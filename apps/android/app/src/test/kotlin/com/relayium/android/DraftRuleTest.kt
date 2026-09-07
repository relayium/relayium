package com.relayium.android

import com.relayium.android.TransferViewModel.Companion.clearedBy
import com.relayium.android.TransferViewModel.Companion.edited
import com.relayium.android.TransferViewModel.Draft
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Draft OWNERSHIP (R15b/R15.1).
 *
 * The draft is not a bare string that some observer blanks when the link
 * changes; it carries the link it was typed for and a revision that
 * distinguishes later edits. Two failures this pins:
 *
 *  - text composed for one peer must never be shown, extended or cleared
 *    against a different peer, in EITHER direction (old text into a new
 *    session, and a new session's text erased by an old completion);
 *  - a delivery confirmation clears only the exact submission it confirms, so
 *    a rejected enqueue keeps the user's text and edits typed after the tap
 *    survive their own send.
 *
 * These are the pure rules. `TransferControllerTest` covers the send-side
 * fence they depend on, where the controller re-checks the link on its own
 * executor before sealing.
 */
class DraftRuleTest {

    private val draft = Draft(linkId = 3, revision = 4, text = "hello")

    // ── editing ─────────────────────────────────────────────────────────────

    @Test
    fun `an edit for the owning link advances the revision`() {
        assertEquals(Draft(3, 5, "hello!"), draft.edited("hello!", expectedLink = 3))
    }

    @Test
    fun `an edit for a NEWER link starts that link's own draft`() {
        // NOT "hello" plus a keystroke: the previous peer's text is replaced,
        // never extended, so it cannot reach the new peer by accident.
        assertEquals(Draft(4, 0, "h"), draft.edited("h", expectedLink = 4))
    }

    @Test
    fun `a stale edit from an OLDER link cannot overwrite the current draft`() {
        // R15.2. Link ids are the controller's monotonic epochs. A composable
        // rendered against link 7 can still deliver a queued keystroke after
        // link 8 exists; taking it would erase what the user has already typed
        // for the CURRENT peer and walk the owning id backwards.
        val current = Draft(linkId = 8, revision = 4, text = "new peer unsent text")
        assertEquals(current, current.edited("old delayed edit", expectedLink = 7))
    }

    @Test
    fun `a stale edit cannot walk ownership backwards and then be cleared by a stale completion`() {
        // The composite failure the direction rule closes: if the older edit
        // were taken, the draft would own link 7 revision 0 — and a completion
        // for link 7 revision 0, submitted long before, would then clear text
        // the user typed for link 8.
        val current = Draft(linkId = 8, revision = 0, text = "typed for the new peer")
        val afterStale = current.edited("old delayed edit", expectedLink = 7)
        val staleSubmission = Draft(linkId = 7, revision = 0, text = "old delayed edit")
        assertEquals(current, afterStale)
        assertEquals(current, afterStale.clearedBy(staleSubmission))
    }

    @Test
    fun `the first keystroke for a new link is kept, not dropped`() {
        // The other half of the direction rule: refusing OLDER edits must not
        // become refusing every edit whose link differs, or the new peer's
        // first character would vanish.
        assertEquals(Draft(9, 0, "n"), draft.edited("n", expectedLink = 9))
    }

    @Test
    fun `the first edit before any join owns the no-link identity`() {
        val empty = Draft(TransferViewModel.NO_LINK, 0, "")
        assertEquals(Draft(TransferViewModel.NO_LINK, 1, "x"), empty.edited("x", TransferViewModel.NO_LINK))
    }

    // ── clearing ────────────────────────────────────────────────────────────

    @Test
    fun `the confirmed submission clears`() {
        assertEquals(Draft(3, 4, ""), draft.clearedBy(draft))
    }

    @Test
    fun `an edit typed after the tap survives its own delivery`() {
        val submitted = draft
        val edited = draft.edited("hello, and more", expectedLink = 3)
        assertEquals(edited, edited.clearedBy(submitted))
    }

    @Test
    fun `a stale completion from an old link cannot blank the new draft`() {
        val submittedOnOldLink = Draft(linkId = 3, revision = 4, text = "for the old peer")
        val current = Draft(linkId = 4, revision = 0, text = "for the new peer")
        assertEquals(current, current.clearedBy(submittedOnOldLink))
    }

    @Test
    fun `a stale completion whose link and revision happen to be reused still only clears an identical submission`() {
        // Same link, EARLIER revision: the user has typed since, so the field
        // must keep what it holds.
        val submitted = Draft(linkId = 3, revision = 2, text = "old body")
        assertEquals(draft, draft.clearedBy(submitted))
    }

    @Test
    fun `clearing twice is harmless`() {
        val cleared = draft.clearedBy(draft)
        assertEquals(cleared, cleared.clearedBy(draft))
    }
}
