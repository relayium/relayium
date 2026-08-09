package cloud

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strings"
	"time"
)

// Client is the CLI-side HTTP client for the account-bound cloud API.
// Server is the base URL (e.g. https://relayium.com); Token, once set
// (typically from Login or a loaded Creds), is sent as a bearer token
// by higher-level callers (Task 12/13's up/down).
type Client struct {
	Server string
	HTTP   *http.Client
	Token  string

	// DeviceName is the account-visible label a device-code login asks central
	// to register for this machine (DeviceStart sends it; nothing else reads
	// it). Empty behaves exactly like a pre-label CLI, which is what keeps a new
	// CLI working against an old server and vice versa.
	//
	// It is a field rather than a Login parameter so DeviceStart's signature
	// stays stable, and it is DESCRIPTIVE ONLY: central sanitizes it again on
	// arrival and never authorizes anything on it.
	DeviceName string

	// Progress, if set, is called during Upload and Download with the number of
	// plaintext bytes transferred so far and the total (from the manifest / the
	// summed source file sizes). total may be 0 for an empty transfer. It lets a
	// caller render a progress bar; nil (the default) disables reporting.
	Progress func(done, total int64)

	// sleep is used between poll attempts; overridable in tests so the
	// device-code poll loop doesn't actually block on wall-clock time.
	sleep func(time.Duration)

	// idleTimeout bounds how long a single blob-body Read may stall with no
	// bytes arriving before the download treats the stream as dead and resumes
	// (reconnect + Range). Dropping the blanket http.Client.Timeout removed the
	// only bound on a wedged body; without this a server that accepts the request
	// then dribbles or freezes the body would hang `down`/`up` forever, and the
	// resume loop — which only reacts to read errors/EOF — never engages. 0 uses
	// defaultIdleTimeout; overridable in tests.
	idleTimeout time.Duration
}

// defaultIdleTimeout is the default per-Read stall bound for streaming bodies.
const defaultIdleTimeout = 60 * time.Second

// NewClient builds a Client against the given server base URL.
func NewClient(server string) *Client {
	// Deliberately no blanket http.Client.Timeout: it bounds the WHOLE
	// request including reading the response body, so it would cap the
	// streaming upload (writeUploadBody) and download (blob body) at a fixed
	// wall clock. Any transfer slower than that cap — a large blob, a
	// cold-storage round-trip, a slow link — then dies mid-stream with
	// "context deadline exceeded (Client.Timeout or context cancellation
	// while reading body)". Instead bound only the phases that should be
	// fast (connect, TLS handshake, time-to-first-response-byte) via the
	// transport, and let the body stream for as long as it needs — an
	// interactive `relayium up/down` can always be Ctrl-C'd. Per-request
	// deadlines still ride on the ctx each method threads through.
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.ResponseHeaderTimeout = 30 * time.Second
	return &Client{
		Server: server,
		HTTP:   &http.Client{Transport: &uaTransport{base: tr}},
		sleep:  time.Sleep,
	}
}

// userAgent is the bounded identifier every request from this package carries.
// Set once by the CLI through SetClientVersion; the package cannot compose it
// itself because the release version is stamped into package main by the
// linker.
//
// It exists so the browser approval page can say what is asking for access
// instead of "Go-http-client/2.0". Like every other thing a client says about
// itself, it is descriptive and spoofable — never an authentication signal.
var userAgent = "relayium-cli/unknown (" + runtime.GOOS + "; " + runtime.GOARCH + ")"

// SetClientVersion records the CLI release version in the User-Agent. Called
// once from the CLI's entry point.
func SetClientVersion(v string) {
	// Bounded and single-line: this string is stored by central and rendered on
	// an approval page. A version injected at link time is not attacker
	// controlled, but it is not validated either, and the cost of being sure is
	// one function call.
	v = strings.Join(strings.Fields(v), "-")
	if v == "" {
		v = "unknown"
	}
	if len(v) > 32 {
		v = v[:32]
	}
	userAgent = "relayium-cli/" + v + " (" + runtime.GOOS + "; " + runtime.GOARCH + ")"
}

// uaTransport stamps userAgent on every request the cloud client makes.
//
// A transport rather than a line in each request builder: there are four of
// them today, and the one that gets added later without the header is exactly
// the one whose origin a user would want to see on the approval page.
type uaTransport struct{ base http.RoundTripper }

func (t *uaTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	// A RoundTripper must not modify the request it is handed — the same
	// *Request is reused on redirect and retry.
	clone := req.Clone(req.Context())
	clone.Header.Set("User-Agent", userAgent)
	return t.base.RoundTrip(clone)
}

// DeviceStart is the response from POST /api/cli/device/start.
type DeviceStart struct {
	UserCode        string
	VerificationURI string
	DeviceCode      string
	Interval        int
	ExpiresIn       int
}

// deviceStartRequest is the optional body of POST /api/cli/device/start. The
// label is bound to the pending request here, before the browser sees it, so
// the identity a human approves is the identity that gets persisted — and so
// the terminal can print it while they decide.
type deviceStartRequest struct {
	DeviceName string `json:"device_name,omitempty"`
}

type deviceStartResponse struct {
	UserCode        string `json:"user_code"`
	DeviceCode      string `json:"device_code"`
	VerificationURI string `json:"verification_uri"`
	Interval        int    `json:"interval"`
	ExpiresIn       int    `json:"expires_in"`
}

// postJSON POSTs body (marshaled as JSON, or no body if nil) to path and
// decodes the JSON response into out.
func (c *Client) postJSON(ctx context.Context, path string, body any, out any) error {
	var reader *bytes.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(b)
	} else {
		reader = bytes.NewReader(nil)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Server+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	// Bearer when we have one. It is empty during device login — start/poll are
	// the calls that obtain the token — where the header is simply omitted.
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// The server states its reason in the body ("could not mint a pairing
		// code, try again"); a bare status number throws that away. Bounded read
		// — the body is remote input, and this goes straight to a terminal.
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return &HTTPError{Path: path, Status: resp.StatusCode, Body: strings.TrimSpace(string(b))}
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// DeviceStart calls POST /api/cli/device/start.
func (c *Client) DeviceStart(ctx context.Context) (DeviceStart, error) {
	var resp deviceStartResponse
	// A server that predates labels ignores the extra field, and one that
	// postdates it treats an absent field as "no label" — so neither direction
	// of a mixed-version fleet needs to know which side it is talking to.
	if err := c.postJSON(ctx, "/api/cli/device/start", deviceStartRequest{DeviceName: c.DeviceName}, &resp); err != nil {
		return DeviceStart{}, err
	}
	return DeviceStart{
		UserCode:        resp.UserCode,
		VerificationURI: resp.VerificationURI,
		DeviceCode:      resp.DeviceCode,
		Interval:        resp.Interval,
		ExpiresIn:       resp.ExpiresIn,
	}, nil
}

// Logout revokes the currently configured bearer token on the server.
func (c *Client) Logout(ctx context.Context) error {
	if c.Token == "" {
		return nil
	}
	return c.postJSON(ctx, "/api/auth/logout", nil, nil)
}

type devicePollRequest struct {
	DeviceCode string `json:"device_code"`
}

type devicePollResponse struct {
	Status       string `json:"status"`
	AccessToken  string `json:"access_token"`
	AccountEmail string `json:"account_email"`
}

// DevicePoll calls POST /api/cli/device/poll with the given device code.
// status is one of "authorization_pending", "slow_down", "expired",
// "denied", or "ok" (with accessToken/email populated).
func (c *Client) DevicePoll(ctx context.Context, deviceCode string) (status, accessToken, email string, err error) {
	var resp devicePollResponse
	if err := c.postJSON(ctx, "/api/cli/device/poll", devicePollRequest{DeviceCode: deviceCode}, &resp); err != nil {
		return "", "", "", err
	}
	return resp.Status, resp.AccessToken, resp.AccountEmail, nil
}

// Login drives the full device-code flow: it starts a device authorization,
// invokes notify once with the details so the caller can show the user code
// and verification URL, then polls until the user approves ("ok"), the
// request is denied/expired, or ExpiresIn elapses.
func (c *Client) Login(ctx context.Context, notify func(DeviceStart)) (Creds, error) {
	start, err := c.DeviceStart(ctx)
	if err != nil {
		return Creds{}, fmt.Errorf("device start: %w", err)
	}
	if notify != nil {
		notify(start)
	}

	sleep := c.sleep
	if sleep == nil {
		sleep = time.Sleep
	}

	interval := start.Interval
	if interval < 1 {
		interval = 1
	}

	// Floor the expiry window the same way we floor interval: Client.Server
	// is a user-supplied base URL (self-hosting is supported), so a buggy or
	// hostile server that advertises expires_in <= 0 while forever returning
	// authorization_pending must not be able to hang Login. 600s mirrors the
	// first-party server's deviceCodeTTL and keeps the loop always bounded.
	expiresIn := start.ExpiresIn
	if expiresIn <= 0 {
		expiresIn = 600
	}

	// elapsed tracks logical time (sum of the intervals we've slept for)
	// rather than wall-clock time, so the loop's timeout is deterministic
	// under a stubbed sleep (as in tests) instead of depending on real
	// clock progress that a no-op sleep would never advance.
	elapsed := 0
	for {
		sleep(time.Duration(interval) * time.Second)
		elapsed += interval

		if err := ctx.Err(); err != nil {
			return Creds{}, err
		}

		status, accessToken, email, err := c.DevicePoll(ctx, start.DeviceCode)
		if err != nil {
			return Creds{}, fmt.Errorf("device poll: %w", err)
		}

		switch status {
		case "ok":
			return Creds{Server: c.Server, AccessToken: accessToken, AccountEmail: email}, nil
		case "expired":
			return Creds{}, fmt.Errorf("device login expired before approval")
		case "denied":
			return Creds{}, fmt.Errorf("device login was denied")
		case "slow_down":
			interval += 5
		case "authorization_pending":
			// keep polling
		default:
			return Creds{}, fmt.Errorf("device poll: unexpected status %q", status)
		}

		if elapsed >= expiresIn {
			return Creds{}, fmt.Errorf("device login timed out waiting for approval")
		}
	}
}
