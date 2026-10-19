package com.relayium.android.cloud

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OrderedUploadPipelineTest {
    private fun pipeline(
        total: Long = 12,
        read: suspend (Long, ByteArray, Int) -> Unit = { _, _, _ -> },
        send: suspend (Long, ByteArray, Int, () -> Unit) -> UploadOffset,
        status: suspend () -> Long = { error("unexpected status") },
        owns: () -> Boolean = { true },
        progress: (Long) -> Unit = {},
    ) = OrderedUploadPipeline(total, 4, read, send, status, owns, progress)

    @Test
    fun `body completion starts only one successor and cumulative ack cannot retire live owner`() = runBlocking {
        withTimeout(5_000) {
            val both = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            var active = 0
            var peak = 0
            var reads = 0
            val progress = mutableListOf<Long>()
            val task = async {
                pipeline(total = 8, read = { _, _, _ -> reads++ }, send = { at, _, _, sent ->
                    active++; peak = maxOf(peak, active)
                    try {
                        sent()
                        if (at == 0L) { both.await(); UploadOffset(8, false) }
                        else if (at == 4L) { both.complete(Unit); release.await(); UploadOffset(8, false) }
                        else UploadOffset(12, false)
                    } finally { active-- }
                }, progress = { progress.add(it) }).run(0)
            }
            both.await()
            // Sentinel runs after the first request's cumulative answer.
            kotlinx.coroutines.yield()
            assertEquals(2, reads)
            assertEquals(1, active)
            assertTrue(!task.isCompleted)
            release.complete(Unit)
            assertEquals(8L, task.await())
            assertEquals(2, peak)
            assertEquals(0, active)
            assertEquals(listOf(8L, 8L), progress)
        }
    }

    @Test
    fun `cancel joins both owners before spool may close`() = runBlocking {
        withTimeout(5_000) {
            val both = CompletableDeferred<Unit>()
            var active = 0
            var closed = 0
            var probes = 0
            val task = launch {
                pipeline(send = { _, _, _, sent ->
                    active++
                    try {
                        sent()
                        if (active == 2) both.complete(Unit)
                        awaitCancellation()
                    } finally { active--; closed++ }
                }, status = { probes++; 0 }).run(0)
            }
            both.await(); task.cancelAndJoin()
            assertEquals(0, active); assertEquals(2, closed); assertEquals(0, probes)
        }
    }

    @Test
    fun `gap drains successor before authoritative probe and returns same session replay offset`() = runBlocking {
        withTimeout(5_000) {
            val both = CompletableDeferred<Unit>()
            var active = 0
            var probes = 0
            val offset = pipeline(send = { at, _, _, sent ->
                active++
                try {
                    sent()
                    if (at == 0L) { both.await(); UploadOffset(2, false) }
                    else { both.complete(Unit); awaitCancellation() }
                } finally { active-- }
            }, status = { assertEquals(0, active); probes++; 2 }).run(0)
            assertEquals(2L, offset); assertEquals(1, probes)
        }
    }

    @Test
    fun `lost answer without body callback does not hang and probes once after drain`() = runBlocking {
        withTimeout(5_000) {
            var active = 0
            var probes = 0
            val offset = pipeline(send = { _, _, _, _ ->
                active++
                try { throw CloudException(CloudFailure(CloudFailure.Kind.STORAGE_UNAVAILABLE)) }
                finally { active-- }
            }, status = { assertEquals(0, active); probes++; 4 }).run(0)
            assertEquals(4L, offset); assertEquals(1, probes)
        }
    }

    @Test
    fun `ack beyond offered ciphertext is refused without probing or finishing`() = runBlocking {
        withTimeout(5_000) {
            var failed = false
            try {
                pipeline(send = { _, _, _, _ -> UploadOffset(12, false) }).run(0)
            } catch (e: CloudException) {
                assertEquals(CloudFailure.Kind.MALFORMED, e.failure.kind); failed = true
            }
            assertTrue(failed)
        }
    }

    @Test
    fun `account leaving during spool read sends no bearer`() = runBlocking {
        var current = true
        var sends = 0
        assertEquals(0L, pipeline(read = { _, _, _ -> current = false },
            send = { _, _, _, _ -> sends++; UploadOffset(4, false) }, owns = { current }).run(0))
        assertEquals(0, sends)
    }
}
