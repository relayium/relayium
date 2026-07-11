package cloud

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
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

	// sleep is used between poll attempts; overridable in tests so the
	// device-code poll loop doesn't actually block on wall-clock time.
	sleep func(time.Duration)
}

// NewClient builds a Client against the given server base URL.
func NewClient(server string) *Client {
	return &Client{
		Server: server,
		HTTP:   &http.Client{Timeout: 30 * time.Second},
		sleep:  time.Sleep,
	}
}

// DeviceStart is the response from POST /api/cli/device/start.
type DeviceStart struct {
	UserCode        string
	VerificationURI string
	DeviceCode      string
	Interval        int
	ExpiresIn       int
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
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("%s: unexpected status %d", path, resp.StatusCode)
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// DeviceStart calls POST /api/cli/device/start.
func (c *Client) DeviceStart(ctx context.Context) (DeviceStart, error) {
	var resp deviceStartResponse
	if err := c.postJSON(ctx, "/api/cli/device/start", nil, &resp); err != nil {
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
