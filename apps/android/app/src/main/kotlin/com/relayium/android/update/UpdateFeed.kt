package com.relayium.android.update

import com.relayium.protocol.Json
import java.net.URI
import java.net.URISyntaxException

/**
 * The official update metadata document, and every rule that decides whether a
 * fetched one may be believed.
 *
 * ## What this file is NOT
 *
 * It is not a download verifier. The update flow is browser-mediated: this app
 * hands a URL to the system browser, the user confirms the install, and the
 * bytes never pass through Relayium's process. The `sha256` and `size` below
 * are therefore PUBLISHED FACTS a person can check by hand — they are not, and
 * must never be described as, something the app verified. What actually
 * enforces update identity is Android's own package manager: an APK signed by
 * a different certificate cannot replace an installed one
 * (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`), and `applicationId` below is checked
 * so a feed cannot point this app at a different product's package.
 *
 * ## Why the parsing is this strict
 *
 * The document is fetched over the network and its `downloadUrl` becomes an
 * `ACTION_VIEW` intent. A lenient reader would turn "the feed was replaced" or
 * "a middlebox answered instead" into "here is a link, please install it". So
 * every required field must be present AND well-formed, and anything else is a
 * refusal rather than a best effort. Unknown fields are the one deliberate
 * exception: they are ignored, so a later schema can add one without bricking
 * the readers already installed.
 */
object UpdateFeed {

    /** The one document a shipped build ever reads. */
    const val OFFICIAL_URL = "https://relayium.com/apps/android/update.json"

    /** The package this app is; a feed naming another product is refused. */
    const val APPLICATION_ID = "com.relayium.android"

    /** The only schema revision this build understands. A future document that
     *  bumps it is refused rather than guessed at — an unknown schema is an
     *  unknown meaning, and "ignore what you do not recognise" is only safe for
     *  ADDED fields, never for a changed contract. */
    const val SCHEMA = 1

    /**
     * The whole document, bounded. 64 KiB is far larger than any real feed
     * (the published one is a few hundred bytes) and small enough that a
     * hostile or broken origin cannot make this app read a stream forever.
     *
     * A reader must REJECT a body that exceeds this, not truncate it to fit:
     * a prefix of a JSON document is either invalid — in which case truncating
     * only changes which error is reported — or, far worse, a valid shorter
     * document that says something the publisher did not. `UpdateSource`
     * therefore asks for one byte more than this and fails if it gets it.
     */
    const val MAX_BODY_BYTES = 64 * 1024

    /** Release notes are shown as plain text in a bounded block. Anything
     *  longer is truncation of DISPLAY only, and the parse still succeeds —
     *  the note is prose, not a decision input. */
    const val MAX_NOTE_CHARS = 2000

    private const val DOWNLOAD_HOST = "github.com"

    private val SHA256 = Regex("^[0-9a-f]{64}$")

    /**
     * This channel's version names are exactly three numeric parts.
     *
     * Not a style rule. The download URL is DERIVED from the version below, so
     * the version string is part of a path; allowing an arbitrary label would
     * mean allowing an arbitrary path component, and two different labels could
     * describe the same release. Three plain integers, no leading zeros, no
     * suffix, no build metadata.
     */
    private val VERSION_NAME = Regex("""^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$""")

    /**
     * The largest APK this publisher will ever advertise: 512 MiB.
     *
     * A PUBLISHER POLICY, not an Android platform limit. It exists so `size` is
     * a bounded, sensible number rather than anything a JSON document can hold
     * — and so an absurd value is refused at the same place every other absurd
     * value is, instead of being carried into the UI and the staging tool.
     * `web/scripts/stage-android-release.mjs` enforces the identical bound, so
     * a document that would be refused on a device cannot be published either.
     */
    const val MAX_APK_BYTES: Long = 512L * 1024 * 1024

    /**
     * The exact immutable asset path for one specific release.
     *
     * This is the fix for a real hole: a path check that only matched the
     * `android-v…/Relayium….apk` NAMESPACE let a document advertise
     * `0.1.2 (3)` while pointing at `android-v0.1.1/Relayium-0.1.1-2.apk` — an
     * update offer that installs the version the user already has, or an older
     * one. The tag and the file name are not decoration; they identify the
     * bytes, so they must be DERIVED from the advertised version rather than
     * merely pattern-matched.
     *
     * The shape is the one the release helper actually produces:
     * tag `android-v<versionName>`, asset `Relayium-<versionName>-<versionCode>.apk`.
     */
    fun assetPath(versionName: String, versionCode: Int): String =
        "/relayium/relayium/releases/download/android-v$versionName/Relayium-$versionName-$versionCode.apk"

    /** What a well-formed document says. */
    sealed interface Feed {

        /**
         * The publisher states that no APK is currently distributed.
         *
         * A first-class answer, and deliberately NOT the same as "you are up to
         * date": it is what the placeholder manifest says before the first
         * release is published, and what a withdrawn release would say. The UI
         * must not turn it into an update offer, and must not turn it into an
         * error either — nothing failed.
         */
        data object None : Feed

        /** A published release, with every required field validated. */
        data class Release(
            val versionCode: Int,
            val versionName: String,
            val downloadUrl: String,
            val sha256: String,
            val size: Long,
            /** Locale tag → note. Always contains `en`. */
            val notes: Map<String, String>,
        ) : Feed
    }

    /** Why a document was refused. Rendered to the user as one honest sentence;
     *  the distinctions exist so a test can tell them apart. */
    enum class Rejection {
        /** Not JSON at all, or JSON this build's strict reader refuses — which
         *  is what an HTML error page or a captive-portal splash arrives as. */
        NOT_JSON,

        /** Valid JSON, wrong shape: a missing required field, a string where a
         *  number belongs, a non-integral or out-of-range `versionCode`. */
        MALFORMED,

        /** A schema revision this build does not understand. */
        UNKNOWN_SCHEMA,

        /** The feed describes a different application id. */
        WRONG_APPLICATION,

        /** `downloadUrl` is not the exact official immutable asset shape. */
        UNTRUSTED_URL,
    }

    sealed interface Parsed {
        data class Ok(val feed: Feed) : Parsed
        data class Refused(val why: Rejection) : Parsed
    }

    /**
     * Read a document.
     *
     * `text` is the COMPLETE body — a caller that could only read part of one
     * must fail before reaching here rather than pass a prefix.
     */
    fun parse(text: String): Parsed {
        val root = Json.parseOrNull(text) as? Json.Obj ?: return Parsed.Refused(Rejection.NOT_JSON)

        val schema = root["schema"].asIntOrNull() ?: return Parsed.Refused(Rejection.MALFORMED)
        if (schema != SCHEMA) return Parsed.Refused(Rejection.UNKNOWN_SCHEMA)

        val android = root["android"] as? Json.Obj ?: return Parsed.Refused(Rejection.MALFORMED)

        // `available` is required and must be a real boolean. A missing flag is
        // NOT read as false: the difference between "no release" and "the
        // document is not what we think it is" is exactly what this refusal
        // protects, and guessing would make a corrupted feed look like a
        // deliberate withdrawal.
        val available = (android["available"] as? Json.Bool)?.value
            ?: return Parsed.Refused(Rejection.MALFORMED)
        if (!available) return Parsed.Ok(Feed.None)

        val applicationId = (android["applicationId"] as? Json.Str)?.value
            ?: return Parsed.Refused(Rejection.MALFORMED)
        if (applicationId != APPLICATION_ID) return Parsed.Refused(Rejection.WRONG_APPLICATION)

        val versionCode = android["versionCode"].asIntOrNull()
            ?: return Parsed.Refused(Rejection.MALFORMED)
        if (versionCode < 1) return Parsed.Refused(Rejection.MALFORMED)

        val versionName = (android["versionName"] as? Json.Str)?.value
            ?: return Parsed.Refused(Rejection.MALFORMED)
        // Displayed verbatim next to a download button AND used to derive the
        // asset path, so it is the strict numeric form and nothing else.
        if (!VERSION_NAME.matches(versionName)) return Parsed.Refused(Rejection.MALFORMED)

        val sha256 = (android["sha256"] as? Json.Str)?.value
            ?: return Parsed.Refused(Rejection.MALFORMED)
        if (!SHA256.matches(sha256)) return Parsed.Refused(Rejection.MALFORMED)

        val size = android["size"].asLongOrNull() ?: return Parsed.Refused(Rejection.MALFORMED)
        if (size < 1 || size > MAX_APK_BYTES) return Parsed.Refused(Rejection.MALFORMED)

        val downloadUrl = (android["downloadUrl"] as? Json.Str)?.value
            ?: return Parsed.Refused(Rejection.MALFORMED)
        // Bound to THIS release, not merely to the official namespace.
        if (!isOfficialDownloadUrl(downloadUrl, versionName, versionCode)) {
            return Parsed.Refused(Rejection.UNTRUSTED_URL)
        }

        val notes = parseNotes(android["notes"]) ?: return Parsed.Refused(Rejection.MALFORMED)

        return Parsed.Ok(
            Feed.Release(
                versionCode = versionCode,
                versionName = versionName,
                downloadUrl = downloadUrl,
                sha256 = sha256,
                size = size,
                notes = notes,
            ),
        )
    }

    /**
     * Release notes: an object of locale tag → plain-text note, requiring `en`.
     *
     * English is required because it is the fallback: a document whose only
     * note is in a language this device does not read would otherwise render an
     * empty block. Notes are TEXT and are rendered as text — no markup is
     * parsed and no link is made clickable, so a compromised feed cannot put a
     * tappable URL in front of the user through this field.
     */
    private fun parseNotes(value: Json?): Map<String, String>? {
        val obj = value as? Json.Obj ?: return null
        val out = LinkedHashMap<String, String>(obj.entries.size)
        for ((tag, item) in obj.entries) {
            val note = (item as? Json.Str)?.value ?: return null
            // Control characters other than newline would let a note redraw the
            // block; a lone newline is legitimate paragraphing.
            if (note.any { it < ' ' && it != '\n' }) return null
            out[tag] = note.take(MAX_NOTE_CHARS)
        }
        if (out["en"].isNullOrBlank()) return null
        return out
    }

    /**
     * Pick the note for a locale, with English as the guaranteed fallback.
     *
     * `zh-Hans-CN` matches a `zh` note: the tag is narrowed at each `-` until
     * something matches, which is how a device locale that is more specific
     * than the published note still finds it.
     */
    fun noteFor(notes: Map<String, String>, localeTag: String): String {
        var tag = localeTag.lowercase().replace('_', '-')
        val lowered = notes.mapKeys { it.key.lowercase() }
        while (tag.isNotEmpty()) {
            lowered[tag]?.let { if (it.isNotBlank()) return it }
            val cut = tag.lastIndexOf('-')
            if (cut < 0) break
            tag = tag.substring(0, cut)
        }
        return lowered["en"].orEmpty()
    }

    /**
     * Is this exactly an official immutable release asset URL?
     *
     * PARSED, never prefix-matched. `https://github.com@evil.example/x.apk`
     * begins with an allowed-looking prefix and its HOST is `evil.example`;
     * `Backend.resolve` documents the same trap for the same reason, and this
     * is the same class of decision — the result is handed to the system
     * browser as something to install.
     *
     * Required, all of them:
     *
     *  * scheme exactly `https` (case-insensitively), so no cleartext and no
     *    `intent:`/`file:`/`javascript:` scheme smuggled through;
     *  * host exactly `github.com`, no subdomain, no trailing dot;
     *  * NO userinfo — that is the `@` trick above;
     *  * NO port at all, not even an explicit `:443`. The canonical URL has
     *    none, so anything else is a document this build did not expect;
     *  * NO query and NO fragment, which a redirector would need;
     *  * the raw path identical to the decoded path, which is what refuses
     *    `%2e%2e%2f` and every other encoded traversal without having to guess
     *    at normalisation; and
     *  * the path exactly [assetPath] for the version being advertised.
     *
     * That last one is the important one, and it is not a shape check. A
     * namespace-only pattern accepted a document advertising `0.1.2 (3)` while
     * pointing at `android-v0.1.1/Relayium-0.1.1-2.apk`, which offers the user
     * an "update" to a build they already have — or to an older one. The tag
     * and file name identify the bytes, so they are derived from the advertised
     * version and compared exactly, never merely matched against a pattern.
     */
    fun isOfficialDownloadUrl(candidate: String, versionName: String, versionCode: Int): Boolean {
        if (!VERSION_NAME.matches(versionName)) return false
        if (versionCode < 1) return false
        val uri = try {
            URI(candidate)
        } catch (_: URISyntaxException) {
            return false
        }
        if (uri.scheme?.lowercase() != "https") return false
        if (uri.userInfo != null || uri.rawUserInfo != null) return false
        if (uri.query != null || uri.rawQuery != null) return false
        if (uri.fragment != null || uri.rawFragment != null) return false
        if (uri.port != -1) return false
        if (uri.host?.lowercase() != DOWNLOAD_HOST) return false
        // `URI` exposes an authority that can carry things `host` normalises
        // away; requiring them equal keeps the two readings from differing.
        if (uri.authority?.lowercase() != DOWNLOAD_HOST) return false
        val path = uri.path ?: return false
        if (path != uri.rawPath) return false
        if (path.contains("..") || path.contains("//")) return false
        return path == assetPath(versionName, versionCode)
    }

    /** What the fetched document means for the build that fetched it. */
    sealed interface Outcome {
        /** The publisher distributes nothing right now. */
        data object NoneDistributed : Outcome

        /** Installed build is at or ahead of what is published. A feed that has
         *  gone BACKWARDS lands here too: a downgrade is never offered. */
        data class UpToDate(val installedVersionName: String) : Outcome

        /** Strictly newer. The only outcome that offers a download. */
        data class Available(val release: Feed.Release) : Outcome
    }

    /**
     * Compare a document against the running build.
     *
     * `versionCode` only. It is the integer Android itself orders packages by,
     * and it is the one the install would be judged against; comparing the
     * display name would make `0.1.10` older than `0.1.9`.
     */
    fun outcome(feed: Feed, installedVersionCode: Int, installedVersionName: String): Outcome =
        when (feed) {
            is Feed.None -> Outcome.NoneDistributed
            is Feed.Release ->
                if (feed.versionCode > installedVersionCode) {
                    Outcome.Available(feed)
                } else {
                    Outcome.UpToDate(installedVersionName)
                }
        }

    /**
     * A JSON number that is an exact, in-range Int.
     *
     * `Json.Num` holds a double, because that is what a browser reads. So
     * `2.5`, `1e400`, and anything past Int's range are all refusals rather
     * than roundings: a version ordering must not depend on how a fraction was
     * truncated.
     */
    private fun Json?.asIntOrNull(): Int? {
        val long = asLongOrNull() ?: return null
        return if (long in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()) long.toInt() else null
    }

    /**
     * A JSON number that is an exact integer.
     *
     * The obvious round-trip — `value.toLong().toDouble() == value` — is NOT
     * sufficient, and accepting it was a real defect. Kotlin's `Double.toLong`
     * SATURATES: `9223372036854775808` (2^63, one past `Long.MAX_VALUE`) parses
     * to the double `9.223372036854776E18`, saturates to `Long.MAX_VALUE`, and
     * `Long.MAX_VALUE.toDouble()` is that same double again — so the round-trip
     * "passes" for a value that is not representable at all, and the size check
     * downstream then compared a number the document never contained.
     *
     * Bounding at 2^53 is what actually fixes it: below that every integer has
     * exactly one double, so the round-trip means what it appears to mean. It
     * is also far above anything this document holds — a `versionCode` is an
     * Int and a `size` is capped at [MAX_APK_BYTES].
     */
    private fun Json?.asLongOrNull(): Long? {
        val value = (this as? Json.Num)?.value ?: return null
        if (!value.isFinite()) return null
        if (value > EXACT_INTEGER_LIMIT || value < -EXACT_INTEGER_LIMIT) return null
        val asLong = value.toLong()
        return if (asLong.toDouble() == value) asLong else null
    }

    /** 2^53: the largest magnitude where every integer has its own double. */
    private const val EXACT_INTEGER_LIMIT = 9007199254740992.0
}
