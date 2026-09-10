//go:build windows

// Verifying an installer, and launching the file that was verified.
//
// ## The identity is held, not re-resolved
//
// The file is opened handle-relative beneath the staging handle, its id is
// compared to the receipt, its size and SHA-256 are read THROUGH that handle,
// and Authenticode is asked about that same open file. The handle stays open
// across `CreateProcessW`, opened with `FILE_SHARE_READ` only — the loader must
// be able to map the image, but nothing may write it, rename it or delete it
// while we hold it. That, plus the ancestor chain held since `scope.open`, is
// what makes the path handed to `CreateProcessW` denote the object verified.
//
// It is NOT proven by the path string. `CreateProcessW` takes a name, and a name
// is only as stable as the components above it — which is why the traversal
// starts at the volume root and every ancestor handle is retained.
//
// ## Trust is a return value of zero
//
// `WinVerifyTrust` returns a trust-provider status. Anything but `ERROR_SUCCESS`
// is a refusal, including values that are not `TRUST_E_*`.
//
// ## The publisher comes from the VERIFIED signer
//
// `WTHelperGetProvSignerFromChain` on the state data `WinVerifyTrust` just
// produced, then the first certificate of that signer's chain. Enumerating the
// file's certificate collection and taking a subject would read a certificate
// the file's author chose, not the one that was validated.
//
// Primary sources:
// https://learn.microsoft.com/en-us/windows/win32/api/wintrust/nf-wintrust-winverifytrust
// https://learn.microsoft.com/en-us/windows/win32/api/wintrust/ns-wintrust-wintrust_file_info
package updio

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"runtime"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Publisher verdicts, mirroring the host's `PublisherVerdict` exactly.
const (
	VerdictExpected = "signed-by-expected-publisher"
	VerdictOther    = "signed-by-other-publisher"
	VerdictUnsigned = "unsigned"
	VerdictUnavail  = "unavailable"
)

var (
	wintrust                             = windows.NewLazySystemDLL("wintrust.dll")
	procWinVerifyTrust                   = wintrust.NewProc("WinVerifyTrust")
	procWTHelperProvDataFromState        = wintrust.NewProc("WTHelperProvDataFromStateData")
	procWTHelperGetProvSignerFrom        = wintrust.NewProc("WTHelperGetProvSignerFromChain")
	actionGenericVerifyV2                = windows.GUID{Data1: 0x00AAC56B, Data2: 0xCD44, Data3: 0x11D0, Data4: [8]byte{0x8C, 0xC2, 0x00, 0xC0, 0x4F, 0xC2, 0x95, 0xEE}}
	trustERRSuccess               uint32 = 0
)

// WinVerifyTrust statuses this build distinguishes. The function returns LONG,
// which `Call` widens to a `uintptr`; only the low 32 bits are the status.
const (
	trustNoSignature        uint32 = 0x800B0100 // TRUST_E_NOSIGNATURE
	trustSubjectFormUnknown uint32 = 0x800B0003 // TRUST_E_SUBJECT_FORM_UNKNOWN
	trustProviderUnknown    uint32 = 0x800B0001 // TRUST_E_PROVIDER_UNKNOWN
	trustActionUnknown      uint32 = 0x800B0002 // TRUST_E_ACTION_UNKNOWN
)

const (
	wtdUINone            = 2
	wtdRevokeWholeChain  = 1
	wtdChoiceFile        = 1
	wtdStateActionVerify = 1
	wtdStateActionClose  = 2

	// dwProvFlags is ZERO. Every value that could go here changes what "trusted"
	// means, and none of them is wanted:
	//
	//   * `WTD_USE_IE4_TRUST_FLAG` (0x1) selects the IE4 policy. An earlier
	//     revision set it while calling it "safer", which it is not.
	//   * `WTD_SAFER_FLAG` (0x100) is documented as unsupported.
	//   * `WTD_CACHE_ONLY_URL_RETRIEVAL` (0x1000) forbids fetching revocation
	//     data. Combined with whole-chain revocation on a machine with no cached
	//     CRLs — a fresh CI runner, or a user's first run — that turns a
	//     genuinely signed installer into a refusal.
	//
	// https://learn.microsoft.com/en-us/windows/win32/api/wintrust/ns-wintrust-wintrust_data
	wtdProvFlagsNone = 0

	// The canonical subject encoding, chosen once and written down.
	//
	// `CERT_NAME_RDN_TYPE` with `CERT_X500_NAME_STR` yields the full X.500
	// subject — not `CERT_NAME_SIMPLE_DISPLAY_TYPE`, which is a friendly label
	// chosen from whatever the certificate happens to carry, and pinning an
	// identity to a display string is pinning to something ambiguous.
	//
	// `CERT_NAME_STR_REVERSE_FLAG` is REQUIRED and is NOT the default.
	// `CertNameToStr` documents forward order unless it is set, while .NET's
	// `X500DistinguishedName.Name` — which is what
	// `(Get-AuthenticodeSignature x).SignerCertificate.Subject` returns, and so
	// what anyone configuring the pin will paste — decodes reversed. Without the
	// flag a multi-RDN publisher such as `CN=…, O=…, L=…, S=…, C=US` renders in
	// the opposite order, and a perfectly valid signature is refused as the
	// wrong publisher.
	//
	// The pin's canonical form is therefore: the X.500 subject exactly as .NET
	// renders it. One encoding, stated here, matched by the fixture from an
	// independent source rather than from this code.
	//
	// https://learn.microsoft.com/en-us/windows/win32/api/wincrypt/nf-wincrypt-certnametostra
	// https://learn.microsoft.com/en-us/windows/win32/api/wincrypt/nf-wincrypt-certgetnamestringa
	certNameRDNType    = 2
	certX500NameStr    = 3
	certNameStrReverse = 0x02000000

	// GetFinalPathNameByHandleW flags. x/sys declares the call but not these.
	// `VOLUME_NAME_DOS | FILE_NAME_NORMALIZED` is what CreateProcessW can open.
	fileNameNormalized = 0x0
	volumeNameDOS      = 0x0
)

type wintrustFileInfo struct {
	Size         uint32
	FilePath     *uint16
	File         windows.Handle
	KnownSubject *windows.GUID
}

// wintrustData is WINTRUST_DATA.
//
// ## Every pointer field is typed as a pointer, deliberately
//
// The union member is `unsafe.Pointer`, not `uintptr`. They are the same width,
// so the ABI is unchanged — but a `uintptr` is just an integer to the garbage
// collector, and the `WINTRUST_FILE_INFO` it addresses would be reachable from
// nothing while `WinVerifyTrust` was reading it. Typing the field keeps the
// referent alive for as long as this structure is, which is what the call
// actually requires. The same reasoning applies to the LPVOID fields, which stay
// nil here but are declared honestly.
//
// https://learn.microsoft.com/en-us/windows/win32/api/wintrust/ns-wintrust-wintrust_data
type wintrustData struct {
	Size                            uint32
	PolicyCallbackData              unsafe.Pointer
	SIPClientData                   unsafe.Pointer
	UIChoice                        uint32
	RevocationChecks                uint32
	UnionChoice                     uint32
	FileOrCatalogOrBlobOrSgnrOrCert unsafe.Pointer
	StateAction                     uint32
	StateData                       windows.Handle
	URLReference                    *uint16
	ProvFlags                       uint32
	UIContext                       uint32
	SignatureSettings               unsafe.Pointer
}

// cryptProviderSgnr is CRYPT_PROVIDER_SGNR, in the documented field order.
//
// The chain COUNT and the chain POINTER are near the start, immediately after
// the verification time — not at the end. An earlier revision here invented a
// tail layout and read `pasCertChain` out of bytes that belong to other fields,
// which no unsigned-file test could have caught: those paths return before a
// signer is ever walked. `layout_windows_test.go` asserts the offsets against
// the SDK rather than trusting this comment.
//
// https://learn.microsoft.com/en-us/windows/win32/api/wintrust/ns-wintrust-crypt_provider_sgnr
type cryptProviderSgnr struct {
	Size               uint32
	VerifyAsOf         windows.Filetime
	CertChainCount     uint32
	CertChain          uintptr // *cryptProviderCert
	SignerType         uint32
	Signer             uintptr // CMSG_SIGNER_INFO*
	Error              uint32
	CounterSignerCount uint32
	CounterSigners     uintptr // *cryptProviderSgnr
	ChainContext       uintptr // PCCERT_CHAIN_CONTEXT
}

// cryptProviderCert is CRYPT_PROVIDER_CERT.
//
// https://learn.microsoft.com/en-us/windows/win32/api/wintrust/ns-wintrust-crypt_provider_cert
type cryptProviderCert struct {
	Size                uint32
	Cert                *windows.CertContext
	Commercial          int32
	TrustedRoot         int32
	SelfSigned          int32
	TestCert            int32
	RevokedReason       uint32
	Confidence          uint32
	Error               uint32
	TrustListContext    uintptr
	TrustListSignerCert int32
	CtlContext          uintptr
	CtlError            uint32
	IsCyclic            int32
	ChainElement        uintptr
}

// verifyHeld does the whole chain on a file it opens and holds, and returns the
// handle so the caller may launch through it without reopening.
func (c *WindowsCustody) verifyHeld(
	name, receipt, expectedSHA, publisher string, size int64, launch bool,
) (windows.Handle, string, error) {
	if !c.open {
		return 0, VerdictUnavail, Errf(CodeNoScope)
	}
	if publisher == "" && launch {
		// No pin, no install. Not a wildcard and not a warning.
		return 0, VerdictUnavail, Errf(CodeNoPin)
	}
	handle, err := openChildFile(
		c.staging, name, windows.FILE_GENERIC_READ|windows.SYNCHRONIZE,
		installShare, windows.FILE_OPEN,
	)
	if err != nil {
		if IsCode(err, CodeNotFound) {
			return 0, VerdictUnavail, Errf(CodeIdentity)
		}
		// Not lockable with write and delete denied is a refusal, never
		// "probably fine".
		return 0, VerdictUnavail, Errf(CodeNotLock)
	}
	fail := func(verdict string, code string) (windows.Handle, string, error) {
		windows.CloseHandle(handle)
		return 0, verdict, Errf(code)
	}
	current, err := receiptOf(handle)
	if err != nil {
		return fail(VerdictUnavail, CodeIO)
	}
	if current != receipt {
		return fail(VerdictUnavail, CodeIdentity)
	}
	actual, err := sizeOf(handle)
	if err != nil {
		return fail(VerdictUnavail, CodeIO)
	}
	if actual != size {
		return fail(VerdictUnavail, CodeIdentity)
	}
	digest := sha256.New()
	if err := streamInto(handle, digest); err != nil {
		return fail(VerdictUnavail, CodeIO)
	}
	if !strings.EqualFold(hex.EncodeToString(digest.Sum(nil)), expectedSHA) {
		return fail(VerdictUnavail, CodeIdentity)
	}
	verdict, subject, err := authenticode(handle, name)
	if err != nil && verdict != VerdictUnsigned {
		windows.CloseHandle(handle)
		// The cause is carried so a Windows run reports the actual status
		// instead of one opaque word.
		return 0, verdict, Errw(CodeUnavail, err)
	}
	switch verdict {
	case VerdictUnsigned:
		return fail(VerdictUnsigned, CodeUnsigned)
	case VerdictUnavail:
		// A check that could not run is NOT "unsigned", and never ready.
		return fail(VerdictUnavail, CodeUnavail)
	}
	if publisher == "" {
		// Signed by SOMEONE, with no expectation to compare against.
		//
		// Not `expected`, because nothing was expected; and NOT `other`, because
		// nothing was ruled out — reporting a mismatch against an unconfigured
		// pin would tell the user their installer came from the wrong publisher
		// when the truth is that this build has no opinion yet. `unavailable`
		// claims neither and can never reach `ready`.
		return fail(VerdictUnavail, CodeUnavail)
	}
	if subject != publisher {
		return fail(VerdictOther, CodePublisher)
	}
	return handle, VerdictExpected, nil
}

// VerifyInstaller verifies and RETURNS. It never creates a process.
func (c *WindowsCustody) VerifyInstaller(
	name, receipt, sha, publisher string, size int64,
) (string, error) {
	handle, verdict, err := c.verifyHeld(name, receipt, sha, publisher, size, false)
	if err != nil {
		return verdict, err
	}
	windows.CloseHandle(handle)
	return verdict, nil
}

// RunInstaller verifies and launches the file it verified, still holding it.
func (c *WindowsCustody) RunInstaller(
	name, receipt, sha, publisher string, size int64,
) (string, error) {
	handle, verdict, err := c.verifyHeld(name, receipt, sha, publisher, size, true)
	if err != nil {
		return verdict, err
	}
	defer windows.CloseHandle(handle)
	path, err := finalPath(handle)
	if err != nil {
		return VerdictExpected, Errf(CodeIO)
	}
	// No shell, no argument string the host supplied, no environment it chose:
	// the image is launched directly while every ancestor and the file itself
	// are still held.
	application, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return VerdictExpected, Errf(CodeIO)
	}
	// Inheritance is an ALLOW-LIST, not a flag.
	//
	// `bInheritHandles = TRUE` with an ordinary `STARTUPINFO` passes EVERY
	// inheritable handle in this process to the child — the helper's own stdio
	// pipes among them — and an earlier comment here claimed only the three
	// standard handles crossed. They did not. Custody handles are created
	// without `OBJ_INHERIT`, but that is a statement about custody, not about
	// every other handle a Go runtime may hold.
	//
	// `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` makes the set explicit: exactly the
	// handles named below cross, and nothing else can, whatever else is
	// inheritable. The standard three point at NUL because an installer is a GUI
	// program that does not read them, and a child blocking on a console it
	// should never have had is a hang with no cause.
	null, err := openNullDevice()
	if err != nil {
		return VerdictExpected, Errf(CodeIO)
	}
	defer windows.CloseHandle(null)
	stdin := null
	if c.stdHandleForTest != 0 {
		// Test seam only: it can substitute the child's stdin so an acceptance
		// case can keep the launched process alive long enough to observe what
		// it did and did not inherit. It cannot add a handle to the allow-list
		// that this function did not put there.
		stdin = c.stdHandleForTest
	}
	inherited := []windows.Handle{null}
	if stdin != null {
		inherited = append(inherited, stdin)
	}
	// Test-only, and additive: a case that proves the boundary is observable
	// needs a handle it can watch cross. Empty in every shipped path.
	inherited = append(inherited, c.shareForTest...)
	attributes, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return VerdictExpected, Errf(CodeIO)
	}
	defer attributes.Delete()
	if err := attributes.Update(
		windows.PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
		unsafe.Pointer(&inherited[0]),
		uintptr(len(inherited))*unsafe.Sizeof(inherited[0]),
	); err != nil {
		return VerdictExpected, Errf(CodeIO)
	}
	var startup windows.StartupInfoEx
	startup.Cb = uint32(unsafe.Sizeof(startup))
	startup.Flags = windows.STARTF_USESTDHANDLES
	startup.StdInput = stdin
	startup.StdOutput = null
	startup.StdErr = null
	startup.ProcThreadAttributeList = attributes.List()
	var info windows.ProcessInformation
	err = windows.CreateProcess(
		application, nil, nil, nil, true,
		windows.EXTENDED_STARTUPINFO_PRESENT, nil, nil, &startup.StartupInfo, &info,
	)
	// The slice must outlive the call: the attribute list points into it.
	runtime.KeepAlive(inherited)
	if err != nil {
		return VerdictExpected, Errf(CodeIO)
	}
	// The observer exists so an acceptance test can JOIN the exact process this
	// call created, by handle rather than by a PID that could be recycled. It is
	// nil in every shipped path, and it cannot change what is launched: it is
	// handed the result, after the fact.
	if c.onLaunched != nil {
		c.onLaunched(info)
	}
	windows.CloseHandle(info.Thread)
	windows.CloseHandle(info.Process)
	return VerdictExpected, nil
}

// openNullDevice returns an inheritable handle to `NUL`.
func openNullDevice() (windows.Handle, error) {
	name, err := windows.UTF16PtrFromString("NUL")
	if err != nil {
		return 0, err
	}
	security := windows.SecurityAttributes{InheritHandle: 1}
	security.Length = uint32(unsafe.Sizeof(security))
	return windows.CreateFile(
		name, windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, &security,
		windows.OPEN_EXISTING, 0, 0,
	)
}

// finalPath re-derives the path FROM THE HELD HANDLE, so the name handed to
// CreateProcessW is the one the kernel resolves that handle to right now.
func finalPath(h windows.Handle) (string, error) {
	buffer := make([]uint16, windows.MAX_LONG_PATH)
	n, err := windows.GetFinalPathNameByHandle(
		h, &buffer[0], uint32(len(buffer)), fileNameNormalized|volumeNameDOS,
	)
	if err != nil {
		return "", err
	}
	return windows.UTF16ToString(buffer[:n]), nil
}

// authenticode asks Windows about the HELD file and reads the subject from the
// signer it actually validated.
func authenticode(h windows.Handle, name string) (string, string, error) {
	path, err := finalPath(h)
	if err != nil {
		return VerdictUnavail, "", err
	}
	// `pcwszFilePath` must be non-NULL even when `hFile` is supplied; the handle
	// is what the bytes are read from.
	wide, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return VerdictUnavail, "", err
	}
	file := wintrustFileInfo{
		Size:     uint32(unsafe.Sizeof(wintrustFileInfo{})),
		FilePath: wide,
		File:     h,
	}
	data := wintrustData{
		Size:                            uint32(unsafe.Sizeof(wintrustData{})),
		UIChoice:                        wtdUINone,
		RevocationChecks:                wtdRevokeWholeChain,
		UnionChoice:                     wtdChoiceFile,
		FileOrCatalogOrBlobOrSgnrOrCert: unsafe.Pointer(&file),
		StateAction:                     wtdStateActionVerify,
		ProvFlags:                       wtdProvFlagsNone,
	}
	raw, _, _ := procWinVerifyTrust.Call(
		0, uintptr(unsafe.Pointer(&actionGenericVerifyV2)), uintptr(unsafe.Pointer(&data)),
	)
	// `WinVerifyTrust` returns LONG (a signed 32-bit value); `Call` widens it to
	// a `uintptr`, whose upper half on x64 is not something to assume anything
	// about. The status is the low 32 bits, and the raw value is kept for the
	// diagnosis.
	status := uint32(raw)
	defer func() {
		data.StateAction = wtdStateActionClose
		procWinVerifyTrust.Call(
			0, uintptr(unsafe.Pointer(&actionGenericVerifyV2)), uintptr(unsafe.Pointer(&data)),
		)
		// Both structures must outlive the close, not merely the verify: the
		// provider reads them again to release its state. `data` holds `file`
		// through a typed pointer, and `file` holds the path buffer, so keeping
		// these two alive keeps the whole graph alive.
		runtime.KeepAlive(&file)
		runtime.KeepAlive(&data)
	}()
	if status != trustERRSuccess {
		// Everything non-zero is a refusal. Which refusal depends on WHY, and
		// the distinction is not cosmetic: `unsigned` offers the user a reveal,
		// `unavailable` offers nothing.
		switch status {
		case trustNoSignature:
			// A well-formed image carrying no signature.
			return VerdictUnsigned, "", nil
		case trustSubjectFormUnknown, trustProviderUnknown, trustActionUnknown:
			// Not something this provider can even parse — a text file named
			// `.exe`, for instance. That is "could not tell", not "not signed".
			return VerdictUnavail, "", fmt.Errorf("winverifytrust malformed subject: 0x%08x", status)
		default:
			return VerdictUnavail, "", fmt.Errorf("winverifytrust: 0x%08x (raw 0x%x)", status, raw)
		}
	}
	subject, err := signerSubject(data.StateData)
	// Read while the state data is still open — the deferred close above runs
	// after this returns, never before.
	if err != nil {
		return VerdictUnavail, "", nil
	}
	return VerdictExpected, subject, nil
}

// fromWin32Pointer converts a pointer Win32 returned as a `uintptr`.
//
// `WTHelperProvDataFromStateData` and `WTHelperGetProvSignerFromChain` return
// pointers into structures wintrust owns, and neither has a typed wrapper in
// `x/sys`, so there is no way to consume them without this conversion. It is
// isolated here and used nowhere else. `go vet -unsafeptr` reports it by
// construction; `go test`'s default vet set does not include that analyser, so
// the repository gate stays clean and this is disclosed rather than hidden.
//
// The pointers stay valid for the life of the state data, which is closed only
// by the deferred `WTD_STATEACTION_CLOSE` in the caller — after every read here.
func fromWin32Pointer(p uintptr) unsafe.Pointer {
	return unsafe.Pointer(p) //nolint:govet // see the comment above
}

// certX500Flags is the typePara for the canonical subject string. See the
// constants above for why REVERSE is part of it.
func certX500Flags() unsafe.Pointer {
	flags := uint32(certX500NameStr | certNameStrReverse)
	return unsafe.Pointer(&flags)
}

// signerSubject reads the subject of the certificate WinVerifyTrust validated.
func signerSubject(state windows.Handle) (string, error) {
	provider, _, _ := procWTHelperProvDataFromState.Call(uintptr(state))
	if provider == 0 {
		return "", Errf(CodeUnavail)
	}
	signer, _, _ := procWTHelperGetProvSignerFrom.Call(provider, 0, 0, 0)
	if signer == 0 {
		return "", Errf(CodeUnavail)
	}
	sgnr := (*cryptProviderSgnr)(fromWin32Pointer(signer))
	// The structure declares its own size. A shorter one is not the structure
	// this build expects, and reading its chain pointer would be reading
	// whatever follows it in memory.
	if uintptr(sgnr.Size) < unsafe.Sizeof(*sgnr) ||
		sgnr.CertChainCount == 0 || sgnr.CertChain == 0 {
		return "", Errf(CodeUnavail)
	}
	// The LEAF of the chain that was validated — element zero, not a certificate
	// picked out of whatever collection the file carries.
	leaf := (*cryptProviderCert)(fromWin32Pointer(sgnr.CertChain))
	if uintptr(leaf.Size) < unsafe.Sizeof(*leaf) || leaf.Cert == nil {
		return "", Errf(CodeUnavail)
	}
	// The typed wrapper, so no pointer round-trips through `uintptr` here.
	size := windows.CertGetNameString(leaf.Cert, certNameRDNType, 0, certX500Flags(), nil, 0)
	if size <= 1 {
		return "", Errf(CodeUnavail)
	}
	buffer := make([]uint16, size)
	got := windows.CertGetNameString(
		leaf.Cert, certNameRDNType, 0, certX500Flags(), &buffer[0], size,
	)
	if got <= 1 {
		return "", Errf(CodeUnavail)
	}
	return windows.UTF16ToString(buffer), nil
}
