package com.relayium.android.transport

import com.relayium.protocol.Json
import com.relayium.protocol.JoinInput
import com.relayium.protocol.PairCode
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

/**
 * The ICE servers the room's own server hands out, as PURE DATA.
 *
 * `org.webrtc` types are deliberately absent so this parses and tests on a
 * plain JVM; the transport maps [Server] to `PeerConnection.IceServer`.
 *
 * `/api/ice` is anonymous — the pairing code is the capability — and it may
 * legitimately answer with no TURN at all (`relayDenied`). The fallback for
 * every failure is an EMPTY list, never a public STUN default: a default
 * third-party server would turn each failed fetch into a silent report of this
 * device's address and session timing to someone else, and a local-network link
 * works from host candidates alone.
 */
object IceConfig {

    data class Server(val urls: List<String>, val username: String?, val credential: String?)

    data class Result(
        val servers: List<Server>,
        /** The server's machine-readable refusal, or "" — never rendered. */
        val relayDenied: String,
    )

    /** The whole ICE exchange is a small JSON document; anything bigger is not
     *  an answer, and reading it unboundedly hands the server a memory lever. */
    private const val MAX_BODY_BYTES = 64L * 1024

    /** One bounded, CANCELLABLE call.
     *
     *  The shared client keeps `readTimeout=0` for its WebSocket; this call gets
     *  its own deadline, and cancelling the coroutine cancels the OkHttp call —
     *  a server that accepts and never answers can neither hold the join
     *  forever nor leak a hung socket into the next session. */
    suspend fun fetch(
        http: OkHttpClient,
        origin: String,
        /** Null asks for the code-less room's configuration, which is what the
         *  Web client requests for Nearby. Having no TURN there is the normal,
         *  correct state rather than a denial. */
        code: PairCode?,
        timeoutSeconds: Long = 10,
    ): Result {
        val bounded = http.newBuilder()
            .callTimeout(timeoutSeconds, TimeUnit.SECONDS)
            .readTimeout(timeoutSeconds, TimeUnit.SECONDS)
            .build()
        val call = bounded.newCall(Request.Builder().url(iceUrl(origin, code)).build())
        return suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (continuation.isActive) continuation.resume(Result(emptyList(), ""))
                }

                override fun onResponse(call: Call, response: Response) {
                    val result = response.use {
                        if (!it.isSuccessful) {
                            Result(emptyList(), "")
                        } else {
                            val body = runCatching {
                                it.peekBody(MAX_BODY_BYTES).string()
                            }.getOrDefault("")
                            parse(body)
                        }
                    }
                    if (continuation.isActive) continuation.resume(result)
                }
            })
        }
    }

    /** `/api/ice?code=…` for a pairing room, `/api/ice` for the code-less one —
     *  the same split `web/src/lib/ice.ts` makes on an empty code. */
    internal fun iceUrl(origin: String, code: PairCode?): String =
        if (code != null) JoinInput.iceUrl(origin, code) else "$origin/api/ice"

    internal fun parse(body: String): Result {
        val root = Json.parseOrNull(body) as? Json.Obj ?: return Result(emptyList(), "")
        val denied = (root["relayDenied"] as? Json.Str)?.value.orEmpty()
        val list = (root["iceServers"] as? Json.Arr)?.items ?: return Result(emptyList(), denied)
        val servers = list.mapNotNull { entry ->
            val o = entry as? Json.Obj ?: return@mapNotNull null
            val urls = when (val u = o["urls"]) {
                is Json.Str -> listOf(u.value)
                is Json.Arr -> u.items.mapNotNull { (it as? Json.Str)?.value }
                else -> emptyList()
            }
            if (urls.isEmpty()) return@mapNotNull null
            Server(
                urls = urls,
                username = (o["username"] as? Json.Str)?.value,
                credential = (o["credential"] as? Json.Str)?.value,
            )
        }
        return Result(servers, denied)
    }
}
