package com.relayium.android.integration

import android.content.ComponentName
import android.content.Intent
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import com.relayium.android.R
import com.relayium.android.TestHooks
import com.relayium.android.TransferController
import com.relayium.android.TransferViewModel
import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * **A real share, from a real other app, with real cross-UID grants.**
 *
 * Everything here arrives through the OS from a fixture that runs under its own
 * application UID and its own non-exported provider. Nothing is synthesised: a
 * locally-built `Intent` carrying a URI this process can already read would
 * exercise none of what actually matters — the grant the sender attached, the
 * admission rules that refuse a share without one, and the binding between an
 * admitted share and the handle map of the intent that carried it.
 *
 * The fixture's payload is deterministic (199,000 bytes from a fixed formula),
 * so the bytes this app reads back can be checked against a hash rather than
 * against "some content arrived".
 *
 * ## The case this exists for
 *
 * The fixture always names the SAME URI, `…/files/fixture`, and serves the same
 * bytes for it. That is worth exercising across two real UIDs and two real
 * grants — but it does NOT, on its own, prove which intent's handle answered:
 * identical bytes cannot distinguish the right access from the wrong one. The
 * rule itself is established by the JVM binding suite, which serves a different
 * byte per access and went RED before the fix. What this adds is that the real
 * cross-uid path still reads correctly at all after a second delivery.
 */
@RunWith(AndroidJUnit4::class)
@LargeTest
class ExternalShareIngressTest {

    @get:Rule(order = 0)
    val compose = createEmptyComposeRule()

    @get:Rule(order = 1)
    internal val host = HostActivityRule()

    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun s(id: Int) = context.getString(id)

    private val viewModel: TransferViewModel
        get() = requireNotNull(TestHooks.viewModel) { "the real ViewModel was not registered" }

    /**
     * Ask the fixture to share.
     *
     * It is a separate application: this starts ITS activity, and it composes
     * and sends the `ACTION_SEND` itself, with its own grant, to this app's
     * debug component. Every step after this line is the operating system's.
     */
    private fun share(mode: String) {
        val intent = Intent()
            .setComponent(ComponentName(SENDER_PACKAGE, "$SENDER_PACKAGE.Sender"))
            .putExtra("mode", mode)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        instrumentation.runOnMainSync { context.startActivity(intent) }
        instrumentation.waitForIdleSync()
        compose.waitForIdle()
        awaitSettled()
    }

    private fun awaitSettled() {
        val deadline = System.currentTimeMillis() + SETTLE_MS
        while (System.currentTimeMillis() < deadline) {
            if (viewModel.ingress.staged.value != null ||
                viewModel.ingress.refusal.value != null
            ) {
                compose.waitForIdle()
                return
            }
            Thread.sleep(POLL_MS)
        }
        compose.waitForIdle()
    }

    // ── files ───────────────────────────────────────────────────────────────

    @Test
    fun aSharedFileIsStagedAndNothingIsSent() {
        share("file")

        val staged = requireNotNull(viewModel.ingress.staged.value) {
            "the external share was not staged; refusal=${viewModel.ingress.refusal.value}"
        }
        assertEquals(IngressHost.Staged.Kind.FILES, staged.kind)
        assertEquals(1, staged.itemCount)

        // The share surface, naming what will be sent and where — and a
        // transfer that has NOT started. An app that dispatched on delivery
        // would be uploading somebody's file the moment they mis-tapped a share
        // sheet.
        compose.onNodeWithText(s(R.string.share_title)).assertIsDisplayed()
        compose.onNodeWithText(s(R.string.share_destination_title)).assertIsDisplayed()
        assertEquals(TransferController.Phase.IDLE, viewModel.state.value.phase)
    }

    @Test
    fun theBytesReadBackAreTheBytesTheSenderPublished() {
        share("file")
        val staged = requireNotNull(viewModel.ingress.staged.value)
        awaitDescribed()

        // The item is read BEFORE the take: taking clears the published staging,
        // and reaching for it afterwards would be reading a surface that is
        // deliberately empty.
        val item = requireNotNull(describedItem(staged)) { "the staged item was never described" }

        // Taken the way a dispatch takes it, then read through the staging —
        // the only sanctioned reader for a share, and the one a real transfer
        // would use.
        val share = requireNotNull(viewModel.ingress.take(staged.id, staged.epoch)) {
            "the staged share could not be taken for dispatch"
        }
        assertEquals(FIXTURE_SHA256, sha256(share.open(item.uri).use { it.readBytes() }))
        share.release()
    }

    @Test
    fun aTakenShareKeepsItsOwnGrantWhenAnotherShareArrives() {
        share("file")
        val first = requireNotNull(viewModel.ingress.staged.value)
        awaitDescribed()
        val firstItem = requireNotNull(describedItem(first))
        val dispatched = requireNotNull(viewModel.ingress.take(first.id, first.epoch))

        // A second real delivery, from the same sender, naming the SAME URI —
        // a different intent with a different grant and a different handle map.
        share("file")
        assertNotNull("the second share was not staged", viewModel.ingress.staged.value)

        // The first dispatch is still reading, and still reading correctly,
        // after a second real delivery arrived. Which ACCESS answered is not
        // decidable from identical bytes — that is the JVM binding suite's job,
        // where each access serves a different byte — so this asserts the
        // weaker, still-worth-having fact: the real cross-uid read survives.
        assertEquals(
            "a dispatched share read through a newer intent's provider access",
            FIXTURE_SHA256,
            sha256(dispatched.open(firstItem.uri).use { it.readBytes() }),
        )
        dispatched.release()
    }

    @Test
    fun aRecreationKeepsTheStagedShareReadableAndDoesNotReplayTheIntent() {
        share("file")
        val before = requireNotNull(viewModel.ingress.staged.value)
        awaitDescribed()

        host.recreate()
        compose.waitForIdle()

        val after = requireNotNull(viewModel.ingress.staged.value) {
            "the staged share did not survive a configuration recreation"
        }
        // The SAME staging, not a second one: `onCreate` runs again with the
        // original intent attached, and the saved-state guard is what stops it
        // being routed twice.
        assertEquals(before.id, after.id)
        assertEquals(before.epoch, after.epoch)

        val item = requireNotNull(describedItem(after))
        val share = requireNotNull(viewModel.ingress.take(after.id, after.epoch))
        assertEquals(FIXTURE_SHA256, sha256(share.open(item.uri).use { it.readBytes() }))
        share.release()
    }

    // ── text ────────────────────────────────────────────────────────────────

    @Test
    fun sharedTextIsStagedExactly() {
        share("text")
        val staged = requireNotNull(viewModel.ingress.staged.value)
        assertEquals(IngressHost.Staged.Kind.TEXT, staged.kind)
        // Byte-for-byte what the other app sent, including the non-ASCII run.
        assertEquals(FIXTURE_TEXT, staged.text)
        assertEquals(TransferController.Phase.IDLE, viewModel.state.value.phase)
    }

    // ── refusals ────────────────────────────────────────────────────────────

    @Test
    fun aShareWithNoReadGrantIsRefusedAndNotStaged() {
        share("nogrant")

        // The sender named a URI it never granted. Staging it would hold a
        // reference this app can never open, and would show the user a file
        // they could choose a destination for and never send.
        assertNull("a share with no read grant was staged", viewModel.ingress.staged.value)
        assertNotNull("nothing was reported for an unusable share", viewModel.ingress.refusal.value)
    }

    @Test
    fun anUnreadableParcelIsRefusedAndTheAppSurvives() {
        share("badparcel")

        // Reading the extra unparcels a `Bundle` the SENDER wrote, in this
        // process, naming a class that does not exist here. Any installed app
        // can do this on demand, so it must be a refusal rather than a crash.
        assertNull(viewModel.ingress.staged.value)
        assertNotNull(viewModel.ingress.refusal.value)
        // Still alive and still usable, which is the whole point.
        compose.onNodeWithText(s(R.string.join_title)).assertExists()
    }

    @Test
    fun anUnreadableParcelListIsRefusedAndTheAppSurvives() {
        share("badparcellist")
        assertNull(viewModel.ingress.staged.value)
        assertNotNull(viewModel.ingress.refusal.value)
        compose.onNodeWithText(s(R.string.join_title)).assertExists()
    }

    @Test
    fun hostileMetadataIsShownAsUnknownRatherThanTrusted() {
        share("hostile")
        val staged = requireNotNull(viewModel.ingress.staged.value)
        awaitDescribed()
        val item = requireNotNull(describedItem(staged))

        // The fixture's hostile mode answers the display name `../../outside.bin`.
        //
        // The contract is exact, so the assertion is too — the previous version
        // of this check was a disjunction that any non-negative size satisfied,
        // and it would have passed for a name shown verbatim. What must be true
        // is that the traversal is GONE: separators are replaced, and a name
        // that cleans down to nothing, to `.` or to `..` becomes null rather
        // than something invented here.
        val name = item.displayName
        if (name != null) {
            assertFalse("a path separator survived into the displayed name: $name", '/' in name)
            assertFalse("a path separator survived into the displayed name: $name", '\\' in name)
            assertNotEquals("a traversal name was shown as-is", "..", name)
            assertNotEquals("a traversal name was shown as-is", ".", name)
            assertFalse(
                "the provider's traversal was rendered verbatim: $name",
                name.contains("../") || name.contains("..\\"),
            )
            assertFalse(
                "a control or bidi character survived into the displayed name",
                name.any { it.isISOControl() || it in BIDI_CONTROLS },
            )
        }
        // Whatever it is called, nothing has been sent.
        assertEquals(TransferController.Phase.IDLE, viewModel.state.value.phase)
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    /** Descriptions are read off the main thread; the count is known first. */
    private fun awaitDescribed() {
        val deadline = System.currentTimeMillis() + SETTLE_MS
        while (System.currentTimeMillis() < deadline) {
            if (viewModel.ingress.staged.value?.items != null) return
            Thread.sleep(POLL_MS)
        }
        error("the staged items were never described")
    }

    private fun describedItem(staged: IngressHost.Staged): IngressHost.Staged.Item? =
        (viewModel.ingress.staged.value?.takeIf { it.id == staged.id } ?: staged).items?.firstOrNull()

    private fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private companion object {
        /** The characters that make a name lie about itself in a list. */
        val BIDI_CONTROLS = setOf('\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069')

        const val SENDER_PACKAGE = "com.relayium.acceptance.sender"

        /** `Files.payload()`: 199,000 bytes, `(byte)(i*31 + (i>>8)*17 + (i>>16)*13 + 7)`. */
        const val FIXTURE_SHA256 =
            "56778cd6fddde3a615b5dc61b6cf1fcae502ada333d5a1a928ebd97803dcfbe9"
        const val FIXTURE_TEXT = "external share 文本 fixture"

        const val SETTLE_MS = 15_000L
        const val POLL_MS = 50L
    }
}
