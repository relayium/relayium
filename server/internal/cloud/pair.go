package cloud

import (
	"context"
	"fmt"
)

// Pair is a freshly minted cross-network pairing code and the unix time it
// expires. CLI-side mirror of web/src/lib/transfer-link.ts's createPair.
type Pair struct {
	Code      string
	ExpiresAt int64
}

type pairResponse struct {
	Code      string `json:"code"`
	ExpiresAt int64  `json:"expiresAt"`
}

// MintPair mints a pairing code owned by the logged-in account. It requires
// Token: minting is account-attributed, while joining a code's room stays
// anonymous — only the sender signs in.
func (c *Client) MintPair(ctx context.Context) (Pair, error) {
	var resp pairResponse
	if err := c.postJSON(ctx, "/api/pair", nil, &resp); err != nil {
		return Pair{}, err
	}
	if resp.Code == "" {
		return Pair{}, fmt.Errorf("/api/pair: server returned an empty code")
	}
	return Pair{Code: resp.Code, ExpiresAt: resp.ExpiresAt}, nil
}

// HTTPError carries the status and message of a failed API call so a caller can
// tell "log in again" (401) from "slow down" (429) without parsing prose, and
// can still show the operator what the server actually said.
type HTTPError struct {
	Path   string
	Status int
	Body   string
}

func (e *HTTPError) Error() string {
	if e.Body != "" {
		return fmt.Sprintf("%s: %s (HTTP %d)", e.Path, e.Body, e.Status)
	}
	return fmt.Sprintf("%s: unexpected status %d", e.Path, e.Status)
}
