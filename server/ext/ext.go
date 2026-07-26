// Package ext defines the extension-point boundary between the account
// service (open layer: auth, passkey, session — self-hosters need all of it)
// and the commercial admin/billing layer (currently still colocated in
// account, slated to move to a private repo).
//
// AdminHost is deliberately small. It holds only the *Service methods the
// commercial files (billing.go, admin.go, admin_rollout.go,
// admin_templates.go, plan_enforce.go) actually call that are defined
// elsewhere in the open layer — verified by grep, not guessed. It does NOT
// attempt to expose the account Store or any of its domain types (User,
// Plan, RolloutTrack, UploadSessionRow, ...): that surface is ~90 methods
// wide and pulling it through this interface would mean either duplicating
// most of the account domain model here or importing account from
// ext, which would cycle back against account's own compile-time assertion
// that *Service satisfies AdminHost. Store access is left for phase 3 to
// resolve, most likely by having the commercial package hold its own store
// reference rather than reaching through the host.
//
// ext must never import account: the whole point of this package
// is a boundary the commercial layer can depend on without pulling in
// account internals, and account internals must never depend on the
// commercial layer. account imports ext (one direction only) to assert
// *Service satisfies AdminHost.
package ext

import (
	"context"
	"net/http"
)

// ChangeField is a field's before/after value, used by WriteAudit to record
// what a high-risk admin write actually changed. Old/New are `any` because
// audited fields span int64 (quotas, prices) and string (labels, price ids).
//
// This type is defined here, not in account, purely so AdminHost's
// WriteAudit signature can reference it without account depending on ext for
// the type and ext depending on account for the method — account's
// ChangeField is a type alias to this one (see account/audit_diff.go).
type ChangeField struct {
	Field string `json:"field"`
	Old   any    `json:"old"`
	New   any    `json:"new"`
}

// AdminHost is the subset of the account service that the commercial
// admin/billing layer needs. The account package's *Service satisfies it
// today (see account/ext_assert.go); once the commercial layer moves to a
// private repo, it will depend on this interface instead of on
// account directly.
type AdminHost interface {
	// CSRFGuard rejects state-changing requests whose Origin doesn't match
	// the site's own origin. Used by RegisterAdmin to wrap every admin route.
	CSRFGuard(next http.Handler) http.Handler

	// CookieSecure reports whether auth/admin cookies should carry the
	// Secure attribute (derived from the base URL scheme).
	CookieSecure() bool

	// RequireStepUp turns a high-risk write handler into "render a
	// confirmation page first, apply later". Used by RegisterAdmin to gate
	// the six high-risk admin writes (passkey delete, settings, plan
	// upsert, user plan, token mint, node delete) plus the rollout
	// emergency-release action.
	RequireStepUp(action string, next http.HandlerFunc) http.HandlerFunc

	// WriteAudit appends an admin-audit-log entry.
	WriteAudit(r *http.Request, action, target string, fields []ChangeField, stepUp string)

	// MatchAdminTOTPStep checks a 6-digit code against the configured admin
	// TOTP secret, allowing ±1 time-step of clock skew.
	MatchAdminTOTPStep(code string) (step int64, ok bool)

	// AdminTOTPEnabled reports whether admin login requires a TOTP code.
	AdminTOTPEnabled() bool

	// AdminPasskeyCount reports how many admin passkeys are registered; 0
	// means the login page must not offer the passkey option.
	AdminPasskeyCount(ctx context.Context) int

	// SetTargetVersion and SetEmergencyTargetVersion drive the fleet/BYO
	// rollout tracks the admin rollout panel manages. RollbackByoToPrevious
	// Version is deliberately NOT part of this interface: it returns
	// account.RolloutTrack, a domain type this package does not want to
	// duplicate or import account for (see package doc).
	SetTargetVersion(ctx context.Context, track, version string) error
	SetEmergencyTargetVersion(ctx context.Context, track, version string) error
}
