package com.relayium.android

import android.content.Context
import android.net.Uri
import com.relayium.android.storage.ProviderOps
import com.relayium.android.storage.ReceiveStore
import com.relayium.android.transport.IceConfig
import com.relayium.android.transport.LinkTransport
import com.relayium.android.transport.SignalingClient
import com.relayium.android.update.UpdateSource
import com.relayium.protocol.PairCode
import java.io.File

/**
 * The one place Android types meet the controller: real OkHttp signalling and
 * ICE, real WebRTC transport, real SAF provider — assembled here so
 * [TransferController] itself stays JVM-testable.
 */
object RealDeps {

    fun create(context: Context, origin: String, deviceName: String): Pair<TransferController.Deps, ProviderOps.Saf> {
        val app = context.applicationContext
        val http = SignalingClient.httpClient()
        val saf = ProviderOps.Saf(app)
        val deps = TransferController.Deps(
            fetchIce = { code: PairCode -> IceConfig.fetch(http, origin, code) },
            signals = { code, events -> SignalingClient(http, origin, code, deviceName, events) },
            transports = { profile, servers, executor, send, events ->
                LinkTransport(app, profile, servers, executor, send, events)
            },
            store = ReceiveStore(File(app.cacheDir, "incoming")),
            providerOps = saf,
        )
        return deps to saf
    }

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
