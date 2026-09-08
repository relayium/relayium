package com.relayium.android.ingress

import com.relayium.protocol.Filename
import com.relayium.protocol.ManifestCodec
import java.io.Closeable
import java.io.IOException
import java.io.InputStream

/**
 * Reading what is behind a shared URI, as a seam.
 *
 * The implementation is a `ContentResolver` and lives in the Android adapter;
 * this interface is what the staging rules are written against, so cancellation
 * ordering, a revoked grant and a provider that lies about a name are all
 * ordinary host unit tests instead of emulator runs.
 *
 * Both calls talk to another process and neither belongs on the main thread.
 */
interface ContentAccess {

    /**
     * What the provider says about an item, or null when it says nothing.
     *
     * Answers are UNTRUSTED: the provider is chosen by whoever sent the intent.
     * [SharedItemMetadata] is where they are made safe to display.
     */
    fun describe(uri: IncomingUri): ProviderDescription?

    /**
     * Open the item for reading.
     *
     * @throws IOException when the grant is gone, the document was deleted, the
     *   provider died, or it simply refuses. This is the ONLY proof that a
     *   grant is live — a flag on an intent is a claim, and this is the fact.
     */
    @Throws(IOException::class)
    fun open(uri: IncomingUri): InputStream
}

/** A provider's raw answer, exactly as it gave it. */
class ProviderDescription(val name: String?, val size: Long?) {
    override fun toString(): String = "ProviderDescription(name=<redacted>, size=$size)"
}

/**
 * Provider-supplied metadata, made safe to show.
 *
 * A shared item's name comes from an app the user did not choose, so it is
 * exactly as trustworthy as a name in a peer's manifest — which is why it
 * crosses the same sanitiser [ManifestCodec] puts every incoming name through.
 * A single U+202E turns `evil<RLO>gnp.exe` into something that reads as
 * `evilexe.png` in every list that renders it.
 *
 * The bounds are the wire's own: a name that could not survive
 * [ManifestCodec.MAX_NAME_BYTES] would be refused at the manifest anyway, and a
 * size the manifest cannot carry is not a size worth displaying.
 */
object SharedItemMetadata {

    /** UTF-8 bytes, as the manifest counts them. */
    const val MAX_NAME_BYTES = ManifestCodec.MAX_NAME_BYTES

    /**
     * A displayable name, or null when the provider gave nothing usable.
     *
     * Null is not a failure to paper over with "file": the destination decides
     * what an unnamed item is called, and inventing a name here would put that
     * decision in the parser, unlocalised.
     *
     * A name is REFUSED rather than truncated when it is too long. Cutting
     * bytes off a UTF-8 string is how a name becomes invalid mid-character, and
     * a shortened name is a different claim about the file than the one the
     * provider made.
     */
    fun displayName(raw: String?): String? {
        val value = raw ?: return null
        // Path separators are dropped rather than the name refused: a provider
        // that answers `holiday/2026.jpg` is describing one document, not a
        // folder, and the separator is only dangerous where it is joined onto a
        // destination path. `Filename.safeDisplayName` handles the bidi and
        // control characters that make a name lie about itself.
        val cleaned = Filename.safeDisplayName(value).replace('/', '_').replace('\\', '_').trim()
        if (cleaned.isEmpty() || cleaned == "." || cleaned == "..") return null
        if (cleaned.toByteArray(Charsets.UTF_8).size > MAX_NAME_BYTES) return null
        return cleaned
    }

    /**
     * A size, or null when the provider did not give a usable one.
     *
     * Null means UNKNOWN and must stay distinguishable from zero: a zero-byte
     * file is a real thing to send, and a provider that would not say is not
     * one. The existing picker path refuses an unknown size outright; here the
     * refusal belongs to the destination, which is the code that knows whether
     * it needs the number in advance.
     */
    fun size(raw: Long?): Long? {
        val value = raw ?: return null
        if (value < 0 || value > ManifestCodec.MAX_SAFE_SIZE) return null
        return value
    }
}

/** One shared item as it can be shown: sanitised, bounded, possibly unknown. */
class StagedItem internal constructor(
    val uri: IncomingUri,
    val displayName: String?,
    val size: Long?,
) {
    override fun toString(): String = "StagedItem(named=${displayName != null}, size=$size)"
}

/** Why a staged item could not be opened. */
enum class ShareUnavailable {
    /** The staged share was cancelled or replaced before this call. */
    RELEASED,
    /** The item is not part of this share. */
    NOT_STAGED,
    /** The provider would not open it: revoked, deleted, gone, refused. */
    GRANT_LOST,
}

/**
 * An item cannot be read, with the reason as an identity rather than text.
 *
 * The message deliberately carries no URI, no path and no provider answer. This
 * exception's text ends up in coroutine failures and crash reports, and "which
 * document" is precisely the part that is nobody else's business.
 */
class ShareUnavailableException(val reason: ShareUnavailable) :
    IOException("relayium: shared item unavailable ($reason)")

/**
 * A share the app is holding on to, and the only thing that can open it.
 *
 * ## What "staged" means here, and what it does not
 *
 * It means references. No content has been read, no bytes copied, nothing
 * written to disk, and no network touched. That is the whole design: the app
 * receives an intent from any installed app, and the cost of receiving one is a
 * list of URIs in memory. iOS stages differently — its share EXTENSION is a
 * separate process that cannot pass a live reference, so it must copy plaintext
 * into an App Group — and copying here to look symmetrical would take a
 * property Android gives for free and throw it away.
 *
 * ## Ownership, and why it is a lease
 *
 * A read grant that arrived on an intent lives as long as the receiving task
 * decides it does; nothing here takes a persistable one, because a persistable
 * grant is an ongoing claim on somebody else's document and Android only offers
 * it under an explicit contract (`ACTION_OPEN_DOCUMENT` and friends) that a
 * share intent is not. So this object holds what it was given, hands out
 * streams, and can be told to let go — and letting go closes every stream it
 * handed out, in the same call, rather than leaving it to a garbage collector
 * that has no deadline.
 *
 * ## Threading
 *
 * [open] and [release] can race, because they will: cancellation comes from the
 * main thread and reads happen on IO. The lock covers the released flag and the
 * registry, the provider call is made outside it (it can block), and the stream
 * is closed if a release won that race — so the outcome of a cancel arriving
 * mid-open is a closed descriptor and a refusal, never a live handle nobody is
 * tracking.
 */
class StagedShare internal constructor(
    /** Identity of THIS staging. Monotonic, never reused; a dispatch made
     *  against an older share can be recognised and refused. */
    val id: Long,
    /** The account/session generation this was staged under. */
    val generation: Long,
    val items: List<IncomingUri>,
    /** Counts, by reason, of what admission dropped. Never identities. */
    val skipped: Map<ShareItemRefusal, Int>,
    private val access: ContentAccess,
) {

    private val lock = Any()
    private var released = false
    private val handedOut = ArrayList<Closeable>()
    /** Membership as a set, so [open] does not walk a thousand-item list. */
    private val staged: Set<String> = items.mapTo(HashSet(items.size)) { it.key }

    val isReleased: Boolean get() = synchronized(lock) { released }

    /**
     * What to show for an item, or null when there is nothing to show it on.
     *
     * **Fenced at both ends, like [open].** A released share asks the provider
     * NOTHING: a cancelled or replaced share that kept querying would be this
     * app reading somebody's documents after the user said stop, and a result
     * arriving from a query that started before the cancel would repopulate a
     * surface the share is no longer behind. The check after the call is the
     * half that closes the second one — the provider call is slow, and a cancel
     * lands inside it.
     *
     * **Null and unknown are different answers**, deliberately:
     *
     *  - `null` means this share is gone (released) or this item was never part
     *    of it. There is nothing to render, and the surface should stop.
     *  - a [StagedItem] with a null name or size means the PROVIDER would not
     *    say — a lapsed grant, a document deleted underneath, a provider that
     *    answers no columns. The item is still staged and the user can still be
     *    told what happened to it.
     *
     * Never throws for the second case: a provider that fails to describe its
     * own document must not take down the surface listing it.
     */
    fun describe(uri: IncomingUri): StagedItem? {
        if (uri.key !in staged) return null
        synchronized(lock) { if (released) return null }
        val raw = try {
            access.describe(uri)
        } catch (_: Exception) {
            // Any provider misbehaviour — a throwing cursor, a security
            // exception from a grant that has already lapsed — is the same
            // event to the user: we cannot say what this is.
            null
        }
        synchronized(lock) { if (released) return null }
        return StagedItem(uri, SharedItemMetadata.displayName(raw?.name), SharedItemMetadata.size(raw?.size))
    }

    /**
     * Open one staged item.
     *
     * Membership is checked FIRST and is not a formality: without it this
     * object would be an open-anything primitive reachable from wherever it is
     * held, and the admission rules that decided which URIs are safe would
     * apply only to the callers that remembered them.
     */
    @Throws(ShareUnavailableException::class)
    fun open(uri: IncomingUri): InputStream {
        if (uri.key !in staged) throw ShareUnavailableException(ShareUnavailable.NOT_STAGED)
        synchronized(lock) {
            if (released) throw ShareUnavailableException(ShareUnavailable.RELEASED)
        }
        val stream = try {
            access.open(uri)
        } catch (_: IOException) {
            throw ShareUnavailableException(ShareUnavailable.GRANT_LOST)
        } catch (_: SecurityException) {
            // A revoked grant surfaces as a SecurityException rather than an
            // IOException, and it is the SAME event to the user: this is no
            // longer available. Letting it propagate would crash a send.
            throw ShareUnavailableException(ShareUnavailable.GRANT_LOST)
        }
        synchronized(lock) {
            if (released) {
                // Release won the race. The descriptor exists, so it is this
                // call's job to close it — the releasing call had nothing to
                // close at the time it ran.
                closeQuietly(stream)
                throw ShareUnavailableException(ShareUnavailable.RELEASED)
            }
            handedOut.add(stream)
        }
        return stream
    }

    /**
     * Let go: close every stream handed out, and refuse every later open.
     *
     * Idempotent, because the paths that call it are independent — a
     * replacement, a cancellation and the end of a transfer can all be true of
     * the same share, and each of them is right to say so.
     */
    fun release() {
        val toClose: List<Closeable>
        synchronized(lock) {
            if (released) return
            released = true
            toClose = ArrayList(handedOut)
            handedOut.clear()
        }
        // Outside the lock: closing talks to the provider, and a provider that
        // blocks must not hold up the next stage.
        for (stream in toClose) closeQuietly(stream)
    }

    private fun closeQuietly(stream: Closeable) {
        try {
            stream.close()
        } catch (_: Exception) {
            // Nothing to do and nothing to say: the descriptor is being
            // abandoned either way, and a close failure is not the user's
            // problem to hear about.
        }
    }
}

/**
 * The one share this app is holding, and the fences around handing it on.
 *
 * ## One slot, latest wins
 *
 * The same rule [IngressCoordinator] uses for links, for the same reason: two
 * shares are two things the user asked for, and the older one is the one they
 * have moved on from. Replacement RELEASES the old share, so a superseded
 * share cannot leave a descriptor open behind it.
 *
 * ## Why a generation
 *
 * A share is account-independent — it is staged before the user has chosen
 * where it goes, and choosing may involve signing in. But it must not survive
 * INTO a different account or a different session: a file staged while signed
 * in as one person, dispatched after a switch, is that person's file uploaded
 * to somebody else's storage. So a share records the generation it was staged
 * under, and both readers compare it. A mismatch does not just refuse — it
 * RELEASES, because a share nobody can dispatch is a grant nobody should keep.
 *
 * The generation itself is the wiring's: whatever integer changes when the
 * account or the session identity changes. This module does not define what
 * that is, it defines that dispatch is fenced by it.
 */
class ShareStaging(private val access: ContentAccess) {

    private val lock = Any()
    private var slot: StagedShare? = null
    private var nextId = 0L

    /**
     * Hold this share, replacing and releasing whatever was held before.
     */
    fun stage(share: AdmittedShare, generation: Long): StagedShare {
        val previous: StagedShare?
        val staged: StagedShare
        synchronized(lock) {
            previous = slot
            staged = StagedShare(++nextId, generation, share.items, share.skipped, access)
            slot = staged
        }
        previous?.release()
        return staged
    }

    /**
     * What is staged for this generation, or null.
     *
     * A share from another generation is released and cleared here rather than
     * merely hidden: the surface asking is the one that would have shown it,
     * and "nobody will ever ask for this again" is exactly when a grant should
     * be let go.
     */
    fun current(generation: Long): StagedShare? {
        val stale: StagedShare?
        val answer: StagedShare?
        synchronized(lock) {
            val held = slot
            if (held == null) return null
            if (held.generation != generation) {
                slot = null
                stale = held
                answer = null
            } else {
                stale = null
                answer = held
            }
        }
        stale?.release()
        return answer
    }

    /**
     * Hand the staged share to the destination the user chose, and stop
     * holding it here.
     *
     * Fenced twice, because the two can go wrong independently: [id] pins the
     * share the user was LOOKING at when they tapped (a newer share may have
     * arrived between the render and the tap), and [generation] pins the
     * account and session it is being sent under. A mismatch on either returns
     * null and nothing is dispatched.
     *
     * Ownership moves to the caller, which becomes responsible for calling
     * `release` when its transfer finishes or fails. The slot is cleared so a
     * second tap cannot dispatch the same share twice.
     */
    fun take(id: Long, generation: Long): StagedShare? {
        val stale: StagedShare?
        val taken: StagedShare?
        synchronized(lock) {
            val held = slot
            if (held == null) return null
            if (held.id != id) {
                // A stale tap. The share that IS held is still current and is
                // not this call's to release — the user may still dispatch it.
                return null
            }
            if (held.generation != generation) {
                slot = null
                stale = held
                taken = null
            } else {
                slot = null
                stale = null
                taken = held
            }
        }
        stale?.release()
        return taken
    }

    /** Drop and release whatever is held. Safe to call when nothing is. */
    fun cancel() {
        val held: StagedShare?
        synchronized(lock) {
            held = slot
            slot = null
        }
        held?.release()
    }
}
