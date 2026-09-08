package com.relayium.android.account

import kotlinx.coroutines.CompletableDeferred

/**
 * A transport whose every answer — and every DELAY — the test chooses.
 *
 * The delay is the point. Nearly all of the behaviour worth asserting about the
 * account layer is what happens when a response lands after the user has moved
 * on, and that is unreachable through a stub that answers instantly: the
 * interesting orderings only exist while a request is in flight. [hold] parks a
 * path until the test releases it, which is what lets a sign-out land in the
 * middle of a sign-in.
 */
class FakeTransport : AccountTransport {

    /** Every request, in order — the method and path only; see the asserts on
     *  [bearers] for credentials, which are never printed. */
    val calls = mutableListOf<String>()

    /** The bearer presented on each call, index-aligned with [calls]. */
    val bearers = mutableListOf<String?>()

    private val answers = mutableMapOf<String, TransportResult>()
    private val gates = mutableMapOf<String, CompletableDeferred<Unit>>()

    /**
     * How [path] answers from now on, REPLACING whatever it answered before.
     *
     * Replacement rather than a queue, because that is what the tests actually
     * express: "the network is down" and then "the network is back" are two
     * states of one endpoint, not two queued responses. A queue makes the second
     * call re-consume the first entry when the first call happened before it was
     * added, which is a fake with its own bug in it.
     */
    fun answer(path: String, status: Int, body: String) = apply {
        answers[path] = TransportResult.Answered(AccountResponse(status, body))
    }

    fun fail(path: String, why: TransportResult.Failure) = apply {
        answers[path] = TransportResult.Failed(why)
    }

    /** Park every call to [path] until [release] is called for it. */
    fun hold(path: String) = apply { gates[path] = CompletableDeferred() }

    fun release(path: String) {
        gates.remove(path)?.complete(Unit)
    }

    override suspend fun send(request: AccountRequest): TransportResult {
        calls += "${request.method} ${request.path}"
        bearers += request.bearer
        gates[request.path]?.await()
        return answers[request.path] ?: TransportResult.Answered(AccountResponse(404, ""))
    }
}

/** A store whose failures are the test's to choose. */
class FlakyTokenStore(
    private var token: String? = null,
    var failSave: Boolean = false,
    var failLoad: Boolean = false,
    var failClear: Boolean = false,
) : TokenStore {
    var saved: String? = token
        private set
    var clears = 0
        private set

    override fun save(token: String) {
        if (failSave) throw TokenStoreException("save refused by the test")
        this.token = token
        saved = token
    }

    override fun load(): String? {
        if (failLoad) throw TokenStoreException("load refused by the test")
        return token
    }

    override fun clear() {
        clears += 1
        if (failClear) throw TokenStoreException("clear refused by the test")
        token = null
        saved = null
    }
}

/** The `/api/me` body, with only the fields this client reads. */
fun meBody(id: String = "acct-1", email: String = "a@example.invalid"): String =
    """{"user":{"id":"$id","email":"$email","displayName":"A","emailVerified":true,""" +
        """"planId":"free","linkedMethods":["password"]}}"""

fun usageBody(trafficCap: Long = 1000L): String =
    """{"resetsAt":1900000000,"plan":{"name":"Free"},""" +
        """"traffic":{"used":10,"cap":$trafficCap},"storage":{"used":0,"cap":0}}"""

fun loginBody(token: String = "rlm_cli_aaaa"): String =
    """{"token":"$token","user":{"id":"acct-1","email":"a@example.invalid"}}"""

fun devicesBody(vararg rows: String): String = """{"devices":[${rows.joinToString(",")}]}"""

fun deviceRow(id: String, name: String = "Phone", current: Boolean = false): String =
    """{"ID":"$id","UserID":"u","Name":"$name","CreatedAt":1,"LastSeenAt":2,""" +
        """"LastIP":"","Kind":"app","Current":$current,"Inbox":null}"""
