package account

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/x509"
	"encoding/asn1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"strings"
	"time"
)

// Cryptographic verification of an App Store signed transaction (JWS compact
// serialization, ES256, x5c certificate chain).
//
// WHY THIS IS HAND-WRITTEN. Apple publishes server libraries for Swift, Java,
// Python and Node — and none for Go. The alternative to ~200 auditable lines
// here is a third-party JOSE dependency in the one place where "what exactly
// does it accept?" IS the security property: algorithm agility, an x5c chain it
// may anchor on its own last element, a signature encoding it may guess at, and
// a JSON parser whose duplicate-key behaviour decides which `bundleId` wins.
// This file therefore accepts exactly one shape and rejects everything else.
//
// THE RULES, in the order they are applied:
//
//  1. exactly three canonical base64url segments — one spelling per segment, so
//     the bytes verified are the bytes signed;
//  2. a protected header that is a strict JSON object with alg=ES256 and an x5c
//     chain of exactly three certificates;
//  3. a certificate path from an Apple transaction-signing leaf, through the
//     Apple WWDR intermediate, to an EXPLICITLY CONFIGURED root, valid at the
//     payload's own signedDate (see appleCandidateSignedDate). The chain in the
//     header supplies candidates, never trust;
//  4. the raw r‖s signature over the ORIGINAL header.payload segments;
//  5. only then may any payload field be read for what it says.
//
// Nothing here logs, wraps or formats any of the material it is given: every
// refusal is a fixed code (see appleRejection).

const (
	// appleMaxJWSBytes bounds a TRANSACTION's compact JWS. A real Apple
	// transaction with its three certificates is ~5 KiB; this leaves room for
	// growth while keeping a hostile body away from the parsers below. The HTTP
	// layer has its own, larger, body limit — this one is about what the verifier
	// will look at.
	//
	// It is deliberately NOT the bound for a notification envelope, which carries
	// two whole JWS documents inside its own payload and is therefore several
	// times larger; see appleMaxNotificationJWSBytes. Bounding both with one
	// constant would mean either refusing real notifications or quadrupling what
	// a transaction submitter may hand the parsers, so the limit is a parameter
	// of verifyAppleCompactJWS rather than a fact about it.
	appleMaxJWSBytes = 12 << 10
	// appleChainCerts is EXACTLY the shape Apple sends and the shape its own
	// App Store Server Library accepts: leaf, WWDR intermediate, root. A range
	// would be an invitation to present some other arrangement that happens to
	// path-validate.
	appleChainCerts   = 3
	appleMaxCertBytes = 8 << 10
	appleMaxJSONDepth = 32
	// appleECDSAKeyBytes is the P-256 coordinate size: an ES256 signature is
	// exactly two of them, concatenated (RFC 7518 §3.4).
	appleECDSAKeyBytes = 32
)

// appleRejection is the only error a refused Apple transaction produces. Its
// message is a FIXED CODE and never contains any part of the JWS, the
// certificates, the account token or the decoded payload: a rejection is
// logged, and a log line outlives the request that made it.
type appleRejection struct{ code string }

func (e *appleRejection) Error() string { return "apple transaction rejected: " + e.code }

func rejectApple(code string) error { return &appleRejection{code: code} }

// appleRejectionCode returns the fixed code behind a rejection, or "" when err
// is not one. This is what may be logged; err.Error() is what may be shown to
// nobody.
func appleRejectionCode(err error) string {
	var r *appleRejection
	if errors.As(err, &r) {
		return r.code
	}
	return ""
}

// verifyAppleCompactJWS verifies one compact JWS against roots and returns the
// payload BYTES. It never returns a payload it has not verified.
//
// `serverNow` is the receipt time; it bounds how far in the future the payload's
// own signedDate may claim to be. The certificate chain is validated at that
// signedDate — see appleCandidateSignedDate for why, and for the one narrow
// thing the untrusted payload is allowed to decide before it is trusted.
//
// `maxBytes` is the caller's own size bound. It is a parameter because a
// notification envelope and the transaction nested inside it are two different
// documents with two different reasonable sizes, and each layer is verified
// INDEPENDENTLY: the outer signature says nothing about the inner one, so the
// inner JWS goes through this same function again, with its own smaller bound,
// rather than being trusted because its container verified.
func verifyAppleCompactJWS(compact string, roots *x509.CertPool, serverNow time.Time, maxBytes int) ([]byte, error) {
	// A nil pool is not "no opinion": x509.VerifyOptions treats it as "use the
	// host's root store", which would silently trust every public CA. There is no
	// path through this function that leaves Roots unset.
	if roots == nil {
		return nil, rejectApple("no_trust_roots")
	}
	if maxBytes <= 0 {
		// A caller that forgot its bound must not inherit "unbounded". There is no
		// document this function is asked to verify without a stated size.
		return nil, rejectApple("jws_size")
	}
	if len(compact) == 0 || len(compact) > maxBytes {
		return nil, rejectApple("jws_size")
	}
	// Exactly three components: header, payload, signature.
	if strings.Count(compact, ".") != 2 {
		return nil, rejectApple("jws_format")
	}
	first := strings.IndexByte(compact, '.')
	last := strings.LastIndexByte(compact, '.')
	headerSeg, payloadSeg, sigSeg := compact[:first], compact[first+1:last], compact[last+1:]

	headerJSON, err := decodeCanonicalB64URL(headerSeg)
	if err != nil {
		return nil, err
	}
	payloadJSON, err := decodeCanonicalB64URL(payloadSeg)
	if err != nil {
		return nil, err
	}
	sig, err := decodeCanonicalB64URL(sigSeg)
	if err != nil {
		return nil, err
	}
	hdr, err := parseAppleJWSHeader(headerJSON)
	if err != nil {
		return nil, err
	}
	// The ONE thing read out of the payload before it is trusted: which instant
	// to validate the chain at. It selects a validation parameter and nothing
	// else — no field is returned, and no entitlement decision is reachable from
	// here until the chain and the signature below have both verified.
	signedAt, err := appleCandidateSignedDate(payloadJSON, serverNow)
	if err != nil {
		return nil, err
	}
	leaf, err := appleChainLeaf(hdr.X5C, roots, signedAt)
	if err != nil {
		return nil, err
	}
	pub, ok := leaf.PublicKey.(*ecdsa.PublicKey)
	if !ok || pub.Curve != elliptic.P256() {
		// ES256 is ECDSA on P-256 and nothing else: an RSA leaf has no r‖s
		// signature to check at all, and another curve is a different algorithm
		// wearing the same `alg`.
		return nil, rejectApple("leaf_key")
	}
	if len(sig) != 2*appleECDSAKeyBytes {
		// JWS ES256 is the raw r‖s pair. An ASN.1 DER signature is the same two
		// numbers in another encoding, and accepting both would mean a second
		// parser stands behind the signature check.
		return nil, rejectApple("signature_shape")
	}
	// The signing input is the ORIGINAL segments, byte for byte — never a
	// re-serialization of anything decoded above.
	digest := sha256.Sum256([]byte(compact[:last]))
	r := new(big.Int).SetBytes(sig[:appleECDSAKeyBytes])
	s := new(big.Int).SetBytes(sig[appleECDSAKeyBytes:])
	if !ecdsa.Verify(pub, digest[:], r, s) {
		return nil, rejectApple("signature")
	}

	// Verified. Only now may any payload field be read for what it says. These
	// are the same bytes appleCandidateSignedDate already put through
	// appleStrictJSONObject, so the caller parses a document that is a single
	// object with no duplicate keys and nothing trailing.
	return payloadJSON, nil
}

// appleSignedDateSkew is how far ahead of the server's own clock a payload's
// signedDate may be before it is refused. It absorbs ordinary clock drift
// between Apple's signer and this host; anything beyond it is a claim about the
// future, and a future signedDate would validate the chain at a time the
// certificate's expiry has not yet been reached.
const appleSignedDateSkew = 5 * time.Minute

// appleCandidateSignedDate reads signedDate out of the still-untrusted payload
// and returns the instant the certificate chain must be validated at.
//
// WHY NOT THE SERVER'S CLOCK. Apple's own offline verifier (SignedDataVerifier
// in the App Store Server Library) validates the chain as of the JWS's
// signedDate, and it has to: a StoreKit client can present a transaction Apple
// signed years ago — a restored purchase, a historical entitlement — and
// Apple's signing certificate rotates. Validating that JWS at receipt time
// would start refusing every historical transaction the day the certificate
// that signed it expired, which is a self-inflicted outage rather than a
// security property. The signature still binds signedDate: a payload that lies
// about it does not verify.
//
// WHY IT IS SAFE TO READ FIRST. This value chooses a validation PARAMETER. It
// is not returned, nothing downstream reads it from here, and both the chain
// and the signature are still ahead — so the worst an attacker can do with a
// forged signedDate is pick a moment at which their own unsigned chain still
// fails. The value is bounded on both sides anyway: it must be an integral,
// positive, in-range millisecond count, and no further ahead of the server than
// the skew above.
func appleCandidateSignedDate(payloadJSON []byte, serverNow time.Time) (time.Time, error) {
	if err := appleStrictJSONObject(payloadJSON); err != nil {
		return time.Time{}, err
	}
	var probe struct {
		SignedDate json.Number `json:"signedDate"`
	}
	dec := json.NewDecoder(bytes.NewReader(payloadJSON))
	dec.UseNumber()
	if err := dec.Decode(&probe); err != nil {
		return time.Time{}, rejectApple("payload_json")
	}
	ms, err := appleMillis(probe.SignedDate, "signed_date")
	if err != nil {
		return time.Time{}, err
	}
	if ms <= 0 {
		// Absent or zero: there is no instant to validate the chain at, and
		// falling back to "now" would quietly reintroduce the receipt-time
		// behaviour this function exists to replace.
		return time.Time{}, rejectApple("signed_date")
	}
	signedAt := time.UnixMilli(ms)
	if signedAt.After(serverNow.Add(appleSignedDateSkew)) {
		return time.Time{}, rejectApple("signed_date_future")
	}
	return signedAt, nil
}

// decodeCanonicalB64URL decodes one JWS segment and requires it to be the ONLY
// base64url spelling of its own bytes.
//
// Re-encoding and comparing is the whole check, deliberately as one guard
// rather than several overlapping ones: it rejects padding, the standard
// alphabet, whitespace and non-zero trailing bits in a single comparison that a
// mutation cannot half-disable. It matters because a second spelling of a
// segment decodes to the same JSON while hashing to something else — the
// verifier would then be checking a signature over material it never returned.
func decodeCanonicalB64URL(seg string) ([]byte, error) {
	if seg == "" {
		return nil, rejectApple("b64_segment")
	}
	raw, err := base64.RawURLEncoding.DecodeString(seg)
	if err != nil {
		return nil, rejectApple("b64_segment")
	}
	if base64.RawURLEncoding.EncodeToString(raw) != seg {
		return nil, rejectApple("b64_segment")
	}
	return raw, nil
}

// appleJWSHeader is the protected header, reduced to what is trusted: the
// algorithm and the certificate chain. A `kid`, `jku` or `jwk` here would name
// a key we did not configure, so none of them is read.
type appleJWSHeader struct {
	Alg string   `json:"alg"`
	X5C []string `json:"x5c"`
}

func parseAppleJWSHeader(raw []byte) (appleJWSHeader, error) {
	if err := appleStrictJSONObject(raw); err != nil {
		return appleJWSHeader{}, err
	}
	var h appleJWSHeader
	if err := json.Unmarshal(raw, &h); err != nil {
		return appleJWSHeader{}, rejectApple("header_json")
	}
	// Pinned, not negotiated: "none" removes the signature, an HMAC alg turns a
	// public key into a shared secret, and a stronger-looking ES384 would be
	// verified with the P-256 machinery below.
	if h.Alg != "ES256" {
		return appleJWSHeader{}, rejectApple("alg")
	}
	if len(h.X5C) != appleChainCerts {
		return appleJWSHeader{}, rejectApple("x5c_count")
	}
	return h, nil
}

// Apple's certificate marker extensions, the two this chain must carry. They
// are Apple-private OIDs with no standard meaning, so x509 path validation
// cannot check them — but they are what distinguishes an Apple RECEIPT-SIGNING
// leaf under the WWDR intermediate from any other certificate that happens to
// chain to the same root.
//
// Apple's official Node server library checks this exact pair at these exact
// positions in verifyCertificateChainWithoutCaching: the receipt-signing OID
// on the leaf and the WWDR OID on the intermediate. Both Relayium callers share
// this verifier, so the transaction and notification trust boundaries cannot
// drift apart.
var (
	// appleWWDRIntermediateOID marks Apple Worldwide Developer Relations as the
	// issuing intermediate (x5c[1]).
	appleWWDRIntermediateOID = asn1.ObjectIdentifier{1, 2, 840, 113635, 100, 6, 2, 1}
	// appleReceiptSigningOID marks the receipt/transaction signing leaf (x5c[0]).
	appleReceiptSigningOID = asn1.ObjectIdentifier{1, 2, 840, 113635, 100, 6, 11, 1}
)

func appleCertHasExtension(cert *x509.Certificate, oid asn1.ObjectIdentifier) bool {
	for _, ext := range cert.Extensions {
		if ext.Id.Equal(oid) {
			return true
		}
	}
	return false
}

// appleChainLeaf parses the x5c chain and returns the leaf ONLY if it is an
// Apple transaction-signing leaf, issued by the Apple WWDR intermediate, on a
// path to a configured root that is valid at time `at`.
//
// Certificates after the first are candidate intermediates — including the
// self-signed root Apple appends. Putting that root in the intermediate pool
// rather than the root pool is the entire point: a path that ends there does
// not terminate at a configured anchor, so an attacker's complete, internally
// consistent chain fails exactly where it should.
//
// THE SUBMITTED CHAIN MUST BE THE VALIDATED CHAIN. Path building is free to
// ignore certificates it was offered, so "the markers are at positions 0 and 1"
// and "a path exists" are two facts about two possibly DIFFERENT chains. A
// marked but unused decoy at x5c[1] would satisfy the first while the second was
// satisfied through x5c[2], leaving the positional marker check decorative and
// the announced three-certificate shape unenforced. So one returned path must
// be exactly the three submitted certificates, in the submitted order, compared
// by raw DER — which also settles that x5c[2] IS a configured anchor rather than
// merely leading to one.
func appleChainLeaf(x5c []string, roots *x509.CertPool, at time.Time) (*x509.Certificate, error) {
	certs := make([]*x509.Certificate, 0, len(x5c))
	for _, enc := range x5c {
		// RFC 7515 §4.1.6: x5c entries are standard base64 (with padding) DER.
		der, err := base64.StdEncoding.Strict().DecodeString(enc)
		if err != nil {
			return nil, rejectApple("x5c_encoding")
		}
		if len(der) == 0 || len(der) > appleMaxCertBytes {
			return nil, rejectApple("x5c_size")
		}
		cert, err := x509.ParseCertificate(der)
		if err != nil {
			return nil, rejectApple("x5c_parse")
		}
		certs = append(certs, cert)
	}
	leaf, intermediate := certs[0], certs[1]
	if leaf.IsCA {
		return nil, rejectApple("leaf_is_ca")
	}
	if leaf.KeyUsage&x509.KeyUsageDigitalSignature == 0 {
		// A certificate that does not claim signing is not a signer, whatever it
		// chains to.
		return nil, rejectApple("leaf_key_usage")
	}
	// The Apple markers, at their fixed positions. Path validation alone would
	// accept any leaf under this root — including one issued for something other
	// than signing transactions.
	if !appleCertHasExtension(leaf, appleReceiptSigningOID) {
		return nil, rejectApple("leaf_marker")
	}
	if !appleCertHasExtension(intermediate, appleWWDRIntermediateOID) {
		return nil, rejectApple("intermediate_marker")
	}
	intermediates := x509.NewCertPool()
	for _, cert := range certs[1:] {
		intermediates.AddCert(cert)
	}
	// ExtKeyUsageAny: Apple's transaction-signing leaf carries a private marker
	// extension rather than one of x509's named extended key usages, so pinning a
	// named EKU here would reject every real Apple certificate. The narrowing
	// that matters — this is a marked signing leaf, under the marked WWDR
	// intermediate, anchored on a configured root — is the KeyUsage and marker
	// checks above plus the exact-chain comparison below.
	chains, err := leaf.Verify(x509.VerifyOptions{
		Roots:         roots,
		Intermediates: intermediates,
		CurrentTime:   at,
		KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageAny},
	})
	if err != nil {
		return nil, rejectApple("chain")
	}
	if !appleChainIsExactly(chains, certs) {
		return nil, rejectApple("chain_shape")
	}
	return leaf, nil
}

// appleChainIsExactly reports whether any validated path is exactly the
// submitted certificates, in the submitted order.
//
// Raw DER is the comparison, not subject/issuer names or public keys: it is the
// only identity that cannot be reproduced by a second certificate claiming to be
// the same one.
func appleChainIsExactly(chains [][]*x509.Certificate, submitted []*x509.Certificate) bool {
	if len(submitted) != appleChainCerts {
		return false
	}
	for _, chain := range chains {
		if len(chain) != appleChainCerts {
			continue
		}
		same := true
		for i := range chain {
			if !bytes.Equal(chain[i].Raw, submitted[i].Raw) {
				same = false
				break
			}
		}
		if same {
			return true
		}
	}
	return false
}

// appleStrictJSONObject requires raw to be exactly one JSON OBJECT, with no
// duplicate keys at any depth and nothing after it.
//
// encoding/json alone accepts all three: it takes the LAST of two `bundleId`
// keys, and json.Unmarshal stops at the end of the first value. Both are
// signature-preserving ways to show one document to a verifier and another to a
// reader — so a payload that is ambiguous at all is refused rather than
// resolved, and the shape is stated here rather than inferred from whichever
// typed decode happens to run next.
func appleStrictJSONObject(raw []byte) error {
	if !bytes.HasPrefix(bytes.TrimLeft(raw, " \t\r\n"), []byte("{")) {
		return rejectApple("json_shape")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := appleJSONValue(dec, 1); err != nil {
		return err
	}
	if _, err := dec.Token(); err != io.EOF {
		return rejectApple("json_trailing")
	}
	return nil
}

// appleJSONValue consumes exactly one JSON value from dec, rejecting duplicate
// object keys and excessive nesting.
func appleJSONValue(dec *json.Decoder, depth int) error {
	if depth > appleMaxJSONDepth {
		return rejectApple("json_depth")
	}
	tok, err := dec.Token()
	if err != nil {
		return rejectApple("json_syntax")
	}
	delim, ok := tok.(json.Delim)
	if !ok {
		return nil // a scalar: string, number, bool or null
	}
	switch delim {
	case '{':
		seen := make(map[string]struct{})
		for dec.More() {
			keyTok, err := dec.Token()
			if err != nil {
				return rejectApple("json_syntax")
			}
			key, ok := keyTok.(string)
			if !ok {
				return rejectApple("json_syntax")
			}
			if _, dup := seen[key]; dup {
				return rejectApple("json_duplicate_key")
			}
			seen[key] = struct{}{}
			if err := appleJSONValue(dec, depth+1); err != nil {
				return err
			}
		}
		if _, err := dec.Token(); err != nil { // '}'
			return rejectApple("json_syntax")
		}
	case '[':
		for dec.More() {
			if err := appleJSONValue(dec, depth+1); err != nil {
				return err
			}
		}
		if _, err := dec.Token(); err != nil { // ']'
			return rejectApple("json_syntax")
		}
	default:
		return rejectApple("json_syntax")
	}
	return nil
}
