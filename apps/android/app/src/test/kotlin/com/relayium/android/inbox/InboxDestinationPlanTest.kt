package com.relayium.android.inbox

import com.relayium.protocol.inbox.InboxManifestItem
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * A manifest name is an INSTRUCTION to this filesystem, written by another
 * machine that may be compromised. AEAD proves who wrote it, not that it is safe
 * to obey.
 *
 * Every refusal below has a concrete consequence if it were a repair instead:
 * the unattended receiver would create a file the user never approved, under a
 * name nobody chose.
 */
class InboxDestinationPlanTest {

    @get:Rule
    val folder = TemporaryFolder()

    private fun file(name: String, size: Long = 4) = InboxManifestItem.file(name, size)

    private val taskDirectory: File get() = File(folder.root, "Delivery")

    private fun plan(vararg names: String) =
        InboxDestinationPlan.plan(taskDirectory, names.map { file(it) })

    private fun refusal(vararg names: String): InboxPlanException =
        try {
            plan(*names)
            throw AssertionError("expected the plan to be refused")
        } catch (e: InboxPlanException) {
            e
        }

    // ── names this device refuses to create ─────────────────────────────────

    @Test
    fun `a traversing or absolute name is refused`() {
        for (name in listOf(
            "../escape.txt", "a/../../escape.txt", "/etc/passwd",
            "C:/windows/system32", "C:relative", "a/./b.txt", "a//b.txt",
        )) {
            assertNull("accepted '$name'", InboxDestinationPlan.checkedRelativePath(name))
        }
    }

    /**
     * Refused, not stripped. A control character can truncate a C string or
     * rewrite a terminal line; a bidi control makes a name read one way in the
     * UI and another on disk. The interactive download path sanitises because a
     * person is watching — here nobody is.
     */
    @Test
    fun `control and bidi characters are refused rather than stripped`() {
        for (name in listOf("bad\u0000name", "bad\nname", "bad\u007Fname", "bad\u009Fname")) {
            assertNull("accepted a control character", InboxDestinationPlan.checkedRelativePath(name))
        }
        for (name in listOf("in\u202Evoice.txt", "a\u200Fb.txt", "x\u2066y.txt")) {
            assertNull("accepted a bidi control", InboxDestinationPlan.checkedRelativePath(name))
        }
    }

    /** The separator is `/` by protocol. A backslash is a legal POSIX byte and a
     *  separator on Windows, so one manifest would produce two different trees. */
    @Test
    fun `a backslash is refused so every receiver builds the same tree`() {
        assertNull(InboxDestinationPlan.checkedRelativePath("a\\b.txt"))
    }

    /** Windows strips a trailing dot or space silently, so `x ` and `x` collide
     *  there and not here. Refused on both, so a manifest is accepted or refused
     *  identically everywhere. */
    @Test
    fun `trailing dots spaces and reserved device names are refused`() {
        for (name in listOf("report.", "report ", "dir./file.txt", "CON", "nul.txt", "LPT9.dat")) {
            assertNull("accepted '$name'", InboxDestinationPlan.checkedRelativePath(name))
        }
    }

    /**
     * Two names this component owns.
     *
     * A delivery into the staging directory would land ON its own staged source:
     * the commit would link the file to itself and then unlink it, reporting
     * `saved` with nothing on disk. A delivery named like the probe would be
     * deleted by the next readiness check.
     */
    @Test
    fun `a manifest may not name this component's own entries`() {
        assertNull(InboxDestinationPlan.checkedRelativePath(InboxContainer.STAGING))
        assertNull(InboxDestinationPlan.checkedRelativePath(InboxContainer.PROBE))
        // …but only at the top level, where they would actually collide.
        assertNotNull(InboxDestinationPlan.checkedRelativePath("nested/${InboxContainer.PROBE}"))
    }

    /**
     * The receipt name is the sharpest of the reserved set.
     *
     * It is written into the staged tree AFTER every file has been written and
     * digested, so a sender that named a file `.relayium-delivery` would have it
     * silently replaced by the receipt: a delivery that downloaded and verified
     * correctly and arrived corrupted. Refused before a byte moves, including as
     * the root of a path.
     */
    @Test
    fun `a manifest may not name the delivery receipt`() {
        assertNull(InboxDestinationPlan.checkedRelativePath(InboxCommit.RECEIPT_NAME))
        assertNull(
            InboxDestinationPlan.checkedRelativePath("${InboxCommit.RECEIPT_NAME}/inside.txt"),
        )
        assertEquals(
            InboxPlanException.Reason.UNSAFE_NAME,
            refusal("ok.txt", InboxCommit.RECEIPT_NAME).reason,
        )
        // A published directory takes its name from the sender too.
        assertEquals(
            InboxDestinationPlan.DEFAULT_DIRECTORY_NAME,
            InboxDestinationPlan.planTaskDirectory(
                folder.root, listOf(file(InboxCommit.RECEIPT_NAME)), InboxFixtures.TASK_ID,
            ).name,
        )
    }

    @Test
    fun `ordinary names including unicode and nesting are accepted`() {
        val entries = plan("hello.txt", "文档/报告.pdf", "a/b/c/deep.bin", "emoji 🎉.png")
        assertEquals(4, entries.size)
        assertEquals("hello.txt", entries[0].name)
        assertTrue(entries[1].destination.endsWith("文档/报告.pdf"))
        assertTrue(entries[3].destination.endsWith("emoji 🎉.png"))
        // Every destination sits inside this delivery's own directory, so none
        // can name a path in the container root that the user might own.
        assertTrue(entries.all { it.destination.startsWith(taskDirectory.path) })
    }

    @Test
    fun `depth beyond the bound is refused`() {
        val deep = (1..40).joinToString("/") { "d$it" } + "/file.txt"
        assertNull(InboxDestinationPlan.checkedRelativePath(deep))
        val fine = (1..30).joinToString("/") { "d$it" } + "/file.txt"
        assertNotNull(InboxDestinationPlan.checkedRelativePath(fine))
    }

    // ── the published directory ─────────────────────────────────────────────

    /**
     * A delivery publishes its own directory, so an existing folder is stepped
     * around rather than merged into — and the user's own files in the container
     * root are never candidates for anything.
     */
    @Test
    fun `an existing directory is stepped around`() {
        File(folder.root, "report").mkdirs()
        val chosen = InboxDestinationPlan.planTaskDirectory(
            folder.root, listOf(file("report.pdf")), InboxFixtures.TASK_ID,
        )
        assertEquals("report (2)", chosen.name)
    }

    @Test
    fun `the directory is named from what was actually sent`() {
        assertEquals(
            "holiday",
            InboxDestinationPlan.planTaskDirectory(
                folder.root, listOf(file("holiday/one.jpg"), file("holiday/two.jpg")),
                InboxFixtures.TASK_ID,
            ).name,
        )
        assertEquals(
            "report",
            InboxDestinationPlan.planTaskDirectory(
                folder.root, listOf(file("report.pdf")), InboxFixtures.TASK_ID,
            ).name,
        )
    }

    /** A folder name comes from the sender too, so it goes through the same
     *  refusal every other name does. */
    @Test
    fun `an unusable manifest name falls back to a safe directory name`() {
        val chosen = InboxDestinationPlan.planTaskDirectory(
            folder.root, listOf(file("\u202Eevil")), InboxFixtures.TASK_ID,
        )
        assertEquals(InboxDestinationPlan.DEFAULT_DIRECTORY_NAME, chosen.name)
    }

    /**
     * Two entries differing only by case are the sender describing TWO files.
     * Renaming one would hide that this receiver cannot represent what was sent,
     * so it is refused — the same answer every receiver gives.
     */
    @Test
    fun `two entries that resolve to one destination are refused`() {
        assertEquals(
            InboxPlanException.Reason.DUPLICATE_DESTINATION,
            refusal("Report.PDF", "report.pdf").reason,
        )
        assertEquals(
            InboxPlanException.Reason.DUPLICATE_DESTINATION,
            refusal("a.txt", "a.txt").reason,
        )
    }

    /** The index is carried so the caller can say WHICH entry was refused; the
     *  name never is, because it is the user's own content. */
    @Test
    fun `a refusal names the index and not the name`() {
        val e = refusal("fine.txt", "../escape.txt")
        assertEquals(InboxPlanException.Reason.UNSAFE_NAME, e.reason)
        assertEquals(1, e.index)
        assertTrue(e.message!!.contains("1"))
        assertTrue("a refusal must not carry the name", !e.message!!.contains("escape"))
    }

    /** A message has no destination at all, and a plan built for one would be a
     *  disguised `.txt` feature. */
    @Test
    fun `a text manifest has no destination plan`() {
        val e = try {
            InboxDestinationPlan.plan(taskDirectory, listOf(InboxManifestItem.text(12)))
            throw AssertionError("expected a refusal")
        } catch (thrown: InboxPlanException) {
            thrown
        }
        assertEquals(InboxPlanException.Reason.NOT_A_FILE_MANIFEST, e.reason)
    }

    /**
     * The directory name is fixed before anything is downloaded, which is what
     * makes a crash resumable: choosing it again later — against a container
     * that now holds this task's OWN published output — would walk the suffix
     * forward and publish the same delivery twice.
     */
    @Test
    fun `a directory name chosen twice against its own output would drift`() {
        val items = listOf(file("report.pdf"))
        val first = InboxDestinationPlan.planTaskDirectory(folder.root, items, InboxFixtures.TASK_ID)
        assertEquals("report", first.name)
        first.mkdirs()
        val second = InboxDestinationPlan.planTaskDirectory(folder.root, items, InboxFixtures.TASK_ID)
        assertEquals(
            "this is exactly why the directory is journalled, not recomputed",
            "report (2)", second.name,
        )
    }
}
