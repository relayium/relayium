package com.relayium.android

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import androidx.test.platform.app.InstrumentationRegistry
import com.relayium.protocol.TextLaneSession
import java.io.File
import java.security.MessageDigest

/**
 * Shared plumbing for the interop instrumentation: arguments, the disposable
 * SAF tree, digests, and bounded waiting.
 *
 * Everything here works against the REAL app process — the same
 * `ContentResolver`, the same `TestDocumentsProvider`, the same
 * [TransferViewModel] `MainActivity` created. Nothing constructs a parallel
 * controller, transport or store: a run that did would be asserting about an
 * object the user never touches, which is the failure mode this whole lane
 * exists to avoid.
 */
internal object InteropDriver {

    /** Instrumentation `-e` arguments, so the shell half owns every value. */
    fun arg(name: String): String? =
        InstrumentationRegistry.getArguments().getString(name)?.takeIf { it.isNotEmpty() }

    fun requireArg(name: String): String =
        arg(name) ?: error("the acceptance requires -e $name")

    private val context: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    /** The debug provider's authority, derived from the RUNNING app id so the
     *  `.debug` suffix cannot drift out of sync with the manifest. */
    private val authority: String get() = "${context.packageName}.testdocs"

    /**
     * A tree URI over the disposable provider — the same SHAPE
     * `ACTION_OPEN_DOCUMENT_TREE` returns, so `ProviderOps.Saf.openTree`,
     * `DocumentFile.fromTreeUri`, `DocumentsContract` and the real IPC are all
     * exercised. The system picker's UI is the only thing not driven; the
     * grant it would produce is the grant a same-uid provider already gives.
     */
    fun treeUri(): Uri = DocumentsContract.buildTreeDocumentUri(authority, ROOT_DOC)

    /**
     * Stage an outgoing file INSIDE the same provider and return its document
     * URI, so the send path opens a real `content://` stream through
     * `ContentResolver` exactly as a user's pick does. A `file://` path or a
     * direct `FileInputStream` would skip the provider boundary and pass off
     * local file IO as SAF.
     */
    fun stageOutgoing(name: String, bytes: ByteArray): Uri {
        val resolver = context.contentResolver
        val parent = DocumentsContract.buildDocumentUri(authority, ROOT_DOC)
        val existing = DocumentsContract.buildDocumentUri(authority, name)
        runCatching { DocumentsContract.deleteDocument(resolver, existing) }
        val created = DocumentsContract.createDocument(
            resolver, parent, "application/octet-stream", name,
        ) ?: error("could not create the outgoing document $name")
        resolver.openOutputStream(created, "wt")?.use { it.write(bytes) }
            ?: error("the provider returned no stream for $name")
        return created
    }

    /** The bytes the app actually SAVED, read back through the provider. */
    fun readSaved(name: String): ByteArray? {
        val uri = DocumentsContract.buildDocumentUri(authority, name)
        return runCatching {
            context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
        }.getOrNull()
    }

    /** Every document id currently under the disposable root, for leftover
     *  assertions after a cancel. */
    fun listTree(): List<String> {
        val children = DocumentsContract.buildChildDocumentsUri(authority, ROOT_DOC)
        val out = ArrayList<String>()
        context.contentResolver.query(
            children, arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID), null, null, null,
        )?.use { cursor ->
            while (cursor.moveToNext()) out.add(cursor.getString(0))
        }
        return out
    }

    fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { "%02x".format(it) }

    /**
     * Bounded waiting on a condition, never a sleep-and-hope. A timeout is a
     * FAILURE with the condition named — an acceptance that proceeded past an
     * unmet precondition would report the next assertion's confusion instead
     * of this one's truth.
     */
    fun awaitTrue(what: String, timeoutMs: Long = 60_000, predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (predicate()) return
            Thread.sleep(50)
        }
        error("timed out after ${timeoutMs}ms waiting for: $what")
    }

    /** The live ViewModel the running Activity created, never a new one. */
    fun viewModel(): TransferViewModel {
        awaitTrue("the real MainActivity registered its ViewModel", 30_000) {
            TestHooks.viewModel != null
        }
        return TestHooks.viewModel!!
    }

    fun state(vm: TransferViewModel) = vm.state.value

    fun textOpen(vm: TransferViewModel) =
        state(vm).textState == TextLaneSession.State.OPEN

    /**
     * Observations for the shell half, which owns every comparison.
     *
     * [name] is a FILE NAME, not a path: the report is written into the app's
     * own internal files directory and the shell reads it back with `run-as`.
     * Writing to `/sdcard/Android/data/<pkg>/files` instead is `EACCES` on
     * this API level even for the owning uid, and a report that silently
     * failed to write looks exactly like a round that never reached its end.
     *
     * Written from a `finally`, so a FAILED round still reports what it got —
     * which is why the shell judges the instrumentation's own success
     * separately and never treats this file's existence as a pass.
     */
    fun report(name: String, fields: Map<String, Any?>) {
        File(context.filesDir, name).writeText(encode(fields))
    }

    private fun encode(v: Any?): String = when (v) {
        null -> "null"
        is Boolean, is Int, is Long -> v.toString()
        is List<*> -> v.joinToString(",", "[", "]") { encode(it) }
        is Map<*, *> -> v.entries.joinToString(",", "{", "}") { (k, value) ->
            "${quote(k.toString())}:${encode(value)}"
        }
        else -> quote(v.toString())
    }

    private fun quote(s: String): String = buildString {
        append('"')
        for (c in s) when (c) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> if (c < ' ') append("\\u%04x".format(c.code)) else append(c)
        }
        append('"')
    }

    const val ROOT_DOC = "root"
}
