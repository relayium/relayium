package com.relayium.protocol

/**
 * One signalling frame's `data` payload, and the generation vocabulary that
 * keeps concurrent connections on one socket from reading each other's SDP.
 *
 * The rendezvous envelope itself (`join` / `welcome` / `peers` / `signal` /
 * `left`) is `docs/protocol/relayium-signaling-v1.md` and lives in [Envelope].
 */
data class Signal(
    val sdpType: String? = null,
    val sdp: String? = null,
    val candidate: String? = null,
    val sdpMid: String? = null,
    val sdpMLineIndex: Int? = null,
    val usernameFragment: String? = null,
    val commit: String? = null,
    val revealKey: String? = null,
    val revealNonce: String? = null,
    val caps: List<String>? = null,
    val auth: String? = null,
    val link: Boolean = false,
    val resume: Boolean = false,
    val text: Boolean = false,
    val linkRequest: Boolean = false,
    val busy: Boolean = false,
    val leave: Boolean = false,
) {

    /**
     * Which concurrent connection this signal belongs to.
     *
     * `resume` outranks `link`: a signal carrying both is a rebuild and never an
     * establishment.
     *
     * The vocabulary is deliberately WIDER than what this client can construct.
     * `FILE` is the untagged generation an older deployed peer still sends and
     * `TEXT` is the retired single-lane one; this client builds neither, but
     * must still be able to NAME them — a tag it could not classify would fall
     * through to `FILE` and be answered as a legacy transfer, which is the exact
     * failure the tags exist to prevent.
     */
    val generation: Generation
        get() = when {
            resume -> Generation.RESUME
            link -> Generation.LINK
            text -> Generation.TEXT
            else -> Generation.FILE
        }

    /** A fresh link offer: `link` generation, an SDP offer, not a rebuild. */
    val isLinkOffer: Boolean get() = generation == Generation.LINK && sdpType == "offer"

    /** The content-free ask. It carries NO sdp, and that absence is part of
     *  recognising it. */
    val isLinkRequest: Boolean get() = link && linkRequest && sdpType == null

    val isLinkBusy: Boolean get() = generation == Generation.LINK && busy

    fun toJson(): Json.Obj {
        val map = LinkedHashMap<String, Json>()
        if (sdpType != null && sdp != null) {
            map["sdp"] = Json.obj("type" to Json.of(sdpType), "sdp" to Json.of(sdp))
        }
        if (candidate != null || sdpMid != null || sdpMLineIndex != null || usernameFragment != null) {
            val ice = LinkedHashMap<String, Json>()
            candidate?.let { ice["candidate"] = Json.of(it) }
            sdpMid?.let { ice["sdpMid"] = Json.of(it) }
            sdpMLineIndex?.let { ice["sdpMLineIndex"] = Json.of(it.toLong()) }
            usernameFragment?.let { ice["usernameFragment"] = Json.of(it) }
            map["ice"] = Json.Obj(ice)
        }
        commit?.let { map["commit"] = Json.of(it) }
        if (revealKey != null && revealNonce != null) {
            map["reveal"] = Json.obj("key" to Json.of(revealKey), "nonce" to Json.of(revealNonce))
        }
        caps?.let { map["caps"] = Json.arr(it.map(Json::of)) }
        if (linkRequest) map["linkRequest"] = Json.of(true)
        if (busy) map["busy"] = Json.of(true)
        if (leave) map["leave"] = Json.of(true)
        auth?.let { map["auth"] = Json.of(it) }
        if (link) map["link"] = Json.of(true)
        if (resume) map["resume"] = Json.of(true)
        if (text) map["text"] = Json.of(true)
        return Json.Obj(map)
    }

    enum class Generation { FILE, RESUME, TEXT, LINK }

    companion object {

        /**
         * Read a peer-authored signal.
         *
         * Lenient about fields it does not understand and strict about the
         * shapes it does: a `caps` that is not an array is dropped rather than
         * coerced, a non-string capability entry is dropped rather than
         * stringified, and an `sdp` missing either half is not an SDP at all.
         * Nothing here throws — this runs inside a socket's receive loop.
         */
        fun fromJson(raw: Json?): Signal? {
            val obj = raw as? Json.Obj ?: return null
            val sdpObj = obj["sdp"] as? Json.Obj
            val ice = obj["ice"] as? Json.Obj
            val reveal = obj["reveal"] as? Json.Obj
            val sdpType = (sdpObj?.get("type") as? Json.Str)?.value
            val sdpText = (sdpObj?.get("sdp") as? Json.Str)?.value
            val mLine = (ice?.get("sdpMLineIndex") as? Json.Num)?.value
                ?.takeIf { it.isFinite() && it >= 0 && it <= Int.MAX_VALUE && it.toInt().toDouble() == it }
                ?.toInt()
            return Signal(
                sdpType = if (sdpType != null && sdpText != null) sdpType else null,
                sdp = if (sdpType != null && sdpText != null) sdpText else null,
                candidate = (ice?.get("candidate") as? Json.Str)?.value,
                sdpMid = (ice?.get("sdpMid") as? Json.Str)?.value,
                sdpMLineIndex = mLine,
                usernameFragment = (ice?.get("usernameFragment") as? Json.Str)?.value,
                commit = (obj["commit"] as? Json.Str)?.value,
                revealKey = (reveal?.get("key") as? Json.Str)?.value,
                revealNonce = (reveal?.get("nonce") as? Json.Str)?.value,
                caps = (obj["caps"] as? Json.Arr)?.items?.mapNotNull { (it as? Json.Str)?.value },
                auth = (obj["auth"] as? Json.Str)?.value,
                link = (obj["link"] as? Json.Bool)?.value == true,
                resume = (obj["resume"] as? Json.Bool)?.value == true,
                text = (obj["text"] as? Json.Bool)?.value == true,
                linkRequest = (obj["linkRequest"] as? Json.Bool)?.value == true,
                busy = (obj["busy"] as? Json.Bool)?.value == true,
                leave = (obj["leave"] as? Json.Bool)?.value == true,
            )
        }

        fun offer(sdp: String, commit: String, caps: List<String>) = Signal(
            sdpType = "offer", sdp = sdp, commit = commit, caps = caps, link = true,
        )

        fun answer(sdp: String, commit: String, caps: List<String>) = Signal(
            sdpType = "answer", sdp = sdp, commit = commit, caps = caps, link = true,
        )

        fun candidate(candidate: String, sdpMid: String?, sdpMLineIndex: Int?) = Signal(
            candidate = candidate, sdpMid = sdpMid, sdpMLineIndex = sdpMLineIndex, link = true,
        )

        fun reveal(key: String, nonce: String) = Signal(revealKey = key, revealNonce = nonce, link = true)

        fun linkRequest() = Signal(link = true, linkRequest = true)

        /** A busy MUST carry the generation of the exchange it refuses, or the
         *  initiator filters it out and waits out its own connect timeout. */
        fun busy() = Signal(link = true, busy = true)

        fun leave(auth: String) = Signal(link = true, leave = true, auth = auth)
    }
}

/**
 * The rendezvous envelope. Transport only; `data` is opaque to this layer.
 *
 * `relayium-signaling-v1.md`: the client NEVER sets `from` (the server stamps
 * it), and a `peers` frame with an ABSENT array means an EMPTY roster, never
 * "no change" — a client that treats absence as no-change leaves a departed
 * peer on screen forever.
 */
data class Envelope(
    val type: String,
    val from: String? = null,
    val to: String? = null,
    val name: String? = null,
    val ip: String? = null,
    val peers: List<Peer>? = null,
    val peer: String? = null,
    val data: Json? = null,
) {
    data class Peer(val id: String, val name: String)

    fun toJson(): Json.Obj {
        val map = LinkedHashMap<String, Json>()
        map["type"] = Json.of(type)
        to?.let { map["to"] = Json.of(it) }
        name?.let { map["name"] = Json.of(it) }
        data?.let { map["data"] = it }
        return Json.Obj(map)
    }

    companion object {
        /**
         * A malformed or non-object frame yields null rather than throwing out
         * of the receive loop. The server is trusted for rendezvous, but a
         * hostile or buggy frame must not crash the client's message loop.
         */
        fun fromJson(text: String): Envelope? {
            val obj = Json.parseOrNull(text) as? Json.Obj ?: return null
            val type = (obj["type"] as? Json.Str)?.value ?: return null
            val peersValue = obj["peers"]
            // An ABSENT array is an EMPTY roster. Only a present non-array is
            // "this frame is not telling us about the roster at all".
            val peers = when {
                type != "peers" -> null
                peersValue == null -> emptyList()
                peersValue is Json.Arr -> peersValue.items.mapNotNull { entry ->
                    val e = entry as? Json.Obj ?: return@mapNotNull null
                    val id = (e["id"] as? Json.Str)?.value ?: return@mapNotNull null
                    Envelope.Peer(id, (e["name"] as? Json.Str)?.value ?: "")
                }
                else -> emptyList()
            }
            return Envelope(
                type = type,
                from = (obj["from"] as? Json.Str)?.value,
                name = (obj["name"] as? Json.Str)?.value,
                ip = (obj["ip"] as? Json.Str)?.value,
                peers = peers,
                peer = (obj["peer"] as? Json.Str)?.value,
                data = obj["data"],
            )
        }

        fun join(name: String) = Envelope(type = "join", name = name)

        fun signal(to: String, data: Json) = Envelope(type = "signal", to = to, data = data)
    }
}
