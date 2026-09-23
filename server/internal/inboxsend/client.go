package inboxsend

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/relayium/relayium/internal/inboxclient"
)

// The sender's own HTTP surface. It deliberately does not reuse
// inboxclient.Client, whose default http.Client follows redirects and decodes
// success bodies without a bound: a sender carries the account bearer and the
// ciphertext, and neither may be re-sent to wherever a 3xx points.
//
//   - Redirects are REFUSED. Every 3xx comes back as an *APIError with
//     CodeRedirectRefused and nothing is re-sent.
//   - Every response body is read through a bound, success and failure alike.
//   - A server's text is never carried further than its machine-readable
//     `error` token, and only a token from the closed set is repeated.
//   - A transport failure is reported without the request URL, which carries
//     upload ids.

const (
	// defaultResponseHeaderTimeout bounds connect/TLS/time-to-first-byte without
	// capping a long request body (an 8 MiB PATCH on a slow link).
	defaultResponseHeaderTimeout = 30 * time.Second
	maxErrorBody                 = 4 << 10
	maxSmallBody                 = 64 << 10
	// maxListBody bounds the two list reads. A task list is at most 500 rows of
	// a few hundred bytes; a device list is bounded by the account's devices.
	maxListBody = 4 << 20
	// maxChunkSize is the largest chunkSize this client accepts from init. The
	// server advertises 8 MiB; a larger value would size the replay buffer.
	maxChunkSize = 16 << 20
)

// inertID is the spelling every server-issued id must have before it is put in
// a request path or a journal: the Web's isInertId rule.
var inertID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// isInertID reports whether id may be interpolated into a request path.
func isInertID(id string) bool { return inertID.MatchString(id) }

// APIError is a non-2xx answer. Code is the server's `error` token when it is
// one this client recognises, else "".
type APIError struct {
	Op     string
	Status int
	Code   string
	// Plain is true when the body was not a JSON object with an `error` field —
	// the shape of today's `409 already finalized` text answer.
	Plain bool
	// Received carries a {"received":N} body (PATCH 409), or -1.
	Received int64
}

func (e *APIError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("%s: %s (HTTP %d)", e.Op, e.Code, e.Status)
	}
	return fmt.Sprintf("%s: HTTP %d", e.Op, e.Status)
}

// TransportError is a request whose answer never arrived (or arrived
// unreadable). For a write it means the outcome is unknown.
type TransportError struct {
	Op  string
	err error
}

func (e *TransportError) Error() string { return e.Op + ": network error: " + describeTransport(e.err) }
func (e *TransportError) Unwrap() error { return e.err }

// describeTransport renders a transport failure without the request URL.
func describeTransport(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	if errors.Is(err, context.Canceled) {
		return "cancelled"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timed out"
	}
	s := err.Error()
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}

func statusOf(err error) int {
	var ae *APIError
	if errors.As(err, &ae) {
		return ae.Status
	}
	return 0
}

func codeOf(err error) string {
	var ae *APIError
	if errors.As(err, &ae) {
		return ae.Code
	}
	return ""
}

func isTransport(err error) bool {
	var te *TransportError
	return errors.As(err, &te)
}

// Client talks to central as the logged-in device.
//
// The bearer is held ONLY inside the authorize closure, never in a field: fmt
// prints a func as an address, and it never calls a Format method on an
// unexported field of an enclosing struct, so no verb applied to a Client — or
// to anything that holds one, pointer or value — can print the credential.
// Format below also keeps a Client's own diagnostics short.
type Client struct {
	server    string
	authorize func(*http.Request)
	hc        *http.Client
}

// Format redacts a Client under every verb.
func (c Client) Format(f fmt.State, _ rune) {
	io.WriteString(f, "inboxsend.Client{server:"+c.server+" credential:redacted}")
}

// ValidateServer checks that server is an absolute http(s) origin the bearer may
// be sent to, and returns its canonical spelling (no trailing slash).
func ValidateServer(server string) (string, error) {
	u, err := url.Parse(strings.TrimRight(server, "/"))
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" ||
		u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return "", errors.New("the stored server address is not a usable http(s) origin")
	}
	return u.Scheme + "://" + u.Host + u.EscapedPath(), nil
}

// NewClient builds a client for server with the bearer token. base, when
// non-nil, is the transport to use (tests); otherwise a clone of the default
// transport with a response-header timeout.
func NewClient(server, token string, base http.RoundTripper) (*Client, error) {
	s, err := ValidateServer(server)
	if err != nil {
		return nil, err
	}
	if base == nil {
		tr := http.DefaultTransport.(*http.Transport).Clone()
		tr.ResponseHeaderTimeout = defaultResponseHeaderTimeout
		base = tr
	}
	bearer := "Bearer " + token
	return &Client{server: s, authorize: func(r *http.Request) { r.Header.Set("Authorization", bearer) }, hc: &http.Client{
		Transport: base,
		// Never follow: the bearer and the ciphertext go to the origin the user
		// logged in to and nowhere else.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}, nil
}

// Server is the canonical origin this client sends to.
func (c *Client) Server() string { return c.server }

type response struct {
	status int
	header http.Header
	body   []byte
}

// roundTrip performs one request and returns the bounded body. A body that
// exceeds limit is an error, not a truncation: a truncated JSON document would
// otherwise parse as something the server did not say.
func (c *Client) roundTrip(ctx context.Context, op, method, path string, hdr http.Header, body []byte, limit int64) (*response, error) {
	var rdr io.Reader = http.NoBody
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.server+path, rdr)
	if err != nil {
		return nil, &TransportError{Op: op, err: err}
	}
	for k, v := range hdr {
		req.Header[k] = v
	}
	c.authorize(req)
	resp, err := c.hc.Do(req)
	if err != nil {
		return nil, &TransportError{Op: op, err: err}
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxErrorBody))
		return nil, &APIError{Op: op, Status: resp.StatusCode, Code: CodeRedirectRefused, Received: -1}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		limit = maxErrorBody
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, &TransportError{Op: op, err: err}
	}
	if int64(len(b)) > limit {
		return nil, &TransportError{Op: op, err: errors.New("response body exceeds its bound")}
	}
	return &response{status: resp.StatusCode, header: resp.Header, body: b}, nil
}

// asAPIError converts a non-2xx response.
func asAPIError(op string, r *response) *APIError {
	e := &APIError{Op: op, Status: r.status, Received: -1, Plain: true}
	var out struct {
		Error    *string `json:"error"`
		Received *int64  `json:"received"`
	}
	if json.Unmarshal(r.body, &out) == nil {
		if out.Error != nil {
			e.Plain = false
			if serverTokens[*out.Error] {
				e.Code = *out.Error
			}
		}
		if out.Received != nil && *out.Received >= 0 {
			e.Plain = false
			e.Received = *out.Received
		}
	}
	return e
}

func (c *Client) getJSON(ctx context.Context, op, path string, limit int64, out any) error {
	r, err := c.roundTrip(ctx, op, http.MethodGet, path, nil, nil, limit)
	if err != nil {
		return err
	}
	if r.status != http.StatusOK {
		return asAPIError(op, r)
	}
	if err := json.Unmarshal(r.body, out); err != nil {
		return &TransportError{Op: op, err: errors.New("unreadable response")}
	}
	return nil
}

// ListDevices is GET /api/devices.
func (c *Client) ListDevices(ctx context.Context) ([]inboxclient.Device, error) {
	var out struct {
		Devices []inboxclient.Device `json:"devices"`
	}
	if err := c.getJSON(ctx, "list devices", "/api/devices", maxListBody, &out); err != nil {
		return nil, err
	}
	return out.Devices, nil
}

// ListKeys is GET /api/devices/{id}/inbox/keys.
func (c *Client) ListKeys(ctx context.Context, deviceID string) ([]inboxclient.Key, error) {
	var out struct {
		Keys []inboxclient.Key `json:"keys"`
	}
	if err := c.getJSON(ctx, "list device keys", devicePath(deviceID, "/inbox/keys"), maxListBody, &out); err != nil {
		return nil, err
	}
	return out.Keys, nil
}

func devicePath(deviceID, suffix string) string {
	return "/api/devices/" + url.PathEscape(deviceID) + suffix
}

func taskPath(deviceID, taskID string) string {
	return devicePath(deviceID, "/inbox/tasks/"+url.PathEscape(taskID))
}

// InitUpload is POST /api/uploads?purpose=device_task. header is the sealed
// manifest; the body is uint32BE(len)||header.
func (c *Client) InitUpload(ctx context.Context, ttl, ciphertextBytes int64, encManifest []byte) (uploadID string, chunkSize int64, err error) {
	q := url.Values{}
	q.Set("purpose", "device_task")
	if ttl > 0 {
		q.Set("ttl", strconv.FormatInt(ttl, 10))
	}
	q.Set("size", strconv.FormatInt(ciphertextBytes, 10))
	body := make([]byte, 4+len(encManifest))
	binary.BigEndian.PutUint32(body, uint32(len(encManifest)))
	copy(body[4:], encManifest)
	hdr := http.Header{"Content-Type": {"application/octet-stream"}}
	r, err := c.roundTrip(ctx, "start upload", http.MethodPost, "/api/uploads?"+q.Encode(), hdr, body, maxSmallBody)
	if err != nil {
		return "", 0, err
	}
	if r.status != http.StatusOK {
		return "", 0, asAPIError("start upload", r)
	}
	var out struct {
		UploadID  string `json:"uploadId"`
		ChunkSize int64  `json:"chunkSize"`
	}
	if json.Unmarshal(r.body, &out) != nil || !isInertID(out.UploadID) ||
		out.ChunkSize <= 0 || out.ChunkSize > maxChunkSize {
		return "", 0, &TransportError{Op: "start upload", err: errors.New("unusable response")}
	}
	return out.UploadID, out.ChunkSize, nil
}

// Append is one PATCH /api/uploads/{id}. It returns the server's committed
// offset from a 200, or an *APIError carrying Received for a 409.
func (c *Client) Append(ctx context.Context, uploadID string, start, total int64, data []byte) (int64, error) {
	hdr := http.Header{
		"Content-Type":  {"application/octet-stream"},
		"Content-Range": {fmt.Sprintf("bytes %d-%d/%d", start, start+int64(len(data))-1, total)},
	}
	r, err := c.roundTrip(ctx, "upload", http.MethodPatch, "/api/uploads/"+url.PathEscape(uploadID), hdr, data, maxSmallBody)
	if err != nil {
		return 0, err
	}
	if r.status != http.StatusOK {
		return 0, asAPIError("upload", r)
	}
	return decodeReceived("upload", r.body)
}

func decodeReceived(op string, b []byte) (int64, error) {
	var out struct {
		Received *int64 `json:"received"`
	}
	if json.Unmarshal(b, &out) != nil || out.Received == nil || *out.Received < 0 {
		return 0, &TransportError{Op: op, err: errors.New("unreadable response")}
	}
	return *out.Received, nil
}

// UploadStatus is GET /api/uploads/{id}: the committed offset of an open
// session. 404 means the session is not open (never existed for this account,
// reaped, or already finalized — the server does not say which).
func (c *Client) UploadStatus(ctx context.Context, uploadID string) (int64, error) {
	r, err := c.roundTrip(ctx, "upload status", http.MethodGet, "/api/uploads/"+url.PathEscape(uploadID), nil, nil, maxSmallBody)
	if err != nil {
		return 0, err
	}
	if r.status != http.StatusOK {
		return 0, asAPIError("upload status", r)
	}
	return decodeReceived("upload status", r.body)
}

// Finalize is POST /api/uploads/{id}/finalize with no body.
func (c *Client) Finalize(ctx context.Context, uploadID string) (storedFileID string, expiresAt int64, err error) {
	r, err := c.roundTrip(ctx, "complete upload", http.MethodPost, "/api/uploads/"+url.PathEscape(uploadID)+"/finalize", nil, nil, maxSmallBody)
	if err != nil {
		return "", 0, err
	}
	if r.status != http.StatusOK {
		return "", 0, asAPIError("complete upload", r)
	}
	var out struct {
		ID        string `json:"id"`
		ExpiresAt int64  `json:"expiresAt"`
	}
	if json.Unmarshal(r.body, &out) != nil || !isInertID(out.ID) || out.ExpiresAt <= 0 {
		return "", 0, &TransportError{Op: "complete upload", err: errors.New("unusable response")}
	}
	return out.ID, out.ExpiresAt, nil
}

// createBody is the exact seven-field create request. It is marshalled once per
// (wrapped key) and those bytes are what every replay sends.
type createBody struct {
	IdempotencyKey      string `json:"idempotencyKey"`
	StoredFileID        string `json:"storedFileId"`
	ProtocolVersion     int    `json:"protocolVersion"`
	WrapAlgorithm       string `json:"wrapAlgorithm"`
	WrappedKey          string `json:"wrappedKey"`
	TargetKeyID         string `json:"targetKeyId"`
	TargetKeyGeneration int64  `json:"targetKeyGeneration"`
}

// CreateTask is POST /api/devices/{target}/inbox/tasks with pre-marshalled body
// bytes, so a replay is byte-identical by construction.
func (c *Client) CreateTask(ctx context.Context, targetID string, body []byte) (inboxclient.Task, bool, error) {
	hdr := http.Header{"Content-Type": {"application/json"}}
	r, err := c.roundTrip(ctx, "queue delivery", http.MethodPost, devicePath(targetID, "/inbox/tasks"), hdr, body, maxSmallBody)
	if err != nil {
		return inboxclient.Task{}, false, err
	}
	if r.status != http.StatusOK && r.status != http.StatusCreated {
		return inboxclient.Task{}, false, asAPIError("queue delivery", r)
	}
	var out struct {
		Task    *inboxclient.Task `json:"task"`
		Created bool              `json:"created"`
	}
	if json.Unmarshal(r.body, &out) != nil || out.Task == nil || !isInertID(out.Task.ID) {
		return inboxclient.Task{}, false, &TransportError{Op: "queue delivery", err: errors.New("unreadable response")}
	}
	return *out.Task, r.status == http.StatusCreated, nil
}

// ListTasks is GET /api/devices/{id}/inbox/tasks?limit=N (newest first).
func (c *Client) ListTasks(ctx context.Context, deviceID string, limit int) ([]inboxclient.Task, error) {
	var out struct {
		Tasks []inboxclient.Task `json:"tasks"`
	}
	p := devicePath(deviceID, "/inbox/tasks") + "?limit=" + strconv.Itoa(limit)
	if err := c.getJSON(ctx, "list deliveries", p, maxListBody, &out); err != nil {
		return nil, err
	}
	return out.Tasks, nil
}

// GetTask is GET /api/devices/{id}/inbox/tasks/{taskId}.
func (c *Client) GetTask(ctx context.Context, deviceID, taskID string) (inboxclient.Task, error) {
	var out struct {
		Task *inboxclient.Task `json:"task"`
	}
	if err := c.getJSON(ctx, "read delivery", taskPath(deviceID, taskID), maxSmallBody, &out); err != nil {
		return inboxclient.Task{}, err
	}
	if out.Task == nil || out.Task.ID != taskID {
		return inboxclient.Task{}, &TransportError{Op: "read delivery", err: errors.New("unusable response")}
	}
	return *out.Task, nil
}

// DeleteTask is DELETE /api/devices/{id}/inbox/tasks/{taskId}.
func (c *Client) DeleteTask(ctx context.Context, deviceID, taskID string) error {
	r, err := c.roundTrip(ctx, "cancel delivery", http.MethodDelete, taskPath(deviceID, taskID), nil, nil, maxSmallBody)
	if err != nil {
		return err
	}
	if r.status != http.StatusOK {
		return asAPIError("cancel delivery", r)
	}
	return nil
}
