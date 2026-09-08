package com.relayium.android.integration

import android.content.Context
import android.content.Intent
import android.os.ParcelFileDescriptor
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until

/**
 * The system's app chooser, and the separate-UID reader on the other side of it.
 *
 * ## Why this is not the Compose rule's job
 *
 * Once `startActivity` leaves the app, everything on screen belongs to another
 * process — the resolver, or the reader itself. Compose semantics reach neither.
 * This drives the real system UI with UiAutomator, the way the rest of this
 * suite drives `DocumentsUI`.
 *
 * ## Two shapes, and the run must handle both
 *
 * `ACTION_SEND` goes through `Intent.createChooser`, so a chooser ALWAYS
 * appears. `ACTION_VIEW` does not: when exactly one installed app handles the
 * type, Android launches it directly and no resolver is drawn at all. A helper
 * that insisted on a chooser would fail the OPEN leg on precisely the device
 * configuration this suite creates — one app under test, one reader.
 *
 * So [handOffToPrivateReader] waits for EITHER, and in both cases it does not
 * return until the reader is actually in the foreground. "The chooser was
 * dismissed" is not evidence that anything received the grant.
 */
internal object HostInboxLiveChooser {

    /** The reader's `android:label`, as the resolver renders it. */
    const val READER_LABEL = "Private Inbox reader"

    const val READER_PKG = "com.relayium.acceptance.reader"

    private val device: UiDevice
        get() = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())

    /**
     * Complete the hand-off, and do not return until the reader owns the screen.
     *
     * Picking the reader BY NAME rather than taking the only row: a resolver
     * that offered something else — a gallery, a text viewer, the app under test
     * itself — and was answered with "whatever is first" would hand the grant to
     * the wrong process and still look like a pass.
     */
    fun handOffToPrivateReader() {
        // The reader may already be up, if the VIEW resolved directly.
        if (readerIsForeground(SETTLE_MS)) return

        val row = device.wait(Until.findObject(By.text(READER_LABEL)), CHOOSER_MS)
            ?: error(
                "neither the chooser nor the reader appeared; " +
                    "foreground was ${device.currentPackageName}",
            )
        row.click()

        // "Just once" / "Always" — present on some resolver versions, absent on
        // others, and either answer is fine because the reader is uninstalled
        // between runs. Only clicked if it is actually there.
        device.wait(Until.findObject(By.text("Just once")), ONCE_MS)?.click()

        if (!readerIsForeground(FOREGROUND_MS)) {
            error(
                "the reader was chosen but never came to the foreground; " +
                    "foreground was ${device.currentPackageName}",
            )
        }
    }

    /**
     * Wait for the reader's report to be WRITTEN, not merely for it to be up.
     *
     * The report is produced on a worker thread after the activity draws, so a
     * run that read it the instant the reader appeared would race a partially
     * published file. The reader states its own completion on screen, and that
     * is what is waited for. The report itself is judged by whoever needs it —
     * [report] reads it from the test across the UID boundary, and the harness
     * reads it again after a leg. An earlier version of this note claimed the
     * shell was the only side that could; that was the arrangement replaced to
     * fix a revocation false pass, and it is no longer true.
     */
    fun awaitReaderFinished() {
        device.wait(Until.findObject(By.pkg(READER_PKG).depth(0)), FOREGROUND_MS)
            ?: error("the reader is not on screen")
        val done = device.wait(Until.findObject(By.textContains("report ready")), REPORT_MS)
        if (done == null) {
            // The fixture says so itself when it fails, and that is a better
            // report than a timeout: it distinguishes "could not read the grant"
            // from "never ran".
            val failed = device.findObject(By.textContains("fixture failed"))
            if (failed != null) error("the external reader reported that it failed")
            error("the external reader never finished within ${REPORT_MS}ms")
        }
    }

    /** Leave the reader and return to the app under test. */
    fun back() {
        device.pressBack()
        device.wait(Until.gone(By.pkg(READER_PKG).depth(0)), FOREGROUND_MS)
    }

    private fun readerIsForeground(timeoutMs: Long): Boolean =
        device.wait(Until.hasObject(By.pkg(READER_PKG).depth(0)), timeoutMs) == true

    /**
     * **The reader's own report, read across the UID boundary.**
     *
     * The reader is a different application, so its `filesDir` is unreachable
     * from this process by any ordinary means — which is the point of using it.
     * `UiAutomation.executeShellCommand` runs as the SHELL user, and the shell
     * is permitted to `run-as` a debuggable package, so the instrumentation can
     * read the report without the app under test ever gaining that ability.
     *
     * ## Why this cannot be left to the harness
     *
     * The revocation proof has to observe a grant working and then stopping,
     * inside ONE `am instrument` invocation. Every leg's teardown finishes the
     * Activity, `TransferViewModel.onCleared` runs, and it calls
     * `SharedFileGrants.revokeAll()` — "every outstanding capability over this
     * account's deliveries ends with the process that granted it". A baseline
     * taken in one leg and a re-check taken in another would therefore ALWAYS
     * show the grant gone, whatever the account did, and the run would report a
     * revocation it never observed.
     *
     * The returned text is parsed and asserted on. It is never logged: the
     * report carries the delivered file names, which are plaintext-derived.
     */
    fun report(name: String): String? {
        val command = "run-as $READER_PKG cat files/$name"
        val fd = InstrumentationRegistry.getInstrumentation().uiAutomation
            .executeShellCommand(command)
        val text = ParcelFileDescriptor.AutoCloseInputStream(fd).use { stream ->
            stream.readBytes().toString(Charsets.UTF_8)
        }
        return text.takeIf { it.isNotBlank() && it.trimStart().startsWith("{") }
    }

    /** Remove any earlier reports, so a stale one cannot be read as this one. */
    fun clearReports() {
        val fd = InstrumentationRegistry.getInstrumentation().uiAutomation
            .executeShellCommand("run-as $READER_PKG rm -f files/received.json files/recheck.json")
        ParcelFileDescriptor.AutoCloseInputStream(fd).use { it.readBytes() }
    }

    /**
     * Ask the reader to try its RETAINED URIs again.
     *
     * EXPLICIT, because `com.relayium.acceptance.RECHECK` matches none of the
     * reader's intent filters — an implicit send would fail to resolve, and a
     * harness that read that failure as "the reader refused" would score a
     * revocation it never tested. No grant flags and no URI: the whole question
     * is whether what it already holds still works.
     */
    fun recheck(context: Context, nonce: String) {
        context.startActivity(
            Intent("com.relayium.acceptance.RECHECK")
                .setClassName(READER_PKG, "$READER_PKG.Reader")
                .putExtra("nonce", nonce)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }

    /** Poll for a report that is present and parseable. */
    fun awaitReport(name: String, timeoutMs: Long = 30_000): String {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            report(name)?.let { return it }
            Thread.sleep(250)
        }
        error("the external reader never published $name within ${timeoutMs}ms")
    }

    private const val SETTLE_MS = 1_500L
    private const val CHOOSER_MS = 15_000L
    private const val ONCE_MS = 1_500L
    private const val FOREGROUND_MS = 15_000L
    private const val REPORT_MS = 30_000L
}
