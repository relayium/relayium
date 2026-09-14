package account

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
)

// --- fixtures -------------------------------------------------------------

// truncatingWriter is an http.ResponseWriter that accepts exactly `limit` body
// bytes and then fails every write. It makes "the downloader vanished after N
// bytes" a deterministic fixture instead of a race against a real socket, which
// is what lets these tests assert an exact metered byte count.
type truncatingWriter struct {
	hdr     http.Header
	status  int
	limit   int64
	written int64
}

var errDownloaderGone = errors.New("downloader gone")

func (w *truncatingWriter) Header() http.Header {
	if w.hdr == nil {
		w.hdr = http.Header{}
	}
	return w.hdr
}

func (w *truncatingWriter) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
}

func (w *truncatingWriter) Write(p []byte) (int, error) {
	w.WriteHeader(http.StatusOK)
	room := w.limit - w.written
	if room <= 0 {
		return 0, errDownloaderGone
	}
	if int64(len(p)) > room {
		w.written = w.limit
		return int(room), errDownloaderGone
	}
	w.written += int64(len(p))
	return len(p), nil
}

// receiptWriteSpy fails the test if the download-receipt handler performs any
// ACCOUNTING write — balances, lifetime counters, or the receipt rows that
// settle them. Credential bookkeeping (a token's last-used timestamp) is
// deliberately not covered: it is auth metadata, it moves no balance, and
// TestDownloadReceiptStillStampsCredentialUse below pins that it is unchanged.
// The spy delegates rather than stubs, so on unfixed code the write still lands
// and the balance assertions reproduce the original defect too — the spy names
// which call did it.
type receiptWriteSpy struct {
	Store
	t *testing.T
}

func (s *receiptWriteSpy) ClaimDownloadReceipt(ctx context.Context, nonce string, at int64) (bool, error) {
	s.t.Errorf("download-receipt handler consumed a receipt nonce (ClaimDownloadReceipt); it must not write")
	return s.Store.ClaimDownloadReceipt(ctx, nonce, at)
}

func (s *receiptWriteSpy) RecordMeter(ctx context.Context, userID string, kind UsageKind, bytes, at int64) error {
	s.t.Errorf("download-receipt handler metered %d bytes (RecordMeter); it must not write", bytes)
	return s.Store.RecordMeter(ctx, userID, kind, bytes, at)
}

func (s *receiptWriteSpy) AddDownloadStat(ctx context.Context, userID string, bytes int64) error {
	s.t.Errorf("download-receipt handler adjusted download stats by %d (AddDownloadStat); it must not write", bytes)
	return s.Store.AddDownloadStat(ctx, userID, bytes)
}

// seedFleetDirectDownload builds a file server whose single stored file sits on
// an ONLINE fleet node advertising a public DownloadURL — the exact shape the
// withdrawn fleet-direct optimization used to 302 for — backed by a fake node
// that really serves the ciphertext, so the proxy path's byte accounting can be
// measured rather than assumed. clock may be nil for a frozen wall clock.
func seedFleetDirectDownload(t *testing.T, body string, clock func() time.Time) (*httptest.Server, *Service, *SQLiteStore, string, string) {
	t.Helper()
	ts, svc, store, _ := newFileServer(t)
	if clock == nil {
		frozen := time.Now()
		clock = func() time.Time { return frozen }
	}
	svc.now = clock
	svc.SetDirectDownload(true)
	ctx := context.Background()
	owner, _ := store.UpsertUserByEmail(ctx, "fleetdirect@example.com", "")
	nodeStore := map[string][]byte{"fbk": []byte(body)}
	fn := fakeNode(t, nodeStore)
	t.Cleanup(fn.Close)
	if _, err := store.UpsertNode(ctx, Node{
		ID: "fleetnode", OwnerType: "fleet", StorageEnabled: true,
		StorageURL: fn.URL, StorageSecret: "ss",
		DownloadURL: "https://node7.relayium.com",
		CreatedAt:   1, LastSeenAt: svc.now().Unix(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateStoredFile(ctx, StoredFile{
		ID: "ff", UserID: owner.ID, BlobKey: "fbk", EncManifest: []byte("m"),
		Size: int64(len(body)), NodeID: "fleetnode",
		CreatedAt: 1, ExpiresAt: svc.now().Add(365 * 24 * time.Hour).Unix(),
	}); err != nil {
		t.Fatal(err)
	}
	return ts, svc, store, owner.ID, "ff"
}

// getBlobTruncated drives the REAL route mux with a writer that dies after
// `limit` bytes and reports the status the handler chose.
func getBlobTruncated(t *testing.T, svc *Service, fid string, limit int64) *truncatingWriter {
	t.Helper()
	w := &truncatingWriter{limit: limit}
	svc.Routes().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/files/"+fid+"/blob", nil))
	return w
}

const fleetBody = "fleet ciphertext payload"

// --- AUD-03: no metering for bytes that never left -------------------------

// A share link holder who requests an eligible fleet-hosted blob and reads
// nothing must cost the owner nothing. The withdrawn optimization charged the
// whole file size the moment it answered with a redirect, so repeating the
// request drained the owner's monthly traffic — and the owner's shares with it
// — without a single byte being served.
func TestFleetEligibleDownloadNeverChargesUnservedBytes(t *testing.T) {
	_, svc, store, ownerID, fid := seedFleetDirectDownload(t, fleetBody, nil)
	ctx := context.Background()
	period := periodOf(svc.now().Unix())

	for i := 0; i < 5; i++ {
		w := getBlobTruncated(t, svc, fid, 0)
		if w.status == http.StatusFound {
			t.Fatalf("request %d: a fleet stored download must be proxied, got 302 to %q",
				i, w.Header().Get("Location"))
		}
	}

	if _, d, _ := store.MonthlyUsage(ctx, ownerID, period); d != 0 {
		t.Fatalf("5 unread download requests metered %d bytes against the owner, want 0", d)
	}
	st, _ := store.GetUserStats(ctx, ownerID)
	if st.DownloadBytes != 0 || st.DownloadsTotal != 0 {
		t.Fatalf("unread requests moved lifetime stats to bytes=%d count=%d, want 0/0",
			st.DownloadBytes, st.DownloadsTotal)
	}
}

// --- AUD-03/AUD-08: a partial download is one download of N bytes ----------

// The bytes that physically left central are the bill, and a partial delivery
// is still exactly one download. Pre-charging the full size and then letting a
// node's receipt refund the difference got both numbers wrong: it billed for
// bytes nobody received, and the refund's negative delta bumped the lifetime
// download COUNT a second time.
func TestFleetProxiedPartialDownloadMetersServedBytesAndCountsOnce(t *testing.T) {
	const served = 9
	_, svc, store, ownerID, fid := seedFleetDirectDownload(t, fleetBody, nil)
	ctx := context.Background()
	period := periodOf(svc.now().Unix())

	w := getBlobTruncated(t, svc, fid, served)
	if w.status == http.StatusFound {
		t.Fatalf("a fleet stored download must be proxied, got 302 to %q", w.Header().Get("Location"))
	}
	if w.written != served {
		t.Fatalf("fixture served %d bytes, want %d", w.written, served)
	}

	if _, d, _ := store.MonthlyUsage(ctx, ownerID, period); d != served {
		t.Fatalf("partial download metered %d bytes, want the %d actually served", d, served)
	}
	st, _ := store.GetUserStats(ctx, ownerID)
	if st.DownloadBytes != served {
		t.Fatalf("lifetime download bytes = %d, want %d", st.DownloadBytes, served)
	}
	if st.DownloadsTotal != 1 {
		t.Fatalf("one partial download counted %d times, want exactly 1", st.DownloadsTotal)
	}
}

// A complete fleet-hosted download is proxied and billed once, at its real size.
func TestFleetEligibleDownloadIsProxiedAndMeteredOnce(t *testing.T) {
	ts, svc, store, ownerID, fid := seedFleetDirectDownload(t, fleetBody, nil)
	ctx := context.Background()
	period := periodOf(svc.now().Unix())

	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Get(ts.URL + "/api/files/" + fid + "/blob")
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("download status = %d (Location %q), want 200 from the central proxy",
			resp.StatusCode, resp.Header.Get("Location"))
	}
	if string(got) != fleetBody {
		t.Fatalf("proxied body = %q, want the stored ciphertext", got)
	}

	if _, d, _ := store.MonthlyUsage(ctx, ownerID, period); d != int64(len(fleetBody)) {
		t.Fatalf("metered %d bytes, want %d", d, len(fleetBody))
	}
	st, _ := store.GetUserStats(ctx, ownerID)
	if st.DownloadsTotal != 1 || st.DownloadBytes != int64(len(fleetBody)) {
		t.Fatalf("lifetime stats = count %d / %d bytes, want 1 / %d",
			st.DownloadsTotal, st.DownloadBytes, len(fleetBody))
	}
}

// --- AUD-02/AUD-04/AUD-08: the legacy receipt endpoint settles nothing -----

// seedReceiptService builds a fleet-authenticated node service holding one
// 200-byte shared file, plus history that must survive untouched: usage already
// settled for a real download, and an already-seen receipt nonce.
func seedReceiptService(t *testing.T, clock func() time.Time) (*Service, *SQLiteStore, string) {
	t.Helper()
	s := nodeService(t, "fleet-secret")
	if clock != nil {
		s.now = clock
	}
	st := s.store.(*SQLiteStore)
	ctx := context.Background()
	owner, _ := st.UpsertUserByEmail(ctx, "receipt@example.com", "")
	if err := st.CreateStoredFile(ctx, StoredFile{
		ID: "f", UserID: owner.ID, BlobKey: "bk", EncManifest: []byte("m"), Size: 200,
		NodeID: "fleetnode", CreatedAt: 1, ExpiresAt: 1 << 40,
	}); err != nil {
		t.Fatal(err)
	}
	return s, st, owner.ID
}

// A fleet credential plus a made-up nonce used to be a withdrawal slip: central
// kept no record of what it had actually issued, so every unseen nonce refunded
// a pre-charge that may never have existed and drove real usage negative. The
// endpoint must now settle nothing at all — no balance, no counter, and not even
// the nonce row that used to make the forgery single-use.
func TestForgedFleetReceiptsCannotCreditUsageOrCounters(t *testing.T) {
	s, st, ownerID := seedReceiptService(t, nil)
	ctx := context.Background()
	now := s.now().Unix()
	period := periodOf(now)

	// History that predates this request and must come out unchanged.
	if err := st.RecordMeter(ctx, ownerID, MeterDownload, 200, now); err != nil {
		t.Fatal(err)
	}
	if err := st.AddDownloadStat(ctx, ownerID, 200); err != nil {
		t.Fatal(err)
	}
	if first, err := st.ClaimDownloadReceipt(ctx, "historic", now); err != nil || !first {
		t.Fatalf("seed historic receipt: first=%v err=%v", first, err)
	}
	s.store = &receiptWriteSpy{Store: s.store, t: t}

	forged := []string{"forged1", "forged2", "forged3"}
	for _, nonce := range forged {
		body := `{"blobKey":"bk","nonce":"` + nonce + `","servedBytes":0}`
		if code := postReceipt(t, s, "fleet-secret", body); code != http.StatusGone {
			t.Fatalf("forged receipt %q: got %d, want 410", nonce, code)
		}
		// Replay: a retry must be just as inert, and just as stable.
		if code := postReceipt(t, s, "fleet-secret", body); code != http.StatusGone {
			t.Fatalf("replayed receipt %q: got %d, want 410", nonce, code)
		}
	}

	if _, d, _ := st.MonthlyUsage(ctx, ownerID, period); d != 200 {
		t.Fatalf("forged receipts moved monthly download usage to %d, want the real 200", d)
	}
	stats, _ := st.GetUserStats(ctx, ownerID)
	if stats.DownloadBytes != 200 || stats.DownloadsTotal != 1 {
		t.Fatalf("forged receipts moved lifetime stats to %d bytes / count %d, want 200 / 1",
			stats.DownloadBytes, stats.DownloadsTotal)
	}
	// Nonces the handler never wrote are still unseen, and the historic row a
	// self-host operator may still need to audit is still there.
	for _, nonce := range forged {
		if first, _ := st.ClaimDownloadReceipt(ctx, nonce, now); !first {
			t.Fatalf("receipt handler consumed nonce %q", nonce)
		}
	}
	if first, _ := st.ClaimDownloadReceipt(ctx, "historic", now); first {
		t.Fatal("pre-existing receipt history was purged")
	}
}

// Authentication is resolved before anything else and keeps its existing
// distinctions; only a caller that got all the way through as fleet learns the
// accounting itself is gone. The endpoint must not become an oracle that answers
// differently for an unauthenticated prober.
func TestDownloadReceiptAuthenticatesBeforeReportingLegacyRejection(t *testing.T) {
	s, st, _ := seedReceiptService(t, nil)
	s.cfg.EnableUserNodes = true
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "byonode@example.com", "")
	if err := st.CreateNodeToken(ctx, NodeToken{
		ID: "nt1", TokenHash: authx.HashToken("usertok"), UserID: u.ID, Name: "byo", CreatedAt: 1,
	}); err != nil {
		t.Fatal(err)
	}
	s.store = &receiptWriteSpy{Store: s.store, t: t}

	const body = `{"blobKey":"bk","nonce":"n","servedBytes":1}`
	for _, tc := range []struct {
		name, bearer, body string
		want               int
	}{
		{"no bearer", "", body, http.StatusUnauthorized},
		{"unknown bearer", "wrong", body, http.StatusUnauthorized},
		{"user node token", "usertok", body, http.StatusForbidden},
		{"fleet token", "fleet-secret", body, http.StatusGone},
		// Stable regardless of payload: a fleet caller gets the same answer for
		// junk, so nothing downstream of auth can be probed through it.
		{"fleet token, junk body", "fleet-secret", `not json`, http.StatusGone},
		{"fleet token, empty body", "fleet-secret", ``, http.StatusGone},
	} {
		if code := postReceipt(t, s, tc.bearer, tc.body); code != tc.want {
			t.Errorf("%s: got %d, want %d", tc.name, code, tc.want)
		}
	}
}

// The endpoint settles nothing, but it still AUTHENTICATES, and authenticating
// stamps a credential's last-used time exactly as every other node route does.
// That write is the deliberate boundary of the invariant: no accounting, no
// receipt, no entitlement — credential bookkeeping unchanged. Diverging this
// route's token handling from the rest would cost an operator the record of
// which credentials are still in use.
func TestDownloadReceiptStillStampsCredentialUse(t *testing.T) {
	s, st, _ := seedReceiptService(t, nil)
	s.cfg.NodeToken = "" // force the admin-minted path, not the shared env token
	s.cfg.EnableUserNodes = true
	ctx := context.Background()
	now := s.now().Unix()

	if err := st.CreateFleetToken(ctx, FleetToken{
		ID: "ft1", TokenHash: authx.HashToken("mintedfleet"), Name: "minted", CreatedAt: 1,
	}); err != nil {
		t.Fatal(err)
	}
	u, _ := st.UpsertUserByEmail(ctx, "stamp@example.com", "")
	if err := st.CreateNodeToken(ctx, NodeToken{
		ID: "nt1", TokenHash: authx.HashToken("mintednode"), UserID: u.ID, Name: "byo", CreatedAt: 1,
	}); err != nil {
		t.Fatal(err)
	}

	if code := postReceipt(t, s, "mintedfleet", `{"blobKey":"bk","nonce":"x","servedBytes":1}`); code != http.StatusGone {
		t.Fatalf("admin-minted fleet token: got %d, want 410", code)
	}
	if code := postReceipt(t, s, "mintednode", `{"blobKey":"bk","nonce":"y","servedBytes":1}`); code != http.StatusForbidden {
		t.Fatalf("user node token: got %d, want 403", code)
	}

	ft, found, err := st.FleetTokenByHash(ctx, authx.HashToken("mintedfleet"))
	if err != nil || !found {
		t.Fatalf("read back fleet token: found=%v err=%v", found, err)
	}
	if ft.LastUsedAt != now {
		t.Errorf("fleet token last-used = %d, want %d — authenticating must still stamp it", ft.LastUsedAt, now)
	}
	nts, err := st.ListNodeTokensByUser(ctx, u.ID)
	if err != nil || len(nts) != 1 {
		t.Fatalf("read back node tokens: %d tokens, err=%v", len(nts), err)
	}
	if nts[0].LastUsedAt != now {
		t.Errorf("node token last-used = %d, want %d — authenticating must still stamp it", nts[0].LastUsedAt, now)
	}

	// And none of that authentication moved money.
	if _, d, _ := st.MonthlyUsage(ctx, u.ID, periodOf(now)); d != 0 {
		t.Errorf("credential stamping metered %d download bytes, want 0", d)
	}
	if first, _ := st.ClaimDownloadReceipt(ctx, "x", now); !first {
		t.Error("receipt nonce was consumed while only authenticating")
	}
}

// A receipt that arrives in the month AFTER the download must not write to
// either period. The withdrawn design charged the issuing month and refunded the
// arrival month, so a download spanning midnight left one month over-billed and
// the next month negative.
func TestLateFleetReceiptWritesToNeitherAccountingPeriod(t *testing.T) {
	const served = 9
	endOfMonth := time.Date(2026, 8, 31, 23, 59, 50, 0, time.UTC)
	nextMonth := time.Date(2026, 9, 1, 0, 0, 10, 0, time.UTC)
	clock := endOfMonth
	_, svc, store, ownerID, fid := seedFleetDirectDownload(t, fleetBody, func() time.Time { return clock })
	svc.cfg.NodeToken = "fleet-secret"
	ctx := context.Background()
	oldPeriod, newPeriod := periodOf(endOfMonth.Unix()), periodOf(nextMonth.Unix())

	if w := getBlobTruncated(t, svc, fid, served); w.status == http.StatusFound {
		t.Fatalf("a fleet stored download must be proxied, got 302 to %q", w.Header().Get("Location"))
	}

	clock = nextMonth
	svc.store = &receiptWriteSpy{Store: svc.store, t: t}
	if code := postReceipt(t, svc, "fleet-secret", `{"blobKey":"fbk","nonce":"late","servedBytes":`+itoa(served)+`}`); code != http.StatusGone {
		t.Fatalf("late receipt: got %d, want 410", code)
	}

	if _, d, _ := store.MonthlyUsage(ctx, ownerID, oldPeriod); d != served {
		t.Fatalf("%s download usage = %d, want the %d bytes actually served that month", oldPeriod, d, served)
	}
	if _, d, _ := store.MonthlyUsage(ctx, ownerID, newPeriod); d != 0 {
		t.Fatalf("%s download usage = %d, want 0 — a receipt must not write a later period", newPeriod, d)
	}
}

// itoa keeps the receipt bodies above readable without pulling strconv into a
// file that otherwise never formats a number.
func itoa(n int64) string { return intToStr(int(n)) }

// --- BYO: the opt-in free path and the paid proxy path both survive --------

// seedByoOnlineNode returns a server whose file sits on the OWNER's own online
// BYO node, which really serves the ciphertext.
func seedByoOnlineNode(t *testing.T, body string) (*httptest.Server, *Service, *SQLiteStore, string, string) {
	t.Helper()
	ts, svc, store, _ := newFileServer(t)
	frozen := time.Now()
	svc.now = func() time.Time { return frozen }
	svc.SetDirectDownload(true)
	ctx := context.Background()
	owner, _ := store.UpsertUserByEmail(ctx, "byoonline@example.com", "")
	nodeStore := map[string][]byte{"bbk": []byte(body)}
	fn := fakeNode(t, nodeStore)
	t.Cleanup(fn.Close)
	if _, err := store.UpsertNode(ctx, Node{
		ID: "byonode", OwnerType: "user", OwnerUserID: owner.ID, StorageEnabled: true,
		StorageURL: fn.URL, StorageSecret: "bs",
		DownloadURL: "https://mynode.example.com",
		CreatedAt:   1, LastSeenAt: svc.now().Unix(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateStoredFile(ctx, StoredFile{
		ID: "bf", UserID: owner.ID, BlobKey: "bbk", EncManifest: []byte("m"),
		Size: int64(len(body)), NodeID: "byonode",
		CreatedAt: 1, ExpiresAt: svc.now().Add(time.Hour).Unix(),
	}); err != nil {
		t.Fatal(err)
	}
	return ts, svc, store, owner.ID, "bf"
}

// Without the client's explicit opt-in header, an own-node download still comes
// through central, central really pays that egress, and the owner is metered for
// the bytes served — the ordinary paid proxy path, unchanged by the fleet
// containment.
func TestByoOwnNodeWithoutOptInIsProxiedAndMetered(t *testing.T) {
	ts, svc, store, ownerID, fid := seedByoOnlineNode(t, "byo ciphertext")
	ctx := context.Background()
	period := periodOf(svc.now().Unix())

	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Get(ts.URL + "/api/files/" + fid + "/blob")
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("no opt-in header: status %d (Location %q), want the 200 proxy path",
			resp.StatusCode, resp.Header.Get("Location"))
	}
	if string(got) != "byo ciphertext" {
		t.Fatalf("proxied body = %q", got)
	}
	if _, d, _ := store.MonthlyUsage(ctx, ownerID, period); d != int64(len("byo ciphertext")) {
		t.Fatalf("proxied own-node download metered %d bytes, want %d", d, len("byo ciphertext"))
	}
}

// The opt-in own-node path stays free and direct: it is the user's own disk and
// their own bandwidth, and central never enters the data path.
func TestByoOwnNodeOptInStaysFreeAndDirect(t *testing.T) {
	ts, svc, store, ownerID, fid := seedByoOnlineNode(t, "byo ciphertext")
	ctx := context.Background()
	period := periodOf(svc.now().Unix())

	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/files/"+fid+"/blob", nil)
	req.Header.Set("X-Relayium-Direct-Download", "1")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("opt-in own-node download must still redirect direct, got %d", resp.StatusCode)
	}
	if _, d, _ := store.MonthlyUsage(ctx, ownerID, period); d != 0 {
		t.Fatalf("opt-in own-node download must stay free, metered %d bytes", d)
	}
}
