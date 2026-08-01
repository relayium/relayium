package account

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/relayium/relayium/httpx"
)

// nodePinVerify matches a node's leaf TLS cert SHA-256 (hex) against want, for
// the reachability probe of an https+pinned node. Mirrors the storage package's
// pin check (kept local so account need not export it from storage).
func nodePinVerify(want string) func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
	return func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
		if len(rawCerts) == 0 {
			return errors.New("node presented no TLS certificate")
		}
		sum := sha256.Sum256(rawCerts[0])
		if subtle.ConstantTimeCompare([]byte(hex.EncodeToString(sum[:])), []byte(want)) != 1 {
			return errors.New("node TLS fingerprint mismatch")
		}
		return nil
	}
}

// nodeCheckResp is the result of an on-demand connectivity probe of one of the
// caller's own nodes, distinct from the passive heartbeat-freshness "online"
// flag: reachable is a live round-trip from central to the node's storage
// endpoint right now.
type nodeCheckResp struct {
	Reachable bool   `json:"reachable"`       // central got an HTTP response from the node just now
	Online    bool   `json:"online"`          // heartbeat seen within the online window
	LatencyMs int64  `json:"latencyMs"`       // probe round-trip, when reachable
	Error     string `json:"error,omitempty"` // why the probe couldn't confirm reachability
}

// handleCheckNode actively probes one of the caller's nodes so a user can
// confirm a freshly deployed node is actually reachable — the passive online dot
// only reflects whether a heartbeat arrived, not whether central can reach the
// node's storage port (which a host firewall often blocks). Non-owner and
// missing ids both 404, so the endpoint never leaks another user's node.
func (s *Service) handleCheckNode(w http.ResponseWriter, r *http.Request, u User) {
	n, ok, err := s.store.GetNode(r.Context(), r.PathValue("id"))
	if err != nil || !ok || n.OwnerUserID != u.ID {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	since := s.now().Add(-nodeOnlineWindow).Unix()
	resp := nodeCheckResp{Online: n.LastSeenAt >= since}

	if n.StorageURL == "" {
		resp.Error = "no storage endpoint (relay-only node)"
		httpx.WriteJSON(w, http.StatusOK, resp)
		return
	}
	start := s.now()
	switch perr := s.ProbeNodeStorage(r.Context(), n); {
	case perr == nil:
		resp.Reachable = true
		resp.LatencyMs = s.now().Sub(start).Milliseconds()
	case errors.Is(perr, errStorageURLNotProbeable):
		resp.Error = "storage URL not probeable"
	default:
		resp.Error = "unreachable — check the node is running and its storage port is open"
	}
	httpx.WriteJSON(w, http.StatusOK, resp)
}

// errStorageURLNotProbeable means the node's advertised storage URL failed the
// SSRF gate, so central declined to make the request at all — a different thing
// from having asked and got nothing back.
var errStorageURLNotProbeable = errors.New("storage URL not probeable")

// ProbeNodeStorage asks, right now, whether central can reach this node's blob
// endpoint. Nil means yes.
//
// This is the question the heartbeat cannot answer: the heartbeat travels
// node→central and blob writes travel central→node, so a node whose blob port
// is closed keeps reporting itself healthy while every write to it fails. Used
// both by the on-demand check button and by StorageProber's sweep, so the two
// can never disagree about what "reachable" means.
//
// Readiness requires a 2xx from /readyz. During a rolling upgrade only, a 404
// falls back to the legacy /healthz endpoint; explicit non-ready responses fail.
func (s *Service) ProbeNodeStorage(ctx context.Context, n Node) error {
	if n.StorageURL == "" {
		return errStorageURLNotProbeable
	}
	// Re-run the SSRF gate: StorageURL is user-controlled and we're about to make
	// central issue an outbound request to it.
	if err := validateNodeStorageURL(n.StorageURL, s.allowPrivateNodeURLs); err != nil {
		return errStorageURLNotProbeable
	}
	// The same SSRF-guarded dialer as blob traffic, and when the node reported a
	// TLS fingerprint, the same pin — so a probe that passes proves the channel
	// real blob traffic uses, not merely that something is listening.
	tr := &http.Transport{DialContext: guardedDialContext(s.allowPrivateNodeURLs)}
	if n.StorageFP != "" {
		tr.TLSClientConfig = &tls.Config{
			InsecureSkipVerify:    true,
			MinVersion:            tls.VersionTLS13,
			VerifyPeerCertificate: nodePinVerify(n.StorageFP),
		}
	}
	client := &http.Client{Timeout: nodeProbeTimeout, Transport: tr}
	pctx, cancel := context.WithTimeout(ctx, nodeProbeTimeout)
	defer cancel()
	base := strings.TrimRight(n.StorageURL, "/")
	req, err := http.NewRequestWithContext(pctx, http.MethodGet, base+"/readyz", nil)
	if err != nil {
		return err
	}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	res.Body.Close()
	if res.StatusCode >= 200 && res.StatusCode < 300 {
		return nil
	}
	// Rolling-upgrade compatibility: an older node does not have /readyz yet.
	// Fall back only for 404; any explicit readiness failure remains a failure.
	if res.StatusCode != http.StatusNotFound {
		return fmt.Errorf("node readiness returned HTTP %d", res.StatusCode)
	}
	legacyReq, err := http.NewRequestWithContext(pctx, http.MethodGet, base+"/healthz", nil)
	if err != nil {
		return err
	}
	legacy, err := client.Do(legacyReq)
	if err != nil {
		return err
	}
	legacy.Body.Close()
	if legacy.StatusCode < 200 || legacy.StatusCode >= 300 {
		return fmt.Errorf("node health returned HTTP %d", legacy.StatusCode)
	}
	return nil
}

const nodeProbeTimeout = 6 * time.Second
