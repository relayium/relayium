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

    /**
     * How many `relays` entries the no-selection fallback folds in.
     *
     * Positional, and applied to the RAW array before any entry is parsed, so a
     * response padded with malformed entries cannot promote a ninth real one
     * into view. It bounds what a hostile or broken `/api/ice` can make this
     * client do, since each entry costs a TURN allocation during ICE. Same
     * number, and the same reasoning, as `RelaySelection.maxFallbackRelays`
     * (Swift) and `MAX_FALLBACK_RELAYS` in `web/src/lib/ice.ts`.
     */
    private const val MAX_FALLBACK_RELAYS = 8

    /**
     * Read `/api/ice`'s answer: the top-level list, then the relay pool folded
     * in behind it.
     *
     * ## Why the pool is read at all
     *
     * `server/account/turn.go` puts the legacy single TURN in the top level
     * ONLY when the code's owner is non-strict and a fleet secret is
     * configured; the owner's own self-hosted nodes always go in `relays`
     * instead. A client that reads only the top level therefore resolves
     * STUN-only for exactly the rooms whose credential was issued in the pool —
     * an own-nodes ("only my nodes") owner most of all. The peer meanwhile
     * folds the same pool in and, because the merged list then contains TURN,
     * builds relay-only. One side then holds a relay the other cannot see: the
     * room was issued a working credential, and on a network that needs one to
     * pair — a hard NAT on either side — the transfer can fail anyway.
     *
     * ## The shape it mirrors
     *
     * `RelaySelection.resolve(config, chosen: nil)` on Apple: the top-level list
     * first, then each of the first [MAX_FALLBACK_RELAYS] entries' own
     * `iceServers` appended in order. This client makes no CHOICE — it runs no
     * relay RTT negotiation — so the no-selection fallback is the whole of what
     * it needs, and the merged list is what a connection is built from.
     *
     * ## What it deliberately does not do
     *
     * No transport policy is decided here and no external STUN is ever
     * invented: every entry returned came from this server's answer, and the
     * fallback for anything unreadable stays the empty list. Malformed pool
     * data is skipped per entry rather than rejecting the response, so a bad
     * relay row can never cost the caller a valid top-level credential —
     * deliberately unlike the Apple decoder, which is all-or-nothing.
     */
    internal fun parse(body: String): Result {
        val root = Json.parseOrNull(body) as? Json.Obj ?: return Result(emptyList(), "")
        val denied = (root["relayDenied"] as? Json.Str)?.value.orEmpty()
        // Missing, null or non-array is an absent top level, NOT an absent
        // answer: the pool below may still carry the credential this room was
        // issued, and returning early here is what lost it.
        val top = parseServers(root["iceServers"])
        val pool = (root["relays"] as? Json.Arr)?.items.orEmpty()
            .take(MAX_FALLBACK_RELAYS)
            .flatMap { entry -> parseServers((entry as? Json.Obj)?.get("iceServers")) }
        // Exact duplicates only — same urls, same username, same credential.
        // The pool legitimately repeats a top-level entry when one machine is
        // offered under both, and probing it twice buys nothing. First
        // occurrence wins, so a valid top-level entry is never the one dropped.
        val servers = (top + pool).distinctBy { Triple(it.urls, it.username, it.credential) }
        return Result(servers, denied)
    }

    /** One `iceServers` list, from wherever it appeared. Anything that is not a
     *  usable entry — a non-object, or one with no readable URL — is skipped
     *  rather than failing its neighbours. */
    private fun parseServers(value: Json?): List<Server> {
        val list = (value as? Json.Arr)?.items ?: return emptyList()
        return list.mapNotNull { entry ->
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
    }
}
