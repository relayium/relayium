package selfupdate

// releaseSigningPubKeyPEM is the PKIX/PEM ECDSA-P256 public key whose PRIVATE
// half signs every release's checksums.txt (see .goreleaser.yaml's `signs`
// block and the RELAYIUM_RELEASE_KEY GitHub Actions secret). verifyReleaseSignature
// checks each downloaded checksums.txt against it with the Go standard library,
// so `relayium update` needs no external cosign/openssl on the user's machine.
//
// This value is the PUBLIC key — safe to commit. While it is empty, release
// signing is treated as "not configured yet" and updates fall back to
// checksum-only (no behavior change), so this file can land before the key
// exists. Populate it to turn on fail-closed signature verification.
//
// Generate the keypair once (keep the .key PRIVATE, paste the .pub here):
//
//	openssl ecparam -name prime256v1 -genkey -noout -out relayium-release.key
//	openssl ec -in relayium-release.key -pubout        # <- paste this block below
//
// A var (not const) so tests can substitute their own key; production sets it
// here once and never mutates it at runtime.
var releaseSigningPubKeyPEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAErOLLZclLFkpUWt8w4KIZ4SYB4JZf
bDRZOmWOdGsmHGKTU2GNeZZpJYPCL22ylULbxvQJEkdveZqkFIyYcGKNoA==
-----END PUBLIC KEY-----`
