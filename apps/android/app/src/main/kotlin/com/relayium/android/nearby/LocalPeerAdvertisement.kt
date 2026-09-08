package com.relayium.android.nearby

import java.security.SecureRandom

/**
 * What one device says about itself on the local link, and the exact rules for
 * reading what another device said.
 *
 * This is a PORT, not a design: the authority is
 * `apps/RelayiumKit/Sources/RelayiumLocalPeerKit/LocalPeerAdvertisement.swift`,
 * which is shipped in the Apple clients. Every bound below is one of theirs, and
 * a difference in any of them is a peer that one platform lists and the other
 * silently refuses. They are written out rather than relaxed for exactly that
 * reason.
 *
 * Nothing here is a key, an authenticated identity, or permission for anything.
 * The identity is a per-channel random label so that browsing does not broadcast
 * a durable installation handle, and the capabilities are a HINT about which
 * wire a peer can speak. A record can be forged by anything on the link; the
 * commit-reveal handshake and the SAS are what authenticate a session, and no
 * value in this file shortens either.
 */
data class LocalPeerAdvertisement(
    val identity: String,
    val name: String,
    val capabilities: List<String>,
) {

    /** Bonjour instance name IS the identity, so a record whose instance name and
     *  `i` disagree is refused rather than reconciled. */
    val serviceInstanceName: String get() = identity

    val txtRecord: Map<String, String>
        get() = mapOf(
            IDENTITY_KEY to identity,
            NAME_KEY to name,
            CAPABILITIES_KEY to capabilities.joinToString(CAPABILITY_SEPARATOR.toString()),
        )

    companion object {
        /** The only Bonjour service this app advertises or browses.
         *
         *  `NsdManager` wants the trailing dot that `NWListener.Service` does
         *  not; both name the same `_relayium._tcp` service, and the platform
         *  strips or adds the dot on its own. Kept as two constants so neither
         *  side has to remember which shape its API takes. */
        const val SERVICE_TYPE = "_relayium._tcp."
        const val SERVICE_DOMAIN = "local."

        const val IDENTITY_KEY = "i"
        const val NAME_KEY = "n"
        const val CAPABILITIES_KEY = "c"

        const val IDENTITY_LENGTH = 32
        const val MAX_NAME_BYTES = 64
        /** One separator, so the field is a LIST rather than a nested encoding a
         *  parser could be talked into walking. */
        const val CAPABILITY_SEPARATOR = ','
        const val MAX_CAPABILITY_BYTES = 24
        const val MAX_CAPABILITIES = 8

        private val random = SecureRandom()

        /** A fresh per-channel identity: 16 random bytes as lower-case hex. */
        fun mintIdentity(): String {
            val bytes = ByteArray(IDENTITY_LENGTH / 2)
            random.nextBytes(bytes)
            return bytes.joinToString("") { "%02x".format(it) }
        }

        /**
         * Exactly 32 lower-case hex characters, compared as BYTES.
         *
         * `Char.isLetterOrDigit` and an upper-case variant are both wrong here:
         * the value is matched for exact equality against a Bonjour instance
         * name everywhere it is read, so anything a byte comparison could not
         * match is refused rather than carried as an unusable id.
         */
        fun isValidIdentity(value: String): Boolean {
            val bytes = value.toByteArray(Charsets.UTF_8)
            if (bytes.size != IDENTITY_LENGTH) return false
            return bytes.all { b ->
                val c = b.toInt() and 0xff
                (c in 0x30..0x39) || (c in 0x61..0x66)
            }
        }

        /** Printable ASCII, no separator, bounded, non-empty. */
        fun isValidCapability(value: String): Boolean {
            val bytes = value.toByteArray(Charsets.UTF_8)
            if (bytes.isEmpty() || bytes.size > MAX_CAPABILITY_BYTES) return false
            return bytes.all { b ->
                val c = b.toInt() and 0xff
                c > 0x20 && c < 0x7f && c != ','.code
            }
        }

        /**
         * A capability list a peer could not have meant is not a peer with fewer
         * capabilities — it is a record this build does not understand, and the
         * WHOLE advertisement is refused rather than admitted with a guess.
         *
         * Empty segments are kept by the split (`limit = -1` is Kotlin's
         * `omittingEmptySubsequences: false`) precisely so an empty field, a
         * trailing comma or a doubled comma FAILS `isValidCapability` instead of
         * quietly becoming a shorter list. Duplicates are rejected rather than
         * collapsed: two spellings of one claim is how a list gets read as
         * longer than the bound that admitted it.
         */
        fun parseCapabilities(field: String): List<String>? {
            val tokens = field.split(CAPABILITY_SEPARATOR)
            if (tokens.isEmpty() || tokens.size > MAX_CAPABILITIES) return null
            if (!tokens.all(::isValidCapability)) return null
            if (tokens.toSet().size != tokens.size) return null
            return tokens
        }

        /**
         * Read a discovered record, or refuse it whole.
         *
         * Unknown keys and a Bonjour-renamed instance are INCOMPATIBLE peers,
         * not partially understood ones: the key set must be exactly the three
         * this record has, and `i` must equal the instance name the responder
         * actually answered under. A future record shape must use a new type.
         */
        fun parse(instanceName: String, txtRecord: Map<String, String>): LocalPeerAdvertisement? {
            if (txtRecord.keys != setOf(IDENTITY_KEY, NAME_KEY, CAPABILITIES_KEY)) return null
            val identity = txtRecord[IDENTITY_KEY] ?: return null
            if (identity != instanceName) return null
            if (!isValidIdentity(identity)) return null
            val name = txtRecord[NAME_KEY] ?: return null
            if (name.isEmpty()) return null
            if (name.toByteArray(Charsets.UTF_8).size > MAX_NAME_BYTES) return null
            val field = txtRecord[CAPABILITIES_KEY] ?: return null
            val capabilities = parseCapabilities(field) ?: return null
            return LocalPeerAdvertisement(identity, name, capabilities)
        }

        /**
         * Trim a device name to something the Apple parser will accept.
         *
         * `android.os.Build.MODEL` is short in practice, but it is not bounded
         * by anything this app controls, and a name over 64 UTF-8 bytes makes
         * the WHOLE advertisement unparseable to a peer — an invisible failure
         * that looks like "the other device does not appear". Truncation is on
         * a CODE POINT boundary, so a multi-byte character is never cut in half
         * into invalid UTF-8. An empty or blank name falls back to a constant
         * rather than advertising a record `parse` would refuse.
         */
        fun sanitizeName(raw: String): String {
            val trimmed = raw.trim()
            if (trimmed.isEmpty()) return FALLBACK_NAME
            if (trimmed.toByteArray(Charsets.UTF_8).size <= MAX_NAME_BYTES) return trimmed
            val out = StringBuilder()
            var bytes = 0
            var i = 0
            while (i < trimmed.length) {
                val point = trimmed.codePointAt(i)
                val width = Character.charCount(point)
                val chunk = String(Character.toChars(point))
                val size = chunk.toByteArray(Charsets.UTF_8).size
                if (bytes + size > MAX_NAME_BYTES) break
                out.append(chunk)
                bytes += size
                i += width
            }
            return if (out.isEmpty()) FALLBACK_NAME else out.toString()
        }

        /** Used only when a device has no usable name of its own. */
        const val FALLBACK_NAME = "Android"
    }
}
