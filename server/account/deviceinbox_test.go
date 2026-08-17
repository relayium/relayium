package account

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/inbox"
)

// Device Inbox Phase 1A acceptance.
//
// The invariants under test, stated before the implementation and repeated here
// so a reader can check the assertions against them rather than against the code:
//
//  1. Central never receives device private keys or content keys.
//  2. A revoked or rotated-away key fails SAFELY: it stops being a send target,
//     it cannot resurrect its own presence, and it cannot re-enrol itself.
//  3. Rolling versions negotiate explicitly and fail closed; nothing is stored
//     for a version or receive capability central does not share.
//  4. Presence EXPIRES. It is never a stored boolean and never implies an
//     indefinite online state.
//  5. Only the device itself may assert its own presence or key custody; only
//     the account may revoke.

// ---------- helpers ----------

type inboxKeypair struct {
	priv    *ecdh.PrivateKey
	encoded string
}

func newInboxKeypair(t *testing.T) inboxKeypair {
	t.Helper()
	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate X25519 key: %v", err)
	}
	return inboxKeypair{priv: priv, encoded: inbox.EncodePublicKey(priv.PublicKey().Bytes())}
}

// jsonDo issues a request with a JSON body, which the bearer endpoints need and
// deviceHarness.do (body-less) does not provide.
func (h *deviceHarness) jsonDo(t *testing.T, method, path, body string, mutate func(*http.Request)) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, h.ts.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatalf("build %s %s: %v", method, path, err)
	}
	req.Header.Set("Content-Type", "application/json")
	if mutate != nil {
		mutate(req)
	}
	resp, err := h.ts.Client().Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func decodeJSONBody(t *testing.T, resp *http.Response) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	return out
}

const validRegistration = `{"platform":"linux","appVersion":"0.15.0",
	"protocolVersions":[2],"capabilities":["inbox.receive.v2","inbox.autoaccept.v1"]}`

// enrolledDevice registers a device inbox and its first key, returning the
// device id, bearer and keypair. It fails the test if either step does not
// succeed, so every later assertion starts from a known-good enrolment.
func (h *deviceHarness) enrolledDevice(t *testing.T, userID, name string) (deviceID, token string, kp inboxKeypair) {
	t.Helper()
	token = h.bearer(t, userID, name)
	devices := decodeDevices(t, h.do(t, "GET", "/api/devices", withBearer(token)))
	for _, d := range devices {
		if d.Current {
			deviceID = d.ID
		}
	}
	if deviceID == "" {
		t.Fatalf("no current device for a freshly minted bearer: %+v", devices)
	}
	resp := h.jsonDo(t, "PUT", "/api/devices/"+deviceID+"/inbox", validRegistration, withBearer(token))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("enrol %s: got %d, want 200", name, resp.StatusCode)
	}
	kp = newInboxKeypair(t)
	resp = h.jsonDo(t, "POST", "/api/devices/"+deviceID+"/inbox/keys",
		fmt.Sprintf(`{"algorithm":%q,"publicKey":%q}`, inbox.KeyAlgX25519SealedBoxV1, kp.encoded),
		withBearer(token))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("register key for %s: got %d, want 200", name, resp.StatusCode)
	}
	return deviceID, token, kp
}

// deviceInboxRow is the sender-facing view carried inside the device list.
type deviceInboxRow struct {
	Presence                 string
	LastHeartbeatAt          int64
	PresenceExpiresAt        int64
	HeartbeatIntervalSeconds int
	ProtocolVersion          int
	Capabilities             []string
	ReceiveCapability        string
	AutoAccept               string
	ReceiveDirReady          bool
	Platform                 string
	AppVersion               string
	Revoked                  bool
	CanReceive               bool
	RegisteredAt             int64
	Key                      *struct {
		ID           string
		Algorithm    string
		PublicKey    string
		Generation   int64
		CreatedAt    int64
		SupersededAt int64
		RevokedAt    int64
	}
}

type deviceRowWithInbox struct {
	ID    string
	Name  string
	Kind  string
	Inbox *deviceInboxRow
}

func (h *deviceHarness) deviceRow(t *testing.T, token, deviceID string) deviceRowWithInbox {
	t.Helper()
	resp := h.do(t, "GET", "/api/devices", withBearer(token))
	var body struct {
		Devices []deviceRowWithInbox `json:"devices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode devices: %v", err)
	}
	for _, d := range body.Devices {
		if d.ID == deviceID {
			return d
		}
	}
	t.Fatalf("device %s not in list %+v", deviceID, body.Devices)
	return deviceRowWithInbox{}
}

// ---------- invariant 1: no private key material reaches central ----------

// TestDeviceKeyRegistrationNeverStoresPrivateMaterial is the executable form of
// the zero-knowledge promise. It deliberately submits the private scalar as an
// extra JSON field — the exact thing a careless client or a malicious one might
// do — and requires the versioned API to reject the entire request rather than
// silently claiming success while ignoring security-sensitive material. It then
// performs a valid public-only registration and sweeps EVERY database column.
//
// A shape check on the request struct would not do: the failure this guards
// against is a future field, a debug log line, or an audit row that happens to
// carry the body through. Sweeping the database is the assertion that can
// actually fail if that happens.
func TestDeviceKeyRegistrationNeverStoresPrivateMaterial(t *testing.T) {
	h := newDeviceHarness(t)
	uid := h.user(t, "zeroknowledge@example.com")
	token := h.bearer(t, uid, "CLI")
	deviceID := ""
	for _, d := range decodeDevices(t, h.do(t, "GET", "/api/devices", withBearer(token))) {
		if d.Current {
			deviceID = d.ID
		}
	}
	if code := h.jsonDo(t, "PUT", "/api/devices/"+deviceID+"/inbox", validRegistration, withBearer(token)).StatusCode; code != http.StatusOK {
		t.Fatalf("enrol: %d", code)
	}

	kp := newInboxKeypair(t)
	privHex := hex.EncodeToString(kp.priv.Bytes())
	privB64 := inbox.EncodePublicKey(kp.priv.Bytes()) // same base64url spelling a client would use
	body := fmt.Sprintf(`{"algorithm":%q,"publicKey":%q,"privateKey":%q,"contentKey":%q,"secret":%q}`,
		inbox.KeyAlgX25519SealedBoxV1, kp.encoded, privB64, privB64, privHex)
	if code := h.jsonDo(t, "POST", "/api/devices/"+deviceID+"/inbox/keys", body, withBearer(token)).StatusCode; code != http.StatusBadRequest {
		t.Fatalf("register request containing private material: got %d, want 400", code)
	}
	validBody := fmt.Sprintf(`{"algorithm":%q,"publicKey":%q}`,
		inbox.KeyAlgX25519SealedBoxV1, kp.encoded)
	if code := h.jsonDo(t, "POST", "/api/devices/"+deviceID+"/inbox/keys", validBody, withBearer(token)).StatusCode; code != http.StatusOK {
		t.Fatalf("register public key: %d", code)
	}

	needles := []string{privB64, privHex, strings.ToUpper(privHex)}
	if hits := sweepDatabaseForSecrets(t, h.store, needles); len(hits) > 0 {
		t.Fatalf("private key material reached the database: %v", hits)
	}

	// And it is not echoed back either: the API response and the device list are
	// the two places a client would see it.
	resp := h.do(t, "GET", "/api/devices", withBearer(token))
	var raw json.RawMessage
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, needle := range needles {
		if strings.Contains(string(raw), needle) {
			t.Fatalf("device list response leaked private key material (%q)", needle)
		}
	}
	// The PUBLIC key must be there, or the sweep above proved nothing except
	// that the registration silently did nothing.
	if !strings.Contains(string(raw), kp.encoded) {
		t.Fatal("device list does not carry the registered PUBLIC key — the leak sweep was vacuous")
	}
}

// sweepDatabaseForSecrets scans every column of every table for each needle and
// returns a description of each hit. Used to prove an absence that a targeted
// column check could not: the point is to catch material landing somewhere
// nobody thought to look.
//
// It RETURNS its findings rather than failing, so the sweep itself can be
// mutation-checked (see TestSecretSweepCanFail) — an absence assertion nobody
// has ever seen fail is not evidence.
func sweepDatabaseForSecrets(t *testing.T, st *SQLiteStore, needles []string) []string {
	t.Helper()
	var hits []string
	ctx := context.Background()
	tables, err := st.db.QueryContext(ctx,
		`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
	if err != nil {
		t.Fatalf("list tables: %v", err)
	}
	var names []string
	for tables.Next() {
		var n string
		if err := tables.Scan(&n); err != nil {
			t.Fatalf("scan table name: %v", err)
		}
		names = append(names, n)
	}
	if err := tables.Err(); err != nil {
		t.Fatalf("iterate tables: %v", err)
	}
	tables.Close()
	if len(names) == 0 {
		t.Fatal("no tables found — the sweep would pass vacuously")
	}
	for _, table := range names {
		rows, err := st.db.QueryContext(ctx, `SELECT * FROM "`+table+`"`)
		if err != nil {
			t.Fatalf("select from %s: %v", table, err)
		}
		cols, err := rows.Columns()
		if err != nil {
			t.Fatalf("columns of %s: %v", table, err)
		}
		for rows.Next() {
			cells := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range cells {
				ptrs[i] = &cells[i]
			}
			if err := rows.Scan(ptrs...); err != nil {
				t.Fatalf("scan %s: %v", table, err)
			}
			for i, cell := range cells {
				var text string
				switch v := cell.(type) {
				case string:
					text = v
				case []byte:
					text = string(v)
				default:
					continue
				}
				for _, needle := range needles {
					if needle != "" && strings.Contains(text, needle) {
						hits = append(hits, fmt.Sprintf("%s.%s = %q", table, cols[i], text))
					}
				}
			}
		}
		if err := rows.Err(); err != nil {
			t.Fatalf("iterate %s: %v", table, err)
		}
		rows.Close()
	}
	return hits
}

// The sweep above is only meaningful if it can actually find something. This
// proves the mechanism, so a later refactor that breaks the scan (a changed
// driver type, an empty table list) cannot leave the real test passing blind.
func TestSecretSweepCanFail(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, err := st.UpsertUserByEmail(ctx, "sweep-canary@example.com", "Canary")
	if err != nil {
		t.Fatal(err)
	}
	hits := sweepDatabaseForSecrets(t, st, []string{u.Email})
	if len(hits) == 0 {
		t.Fatal("the secret sweep did not detect a value that is definitely in the database")
	}
	// And it is not simply matching everything.
	if hits := sweepDatabaseForSecrets(t, st, []string{"no-such-value-anywhere-in-this-database"}); len(hits) != 0 {
		t.Fatalf("the sweep reported hits for a value that is not present: %v", hits)
	}
}

// ---------- invariant 3: explicit version/capability negotiation ----------

func TestRegistrationNegotiatesAndEchoesTheAgreedVersion(t *testing.T) {
	h := newDeviceHarness(t)
	uid := h.user(t, "negotiate@example.com")
	token := h.bearer(t, uid, "CLI")
	deviceID := currentDeviceID(t, h, token)

	// A rolling client that speaks more than central does must be told what was
	// actually agreed, not left to assume its highest.
	resp := h.jsonDo(t, "PUT", "/api/devices/"+deviceID+"/inbox",
		`{"platform":"linux","protocolVersions":[1,2,7],"capabilities":["inbox.receive.v2","inbox.receive.v9"]}`,
		withBearer(token))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("register: got %d, want 200", resp.StatusCode)
	}
	body := decodeJSONBody(t, resp)
	if got := body["protocolVersion"]; got != float64(inbox.ProtocolV2) {
		t.Fatalf("negotiated protocolVersion = %v, want %d", got, inbox.ProtocolV2)
	}
	if got := body["receiveCapability"]; got != inbox.CapReceiveV2 {
		t.Fatalf("negotiated receiveCapability = %v, want %q", got, inbox.CapReceiveV2)
	}
	if got := body["keyAlgorithm"]; got != inbox.KeyAlgX25519SealedBoxV1 {
		t.Fatalf("keyAlgorithm = %v, want %q", got, inbox.KeyAlgX25519SealedBoxV1)
	}
	// The unknown sibling capability is CARRIED, not dropped: central is not the
	// semantic authority for a token a newer sender may understand.
	row := h.deviceRow(t, token, deviceID)
	if row.Inbox == nil {
		t.Fatal("device list has no inbox after registration")
	}
	var sawUnknown bool
	for _, c := range row.Inbox.Capabilities {
		if c == "inbox.receive.v9" {
			sawUnknown = true
		}
	}
	if !sawUnknown {
		t.Fatalf("announced capabilities = %v, want the unknown token carried through", row.Inbox.Capabilities)
	}
}

// ADVERSARIAL: a device from a future (or an ancient) fleet whose protocol
// central does not speak must be REFUSED and must store nothing. A silent
// fallback to v1 would have central treating a device as speaking a protocol it
// never claimed.
func TestUnsupportedProtocolVersionIsRefusedAndStoresNothing(t *testing.T) {
	h := newDeviceHarness(t)
	uid := h.user(t, "future@example.com")
	token := h.bearer(t, uid, "Future CLI")
	deviceID := currentDeviceID(t, h, token)

	resp := h.jsonDo(t, "PUT", "/api/devices/"+deviceID+"/inbox",
		`{"platform":"linux","protocolVersions":[42,43],"capabilities":["inbox.receive.v2"]}`,
		withBearer(token))
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("unsupported protocol: got %d, want 409", resp.StatusCode)
	}
	body := decodeJSONBody(t, resp)
	if body["error"] != "unsupported_protocol_version" {
		t.Fatalf("error = %v", body["error"])
	}
	if body["supportedProtocols"] == nil {
		t.Fatal("a refusal must tell a rolling client what central does support")
	}
	if row := h.deviceRow(t, token, deviceID); row.Inbox != nil {
		t.Fatalf("a refused negotiation left an enrolment behind: %+v", row.Inbox)
	}
}

// ADVERSARIAL: same fail-closed rule for the capability that gates receiving.
// A device implementing a receive version central does not negotiate must not be
// listed as a target, because central cannot say what claiming a task means for
// it. inbox.receive.v1 is the case that will actually occur — v2 replaced it
// outright and it is not a downgrade path.
func TestUnsupportedReceiveCapabilityIsRefusedAndStoresNothing(t *testing.T) {
	h := newDeviceHarness(t)
	uid := h.user(t, "cap@example.com")
	token := h.bearer(t, uid, "Future CLI")
	deviceID := currentDeviceID(t, h, token)

	for _, caps := range []string{
		`["inbox.receive.v1"]`,
		`["inbox.receive.v1","inbox.autoaccept.v1","inbox.resume.v1"]`,
		`["inbox.receive.v9"]`,
		`[]`,
		`["inbox.autoaccept.v1"]`,
	} {
		resp := h.jsonDo(t, "PUT", "/api/devices/"+deviceID+"/inbox",
			`{"platform":"linux","protocolVersions":[2],"capabilities":`+caps+`}`, withBearer(token))
		if resp.StatusCode != http.StatusConflict {
			t.Fatalf("caps %s: got %d, want 409", caps, resp.StatusCode)
		}
		if body := decodeJSONBody(t, resp); body["error"] != "unsupported_capability" {
			t.Fatalf("caps %s: error = %v", caps, body["error"])
		}
	}
	if row := h.deviceRow(t, token, deviceID); row.Inbox != nil {
		t.Fatalf("a refused capability negotiation left an enrolment behind: %+v", row.Inbox)
	}
}

func TestAutomaticPolicyWithoutCapabilityIsRefusedAndStoresNothing(t *testing.T) {
	h := newDeviceHarness(t)
	uid := h.user(t, "auto-cap@example.com")
	token := h.bearer(t, uid, "CLI")
	deviceID := currentDeviceID(t, h, token)

	resp := h.jsonDo(t, "PUT", "/api/devices/"+deviceID+"/inbox",
		`{"protocolVersions":[2],"capabilities":["inbox.receive.v2"],"autoAccept":"auto"}`,
		withBearer(token))
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("auto without capability: got %d, want 409", resp.StatusCode)
	}
	body := decodeJSONBody(t, resp)
	if body["error"] != "unsupported_auto_accept_capability" {
		t.Fatalf("error = %v", body["error"])
	}
	if row := h.deviceRow(t, token, deviceID); row.Inbox != nil {
		t.Fatalf("a refused auto policy left an enrolment behind: %+v", row.Inbox)
	}
}

func TestRegistrationRejectsMalformedAnnouncements(t *testing.T) {
	h := newDeviceHarness(t)
	uid := h.user(t, "malformed@example.com")
	token := h.bearer(t, uid, "CLI")
	deviceID := currentDeviceID(t, h, token)

	for _, tc := range []struct{ name, body, wantErr string }{
		{"unversioned capability",
			`{"protocolVersions":[2],"capabilities":["inbox.receive"]}`, "invalid_capabilities"},
		{"auto-accept typo",
			`{"protocolVersions":[2],"capabilities":["inbox.receive.v2"],"autoAccept":"always"}`, "invalid_auto_accept"},
		{"control character in platform",
			`{"protocolVersions":[2],"capabilities":["inbox.receive.v2"],"platform":"li\u0000nux"}`, "invalid_device_metadata"},
		{"oversized app version",
			`{"protocolVersions":[2],"capabilities":["inbox.receive.v2"],"appVersion":"` + strings.Repeat("9", inbox.MaxAppVersionLen+1) + `"}`, "invalid_device_metadata"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp := h.jsonDo(t, "PUT", "/api/devices/"+deviceID+"/inbox", tc.body, withBearer(token))
			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("got %d, want 400", resp.StatusCode)
			}
			if body := decodeJSONBody(t, resp); body["error"] != tc.wantErr {
				t.Fatalf("error = %v, want %q", body["error"], tc.wantErr)
			}
		})
	}
	if row := h.deviceRow(t, token, deviceID); row.Inbox != nil {
		t.Fatalf("a rejected announcement left an enrolment behind: %+v", row.Inbox)
	}
}

// PRD §8: automatic write-to-disk is default-off. A registration that says
// nothing about the policy must not arrive at "auto".
func TestAutoAcceptDefaultsOffOnRegistration(t *testing.T) {
	h := newDeviceHarness(t)
	uid := h.user(t, "autoaccept@example.com")
	deviceID, token, _ := h.enrolledDevice(t, uid, "CLI")
	row := h.deviceRow(t, token, deviceID)
	if row.Inbox.AutoAccept != inbox.AutoAcceptOff {
		t.Fatalf("autoAccept = %q, want %q with no policy announced", row.Inbox.AutoAccept, inbox.AutoAcceptOff)
	}
}

// ---------- key registration, rotation, revocation ----------

// ADVERSARIAL: an invalid public key must be refused at REGISTRATION, so no
// sender ever wraps a content key to one. The low-order point is the case that
// matters most: it parses, it is the right length, and every wrap to it is
// recoverable by anyone.
func TestInvalidPublicKeysAreRefused(t *testing.T) {
	h := newDeviceHarness(t)
	uid := h.user(t, "badkeys@example.com")
	token := h.bearer(t, uid, "CLI")
	deviceID := currentDeviceID(t, h, token)
	if code := h.jsonDo(t, "PUT", "/api/devices/"+deviceID+"/inbox", validRegistration, withBearer(token)).StatusCode; code != http.StatusOK {
		t.Fatalf("enrol: %d", code)
	}
	allZero := inbox.EncodePublicKey(make([]byte, 32))

	for _, tc := range []struct {
		name, alg, key string
		wantStatus     int
		wantErr        string
	}{
		{"all-zero low order point", inbox.KeyAlgX25519SealedBoxV1, allZero, http.StatusBadRequest, "unusable_public_key"},
		{"too short", inbox.KeyAlgX25519SealedBoxV1, inbox.EncodePublicKey(make([]byte, 16)), http.StatusBadRequest, "malformed_public_key"},
		{"not base64url", inbox.KeyAlgX25519SealedBoxV1, "@@@@", http.StatusBadRequest, "malformed_public_key"},
		{"empty", inbox.KeyAlgX25519SealedBoxV1, "", http.StatusBadRequest, "malformed_public_key"},
		{"unknown algorithm", "rsa-oaep-v1", allZero, http.StatusConflict, "unsupported_key_algorithm"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp := h.jsonDo(t, "POST", "/api/devices/"+deviceID+"/inbox/keys",
				fmt.Sprintf(`{"algorithm":%q,"publicKey":%q}`, tc.alg, tc.key), withBearer(token))
			if resp.StatusCode != tc.wantStatus {
				t.Fatalf("got %d, want %d", resp.StatusCode, tc.wantStatus)
			}
			if body := decodeJSONBody(t, resp); body["error"] != tc.wantErr {
				t.Fatalf("error = %v, want %q", body["error"], tc.wantErr)
			}
		})
	}
	// Nothing was stored, so the device is still not a valid send target.
	row := h.deviceRow(t, token, deviceID)
	if row.Inbox.Key != nil || row.Inbox.CanReceive {
		t.Fatalf("a rejected key left the device sendable: %+v", row.Inbox)
	}
}

// Keys require a negotiated enrolment first, so no key can exist for a protocol
// version central never agreed to.
func TestKeyRegistrationRequiresAnEnrolment(t *testing.T) {
	h := newDeviceHarness(t)
	uid := h.user(t, "nokey@example.com")
	token := h.bearer(t, uid, "CLI")
	deviceID := currentDeviceID(t, h, token)
	kp := newInboxKeypair(t)

	resp := h.jsonDo(t, "POST", "/api/devices/"+deviceID+"/inbox/keys",
		fmt.Sprintf(`{"algorithm":%q,"publicKey":%q}`, inbox.KeyAlgX25519SealedBoxV1, kp.encoded),
		withBearer(token))
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("got %d, want 409", resp.StatusCode)
	}
	if body := decodeJSONBody(t, resp); body["error"] != "device_inbox_not_registered" {
		t.Fatalf("error = %v", body["error"])
	}
}

func TestKeyRotationSupersedesRatherThanDeletes(t *testing.T) {
	h := newDeviceHarness(t)
	uid := h.user(t, "rotate@example.com")
	deviceID, token, first := h.enrolledDevice(t, uid, "CLI")
	firstKeyID := h.deviceRow(t, token, deviceID).Inbox.Key.ID

	second := newInboxKeypair(t)
	resp := h.jsonDo(t, "POST", "/api/devices/"+deviceID+"/inbox/keys",
		fmt.Sprintf(`{"algorithm":%q,"publicKey":%q,"previousKeyId":%q}`,
			inbox.KeyAlgX25519SealedBoxV1, second.encoded, firstKeyID), withBearer(token))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("rotate: got %d, want 200", resp.StatusCode)
	}

	row := h.deviceRow(t, token, deviceID)
	if row.Inbox.Key == nil || row.Inbox.Key.PublicKey != second.encoded {
		t.Fatalf("active key = %+v, want the newly registered one", row.Inbox.Key)
	}
	if row.Inbox.Key.Generation != 2 {
		t.Fatalf("generation = %d, want 2", row.Inbox.Key.Generation)
	}
	if !row.Inbox.CanReceive {
		t.Fatal("a rotated device must still be sendable")
	}

	// The OLD key is retained and marked superseded — not deleted. A task queued
	// before the rotation was sealed to it, and the device still holds that
	// private key; dropping the row would make such a task unexplainable.
	keys := h.keyHistory(t, token, deviceID)
	if len(keys) != 2 {
		t.Fatalf("history has %d keys, want 2 (the old one must be retained)", len(keys))
	}
	var old map[string]any
	for _, k := range keys {
		if k["PublicKey"] == first.encoded {
			old = k
		}
	}
	if old == nil {
		t.Fatalf("the superseded key is missing from the history: %+v", keys)
	}
	if old["SupersededAt"] == float64(0) {
		t.Fatal("the previous key was not marked superseded")
	}
	if old["RevokedAt"] != float64(0) {
		t.Fatal("rotation must not REVOKE the old key — the device can still drain tasks sealed to it")
	}
}

func (h *deviceHarness) keyHistory(t *testing.T, token, deviceID string) []map[string]any {
	t.Helper()
	resp := h.do(t, "GET", "/api/devices/"+deviceID+"/inbox/keys", withBearer(token))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("key history: got %d, want 200", resp.StatusCode)
	}
	var body struct {
		Keys []map[string]any `json:"keys"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode keys: %v", err)
	}
	return body.Keys
}

// ADVERSARIAL: replayed and stale rotations. Every one of these is a captured
// request re-sent later; each must fail rather than reinstate a key the device
// may no longer hold.
func TestStaleAndReplayedRotationsAreRefused(t *testing.T) {
	h := newDeviceHarness(t)
	uid := h.user(t, "replay@example.com")
	deviceID, token, first := h.enrolledDevice(t, uid, "CLI")
	firstKeyID := h.deviceRow(t, token, deviceID).Inbox.Key.ID

	post := func(body string) *http.Response {
		return h.jsonDo(t, "POST", "/api/devices/"+deviceID+"/inbox/keys", body, withBearer(token))
	}
	keyBody := func(pub, prev string) string {
		return fmt.Sprintf(`{"algorithm":%q,"publicKey":%q,"previousKeyId":%q}`,
			inbox.KeyAlgX25519SealedBoxV1, pub, prev)
	}

	second := newInboxKeypair(t)
	if code := post(keyBody(second.encoded, firstKeyID)).StatusCode; code != http.StatusOK {
		t.Fatalf("first rotation: %d", code)
	}
	secondKeyID := h.deviceRow(t, token, deviceID).Inbox.Key.ID

	// 1. A captured INITIAL registration (previousKeyId absent) replayed once a
	//    key exists. Without the CAS this would install a stale key as current.
	third := newInboxKeypair(t)
	resp := post(fmt.Sprintf(`{"algorithm":%q,"publicKey":%q}`, inbox.KeyAlgX25519SealedBoxV1, third.encoded))
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("replayed initial registration: got %d, want 409", resp.StatusCode)
	}
	if body := decodeJSONBody(t, resp); body["error"] != "stale_key_rotation" {
		t.Fatalf("error = %v", body["error"])
	}

	// 2. A captured A→B rotation replayed once the device is on B: the named
	//    predecessor is no longer current.
	fourth := newInboxKeypair(t)
	resp = post(keyBody(fourth.encoded, firstKeyID))
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("stale predecessor: got %d, want 409", resp.StatusCode)
	}

	// 3. Rotating BACK onto a superseded key — a downgrade dressed as a
	//    rotation. Refused even though the CAS itself would be satisfied.
	resp = post(keyBody(first.encoded, secondKeyID))
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("key reuse: got %d, want 409", resp.StatusCode)
	}
	if body := decodeJSONBody(t, resp); body["error"] != "device_key_reused" {
		t.Fatalf("error = %v, want device_key_reused", body["error"])
	}

	// After all of that, the current key is still the one the device actually
	// rotated to.
	row := h.deviceRow(t, token, deviceID)
	if row.Inbox.Key.PublicKey != second.encoded {
		t.Fatalf("active key changed under replay: %+v", row.Inbox.Key)
	}
	if len(h.keyHistory(t, token, deviceID)) != 2 {
		t.Fatal("a refused rotation wrote a key row")
	}
}

// A retry of the SAME rotation — the client that lost the response — must
// converge rather than deadlock against its own compare-and-swap.
func TestRepeatingTheSameRotationIsIdempotent(t *testing.T) {
	h := newDeviceHarness(t)
	uid := h.user(t, "idempotent@example.com")
	deviceID, token, _ := h.enrolledDevice(t, uid, "CLI")
	firstKeyID := h.deviceRow(t, token, deviceID).Inbox.Key.ID

	second := newInboxKeypair(t)
	body := fmt.Sprintf(`{"algorithm":%q,"publicKey":%q,"previousKeyId":%q}`,
		inbox.KeyAlgX25519SealedBoxV1, second.encoded, firstKeyID)
	first := h.jsonDo(t, "POST", "/api/devices/"+deviceID+"/inbox/keys", body, withBearer(token))
	if first.StatusCode != http.StatusOK {
		t.Fatalf("rotate: %d", first.StatusCode)
	}
	firstBody := decodeJSONBody(t, first)

	// Same request again, still naming the OLD predecessor — which is exactly
	// what a retry carries.
	retry := h.jsonDo(t, "POST", "/api/devices/"+deviceID+"/inbox/keys", body, withBearer(token))
	if retry.StatusCode != http.StatusOK {
		t.Fatalf("retried rotation: got %d, want 200", retry.StatusCode)
	}
	retryBody := decodeJSONBody(t, retry)
	before := firstBody["key"].(map[string]any)
	after := retryBody["key"].(map[string]any)
	if before["ID"] != after["ID"] || before["Generation"] != after["Generation"] {
		t.Fatalf("a retry created a new key: %v then %v", before, after)
	}
	if len(h.keyHistory(t, token, deviceID)) != 2 {
		t.Fatal("a retried rotation added a history entry")
	}
}

// ---------- invariant 2: revocation fails safe ----------

func TestRevokingTheActiveKeyMakesTheDeviceUnsendableImmediately(t *testing.T) {
	h := newDeviceHarness(t)
	uid := h.user(t, "revoke-active@example.com")
	deviceID, token, _ := h.enrolledDevice(t, uid, "CLI")
	// Heartbeat first, so the device is genuinely online when the key is
	// revoked — otherwise "offline afterwards" would prove nothing.
	if code := h.jsonDo(t, "POST", "/api/devices/"+deviceID+"/inbox/heartbeat", `{}`, withBearer(token)).StatusCode; code != http.StatusOK {
		t.Fatalf("heartbeat: %d", code)
	}
	before := h.deviceRow(t, token, deviceID)
	if before.Inbox.Presence != inbox.PresenceOnline || !before.Inbox.CanReceive {
		t.Fatalf("precondition failed, device is not a live target: %+v", before.Inbox)
	}
	keyID := before.Inbox.Key.ID

	// Revoked from the WEB SESSION — the realistic case is a user on another
	// machine reacting to a lost laptop.
	cookie := h.cookie(t, uid)
	resp := h.jsonDo(t, "POST", "/api/devices/"+deviceID+"/inbox/keys/"+keyID+"/revoke", `{}`,
		func(r *http.Request) { r.AddCookie(cookie) })
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("revoke: got %d, want 200", resp.StatusCode)
	}
	if body := decodeJSONBody(t, resp); body["revokedActiveKey"] != true {
		t.Fatalf("revokedActiveKey = %v, want true", body["revokedActiveKey"])
	}

	after := h.deviceRow(t, token, deviceID)
	if after.Inbox.CanReceive {
		t.Fatal("a device whose active key was revoked is still advertised as sendable")
	}
	if after.Inbox.Key != nil {
		t.Fatalf("a revoked key is still published for senders to wrap to: %+v", after.Inbox.Key)
	}
	if after.Inbox.Presence != inbox.PresenceOffline {
		t.Fatalf("presence = %q after revocation, want offline", after.Inbox.Presence)
	}
	if !after.Inbox.Revoked {
		t.Fatal("the enrolment is not marked revoked")
	}
}

// ADVERSARIAL: the stolen laptop. Its key was revoked, but it still holds a
// working account bearer. Every path back to being a send target must be shut:
// it cannot heartbeat, cannot register a fresh key, and cannot clear its own
// revocation.
func TestARevokedDeviceCannotRestoreItself(t *testing.T) {
	h := newDeviceHarness(t)
	uid := h.user(t, "stolen@example.com")
	deviceID, token, _ := h.enrolledDevice(t, uid, "CLI")
	keyID := h.deviceRow(t, token, deviceID).Inbox.Key.ID
	cookie := h.cookie(t, uid)
	if code := h.jsonDo(t, "POST", "/api/devices/"+deviceID+"/inbox/keys/"+keyID+"/revoke", `{}`,
		func(r *http.Request) { r.AddCookie(cookie) }).StatusCode; code != http.StatusOK {
		t.Fatalf("revoke: %d", code)
	}

	// The bearer still authenticates — revoking a KEY is not revoking the
	// credential — which is precisely why the checks below have to hold.
	if code := h.do(t, "GET", "/api/me", withBearer(token)).StatusCode; code != http.StatusOK {
		t.Fatalf("precondition: the bearer should still work, got %d", code)
	}

	t.Run("cannot heartbeat", func(t *testing.T) {
		resp := h.jsonDo(t, "POST", "/api/devices/"+deviceID+"/inbox/heartbeat", `{}`, withBearer(token))
		if resp.StatusCode != http.StatusConflict {
			t.Fatalf("got %d, want 409", resp.StatusCode)
		}
		if body := decodeJSONBody(t, resp); body["error"] != "device_inbox_revoked" {
			t.Fatalf("error = %v", body["error"])
		}
		if got := h.deviceRow(t, token, deviceID).Inbox.Presence; got != inbox.PresenceOffline {
			t.Fatalf("presence = %q after a refused heartbeat, want offline", got)
		}
	})

	t.Run("cannot register a fresh key", func(t *testing.T) {
		fresh := newInboxKeypair(t)
		resp := h.jsonDo(t, "POST", "/api/devices/"+deviceID+"/inbox/keys",
			fmt.Sprintf(`{"algorithm":%q,"publicKey":%q}`, inbox.KeyAlgX25519SealedBoxV1, fresh.encoded),
			withBearer(token))
		if resp.StatusCode != http.StatusConflict {
			t.Fatalf("got %d, want 409", resp.StatusCode)
		}
		if got := h.deviceRow(t, token, deviceID); got.Inbox.CanReceive {
			t.Fatal("the revoked device re-armed itself with a new key")
		}
	})

	t.Run("cannot re-enrol", func(t *testing.T) {
		resp := h.jsonDo(t, "PUT", "/api/devices/"+deviceID+"/inbox", validRegistration, withBearer(token))
		if resp.StatusCode != http.StatusConflict {
			t.Fatalf("got %d, want 409", resp.StatusCode)
		}
	})

	t.Run("cannot clear its own revocation", func(t *testing.T) {
		resp := h.do(t, "DELETE", "/api/devices/"+deviceID+"/inbox", withBearer(token))
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("got %d, want 403", resp.StatusCode)
		}
		if body := decodeJSONBody(t, resp); body["error"] != "revoked_device_cannot_clear_itself" {
			t.Fatalf("error = %v", body["error"])
		}
	})

	// The owner, from a browser, CAN clear it — that is the deliberate
	// re-enrolment path, and it takes a human.
	t.Run("the owner can clear it from elsewhere", func(t *testing.T) {
		resp := h.do(t, "DELETE", "/api/devices/"+deviceID+"/inbox", func(r *http.Request) { r.AddCookie(cookie) })
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("owner clear: got %d, want 200", resp.StatusCode)
		}
		if row := h.deviceRow(t, token, deviceID); row.Inbox != nil {
			t.Fatalf("the enrolment survived the clear: %+v", row.Inbox)
		}
		// And the key history went with it, so nothing stale remains to be
		// mistaken for a current key.
		if code := h.do(t, "GET", "/api/devices/"+deviceID+"/inbox/keys", withBearer(token)).StatusCode; code != http.StatusNotFound {
			t.Fatalf("key history after clear: got %d, want 404", code)
		}
	})
}

// Revoking a SUPERSEDED key withdraws that key alone: the device is on a newer
// key and must keep working. Collapsing the two states would take a device out
// of service for cleaning up its own history.
func TestRevokingASupersededKeyLeavesTheDeviceWorking(t *testing.T) {
	h := newDeviceHarness(t)
	uid := h.user(t, "revoke-old@example.com")
	deviceID, token, _ := h.enrolledDevice(t, uid, "CLI")
	oldKeyID := h.deviceRow(t, token, deviceID).Inbox.Key.ID

	second := newInboxKeypair(t)
	if code := h.jsonDo(t, "POST", "/api/devices/"+deviceID+"/inbox/keys",
		fmt.Sprintf(`{"algorithm":%q,"publicKey":%q,"previousKeyId":%q}`,
			inbox.KeyAlgX25519SealedBoxV1, second.encoded, oldKeyID), withBearer(token)).StatusCode; code != http.StatusOK {
		t.Fatalf("rotate: %d", code)
	}

	resp := h.jsonDo(t, "POST", "/api/devices/"+deviceID+"/inbox/keys/"+oldKeyID+"/revoke", `{}`,
		func(r *http.Request) { r.AddCookie(h.cookie(t, uid)) })
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("revoke superseded: got %d, want 200", resp.StatusCode)
	}
	if body := decodeJSONBody(t, resp); body["revokedActiveKey"] != false {
		t.Fatalf("revokedActiveKey = %v, want false", body["revokedActiveKey"])
	}
	row := h.deviceRow(t, token, deviceID)
	if row.Inbox.Revoked || !row.Inbox.CanReceive {
		t.Fatalf("revoking an OLD key took the device out of service: %+v", row.Inbox)
	}
	if row.Inbox.Key.PublicKey != second.encoded {
		t.Fatalf("active key changed: %+v", row.Inbox.Key)
	}
}

// Deleting the device row is the complete remedy for a lost machine: it
// cascades the enrolment and the key history along with the bearer, so no
// orphaned public key is left published for a device that no longer exists.
func TestDeletingADeviceCascadesItsInboxAndKeys(t *testing.T) {
	h := newDeviceHarness(t)
	uid := h.user(t, "cascade@example.com")
	deviceID, token, _ := h.enrolledDevice(t, uid, "CLI")
	other := h.bearer(t, uid, "Browser-side credential")

	if code := h.do(t, "DELETE", "/api/devices/"+deviceID, withBearer(other)).StatusCode; code != http.StatusOK {
		t.Fatalf("delete device: %d", code)
	}
	ctx := context.Background()
	if _, found, err := h.store.GetDeviceInbox(ctx, deviceID, uid); err != nil || found {
		t.Fatalf("enrolment survived device deletion: found=%v err=%v", found, err)
	}
	keys, err := h.store.ListDeviceKeys(ctx, deviceID, uid)
	if err != nil {
		t.Fatal(err)
	}
	if len(keys) != 0 {
		t.Fatalf("%d key rows survived device deletion", len(keys))
	}
	// The bearer bound to that device is gone too (the pre-existing cascade),
	// so the machine cannot act at all.
	if code := h.do(t, "GET", "/api/me", withBearer(token)).StatusCode; code != http.StatusUnauthorized {
		t.Fatalf("revoked device bearer: got %d, want 401", code)
	}
}

// ---------- invariant 4: presence expires ----------

func TestPresenceExpiresWithoutAnyServerSideSweep(t *testing.T) {
	h := newDeviceHarness(t)
	uid := h.user(t, "presence@example.com")
	deviceID, token, _ := h.enrolledDevice(t, uid, "CLI")

	base := time.Now()
	clock := base
	h.svc.SetNow(func() time.Time { return clock })

	resp := h.jsonDo(t, "POST", "/api/devices/"+deviceID+"/inbox/heartbeat", `{"receiveDirReady":true}`, withBearer(token))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("heartbeat: got %d, want 200", resp.StatusCode)
	}
	beat := decodeJSONBody(t, resp)
	if beat["presence"] != inbox.PresenceOnline {
		t.Fatalf("presence = %v, want online", beat["presence"])
	}
	if got := beat["presenceExpiresAt"]; got != float64(base.Add(inbox.PresenceTTL).Unix()) {
		t.Fatalf("presenceExpiresAt = %v, want a bounded expiry", got)
	}

	row := h.deviceRow(t, token, deviceID)
	if row.Inbox.Presence != inbox.PresenceOnline || !row.Inbox.ReceiveDirReady {
		t.Fatalf("after heartbeat: %+v", row.Inbox)
	}

	// Just inside the window.
	clock = base.Add(inbox.PresenceTTL - time.Second)
	if got := h.deviceRow(t, token, deviceID).Inbox.Presence; got != inbox.PresenceOnline {
		t.Fatalf("one second before expiry: %q, want online", got)
	}
	// Past it — with NOTHING having run in between. No sweeper, no second
	// request from the device, no restart. The device simply stops being
	// claimed to be online.
	clock = base.Add(inbox.PresenceTTL)
	if got := h.deviceRow(t, token, deviceID).Inbox.Presence; got != inbox.PresenceOffline {
		t.Fatalf("at expiry: %q, want offline", got)
	}
	clock = base.Add(24 * time.Hour)
	row = h.deviceRow(t, token, deviceID)
	if row.Inbox.Presence != inbox.PresenceOffline {
		t.Fatalf("a day later: %q, want offline", row.Inbox.Presence)
	}
	// Offline is not "rejected": the device is still a legitimate queue target,
	// which is the whole point of an asynchronous inbox (PRD §7.3).
	if !row.Inbox.CanReceive {
		t.Fatal("an offline but properly enrolled device must still be sendable")
	}
	// The last heartbeat is still reported truthfully rather than erased.
	if row.Inbox.LastHeartbeatAt != base.Unix() {
		t.Fatalf("lastHeartbeatAt = %d, want %d", row.Inbox.LastHeartbeatAt, base.Unix())
	}
}

func TestRegisteringDoesNotImplyPresence(t *testing.T) {
	h := newDeviceHarness(t)
	uid := h.user(t, "quiet@example.com")
	deviceID, token, _ := h.enrolledDevice(t, uid, "CLI")

	// Enrolment says what a device CAN do, not that it is running. A client that
	// registers and then crashes must not leave a sender believing it is online.
	row := h.deviceRow(t, token, deviceID)
	if row.Inbox.Presence != inbox.PresenceOffline {
		t.Fatalf("presence = %q straight after registration, want offline", row.Inbox.Presence)
	}
	if row.Inbox.PresenceExpiresAt != 0 || row.Inbox.LastHeartbeatAt != 0 {
		t.Fatalf("registration wrote presence state: %+v", row.Inbox)
	}
	if !row.Inbox.CanReceive {
		t.Fatal("an enrolled, keyed device should be sendable even before its first heartbeat")
	}
}

// A re-registration (a client restarting and re-announcing its capabilities)
// must not clear presence, and must not restate the first-enrolment timestamp.
func TestReRegistrationPreservesPresenceAndEnrolmentTime(t *testing.T) {
	h := newDeviceHarness(t)
	uid := h.user(t, "rereg@example.com")
	deviceID, token, _ := h.enrolledDevice(t, uid, "CLI")

	base := time.Now()
	clock := base
	h.svc.SetNow(func() time.Time { return clock })
	if code := h.jsonDo(t, "POST", "/api/devices/"+deviceID+"/inbox/heartbeat", `{}`, withBearer(token)).StatusCode; code != http.StatusOK {
		t.Fatalf("heartbeat: %d", code)
	}
	first := h.deviceRow(t, token, deviceID).Inbox

	clock = base.Add(10 * time.Second)
	if code := h.jsonDo(t, "PUT", "/api/devices/"+deviceID+"/inbox",
		`{"platform":"linux","appVersion":"0.16.0","protocolVersions":[2],"capabilities":["inbox.receive.v2"]}`,
		withBearer(token)).StatusCode; code != http.StatusOK {
		t.Fatalf("re-register: %d", code)
	}
	after := h.deviceRow(t, token, deviceID).Inbox
	if after.Presence != inbox.PresenceOnline || after.PresenceExpiresAt != first.PresenceExpiresAt {
		t.Fatalf("re-registration disturbed presence: before %+v after %+v", first, after)
	}
	if after.RegisteredAt != first.RegisteredAt {
		t.Fatalf("registeredAt moved on re-registration: %d -> %d", first.RegisteredAt, after.RegisteredAt)
	}
	if after.AppVersion != "0.16.0" {
		t.Fatalf("appVersion = %q, want the re-announced value", after.AppVersion)
	}
}

// A device shutting down says so, instead of leaving senders to wait out the
// TTL believing it is still there.
func TestGracefulGoodbyeExpiresPresenceButKeepsLastSeenHonest(t *testing.T) {
	h := newDeviceHarness(t)
	uid := h.user(t, "goodbye@example.com")
	deviceID, token, _ := h.enrolledDevice(t, uid, "CLI")

	base := time.Now()
	h.svc.SetNow(func() time.Time { return base })
	if code := h.jsonDo(t, "POST", "/api/devices/"+deviceID+"/inbox/heartbeat", `{}`, withBearer(token)).StatusCode; code != http.StatusOK {
		t.Fatalf("heartbeat: %d", code)
	}
	resp := h.jsonDo(t, "POST", "/api/devices/"+deviceID+"/inbox/offline", `{}`, withBearer(token))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("offline: got %d, want 200", resp.StatusCode)
	}
	row := h.deviceRow(t, token, deviceID).Inbox
	if row.Presence != inbox.PresenceOffline {
		t.Fatalf("presence = %q after goodbye, want offline", row.Presence)
	}
	// last-seen is the honest record of when the device was last heard from; a
	// clean shutdown must not rewrite it into "never".
	if row.LastHeartbeatAt != base.Unix() {
		t.Fatalf("lastHeartbeatAt = %d, want the real last heartbeat %d", row.LastHeartbeatAt, base.Unix())
	}
}

// ---------- invariant 5: who may assert what ----------

// ADVERSARIAL: a browser session is account-wide. If it could heartbeat or
// register a key for a CLI device, a signed-in tab could advertise a server as
// online that is not, or publish a public key whose private half nobody holds —
// which would make every task sealed to it permanently undecryptable.
func TestABrowserSessionCannotSpeakForADevice(t *testing.T) {
	h := newDeviceHarness(t)
	uid := h.user(t, "session-spoof@example.com")
	deviceID, token, _ := h.enrolledDevice(t, uid, "CLI")
	cookie := h.cookie(t, uid)
	withCookie := func(r *http.Request) { r.AddCookie(cookie) }

	rogue := newInboxKeypair(t)
	for _, tc := range []struct{ name, method, path, body string }{
		{"heartbeat", "POST", "/api/devices/" + deviceID + "/inbox/heartbeat", `{}`},
		{"offline", "POST", "/api/devices/" + deviceID + "/inbox/offline", `{}`},
		{"register inbox", "PUT", "/api/devices/" + deviceID + "/inbox", validRegistration},
		{"register key", "POST", "/api/devices/" + deviceID + "/inbox/keys",
			fmt.Sprintf(`{"algorithm":%q,"publicKey":%q}`, inbox.KeyAlgX25519SealedBoxV1, rogue.encoded)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp := h.jsonDo(t, tc.method, tc.path, tc.body, withCookie)
			if resp.StatusCode != http.StatusNotFound {
				t.Fatalf("got %d, want 404", resp.StatusCode)
			}
		})
	}
	row := h.deviceRow(t, token, deviceID).Inbox
	if row.Presence != inbox.PresenceOffline {
		t.Fatalf("a session set presence: %q", row.Presence)
	}
	if row.Key.PublicKey == rogue.encoded {
		t.Fatal("a session replaced the device's public key")
	}
	// Reading is fine — the account owns the device and needs to see its keys.
	if code := h.do(t, "GET", "/api/devices/"+deviceID+"/inbox/keys", withCookie).StatusCode; code != http.StatusOK {
		t.Fatalf("session key history read: got %d, want 200", code)
	}
}

// ADVERSARIAL: one account's bearer must reach nothing of another's, and must
// not be able to distinguish "not yours" from "does not exist".
func TestAnotherAccountCannotTouchADeviceInbox(t *testing.T) {
	h := newDeviceHarness(t)
	victim := h.user(t, "inbox-victim@example.com")
	attacker := h.user(t, "inbox-attacker@example.com")
	deviceID, victimToken, victimKey := h.enrolledDevice(t, victim, "Victim CLI")
	attackerToken := h.bearer(t, attacker, "Attacker Mac")
	keyID := h.deviceRow(t, victimToken, deviceID).Inbox.Key.ID

	rogue := newInboxKeypair(t)
	for _, tc := range []struct{ name, method, path, body string }{
		{"read keys", "GET", "/api/devices/" + deviceID + "/inbox/keys", ""},
		{"revoke key", "POST", "/api/devices/" + deviceID + "/inbox/keys/" + keyID + "/revoke", `{}`},
		{"clear enrolment", "DELETE", "/api/devices/" + deviceID + "/inbox", ""},
		{"heartbeat", "POST", "/api/devices/" + deviceID + "/inbox/heartbeat", `{}`},
		{"re-enrol", "PUT", "/api/devices/" + deviceID + "/inbox", validRegistration},
		{"replace key", "POST", "/api/devices/" + deviceID + "/inbox/keys",
			fmt.Sprintf(`{"algorithm":%q,"publicKey":%q}`, inbox.KeyAlgX25519SealedBoxV1, rogue.encoded)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp := h.jsonDo(t, tc.method, tc.path, tc.body, withBearer(attackerToken))
			if resp.StatusCode != http.StatusNotFound {
				t.Fatalf("got %d, want 404 (no existence disclosure)", resp.StatusCode)
			}
		})
	}
	// Nothing moved.
	row := h.deviceRow(t, victimToken, deviceID).Inbox
	if row == nil || row.Revoked || !row.CanReceive || row.Key.PublicKey != victimKey.encoded {
		t.Fatalf("the victim's enrolment was mutated by another account: %+v", row)
	}
	// And the attacker's own device list does not contain it.
	for _, d := range decodeDevices(t, h.do(t, "GET", "/api/devices", withBearer(attackerToken))) {
		if d.ID == deviceID {
			t.Fatal("another account's device appeared in the attacker's list")
		}
	}
}

// A device that never enrolled (every browser device, and any client build
// predating Phase 1A) carries a null Inbox, which is what makes this field
// additive for the existing web client rather than a breaking change.
func TestUnenrolledDevicesCarryANullInbox(t *testing.T) {
	h := newDeviceHarness(t)
	uid := h.user(t, "legacy@example.com")
	token := h.bearer(t, uid, "Old app")
	deviceID := currentDeviceID(t, h, token)

	resp := h.do(t, "GET", "/api/devices", withBearer(token))
	var raw struct {
		Devices []map[string]any `json:"devices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(raw.Devices) != 1 {
		t.Fatalf("got %d devices, want 1", len(raw.Devices))
	}
	if v, ok := raw.Devices[0]["Inbox"]; !ok || v != nil {
		t.Fatalf("Inbox = %v (present=%v), want an explicit null", v, ok)
	}
	// The fields the web reads today are untouched.
	for _, key := range []string{"ID", "Name", "Kind", "CreatedAt", "LastSeenAt", "Current"} {
		if _, ok := raw.Devices[0][key]; !ok {
			t.Errorf("device response is missing %q", key)
		}
	}
	_ = deviceID
}

func currentDeviceID(t *testing.T, h *deviceHarness, token string) string {
	t.Helper()
	for _, d := range decodeDevices(t, h.do(t, "GET", "/api/devices", withBearer(token))) {
		if d.Current {
			return d.ID
		}
	}
	t.Fatal("no current device for this bearer")
	return ""
}

// ---------- store-level races and constraints ----------

// Two rotations racing from the same predecessor: exactly one may win. The
// loser must be told its rotation is stale rather than forking the key history,
// which would leave two "current" keys and no answer to "which key do I seal
// to".
func TestConcurrentRotationsFromTheSamePredecessorAllowExactlyOneWinner(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, err := st.UpsertUserByEmail(ctx, "race@example.com", "Race")
	if err != nil {
		t.Fatal(err)
	}
	dev, err := st.UpsertDevice(ctx, Device{ID: "race-device", UserID: u.ID, Name: "CLI", Kind: "cli", CreatedAt: 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpsertDeviceInbox(ctx, DeviceInbox{
		DeviceID: dev.ID, UserID: u.ID, ProtocolVersion: inbox.ProtocolV2,
		Capabilities: []string{inbox.CapReceiveV2}, ReceiveCapability: inbox.CapReceiveV2,
		AutoAccept: inbox.AutoAcceptOff, RegisteredAt: 1, UpdatedAt: 1,
	}); err != nil {
		t.Fatal(err)
	}
	first := newInboxKeypair(t)
	base, err := st.RotateDeviceKey(ctx, DeviceKey{
		ID: "k1", DeviceID: dev.ID, UserID: u.ID,
		Algorithm: inbox.KeyAlgX25519SealedBoxV1, PublicKey: first.encoded, CreatedAt: 2,
	}, "")
	if err != nil {
		t.Fatal(err)
	}

	a, b := newInboxKeypair(t), newInboxKeypair(t)
	start := make(chan struct{})
	errs := make(chan error, 2)
	var ready sync.WaitGroup
	ready.Add(2)
	for _, candidate := range []DeviceKey{
		{ID: "k2", DeviceID: dev.ID, UserID: u.ID, Algorithm: inbox.KeyAlgX25519SealedBoxV1, PublicKey: a.encoded, CreatedAt: 3},
		{ID: "k3", DeviceID: dev.ID, UserID: u.ID, Algorithm: inbox.KeyAlgX25519SealedBoxV1, PublicKey: b.encoded, CreatedAt: 4},
	} {
		candidate := candidate
		go func() {
			ready.Done()
			<-start
			_, err := st.RotateDeviceKey(ctx, candidate, base.ID)
			errs <- err
		}()
	}
	ready.Wait()
	close(start)
	var succeeded, stale int
	for range 2 {
		switch err := <-errs; {
		case err == nil:
			succeeded++
		case errors.Is(err, ErrStaleKeyRotation):
			stale++
		default:
			t.Fatalf("concurrent rotation returned unexpected error: %v", err)
		}
	}
	if succeeded != 1 || stale != 1 {
		t.Fatalf("concurrent rotations: succeeded=%d stale=%d, want 1 and 1", succeeded, stale)
	}

	keys, err := st.ListDeviceKeys(ctx, dev.ID, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	active := 0
	for _, k := range keys {
		if k.Active() {
			active++
		}
	}
	if active != 1 {
		t.Fatalf("%d active keys, want exactly 1 (the history forked)", active)
	}
	if len(keys) != 2 {
		t.Fatalf("%d key rows, want 2 (the losing rotation was written)", len(keys))
	}
}

// The generation counter is unique per device by DB constraint, so a fork
// cannot be produced even by bypassing the CAS at the store layer.
func TestDuplicateGenerationIsRejectedByTheDatabase(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, err := st.UpsertUserByEmail(ctx, "gen@example.com", "Gen")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpsertDevice(ctx, Device{ID: "gen-device", UserID: u.ID, Name: "CLI", Kind: "cli", CreatedAt: 1}); err != nil {
		t.Fatal(err)
	}
	insert := func(id string, gen int64) error {
		_, err := st.db.ExecContext(ctx,
			`INSERT INTO device_keys (id, device_id, user_id, algorithm, public_key, generation, created_at, superseded_at, revoked_at)
			 VALUES (?, 'gen-device', ?, ?, ?, ?, 1, 0, 0)`,
			id, u.ID, inbox.KeyAlgX25519SealedBoxV1, newInboxKeypair(t).encoded, gen)
		return err
	}
	if err := insert("g1", 1); err != nil {
		t.Fatalf("first insert: %v", err)
	}
	if err := insert("g2", 1); err == nil {
		t.Fatal("a duplicate generation was accepted — the key history can fork")
	}
	// Supersede the first row before adding a different generation; a separate
	// database constraint (tested below) intentionally blocks two current rows.
	if _, err := st.db.ExecContext(ctx,
		`UPDATE device_keys SET superseded_at = 2 WHERE id = 'g1'`); err != nil {
		t.Fatalf("supersede first generation: %v", err)
	}
	if err := insert("g3", 2); err != nil {
		t.Fatalf("distinct generation rejected: %v", err)
	}
}

// A distinct generation alone must not permit a second current key. The
// partial unique index is the final database-level guard if a future caller
// bypasses the store CAS or forgets to supersede the predecessor first.
func TestTwoActiveKeysAreRejectedByTheDatabase(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, err := st.UpsertUserByEmail(ctx, "active-key@example.com", "Active")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpsertDevice(ctx, Device{ID: "active-device", UserID: u.ID, Name: "CLI", Kind: "cli", CreatedAt: 1}); err != nil {
		t.Fatal(err)
	}
	insert := func(id string, generation int64) error {
		_, err := st.db.ExecContext(ctx,
			`INSERT INTO device_keys (id, device_id, user_id, algorithm, public_key, generation, created_at, superseded_at, revoked_at)
			 VALUES (?, 'active-device', ?, ?, ?, ?, 1, 0, 0)`,
			id, u.ID, inbox.KeyAlgX25519SealedBoxV1, newInboxKeypair(t).encoded, generation)
		return err
	}
	if err := insert("active-1", 1); err != nil {
		t.Fatalf("first active key: %v", err)
	}
	if err := insert("active-2", 2); err == nil {
		t.Fatal("a second active key was accepted")
	}
}

// The device_inbox and device_keys tables must actually carry the ON DELETE
// CASCADE the migration declares — the foreign_keys pragma is what makes it
// real, and a future DSN change that dropped it would silently orphan rows.
func TestDeviceInboxForeignKeysAreEnforced(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	var on int
	if err := st.db.QueryRowContext(ctx, `PRAGMA foreign_keys`).Scan(&on); err != nil {
		t.Fatal(err)
	}
	if on != 1 {
		t.Fatal("foreign_keys pragma is off; the device_inbox/device_keys cascades are decorative")
	}
	_, err := st.db.ExecContext(ctx,
		`INSERT INTO device_inbox (device_id, user_id, registered_at, updated_at) VALUES ('ghost', 'u', 1, 1)`)
	if err == nil {
		t.Fatal("an enrolment was created for a device that does not exist")
	}
	if !strings.Contains(strings.ToUpper(err.Error()), "FOREIGN KEY") {
		t.Fatalf("rejected for the wrong reason: %v", err)
	}
}

// Account deletion must take the Device Inbox with it. Both purge paths delete
// `devices` by user id and rely on the ON DELETE CASCADE for the two new
// tables; that reliance is an assumption about a pragma and a foreign key, so it
// is asserted rather than assumed. A public key is not a secret, but retaining
// per-account rows after a hard purge contradicts the deletion model.
func TestAccountDeletionRemovesDeviceInboxAndKeys(t *testing.T) {
	for _, tc := range []struct {
		name  string
		purge func(t *testing.T, st *SQLiteStore, userID string)
	}{
		{"soft delete (PurgeTransientUserData)", func(t *testing.T, st *SQLiteStore, userID string) {
			if _, err := st.PurgeTransientUserData(context.Background(), userID); err != nil {
				t.Fatalf("purge transient: %v", err)
			}
		}},
		{"hard purge (ArchiveAndPurgeUser)", func(t *testing.T, st *SQLiteStore, userID string) {
			ctx := context.Background()
			// ArchiveAndPurgeUser refuses a user who is not actually due for
			// purge, so schedule the deletion the way the product does.
			if err := st.SetAccountDeletion(ctx, userID, 1, 2); err != nil {
				t.Fatalf("schedule deletion: %v", err)
			}
			if err := st.ArchiveAndPurgeUser(ctx, userID, 1<<40); err != nil {
				t.Fatalf("archive and purge: %v", err)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st := newTestStore(t)
			ctx := context.Background()
			u, err := st.UpsertUserByEmail(ctx, "purge-inbox@example.com", "Purge")
			if err != nil {
				t.Fatal(err)
			}
			dev, err := st.UpsertDevice(ctx, Device{ID: "purge-device", UserID: u.ID, Name: "CLI", Kind: "cli", CreatedAt: 1})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := st.UpsertDeviceInbox(ctx, DeviceInbox{
				DeviceID: dev.ID, UserID: u.ID, ProtocolVersion: inbox.ProtocolV2,
				Capabilities: []string{inbox.CapReceiveV2}, ReceiveCapability: inbox.CapReceiveV2,
				AutoAccept: inbox.AutoAcceptOff, RegisteredAt: 1, UpdatedAt: 1,
			}); err != nil {
				t.Fatal(err)
			}
			if _, err := st.RotateDeviceKey(ctx, DeviceKey{
				ID: "purge-key", DeviceID: dev.ID, UserID: u.ID,
				Algorithm: inbox.KeyAlgX25519SealedBoxV1, PublicKey: newInboxKeypair(t).encoded, CreatedAt: 2,
			}, ""); err != nil {
				t.Fatal(err)
			}
			// Precondition, so "gone afterwards" is not trivially true.
			assertRowCount(t, st, `SELECT COUNT(*) FROM device_inbox WHERE user_id = ?`, u.ID, 1)
			assertRowCount(t, st, `SELECT COUNT(*) FROM device_keys WHERE user_id = ?`, u.ID, 1)

			tc.purge(t, st, u.ID)

			assertRowCount(t, st, `SELECT COUNT(*) FROM device_inbox WHERE user_id = ?`, u.ID, 0)
			assertRowCount(t, st, `SELECT COUNT(*) FROM device_keys WHERE user_id = ?`, u.ID, 0)
		})
	}
}

func assertRowCount(t *testing.T, st *SQLiteStore, query, arg string, want int) {
	t.Helper()
	var got int
	if err := st.db.QueryRowContext(context.Background(), query, arg).Scan(&got); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	if got != want {
		t.Fatalf("%s: got %d rows, want %d", query, got, want)
	}
}

// TestDeviceCanReceiveIsDecidedAgainstTheCurrentNegotiableSet is the regression
// guard for a stored-row-outlives-its-release bug.
//
// A `device_inbox` row keeps whatever `receive_capability` string was negotiated
// when it last registered. Written as a hard-coded `== CapReceiveV1`, the
// eligibility check kept every one of those rows a valid send target across a
// protocol bump — so a v2 sender would have been handed a target that can only
// read v1, encrypted to it, uploaded, and only then discovered the device cannot
// open what it received.
func TestDeviceCanReceiveIsDecidedAgainstTheCurrentNegotiableSet(t *testing.T) {
	key := DeviceKey{ID: "k1", Algorithm: inbox.KeyAlgX25519SealedBoxV1, CreatedAt: 1}
	base := DeviceInbox{
		DeviceID: "d1", ProtocolVersion: inbox.ProtocolV2,
		ReceiveCapability: inbox.CapReceiveV2,
	}
	if !DeviceCanReceive(base, key, true) {
		t.Fatal("a currently-negotiable device must be sendable")
	}
	for _, tc := range []struct {
		name string
		cap  string
	}{
		{"historical v1", inbox.CapReceiveV1},
		{"a version central never defined", "inbox.receive.v9"},
		{"the wrong capability family", inbox.CapAutoAcceptV1},
		{"empty", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stale := base
			stale.ReceiveCapability = tc.cap
			if DeviceCanReceive(stale, key, true) {
				t.Fatalf("%q must not be a send target", tc.cap)
			}
		})
	}
	// The stored PROTOCOL version is gated the same way and for the same reason.
	stale := base
	stale.ProtocolVersion = inbox.ProtocolV1
	if DeviceCanReceive(stale, key, true) {
		t.Fatal("a device still registered at v1 must not be a send target")
	}
	// inbox.text.v1 is not a receive capability and must not become a second
	// gate: a receiver that only takes files is still a perfectly good target.
	textless := base
	textless.Capabilities = []string{inbox.CapReceiveV2}
	if !DeviceCanReceive(textless, key, true) {
		t.Fatal("a file-only receiver must remain sendable")
	}
}
