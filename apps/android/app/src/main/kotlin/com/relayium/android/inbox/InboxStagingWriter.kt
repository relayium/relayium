package com.relayium.android.inbox

import com.relayium.android.cloud.DurableFiles
import com.relayium.protocol.inbox.InboxManifest
import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest

/**
 * Where a delivery's decrypted payload goes while it is still unproven.
 *
 * Two implementations, and the split is the file/message boundary itself: a file
 * tree is staged on disk, while a message is held in memory and never touches
 * the received container at all. The streaming loop is written against this
 * interface so neither kind can acquire the other's obligations by accident —
 * there is no way to reach a staging directory from the message path, because
 * the message path never has one.
 */
internal interface InboxPayloadSink : Closeable {

    /** One run of authenticated plaintext, in delivery order. */
    fun write(plaintext: ByteArray)

    /** The stream ended. Flush and make durable whatever the writes left. */
    fun finish()

    /**
     * Prove what was written matches what the manifest declared.
     *
     * Called after the whole authenticated stream has been consumed and before
     * anything is published. The sink's own accounting could be wrong; what it
     * actually wrote cannot be, and this is the last chance to notice.
     */
    fun verifyDelivered()
}

/**
 * Fans decrypted plaintext across the staged files, in plan order.
 *
 * The manifest is the ONLY source of per-file boundaries — the ciphertext stream
 * carries none — so the declared sizes are consumed exactly. A stream delivering
 * more data than the manifest accounts for is refused rather than spilling into
 * the next file or creating one.
 *
 * The SHA-256 of each file is computed as it is written, so the receipt that
 * proves authorship at publication time costs no extra read of the data.
 */
internal class InboxStagingWriter(
    private val staging: File,
    private val plan: List<InboxPlanEntry>,
    private val files: DurableFiles,
) : InboxPayloadSink {

    private val digests = LinkedHashMap<String, String>()
    private var index = 0
    private var current: FileOutputStream? = null
    private var currentDigest: MessageDigest? = null
    private var remaining = 0L

    /** Name to lowercase hex SHA-256, in plan order. Complete only after
     *  [finish]. */
    val fileDigests: Map<String, String> get() = digests

    override fun write(plaintext: ByteArray) {
        var offset = 0
        while (offset < plaintext.size) {
            val sink = openNext()
                // Every declared byte is spoken for, so anything further is the
                // sender contradicting its own manifest.
                ?: throw InboxFailure.terminal(
                    com.relayium.protocol.inbox.InboxDeviceErrorCode.VERIFY_FAILED,
                    InboxFailure.Reason.STAGED_SIZE_MISMATCH,
                )
            val take = minOf((plaintext.size - offset).toLong(), remaining).toInt()
            try {
                sink.write(plaintext, offset, take)
            } catch (e: IOException) {
                throw storage(e)
            }
            currentDigest?.update(plaintext, offset, take)
            offset += take
            remaining -= take
            if (remaining == 0L) closeCurrent()
        }
    }

    override fun finish() {
        closeCurrent()
        // A manifest may declare a zero-length file, and a stream carrying no
        // bytes for it must still produce one: the delivery is what the manifest
        // described, not only the parts that happened to have content.
        while (index < plan.size) {
            openNext() ?: break
            if (remaining == 0L) closeCurrent()
        }
    }

    override fun verifyDelivered() {
        for (entry in plan) {
            val file = File(staging, entry.name)
            if (!file.isFile || file.length() != entry.size) {
                throw InboxFailure.retryable(
                    com.relayium.protocol.inbox.InboxDeviceErrorCode.VERIFY_FAILED,
                    InboxFailure.Reason.STAGED_SIZE_MISMATCH,
                )
            }
            if (digests[entry.name] == null) {
                throw InboxFailure.retryable(
                    com.relayium.protocol.inbox.InboxDeviceErrorCode.VERIFY_FAILED,
                    InboxFailure.Reason.STAGED_SIZE_MISMATCH,
                )
            }
        }
    }

    override fun close() {
        try {
            current?.close()
        } catch (_: IOException) {
            // Abandoning the stage; the failure that brought us here is the one
            // worth reporting.
        }
        current = null
        currentDigest = null
    }

    /** Open the next planned file, or null when the plan is exhausted. */
    private fun openNext(): FileOutputStream? {
        current?.let { return it }
        if (index >= plan.size) return null
        val entry = plan[index]
        val file = File(staging, entry.name)
        try {
            file.parentFile?.let { files.createDirectories(it) }
            val stream = FileOutputStream(file, false)
            current = stream
            currentDigest = MessageDigest.getInstance("SHA-256")
            remaining = entry.size
            return stream
        } catch (e: IOException) {
            throw storage(e)
        }
    }

    /** Finish the current file: flush, fsync, record its digest, advance. */
    private fun closeCurrent() {
        val stream = current ?: return
        val entry = plan[index]
        try {
            // Durable before publication even looks at it: the rename that
            // publishes this tree must not outrun the bytes inside it.
            files.syncStream(stream)
            stream.close()
        } catch (e: IOException) {
            throw storage(e)
        }
        digests[entry.name] = currentDigest!!.digest().joinToString("") { "%02x".format(it) }
        current = null
        currentDigest = null
        index += 1
    }

    private fun storage(e: IOException): InboxFailure {
        val message = e.message.orEmpty().lowercase()
        return when {
            message.contains("space left") || message.contains("enospc") ->
                InboxFailure.attention(
                    com.relayium.protocol.inbox.InboxDeviceErrorCode.DISK_FULL,
                    InboxFailure.Reason.NOT_ENOUGH_SPACE,
                )
            message.contains("permission") || message.contains("denied") ->
                InboxFailure.attention(
                    com.relayium.protocol.inbox.InboxDeviceErrorCode.PERMISSION_DENIED,
                    InboxFailure.Reason.DIRECTORY_UNAVAILABLE,
                )
            else -> InboxFailure.retryable(
                com.relayium.protocol.inbox.InboxDeviceErrorCode.INTERNAL,
                InboxFailure.Reason.UNEXPECTED,
            )
        }
    }
}

/**
 * Collects one message in memory, bounded by its declared length.
 *
 * In memory because the protocol bounds a message at 64 KiB precisely so a
 * receiver can do this rather than build a second staging path — and because a
 * message that never reaches a temporary file is one a crash cannot leave behind
 * in the user's container.
 */
internal class InboxMessageBuffer(private val declared: Int) : InboxPayloadSink {

    private val bytes = java.io.ByteArrayOutputStream(
        declared.coerceIn(0, InboxManifest.MAX_TEXT_BYTES.toInt()),
    )

    /**
     * Refuses the first byte past the declared length rather than growing.
     *
     * The stream is authenticated, so an over-long one is a sender contradicting
     * its own manifest — and an unbounded append here would be a memory
     * exhaustion any sender could ask for.
     */
    override fun write(plaintext: ByteArray) {
        if (bytes.size() + plaintext.size > declared) {
            throw InboxFailure.terminal(
                com.relayium.protocol.inbox.InboxDeviceErrorCode.VERIFY_FAILED,
                InboxFailure.Reason.MESSAGE_MALFORMED,
            )
        }
        bytes.write(plaintext)
    }

    override fun finish() {}

    override fun verifyDelivered() {
        if (bytes.size() != declared) {
            throw InboxFailure.retryable(
                com.relayium.protocol.inbox.InboxDeviceErrorCode.VERIFY_FAILED,
                InboxFailure.Reason.STAGED_SIZE_MISMATCH,
            )
        }
    }

    override fun close() {}

    /**
     * The message, or null if these bytes are not exactly one valid UTF-8 string
     * of the declared length.
     *
     * The re-encode is not belt and braces. Kotlin's `String(bytes, UTF_8)`
     * REPLACES an invalid sequence with U+FFFD rather than failing, so the round
     * trip is what proves the bytes were text: a repaired string would re-encode
     * to something different, and the user would otherwise be shown words nobody
     * wrote.
     */
    fun message(): String? {
        val raw = bytes.toByteArray()
        if (raw.size != declared) return null
        val text = String(raw, Charsets.UTF_8)
        return if (text.toByteArray(Charsets.UTF_8).contentEquals(raw)) text else null
    }
}
