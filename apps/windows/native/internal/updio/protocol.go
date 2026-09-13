// The request and reply shapes, and what the helper refuses outright.
//
// ## Where the trust boundary actually is
//
// `scope.open` carries a directory, and the helper TRUSTS the one it is given.
// It has to: the helper does not know where the app's data lives, and it has no
// way to tell a legitimate root from another. So a compromised MAIN PROCESS can
// point this helper at a different directory, and nothing here prevents that —
// a main process that chooses the root is already inside the boundary, and
// claiming otherwise would be a guarantee this cannot keep.
//
// What the helper does guarantee is everything AFTER that choice. The main
// process derives the root from `app.getPath("userData")` and passes nothing
// from a renderer, from IPC or from the environment; and no later request can
// name a path at all — every one names a single inert component inside the
// already-held scope, or a handle this helper itself issued. So the reachable
// surface is one directory chosen once by main, and a renderer that takes over
// the UI cannot widen it.
//
// ## Errors are a closed set
//
// A code and nothing else. No path, no digest, no publisher subject, no OS error
// text: a helper that echoes what it saw is a helper that leaks what it saw.
package updio

// ProtocolVersion is this helper's own protocol. It is DELIBERATELY unrelated to
// the receive and secret helpers' versions: those protocols are mature and this
// one must be able to change without touching them.
const ProtocolVersion = 1

// Operation names.
const (
	OpHello          = "hello"
	OpScopeOpen      = "scope.open"
	OpScopeIdentity  = "scope.identity"
	OpScopeRemove    = "scope.remove"
	OpScopeRead      = "scope.read"
	OpScopeHash      = "scope.hash"
	OpCustodyCreate  = "custody.create"
	OpCustodyWrite   = "custody.write"
	OpCustodySync    = "custody.sync"
	OpCustodyClose   = "custody.close"
	OpCustodyCommit  = "custody.commit"
	OpCustodyDiscard = "custody.discard"
	OpInstallVerify  = "install.verify"
	OpInstallRun     = "install.run"
)

// Error codes. Closed set; the host maps them to `CustodyError`/`InstallRefusal`.
const (
	CodeProtocol   = "protocol"
	CodeBadName    = "bad-name"
	CodeRedirected = "redirected"
	CodeNotDir     = "not-a-directory"
	CodeExists     = "exists"
	CodeTooLarge   = "too-large"
	CodeIO         = "io"
	CodeNoScope    = "no-scope"
	CodeNoHandle   = "no-handle"
	// CodeNotFound is ABSENCE, kept distinct from `io` so a caller can tell
	// "nothing is there" from "could not tell" — conflating them is how
	// recovery decides about a file it never saw.
	CodeNotFound  = "not-found"
	CodeHandles   = "too-many-handles"
	CodeIdentity  = "identity-changed"
	CodePublisher = "publisher"
	CodeUnsigned  = "unsigned"
	CodeUnavail   = "unavailable"
	CodeNotLock   = "not-lockable"
	CodeNoPin     = "no-expected-publisher"
	CodeCancelled = "cancelled"
)

// Request is one control frame from the host.
type Request struct {
	Op string `json:"op"`
	// Root is the app-owned data directory. `scope.open` only.
	Root string `json:"root,omitempty"`
	// Component is the staging subdirectory. `scope.open` only.
	Component string `json:"component,omitempty"`
	// Name is one inert component inside the held scope.
	Name string `json:"name,omitempty"`
	// To is the publication name for `custody.commit`.
	To string `json:"to,omitempty"`
	// Handle identifies a custody this helper issued.
	Handle uint32 `json:"handle,omitempty"`
	// Receipt is the identity the caller believes the object has.
	Receipt string `json:"receipt,omitempty"`
	// Bytes is the length of the binary frame that MUST follow a write.
	Bytes int `json:"bytes,omitempty"`
	// Max bounds a read.
	Max int `json:"max,omitempty"`
	// Size and SHA256 are the SIGNED manifest's expectation.
	Size   int64  `json:"size,omitempty"`
	SHA256 string `json:"sha256,omitempty"`
	// Publisher is the pinned Authenticode subject. Empty means NO pin, which
	// is a refusal rather than a wildcard.
	Publisher string `json:"publisher,omitempty"`
	// Consent must be exactly `granted` for `install.run`. A missing or
	// misspelled value is a refusal: consent has no default here either.
	Consent string `json:"consent,omitempty"`
}

// Reply is one control frame to the host. Exactly one of Error/values is set.
type Reply struct {
	OK      bool   `json:"ok"`
	Code    string `json:"code,omitempty"`
	Version int    `json:"version,omitempty"`
	// Receipt is the identity of an object this helper created or inspected.
	Receipt string `json:"receipt,omitempty"`
	Handle  uint32 `json:"handle,omitempty"`
	// Present distinguishes "nothing there" from an error, for identity/read.
	Present bool `json:"present,omitempty"`
	// Bytes is the length of the payload frame that FOLLOWS this reply. Set
	// only by `scope.read`, and only when Present. The record travels as bytes
	// rather than as a JSON string: it is up to `MaxJournalBytes`, which no
	// control frame may carry.
	Bytes  int    `json:"bytes,omitempty"`
	SHA256 string `json:"sha256,omitempty"`
	// Verdict is the publisher answer, mirroring `PublisherVerdict`.
	Verdict string `json:"verdict,omitempty"`
	// Gone reports a confirmed absence after a remove or discard.
	Gone bool `json:"gone,omitempty"`
}

func fail(code string) Reply { return Reply{OK: false, Code: code} }

// InertName reports whether a name is one component this helper will act on.
//
// Restated here rather than trusted from the host: this is the last check before
// a name reaches an NT call, and the host being compromised is the case it
// exists for.
func InertName(name string) bool {
	if len(name) == 0 || len(name) > 120 || name == "." || name == ".." {
		return false
	}
	for i := 0; i < len(name); i++ {
		c := name[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9':
		case c == '.' || c == '_' || c == '-':
		default:
			return false
		}
	}
	return true
}
