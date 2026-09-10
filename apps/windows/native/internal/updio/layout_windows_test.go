//go:build windows

// The SDK ABI, asserted at COMPILE TIME.
//
// These structures are read through pointers wintrust owns. A field at the wrong
// offset does not fail loudly — it silently returns whatever bytes live there,
// and the paths that would notice are exactly the ones a run without a genuinely
// signed fixture never reaches. So the offsets are checked here rather than
// trusted from a comment, the same way `internal/winio` checks its rename
// structure.
//
// Values from the documented definitions:
// https://learn.microsoft.com/en-us/windows/win32/api/wintrust/ns-wintrust-crypt_provider_sgnr
// https://learn.microsoft.com/en-us/windows/win32/api/wintrust/ns-wintrust-crypt_provider_cert
package updio

import (
	"testing"
	"unsafe"
)

// A compile-time assertion: a false condition makes the array length negative.
type assert [1]struct{}

func sizeAssert(ok bool) assert {
	if !ok {
		panic("layout")
	}
	return assert{}
}

func TestCryptProviderSgnrMatchesTheSDK(t *testing.T) {
	var s cryptProviderSgnr
	// x64: cbStruct 0, sftVerifyAsOf 4, csCertChain 12, pasCertChain 16,
	// dwSignerType 24, psSigner 32, dwError 40, csCounterSigners 44,
	// pasCounterSigners 48, pChainContext 56.
	for _, c := range []struct {
		name string
		got  uintptr
		want uintptr
	}{
		{"Size", unsafe.Offsetof(s.Size), 0},
		{"VerifyAsOf", unsafe.Offsetof(s.VerifyAsOf), 4},
		{"CertChainCount", unsafe.Offsetof(s.CertChainCount), 12},
		{"CertChain", unsafe.Offsetof(s.CertChain), 16},
		{"SignerType", unsafe.Offsetof(s.SignerType), 24},
		{"Signer", unsafe.Offsetof(s.Signer), 32},
		{"Error", unsafe.Offsetof(s.Error), 40},
		{"CounterSignerCount", unsafe.Offsetof(s.CounterSignerCount), 44},
		{"CounterSigners", unsafe.Offsetof(s.CounterSigners), 48},
		{"ChainContext", unsafe.Offsetof(s.ChainContext), 56},
	} {
		if c.got != c.want {
			t.Fatalf("CRYPT_PROVIDER_SGNR.%s at %d, SDK says %d", c.name, c.got, c.want)
		}
	}
	if got := unsafe.Sizeof(s); got != 64 {
		t.Fatalf("CRYPT_PROVIDER_SGNR is %d bytes, SDK says 64", got)
	}
}

func TestCryptProviderCertMatchesTheSDK(t *testing.T) {
	var c cryptProviderCert
	for _, k := range []struct {
		name string
		got  uintptr
		want uintptr
	}{
		{"Size", unsafe.Offsetof(c.Size), 0},
		{"Cert", unsafe.Offsetof(c.Cert), 8},
		{"Commercial", unsafe.Offsetof(c.Commercial), 16},
		{"TrustedRoot", unsafe.Offsetof(c.TrustedRoot), 20},
		{"SelfSigned", unsafe.Offsetof(c.SelfSigned), 24},
		{"TestCert", unsafe.Offsetof(c.TestCert), 28},
		{"RevokedReason", unsafe.Offsetof(c.RevokedReason), 32},
		{"Confidence", unsafe.Offsetof(c.Confidence), 36},
		{"Error", unsafe.Offsetof(c.Error), 40},
		{"TrustListContext", unsafe.Offsetof(c.TrustListContext), 48},
		{"TrustListSignerCert", unsafe.Offsetof(c.TrustListSignerCert), 56},
		{"CtlContext", unsafe.Offsetof(c.CtlContext), 64},
		{"CtlError", unsafe.Offsetof(c.CtlError), 72},
		{"IsCyclic", unsafe.Offsetof(c.IsCyclic), 76},
		{"ChainElement", unsafe.Offsetof(c.ChainElement), 80},
	} {
		if k.got != k.want {
			t.Fatalf("CRYPT_PROVIDER_CERT.%s at %d, SDK says %d", k.name, k.got, k.want)
		}
	}
	if got := unsafe.Sizeof(c); got != 88 {
		t.Fatalf("CRYPT_PROVIDER_CERT is %d bytes, SDK says 88", got)
	}
}

func TestFileRenameInformationMatchesTheSDK(t *testing.T) {
	var r fileRenameInformation
	if got := unsafe.Offsetof(r.RootDirectory); got != 8 {
		t.Fatalf("FILE_RENAME_INFORMATION.RootDirectory at %d, SDK says 8", got)
	}
	if got := unsafe.Offsetof(r.FileNameLength); got != 16 {
		t.Fatalf("FILE_RENAME_INFORMATION.FileNameLength at %d, SDK says 16", got)
	}
	if got := unsafe.Offsetof(r.FileName); got != 20 {
		t.Fatalf("FILE_RENAME_INFORMATION.FileName at %d, SDK says 20", got)
	}
}

func TestFileIdInfoMatchesTheSDK(t *testing.T) {
	var f fileIdInfo
	if got := unsafe.Offsetof(f.FileId); got != 8 {
		t.Fatalf("FILE_ID_INFO.FileId at %d, SDK says 8", got)
	}
	if got := unsafe.Sizeof(f); got != 24 {
		t.Fatalf("FILE_ID_INFO is %d bytes, SDK says 24", got)
	}
}

var _ = sizeAssert(true)
