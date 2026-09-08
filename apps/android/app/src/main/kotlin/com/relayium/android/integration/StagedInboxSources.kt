package com.relayium.android.integration

import com.relayium.android.inbox.InboxAccountId
import com.relayium.android.inbox.InboxServiceFactory
import com.relayium.android.inbox.InboxServices
import com.relayium.android.inbox.InboxSourceOpener
import com.relayium.android.inbox.InboxSourceRef
import com.relayium.android.ingress.IncomingUri
import com.relayium.android.ingress.StagedShare
import com.relayium.protocol.stored.PlaintextSource
import java.io.IOException
import java.io.InputStream

/**
 * Sending a SHARED file to a device in the Inbox, without ever handing the
 * Inbox a raw `Uri`.
 *
 * ## The constraint this is built around
 *
 * The ingress module keeps the real `Uri` objects private on purpose — "the map
 * is the capability", so a caller cannot turn an accepted share into a
 * general-purpose opener by constructing an `IncomingUri` of its own. The only
 * sanctioned way to read staged content is `StagedShare.open`.
 *
 * The Inbox's own opener resolves `InboxSourceRef.uri` through a
 * `ContentResolver`, which is right for a file the user picked with the system
 * document picker and wrong for one that arrived on a share intent: it would
 * need the very `Uri` the ingress module declines to expose.
 *
 * So the two are composed rather than either being changed. A staged item is
 * named by a `relayium-share:` reference that only this opener understands; the
 * bytes come from the staged share, under the staging's own release semantics.
 * Anything else falls through to the production opener untouched, so a document
 * chosen from the picker takes exactly the path it takes today.
 *
 * ## Why the whole services bundle is rebuilt rather than mutated
 *
 * `InboxServices` is one account's pinned bundle — every field bound to one
 * account and one bearer. Reassigning a field on it would be the exact thing
 * its design forbids. Building a new bundle from the delegate's own fields
 * keeps that property: one account, one bearer, one bundle, with a single seam
 * substituted.
 */
class StagedInboxSources(
    private val delegate: InboxServiceFactory,
    /** The share the host is currently holding, read at open time so a
     *  replaced or released share cannot be read through a stale reference. */
    private val staged: () -> StagedShare?,
) : InboxServiceFactory {

    override suspend fun open(account: InboxAccountId, bearer: String): InboxServices {
        val base = delegate.open(account, bearer)
        return InboxServices(
            account = base.account,
            deviceId = base.deviceId,
            deviceName = base.deviceName,
            device = base.device,
            sender = base.sender,
            keys = base.keys,
            container = base.container,
            journals = base.journals,
            messages = base.messages,
            outgoing = base.outgoing,
            conversations = base.conversations,
            sendStore = base.sendStore,
            preparer = base.preparer,
            coordinator = base.coordinator,
            policies = base.policies,
            sources = Opener(base.sources, staged),
            freeBytes = base.freeBytes,
            engine = base.engine,
        )
    }

    /**
     * Opens staged items itself and hands everything else to the real opener.
     *
     * Deliberately NOT its own lifetime manager. The delegate's
     * `InboxLeasedSources` already owns the "close the descriptor out from under
     * a blocked read" behaviour, and a second, weaker copy of that here is how
     * a provider read ends up with two owners and no closer. Staged streams are
     * closed by the staged share's own `release`, which is the other owner they
     * already had.
     */
    private class Opener(
        private val fallback: InboxSourceOpener,
        private val staged: () -> StagedShare?,
    ) : InboxSourceOpener {

        override suspend fun <T> withSources(
            refs: List<InboxSourceRef>,
            body: suspend (List<PlaintextSource>) -> T,
        ): T {
            if (refs.none { it.uri.startsWith(PREFIX) }) return fallback.withSources(refs, body)
            val share = staged()
                ?: throw IOException("relayium: the shared items are no longer staged")
            val opened = ArrayList<PlaintextSource>(refs.size)
            for (ref in refs) {
                if (!ref.uri.startsWith(PREFIX)) {
                    // A mixed batch is not something the host composes, and
                    // silently sending only half of it would be worse than
                    // refusing the whole.
                    throw IOException("relayium: a batch mixes staged and picked sources")
                }
                opened += StagedSource(ref, share)
            }
            return body(opened)
        }
    }

    /**
     * One staged item as the encoder reads it.
     *
     * The stream is opened ONCE and held for the whole staging rather than
     * reopened per chunk, for the reason the picker path gives: a second
     * resolution of the same reference is the one that can point at different
     * bytes than the ones the user approved.
     */
    private class StagedSource(ref: InboxSourceRef, share: StagedShare) : PlaintextSource {

        override val name: String = ref.name
        override val size: Long = ref.size

        private val stream: InputStream = share.open(incomingUri(ref.uri))

        override fun read(max: Int): ByteArray {
            if (max <= 0) return ByteArray(0)
            val buffer = ByteArray(max)
            var read = 0
            // A content stream may return a short read at any point; only -1 is
            // the end. Filling the buffer keeps frames at the wire size instead
            // of producing a stream of tiny ones.
            while (read < max) {
                val n = stream.read(buffer, read, max - read)
                if (n <= 0) break
                read += n
            }
            return if (read == max) buffer else buffer.copyOf(read)
        }

        /** Closing belongs to the staged share, which is the owner that can act
         *  while a read is blocked. Closing twice is harmless. */
        override fun close() = Unit
    }

    companion object {
        /**
         * The scheme that marks a reference as staged rather than picked.
         *
         * `relayium-share:` cannot be a real content URI scheme, so a picked
         * document can never be mistaken for a staged one — and a staged
         * reference reaching the production opener by mistake resolves to
         * nothing rather than to some other document.
         */
        const val PREFIX = "relayium-share:"

        /** The reference the host puts in an [InboxSourceRef] for a staged item. */
        fun refUri(uri: IncomingUri): String = PREFIX + uri.key

        /** The staged item a reference names. */
        fun incomingUri(ref: String): IncomingUri {
            val key = ref.removePrefix(PREFIX)
            // Only the key is compared by `IncomingUri.equals`, and the staged
            // share checks membership against its own set — so a reference the
            // share does not hold is refused there rather than opened here.
            return IncomingUri(key = key, scheme = null, authority = null, encodedAuthority = null)
        }
    }
}
