// Stable error codes crossing the helper's trust boundary.
//
// These strings are protocol, not diagnostics: the Electron integrator maps them
// to user-facing copy, so renaming one is a breaking change. They are also the
// ONLY failure detail that reaches a log — see the package doc in serve for why
// no path, filename or destination root may ever accompany them.
package wire

// Code is a stable, host-visible failure classification.
type Code string

const (
	// Transport and lifecycle.
	CodeProtocol         Code = "E_PROTOCOL"
	CodeSequence         Code = "E_SEQUENCE"
	CodeCancelled        Code = "E_CANCELLED"
	CodeHostBackpressure Code = "E_HOST_BACKPRESSURE"
	CodeResponseTooLarge Code = "E_RESPONSE_TOO_LARGE"
	CodeInternal         Code = "E_INTERNAL"

	// Manifest and naming, decided before any byte is written.
	CodeManifest    Code = "E_MANIFEST"
	CodeNameTooLong Code = "E_NAME_TOO_LONG"

	// Destination authority.
	CodeRoot              Code = "E_ROOT"
	CodeReparseComponent  Code = "E_REPARSE_COMPONENT"
	CodeUnsupportedVolume Code = "E_UNSUPPORTED_VOLUME"

	// Filesystem outcomes.
	CodeExists        Code = "E_EXISTS"
	CodeTypeConflict  Code = "E_TYPE_CONFLICT"
	CodeAccess        Code = "E_ACCESS"
	CodeSharing       Code = "E_SHARING"
	CodeNoSpace       Code = "E_NO_SPACE"
	CodeDeletePending Code = "E_DELETE_PENDING"
	CodeNotFound      Code = "E_NOT_FOUND"
	CodeIO            Code = "E_IO"

	// Length accounting.
	CodeLengthExceeded Code = "E_LENGTH_EXCEEDED"
	CodeLengthShort    Code = "E_LENGTH_SHORT"
	CodeShortWrite     Code = "E_SHORT_WRITE"

	// Publication.
	CodePartialPublication Code = "E_PARTIAL_PUBLICATION"
)

// Error is a coded failure. Detail is bounded, non-sensitive context — an
// NTSTATUS in hex, a segment index, a state name. Never a path.
type Error struct {
	Code   Code
	Detail string
}

func (e *Error) Error() string {
	if e.Detail == "" {
		return string(e.Code)
	}
	return string(e.Code) + ": " + e.Detail
}

// Errf builds a coded error.
func Errf(code Code, detail string) *Error { return &Error{Code: code, Detail: detail} }

// CodeOf classifies any error for the wire. An error that is not already coded
// is E_INTERNAL rather than something more specific, because guessing a
// filesystem meaning from an unknown error is how a helper reports a wrong
// cause with confidence.
func CodeOf(err error) Code {
	if err == nil {
		return ""
	}
	var coded *Error
	if asError(err, &coded) {
		return coded.Code
	}
	return CodeInternal
}

// DetailOf returns the bounded detail of a coded error, or "" for anything else.
// An uncoded error's text is deliberately dropped: Go error strings from the
// standard library routinely embed the path that produced them, and that is the
// one thing this boundary must not emit.
func DetailOf(err error) string {
	var coded *Error
	if asError(err, &coded) {
		return coded.Detail
	}
	return ""
}
