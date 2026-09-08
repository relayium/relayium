package com.relayium.android.integration

import com.relayium.android.ingress.ContentAccess
import com.relayium.android.ingress.IncomingUri
import com.relayium.android.ingress.IngressCoordinator
import com.relayium.android.ingress.IngressOutcome
import com.relayium.android.ingress.IngressRefusal
import com.relayium.android.ingress.IngressRequest
import com.relayium.android.ingress.IngressSurface
import com.relayium.android.ingress.ProviderDescription
import com.relayium.android.ingress.ShareItemRefusal
import com.relayium.android.ingress.ShareStaging
import com.relayium.android.ingress.StagedShare
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Everything another app hands this one, held until the user says where it
 * goes.
 *
 * ## Staging is not sending, and the type system says so
 *
 * The accepted ingress vocabulary has no `Send` case — see `IngressRequest` —
 * and this class adds none. A share becomes a list of references, a description
 * the user can read, and a set of destinations to choose from. The transfer
 * itself starts at a tap, on a screen naming what will be sent and where.
 *
 * That is the whole product decision: an app that auto-sent on intent delivery
 * would be uploading somebody's photo the moment they mis-tapped a share sheet.
 *
 * ## Why a share is not gated on a live transfer, and a link is
 *
 * `IngressCoordinator` asks [IngressCoordinator] wiring whether a request must
 * wait. A prefilled code overwrites the code a live session is running on, and
 * a stored link restarts a download — both destroy work, so both wait.
 *
 * Staging destroys nothing. It opens no stream, holds no lease and touches no
 * session; the one thing it replaces is an EARLIER staged share, which is
 * already "latest wins" by design. Making it wait would mean a user who shared
 * a photo during a transfer saw nothing happen at all, with the share arriving
 * minutes later attached to a screen they had left. So it is applied at once,
 * and the destruction that a dispatch really can cause is gated at the dispatch
 * — where the screen names it.
 *
 * ## Nothing here is saved state
 *
 * Shared text is the user's message and staged URIs carry grants. Both live in
 * this object, whose lifetime is the ViewModel's — through rotation and the
 * picker round trip, and no further. After process death the honest answer is
 * that the share is gone, which is what the surface says; persisting it would
 * mean writing a message or a capability outside this process's memory.
 */
class IngressHost(
    /** Where descriptions are read. Provider queries are binder calls into
     *  another process and must never run on Main. */
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {

    /**
     * The staging for the intent currently held, or null.
     *
     * ## Why a staging PER INTENT and not one for the app
     *
     * `ShareStaging` takes one [ContentAccess] for its lifetime, and every
     * `StagedShare` it creates keeps that reference — which is exactly right,
     * because an intent's access is closed over the URIs THAT intent named and
     * is the only capability that can open them.
     *
     * A single long-lived staging whose access was swapped as each intent
     * arrived would break that binding, and not only in theory: a share already
     * TAKEN by a dispatch is still live and still reading, and after a newer
     * intent arrived its reads would resolve through the newer intent's handle
     * map. For a URI the new map does not hold that is a lost grant mid-send;
     * for one it does hold, it is the wrong provider entry answering for the
     * user's earlier file.
     *
     * One staging per intent makes the binding permanent by construction. A
     * share removed from its slot by [take] carries its own access with it and
     * is unaffected by anything that arrives afterwards.
     */
    private var staging: ShareStaging? = null

    /**
     * The share currently held, as this host identifies it.
     *
     * ## Why the id is the HOST's and not the staging's
     *
     * `ShareStaging` numbers its shares from its own counter, which is exactly
     * right for one staging and wrong across many: with a staging per intent,
     * every intent's first share is `1`. The id is the fence the surface uses —
     * it pins the share that was on screen when the user tapped, so a newer one
     * arriving between the render and the tap cannot be dispatched in its place
     * — and an id that repeats is not a fence at all.
     *
     * So the host numbers shares monotonically for the life of the process and
     * translates at [take]. The staging's own id is still checked, by the
     * staging, which keeps that rule where it was written.
     */
    private class Held(val hostId: Long, val staging: ShareStaging, val shareId: Long)

    private var held: Held? = null

    private var nextStagedId = 0L

    /** Held here rather than in the staging, which is about references. */
    private var stagedText: String? = null

    private val _staged = MutableStateFlow<Staged?>(null)

    /** What the share surface renders. Null when nothing is held. */
    val staged: StateFlow<Staged?> = _staged.asStateFlow()

    private val _navigation = MutableStateFlow<IngressSurface?>(null)

    /** A one-shot request for the shell to select a surface. The shell consumes
     *  it with [consumeNavigation]; it is never re-raised, so a recreation
     *  cannot yank the screen away from wherever the user has since gone. */
    val navigation: StateFlow<IngressSurface?> = _navigation.asStateFlow()

    private val _refusal = MutableStateFlow<IngressRefusal?>(null)

    /** Why the last thing handed to this app was refused, as an identity the UI
     *  localises. Never the input itself. */
    val refusal: StateFlow<IngressRefusal?> = _refusal.asStateFlow()

    /**
     * What is staged, as the surface may show it.
     *
     * [items] is null until the descriptions have been read off the main
     * thread — a count is known immediately, names and sizes are not.
     */
    class Staged internal constructor(
        val id: Long,
        val epoch: Long,
        val kind: Kind,
        val itemCount: Int,
        val items: List<Item>?,
        /** Counts, by reason, of what admission dropped. Never identities. */
        val skipped: Map<ShareItemRefusal, Int>,
        /** Present only for [Kind.TEXT]. The user's message, in memory. */
        val text: String?,
    ) {
        enum class Kind { FILES, TEXT }

        /** One item: sanitised name, or null when the provider would not say. */
        class Item internal constructor(
            val uri: IncomingUri,
            val displayName: String?,
            val size: Long?,
        )

        /** No names, no text, no URIs. */
        override fun toString(): String = "Staged($kind, items=$itemCount, described=${items != null})"
    }

    /**
     * The coordinator, built once and owned for the ViewModel's life.
     *
     * [navigate] and [apply] are this object's; [isBusy] belongs to the caller,
     * because whether a code or a stored link may be written depends on models
     * this class deliberately does not know about.
     */
    fun coordinator(
        isBusy: (IngressRequest) -> Boolean,
        applyLink: (IngressRequest) -> Unit,
    ): IngressCoordinator = IngressCoordinator(
        navigate = { surface -> _navigation.value = surface },
        apply = { request ->
            when (request) {
                is IngressRequest.StageFiles -> Unit // staged by the caller; see stage()
                is IngressRequest.StageText -> Unit
                else -> applyLink(request)
            }
        },
        isBusy = { request ->
            when (request) {
                // Staging destroys nothing, so it never waits. See the class
                // note: waiting here is how a share silently disappears.
                is IngressRequest.StageFiles, is IngressRequest.StageText -> false
                else -> isBusy(request)
            }
        },
    )

    /** The shell has selected the surface; do not ask again. */
    fun consumeNavigation() {
        _navigation.value = null
    }

    fun clearRefusal() {
        _refusal.value = null
    }

    /** Report a refusal for the surface to render. */
    fun refuse(reason: IngressRefusal) {
        _refusal.value = reason
    }

    /**
     * Hold a shared batch of files, replacing whatever was held.
     *
     * The descriptions are read afterwards, on [io]: a provider query is a
     * binder call into another process and can block for as long as that
     * process likes. The count is published immediately so the surface has
     * something truthful to show while they resolve.
     */
    fun stage(
        request: IngressRequest.StageFiles,
        contentAccess: ContentAccess,
        epoch: Long,
        scope: CoroutineScope,
    ) {
        stagedText = null
        // The new intent's own staging, bound to the access that can open the
        // URIs it named. The previous one is cancelled AFTERWARDS, so the
        // ordering is stated once and is the ordering that actually runs:
        // whatever was still sitting in the old slot is released, while a share
        // a dispatch already took is untouched — it is no longer in a slot, and
        // its owner is responsible for it.
        val previous = staging
        val fresh = ShareStaging(contentAccess)
        staging = fresh
        val share = fresh.stage(request.share, epoch)
        val hostId = ++nextStagedId
        held = Held(hostId, fresh, share.id)
        previous?.cancel()
        _refusal.value = null
        _staged.value = Staged(
            id = hostId,
            epoch = epoch,
            kind = Staged.Kind.FILES,
            itemCount = share.items.size,
            items = null,
            skipped = share.skipped,
            text = null,
        )
        scope.launch { describe(share, epoch) }
    }

    /** Hold shared text, replacing whatever was held. */
    fun stage(request: IngressRequest.StageText, epoch: Long) {
        // A previous file share is released rather than left holding grants: the
        // user has replaced it, and a grant nobody can dispatch is one nobody
        // should keep. A share a dispatch already took is not in the slot and is
        // not this call's to release.
        staging?.cancel()
        stagedText = request.text
        _refusal.value = null
        _staged.value = Staged(
            id = TEXT_ID,
            epoch = epoch,
            kind = Staged.Kind.TEXT,
            itemCount = 1,
            items = emptyList(),
            skipped = emptyMap(),
            text = request.text,
        )
    }

    private suspend fun describe(share: StagedShare, epoch: Long) {
        val described = withContext(io) {
            share.items.map { uri ->
                val item = share.describe(uri)
                Staged.Item(uri, item?.displayName, item?.size)
            }
        }
        // The share may have been replaced or released while the provider was
        // answering. Publishing then would repopulate a surface the share is no
        // longer behind.
        if (share.isReleased) return
        val current = _staged.value ?: return
        // The published share, by the host's own identity: `share.id` restarts
        // with each intent's staging and cannot answer "is this still the one".
        if (held?.staging !== staging || current.epoch != epoch) return
        if (held?.shareId != share.id) return
        _staged.value = Staged(
            id = current.id,
            epoch = current.epoch,
            kind = current.kind,
            itemCount = current.itemCount,
            items = described,
            skipped = current.skipped,
            text = null,
        )
    }

    /**
     * The staged text, if the epoch still matches.
     *
     * Read at the dispatch rather than held by the caller, so a message cannot
     * be sent under an identity that replaced the one it was staged under.
     */
    fun textFor(epoch: Long): String? {
        val current = _staged.value ?: return null
        if (current.kind != Staged.Kind.TEXT || current.epoch != epoch) return null
        return stagedText
    }

    /**
     * Hand the staged files to the destination the user chose.
     *
     * Both fences are the accepted staging's: [id] pins the share that was on
     * screen when they tapped, [epoch] pins the identity. Ownership moves to
     * the caller, which must `release` when its transfer finishes or fails.
     */
    fun take(id: Long, epoch: Long): StagedShare? {
        // The host's id pins WHICH share the user tapped for; the staging's own
        // id and epoch are still what release it, so the accepted rule stays
        // where it was written.
        val current = held ?: return null
        if (current.hostId != id) return null
        val taken = current.staging.take(current.shareId, epoch)
        if (taken != null) {
            held = null
            clear()
        }
        return taken
    }

    /** The user dismissed the share, or its identity went away. */
    fun cancel() {
        staging?.cancel()
        held = null
        clear()
    }

    /**
     * Release a share whose staging epoch is no longer current.
     *
     * Called on every identity change. `ShareStaging.current` does the release
     * itself when asked under the new epoch; asking is what makes it happen
     * rather than leaving a grant held by a slot nobody will read again.
     */
    fun releaseStale(epoch: Long) {
        val held = _staged.value ?: return
        if (held.epoch == epoch) return
        staging?.current(epoch)
        cancel()
    }

    private fun clear() {
        stagedText = null
        _staged.value = null
    }

    private companion object {
        /** Text is not a `StagedShare` and has no id of its own; one constant is
         *  clearer than a nullable the dispatch path would have to branch on. */
        const val TEXT_ID = -1L
    }
}

/** Map the ingress module's surface vocabulary onto nothing — the shell owns
 *  its destinations, and this is where the two meet. Kept here so the ingress
 *  module stays testable without the shell's enum. */
fun IngressSurface.isShare(): Boolean = this == IngressSurface.SHARE

/** Whether an outcome carried a refusal to render. */
fun IngressOutcome.refusalOrNull(): IngressRefusal? =
    (this as? IngressOutcome.Refused)?.reason
