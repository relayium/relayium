package com.relayium.android.integration

import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject

/**
 * The Apple endpoint's control API, and the receipts it will answer with.
 *
 * ## Why the TEST drives the peer rather than the shell
 *
 * Every receiving leg has an ordering requirement the shell cannot express: the
 * app must be foreground and actually LISTENING before the Mac sends, or an
 * `AUTO` delivery is being asserted against a device that was not yet receiving.
 * A shell that started the instrumentation and then sent would be racing it, and
 * the fix — a sleep — turns a deterministic gate into a probabilistic one.
 *
 * The emulator reaches a host process bound to loopback at `10.0.2.2`, which is
 * the same alias the app's own origin uses. So the barrier lives where the
 * precondition is observable: the test waits for the product's own `LISTENING`,
 * then issues the send, then waits for the product's own receipt.
 *
 * ## Nothing here can print a credential
 *
 * The control bearer arrives from [LiveFixture] and is written only into a
 * request header. It is never interpolated into a URL, a message, or a report,
 * and [fail] names the command and the status — never the body it sent and never
 * the header it set.
 */
internal class HostInboxLiveDriver(
    private val baseUrl: String,
    private val controlToken: String,
) {

    /** Issue one `/drive` command and return the peer's answer. */
    fun drive(command: String, body: Map<String, Any?> = emptyMap()): JSONObject {
        val payload = JSONObject(body.toMutableMap().apply { put("command", command) })
        val answer = post("/drive", payload.toString(), command)
        if (answer.has("error")) {
            error("the endpoint refused '$command': ${answer.getString("error")}")
        }
        return answer
    }

    /** The endpoint's live view of itself. */
    fun observed(): JSONObject = get("/observed")

    /**
     * Wait until the endpoint's own view satisfies [predicate].
     *
     * Polls `/observed` rather than sleeping, because every fact this lane
     * compares is one the peer publishes. Reports the LAST snapshot's shape on
     * timeout — key names and counts only — so a failure says which side was
     * behind without printing a body.
     */
    fun awaitObserved(
        what: String,
        timeoutMs: Long = 120_000,
        poke: (() -> Unit)? = null,
        predicate: (JSONObject) -> Boolean,
    ): JSONObject {
        val deadline = System.currentTimeMillis() + timeoutMs
        var last: JSONObject? = null
        while (System.currentTimeMillis() < deadline) {
            // Asked again each round, when the caller says the answer only
            // changes because something asked. A delivery lands in `/observed`
            // on its own, but the account's DEVICE LIST is re-read only when
            // `refreshTargets` runs — so a device that had not published its key
            // at the first ask is correctly reported as unable to receive, and
            // polling a stale answer would wait out the whole timeout. This is
            // the same rule the macOS suite's `await_target` follows.
            poke?.invoke()
            val snapshot = observed()
            last = snapshot
            if (predicate(snapshot)) return snapshot
            Thread.sleep(POLL_MS)
        }
        error("$what: the endpoint never reached it within ${timeoutMs}ms; ${shape(last)}")
    }

    /**
     * A summary safe to put in a failure message.
     *
     * Counts and key names, never a value: an `/observed` document carries
     * device names, conversation bodies and received file names, and a timeout
     * message is exactly the artifact that gets attached to a report.
     */
    private fun shape(snapshot: JSONObject?): String {
        if (snapshot == null) return "no snapshot was read"
        val parts = ArrayList<String>()
        for (key in snapshot.keys()) {
            when (val value = snapshot.opt(key)) {
                is JSONArray -> parts += "$key[${value.length()}]"
                else -> parts += key
            }
        }
        return "last snapshot: ${parts.sorted().joinToString(",")}"
    }

    private fun post(path: String, body: String, what: String): JSONObject {
        val connection = open(path)
        connection.requestMethod = "POST"
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/json")
        connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        return read(connection, what)
    }

    private fun get(path: String): JSONObject {
        val connection = open(path)
        connection.requestMethod = "GET"
        return read(connection, path)
    }

    private fun open(path: String): HttpURLConnection =
        (URL("$baseUrl$path").openConnection() as HttpURLConnection).apply {
            // The peer's own main-actor budget is 10s; sit outside it so a
            // peer-side timeout arrives as its own status rather than as a
            // client abort that cannot say whose it was.
            connectTimeout = 20_000
            readTimeout = 25_000
            setRequestProperty("Authorization", "Bearer $controlToken")
        }

    private fun read(connection: HttpURLConnection, what: String): JSONObject {
        val status = connection.responseCode
        val text = if (status in 200..299) {
            connection.inputStream.bufferedReader().use { it.readText() }
        } else {
            // Drained and DISCARDED. An error body from a control API is the one
            // place a token echo or an account detail could reach a log.
            runCatching { connection.errorStream?.bufferedReader()?.use { it.readText() } }
            error("the endpoint answered $status to '$what'")
        }
        connection.disconnect()
        return JSONObject(text)
    }

    companion object {
        private const val POLL_MS = 500L

        /**
         * The receipts the peer stated for a batch it sent, as a comparable map.
         *
         * Keyed by the path when there is one and the name when there is not,
         * which is the same identity the receiver's own walk produces — so a
         * delivery that flattened a tree fails on the KEY rather than slipping
         * through a name-only comparison.
         */
        fun receipts(answer: JSONObject): Map<String, Receipt> {
            val out = LinkedHashMap<String, Receipt>()
            val array = answer.optJSONArray("receipts") ?: JSONArray()
            for (i in 0 until array.length()) {
                val row = array.getJSONObject(i)
                val receipt = Receipt(
                    name = row.getString("name"),
                    path = row.optString("path", "").ifEmpty { null },
                    size = row.getLong("size"),
                    sha256 = row.getString("sha256"),
                )
                out[receipt.key] = receipt
            }
            return out
        }

        /**
         * Every file under [root], read back OFF DISK.
         *
         * Not out of the product's own metadata, for the reason the macOS
         * endpoint states about its own walk: a receiver that recorded a
         * delivery it never committed would produce a perfect receipt list. The
         * digest here is computed from bytes that are actually on the device.
         */
        fun walk(root: File): Map<String, Receipt> {
            val out = LinkedHashMap<String, Receipt>()
            if (!root.isDirectory) return out
            root.walkTopDown().filter { it.isFile }.forEach { file ->
                val relative = file.relativeTo(root).path
                val receipt = Receipt(
                    name = file.name,
                    path = if (relative.contains(File.separatorChar)) relative else null,
                    size = file.length(),
                    sha256 = sha256(file.readBytes()),
                )
                out[receipt.key] = receipt
            }
            return out
        }

        /**
         * The delivered files ONLY — the commit receipt excluded.
         *
         * `InboxCommit.RECEIPT_NAME` is written into the staged tree after every
         * file has been written and digested, so a faithful walk of a committed
         * delivery contains one entry the sender never sent. Comparing that walk
         * against the sender's receipts fails on an extra the product is
         * supposed to produce.
         *
         * **Exactly the root-level receipt, and nothing else.** The key is
         * compared for equality, not tested for a leading dot: `key` is the
         * relative path, so `.relayium-delivery` matches only the marker at the
         * top of the delivery. A hidden file the USER sent — `.env`, or
         * `notes/.draft` — keeps a key containing a separator or a different
         * name and is still compared. A blanket hidden-file filter would hide
         * real payload, and dropping unexpected extras wholesale would defeat
         * the exact-set comparison this exists to serve.
         *
         * The name is taken from the product's own constant rather than copied,
         * so a rename cannot leave this silently filtering the wrong thing.
         * `InboxDestinationPlan` records why a manifest may never produce that
         * name at the top level, which is what makes this exclusion safe.
         */
        fun payload(root: File): Map<String, Receipt> =
            walk(root).filterKeys { it != com.relayium.android.inbox.InboxCommit.RECEIPT_NAME }

        /** True when the delivery carries its commit receipt. */
        fun isCommitted(root: File): Boolean =
            walk(root).containsKey(com.relayium.android.inbox.InboxCommit.RECEIPT_NAME)

        fun sha256(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(bytes)
                .joinToString("") { "%02x".format(it) }
    }

    /**
     * One file, as either side describes it.
     *
     * [path] is null for a file that landed loose, matching the peer's own
     * convention exactly so the two maps are comparable without translation.
     */
    data class Receipt(
        val name: String,
        val path: String?,
        val size: Long,
        val sha256: String,
    ) {
        val key: String get() = path ?: name
    }
}
