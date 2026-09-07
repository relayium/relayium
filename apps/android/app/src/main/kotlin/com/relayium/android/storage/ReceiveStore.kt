package com.relayium.android.storage

import com.relayium.protocol.FileMeta
import com.relayium.protocol.Filename
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * Stage privately, verify, then export.
 *
 * ## The obligations, made structural
 *
 * 1. **An ACK is a durability claim.** Bytes are flushed AND fsync'd to a
 *    private file before the byte count that produces an ACK moves.
 * 2. **Nothing partial is ever presented as saved.** A document in the user's
 *    tree is created only for a file whose chained digest verified, and a copy
 *    that fails at ANY provider step deletes what that step created.
 * 3. **Cleanup is a LEDGER, not a search.** Every identity this batch creates
 *    in the user's tree — directories included — is recorded AT creation,
 *    classified there as file or directory, and rollback walks exactly the
 *    ledger, children before parents. Nothing pre-existing is ever touched, and
 *    a directory this batch reused (it already existed) is never deleted.
 *    Ledgered FILES are deleted; ledgered DIRECTORIES are deleted only through
 *    [ProviderOps.deleteEmptyDirectory], whose generic-SAF answer is "cannot" —
 *    so on a real device a rolled-back batch leaves its created (empty apart
 *    from anything the user added) directories standing and the outcome reports
 *    the cleanup incomplete. That is deliberate: the alternative is a recursive
 *    provider delete that can take a user's own file with it.
 *
 * Staging lives in a per-batch directory under [stagingRoot]; anything else
 * found under that root at [begin] is an orphan of an earlier process
 * incarnation and is removed then.
 *
 * NOT thread-safe by itself: the controller confines every call to its storage
 * executor.
 */
open class ReceiveStore(
    private val stagingRoot: File,
    private val io: FileIo = FileIo.Real,
) {

    /** Local staging effects. Injectable so write/fsync/close failures are
     *  exercised, not asserted. Provider effects are [ProviderOps]. */
    interface FileIo {
        interface Sink {
            fun append(bytes: ByteArray)
            /** Flush AND fsync this descriptor. */
            fun sync()
            fun close()
        }

        fun open(target: File): Sink

        object Real : FileIo {
            override fun open(target: File): Sink = object : Sink {
                private val out = FileOutputStream(target, true)
                override fun append(bytes: ByteArray) = out.write(bytes)
                override fun sync() {
                    out.flush()
                    out.fd.sync()
                }
                override fun close() = out.close()
            }
        }
    }

    sealed interface Outcome {
        data object Ok : Outcome
        data class Failed(val reason: Reason, val cleanupComplete: Boolean = true) : Outcome
        enum class Reason { NO_SPACE, WRITE_FAILED, EXPORT_FAILED, UNSAFE_PATH, NAME_TAKEN }
    }

    private var batchDir: File? = null
    private var batchCounter = 0
    private val staged = LinkedHashMap<Int, File>()
    private val sinks = HashMap<Int, FileIo.Sink>()
    private var files: List<FileMeta> = emptyList()
    private var ops: ProviderOps? = null
    private var root: ProviderOps.Node? = null

    /** One ledgered creation. The file/directory classification is fixed HERE,
     *  at creation, because a later metadata query on a failing provider could
     *  misreport a directory as a file and hand it to a recursive delete. */
    private class Created(val node: ProviderOps.Node, val isDirectory: Boolean)

    /** Every node this batch CREATED in the user's tree, in creation order —
     *  parents before children — so rollback walks it in reverse. */
    private val created = ArrayList<Created>()

    /**
     * A cleanup somewhere in this store's life finished incomplete and has not
     * been surfaced yet. SESSION-level, deliberately outside any batch
     * generation: the leftover is real whichever batch is current, and the
     * generation fences that protect new batches from old completions were
     * silently eating exactly this warning.
     */
    @Volatile
    var unresolvedCleanup: Boolean = false
        protected set

    /** Read-and-clear, so the UI surfaces the warning exactly once. */
    fun consumeCleanupWarning(): Boolean {
        val was = unresolvedCleanup
        unresolvedCleanup = false
        return was
    }

    /** Directories this batch created, keyed by their path segments, so two
     *  files sharing a new folder create it once and own it once. */
    private val createdDirs = HashMap<List<String>, ProviderOps.Node>()

    /**
     * Prepare for one accepted batch.
     *
     * Every path is resolved and every staging file — INCLUDING zero-byte ones,
     * which will never see a [write] — is created before the first frame, so an
     * unsafe layout or a full disk refuses while the user can still be told.
     */
    open fun begin(files: List<FileMeta>, ops: ProviderOps, root: ProviderOps.Node): Outcome {
        // A defensive re-discard. Its RESULT is kept, not erased: leftovers a
        // previous batch could not remove are still leftovers, and the flag
        // below is how the session surfaces them exactly once.
        if (discard() is Outcome.Failed) unresolvedCleanup = true
        // The root must EXIST before its free space means anything: on a fresh
        // install `usableSpace` of a missing directory is 0, which read as
        // "no space" for the very first one-byte file.
        if (!stagingRoot.isDirectory && !stagingRoot.mkdirs()) {
            return Outcome.Failed(Outcome.Reason.WRITE_FAILED)
        }
        // Orphans of an earlier process incarnation share nothing with this
        // batch and are unowned by anything live; remove them now.
        stagingRoot.listFiles()?.forEach { it.deleteRecursively() }

        this.files = files
        this.ops = ops
        this.root = root
        for (file in files) {
            if (Filename.resolveRelativePath(file.path, file.name) is Filename.PathVerdict.Refuse) {
                return Outcome.Failed(Outcome.Reason.UNSAFE_PATH)
            }
        }
        val total = files.sumOf { it.size }
        // Staged plus the exported copy: refusing up front beats filling the
        // device on the last file. `usableSpace` (not StorageManager's
        // allocatable bytes) is deliberate: this class stays JVM-testable, the
        // check is a conservative refusal rather than an allocation, and
        // clearable-cache headroom the platform might free is not space this
        // app should plan to consume.
        @Suppress("UsableSpace")
        if (stagingRoot.usableSpace < total * 2) return Outcome.Failed(Outcome.Reason.NO_SPACE)

        val dir = File(stagingRoot, "batch-${batchCounter++}")
        if (!dir.mkdirs() && !dir.isDirectory) return Outcome.Failed(Outcome.Reason.WRITE_FAILED)
        batchDir = dir
        return try {
            for (index in files.indices) {
                val target = File(dir, "$index.part")
                target.delete()
                if (!target.createNewFile()) return Outcome.Failed(Outcome.Reason.WRITE_FAILED)
                staged[index] = target
            }
            Outcome.Ok
        } catch (_: IOException) {
            Outcome.Failed(Outcome.Reason.WRITE_FAILED)
        }
    }

    /** Append verified-in-sequence plaintext, then fsync. The caller may only
     *  advance its ACK after this returns [Outcome.Ok]. */
    open fun write(index: Int, bytes: ByteArray): Outcome {
        val target = staged[index] ?: return Outcome.Failed(Outcome.Reason.WRITE_FAILED)
        return try {
            val sink = sinks.getOrPut(index) { io.open(target) }
            sink.append(bytes)
            sink.sync()
            Outcome.Ok
        } catch (_: IOException) {
            Outcome.Failed(Outcome.Reason.WRITE_FAILED)
        }
    }

    /**
     * Move one VERIFIED file into the user's tree.
     *
     * Ledger-first: the directory or document node enters [created] the moment
     * the provider hands it back, BEFORE anything is written into it, so a
     * failure at any later step — including a throw from the provider itself —
     * still leaves every created identity reachable by [discard].
     *
     * A name that already exists is a refusal, never an overwrite. A provider
     * that AUTO-RENAMED the document did not give the user the file the sender
     * named, so the renamed document is deleted and the export refused rather
     * than silently claimed.
     */
    open fun export(index: Int): Outcome {
        val meta = files.getOrNull(index) ?: return Outcome.Failed(Outcome.Reason.EXPORT_FAILED)
        val source = staged[index] ?: return Outcome.Failed(Outcome.Reason.EXPORT_FAILED)
        val provider = ops ?: return Outcome.Failed(Outcome.Reason.EXPORT_FAILED)
        val tree = root ?: return Outcome.Failed(Outcome.Reason.EXPORT_FAILED)
        val verdict = Filename.resolveRelativePath(meta.path, meta.name) as? Filename.PathVerdict.Accept
            ?: return Outcome.Failed(Outcome.Reason.UNSAFE_PATH)

        // Close the staging sink before the copy reads the file back. A close
        // that THROWS is a failed export: the descriptor's state is unknown and
        // pretending otherwise would copy a file we cannot vouch for.
        val sink = sinks.remove(index)
        if (sink != null && runCatching { sink.close() }.isFailure) {
            return Outcome.Failed(Outcome.Reason.EXPORT_FAILED)
        }

        return try {
            var dir = tree
            val walked = ArrayList<String>(verdict.segments.size)
            for (segment in verdict.segments) {
                walked.add(segment)
                val owned = createdDirs[walked.toList()]
                if (owned != null) {
                    dir = owned
                    continue
                }
                val existing = provider.findChild(dir, segment)
                dir = when {
                    existing != null && existing.isDirectory -> existing // reused, never owned
                    existing != null -> return Outcome.Failed(Outcome.Reason.NAME_TAKEN)
                    else -> {
                        val made = provider.createDirectory(dir, segment)
                            ?: return Outcome.Failed(Outcome.Reason.EXPORT_FAILED)
                        // Ledgered immediately AS a directory, and refused if
                        // renamed: a directory under a different name is a tree
                        // the sender did not describe.
                        created.add(Created(made, isDirectory = true))
                        if (made.name != segment) return Outcome.Failed(Outcome.Reason.EXPORT_FAILED)
                        createdDirs[walked.toList()] = made
                        made
                    }
                }
            }
            if (provider.findChild(dir, verdict.leaf) != null) {
                return Outcome.Failed(Outcome.Reason.NAME_TAKEN)
            }
            val document = provider.createFile(dir, verdict.leaf)
                ?: return Outcome.Failed(Outcome.Reason.EXPORT_FAILED)
            val entry = Created(document, isDirectory = false)
            created.add(entry) // ledgered BEFORE any byte is written
            if (document.name != verdict.leaf) {
                // Auto-renamed: delete OUR document and refuse — the requested
                // name was not delivered. The ledger entry leaves ONLY on a
                // CONFIRMED deletion; a delete that returns false or throws
                // keeps it, so the batch discard retries and, failing that,
                // reports the leftover instead of a falsely clean rollback.
                if (runCatching { document.delete() }.getOrDefault(false)) {
                    created.remove(entry)
                }
                return Outcome.Failed(Outcome.Reason.NAME_TAKEN)
            }
            document.openOut().use { out ->
                source.inputStream().use { it.copyTo(out) }
                out.flush()
                (out as? FileOutputStream)?.fd?.sync()
            }
            // Only a FULLY closed copy retires the staging.
            source.delete()
            staged.remove(index)
            Outcome.Ok
        } catch (failure: Exception) {
            // Any provider throw — SecurityException included — lands here with
            // every created identity already in the ledger. The half-written
            // document goes now; the rest waits for the batch-level discard.
            // The file/directory question is answered by the LEDGER, never by a
            // provider metadata query that can itself throw or misreport, and
            // the delete is guarded: a throw simply leaves the entry ledgered.
            val tail = created.lastOrNull()
            if (tail != null && !tail.isDirectory) {
                if (runCatching { tail.node.delete() }.getOrDefault(false)) {
                    created.remove(tail)
                }
            }
            Outcome.Failed(Outcome.Reason.EXPORT_FAILED)
        }
    }

    /**
     * Cancel or failure: remove what THIS BATCH created, and nothing else.
     *
     * Children before parents. Ledgered FILES are deleted. Ledgered DIRECTORIES
     * go only through [ProviderOps.deleteEmptyDirectory], which succeeds only
     * where the provider can refuse a non-empty directory ATOMICALLY — a
     * query-then-delete would be a window in which a recursive provider delete
     * destroys a user file added in between. Generic SAF has no such primitive,
     * so there a rolled-back batch LEAVES its created directories standing and
     * this returns `cleanupComplete = false`: a truthful leftover is the
     * accepted cost of never risking unowned data.
     */
    open fun discard(): Outcome {
        for (sink in sinks.values) runCatching { sink.close() }
        sinks.clear()
        batchDir?.let { runCatching { it.deleteRecursively() } }
        batchDir = null
        staged.clear()
        var complete = true
        val provider = ops
        for (entry in created.asReversed()) {
            val deleted = runCatching {
                if (entry.isDirectory) {
                    provider?.deleteEmptyDirectory(entry.node) == true
                } else {
                    entry.node.delete()
                }
            }.getOrDefault(false)
            if (!deleted) complete = false
        }
        created.clear()
        createdDirs.clear()
        files = emptyList()
        ops = null
        root = null
        return if (complete) {
            Outcome.Ok
        } else {
            unresolvedCleanup = true
            Outcome.Failed(Outcome.Reason.EXPORT_FAILED, cleanupComplete = false)
        }
    }

    /** A batch that completed: staging goes, EXPORTED DOCUMENTS STAY. */
    open fun finish() {
        for (sink in sinks.values) runCatching { sink.close() }
        sinks.clear()
        batchDir?.let { runCatching { it.deleteRecursively() } }
        batchDir = null
        staged.clear()
        created.clear()
        createdDirs.clear()
        files = emptyList()
        ops = null
        root = null
    }

    // Observability for tests that must prove cleanup really removed something.
    val stagedCount: Int get() = staged.size
    val ledgerSize: Int get() = created.size
}
