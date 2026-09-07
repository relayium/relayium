package com.relayium.android

import com.relayium.android.storage.ProviderOps
import com.relayium.android.storage.ReceiveStore
import com.relayium.protocol.FileMeta
import java.io.File
import java.io.IOException
import java.io.OutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The staging/export ownership logic against a REAL filesystem.
 *
 * [FileNode] implements [ProviderOps] over `java.io.File`, so every create,
 * find, delete, write and rollback below actually happens on disk — the store's
 * decisions are exercised, not mirrored. Failure injection wraps the same real
 * operations and throws where a SAF provider would (SecurityException is not an
 * IOException, which is exactly the R11 point).
 */
class ReceiveStoreTest {

    @get:Rule
    val temp = TemporaryFolder()

    /**
     * A real-directory ProviderOps with the SHIPPED provider's semantics:
     * `FileSystemProvider.deleteDocument` deletes a directory's contents
     * RECURSIVELY before the directory itself, so `delete()` here does too, and
     * `deleteEmptyDirectory` keeps its conservative default — generic SAF has
     * no atomic empty-only delete, and a recursive-provider test implementing
     * one would be exactly the false green the independent probe demonstrated.
     */
    private open class FileOps : ProviderOps {
        /** Directory nodes handed to generic delete() — must stay ZERO. */
        var directoryDeletes = 0

        open inner class FileNode(val file: File) : ProviderOps.Node {
            override val name: String get() = file.name
            override val isDirectory: Boolean get() = file.isDirectory
            override fun delete(): Boolean {
                if (file.isDirectory) directoryDeletes++
                return file.deleteRecursively()
            }
            override fun openOut(): OutputStream = file.outputStream()
        }

        fun node(file: File): ProviderOps.Node = FileNode(file)

        override fun findChild(parent: ProviderOps.Node, name: String): ProviderOps.Node? {
            val child = File((parent as FileNode).file, name)
            return if (child.exists()) FileNode(child) else null
        }

        override fun createDirectory(parent: ProviderOps.Node, name: String): ProviderOps.Node? {
            val child = File((parent as FileNode).file, name)
            return if (child.mkdir()) FileNode(child) else null
        }

        override fun createFile(parent: ProviderOps.Node, name: String): ProviderOps.Node? {
            val child = File((parent as FileNode).file, name)
            return if (child.createNewFile()) FileNode(child) else null
        }
    }

    /**
     * A backend that genuinely CAN refuse a non-empty directory atomically —
     * POSIX rmdir semantics through `File.delete()`, which fails rather than
     * recurses — and therefore may offer the empty-only deletion the SAF
     * adapter must not claim.
     */
    private open class AtomicDirOps : FileOps() {
        override fun deleteEmptyDirectory(node: ProviderOps.Node): Boolean =
            (node as FileNode).file.delete()
    }

    private fun store(): Pair<ReceiveStore, File> {
        val staging = temp.newFolder("staging")
        return ReceiveStore(staging) to staging
    }

    private fun tree(): Pair<FileOps, File> {
        val ops = FileOps()
        val root = temp.newFolder("tree")
        return ops to root
    }

    private fun atomicTree(): Pair<AtomicDirOps, File> {
        val ops = AtomicDirOps()
        val root = temp.newFolder("tree-atomic")
        return ops to root
    }

    // ── the ordinary path, including the zero-byte file R11 names ───────────

    @Test
    fun `a batch with a zero-byte file stages, exports and finishes`() {
        val (store, _) = store()
        val (ops, rootDir) = tree()
        val files = listOf(FileMeta("empty.bin", 0), FileMeta("small.bin", 3))
        assertEquals(ReceiveStore.Outcome.Ok, store.begin(files, ops, ops.node(rootDir)))
        // The zero-byte entry gets NO write call — only DONE arrives for it —
        // and must still export.
        assertEquals(ReceiveStore.Outcome.Ok, store.write(1, byteArrayOf(1, 2, 3)))
        assertEquals(ReceiveStore.Outcome.Ok, store.export(0))
        assertEquals(ReceiveStore.Outcome.Ok, store.export(1))
        store.finish()
        assertEquals(0L, File(rootDir, "empty.bin").length())
        assertTrue(File(rootDir, "small.bin").readBytes().contentEquals(byteArrayOf(1, 2, 3)))
    }

    @Test
    fun `nested directories are created once, ledgered, and survive completion`() {
        val (store, _) = store()
        val (ops, rootDir) = tree()
        val files = listOf(
            FileMeta("a.bin", 1, path = "photos/2026/a.bin"),
            FileMeta("b.bin", 1, path = "photos/2026/b.bin"),
        )
        assertEquals(ReceiveStore.Outcome.Ok, store.begin(files, ops, ops.node(rootDir)))
        store.write(0, byteArrayOf(7))
        store.write(1, byteArrayOf(8))
        assertEquals(ReceiveStore.Outcome.Ok, store.export(0))
        assertEquals(ReceiveStore.Outcome.Ok, store.export(1))
        store.finish()
        assertTrue(File(rootDir, "photos/2026/a.bin").exists())
        assertTrue(File(rootDir, "photos/2026/b.bin").exists())
    }

    // ── rollback owns directories too, and only what this batch created ─────

    @Test
    fun `discard removes created files AND directories where the backend is atomic`() {
        // Full removal is only offered where deleteEmptyDirectory really is
        // atomic empty-only; rmdir semantics also prove children went first.
        val (store, _) = store()
        val (ops, rootDir) = atomicTree()
        val files = listOf(FileMeta("deep.bin", 1, path = "made/by/batch/deep.bin"))
        store.begin(files, ops, ops.node(rootDir))
        store.write(0, byteArrayOf(9))
        assertEquals(ReceiveStore.Outcome.Ok, store.export(0))
        assertTrue(File(rootDir, "made/by/batch/deep.bin").exists())
        assertEquals(ReceiveStore.Outcome.Ok, store.discard())
        assertFalse("the file goes", File(rootDir, "made/by/batch/deep.bin").exists())
        assertFalse("and so does every directory the batch created", File(rootDir, "made").exists())
    }

    @Test
    fun `discard never touches a pre-existing directory or a foreign file inside one`() {
        val (store, _) = store()
        val (ops, rootDir) = atomicTree()
        // The user already has photos/, with their own file in it.
        File(rootDir, "photos").mkdir()
        File(rootDir, "photos/mine.jpg").writeBytes(byteArrayOf(1))
        val files = listOf(FileMeta("new.bin", 1, path = "photos/incoming/new.bin"))
        store.begin(files, ops, ops.node(rootDir))
        store.write(0, byteArrayOf(2))
        assertEquals(ReceiveStore.Outcome.Ok, store.export(0))
        assertEquals(ReceiveStore.Outcome.Ok, store.discard())
        assertTrue("the user's directory survives", File(rootDir, "photos").isDirectory)
        assertTrue("and the user's file", File(rootDir, "photos/mine.jpg").exists())
        assertFalse("only the batch-created subtree went", File(rootDir, "photos/incoming").exists())
    }

    @Test
    fun `rollback under RECURSIVE provider semantics preserves an unowned child`() {
        // The independent probe's red case: with the shipped SAF behaviour a
        // ledger-driven delete() of the batch directory would have recursively
        // destroyed the user's file. The directory must never reach delete().
        val (store, _) = store()
        val (ops, rootDir) = tree()
        val files = listOf(FileMeta("x.bin", 1, path = "newdir/x.bin"))
        store.begin(files, ops, ops.node(rootDir))
        store.write(0, byteArrayOf(3))
        assertEquals(ReceiveStore.Outcome.Ok, store.export(0))
        // The user drops their own file into the batch-created directory.
        File(rootDir, "newdir/users-own.txt").writeBytes(byteArrayOf(4))
        val outcome = store.discard()
        assertTrue(
            "cleanup must report itself incomplete, not claim success",
            outcome is ReceiveStore.Outcome.Failed && !outcome.cleanupComplete,
        )
        assertTrue(
            "the user's file survives a provider whose directory delete is recursive",
            File(rootDir, "newdir/users-own.txt").exists(),
        )
        assertFalse("our document still went", File(rootDir, "newdir/x.bin").exists())
        assertEquals("no directory was ever handed to generic delete", 0, ops.directoryDeletes)
        assertTrue("the warning is latched for the session", store.unresolvedCleanup)
        assertTrue(store.consumeCleanupWarning())
        assertFalse("and consumed exactly once", store.consumeCleanupWarning())
    }

    @Test
    fun `a child appearing inside the query-then-delete window still survives`() {
        // The adversarial TOCTOU: the directory IS empty once our own document
        // went, and only then does the user's file appear — precisely where a
        // hasChildren-then-delete rollback would have recursively taken it.
        // Modelled deterministically: deleting our document plants an unrelated
        // file in its parent as a side effect.
        val rootDir = temp.newFolder("tree-race")
        val ops = object : FileOps() {
            override fun createFile(parent: ProviderOps.Node, name: String): ProviderOps.Node? {
                val real = super.createFile(parent, name) as FileNode? ?: return null
                val dir = real.file.parentFile
                return object : ProviderOps.Node by real {
                    override fun delete(): Boolean = real.delete().also {
                        File(dir, "raced-in.txt").writeBytes(byteArrayOf(9))
                    }
                }
            }
        }
        val (store, _) = store()
        store.begin(listOf(FileMeta("x.bin", 1, path = "newdir/x.bin")), ops, ops.node(rootDir))
        store.write(0, byteArrayOf(3))
        assertEquals(ReceiveStore.Outcome.Ok, store.export(0))
        val outcome = store.discard()
        assertTrue(
            "the raced-in child survives because no directory delete ever runs",
            File(rootDir, "newdir/raced-in.txt").exists(),
        )
        assertEquals(0, ops.directoryDeletes)
        assertTrue(outcome is ReceiveStore.Outcome.Failed && !outcome.cleanupComplete)
    }

    @Test
    fun `generic SAF rollback leaves created directories standing and says so`() {
        // No user interference at all: the honest tradeoff is that a
        // no-atomic-delete provider keeps its batch-created directories and the
        // outcome must NOT read Ok.
        val (store, _) = store()
        val (ops, rootDir) = tree()
        store.begin(listOf(FileMeta("x.bin", 1, path = "kept/x.bin")), ops, ops.node(rootDir))
        store.write(0, byteArrayOf(1))
        assertEquals(ReceiveStore.Outcome.Ok, store.export(0))
        val outcome = store.discard()
        assertFalse("our document went", File(rootDir, "kept/x.bin").exists())
        assertTrue("the directory stands", File(rootDir, "kept").isDirectory)
        assertTrue(
            "and the outcome reports the leftover instead of claiming clean",
            outcome is ReceiveStore.Outcome.Failed && !outcome.cleanupComplete,
        )
    }

    @Test
    fun `a renamed document whose delete fails stays a reported cleanup failure`() {
        // The probe's second red: rollback of the auto-renamed document fails,
        // and the old code removed its ledger entry anyway — discard then
        // reported a clean rollback with an orphan on disk.
        val rootDir = temp.newFolder("tree-rename-stuck")
        val ops = object : FileOps() {
            override fun createFile(parent: ProviderOps.Node, name: String): ProviderOps.Node? {
                val real = super.createFile(parent, "$name (1)") ?: return null
                return object : ProviderOps.Node by real {
                    override fun delete(): Boolean = false // the provider refuses
                }
            }
        }
        val (store, _) = store()
        store.begin(listOf(FileMeta("sent.txt", 0)), ops, ops.node(rootDir))
        assertTrue(store.export(0) is ReceiveStore.Outcome.Failed)
        assertTrue("the undeletable document is still on disk", File(rootDir, "sent.txt (1)").exists())
        val cleanup = store.discard()
        assertTrue(
            "an unremoved renamed document must remain a reported cleanup failure: $cleanup",
            cleanup is ReceiveStore.Outcome.Failed && !cleanup.cleanupComplete,
        )
    }

    @Test
    fun `a missing staging root is created, not read as a full disk`() {
        // The probe's third red: on a fresh install the root does not exist,
        // its usableSpace is 0, and the very first one-byte file was refused
        // NO_SPACE.
        val stage = File(temp.root, "new-incoming-root")
        assertFalse(stage.exists())
        val (ops, rootDir) = tree()
        assertEquals(
            ReceiveStore.Outcome.Ok,
            ReceiveStore(stage).begin(listOf(FileMeta("one.txt", 1)), ops, ops.node(rootDir)),
        )
    }

    @Test
    fun `a staging sink whose close throws fails the export truthfully`() {
        val staging = temp.newFolder("staging-badclose")
        val store = ReceiveStore(
            staging,
            io = object : ReceiveStore.FileIo {
                override fun open(target: File): ReceiveStore.FileIo.Sink =
                    object : ReceiveStore.FileIo.Sink {
                        private val real = ReceiveStore.FileIo.Real.open(target)
                        override fun append(bytes: ByteArray) = real.append(bytes)
                        override fun sync() = real.sync()
                        override fun close() = throw IOException("close failed")
                    }
            },
        )
        val (ops, rootDir) = tree()
        store.begin(listOf(FileMeta("f.bin", 1)), ops, ops.node(rootDir))
        store.write(0, byteArrayOf(1))
        assertTrue(
            "a descriptor whose close failed is not one to copy from",
            store.export(0) is ReceiveStore.Outcome.Failed,
        )
        assertFalse("nothing was claimed saved", File(rootDir, "f.bin").exists())
    }

    // ── provider failures beyond IOException ────────────────────────────────

    @Test
    fun `a SecurityException mid-copy still leaves every created identity in the ledger`() {
        val (store, _) = store()
        val rootDir = temp.newFolder("tree-sec")
        val ops = object : AtomicDirOps() {
            override fun createFile(parent: ProviderOps.Node, name: String): ProviderOps.Node? {
                val real = super.createFile(parent, name) ?: return null
                return object : ProviderOps.Node by real {
                    // The provider revokes access exactly when the copy starts —
                    // a SecurityException, which is NOT an IOException.
                    override fun openOut(): OutputStream = throw SecurityException("revoked")
                }
            }
        }
        val files = listOf(FileMeta("f.bin", 1, path = "sub/f.bin"))
        store.begin(files, ops, ops.node(rootDir))
        store.write(0, byteArrayOf(5))
        val outcome = store.export(0)
        assertTrue(outcome is ReceiveStore.Outcome.Failed)
        // The incomplete document was rolled back immediately; the created
        // directory is still ledgered and goes with the batch discard.
        assertFalse(File(rootDir, "sub/f.bin").exists())
        store.discard()
        assertFalse(File(rootDir, "sub").exists())
    }

    @Test
    fun `a throwing findChild is a truthful failure, not a crash or a false save`() {
        val (store, _) = store()
        val rootDir = temp.newFolder("tree-find")
        val ops = object : FileOps() {
            override fun findChild(parent: ProviderOps.Node, name: String): ProviderOps.Node? =
                throw SecurityException("provider gone")
        }
        val files = listOf(FileMeta("f.bin", 1))
        store.begin(files, ops, ops.node(rootDir))
        store.write(0, byteArrayOf(5))
        assertTrue(store.export(0) is ReceiveStore.Outcome.Failed)
        assertEquals("nothing was created, so nothing is ledgered", 0, store.ledgerSize)
    }

    @Test
    fun `an auto-renaming provider is refused and its document deleted`() {
        val (store, _) = store()
        val rootDir = temp.newFolder("tree-rename")
        val ops = object : FileOps() {
            override fun createFile(parent: ProviderOps.Node, name: String): ProviderOps.Node? {
                // The provider "helpfully" deduplicates the name.
                return super.createFile(parent, "$name (1)")
            }
        }
        val files = listOf(FileMeta("photo.jpg", 1))
        store.begin(files, ops, ops.node(rootDir))
        store.write(0, byteArrayOf(6))
        val outcome = store.export(0)
        assertTrue(
            "a renamed document is not the file the sender named",
            outcome is ReceiveStore.Outcome.Failed &&
                outcome.reason == ReceiveStore.Outcome.Reason.NAME_TAKEN,
        )
        assertFalse("the renamed document was rolled back", File(rootDir, "photo.jpg (1)").exists())
    }

    @Test
    fun `an existing file with the target name is a refusal that deletes nothing`() {
        val (store, _) = store()
        val (ops, rootDir) = tree()
        File(rootDir, "taken.bin").writeBytes(byteArrayOf(42))
        val files = listOf(FileMeta("taken.bin", 1))
        store.begin(files, ops, ops.node(rootDir))
        store.write(0, byteArrayOf(1))
        val outcome = store.export(0)
        assertTrue(
            outcome is ReceiveStore.Outcome.Failed &&
                outcome.reason == ReceiveStore.Outcome.Reason.NAME_TAKEN,
        )
        assertTrue("the user's file is untouched", File(rootDir, "taken.bin").readBytes().contentEquals(byteArrayOf(42)))
        store.discard()
        assertTrue(File(rootDir, "taken.bin").exists())
    }

    // ── staging ownership across process incarnations ───────────────────────

    @Test
    fun `orphaned staging from an earlier process is removed at begin`() {
        val staging = temp.newFolder("staging-orphans")
        // A previous incarnation died mid-batch.
        File(staging, "batch-0").mkdirs()
        File(staging, "batch-0/3.part").writeBytes(ByteArray(128))
        val store = ReceiveStore(staging)
        val (ops, rootDir) = tree()
        assertEquals(
            ReceiveStore.Outcome.Ok,
            store.begin(listOf(FileMeta("f.bin", 1)), ops, ops.node(rootDir)),
        )
        assertFalse("the orphan is gone", File(staging, "batch-0/3.part").exists())
    }

    @Test
    fun `a failing local sink is a write failure the ACK path can see`() {
        val staging = temp.newFolder("staging-badsink")
        val store = ReceiveStore(
            staging,
            io = object : ReceiveStore.FileIo {
                override fun open(target: File): ReceiveStore.FileIo.Sink =
                    object : ReceiveStore.FileIo.Sink {
                        override fun append(bytes: ByteArray) = throw IOException("disk died")
                        override fun sync() = Unit
                        override fun close() = Unit
                    }
            },
        )
        val (ops, rootDir) = tree()
        store.begin(listOf(FileMeta("f.bin", 4)), ops, ops.node(rootDir))
        assertTrue(store.write(0, byteArrayOf(1)) is ReceiveStore.Outcome.Failed)
    }
}
