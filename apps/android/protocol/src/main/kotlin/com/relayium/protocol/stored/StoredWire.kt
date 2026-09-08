package com.relayium.protocol.stored

import java.util.Base64

/**
 * `stored/1`: the zero-knowledge wire for a transfer the server HOLDS.
 *
 * Authoritative description: `docs/protocol/relayium-stored-wire-v1.md`; the
 * bytes are pinned by `apps/RelayiumKit/Tests/Fixtures/store-wire-vectors.json`,
 * the same fixture the Web and Swift ports assert on. One random AES-256-GCM key
 * per upload covers both the manifest and every file byte, the key travels only
 * in a link fragment, and the server stores ciphertext it cannot read.
 *
 * ## Why this is a separate wire from `link/1`
 *
 * The realtime lanes derive their keys from a live handshake between two present
 * devices. A stored transfer has no peer to shake hands with — the recipient may
 * open the link days later — so the key is generated locally and handed over out
 * of band, inside the URL fragment a browser never sends to a server. That makes
 * the two wires share primitives ([com.relayium.protocol.Crypto]'s nonce
 * derivation and AES-256-GCM) and nothing else.
 */
class StoredWireException(val reason: Reason) : RuntimeException("relayium stored wire: $reason") {

    enum class Reason {
        /** The `#k=` key is not a well-formed 32-byte base64url value. */
        INVALID_KEY,

        /** The manifest parsed but describes something no receiver may act on. */
        INVALID_MANIFEST,

        /** A length prefix exceeded [MAX_FRAME_CT], read BEFORE allocating. */
        FRAME_TOO_LARGE,

        /**
         * Authentication failed, or the stream ended mid-frame.
         *
         * One reason for both because they are one event to a reader: bytes
         * arrived that this key does not vouch for. Distinguishing "tampered"
         * from "cut short" would describe the ATTACKER's method, which the
         * client cannot actually know — a truncated frame and an altered one are
         * the same GCM failure.
         */
        TRUNCATED_STREAM,

        /** Every frame authenticated, but the total is not what the manifest
         *  promised — the shape a stream truncated on a frame boundary takes. */
        LENGTH_MISMATCH,
    }
}

internal fun storedFailure(reason: StoredWireException.Reason): Nothing =
    throw StoredWireException(reason)

/** 32 bytes of AES-256-GCM key, and nothing else is a key. */
const val STORE_KEY_BYTES = 32

/**
 * base64url, NO padding — libsodium's `URLSAFE_NO_PADDING`, which is what the
 * Web writes into `#k=` and therefore what every other client must read.
 */
fun encodeStoreKey(raw: ByteArray): String =
    Base64.getUrlEncoder().withoutPadding().encodeToString(raw)

/**
 * The length of a 32-byte key in unpadded base64url: exactly 43 characters.
 *
 * Checked FIRST, before the alphabet scan and before the decoder sees anything.
 * This value arrives from a clipboard, an intent or a pasted link, so the cheap
 * exact-length refusal is what stops a megabyte of "key" from being scanned and
 * decoded into a buffer only to be rejected for its size at the end.
 */
const val STORE_KEY_TEXT_LENGTH = 43

/**
 * Strict decode: refuse, never repair.
 *
 * Three rules, in the order that costs least:
 *
 * * the length is exactly [STORE_KEY_TEXT_LENGTH]. Nothing else can be a
 *   32-byte key, and this subsumes the wire document's `length % 4 == 1` rule —
 *   a key that lost a character in transit fails here rather than decoding to a
 *   different 32 bytes;
 * * every character is in the base64url alphabet — no `+`, `/`, `=` or
 *   whitespace, so a key pasted with a stray character FAILS instead of
 *   silently meaning something else;
 * * the decoded result really is [STORE_KEY_BYTES] long.
 *
 * The refusal matters more than it looks: a silently truncated key would
 * otherwise produce an authentication failure the user reads as "the sender's
 * file is corrupt", when the honest answer is "this link is incomplete".
 */
fun decodeStoreKey(text: String): ByteArray {
    if (text.length != STORE_KEY_TEXT_LENGTH) storedFailure(StoredWireException.Reason.INVALID_KEY)
    for (c in text) {
        val ok = c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' || c == '-' || c == '_'
        if (!ok) storedFailure(StoredWireException.Reason.INVALID_KEY)
    }
    val raw = try {
        Base64.getUrlDecoder().decode(text)
    } catch (_: IllegalArgumentException) {
        storedFailure(StoredWireException.Reason.INVALID_KEY)
    }
    if (raw.size != STORE_KEY_BYTES) storedFailure(StoredWireException.Reason.INVALID_KEY)
    return raw
}

/** A fresh upload key from the platform CSPRNG. */
fun generateStoreKey(): ByteArray =
    ByteArray(STORE_KEY_BYTES).also { java.security.SecureRandom().nextBytes(it) }
