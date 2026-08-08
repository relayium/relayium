// Package inboxclient is the CLI-side Device Inbox client (Phase 1C): the HTTP
// surface a receiving device speaks, its persistent local state (configuration,
// X25519 private-key history and per-task crash journals), and the foreground
// worker that claims, downloads, verifies and atomically commits encrypted
// deliveries into one fixed directory.
//
// PRE-IMPLEMENTATION INVARIANTS. Each is asserted by a test in this package or
// in cmd/relayium; changing one of them is a protocol or product change, not a
// refactor.
//
//  1. THE PRIVATE KEY NEVER LEAVES. The only key material this package sends to
//     central is a 32-byte X25519 PUBLIC key. There is no request field, and no
//     code path, that transmits a private key, an unsealed content key, a
//     manifest plaintext, a file name or a destination path.
//  2. PERSIST BEFORE PUBLISH. A generated private key is durably written (0600
//     inside a 0700 directory, temp file + fsync + rename + directory fsync)
//     BEFORE its public half is registered. The reverse order would let a crash
//     publish a key whose private half nobody holds, making every task sealed to
//     it permanently undecryptable.
//  3. KEYS ARE RETAINED BY GENERATION. Rotating does not delete the superseded
//     private key, so a task sealed before the rotation still decrypts. Only an
//     explicit `inbox disable` (after central confirms the enrolment is cleared)
//     destroys private keys.
//  4. `saved` IS EARNED. It is reported only after the whole authenticated
//     stream verified AND every planned destination was committed durably. A
//     ciphertext that merely arrived is never reported saved.
//  5. NEVER OVERWRITE. Commit is link(2)-based, which fails closed on an
//     existing name; there is no code path that renames over, truncates, opens,
//     executes or extracts an existing file.
//  6. ERRORS ARE OPAQUE. Everything reported to central comes from the closed
//     inbox.TaskErr* set. There is no free-text field, so a file name cannot
//     reach central even when the device is explaining exactly why it failed.
package inboxclient

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// ClaimTokenHeader carries the one-time claim token on ciphertext reads. It is
// a bearer for advancing one task and is never written to disk or logged.
const ClaimTokenHeader = "X-Relayium-Inbox-Claim"

// maxErrorBody bounds how much of a rejection body is read before it is parsed
// for the machine-readable `error` token. The body is remote input on a path
// that ends in a terminal, so it is bounded and never echoed verbatim.
const maxErrorBody = 4 << 10

// defaultResponseHeaderTimeout bounds the fast phases of a request (connect,
// TLS, time to first response byte) without capping a streaming ciphertext
// body, which legitimately runs for as long as the transfer needs. Mirrors
// cloud.NewClient's reasoning.
const defaultResponseHeaderTimeout = 30 * time.Second

// Client is the device half of the Device Inbox HTTP API. Server is the base
// URL the device is logged in to (self-hosting supported; every path below is
// relative to it), and Token is the CLI bearer bound to DeviceID's row.
//
// Every device-side call requires BOTH the bearer (device-self) and, for task
// progress, the current claim token — see the protocol doc §15.
type Client struct {
	Server   string
	Token    string
	DeviceID string
	HTTP     *http.Client
}

// NewClient builds a Client against server. Deliberately no blanket
// http.Client.Timeout: it would bound the whole request including the streaming
// ciphertext body, killing any transfer slower than the cap mid-stream.
func NewClient(server, token string) *Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.ResponseHeaderTimeout = defaultResponseHeaderTimeout
	return &Client{Server: strings.TrimRight(server, "/"), Token: token, HTTP: &http.Client{Transport: tr}}
}

// APIError is a rejection central stated in machine-readable form. Code is the
// `error` token from the protocol doc (§8 and §16) and is what callers branch
// on; the response body is never carried further, so nothing a server says can
// smuggle unbounded text into a log line.
type APIError struct {
	Op     string
	Status int
	Code   string
}

func (e *APIError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("relayium inbox: %s: %s (HTTP %d)", e.Op, e.Code, e.Status)
	}
	return fmt.Sprintf("relayium inbox: %s: HTTP %d", e.Op, e.Status)
}

// ErrorCode returns the machine-readable token of err, or "" if err is not an
// APIError. Callers use it instead of string matching on Error().
func ErrorCode(err error) string {
	var ae *APIError
	if errors.As(err, &ae) {
		return ae.Code
	}
	return ""
}

// ErrorStatus returns the HTTP status of err, or 0 if err is not an APIError.
func ErrorStatus(err error) int {
	var ae *APIError
	if errors.As(err, &ae) {
		return ae.Status
	}
	return 0
}

// Key is one entry of the device's public-key history as central reports it.
// There is no private-key field here by construction (invariant 1).
type Key struct {
	ID           string
	Algorithm    string
	PublicKey    string
	Generation   int64
	CreatedAt    int64
	SupersededAt int64
	RevokedAt    int64
}

// Active reports whether new tasks are sealed to this key.
func (k Key) Active() bool { return k.SupersededAt == 0 && k.RevokedAt == 0 }

// InboxView is the enrolment central holds for a device.
type InboxView struct {
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
	Key                      *Key
}

// Device is one row of GET /api/devices.
type Device struct {
	ID         string
	Name       string
	Kind       string
	CreatedAt  int64
	LastSeenAt int64
	// Current is true for exactly the device row whose bearer authenticated the
	// request, which is how a CLI discovers which device it IS.
	Current bool
	Inbox   *InboxView
}

// Task is the account-visible view of one queued delivery.
type Task struct {
	ID                  string
	TargetDeviceID      string
	SourceDeviceID      string
	IdempotencyKey      string
	StoredFileID        string
	State               string
	ErrorCode           string
	CiphertextBytes     int64
	WrapAlgorithm       string
	TargetKeyID         string
	TargetKeyGeneration int64
	Attempts            int64
	NextAttemptAt       int64
	LeaseExpiresAt      int64
	CreatedAt           int64
	UpdatedAt           int64
	ExpiresAt           int64
	NotifiedAt          int64
	SavedAt             int64
	TerminalAt          int64
	Terminal            bool
}

// Delivery is the claim response: a Task plus the material only the target
// device may hold — the sealed content key, the encrypted manifest, and the
// claim token that authorizes this worker's progress reports. None of the three
// is ever written to disk or logged.
type Delivery struct {
	Task
	EncManifest string // standard base64
	WrappedKey  string // raw base64url, exactly inbox.SealedBoxBytes decoded
	ClaimToken  string
}

// EnrolResult echoes what the two sides agreed on. A client that cannot satisfy
// the negotiated version/capability must stop rather than guess.
type EnrolResult struct {
	Inbox             InboxView
	ProtocolVersion   int
	ReceiveCapability string
	KeyAlgorithm      string
}

// HeartbeatResult reports the presence central recorded and the cadence it
// expects, so the worker follows the server's advertised interval rather than a
// compiled-in guess that could drift from the protocol.
type HeartbeatResult struct {
	Presence                 string
	PresenceExpiresAt        int64
	HeartbeatIntervalSeconds int
}

func (c *Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return http.DefaultClient
}

// devicePath builds a device-scoped URL. The device id comes from central's own
// device list, but it is escaped anyway so no value can ever smuggle extra path
// segments into a request URL.
func (c *Client) devicePath(suffix string) string {
	return c.Server + "/api/devices/" + url.PathEscape(c.DeviceID) + suffix
}

// do performs one request, decoding a 2xx JSON body into out (nil to discard)
// and turning anything else into an *APIError carrying the machine-readable
// code.
func (c *Client) do(ctx context.Context, op, method, u string, body, out any) error {
	var rdr io.Reader = http.NoBody
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rdr)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return fmt.Errorf("relayium inbox: %s: %w", op, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &APIError{Op: op, Status: resp.StatusCode, Code: decodeErrorCode(resp.Body)}
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxErrorBody))
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("relayium inbox: %s: malformed response: %w", op, err)
	}
	return nil
}

// decodeErrorCode extracts the `error` token from a bounded prefix of a
// rejection body. A body that is not JSON, or carries no token, yields "" —
// the caller then reports the status alone rather than echoing server text.
func decodeErrorCode(r io.Reader) string {
	b, err := io.ReadAll(io.LimitReader(r, maxErrorBody))
	if err != nil {
		return ""
	}
	var out struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(b, &out) != nil {
		return ""
	}
	return out.Error
}

// CurrentDevice returns the device row this bearer authenticates as. A CLI
// cannot assume its device id: it is minted server-side when the login is
// approved, so the honest way to learn it is to ask which row is Current.
//
// A cookie-authenticated caller never marks a row, and this client only ever
// sends a bearer, so exactly one row can be Current.
func (c *Client) CurrentDevice(ctx context.Context) (Device, error) {
	var out struct {
		Devices []Device `json:"devices"`
	}
	if err := c.do(ctx, "list devices", http.MethodGet, c.Server+"/api/devices", nil, &out); err != nil {
		return Device{}, err
	}
	for _, d := range out.Devices {
		if d.Current {
			return d, nil
		}
	}
	return Device{}, ErrNoCurrentDevice
}

// ErrNoCurrentDevice means central did not mark any row as the caller's own.
// That is a credential problem (a revoked/rotated token, or a session cookie
// where a bearer was expected), not a transient failure, so it is distinct from
// a network error.
var ErrNoCurrentDevice = errors.New("relayium inbox: this credential is not bound to a device (run `relayium login` again)")

// EnrolRequest is the device's self-description. Everything in it is bounded and
// validated by central; nothing derived from a received file appears here.
type EnrolRequest struct {
	Platform         string   `json:"platform"`
	AppVersion       string   `json:"appVersion"`
	ProtocolVersions []int    `json:"protocolVersions"`
	Capabilities     []string `json:"capabilities"`
	AutoAccept       string   `json:"autoAccept"`
	ReceiveDirReady  bool     `json:"receiveDirReady"`
}

// Enrol announces protocol versions and capabilities (PUT .../inbox). Central
// fails closed on an empty intersection, so a 409 here is the client's signal to
// upgrade or stop — never to retry with a guessed default.
func (c *Client) Enrol(ctx context.Context, req EnrolRequest) (EnrolResult, error) {
	var out struct {
		Inbox             InboxView `json:"inbox"`
		ProtocolVersion   int       `json:"protocolVersion"`
		ReceiveCapability string    `json:"receiveCapability"`
		KeyAlgorithm      string    `json:"keyAlgorithm"`
	}
	if err := c.do(ctx, "enrol device inbox", http.MethodPut, c.devicePath("/inbox"), req, &out); err != nil {
		return EnrolResult{}, err
	}
	return EnrolResult{
		Inbox: out.Inbox, ProtocolVersion: out.ProtocolVersion,
		ReceiveCapability: out.ReceiveCapability, KeyAlgorithm: out.KeyAlgorithm,
	}, nil
}

// RegisterKey publishes a public key (POST .../inbox/keys). previousKeyID is the
// compare-and-swap input: empty means "I have no key yet" and is refused if one
// exists; otherwise it must name the key currently active. That is what makes a
// captured request useless on replay.
func (c *Client) RegisterKey(ctx context.Context, algorithm, publicKey, previousKeyID string) (Key, error) {
	body := map[string]string{"algorithm": algorithm, "publicKey": publicKey}
	if previousKeyID != "" {
		body["previousKeyId"] = previousKeyID
	}
	var out struct {
		Key Key `json:"key"`
	}
	if err := c.do(ctx, "register device key", http.MethodPost, c.devicePath("/inbox/keys"), body, &out); err != nil {
		return Key{}, err
	}
	return out.Key, nil
}

// ListKeys returns the device's key history, newest first. Used to reconcile
// after a lost registration response: the local private key is already durable,
// so matching it back to the server's key id needs no new key.
func (c *Client) ListKeys(ctx context.Context) ([]Key, error) {
	var out struct {
		Keys []Key `json:"keys"`
	}
	if err := c.do(ctx, "list device keys", http.MethodGet, c.devicePath("/inbox/keys"), nil, &out); err != nil {
		return nil, err
	}
	return out.Keys, nil
}

// Heartbeat refreshes presence and reports whether the receive directory is
// usable right now. receiveDirReady is checked immediately before each call, so
// a device whose disk went away stops advertising a directory it cannot write.
func (c *Client) Heartbeat(ctx context.Context, receiveDirReady bool) (HeartbeatResult, error) {
	var out HeartbeatResult
	body := map[string]bool{"receiveDirReady": receiveDirReady}
	if err := c.do(ctx, "heartbeat", http.MethodPost, c.devicePath("/inbox/heartbeat"), body, &out); err != nil {
		return HeartbeatResult{}, err
	}
	return out, nil
}

// Offline is the graceful goodbye of a worker shutting down: it expires the
// device's own presence immediately instead of leaving senders to wait out the
// TTL believing the machine is still there.
func (c *Client) Offline(ctx context.Context) error {
	return c.do(ctx, "offline", http.MethodPost, c.devicePath("/inbox/offline"), nil, nil)
}

// Pending is the cheap "is there work" poll. It marks queued tasks notified and
// leases nothing, so it is safe to call on a backoff schedule.
func (c *Client) Pending(ctx context.Context, limit int) ([]Task, error) {
	u := c.devicePath("/inbox/pending")
	if limit > 0 {
		u += "?limit=" + strconv.Itoa(limit)
	}
	var out struct {
		Tasks []Task `json:"tasks"`
	}
	if err := c.do(ctx, "poll pending", http.MethodGet, u, nil, &out); err != nil {
		return nil, err
	}
	return out.Tasks, nil
}

// Claim leases work and is the ONLY source of delivery material. leaseSeconds is
// central's own lease TTL, which the worker uses to schedule progress reports
// rather than assuming the compiled-in constant.
func (c *Client) Claim(ctx context.Context, max int) (deliveries []Delivery, leaseSeconds int, err error) {
	var out struct {
		Tasks        []Delivery `json:"tasks"`
		LeaseSeconds int        `json:"leaseSeconds"`
	}
	if err := c.do(ctx, "claim tasks", http.MethodPost, c.devicePath("/inbox/claim"), map[string]int{"max": max}, &out); err != nil {
		return nil, 0, err
	}
	return out.Tasks, out.LeaseSeconds, nil
}

// Report records progress, the final commit, or a failure. Repeating the current
// state is an idempotent lease renewal, which is how a long download keeps its
// claim alive without inventing a separate heartbeat endpoint.
//
// committed must be true only for state == inbox.TaskSaved, and only after every
// planned destination is durably on disk. Central cannot observe the commit, so
// the assertion is the whole basis for `saved`.
func (c *Client) Report(ctx context.Context, taskID, claimToken, state, errorCode string, committed bool) (Task, error) {
	body := map[string]any{
		"claimToken": claimToken, "state": state,
		"errorCode": errorCode, "committed": committed,
	}
	var out struct {
		Task  Task   `json:"task"`
		Error string `json:"error"`
	}
	err := c.do(ctx, "report task", http.MethodPost, c.taskPath(taskID, "/report"), body, &out)
	return out.Task, err
}

// Accept resolves an attention_required task from this machine: true re-queues
// it, false ends it as failed_terminal/user_declined.
func (c *Client) Accept(ctx context.Context, taskID string, accept bool) (Task, error) {
	var out struct {
		Task Task `json:"task"`
	}
	err := c.do(ctx, "accept task", http.MethodPost, c.taskPath(taskID, "/accept"), map[string]bool{"accept": accept}, &out)
	return out.Task, err
}

// ClearInbox removes this device's enrolment and its whole key history
// (DELETE .../inbox), which also terminates its unfinished tasks as revoked. It
// is the server half of `relayium inbox disable`, and must succeed before any
// local private key is destroyed.
func (c *Client) ClearInbox(ctx context.Context) error {
	return c.do(ctx, "clear device inbox", http.MethodDelete, c.devicePath("/inbox"), nil, nil)
}

func (c *Client) taskPath(taskID, suffix string) string {
	return c.devicePath("/inbox/tasks/" + url.PathEscape(taskID) + suffix)
}

// BlobResponse is one ciphertext stream. Body must be closed by the caller.
type BlobResponse struct {
	Body io.ReadCloser
	// Partial reports whether the server honoured a Range request with a 206.
	// A resume answered with a full 200 is NOT a tail, and treating it as one
	// would splice the start of the object into the middle of the stream.
	Partial bool
	Status  int
}

// Blob opens the task's ciphertext, resuming at offset when non-zero. The claim
// token travels in a header rather than the URL so it cannot reach a proxy log
// or a browser history the way a query parameter would.
//
// The caller is responsible for checking Partial: when offset > 0 and the server
// answered 200, the stream must be restarted from scratch.
func (c *Client) Blob(ctx context.Context, taskID, claimToken string, offset int64) (*BlobResponse, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.taskPath(taskID, "/blob"), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set(ClaimTokenHeader, claimToken)
	if offset > 0 {
		req.Header.Set("Range", "bytes="+strconv.FormatInt(offset, 10)+"-")
	}
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("relayium inbox: fetch ciphertext: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		code := decodeErrorCode(resp.Body)
		resp.Body.Close()
		return nil, &APIError{Op: "fetch ciphertext", Status: resp.StatusCode, Code: code}
	}
	return &BlobResponse{Body: resp.Body, Partial: resp.StatusCode == http.StatusPartialContent, Status: resp.StatusCode}, nil
}

// DecodeEncManifest decodes the claim response's encrypted manifest. Standard
// base64, matching GET /api/files/{id}/meta, so a client has one decoding rule
// for the manifest wherever it obtains it.
func DecodeEncManifest(s string) ([]byte, error) {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("relayium inbox: malformed encrypted manifest encoding: %w", err)
	}
	return b, nil
}
