package com.relayium.android.integration

import java.io.File
import java.io.IOException
import java.security.SecureRandom

/**
 * The files this app has offered to another app, and for how long.
 *
 * ## Why a registry and not a path in the URI
 *
 * Opening, exporting or sharing a received delivery means handing a `content://`
 * URI to somebody else's app. The usual shape encodes a path — `FileProvider`
 * does exactly that — and then defends it with a canonical-prefix check, so the
 * safety of every received file rests on that one comparison being written
 * correctly and never regressing.
 *
 * Here the URI carries an opaque token and nothing else. There is no path to
 * traverse, no `..` to normalise and no encoding trick to try, because the
 * provider does not accept a path at all: it accepts a token that this process
 * minted, and answers only for files it was already holding. Path confinement is
 * then a property of what can be REGISTERED, checked once, here — rather than a
 * property of every request.
 *
 * ## Repeated reads are ordinary and must keep working
 *
 * A grant is **not** consumed by its first use. Real consumers do not read once:
 * a gallery queries the display name, then the size, then opens the file, then
 * re-opens it after a configuration change; a mail composer queries, opens to
 * hash, and opens again to attach. A token retired on first touch would work in
 * a test and fail in front of a user, with the file appearing to vanish
 * mid-attach. So a grant answers as many times as it is asked, for as long as
 * it is valid, exactly like any other read-only content provider.
 *
 * What bounds it instead is time and authority:
 *
 *  * **Lifetime.** [LIFETIME_MILLIS] from the moment it was minted, on the
 *    monotonic clock. Long enough for a user to pick an app, wait for it to
 *    start and read the file; short enough that a URI leaked into another app's
 *    history is not a standing capability over this account's deliveries.
 *  * **Authority.** Every grant records the account session it was minted
 *    under. An account change revokes them all — a URI minted for A must not
 *    still resolve while B is signed in, even though the bytes on disk are the
 *    same bytes.
 *
 * ## Process death is a truthful failure
 *
 * This registry is memory only, deliberately. A grant that survived into a new
 * process would be a capability the user never re-authorised, reconstructed from
 * persisted state that would itself have to name the file. So after process
 * death an outstanding URI resolves to nothing, and the provider answers the
 * consumer's open with an ordinary "not found" — which is what actually
 * happened — rather than crashing, or worse, resolving to whatever now occupies
 * that token.
 *
 * ## What is not here
 *
 * No secret is in the URI. The token is random so it cannot be guessed, but it
 * is not the protection: the provider is **not exported**, so nothing can reach
 * it except an app this one explicitly granted, and the token is what tells one
 * grant from another rather than what authorises it. No key, no bearer, no
 * account id and no path appears in it.
 *
 * Thread-safe: the provider is called from binder threads while the host mints
 * and revokes on the main thread.
 */
object SharedFileGrants {

    /** One offered file. */
    class Grant internal constructor(
        val file: File,
        val displayName: String,
        val size: Long,
        /** The account session this was minted under; see [revokeExcept]. */
        val authority: String,
        val expiresAt: Long,
    ) {
        /** No path and no account: this can reach a log. */
        override fun toString(): String = "Grant(named=${displayName.isNotEmpty()}, $size bytes)"
    }

    private val lock = Any()
    private val grants = HashMap<String, Grant>()

    /**
     * The directory every grantable file must be inside.
     *
     * Set once by the host from `noBackupFilesDir`. Until it is, nothing can be
     * registered — a registry with no root would accept any file the caller
     * named, which is the whole failure this class is built to make
     * unreachable.
     */
    private var root: File? = null

    /** Called once at host construction. */
    fun useRoot(directory: File) {
        synchronized(lock) { root = directory.canonicalFileOrNull() }
    }

    /**
     * Offer [files] to another app under [authority], and answer with the token
     * for each.
     *
     * A file outside the root, a file that is not a regular file, or one whose
     * path cannot be canonicalised is skipped rather than offered — the caller
     * gets a shorter list, which is the honest answer for a delivery whose files
     * a user has moved or deleted underneath the app.
     */
    fun offer(files: List<File>, authority: String, nowMillis: Long): List<String> {
        val confined = root ?: return emptyList()
        val tokens = ArrayList<String>(files.size)
        synchronized(lock) {
            prune(nowMillis)
            for (file in files) {
                val canonical = file.canonicalFileOrNull() ?: continue
                if (!canonical.isFile) continue
                if (!canonical.isInside(confined)) continue
                val token = randomToken()
                grants[token] = Grant(
                    file = canonical,
                    displayName = canonical.name,
                    size = canonical.length(),
                    authority = authority,
                    expiresAt = nowMillis + LIFETIME_MILLIS,
                )
                tokens += token
            }
        }
        return tokens
    }

    /**
     * The grant behind a token, for METADATA only.
     *
     * Null covers every refusal the provider must render the same way — never
     * minted, minted in a previous process, expired, revoked — because they are
     * the same event to the app on the other side: this is not available.
     *
     * Deliberately NOT the path an open takes. Returning a grant releases the
     * lock, and a revocation completing in that window would still leave the
     * caller holding a value it could open a descriptor from. A name and a size
     * read a beat before a revocation are harmless; a file descriptor is not.
     * See [openGrant].
     */
    fun resolve(token: String, nowMillis: Long): Grant? = synchronized(lock) {
        prune(nowMillis)
        grants[token]
    }

    /**
     * Validate a token AND open from it as one serialized operation.
     *
     * ## Why this is not "resolve, then open"
     *
     * That shape has a window. `resolve` checks the grant under the lock and
     * releases it; the caller then opens the file. An account change landing in
     * between runs [revokeExcept] to completion — and the open still succeeds,
     * handing the previous session's file to another app after the app has
     * decided that session is over. The check would be describing a state the
     * open no longer runs in.
     *
     * So the open happens INSIDE the operation that validates it. A revocation
     * either wins — [open] is never invoked and the consumer is told the file is
     * not available — or it loses, in which case the descriptor was already
     * created and handed out. There is no third outcome and no ordering in which
     * a revoked grant produces a descriptor.
     *
     * ## What is safe to do in [open], and what is not
     *
     * A bounded local `ParcelFileDescriptor.open` on the app's own storage, on
     * a binder thread, and nothing else. It must not read, block on IO, or
     * touch the main thread: this runs under the registry lock, and anything
     * slow here would stall every other grant operation in the process.
     *
     * A descriptor that has already been handed to another app is that app's to
     * own. Revocation stops NEW opens; it does not reach through an FD the
     * system has already duplicated into another process, and pretending
     * otherwise would be a claim this app cannot honour.
     */
    fun <T> openGrant(token: String, nowMillis: Long, open: (Grant) -> T): T? =
        synchronized(lock) {
            prune(nowMillis)
            val grant = grants[token] ?: return null
            open(grant)
        }

    /**
     * Drop every grant whose lifetime has run out.
     *
     * Called from every operation that touches the registry, rather than only
     * when a token happens to be resolved again. The ordinary case is a share
     * that SUCCEEDED: the consumer read the file, never came back, and its
     * grant would otherwise sit in this map for the life of the process. A
     * registry that only expired what it was asked about would grow with every
     * share the user ever made, and the entries it kept would be exactly the
     * ones nothing was watching.
     */
    private fun prune(nowMillis: Long) {
        grants.entries.removeAll { (_, grant) -> nowMillis >= grant.expiresAt }
    }

    /**
     * Revoke everything not minted under [authority].
     *
     * Called on every adoption, including the release to no account. A URI
     * minted while A was signed in must stop resolving the moment B is — the
     * bytes are the same bytes, and that is exactly why the check cannot be
     * about the file.
     */
    fun revokeExcept(authority: String?) {
        synchronized(lock) {
            grants.entries.removeAll { (_, grant) -> grant.authority != authority }
        }
    }

    /** Revoke everything. The host going away, or an explicit cancel. */
    fun revokeAll() {
        synchronized(lock) { grants.clear() }
    }

    /** How many grants are outstanding. For tests and for the host's own
     *  assertions; it names nothing. */
    fun outstanding(): Int = synchronized(lock) { grants.size }

    /**
     * Ten minutes.
     *
     * The interval a person needs to choose an app from the share sheet, watch
     * it start, and have it read the file — including a slow first launch. It is
     * not a session: nothing renews it, and a consumer that comes back tomorrow
     * gets nothing.
     */
    const val LIFETIME_MILLIS = 10 * 60 * 1000L

    /** 32 hex characters. Random so a token cannot be guessed; the provider not
     *  being exported is what actually authorises the read. */
    private fun randomToken(): String {
        val bytes = ByteArray(16)
        SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }
}

/**
 * The canonical form, or null when the filesystem will not say.
 *
 * Canonical rather than absolute: `getAbsolutePath` keeps `..` and follows no
 * symlink, so a containment check against it is a check against a string the
 * caller chose.
 */
internal fun File.canonicalFileOrNull(): File? = try {
    canonicalFile
} catch (_: IOException) {
    null
} catch (_: SecurityException) {
    null
}

/**
 * Whether this canonical path is inside [root].
 *
 * The separator is appended before comparing, so `/data/inbox-evil` is not
 * inside `/data/inbox` — the prefix bug this check exists to avoid. Equality
 * with the root itself is not containment: the root is a directory, and nothing
 * offers it.
 */
internal fun File.isInside(root: File): Boolean {
    val parent = root.path.let { if (it.endsWith(File.separator)) it else it + File.separator }
    return path.startsWith(parent)
}
