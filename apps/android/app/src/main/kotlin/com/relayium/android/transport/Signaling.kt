package com.relayium.android.transport

import com.relayium.protocol.Envelope
import com.relayium.protocol.Json
import com.relayium.protocol.JoinInput
import com.relayium.protocol.PairCode
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * The rendezvous WebSocket, per `docs/protocol/relayium-signaling-v1.md`.
 *
 * Transport only. Everything inside `data` is opaque here and is classified by
 * the protocol module, which is what keeps this class free of any knowledge
 * about generations, capabilities or the handshake.
 */
class SignalingClient(
    private val http: OkHttpClient,
    private val origin: String,
    private val code: PairCode,
    private val deviceName: String,
    private val events: Events,
) : SignalingHandle {

    interface Events {
        /** `welcome`: this connection's own peer id, and the server-observed IP. */
        fun onSelfId(id: String, ip: String)
        /** A roster. An ABSENT array means EMPTY, never "no change". */
        fun onPeers(peers: List<Envelope.Peer>)
        /** The server confirmed one physical peer connection closed. */
        fun onPeerLeft(peerId: String)
        /** One opaque payload from one peer. */
        fun onSignal(from: String, data: Json)
        /** The socket ended. `code` is the WebSocket close code, or -1. */
        fun onClosed(code: Int, reason: String)
        fun onFailure(error: Throwable)
    }

    private var socket: WebSocket? = null

    override fun connect() {
        val request = Request.Builder()
            .url(JoinInput.webSocketUrl(origin, code))
            .build()
        socket = http.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    // Send through the CALLBACK's socket: the `socket` field is
                    // assigned on the caller's thread after newWebSocket returns
                    // and this callback can run first, which would silently drop
                    // the join. The join carries a display name and NOTHING
                    // else — `deviceId`/`active` are LAN-room presence fields a
                    // pairing room ignores.
                    runCatching { webSocket.send(Json.stringify(Envelope.join(deviceName).toJson())) }
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    // A malformed or non-object frame is DROPPED, never thrown:
                    // this runs on OkHttp's reader thread and an exception here
                    // takes the whole socket down for a frame nobody needed.
                    val envelope = Envelope.fromJson(text) ?: return
                    when (envelope.type) {
                        "welcome" -> events.onSelfId(envelope.name.orEmpty(), envelope.ip.orEmpty())
                        "peers" -> events.onPeers(envelope.peers ?: emptyList())
                        "left" -> envelope.peer?.let(events::onPeerLeft)
                        "signal" -> {
                            val from = envelope.from ?: return
                            val data = envelope.data ?: return
                            events.onSignal(from, data)
                        }
                        else -> Unit
                    }
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    events.onClosed(code, reason)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    events.onFailure(t)
                }
            },
        )
    }

    /** Best effort, and deliberately so: a signalling frame lost during a
     *  reconnect is realigned by the join/welcome/peers exchange, and throwing
     *  from a fire-and-forget UI path would be worse than dropping one. */
    override fun sendSignal(to: String, data: Json) {
        send(Envelope.signal(to, data))
    }

    private fun send(envelope: Envelope) {
        val text = Json.stringify(envelope.toJson())
        runCatching { socket?.send(text) }
    }

    override fun close() {
        runCatching { socket?.close(NORMAL_CLOSURE, null) }
        socket = null
    }

    companion object {
        private const val NORMAL_CLOSURE = 1000

        /**
         * One client for the whole app.
         *
         * No cookie jar and no credential store: this client is anonymous by
         * construction, which is what "join-only, no account" means at the HTTP
         * layer rather than only in the UI.
         */
        fun httpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS) // a WebSocket has no read deadline
            .writeTimeout(15, TimeUnit.SECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }
}
