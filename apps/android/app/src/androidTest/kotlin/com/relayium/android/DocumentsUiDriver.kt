package com.relayium.android

import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.regex.Pattern

/**
 * Driving the SYSTEM document picker.
 *
 * Extracted so the session surface and the cloud surface drive one
 * implementation rather than two: DocumentsUI's affordances differ across AOSP
 * releases in ways that took several observed failures to get right (a
 * background "Recent" tile that shadows the provider root, a confirm button
 * that is present but disabled, a consent dialog whose TITLE also contains the
 * word the button does), and a second copy of that knowledge would be a second
 * thing to keep correct.
 *
 * The system picker is the SYSTEM's UI: it stays in the device's language even
 * when the app under test has been switched to another, so every selector here
 * is an English DocumentsUI label and nothing here is localised.
 *
 * Readiness is always a parameter rather than a session field, because "the app
 * consumed the grant" is a different observable on each surface.
 */
object DocumentsUiDriver {

    const val DOCS_PKG = "com.android.documentsui"

    private val device: UiDevice
        get() = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())

    /** Case-insensitive substring match on text OR content-description:
     *  DocumentsUI capitalises labels differently across releases ("Use this
     *  folder" rendered USE THIS FOLDER) and exposes some affordances only by
     *  description, so both are tried. */
    fun byLabel(label: String): androidx.test.uiautomator.BySelector = By.text(
        Pattern.compile(".*" + Pattern.quote(label) + ".*", Pattern.CASE_INSENSITIVE),
    )

    fun byDesc(label: String): androidx.test.uiautomator.BySelector = By.desc(
        Pattern.compile(".*" + Pattern.quote(label) + ".*", Pattern.CASE_INSENSITIVE),
    )

    /**
     * The visible labels of the SYSTEM PICKER, so a selector that stopped
     * matching a new DocumentsUI names what it actually saw instead of
     * producing a bare timeout. Bounded.
     *
     * ## Why this is scoped to one package and then redacted anyway
     *
     * Every caller is an ERROR path, and the loudest error path is "the picker
     * never appeared" — which is exactly the case where the foreground is the
     * APP, showing a finished upload's link. That link carries the decryption
     * key, and a failure message is a durable artifact: an instrumentation log,
     * a CI record, a bug report. A comment telling callers not to dump while a
     * secret is on screen would be no protection at all, because no caller
     * chooses to; the failure does.
     *
     * So the scope is structural — only `com.android.documentsui` nodes are
     * even collected — and a second, defensive pass drops anything that looks
     * like a key or a link fragment, so a future picker that somehow surfaces
     * app text still cannot leak one.
     */
    fun uiDump(): String =
        device.findObjects(By.pkg(DOCS_PKG))
            .mapNotNull { o -> (o.text ?: o.contentDescription)?.takeIf { t -> t.isNotBlank() } }
            .map(::redact)
            .distinct().take(40).joinToString(" | ")

    /** Anything that could be a stored key or the link carrying one. The
     *  43-character rule is the exact length of a 32-byte key in unpadded
     *  base64url; the substring rules catch the link around it. */
    private fun redact(label: String): String = when {
        label.contains("#k=") || label.contains("/d/") -> "<redacted link>"
        Regex("[A-Za-z0-9_-]{43}").containsMatchIn(label) -> "<redacted key-shaped text>"
        else -> label
    }

    /**
     * Find a DocumentsUI affordance by text or description and click it,
     * re-finding on a `StaleObjectException`.
     *
     * DocumentsUI animates between the roots drawer, the directory list and the
     * confirm bar, so a reference found a frame before the click can go stale
     * mid-transition; the fix is to look it up again, not to sleep and hope.
     */
    fun tap(label: String, what: String, requireEnabled: Boolean = false) {
        val deadline = System.currentTimeMillis() + 25_000
        var lastSeen = ""
        while (System.currentTimeMillis() < deadline) {
            val obj = device.wait(Until.findObject(byLabel(label)), 2_000)
                ?: device.findObject(byDesc(label))
            if (obj != null) {
                try {
                    // The tree-confirm button ("Use this folder") is DISABLED
                    // until a selectable root is actually chosen; clicking it
                    // then does nothing. Wait for it to become enabled rather
                    // than tapping a dead control.
                    if (requireEnabled && !obj.isEnabled) {
                        lastSeen = "$label present but disabled"
                    } else {
                        obj.click()
                        return
                    }
                } catch (_: StaleObjectException) {
                    // The view moved under us; re-find on the next loop.
                }
            } else {
                lastSeen = uiDump()
            }
        }
        error("DocumentsUI never let $what ('$label') be tapped; last visible: $lastSeen")
    }

    /**
     * Complete a fresh tree grant.
     *
     * Click the scoped-access ALLOW dialog if the platform shows one, or confirm
     * the app returned (DocumentsUI gone and [consumed] true) if it auto-granted.
     * Fails only if neither happens within the bound — i.e. the picker is
     * genuinely stuck — rather than falling through while it is still open.
     */
    fun confirmTreeGrant(consumed: () -> Boolean) {
        // EXACT "Allow", not a substring: the dialog TITLE ("Allow Relayium to
        // access files in Relayium test tree?") also contains "Allow" and is an
        // enabled TextView, so a `.*Allow.*` match clicks the title and the
        // grant never happens — which is exactly how a run hung here with the
        // consent dialog still on screen. `^Allow$` targets the BUTTON.
        val allowButton = By.text(Pattern.compile("^Allow$", Pattern.CASE_INSENSITIVE))
        val deadline = System.currentTimeMillis() + 25_000
        while (System.currentTimeMillis() < deadline) {
            val allow = device.wait(Until.findObject(allowButton), 1_000)
            if (allow != null) {
                try {
                    if (allow.isEnabled) {
                        allow.click()
                        // The grant is only real once the dialog is GONE and the
                        // app has consumed the prompt — not the moment the click
                        // is dispatched.
                        device.wait(Until.gone(allowButton), 5_000)
                        if (waitConsumed(consumed)) return
                    }
                } catch (_: StaleObjectException) { /* re-find */ }
            }
            // Auto-grant path: no dialog, the picker closed and the app returned.
            val docsUiGone = device.wait(
                Until.gone(By.pkg(DOCS_PKG).depth(0)), 500,
            ) ?: false
            if (docsUiGone && consumed()) return
        }
        error("the scoped-access grant never completed; visible: ${uiDump()}")
    }

    /** True once the app has left the folder prompt, within a short bound — the
     *  observable that the grant actually reached the app. */
    fun waitConsumed(consumed: () -> Boolean): Boolean {
        val until = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < until) {
            if (consumed()) return true
            Thread.sleep(50)
        }
        return false
    }

    /**
     * Enter the disposable provider's ROOT from the roots DRAWER.
     *
     * Shared by both pickers, and the scoping is the whole point. Each picker's
     * home screen carries a BACKGROUND tile labelled "Relayium test tree" — the
     * file picker's "Recent" apps row, and the tree picker's own home — and that
     * tile stays in the view tree even after the drawer opens. A bare label
     * match therefore selects the wrong node and the picker stays where it was,
     * which is exactly how a tree grant came back rooted at the DEVICE storage
     * root instead of the provider.
     *
     * So the row is taken from the drawer's `roots_list` and from nowhere else.
     */
    fun enterTestRootFromDrawer() {
        device.wait(Until.findObject(By.pkg(DOCS_PKG).depth(0)), 20_000)
            ?: error("the system picker never appeared; visible: ${uiDump()}")
        // The drawer toggle is labelled differently across releases, so fall
        // back to the same alternatives `openRoots` tries rather than failing on
        // the first name.
        val toggle = device.wait(Until.findObject(By.desc("Show roots")), 8_000)
        if (toggle != null) toggle.click() else openRoots()
        val rootsList = device.wait(Until.findObject(By.res(DOCS_PKG, "roots_list")), 8_000)
            ?: error("the roots drawer never opened; visible: ${uiDump()}")
        val rootRow = rootsList.findObject(By.textContains("Relayium test tree"))
            ?: error("the test root is not in the drawer's roots list; visible: ${uiDump()}")
        try {
            rootRow.click()
        } catch (_: StaleObjectException) {
            device.findObject(By.res(DOCS_PKG, "roots_list"))
                ?.findObject(By.textContains("Relayium test tree"))?.click()
        }
    }

    /**
     * Enter the provider root, then tap a document in it.
     *
     * Readiness is the provider's OWN document list appearing — the target
     * present — which is how a stale home view is told apart from the real root
     * having loaded.
     */
    fun enterTestRootThenTap(fileName: String) {
        enterTestRootFromDrawer()
        device.wait(Until.findObject(byLabel(fileName)), 20_000)
            ?: error("the provider root never listed $fileName after entering it; visible: ${uiDump()}")
        tap(fileName, "the staged outgoing document")
    }

    /**
     * Enter the provider root in the TREE picker and descend into one of its
     * directories.
     *
     * The directory is confirmed to be listed BEFORE it is tapped, for the same
     * reason the file picker waits: a tap dispatched at a view that has not
     * loaded silently does nothing, and the grant that follows is then rooted
     * wherever the picker happened to be — the device storage root, not the
     * folder the test meant. Failing here names what was on screen instead.
     */
    fun enterTestRootThenOpenDirectory(directoryName: String) {
        enterTestRootFromDrawer()
        device.wait(Until.findObject(byLabel(directoryName)), 20_000)
            ?: error(
                "the provider root never listed the directory '$directoryName'; " +
                    "visible: ${uiDump()}",
            )
        tap(directoryName, "the destination subfolder")
        // Inside it now: the confirm button is only the right one to press once
        // the picker is actually showing this directory.
        device.wait(Until.findObject(byLabel(directoryName)), 10_000)
            ?: error("the picker never showed '$directoryName' as the current folder; visible: ${uiDump()}")
    }

    /** Open the roots drawer if it is not already showing the roots list. AOSP
     *  releases label the toggle differently ("Show roots", a navigation
     *  description) or open it by an edge swipe, so several are tried before
     *  giving up with what was actually on screen. */
    fun openRoots() {
        val opener = device.wait(Until.findObject(byDesc("Show roots")), 5_000)
            ?: device.wait(Until.findObject(byDesc("roots")), 2_000)
            ?: device.wait(Until.findObject(byDesc("navigation")), 2_000)
            ?: device.wait(Until.findObject(byDesc("drawer")), 2_000)
        if (opener != null) {
            opener.click()
            return
        }
        // No labelled toggle: swipe the drawer open from the left edge.
        device.swipe(0, device.displayHeight / 2, device.displayWidth / 2, device.displayHeight / 2, 10)
    }
}
