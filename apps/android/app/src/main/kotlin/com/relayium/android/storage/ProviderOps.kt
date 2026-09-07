package com.relayium.android.storage

import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import java.io.IOException
import java.io.OutputStream

/**
 * The narrow seam over the document provider: exactly the five effects
 * [ReceiveStore] performs against a user-chosen tree, and nothing else.
 *
 * It exists so the OWNERSHIP logic — which identities this batch created, in
 * what order, and what a rollback may touch — is exercised by tests against a
 * real filesystem (`java.io.File`-backed nodes on the JVM) and by failure
 * injection at the real call sites, instead of being asserted about a
 * `DocumentFile` wrapper nothing off-device can execute.
 *
 * Every method may throw: SAF providers legitimately raise `SecurityException`,
 * `IllegalArgumentException` and provider-specific errors, not only
 * `IOException`. Callers treat ANY throw as that operation failing.
 */
interface ProviderOps {

    /** One document or directory this batch can address. */
    interface Node {
        /** The name the PROVIDER gave it — which may differ from the requested
         *  one; a caller that must have the requested name checks this. */
        val name: String
        val isDirectory: Boolean
        /** Delete a FILE document. [ReceiveStore] never calls this on a node it
         *  ledgered as a directory: the shipped SAF provider deletes a
         *  directory's contents RECURSIVELY, so a generic directory delete can
         *  destroy a user file placed inside after creation. */
        fun delete(): Boolean
        /** A fresh output stream for a file node. */
        fun openOut(): OutputStream
    }

    fun findChild(parent: Node, name: String): Node?

    fun createDirectory(parent: Node, name: String): Node?

    fun createFile(parent: Node, name: String): Node?

    /**
     * Delete [node] ONLY if the provider can do so ATOMICALLY empty-only — the
     * call must fail, not recurse, when the directory holds anything.
     *
     * The conservative default is "cannot": querying emptiness first and then
     * deleting is a TOCTOU window in which a recursive provider delete destroys
     * a user file added in between, and generic SAF (`DocumentsContract` over
     * the shipped `FileSystemProvider.deleteDocument`) offers no atomic
     * empty-only primitive. A provider without one PRESERVES batch-created
     * directories during rollback and the store reports the leftover truthfully.
     * Only an adapter whose backend genuinely refuses non-empty deletion (e.g.
     * POSIX `rmdir`/`File.delete` semantics) may override this with `true` work.
     */
    fun deleteEmptyDirectory(node: Node): Boolean = false

    /** The Android implementation over SAF. Thin on purpose: everything with a
     *  decision in it lives above this seam. */
    class Saf(private val context: Context) : ProviderOps {

        fun openTree(tree: Uri): Node? =
            DocumentFile.fromTreeUri(context, tree)?.let { SafNode(it) }

        override fun findChild(parent: Node, name: String): Node? =
            (parent as SafNode).file.findFile(name)?.let { SafNode(it) }

        override fun createDirectory(parent: Node, name: String): Node? =
            (parent as SafNode).file.createDirectory(name)?.let { SafNode(it) }

        override fun createFile(parent: Node, name: String): Node? =
            (parent as SafNode).file.createFile("application/octet-stream", name)?.let { SafNode(it) }

        // deleteEmptyDirectory deliberately NOT overridden: DocumentsContract
        // deletion is recursive and there is no atomic empty-only form, so SAF
        // rollback preserves batch-created directories (default false).

        private inner class SafNode(val file: DocumentFile) : Node {
            override val name: String get() = file.name.orEmpty()
            override val isDirectory: Boolean get() = file.isDirectory
            override fun delete(): Boolean = file.delete()
            override fun openOut(): OutputStream =
                context.contentResolver.openOutputStream(file.uri, "wt")
                    ?: throw IOException("the provider gave no output stream")
        }
    }
}
