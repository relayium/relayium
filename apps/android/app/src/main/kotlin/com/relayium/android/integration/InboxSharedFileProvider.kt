package com.relayium.android.integration

import android.content.ContentProvider
import android.content.ContentValues
import android.content.UriMatcher
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import java.io.File
import java.io.FileNotFoundException

/**
 * How a received delivery reaches another app — a gallery, a document viewer,
 * a mail composer — without this app handing out a path.
 *
 * ## Not exported, and that is the authorisation
 *
 * `android:exported="false"` means no app can address this provider at all.
 * What reaches it is a URI this app put into an `Intent` with
 * `FLAG_GRANT_READ_URI_PERMISSION`, which the system turns into a per-URI grant
 * for exactly that consumer, revoked when its task finishes. The token in the
 * URI distinguishes one grant from another; it is not what permits the read.
 *
 * ## Read-only, in the strong sense
 *
 * [insert], [update] and [delete] are not "unimplemented" — they throw, so a
 * caller finds out rather than believing a silent no-op succeeded. [openFile]
 * accepts `r` and refuses every other mode, including `rw` and `wt`: a consumer
 * that asked to write to a received file is asking to modify a delivery whose
 * bytes this app has already verified and recorded.
 *
 * ## Ordinary consumer semantics
 *
 * Query and open both work repeatedly for as long as the grant is valid, which
 * is what real consumers do — name, then size, then open, then open again after
 * their own recreation. Bounding is by time and by account session, in
 * [SharedFileGrants], never by "this token has been touched once".
 *
 * ## Every refusal is the same refusal
 *
 * Expired, revoked by an account change, minted in a process that has since
 * died, or never minted at all — [query] answers an empty cursor and [openFile]
 * throws [FileNotFoundException]. That is the truthful outcome for all of them,
 * it is a shape every consumer already handles, and answering them differently
 * would tell a caller which tokens once existed.
 */
class InboxSharedFileProvider : ContentProvider() {

    private lateinit var matcher: UriMatcher

    override fun onCreate(): Boolean {
        // The authority is per-application-id, so the debug variant's suffixed
        // id does not collide with a release install on the same device.
        matcher = UriMatcher(UriMatcher.NO_MATCH)
        matcher.addURI(authority(context!!.packageName), "$SEGMENT/*", FILE)
        return true
    }

    /**
     * The type, from the file's own extension.
     *
     * Derived rather than stored: the name came from a manifest this app
     * verified, and an extension is the only thing a chooser can use to offer
     * sensible apps. An unknown extension answers the generic type instead of
     * guessing — a wrong concrete type sends the file to an app that cannot
     * read it.
     */
    override fun getType(uri: Uri): String {
        val grant = grantFor(uri) ?: return FALLBACK_TYPE
        val extension = grant.displayName.substringAfterLast('.', "").lowercase()
        if (extension.isEmpty()) return FALLBACK_TYPE
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) ?: FALLBACK_TYPE
    }

    /**
     * The two columns a consumer actually reads.
     *
     * Only what was asked for, in the order asked for: a chooser that requested
     * `DISPLAY_NAME` alone must not receive a size column it did not ask about.
     * Nothing else is answerable — there is no path column, and no column that
     * names the account or the delivery.
     */
    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor {
        val columns = projection?.filter { it == OpenableColumns.DISPLAY_NAME || it == OpenableColumns.SIZE }
            ?: listOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        val cursor = MatrixCursor(columns.toTypedArray())
        val grant = grantFor(uri) ?: return cursor
        // An `Iterable` row rather than an array: the two column values are a
        // String and a Long, and an inferred array type over both is the
        // intersection Kotlin warns about reifying.
        val row: List<Any> = columns.map { column ->
            when (column) {
                OpenableColumns.DISPLAY_NAME -> grant.displayName
                else -> grant.size
            }
        }
        cursor.addRow(row)
        return cursor
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        // `r` and nothing else. A received file is evidence of a delivery this
        // app verified; a consumer that could write to it could make the
        // recorded manifest a lie.
        if (mode != "r") throw FileNotFoundException("relayium: read-only")
        if (matcher.match(uri) != FILE) throw FileNotFoundException("relayium: no such grant")
        val token = uri.lastPathSegment ?: throw FileNotFoundException("relayium: no such grant")
        // The validation and the open are ONE serialized registry operation.
        // Resolving first and opening afterwards has a window: an account change
        // completing in between revokes the grant, and the descriptor is handed
        // out anyway — the previous session's file, delivered after this app
        // decided that session was over. Inside the operation a revocation
        // either wins, and this throws, or it loses, and the descriptor already
        // existed.
        val descriptor = SharedFileGrants.openGrant(token, SystemClock.elapsedRealtime()) { grant ->
            val file: File = grant.file
            if (!file.isFile) null
            else ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
        }
        return descriptor ?: throw FileNotFoundException("relayium: no such grant")
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri =
        throw UnsupportedOperationException("relayium: read-only provider")

    override fun update(
        uri: Uri,
        values: ContentValues?,
        selection: String?,
        selectionArgs: Array<out String>?,
    ): Int = throw UnsupportedOperationException("relayium: read-only provider")

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int =
        throw UnsupportedOperationException("relayium: read-only provider")

    private fun grantFor(uri: Uri): SharedFileGrants.Grant? {
        if (matcher.match(uri) != FILE) return null
        val token = uri.lastPathSegment ?: return null
        return SharedFileGrants.resolve(token, SystemClock.elapsedRealtime())
    }

    companion object {
        private const val FILE = 1
        private const val SEGMENT = "received"
        private const val FALLBACK_TYPE = "application/octet-stream"

        /** Per application id, so debug and release installs do not collide. */
        fun authority(packageName: String): String = "$packageName.inboxfiles"

        /** The URI for a token minted by [SharedFileGrants]. */
        fun uriFor(packageName: String, token: String): Uri = Uri.Builder()
            .scheme("content")
            .authority(authority(packageName))
            .appendPath(SEGMENT)
            .appendPath(token)
            .build()
    }
}
