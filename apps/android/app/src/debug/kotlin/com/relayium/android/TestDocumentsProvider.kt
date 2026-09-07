package com.relayium.android

import android.database.Cursor
import android.database.MatrixCursor
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import android.provider.DocumentsProvider
import java.io.File
import java.io.FileNotFoundException

/**
 * DEBUG ONLY: a real [DocumentsProvider] over a disposable directory inside the
 * app's own files dir, so the acceptance exercises the app's ACTUAL storage
 * stack — `ContentResolver`, `DocumentsContract`, `DocumentFile`, the
 * [com.relayium.android.storage.ProviderOps.Saf] adapter — without driving the
 * system folder picker's UI (which grants the same kind of tree URI this
 * provider serves).
 *
 * What it deliberately mirrors from generic SAF providers: `deleteDocument` on
 * a DIRECTORY deletes RECURSIVELY, exactly like the shipped
 * `FileSystemProvider` — because that recursive behaviour is the reason the
 * store's rollback refuses to delete directories at all, and a test provider
 * that failed on non-empty directories would quietly un-test that rule.
 *
 * Not in release builds (debug source set), and unreachable by other apps in
 * debug: the `MANAGE_DOCUMENTS` permission on the manifest entry is granted
 * only to the system documents UI, while the app and its instrumentation share
 * a uid with the provider and bypass it.
 */
class TestDocumentsProvider : DocumentsProvider() {

    private val rootDir: File
        get() = File(hostContext().filesDir, "test-tree").apply { mkdirs() }

    /**
     * Deliberately NOT named `requireContext`: `ContentProvider` gained a
     * member of that exact name in API 30, and a private method with the same
     * signature HIDES the supertype's — a warning this build treats as an
     * error, and a real ambiguity for a reader. The app's minSdk is 26, so the
     * supertype member is not callable here either; this helper is the only
     * accessor and it fails loudly rather than returning a null context.
     */
    private fun hostContext() = context ?: throw IllegalStateException("no context")

    private fun fileFor(documentId: String): File {
        val file = if (documentId == ROOT_DOC) rootDir else File(rootDir, documentId)
        // The canonical path must stay inside the root: a traversal in a
        // document id is a test-harness bug, and failing loudly beats writing
        // outside the disposable directory.
        if (!isInside(file, rootDir)) {
            throw SecurityException("document id escapes the test tree: $documentId")
        }
        return file
    }

    /**
     * Containment on PATH SEGMENTS, not on a raw string prefix. A bare
     * `startsWith` accepts a SIBLING whose name merely extends the root's —
     * `/files/test-tree-evil` starts with `/files/test-tree` — so a crafted
     * document id could address a directory the harness never owns. The root
     * itself counts as inside; anything deeper must cross a separator.
     */
    private fun isInside(candidate: File, root: File): Boolean {
        val rootPath = root.canonicalPath
        val path = candidate.canonicalPath
        return path == rootPath || path.startsWith(rootPath + File.separator)
    }

    private fun idFor(file: File): String {
        val relative = file.relativeTo(rootDir).path
        return if (relative.isEmpty()) ROOT_DOC else relative
    }

    private fun rowFor(cursor: MatrixCursor, file: File) {
        val id = idFor(file)
        cursor.newRow()
            .add(Document.COLUMN_DOCUMENT_ID, id)
            .add(Document.COLUMN_DISPLAY_NAME, if (id == ROOT_DOC) "test-tree" else file.name)
            .add(
                Document.COLUMN_MIME_TYPE,
                if (file.isDirectory) Document.MIME_TYPE_DIR else "application/octet-stream",
            )
            .add(Document.COLUMN_SIZE, if (file.isDirectory) null else file.length())
            .add(Document.COLUMN_LAST_MODIFIED, file.lastModified())
            .add(
                Document.COLUMN_FLAGS,
                if (file.isDirectory) Document.FLAG_DIR_SUPPORTS_CREATE
                else Document.FLAG_SUPPORTS_DELETE or Document.FLAG_SUPPORTS_WRITE,
            )
    }

    override fun onCreate(): Boolean = true

    override fun queryRoots(projection: Array<out String>?): Cursor =
        MatrixCursor(projection ?: ROOT_PROJECTION).apply {
            newRow()
                .add(Root.COLUMN_ROOT_ID, "test-root")
                .add(Root.COLUMN_DOCUMENT_ID, ROOT_DOC)
                .add(Root.COLUMN_TITLE, "Relayium test tree")
                // FLAG_SUPPORTS_IS_CHILD is REQUIRED for a root to appear in the
                // ACTION_OPEN_DOCUMENT_TREE picker: DocumentsUI filters out any
                // tree root whose provider does not advertise the capability,
                // even when `isChildDocument` is implemented (it is, below). On
                // AOSP 36 the test root was absent from the tree picker for
                // exactly this reason. Advertising a capability this provider
                // actually implements — not changing the product picker.
                .add(
                    Root.COLUMN_FLAGS,
                    Root.FLAG_SUPPORTS_CREATE or Root.FLAG_SUPPORTS_IS_CHILD,
                )
        }

    override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor {
        val file = fileFor(documentId)
        if (!file.exists()) throw FileNotFoundException(documentId)
        return MatrixCursor(projection ?: DOC_PROJECTION).apply { rowFor(this, file) }
    }

    override fun queryChildDocuments(
        parentDocumentId: String,
        projection: Array<out String>?,
        sortOrder: String?,
    ): Cursor {
        val parent = fileFor(parentDocumentId)
        return MatrixCursor(projection ?: DOC_PROJECTION).apply {
            (parent.listFiles() ?: emptyArray()).sortedBy { it.name }.forEach { rowFor(this, it) }
        }
    }

    override fun isChildDocument(parentDocumentId: String, documentId: String): Boolean {
        val parent = fileFor(parentDocumentId)
        val child = fileFor(documentId)
        // Strictly BELOW the parent: the same separator-aware rule as
        // [isInside], minus the equal case, so a document is never reported as
        // its own child and a sibling prefix is never reported as a descendant.
        return child.canonicalPath != parent.canonicalPath && isInside(child, parent)
    }

    override fun createDocument(
        parentDocumentId: String,
        mimeType: String,
        displayName: String,
    ): String {
        val parent = fileFor(parentDocumentId)
        val target = File(parent, displayName)
        if (!isInside(target, rootDir)) {
            throw SecurityException("refusing to create outside the test tree")
        }
        val created = if (mimeType == Document.MIME_TYPE_DIR) {
            target.mkdir()
        } else {
            target.createNewFile()
        }
        if (!created) throw FileNotFoundException("could not create $displayName")
        return idFor(target)
    }

    override fun openDocument(
        documentId: String,
        mode: String,
        signal: CancellationSignal?,
    ): ParcelFileDescriptor {
        val file = fileFor(documentId)
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.parseMode(mode))
    }

    override fun deleteDocument(documentId: String) {
        val file = fileFor(documentId)
        // Recursive on a directory ON PURPOSE — see the class comment.
        val deleted = if (file.isDirectory) file.deleteRecursively() else file.delete()
        if (!deleted) throw FileNotFoundException("could not delete $documentId")
    }

    private companion object {
        const val ROOT_DOC = "root"
        val ROOT_PROJECTION = arrayOf(
            Root.COLUMN_ROOT_ID, Root.COLUMN_DOCUMENT_ID, Root.COLUMN_TITLE, Root.COLUMN_FLAGS,
        )
        val DOC_PROJECTION = arrayOf(
            Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE,
            Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED, Document.COLUMN_FLAGS,
        )
    }
}
