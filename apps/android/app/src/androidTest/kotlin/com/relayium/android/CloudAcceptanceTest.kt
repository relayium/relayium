package com.relayium.android

import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import com.relayium.android.account.AccountState
import com.relayium.android.account.KeystoreTokenStore
import com.relayium.android.cloud.CloudDownloadModel
import com.relayium.android.cloud.CloudUploadModel
import com.relayium.protocol.stored.ManifestFile
import com.relayium.protocol.stored.StoredManifest
import com.relayium.protocol.stored.encodeStoreKey
import com.relayium.protocol.stored.encryptChunks
import com.relayium.protocol.stored.encryptManifest
import com.relayium.protocol.stored.generateStoreKey
import com.relayium.protocol.stored.uploadHeader
import java.util.concurrent.TimeUnit
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * **Cloud (stored) transfers, on a device, against a real server.**
 *
 * Driven through the REAL `MainActivity`: the real Compose tree, the real
 * [TransferViewModel] a tap drives, the real OkHttp transports, the real
 * Keystore-held bearer, the real SAF stack, and a real Relayium server the
 * shell half started on the host. Nothing constructs a parallel model.
 *
 * Every expected string is resolved through the app's own resources under the
 * DEVICE's configuration, so the same class run under `en` and `zh-Hans`
 * asserts each localisation rather than hard-coding English.
 *
 * ## What is real, and the one thing that is not
 *
 * The bytes, the encryption, the upload, the anonymous download, the manifest
 * refusals and the documents written into a user-granted tree are all real, and
 * they cross the `content://` provider boundary through `ContentResolver` and
 * `DocumentsContract` exactly as a user's own pick does.
 *
 * Most tests here supply the picker RESULT directly, because the grant a picker
 * returns is the grant [InteropDriver]'s same-uid provider gives — that keeps
 * the byte-level cases (a zero-byte file, a chunk boundary, a hostile manifest)
 * deterministic. [cloudPickersDriveTheSystemPickerAcrossRecreation] does drive
 * the real DocumentsUI, because the cloud surface registers its OWN launchers:
 * `UiSessionAcceptanceTest` proves the session's launchers survive the round
 * trip, and says nothing about these.
 *
 * ## The destination is not the source
 *
 * Outgoing fixtures and saved documents live in DIFFERENT trees. Sharing one
 * would put a document of the same name in the destination before the save, and
 * the receive store refuses to overwrite — correctly. A harness that shared a
 * tree would be reading that refusal as a product failure.
 */
@RunWith(AndroidJUnit4::class)
@LargeTest
class CloudAcceptanceTest {

    @get:Rule
    val compose = createEmptyComposeRule()

    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun s(id: Int) = context.getString(id)

    private val origin get() = InteropDriver.requireArg("relayium.origin")
    private val email get() = InteropDriver.requireArg("relayium.email")
    private val password get() = InteropDriver.requireArg("relayium.password")

    @Before
    fun startFromASignedOutDevice() {
        runCatching { KeystoreTokenStore(context).clear() }
    }

    private fun button(text: String) = compose.onNode(hasText(text) and hasClickAction())

    /** The mandatory preflight: this run must be pointed at its own disposable
     *  server before a credential or a byte goes anywhere. */
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
        vm.account.signIn(email, password)
        InteropDriver.awaitTrue("the account to be ready") {
            vm.account.state.value is AccountState.Ready
        }
    }

    /**
     * A destination subtree, separate from where outgoing fixtures are staged.
     *
     * Created fresh per test and emptied first: a document left by an earlier
     * test would be refused as an existing name, which is the store working and
     * would read here as a failure.
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

    /** Read a document the save wrote into the destination subtree. */
    private fun readInDestination(name: String): ByteArray? {
        val authority = "${context.packageName}.testdocs"
        val uri = android.provider.DocumentsContract.buildDocumentUri(authority, "$DEST/$name")
        return runCatching {
            context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
        }.getOrNull()
    }

    /**
     * Wait for EXACTLY the expected refusal.
     *
     * On the kind, never merely on "a failure": these tests open several links
     * in sequence and the previous refusal is still the current state when the
     * next `open` is issued, so a predicate that asks only whether the state is
     * `Failed` is satisfied by the one before it and asserts about the wrong
     * transfer.
     */
    private fun awaitFailure(expected: com.relayium.android.cloud.CloudFailure.Kind) {
        InteropDriver.awaitTrue("the refusal $expected") {
            val current = downloadState()
            current is CloudDownloadModel.State.Failed && current.failure.kind == expected
        }
    }

    private fun uploadState() = InteropDriver.viewModel().cloudUpload.state.value

    private fun downloadState() = InteropDriver.viewModel().cloudDownload.state.value

    private companion object {
        /** The destination subtree's document id under the test provider root. */
        const val DEST = "cloud-dest"
    }

    // ── the account gate ────────────────────────────────────────────────────

    @Test
    fun uploadingIsGatedOnAnAccountAndReceivingIsNot() {
        scenarioOnCloudTab().use {
            // Signed out: the send half states the server's rule and offers the
            // way to satisfy it. Nothing here is a paywall — storing bytes is
            // metered against an account, and opening a link never is.
            compose.onNode(hasText(s(R.string.cloud_needs_account))).performScrollTo()
            button(s(R.string.cloud_open_account)).assertExists()

            // The receive half is fully usable with no account at all.
            compose.onNode(hasText(s(R.string.cloud_receive_title))).performScrollTo()
            compose.onNode(hasSetTextAction() and hasText(s(R.string.cloud_link_label)))
                .assertExists()

            InteropDriver.report(
                "cloud-account-gate",
                mapOf("sendGated" to true, "receiveOpen" to true),
            )
        }
    }

    // ── the whole round trip ────────────────────────────────────────────────

    /**
     * Upload a mixed selection, then open the resulting link and save it — with
     * the bytes compared by digest at both ends.
     *
     * The sizes are the ones where the stream and the file boundaries disagree:
     * a zero-byte file contributes no frame at all, a file larger than one
     * 192 KiB chunk spans several, and a small one shares a network read with
     * its neighbour.
     */
    @Test
    fun aMixedSelectionUploadsAndComesBackByteForByte() {
        val files = linkedMapOf(
            "cloud-small.txt" to "hello world".toByteArray(),
            "cloud-empty.bin" to ByteArray(0),
            "cloud-big.bin" to ByteArray(192 * 1024 + 37) { (it % 251).toByte() },
        )
        val digests = files.mapValues { InteropDriver.sha256(it.value) }

        scenarioOnCloudTab().use {
            signIn()
            val vm = InteropDriver.viewModel()

            // The picker RESULT, through the real ContentResolver: the app reads
            // each document's display name and size the way it does for a real
            // pick, then opens a real `content://` stream to upload it.
            val uris = files.map { (name, bytes) -> InteropDriver.stageOutgoing(name, bytes) }
            vm.cloudFilesPicked(uris, vm.cloudUpload.beginSelection())
            InteropDriver.awaitTrue("the selection to be described") {
                uploadState() is CloudUploadModel.State.Selected
            }

            compose.waitForIdle()
            button(s(R.string.cloud_upload)).performScrollTo().performClick()
            InteropDriver.awaitTrue("the upload to finish") {
                uploadState() is CloudUploadModel.State.Ready
            }
            val ready = uploadState() as CloudUploadModel.State.Ready
            assertTrue(
                "the link must be composed against this app's own origin",
                ready.link.startsWith("$origin/d/"),
            )
            assertTrue("the server must have granted an expiry", ready.expiresAt > 0)

            // Now the RECEIVING half, driven the way a recipient drives it: the
            // link goes into the field, and the app fetches metadata anonymously.
            compose.onNode(hasSetTextAction() and hasText(s(R.string.cloud_link_label)))
                .performScrollTo()
                .performTextInput(ready.link)
            compose.waitForIdle()
            button(s(R.string.cloud_open)).performScrollTo().performClick()
            InteropDriver.awaitTrue("the link to open") {
                downloadState() is CloudDownloadModel.State.Ready
            }
            val opened = downloadState() as CloudDownloadModel.State.Ready
            assertEquals(files.keys.toList(), opened.names)
            assertEquals(files.values.sumOf { it.size.toLong() }, opened.totalBytes)

            // The folder grant a picker would return, over a real provider —
            // and a tree that is NOT where the originals were staged.
            vm.cloudFolderPicked(destinationTree(), vm.cloudDownload.currentTransfer())
            InteropDriver.awaitTrue("the files to be saved") {
                downloadState() is CloudDownloadModel.State.Done
            }

            val saved = files.keys.associateWith { name ->
                val bytes = readInDestination(name)
                assertNotNull("$name was not saved", bytes)
                InteropDriver.sha256(bytes!!)
            }
            for ((name, digest) in digests) {
                assertEquals("$name did not survive the round trip", digest, saved[name])
            }

            InteropDriver.report(
                "cloud-round-trip",
                // The digests, the sizes and the expiry — never the link, which
                // carries the key.
                mapOf(
                    "files" to files.keys.toList().joinToString(","),
                    "digests" to digests.values.joinToString(","),
                    "savedDigests" to saved.values.joinToString(","),
                    "expiresAt" to ready.expiresAt,
                ),
            )
        }
    }

    // ── retention the server actually applied ───────────────────────────────

    /**
     * A burn-after-read object is gone once it has been fetched.
     *
     * The second open is the assertion: the same link, the same key, and the
     * honest answer that the object no longer exists.
     */
    @Test
    fun aBurnAfterReadLinkIsGoneOnceItHasBeenSaved() {
        scenarioOnCloudTab().use {
            signIn()
            val vm = InteropDriver.viewModel()
            val uri = InteropDriver.stageOutgoing("cloud-burn.txt", "burn me".toByteArray())
            vm.cloudFilesPicked(listOf(uri), vm.cloudUpload.beginSelection())
            InteropDriver.awaitTrue("the selection") { uploadState() is CloudUploadModel.State.Selected }

            vm.cloudUpload.chooseBurnAfterRead(true)
            compose.waitForIdle()
            button(s(R.string.cloud_upload)).performScrollTo().performClick()
            InteropDriver.awaitTrue("the upload") { uploadState() is CloudUploadModel.State.Ready }
            val ready = uploadState() as CloudUploadModel.State.Ready
            assertTrue("the object must be marked one-shot", ready.burnAfterRead)

            vm.cloudDownload.open(ready.link)
            InteropDriver.awaitTrue("the link to open") {
                downloadState() is CloudDownloadModel.State.Ready
            }
            assertTrue(
                "a one-time link must say so before it is saved",
                (downloadState() as CloudDownloadModel.State.Ready).burnAfterRead,
            )
            vm.cloudFolderPicked(destinationTree(), vm.cloudDownload.currentTransfer())
            InteropDriver.awaitTrue("the save") { downloadState() is CloudDownloadModel.State.Done }
            assertEquals("burn me", String(readInDestination("cloud-burn.txt")!!))

            // Second attempt: the server deleted it after the first delivery.
            vm.cloudDownload.reset()
            InteropDriver.awaitTrue("the finished save to be cleared") {
                downloadState() is CloudDownloadModel.State.Idle
            }
            vm.cloudDownload.open(ready.link)
            awaitFailure(com.relayium.android.cloud.CloudFailure.Kind.NOT_FOUND)
            compose.waitForIdle()
            compose.onNode(hasText(s(R.string.cloud_error_not_found))).performScrollTo()

            InteropDriver.report("cloud-burn", mapOf("savedOnce" to true, "secondOpenRefused" to true))
        }
    }

    // ── a hostile object, refused before a folder is chosen ─────────────────

    /**
     * A manifest that names something no device may create is refused BEFORE the
     * user is asked where to put it, and nothing is created in their tree.
     *
     * The object is uploaded by a different client — this test, speaking the
     * wire directly — because the app's own sender would never compose one.
     * That is the point: the receiver's refusal cannot depend on the sender
     * being well behaved.
     */
    @Test
    fun aTraversingManifestIsRefusedBeforeAnyDocumentIsCreated() {
        scenarioOnCloudTab().use {
            signIn()
            val vm = InteropDriver.viewModel()
            val before = InteropDriver.listTree()

            val link = uploadHostileObject(
                StoredManifest(listOf(ManifestFile("../escaped.txt", 5))),
                listOf("evil!".toByteArray()),
            )
            vm.cloudDownload.open(link)
            awaitFailure(com.relayium.android.cloud.CloudFailure.Kind.UNSAFE_NAME)
            compose.waitForIdle()
            compose.onNode(hasText(s(R.string.cloud_error_unsafe_name))).performScrollTo()
            assertEquals("nothing may be created for a refused manifest", before, InteropDriver.listTree())

            // The same rule for two entries that would land on one document.
            val colliding = uploadHostileObject(
                StoredManifest(listOf(ManifestFile("same.txt", 1), ManifestFile("same.txt", 1))),
                listOf(byteArrayOf(1), byteArrayOf(2)),
            )
            // Cleared and OBSERVED cleared before the next link: the previous
            // refusal is still on screen, and a predicate that only asks "is it
            // Failed?" matches that stale state immediately and asserts about
            // the wrong transfer.
            vm.cloudDownload.reset()
            InteropDriver.awaitTrue("the previous refusal to be cleared") {
                downloadState() is CloudDownloadModel.State.Idle
            }
            vm.cloudDownload.open(colliding)
            awaitFailure(com.relayium.android.cloud.CloudFailure.Kind.NAME_COLLISION)
            assertEquals(before, InteropDriver.listTree())

            InteropDriver.report(
                "cloud-hostile-manifest",
                mapOf("traversalRefused" to true, "collisionRefused" to true, "treeUntouched" to true),
            )
        }
    }

    // ── the link survives recreation, and never reaches saved state ─────────

    /**
     * A finished upload survives an Activity recreation, and the link does NOT
     * appear in saved instance state.
     *
     * Both halves matter. The ViewModel outlives a rotation, which is the
     * lifetime the result actually has; the saved-state `Bundle` is written to
     * disk and restored into a later process, so a link in it would be a
     * decryption key persisted by the UI.
     */
    @Test
    fun aFinishedUploadSurvivesRecreationWithoutEnteringSavedState() {
        scenarioOnCloudTab().use { scenario ->
            signIn()
            val vm = InteropDriver.viewModel()
            val uri = InteropDriver.stageOutgoing("cloud-rotate.txt", "rotate".toByteArray())
            vm.cloudFilesPicked(listOf(uri), vm.cloudUpload.beginSelection())
            InteropDriver.awaitTrue("the selection") { uploadState() is CloudUploadModel.State.Selected }
            compose.waitForIdle()
            button(s(R.string.cloud_upload)).performScrollTo().performClick()
            InteropDriver.awaitTrue("the upload") { uploadState() is CloudUploadModel.State.Ready }
            val link = (uploadState() as CloudUploadModel.State.Ready).link

            scenario.recreate()
            compose.waitForIdle()
            button(s(R.string.tab_cloud)).performClick()
            compose.waitForIdle()

            val after = uploadState()
            assertTrue("the finished upload must survive recreation", after is CloudUploadModel.State.Ready)
            assertEquals(link, (after as CloudUploadModel.State.Ready).link)

            // That the key never reaches saved instance state is a SOURCE
            // property — the receive field is a ViewModel draft rather than a
            // `rememberSaveable` — and it is guarded as one, by
            // `scripts/test/android-policy-test.mjs`. Asserting it from here
            // would mean calling a protected `onSaveInstanceState`, which is
            // not reachable and would prove less: a future `rememberSaveable`
            // anywhere in the cloud UI is what the guard actually catches.
            val key = link.substringAfter("#k=")
            assertFalse("the link must carry a key at all", key.isEmpty())

            InteropDriver.report(
                "cloud-recreation",
                mapOf("linkSurvived" to true),
            )
        }
    }

    // ── the cloud surface's OWN launchers, through the system picker ────────

    /**
     * The real DocumentsUI, driven through the cloud surface's own launchers,
     * across an Activity recreation.
     *
     * This is the case the other tests deliberately do not cover. They supply
     * the picker RESULT; this one proves the parts only the system can exercise:
     * that the cloud file and folder launchers really receive a system result,
     * that they still do after the Activity has been recreated, and that a tree
     * granted by the SYSTEM — not by a same-uid provider — is one the save can
     * write into.
     *
     * `UiSessionAcceptanceTest` proves this for the SESSION launchers. These are
     * different launchers with different results, so that run says nothing
     * about them.
     *
     * ## What this does NOT prove
     *
     * The recreation here happens BETWEEN the two pickers, not while one is
     * open. So it covers launching a picker after a recreation; it does NOT
     * cover a result arriving into a recreated Activity while that picker was
     * still open — which is where a request token saved across the round trip
     * actually earns its keep, and where the system may kill the Activity
     * behind the picker. That case needs a device-level configuration change or
     * "don't keep activities" while DocumentsUI is foreground, and it is
     * deliberately not claimed here.
     *
     * The system picker stays in the DEVICE's language whatever the app is set
     * to, so its selectors are English here under both app locales.
     */
    @Test
    fun cloudPickersDriveTheSystemPickerAcrossRecreation() {
        val payload = ByteArray(1024) { (it % 97).toByte() }
        val digest = InteropDriver.sha256(payload)
        val fileName = "cloud-picked.bin"

        scenarioOnCloudTab().use { scenario ->
            signIn()
            val vm = InteropDriver.viewModel()
            InteropDriver.stageOutgoing(fileName, payload)
            destinationTree()

            // 1. The real file picker, through the cloud surface's own button.
            compose.waitForIdle()
            button(s(R.string.cloud_choose_files)).performScrollTo().performClick()
            DocumentsUiDriver.enterTestRootThenTap(fileName)
            InteropDriver.awaitTrue("the picked document to be described") {
                uploadState() is CloudUploadModel.State.Selected
            }

            compose.waitForIdle()
            button(s(R.string.cloud_upload)).performScrollTo().performClick()
            InteropDriver.awaitTrue("the upload") { uploadState() is CloudUploadModel.State.Ready }
            val link = (uploadState() as CloudUploadModel.State.Ready).link

            // 2. Recreated between the two halves — which is when a launcher
            //    registered in the wrong place stops receiving results.
            scenario.recreate()
            compose.waitForIdle()
            button(s(R.string.tab_cloud)).performClick()
            compose.waitForIdle()

            vm.cloudDownload.open(link)
            InteropDriver.awaitTrue("the link to open") {
                downloadState() is CloudDownloadModel.State.Ready
            }

            // 3. The real folder picker, into the separate destination subtree.
            compose.waitForIdle()
            button(s(R.string.cloud_choose_folder)).performScrollTo().performClick()
            // Scoped to the drawer's roots list, then INTO the destination
            // subfolder, verified as listed before it is tapped: a broad label
            // tap matches the picker's own background tile and the grant comes
            // back rooted at device storage instead.
            DocumentsUiDriver.enterTestRootThenOpenDirectory(DEST)
            DocumentsUiDriver.tap("Use this folder", "the tree confirm button", requireEnabled = true)
            DocumentsUiDriver.confirmTreeGrant {
                downloadState() !is CloudDownloadModel.State.Ready
            }
            InteropDriver.awaitTrue("the save to finish") {
                downloadState() is CloudDownloadModel.State.Done
            }

            val saved = readInDestination(fileName)
            assertNotNull("the system-granted tree received nothing", saved)
            assertEquals("the picked document did not survive the round trip", digest, InteropDriver.sha256(saved!!))

            InteropDriver.report(
                "cloud-system-picker",
                mapOf("digest" to digest, "savedDigest" to InteropDriver.sha256(saved), "recreated" to true),
            )
        }
    }

    // ── speaking the wire directly, as a different client would ─────────────

    /** Upload an object this app's own sender would never compose, and return
     *  the link that opens it. */
    private fun uploadHostileObject(manifest: StoredManifest, files: List<ByteArray>): String {
        val http = OkHttpClient.Builder()
            .callTimeout(60, TimeUnit.SECONDS)
            .followRedirects(false)
            .build()
        val token = bearer(http)
        val key = generateStoreKey()
        val body = uploadHeader(encryptManifest(key, manifest)) + encryptChunks(key, files)
        val request = Request.Builder()
            .url("$origin/api/files?burnAfterRead=0&ttl=3600")
            .header("Authorization", "Bearer $token")
            .post(body.toRequestBody("application/octet-stream".toMediaType()))
            .build()
        val text = http.newCall(request).execute().use { response ->
            assertEquals("the hostile object must upload", 200, response.code)
            response.body.string()
        }
        val id = Regex("\"id\":\"([A-Za-z0-9_-]+)\"").find(text)?.groupValues?.get(1)
            ?: error("no id in the upload response")
        return "$origin/d/$id#k=${encodeStoreKey(key)}"
    }

    /** A bearer for the fixture account, obtained the way any client would. */
    private fun bearer(http: OkHttpClient): String {
        val login = """{"email":"$email","password":"$password","deviceName":"acceptance"}"""
        val request = Request.Builder()
            .url("$origin/api/auth/native/login")
            .post(login.toRequestBody("application/json; charset=utf-8".toMediaType()))
            .build()
        val text = http.newCall(request).execute().use { response ->
            assertEquals("the fixture account must sign in", 200, response.code)
            response.body.string()
        }
        return Regex("\"token\":\"([^\"]+)\"").find(text)?.groupValues?.get(1)
            ?: error("no token in the login response")
    }
}
