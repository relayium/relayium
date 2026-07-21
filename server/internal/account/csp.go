package account

import (
	"context"
	"net/http"
)

// cspNonceKey carries the per-request CSP script nonce minted by the server's
// securityHeaders middleware. Server-rendered pages in this package (the admin
// dashboard/login/confirm pages and the /device approval page) stamp it on
// their inline <script nonce="…"> tags so those scripts execute under a
// script-src that no longer allows 'unsafe-inline'.
type cspNonceKey struct{}

// WithCSPNonce returns a context carrying nonce, for the middleware to attach.
func WithCSPNonce(ctx context.Context, nonce string) context.Context {
	return context.WithValue(ctx, cspNonceKey{}, nonce)
}

// CSPNonce returns the request's CSP script nonce, or "" if the request did not
// pass through the middleware (e.g. a direct handler unit test — such pages then
// render a nonce-less <script>, which simply won't execute under the strict CSP
// but keeps tests from panicking).
func CSPNonce(r *http.Request) string {
	n, _ := r.Context().Value(cspNonceKey{}).(string)
	return n
}
