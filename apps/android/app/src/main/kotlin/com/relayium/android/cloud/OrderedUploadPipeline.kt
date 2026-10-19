package com.relayium.android.cloud

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.withContext

/** Two immutable spool pages, ordered submission and durable-only progress.
 *
 * Runs on the model's owner dispatcher. Network callbacks only complete a
 * thread-safe signal; they never read account state. A page stays owned until
 * its request terminates, even if another response cumulatively accepts it.
 * Returning short means all owners have drained and serial replay is safe.
 */
internal class OrderedUploadPipeline(
    private val total: Long,
    private val chunkSize: Int,
    private val read: suspend (Long, ByteArray, Int) -> Unit,
    private val send: suspend (Long, ByteArray, Int, () -> Unit) -> UploadOffset,
    private val status: suspend () -> Long,
    private val owns: () -> Boolean,
    private val onConfirmed: (Long) -> Unit,
) {
    private class Part(
        val end: Long,
        val sent: CompletableDeferred<Unit>,
        val request: Deferred<UploadOffset>,
    )

    suspend fun run(from: Long): Long = supervisorScope {
        require(total >= from && from >= 0)
        require(chunkSize in 1..PendingUploadStore.MAX_CHUNK_SIZE)
        var submitted = from
        var confirmed = from
        val pending = ArrayDeque<Part>()
        suspend fun drain() {
            withContext(NonCancellable) {
                pending.forEach { it.request.cancel() }
                pending.forEach { it.request.join() }
                pending.clear()
            }
        }
        suspend fun start() {
            val at = submitted
            val length = minOf(chunkSize.toLong(), total - at).toInt()
            val bytes = ByteArray(length)
            read(at, bytes, length)
            currentCoroutineContext().ensureActive()
            if (!owns()) return
            val sent = CompletableDeferred<Unit>()
            val request = async { send(at, bytes, length) { sent.complete(Unit) } }
            submitted += length
            pending.addLast(Part(submitted, sent, request))
        }
        fun validate(offset: Long) {
            if (offset < 0 || offset > submitted) {
                throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
            }
        }
        try {
            while (confirmed < total || pending.isNotEmpty()) {
                currentCoroutineContext().ensureActive()
                if (!owns()) return@supervisorScope confirmed
                if (pending.isEmpty()) start()
                if (pending.isEmpty()) return@supervisorScope confirmed
                val first = pending.first()
                // A failed or early response must win over a body signal that
                // will never arrive. Once two exist, await the oldest owner.
                if (pending.size == 1 && submitted < total) {
                    select<Unit> {
                        first.request.onAwait { }
                        first.sent.onAwait { }
                    }
                    if (first.sent.isCompleted && !first.request.isCompleted && owns()) start()
                }
                val answer = first.request.await()
                validate(answer.received)
                if (answer.conflict || answer.received < first.end) {
                    drain()
                    if (!owns()) return@supervisorScope confirmed
                    val offset = status()
                    validate(offset)
                    onConfirmed(maxOf(confirmed, offset))
                    return@supervisorScope offset
                }
                confirmed = maxOf(confirmed, answer.received)
                onConfirmed(confirmed)
                pending.removeFirst()
            }
            confirmed
        } catch (e: CancellationException) {
            throw e
        } catch (e: CloudException) {
            // Bad offsets are protocol violations, not permission to finalize.
            if (e.failure.kind == CloudFailure.Kind.MALFORMED) throw e
            drain()
            if (!owns()) return@supervisorScope confirmed
            val offset = status()
            validate(offset)
            onConfirmed(maxOf(confirmed, offset))
            offset
        } finally {
            drain()
        }
    }
}
