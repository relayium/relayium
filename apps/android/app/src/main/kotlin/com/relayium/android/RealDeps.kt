package com.relayium.android

import android.content.Context
import android.net.Uri
import com.relayium.android.nearby.ConnectionSource
import com.relayium.android.nearby.LocalPeerAdvertisement
import com.relayium.android.nearby.LocalPeerSignalingChannel
import com.relayium.android.nearby.NsdLocalPeerTransport
import com.relayium.android.storage.ProviderOps
import com.relayium.android.storage.ReceiveStore
import com.relayium.android.transport.IceConfig
import com.relayium.android.transport.LinkTransport
import com.relayium.android.transport.SignalingClient
import com.relayium.android.update.UpdateSource
import com.relayium.protocol.LinkProtocol
import com.relayium.protocol.PairCode
import java.io.File

/**
 * The one place Android types meet the controller: real OkHttp signalling and
 * ICE, real WebRTC transport, real `NsdManager` discovery, real SAF provider —
 * assembled here so [TransferController] itself stays JVM-testable.
 */
object RealDeps {

    fun create(context: Context, origin: String, deviceName: String): Pair<TransferController.Deps, ProviderOps.Saf> {
        val app = context.applicationContext
        val http = SignalingClient.httpClient()
        val saf = ProviderOps.Saf(app)
        val deps = TransferController.Deps(
            fetchIce = { source -> fetchIce(http, origin, source) },
            signals = { source, events -> signaling(app, http, origin, deviceName, source, events) },
            transports = { profile, servers, executor, send, events ->
                LinkTransport(app, profile, servers, executor, send, events)
            },
            store = ReceiveStore(File(app.cacheDir, "incoming")),
            providerOps = saf,
        )
        return deps to saf
    }

    /**
     * ICE credentials for the rooms that have a server, and a REFUSAL for the
     * one that does not.
     *
     * The controller already skips this call for a direct source. The check is
     * repeated here because the two fences answer to different readers: the
     * controller's states an intent, and this one is what a future edit to the
     * controller would have to get past. "This path makes no network request"
     * is the whole claim of the local link, so it is worth two.
     */
    private suspend fun fetchIce(
        http: okhttp3.OkHttpClient,
        origin: String,
        source: ConnectionSource,
    ): IceConfig.Result {
        if (!source.usesBackend) return IceConfig.Result(emptyList(), "")
        return IceConfig.fetch(http, origin, codeOf(source))
    }

    /**
     * The rendezvous each source actually uses.
     *
     * All three hand back the SAME `SignalingHandle` seam, which is what lets
     * the controller's admission rules, capability registry and handshake be one
     * implementation rather than three:
     *
     *  - a pairing code and the code-less hub room are both the product's
     *    WebSocket, differing only in whether the URL carries a code;
     *  - the local link has no server at all. Bonjour supplies the roster and
     *    direct TCP carries the addressed envelopes, behind the same seam.
     */
    private fun signaling(
        context: Context,
        http: okhttp3.OkHttpClient,
        origin: String,
        deviceName: String,
        source: ConnectionSource,
        events: SignalingClient.Events,
    ) = when (source) {
        is ConnectionSource.Pairing, ConnectionSource.Hub ->
            SignalingClient(http, origin, codeOf(source), deviceName, events)

        ConnectionSource.Direct -> {
            val advertisement = LocalPeerAdvertisement(
                // Per CHANNEL, so browsing does not broadcast a durable
                // installation handle that anything on the link could follow
                // between sessions.
                identity = LocalPeerAdvertisement.mintIdentity(),
                name = LocalPeerAdvertisement.sanitizeName(deviceName),
                // What this build ACTUALLY implements, read from the same list
                // the roster hello is composed from. A TXT record that promised
                // a wire the routing predicate then refused would invite peers
                // into an establishment that cannot open.
                capabilities = LinkProtocol.ADVERTISED_CAPS,
            )
            LocalPeerSignalingChannel(
                advertisement = advertisement,
                transport = NsdLocalPeerTransport(context),
                events = events,
            )
        }
    }

    /** Null is the code-less room. See [SignalingClient.webSocketUrl]. */
    private fun codeOf(source: ConnectionSource): PairCode? =
        (source as? ConnectionSource.Pairing)?.code

    /** The folder-picker result, resolved at the seam the controller consumes. */
    fun resolveTree(saf: ProviderOps.Saf, tree: Uri): ProviderOps.Node? = saf.openTree(tree)

    /**
     * The real update-feed reader.
     *
     * Its own OkHttp client, NOT the signalling one: that client is built for a
     * WebSocket and carries `readTimeout(0)`, so an origin that accepted the
     * connection and then said nothing would hang the update check with no
     * deadline at all. See [UpdateSource.defaultClient].
     */
    fun updateSource(): UpdateSource = UpdateSource(
        userAgent = "Relayium-Android/${BuildConfig.VERSION_NAME} (update-check)",
    )
}
