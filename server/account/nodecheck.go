package account

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
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
	// Re-run the SSRF gate: StorageURL is user-controlled and we're about to make
	// central issue an outbound request to it.
	if verr := validateNodeStorageURL(n.StorageURL, s.allowPrivateNodeURLs); verr != nil {
		resp.Error = "storage URL not probeable"
		httpx.WriteJSON(w, http.StatusOK, resp)
		return
	}

	// A short-timeout probe with the same SSRF-guarded dialer as blob traffic.
	// Any HTTP response — even a 404 from an older node without /healthz — proves
	// reachability; only a dial/timeout error means unreachable. When the node
	// reported a TLS fingerprint (https endpoint), pin it so the probe speaks the
	// same secured channel real blob traffic does.
	tr := &http.Transport{DialContext: guardedDialContext(s.allowPrivateNodeURLs)}
	if n.StorageFP != "" {
		tr.TLSClientConfig = &tls.Config{
			InsecureSkipVerify:    true,
			MinVersion:            tls.VersionTLS13,
			VerifyPeerCertificate: nodePinVerify(n.StorageFP),
		}
	}
	client := &http.Client{Timeout: 6 * time.Second, Transport: tr}
	url := strings.TrimRight(n.StorageURL, "/") + "/healthz"
	ctx, cancel := context.WithTimeout(r.Context(), 6*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	start := s.now()
	res, perr := client.Do(req)
	if perr != nil {
		resp.Reachable = false
		resp.Error = "unreachable — check the node is running and its storage port is open"
		httpx.WriteJSON(w, http.StatusOK, resp)
		return
	}
	res.Body.Close()
	resp.Reachable = true
	resp.LatencyMs = s.now().Sub(start).Milliseconds()
	httpx.WriteJSON(w, http.StatusOK, resp)
}
