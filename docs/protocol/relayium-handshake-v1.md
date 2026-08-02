# Relayium realtime commit-reveal SAS handshake v1 (authoritative)

Run over the signaling channel before the DataChannel opens. Anchors each peer's
crypto_kx public key with a commit-then-reveal so a malicious signaling relay
cannot MITM the 6-digit SAS. Hashes raw bytes only (never JSON).

## Per side
- keypair = crypto_kx keypair (X25519); selfPub = 32-byte public key.
- selfNonce = 32 random bytes.
- selfCommit = BLAKE2b-256(selfPub || selfNonce)  (R1-A commitKey), base64.

## Wire (inside the signal `data`)
- Commit: `{"commit": <base64 selfCommit>}` — attached to every SDP offer/answer.
- Reveal: `{"reveal": {"key": <base64 selfPub>, "nonce": <base64 selfNonce>}}` — a
  separate signal, sent once.
- base64 is standard (RFC 4648, with padding — btoa/atob).
- Capabilities: `{"caps": [<string>,…]}` — merged alongside `commit` on every SDP
  offer/answer. Optional and lenient: absent is not an error (every peer predating
  it sends none), a non-array is ignored, non-string entries are dropped. It is a
  HINT, never a security input, and it is deliberately OUTSIDE the resume-auth
  signed payload so adding it cannot change any resume tag. The authoritative
  announcement is at the roster level, not here — see relayium-text-v1.md.

## Sequence
1. Both compute selfCommit. The initiator sends an SDP offer carrying its commit;
   the responder, on receiving it, records peerCommit and sends its SDP answer
   carrying its own commit.
2. Record the peer's commit (from the SDP-carried `commit`) BEFORE handling a reveal.
3. The initiator reveals once it has the responder's commit (i.e. on the answer).
   The responder reveals only after it has verified the initiator's reveal.
4. On a peer reveal: verifyCommit(peerCommit, peerPub, peerNonce) (R1-A). Mismatch,
   or no recorded peerCommit, is a hard error ("possible MITM") — never open the
   channel. Duplicate reveals (ICE restart) are ignored.
5. After a verified reveal, both sides derive:
   - keys = deriveSession(role, selfKeypair, peerPub)  — role initiator→client,
     responder→server (crypto_kx); the two roles mirror so one's send == other's recv.
   - sas = sas(selfPub, peerPub)  — order-independent 6-digit code; identical on
     both sides.

## What is mandatory, and what is not
- Steps 1-4 (commit, reveal, verifyCommit) are **mandatory on every connection**
  in every client. A mismatched or missing commit is a hard error and the channel
  never opens. No preference, flag or build reaches this.
- **Displaying the SAS and asking a human to compare it is optional**, and is off
  by default in the web and macOS clients (opt-in via "advanced verification";
  `--verify` in the CLI). The derived value is kept either way, so enabling the
  comparison never needs a renegotiation.
- The distinction matters when reasoning about what an attack buys: commit-reveal
  removes an adaptive key choice by the relay, which is what makes a ~20-bit SAS
  worth comparing at all. Skipping the comparison forgoes the detection of an
  endpoint substitution that a human would have caught; it does not weaken the
  key exchange, the AEAD, or the commitment check.
- The SAS is six digits and so is the pairing code (relayium-signaling-v1.md).
  They are unrelated values; user-facing copy must not conflate them.

## Roles
- initiator = the side that started the connection (sends the SDP offer).
- responder = the side that answers. They MUST take opposite roles.
