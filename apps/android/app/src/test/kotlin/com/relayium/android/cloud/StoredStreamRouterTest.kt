package com.relayium.android.cloud

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Splitting one continuous stream back into files.
 *
 * The cases here are the ones where the stream and the file boundaries
 * disagree, because those are the ones that produce silently WRONG files rather
 * than an error: a zero-byte file that never appears on the wire at all, and a
 * chunk that spans a boundary.
 */
class StoredStreamRouterTest {

    private class Recorder : StoredStreamRouter.Sink {
        val written = LinkedHashMap<Int, ByteArray>()
        val completed = ArrayList<Int>()
        var failWriteAt: Int? = null
        var failCompleteAt: Int? = null

        override fun write(index: Int, bytes: ByteArray): Boolean {
            if (failWriteAt == index) return false
            written[index] = (written[index] ?: ByteArray(0)) + bytes
            return true
        }

        override fun complete(index: Int): Boolean {
            if (failCompleteAt == index) return false
            completed.add(index)
            return true
        }
    }

    private fun route(sizes: List<Long>, chunks: List<ByteArray>, sink: Recorder): Boolean {
        val router = StoredStreamRouter(sizes)
        for (chunk in chunks) if (!router.accept(chunk, sink)) return false
        return router.finish(sink)
    }

    @Test
    fun `a chunk spanning a boundary is split, not attributed to one file`() {
        val sink = Recorder()
        assertTrue(route(listOf(3L, 2L), listOf("abcde".toByteArray()), sink))
        assertEquals("abc", String(sink.written.getValue(0)))
        assertEquals("de", String(sink.written.getValue(1)))
        assertEquals(listOf(0, 1), sink.completed)
    }

    @Test
    fun `a file split across many chunks is reassembled in order`() {
        val sink = Recorder()
        assertTrue(route(listOf(5L), listOf("a".toByteArray(), "bc".toByteArray(), "de".toByteArray()), sink))
        assertEquals("abcde", String(sink.written.getValue(0)))
        assertEquals(listOf(0), sink.completed)
    }

    @Test
    fun `a zero-byte file completes without ever appearing on the wire`() {
        // It contributes no frame, so nothing will arrive for it. Waiting for
        // bytes that cannot come would strand the whole batch.
        val sink = Recorder()
        assertTrue(route(listOf(0L), emptyList(), sink))
        assertEquals(listOf(0), sink.completed)
        assertTrue(sink.written.isEmpty())
    }

    @Test
    fun `zero-byte files at the start, middle and end all complete`() {
        val sink = Recorder()
        assertTrue(route(listOf(0L, 2L, 0L, 0L, 1L, 0L), listOf("abc".toByteArray()), sink))
        assertEquals(listOf(0, 1, 2, 3, 4, 5), sink.completed)
        assertEquals("ab", String(sink.written.getValue(1)))
        assertEquals("c", String(sink.written.getValue(4)))
    }

    @Test
    fun `a stream that ends early does not report success`() {
        val sink = Recorder()
        assertFalse(route(listOf(3L, 3L), listOf("abc".toByteArray()), sink))
        assertEquals(listOf(0), sink.completed)
    }

    @Test
    fun `more bytes than the manifest promised are refused`() {
        val sink = Recorder()
        assertFalse(route(listOf(2L), listOf("abcd".toByteArray()), sink))
    }

    @Test
    fun `a sink that fails stops the routing immediately`() {
        val sink = Recorder()
        sink.failWriteAt = 1
        assertFalse(route(listOf(2L, 2L), listOf("abcd".toByteArray()), sink))
        // Nothing after the failure is written: a store that could not write is
        // not one to keep feeding.
        assertFalse(sink.written.containsKey(1))

        val second = Recorder()
        second.failCompleteAt = 0
        assertFalse(route(listOf(2L, 2L), listOf("abcd".toByteArray()), second))
        assertFalse(second.written.containsKey(1))
    }
}
