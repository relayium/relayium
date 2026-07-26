// Package ext defines the extension-point boundary between the account
// service (open layer: auth, passkey, session — self-hosters need all of it)
// and the commercial admin/billing layer (currently still colocated in
// account, slated to move to a private repo).
//
// AdminHost is deliberately small. It holds only the *Service methods the
// commercial files (billing.go, admin.go, admin_rollout.go,
// admin_templates.go, plan_enforce.go) actually call that are defined
// elsewhere in the open layer — verified by grep, not guessed. It does NOT
// attempt to expose the account Store, Config, or Settings types (nor
// domain types like User, Plan, RolloutTrack, UploadSessionRow, ...): Store
// alone is a ~90-method surface, and all three are defined in account
// itself, so any AdminHost method returning one would force ext to import
// account — which cycles back against account's own compile-time assertion
// that *Service satisfies AdminHost (account already imports ext one way,
// for that assertion). *Service.Store(), .Cfg(), and .ResolveSettings() are
// exported directly on the concrete type instead: the commercial layer can
// call them today because it's still the same package, and once it
// actually moves to a private repo (a later step, not this one — see
// account/service.go's doc comments on Store/Cfg for the full reasoning)
// it will hold its own account.Service (or account.Store) reference rather
// than reaching through this interface for them. *loginThrottle
// (AdminLogins' return type) is excluded for a simpler reason: it's
// unexported, so ext could not even name it in a method signature.
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
	"time"
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

	// Now returns the service's current time. A thin wrapper over the
	// injectable clock account.Service uses internally (defaulted to
	// time.Now, overridden directly by tests) — callers here always observe
	// whatever clock is wired in. Safe to include unlike Store/Cfg/
	// ResolveSettings: its return type is time.Time, not an account type,
	// so it carries no import-cycle risk.
	Now() time.Time

	// HandleAdminConfirm is the step-up confirmation page's POST target.
	// HandleAdminPasskeyDelete/LoginBegin/LoginFinish/RegisterBegin/
	// RegisterFinish and HandleAdminStepUpPasskeyBegin are the admin
	// passkey ceremony endpoints. All seven are route registrations only —
	// RegisterAdmin (admin.go, commercial) wires each to a specific
	// mux.Handle pattern — so, like the rest of AdminHost, their signatures
	// are plain net/http types with no account-specific type to cycle on.
	HandleAdminConfirm(w http.ResponseWriter, r *http.Request)
	HandleAdminPasskeyDelete(w http.ResponseWriter, r *http.Request)
	HandleAdminPasskeyLoginBegin(w http.ResponseWriter, r *http.Request)
	HandleAdminPasskeyLoginFinish(w http.ResponseWriter, r *http.Request)
	HandleAdminPasskeyRegisterBegin(w http.ResponseWriter, r *http.Request)
	HandleAdminPasskeyRegisterFinish(w http.ResponseWriter, r *http.Request)
	HandleAdminStepUpPasskeyBegin(w http.ResponseWriter, r *http.Request)
}
