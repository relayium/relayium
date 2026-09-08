package com.relayium.android.cloud

/**
 * Splits the one continuous plaintext stream of a stored download back into
 * files.
 *
 * The wire has no separator between files: `stored/1` is a single framed stream
 * whose chunk boundaries have nothing to do with file boundaries, and the ONLY
 * thing that says where one file ends is the size the manifest committed to. A
 * 192 KiB chunk can therefore finish one file, contain another whole one, and
 * start a third.
 *
 * Two consequences this routes around, both of which produce silently wrong
 * files if missed:
 *
 * * **A zero-byte file never appears in the stream at all.** It contributes no
 *   frame, so it has to be completed on the way past — including when it is the
 *   first entry, the last entry, or several in a row.
 * * **A chunk that spans a boundary must be split**, not attributed to whichever
 *   file happened to be current.
 *
 * The sink reports failure rather than throwing, and any `false` stops the
 * routing immediately: a receive store that could not write is not a store to
 * keep feeding.
 */
class StoredStreamRouter(private val sizes: List<Long>) {

    /** The destination for routed bytes — in practice the receive store. */
    interface Sink {
        /** Append plaintext to the file at [index]. False if it could not. */
        fun write(index: Int, bytes: ByteArray): Boolean

        /** Every byte of [index] has been written and verified. False if the
         *  file could not be finished. */
        fun complete(index: Int): Boolean
    }

    private var index = 0
    private var writtenToCurrent = 0L

    /** True once every file has been written and completed. */
    val done: Boolean get() = index >= sizes.size

    /**
     * Route one plaintext chunk. False means the sink failed, or the stream
     * carried more bytes than the manifest declared — which the frame decoder's
     * own total check would also catch, but not before these bytes had been
     * written to the user's folder.
     */
    fun accept(chunk: ByteArray, sink: Sink): Boolean {
        var offset = 0
        while (offset < chunk.size) {
            if (!skipEmpty(sink)) return false
            if (index >= sizes.size) return false     // more bytes than promised
            val remaining = sizes[index] - writtenToCurrent
            val take = minOf(remaining, (chunk.size - offset).toLong()).toInt()
            if (take > 0) {
                if (!sink.write(index, chunk.copyOfRange(offset, offset + take))) return false
                writtenToCurrent += take
                offset += take
            }
            if (writtenToCurrent == sizes[index]) {
                if (!sink.complete(index)) return false
                index += 1
                writtenToCurrent = 0
            }
        }
        return true
    }

    /**
     * End of stream: complete any trailing zero-byte files.
     *
     * Returns false if the stream ended before the manifest's files were
     * delivered. The frame decoder rejects a short stream on its own total, so
     * this is the second of two independent checks rather than the only one.
     */
    fun finish(sink: Sink): Boolean {
        if (!skipEmpty(sink)) return false
        return done
    }

    private fun skipEmpty(sink: Sink): Boolean {
        while (index < sizes.size && sizes[index] == 0L && writtenToCurrent == 0L) {
            if (!sink.complete(index)) return false
            index += 1
        }
        return true
    }
}
