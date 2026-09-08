package com.relayium.android.inbox

import com.relayium.protocol.inbox.InboxManifest
import com.relayium.protocol.inbox.InboxManifestKind
import com.relayium.protocol.inbox.InboxManifestV3
import com.relayium.protocol.stored.BytesSource
import com.relayium.protocol.stored.ChunkEncryptor
import com.relayium.protocol.stored.PlaintextSource
import com.relayium.protocol.stored.generateStoreKey
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

/**
 * Turning what a person chose to send into a durable job.
 *
 * Everything that makes a delivery reproducible is written down HERE, before
 * anything reaches the network: the content key, the sealed manifest, the framed
 * ciphertext and its identity, and the idempotency key that will name the task.
 * After this, a send is a retryable durable record rather than an in-flight
 * intention — which is what lets a later process finish it byte for byte.
 *
 * ## Staged, never auto-sent
 *
 * Preparation does NOT deliver. A share arriving from another app produces a
 * staged job and nothing else; the person still chooses the destination and
 * still confirms. Nothing here reaches [InboxSendCoordinator], and nothing here
 * needs a target to be online.
 *
 * ## The caller owns the sources
 *
 * [PlaintextSource]s are read, not closed: this does not own a descriptor a
 * caller opened, and closing one at a moment the caller cannot predict is how a
 * content-provider read fails in a way nobody can explain. The caller closes
 * them, including on cancellation — and cancellation here leaves a job that is
 * simply not prepared, which the store refuses to upload.
 */
class InboxSendPreparer(
    private val store: InboxSendStore,
    private val nowSeconds: () -> Long,
    private val newId: () -> String,
) {

    /**
     * Stage a FILE delivery.
     *
     * The manifest is built from what the sources declare, and the ciphertext is
     * framed with the same stored-wire encoder the cloud path uses — so the
     * recipient decodes one format whichever surface sent it.
     */
    suspend fun stageFiles(
        targetDeviceId: String,
        sources: List<PlaintextSource>,
    ): InboxSendJob {
        require(sources.isNotEmpty()) { "a delivery names at least one file" }
        val manifest = InboxManifest.files(sources.map { it.name to it.size })
        return stage(targetDeviceId, manifest, sources, InboxManifestKind.FILE)
    }

    /**
     * Stage a TEXT delivery.
     *
     * A real text record end to end: the manifest says `text`, and the receiver
     * commits it to its message store rather than writing a `.txt` file. The
     * bytes are the message's own UTF-8, so what the recipient reads is exactly
     * what was typed.
     */
    suspend fun stageText(targetDeviceId: String, text: String): InboxSendJob {
        val bytes = text.toByteArray(Charsets.UTF_8)
        require(bytes.size >= InboxManifest.MIN_TEXT_BYTES) { "an empty message is not a message" }
        require(bytes.size <= InboxManifest.MAX_TEXT_BYTES) { "the message exceeds the protocol bound" }
        return stage(
            targetDeviceId,
            InboxManifest.text(bytes.size.toLong()),
            listOf(BytesSource("message", bytes)),
            InboxManifestKind.TEXT,
        )
    }

    private suspend fun stage(
        targetDeviceId: String,
        manifest: InboxManifestV3,
        sources: List<PlaintextSource>,
        kind: InboxManifestKind,
    ): InboxSendJob {
        currentCoroutineContext().ensureActive()
        // Refused before a key is generated: a manifest this protocol cannot
        // carry is not a delivery, and finding out later would leave a staged
        // job nothing can send.
        InboxManifest.validate(manifest)

        val jobId = InboxId.checked(newId(), "jobId")
        val contentKey = generateStoreKey()
        try {
            // The key first. Without it the ciphertext below cannot be described
            // to anyone, so a crash between the two must leave a job that is
            // simply unprepared rather than one holding unopenable bytes.
            store.saveContentKey(jobId, contentKey)
            store.saveEncManifest(jobId, InboxManifest.seal(contentKey, manifest))

            val job = store.save(
                InboxSendJob(
                    jobId = jobId,
                    targetDeviceId = InboxId.checked(targetDeviceId, "targetDeviceId"),
                    // Minted ONCE, here, and never again for this job: it is the
                    // identity central converges a repeated create on.
                    idempotencyKey = newId(),
                    kind = kind,
                    files = if (kind == InboxManifestKind.FILE) {
                        manifest.items.map { requireNotNull(it.name) to it.size }
                    } else {
                        emptyList()
                    },
                    totalBytes = manifest.items.sumOf { it.size },
                    createdAt = nowSeconds(),
                ),
                nowSeconds(),
            )

            // The framed ciphertext, and its identity bound as it is written.
            return store.prepareSpool(job, nowSeconds()) { out ->
                ChunkEncryptor(contentKey, sources).use { encryptor ->
                    while (true) {
                        currentCoroutineContext().ensureActive()
                        val frame = encryptor.next() ?: break
                        out.write(frame)
                    }
                    encryptor.finish()
                }
            }
        } catch (e: CancellationException) {
            // A cancelled preparation leaves at most an unprepared job, which
            // the uploader refuses. Nothing partial can be sent.
            throw e
        } finally {
            contentKey.fill(0)
        }
    }
}
