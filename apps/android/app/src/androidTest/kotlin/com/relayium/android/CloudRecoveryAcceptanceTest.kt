package com.relayium.android

import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import com.relayium.android.account.AccountState
import com.relayium.android.cloud.CloudDownloadModel
import com.relayium.android.cloud.CloudHistoryModel
import com.relayium.android.cloud.CloudSelection
import com.relayium.android.cloud.CloudUploadModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * **Recoverable cloud uploads, on a device, across a real process death.**
 *
 * The four phases below are separate `@Test` methods ON PURPOSE:
 * `ActivityScenario.recreate` is an Activity restart, not a process death, and
 * a resumable upload's whole claim is about the latter. Only the shell half can
 * produce one — it force-stops the app between two instrumentation runs — so the
 * phases have to be independently addressable and must communicate through the
 * only thing that survives: files on the device.
 *
 * `scripts/android-cloud-recovery-acceptance.sh` is what orders them:
 *
 *   1. [stageAndInterruptAnUpload] signs in, stages a selection larger than the
 *      resumable threshold, lets the server commit part of it, and stops. The
 *      job, its content key and its spool stay on disk. It records the fixture's
 *      digest and the job's identity in a report the next process reads back.
 *   2. **the shell force-stops the app.** Not a recreation, not a cancellation —
 *      the process is killed.
 *   3. [resumeTheInterruptedUploadInAFreshProcess] launches into a process that
 *      has never seen the user's files, finds the offer, taps Resume, and takes
 *      the upload to a link.
 *   4. [theResumedObjectDecodesToTheOriginalBytes] downloads what the server now
 *      holds through the app's own receive path into a granted tree and compares
 *      SHA-256 against the digest phase one recorded. That is the only proof
 *      that a resumed stream is the SAME ciphertext rather than a re-encryption.
 *   5. [historyListsTheObjectAndDeletesItOnConfirmation] exercises the file list
 *      the upload produced: server facts, a rebuildable link, and a confirmed
 *      delete.
 *
 * No report contains a link: a stored link carries its decryption key.
 */
@RunWith(AndroidJUnit4::class)
@LargeTest
class CloudRecoveryAcceptanceTest {

    @get:Rule
    val compose = createEmptyComposeRule()

    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun s(id: Int) = context.getString(id)

    private val origin get() = InteropDriver.requireArg("relayium.origin")
    private val email get() = InteropDriver.requireArg("relayium.email")
    private val password get() = InteropDriver.requireArg("relayium.password")

    /** Comfortably over [CloudUploadModel.RESUMABLE_MIN_BYTES], so the product's
     *  own routing rule — not a test override — puts this on the durable path. */
    private val fixtureBytes = 12 * 1024 * 1024

    private fun button(text: String) = compose.onNode(hasText(text) and hasClickAction())

    private companion object {
        /** The destination subtree name, distinct from the staging root. */
        const val DEST = "cloud-recovery-destination"
    }

    private fun upload() = InteropDriver.viewModel().cloudUpload

    private fun scenarioOnCloudTab(): ActivityScenario<MainActivity> {
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        val vm = InteropDriver.viewModel()
        assertEquals("the app must be on this run's local backend", origin, vm.backendOrigin)
        compose.waitForIdle()
        button(s(R.string.tab_cloud)).performClick()
        compose.waitForIdle()
        return scenario
    }

    private fun signIn() {
        val vm = InteropDriver.viewModel()
        if (vm.account.state.value is AccountState.Ready) return
        vm.account.signIn(email, password)
        InteropDriver.awaitTrue("the account to be ready") {
            vm.account.state.value is AccountState.Ready
        }
    }

    /**
     * The signed-in account's id, read from published state.
     *
     * `AccountSession.authority()` is owner-confined and must be called from the
     * dispatcher that owns it; this reads the same identity out of the
     * `StateFlow` the UI renders from, which is what a test thread may do.
     */
    private fun signedInAccountId(): String =
        (InteropDriver.viewModel().account.state.value as AccountState.Ready).user.id

    /** Deterministic bytes, so a digest identifies them across two processes. */
    private fun fixture(): ByteArray = ByteArray(fixtureBytes) { (it * 31 + 7).toByte() }

    /**
     * A destination subtree, separate from where the outgoing fixture is staged.
     *
     * Sharing one tree would put a document of the same name in the destination
     * before the save, and the receive store refuses to overwrite — correctly.
     */
    private fun destinationTree(): android.net.Uri {
        val resolver = context.contentResolver
        val authority = "${context.packageName}.testdocs"
        val root = android.provider.DocumentsContract.buildDocumentUri(authority, "root")
        val existing = android.provider.DocumentsContract.buildDocumentUri(authority, DEST)
        runCatching { android.provider.DocumentsContract.deleteDocument(resolver, existing) }
        android.provider.DocumentsContract.createDocument(
            resolver, root, android.provider.DocumentsContract.Document.MIME_TYPE_DIR, DEST,
        ) ?: error("could not create the destination subtree")
        return android.provider.DocumentsContract.buildTreeDocumentUri(authority, DEST)
    }

    private fun readInDestination(name: String): ByteArray? {
        val authority = "${context.packageName}.testdocs"
        val document = android.provider.DocumentsContract.buildDocumentUri(authority, "$DEST/$name")
        return runCatching {
            context.contentResolver.openInputStream(document)?.use { it.readBytes() }
        }.getOrNull()
    }

    // ── phase 1: stage, start, and be interrupted ───────────────────────────

    @Test
    fun stageAndInterruptAnUpload() {
        // Deliberately NOT `use`: closing the Activity clears the ViewModel,
        // which cancels the upload — and a cancelled upload is not the thing
        // under test. This phase starts a transfer and then STAYS ALIVE, in
        // flight, until the shell kills the process out from under it.
        ActivityScenario.launch(MainActivity::class.java)
        val vm = InteropDriver.viewModel()
        assertEquals("the app must be on this run's local backend", origin, vm.backendOrigin)
        compose.waitForIdle()
        button(s(R.string.tab_cloud)).performClick()
        compose.waitForIdle()
        signIn()

        val payload = fixture()
        val digest = InteropDriver.sha256(payload)
        val uri = InteropDriver.stageOutgoing("resume-me.bin", payload)

        val model = upload()
        model.select(
            listOf(CloudSelection(uri.toString(), "resume-me.bin", payload.size.toLong())),
            model.beginSelection(),
        )
        InteropDriver.awaitTrue("the selection to be describable") {
            model.state.value is CloudUploadModel.State.Selected
        }
        // The product's own threshold decides this, and the surface says so
        // before the upload starts rather than after an interruption.
        compose.onNode(hasText(s(R.string.cloud_background_note))).performScrollTo()

        model.upload()
        val accountId = signedInAccountId()
        val store = vm.cloudPending
        // Armed once a SERVER SESSION exists and bytes are moving: that is the
        // earliest moment at which a kill can prove anything, and the latest at
        // which the upload is certainly still incomplete.
        InteropDriver.awaitTrue("a resumable session with bytes in flight", 600_000) {
            val plan = store.pending(accountId)
            plan?.uploadId != null && model.state.value.let {
                it is CloudUploadModel.State.Uploading && it.sent > 0
            }
        }
        val plan = store.pending(accountId)!!
        val sent = (model.state.value as CloudUploadModel.State.Uploading).sent

        // The job's IDENTITY, so the next process can be shown to have replayed
        // this spool under this session rather than re-staging or
        // re-initialising. Decoded plaintext alone cannot tell those apart.
        InteropDriver.report(
            "cloud-recovery-staged",
            mapOf(
                "digest" to digest,
                "bytes" to payload.size,
                "staged" to true,
                "jobId" to plan.jobId,
                "uploadId" to plan.uploadId,
                "payloadTotal" to plan.payloadTotal,
                "spoolSha256" to plan.spoolSha256,
                "finalizeAttempted" to plan.finalizeAttempted,
                "sentBeforeInterruption" to sent,
            ),
        )
        // Written LAST, and it is what the shell polls for. Only once it exists
        // is there a session, a spool and an upload in flight to interrupt.
        InteropDriver.report("cloud-recovery-armed", mapOf("armed" to true))

        // Hold the process here, transferring, until `am force-stop` ends it.
        // The instrumentation run is expected to die rather than to pass; the
        // shell treats that as this phase's success condition.
        while (true) {
            Thread.sleep(200)
        }
    }

    // ── phase 2: a process that has never seen the user's files ─────────────

    @Test
    fun resumeTheInterruptedUploadInAFreshProcess() {
        scenarioOnCloudTab().use {
            signIn()
            val model = upload()
            // Recovery is an OFFER, made from this device's own disk. It must
            // appear without any transfer having been started on the user's
            // behalf.
            InteropDriver.awaitTrue("the interrupted upload to be offered", 60_000) {
                model.state.value is CloudUploadModel.State.Interrupted
            }
            val offered = model.state.value as CloudUploadModel.State.Interrupted
            assertTrue("a staged job must be resumable after a process death", offered.resumable)
            assertEquals(1, offered.files)

            // Read BEFORE resuming: the identity the next report is compared
            // against, so "it replayed the same ciphertext under the same
            // session" is a recorded fact rather than an inference from the
            // plaintext that came out at the end.
            val recovered = InteropDriver.viewModel().cloudPending.pending(signedInAccountId())!!
            assertFalse(
                "a job that had not attempted finalize must not claim to have",
                recovered.finalizeAttempted,
            )
            compose.waitForIdle()

            // Through the real button, not the model, because the offer is the
            // product here.
            button(s(R.string.cloud_pending_resume)).performScrollTo().performClick()
            InteropDriver.awaitTrue("the resumed upload to produce a link", 300_000) {
                model.state.value is CloudUploadModel.State.Ready
            }
            val ready = model.state.value as CloudUploadModel.State.Ready
            assertTrue("the link must be on this app's own origin", ready.link.startsWith("$origin/d/"))
            assertNull("a finished upload leaves no notice", model.notice.value)

            InteropDriver.report(
                "cloud-recovery-resumed",
                mapOf(
                    "resumed" to true,
                    "files" to ready.files,
                    "expiresAt" to ready.expiresAt,
                    // The id only. The link carries the key and never leaves the
                    // device except through an explicit copy or share.
                    "objectId" to ready.link.substringAfter("/d/").substringBefore('#'),
                    // Identity as this process found it on disk, for comparison
                    // against phase one's.
                    "jobId" to recovered.jobId,
                    "uploadId" to recovered.uploadId,
                    "payloadTotal" to recovered.payloadTotal,
                    "spoolSha256" to recovered.spoolSha256,
                ),
            )
        }
    }

    // ── phase 3: the bytes are the bytes ────────────────────────────────────

    @Test
    fun theResumedObjectDecodesToTheOriginalBytes() {
        scenarioOnCloudTab().use {
            signIn()
            val vm = InteropDriver.viewModel()
            // The link comes from the app's own file list, which is the surface
            // under test: only this device kept the key.
            val history = vm.cloudHistory
            history.refresh()
            InteropDriver.awaitTrue("the file list to load", 60_000) {
                history.state.value is CloudHistoryModel.State.Ready
            }
            val entries = (history.state.value as CloudHistoryModel.State.Ready).entries
            assertEquals("exactly one object should exist", 1, entries.size)
            val link = entries.single().link
            assertNotNull("this device uploaded it, so it must hold the key", link)

            val destination = destinationTree()
            vm.cloudDownload.open(link!!)
            InteropDriver.awaitTrue("the object's manifest to load", 120_000) {
                vm.cloudDownload.state.value is CloudDownloadModel.State.Ready
            }
            // Through the same seam a granted folder arrives on, so the save
            // crosses the real `content://` boundary.
            vm.cloudFolderPicked(destination, vm.cloudDownload.currentTransfer())
            InteropDriver.awaitTrue("the object to be saved", 300_000) {
                vm.cloudDownload.state.value is CloudDownloadModel.State.Done
            }

            val saved = readInDestination("resume-me.bin")
            assertNotNull("the resumed object must have been written", saved)
            val digest = InteropDriver.sha256(saved!!)
            InteropDriver.report(
                "cloud-recovery-decoded",
                mapOf("savedDigest" to digest, "bytes" to saved.size),
            )
        }
    }

    // ── phase 4: the file list, and a confirmed delete ──────────────────────

    @Test
    fun historyListsTheObjectAndDeletesItOnConfirmation() {
        scenarioOnCloudTab().use {
            signIn()
            val vm = InteropDriver.viewModel()
            val history = vm.cloudHistory
            history.refresh()
            InteropDriver.awaitTrue("the file list to load", 60_000) {
                history.state.value is CloudHistoryModel.State.Ready
            }
            val entry = (history.state.value as CloudHistoryModel.State.Ready).entries.single()
            assertTrue("the server states a size", entry.size > 0)
            assertTrue("the server states an expiry", entry.expiresAt > 0)
            assertFalse("nothing has downloaded it in this phase", entry.burnAfterRead)

            compose.waitForIdle()
            // Deletion is destructive and is confirmed, through the real dialog.
            button(s(R.string.cloud_history_delete)).performScrollTo().performClick()
            compose.waitForIdle()
            compose.onNode(hasText(s(R.string.cloud_history_delete_confirm))).assertIsDisplayed()
            // The dialog's own confirm, not the row button that opened it: both
            // carry the same label, and the last one in the tree is the dialog's.
            val confirms = compose.onAllNodes(
                hasText(s(R.string.cloud_history_delete)) and hasClickAction(),
            )
            confirms[confirms.fetchSemanticsNodes().size - 1].performClick()

            InteropDriver.awaitTrue("the delete to report an outcome", 60_000) {
                history.notice.value != null
            }
            // A delete this device performed, told apart from the server merely
            // declining to say whether the object was ever there.
            assertEquals(CloudHistoryModel.Notice.DELETED, history.notice.value)
            val remaining = history.state.value as CloudHistoryModel.State.Ready
            assertTrue("the row goes with the object", remaining.entries.isEmpty())

            InteropDriver.report(
                "cloud-recovery-history",
                mapOf(
                    "listed" to 1,
                    "deleted" to true,
                    "outcome" to history.notice.value.toString(),
                ),
            )
        }
    }
}
