package com.relayium.android.ingress

import android.content.ClipData
import android.content.ClipDescription
import android.content.Intent
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The adapter against the REAL framework: real `Intent`s, real `Uri`s, a real
 * `ClipData` and a real package manager.
 *
 * Everything in this file is an intent any installed app can send with one
 * `startActivity` call. The rules the intents run into are host-tested next
 * door; what needs a device is the reading itself — parcelling, the compat
 * helpers on this API level, and the extras a sender can lie about.
 *
 * The bar for every case here is the same: **the activity that receives this
 * must not crash.** A refusal is a result; an exception is a denial of service
 * any app on the device can trigger on demand.
 */
@RunWith(AndroidJUnit4::class)
class IngressIntentsTest {

    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    private val origin = "https://relayium.com"
    private val own by lazy { IngressIntents.ownAuthorities(context) }

    private fun read(intent: Intent) = IngressIntents.read(intent, own, origin)

    private fun refusal(intent: Intent): IngressRefusal {
        val outcome = read(intent)?.outcome
        assertTrue("expected refused, got $outcome", outcome is IngressOutcome.Refused)
        return (outcome as IngressOutcome.Refused).reason
    }

    private fun request(intent: Intent): IngressRequest {
        val outcome = read(intent)?.outcome
        assertTrue("expected accepted, got $outcome", outcome is IngressOutcome.Accepted)
        return (outcome as IngressOutcome.Accepted).request
    }

    private fun send(vararg uris: Uri, grant: Boolean = true): Intent =
        Intent(if (uris.size > 1) Intent.ACTION_SEND_MULTIPLE else Intent.ACTION_SEND).apply {
            type = "*/*"
            if (uris.size > 1) {
                putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(uris.toList()))
            } else {
                putExtra(Intent.EXTRA_STREAM, uris.first())
            }
            if (grant) addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }

    // ── what this module claims ─────────────────────────────────────────────

    @Test
    fun theLauncherIntentIsNotAnEntryPointAndIsNotAnError() {
        // A wiring that showed a refusal here would report an error for opening
        // the app.
        assertNull(read(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)))
        assertNull(read(Intent()))
        assertNull(read(Intent("com.example.SOMETHING_ELSE")))
    }

    @Test
    fun aTappedJoinLinkIsReadAsOne() {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("$origin/cross-network#c=042913"))
        val request = request(intent)
        assertTrue(request is IngressRequest.PrefillCode)
        assertEquals("042913", (request as IngressRequest.PrefillCode).code.digits)
    }

    @Test
    fun aViewIntentWithNoDataIsEmptyRatherThanACrash() {
        assertEquals(IngressRefusal.EMPTY, refusal(Intent(Intent.ACTION_VIEW)))
    }

    // ── hostile extras ──────────────────────────────────────────────────────

    @Test
    fun anExtraStreamOfTheWrongTypeDoesNotCrashTheReceiver() {
        // Below API 33 the compat helper cannot check the element type, so the
        // declared ArrayList<Uri> really can hold anything the sender
        // parcelled. An implicit cast in a `for` header would throw here.
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_STREAM, "not a uri at all")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        // Either refused, or read as nothing shareable — never an exception.
        assertNotNull(read(intent))
    }

    @Test
    fun anExtraStreamListOfTheWrongTypeDoesNotCrashTheReceiver() {
        val intent = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
            type = "*/*"
            putStringArrayListExtra(Intent.EXTRA_STREAM, arrayListOf("a", "b"))
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        assertNotNull(read(intent))
    }

    @Test
    fun aListMixingRealUrisWithOtherParcelablesKeepsTheRealOnes() {
        // A parcelled list whose elements are Parcelables of the WRONG class is
        // the reachable form of this: the compat helper's cast is unchecked, so
        // the failure lands element by element. Skipping the ones that are not
        // URIs keeps a share of real files that carries one hostile entry.
        //
        // The related BadParcelableException case — a payload naming a class
        // this process does not have — is NOT reachable from here: an
        // instrumentation test shares a classloader with the app under test, so
        // anything it can parcel, the app can unparcel. It is covered by the
        // catch in the adapter and is NOT claimed as proven by this file; the
        // cross-uid case belongs to the external-sender helper APK at
        // integration.
        val mixed = ArrayList<android.os.Parcelable>()
        mixed.add(Uri.parse("content://media/external/images/1"))
        mixed.add(Intent("com.example.NOT_A_URI"))
        mixed.add(Uri.parse("content://media/external/images/2"))
        val intent = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
            type = "*/*"
            putParcelableArrayListExtra(Intent.EXTRA_STREAM, mixed)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val request = request(intent)
        assertEquals(2, (request as IngressRequest.StageFiles).share.items.size)
    }

    @Test
    fun aShareWithNoGrantIsRefused() {
        val intent = send(Uri.parse("content://media/external/images/1"), grant = false)
        assertEquals(IngressRefusal.NOTHING_SHAREABLE, refusal(intent))
    }

    @Test
    fun aFileUriIsRefusedWhateverItPointsAt() {
        val intent = send(Uri.parse("file:///data/data/${context.packageName}/files/token"))
        assertEquals(IngressRefusal.NOTHING_SHAREABLE, refusal(intent))
    }

    @Test
    fun thisAppsOwnProvidersAreRefused() {
        // The declared set really does contain the debug documents provider, so
        // this is the actual authority a confused-deputy intent would name.
        for (authority in own) {
            val intent = send(Uri.parse("content://$authority/document/secret"))
            assertEquals(authority, IngressRefusal.NOTHING_SHAREABLE, refusal(intent))
        }
    }

    @Test
    fun aUserQualifiedOwnAuthorityIsRefused() {
        // `getAuthorityWithoutUserId` strips through the last `@` before the
        // provider is looked up, so this routes to the app's own provider while
        // reading as a different authority.
        val intent = send(Uri.parse("content://0@${context.packageName}.testdocs/document/secret"))
        assertEquals(IngressRefusal.NOTHING_SHAREABLE, refusal(intent))
    }

    @Test
    fun theDeclaredAuthoritySetContainsWhatThisBuildActuallyDeclares() {
        assertTrue(own.contains(context.packageName.lowercase()))
        // Debug declares the documents provider the acceptance saves into; the
        // point of reading the manifest is that this set is a fact rather than
        // a convention.
        assertTrue(own.all { it == it.lowercase() })
    }

    // ── both places URIs arrive from ────────────────────────────────────────

    @Test
    fun clipDataAndExtraStreamAreBothRead() {
        val first = Uri.parse("content://media/external/images/1")
        val second = Uri.parse("content://media/external/images/2")
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "*/*"
            putExtra(Intent.EXTRA_STREAM, first)
            clipData = ClipData(
                ClipDescription("shared", arrayOf("*/*")),
                ClipData.Item(second),
            )
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val share = (request(intent) as IngressRequest.StageFiles).share
        assertEquals(2, share.items.size)
    }

    @Test
    fun theSameItemInBothPlacesIsSentOnce() {
        val uri = Uri.parse("content://media/external/images/1")
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "*/*"
            putExtra(Intent.EXTRA_STREAM, uri)
            clipData = ClipData(ClipDescription("shared", arrayOf("*/*")), ClipData.Item(uri))
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val share = (request(intent) as IngressRequest.StageFiles).share
        assertEquals(1, share.items.size)
        assertEquals(1, share.skipped[ShareItemRefusal.DUPLICATE])
    }

    @Test
    fun aShareLargerThanOneBatchIsRefusedWithoutWalkingAllOfIt() {
        val many = ArrayList<Uri>()
        repeat(ShareAdmission.MAX_ITEMS + 50) { many.add(Uri.parse("content://media/external/images/$it")) }
        val intent = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
            type = "*/*"
            putParcelableArrayListExtra(Intent.EXTRA_STREAM, many)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        assertEquals(IngressRefusal.TOO_MANY_ITEMS, refusal(intent))
    }

    // ── the scan budget ─────────────────────────────────────────────────────
    //
    // The bound is on entries LOOKED AT. Every case below admits nothing, so a
    // bound that counted survivors would never fire and the walk would run to
    // the end of whatever the sender attached — which is the shape a sender
    // picks precisely because it is free to produce.

    @Test
    fun anOverLongListOfWrongTypesIsRefusedRatherThanWalkedToTheEnd() {
        val junk = ArrayList<String>()
        repeat(ShareAdmission.MAX_ITEMS + 500) { junk.add("not a uri $it") }
        val intent = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
            type = "*/*"
            putStringArrayListExtra(Intent.EXTRA_STREAM, junk)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        // Explicitly TOO_MANY_ITEMS, not "nothing shareable" and not "empty":
        // the sender named more than this app will examine, and that is a
        // different fact from naming nothing usable.
        assertEquals(IngressRefusal.TOO_MANY_ITEMS, refusal(intent))
    }

    @Test
    fun anOverLongClipDataOfTextItemsIsRefusedRatherThanWalkedToTheEnd() {
        // `ClipData.Item(text)` has a null URI, so none of these is ever kept.
        val clip = ClipData(ClipDescription("shared", arrayOf("text/plain")), ClipData.Item("item 0"))
        repeat(ShareAdmission.MAX_ITEMS + 500) { clip.addItem(ClipData.Item("item $it")) }
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            clipData = clip
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        assertEquals(IngressRefusal.TOO_MANY_ITEMS, refusal(intent))
    }

    @Test
    fun theBudgetIsOneAcrossBothContainers() {
        // Two thirds of the ceiling in each half is under the bound separately
        // and over it together. Spending the budget per container would let a
        // sender pay the ceiling twice.
        val each = (ShareAdmission.MAX_ITEMS * 2) / 3
        val stream = ArrayList<Uri>()
        repeat(each) { stream.add(Uri.parse("content://media/external/images/s$it")) }
        val clip = ClipData(
            ClipDescription("shared", arrayOf("*/*")),
            ClipData.Item(Uri.parse("content://media/external/images/c0")),
        )
        repeat(each) { clip.addItem(ClipData.Item(Uri.parse("content://media/external/images/c$it"))) }
        val intent = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
            type = "*/*"
            putParcelableArrayListExtra(Intent.EXTRA_STREAM, stream)
            clipData = clip
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        assertEquals(IngressRefusal.TOO_MANY_ITEMS, refusal(intent))
    }

    @Test
    fun anOverBudgetShareDoesNotFallBackToItsCaption() {
        // Without the check running BEFORE the text path, a share of a million
        // junk entries would arrive as a message the user never wrote.
        val junk = ArrayList<String>()
        repeat(ShareAdmission.MAX_ITEMS + 500) { junk.add("not a uri $it") }
        val intent = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
            type = "*/*"
            putStringArrayListExtra(Intent.EXTRA_STREAM, junk)
            putExtra(Intent.EXTRA_TEXT, "look at this")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        assertEquals(IngressRefusal.TOO_MANY_ITEMS, refusal(intent))
    }

    @Test
    fun aClipJustOverTheCeilingWithACaptionIsRefusedAtTheBoundary() {
        // The tight boundary, in the shape the independent probe uses:
        // `newPlainText` contributes the first item, so this is MAX_ITEMS + 2
        // text items in total, with a caption behind them. It is the smallest
        // over-bound share that used to be answered with the caption.
        val clip = ClipData.newPlainText("probe", "ignored")
        repeat(ShareAdmission.MAX_ITEMS + 1) { clip.addItem(ClipData.Item("ignored")) }
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            clipData = clip
            putExtra(Intent.EXTRA_TEXT, "must not fall back after an oversized share")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        assertEquals(IngressRefusal.TOO_MANY_ITEMS, refusal(intent))
    }

    @Test
    fun aClipOfTextItemsUnderTheCeilingIsStillATextShare() {
        // The other side of the same boundary: a big clip that is genuinely
        // under the bound is a text share, and the caption is its content. The
        // budget must refuse over-bound shares without swallowing ordinary
        // ones.
        val clip = ClipData.newPlainText("probe", "ignored")
        repeat(ShareAdmission.MAX_ITEMS / 2) { clip.addItem(ClipData.Item("ignored")) }
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            clipData = clip
            putExtra(Intent.EXTRA_TEXT, "bring the drive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        assertEquals("bring the drive", (request(intent) as IngressRequest.StageText).text)
    }

    @Test
    fun aShareAtExactlyTheCeilingIsStillAdmitted() {
        // The budget must not refuse the largest share the wire can carry.
        val many = ArrayList<Uri>()
        repeat(ShareAdmission.MAX_ITEMS) { many.add(Uri.parse("content://media/external/images/$it")) }
        val intent = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
            type = "*/*"
            putParcelableArrayListExtra(Intent.EXTRA_STREAM, many)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val share = (request(intent) as IngressRequest.StageFiles).share
        assertEquals(ShareAdmission.MAX_ITEMS, share.items.size)
    }

    // ── text ────────────────────────────────────────────────────────────────

    @Test
    fun sharedTextThatIsAJoinLinkTakesTheLinkPath() {
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, "$origin/cross-network#c=042913")
        }
        assertTrue(request(intent) is IngressRequest.PrefillCode)
    }

    @Test
    fun sharedProseIsStagedAsText() {
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, "bring the drive")
        }
        assertEquals("bring the drive", (request(intent) as IngressRequest.StageText).text)
    }

    @Test
    fun aCaptionBesideAFileDoesNotBecomeAMessage() {
        val intent = send(Uri.parse("content://media/external/images/1")).apply {
            putExtra(Intent.EXTRA_TEXT, "look at this")
        }
        assertTrue(request(intent) is IngressRequest.StageFiles)
    }

    @Test
    fun aShareWithNothingInItIsEmpty() {
        assertEquals(IngressRefusal.EMPTY, refusal(Intent(Intent.ACTION_SEND).apply { type = "*/*" }))
    }

    // ── the resolver seam ───────────────────────────────────────────────────

    @Test
    fun aReaderCannotBeTalkedIntoOpeningSomethingTheIntentDidNotName() {
        // The map built from the intent IS the capability: constructing an
        // IncomingUri by hand must not reach the resolver.
        val intent = send(Uri.parse("content://media/external/images/1"))
        val access = read(intent)!!.access(context.contentResolver)
        val forged = IncomingUri(
            "content://${context.packageName}.testdocs/document/secret",
            "content",
            "${context.packageName}.testdocs",
            "${context.packageName}.testdocs",
        )
        assertNull(access.describe(forged))
        var threw = false
        try {
            access.open(forged).close()
        } catch (_: java.io.IOException) {
            threw = true
        }
        assertTrue("a forged reference must not open", threw)
    }
}
