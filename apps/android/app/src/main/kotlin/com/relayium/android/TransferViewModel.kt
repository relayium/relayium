package com.relayium.android

import android.app.Application
import android.net.Uri
import android.provider.OpenableColumns
import androidx.core.net.toUri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.relayium.android.account.AccountAccessDraft
import com.relayium.android.account.AccountClient
import com.relayium.android.account.AccountSession
import com.relayium.android.account.BrowserLoginModel
import com.relayium.android.account.CreateLinkModel
import com.relayium.android.account.KeystoreTokenStore
import com.relayium.android.account.MintedCode
import com.relayium.android.account.pairCode
import com.relayium.android.cloud.CloudClient
import com.relayium.android.cloud.CloudDownloadModel
import com.relayium.android.cloud.CloudHistoryModel
import com.relayium.android.cloud.CloudLinkDraft
import com.relayium.android.cloud.CloudSelection
import com.relayium.android.cloud.CloudUploadModel
import com.relayium.android.cloud.KeystoreSecretBox
import com.relayium.android.cloud.PendingUploadStore
import com.relayium.android.cloud.StoredLinkKeyStore
import com.relayium.android.storage.ProviderOps
import com.relayium.android.storage.ReceiveStore
import java.io.File
import com.relayium.android.update.UpdateChecker
import com.relayium.android.update.UpdateEndpoint
import com.relayium.protocol.FileMeta
import com.relayium.protocol.JoinInput
import com.relayium.protocol.stored.PlaintextSource
import java.util.concurrent.Executors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * The app-side owner of one [TransferController].
 *
 * The ViewModel outlives the Activity through rotation, the system file
 * picker, and every other configuration change, which is exactly the lifetime
 * an active transfer needs. It does NOT outlive the process: when Android
 * stops the app, the session is honestly over and the controller's terminal
 * state says so — there is no background service and no resume claim.
 *
 * Everything Android-typed that the controller must not know about lives
 * here: content-resolver metadata queries, SAF tree resolution, and the
 * LINK TOKEN that fences system-picker results (see [linkToken]).
 */
class TransferViewModel(app: Application) : AndroidViewModel(app) {

    private val saf: ProviderOps.Saf
    private val controller: TransferController

    /**
     * The origin this ViewModel's controller ACTUALLY talks to, resolved once
     * at construction. Exposed so the interop acceptance can assert, BEFORE it
     * joins anything, that the app under test is pointed at the throwaway
     * local server. That preflight matters because [Backend.readDebugOverride]
     * reads a non-public class reflectively and FAILS CLOSED to production: a
     * harness that skipped the check could quietly drive a disposable test
     * code against the real service. Reading the resolved value — rather than
     * re-deriving it — is what makes the assertion about this instance.
     */
    val backendOrigin: String

    /**
     * The manual update check.
     *
     * Completely independent of [controller]: it shares no state, no scope
     * cancellation, and no error channel with a transfer. A check cannot
     * interrupt a session or discard a draft because it never touches either,
     * and the UI only draws its row on the join screen — see
     * [com.relayium.android.ui.RelayiumApp].
     */
    val updates: UpdateChecker

    /** The feed this instance ACTUALLY reads, resolved once. Exposed for the
     *  same fail-closed reason as [backendOrigin]: the acceptance asserts the
     *  app under test is pointed at its throwaway feed BEFORE it believes any
     *  update answer it sees, so a reflective override that quietly fell back
     *  to production cannot be mistaken for a working test seam. */
    val updateFeedUrl: String

    /**
     * Who is signed in.
     *
     * A model of its own rather than state on this class, and constructed with
     * injected seams — an HTTP transport, a token store, a dispatcher and a
     * clock — so its ownership rules run under plain JVM tests. Nothing
     * Android-typed reaches it: [KeystoreTokenStore] is passed in as a
     * [com.relayium.android.account.TokenStore], and it never learns what a
     * `Context` is.
     */
    val account: AccountSession

    /** Approving this device in a browser, for the accounts that have no
     *  password at all (Apple/Google sign-in) — this build ships no Google SDK
     *  and there is no other way in for them. */
    val browserLogin: BrowserLoginModel

    /** Minting the six digits a second device joins. */
    val createLink: CreateLinkModel

    /** Uploading files the server holds until someone fetches them. */
    val cloudUpload: CloudUploadModel

    /** Opening a stored link somebody sent. */
    val cloudDownload: CloudDownloadModel

    /** The files this account is storing, and the links this device can still
     *  rebuild for them. */
    val cloudHistory: CloudHistoryModel

    /**
     * Where interrupted uploads are staged.
     *
     * Exposed for the same reason [backendOrigin] is: the on-device acceptance
     * has to assert facts about the ACTUAL durable state this instance owns —
     * that a resumed upload replayed the same spool under the same session
     * rather than re-staging or re-initialising — and re-deriving the path in
     * the harness would be asserting against a second copy of the rule.
     * `internal`, so nothing outside this module can reach it.
     */
    internal val cloudPending: PendingUploadStore

    /**
     * The link the user is part-way through pasting.
     *
     * Owned here rather than by the composable for the same reason the account
     * draft is — and for one more: a stored link carries the KEY in its
     * fragment, so `rememberSaveable` would write a decryption key into saved
     * instance state. See [CloudLinkDraft].
     */
    val cloudLinkDraft = CloudLinkDraft()

    /**
     * The ONE thread that owns the cloud receive store, its destination
     * provider and the transport that feeds them.
     *
     * Single-threaded on purpose: [com.relayium.android.storage.ReceiveStore] is
     * not thread-safe, and its writes, exports and rollbacks must be serialised
     * with each other AND with the chunk callback that drives them. Not the main
     * thread, because all of it is disk and document-provider IO.
     */
    private val cloudStorageExecutor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "relayium-cloud-store").apply { isDaemon = true }
    }

    /**
     * The address and the form mode the user is part-way through typing.
     *
     * Owned HERE rather than by the form composable because the form is removed
     * from the composition while a sign-in is in flight — see
     * [AccountAccessDraft] for the state loss that produced. It survives that
     * round trip, an Activity recreation and a tab change, exactly as the
     * message draft does, and for the same reason: the ViewModel's lifetime is
     * the one the work actually has.
     */
    val accessDraft = AccountAccessDraft()

    init {
        val origin = Backend.resolve(Backend.readDebugOverride())
        backendOrigin = origin
        val (deps, safOps) = RealDeps.create(app, origin, android.os.Build.MODEL ?: "Android")
        saf = safOps
        controller = TransferController(viewModelScope, android.os.Build.MODEL ?: "Android", deps)

        val feedUrl = UpdateEndpoint.resolve(UpdateEndpoint.readDebugOverride())
        updateFeedUrl = feedUrl
        updates = UpdateChecker(
            scope = viewModelScope,
            source = RealDeps.updateSource(),
            feedUrl = feedUrl,
            installedVersionCode = BuildConfig.VERSION_CODE,
            installedVersionName = BuildConfig.VERSION_NAME,
            localeTag = {
                androidx.core.os.ConfigurationCompat
                    .getLocales(app.resources.configuration)
                    .get(0)
                    ?.toLanguageTag()
                    ?: "en"
            },
            openUrl = { url -> openInBrowser(app, url) },
        )

        // ONE dispatcher owns every account state transition (see
        // AccountSession): the main dispatcher, which is single-threaded and
        // serialising and is also where Compose wants the result. All blocking
        // keystore and disk work is handed to `io` from inside it, and the
        // HTTP bodies are consumed on OkHttp's own threads before any
        // continuation resumes here.
        val client = AccountClient(
            com.relayium.android.account.OkHttpAccountTransport(
                origin = origin,
                userAgent = "Relayium-Android/${BuildConfig.VERSION_NAME} (account)",
            ),
        )
        val owner = Dispatchers.Main.immediate
        account = AccountSession(
            scope = viewModelScope,
            owner = owner,
            io = Dispatchers.IO,
            client = client,
            tokenStore = KeystoreTokenStore(app),
            deviceName = android.os.Build.MODEL ?: "Android",
        )
        browserLogin = BrowserLoginModel(
            scope = viewModelScope,
            owner = owner,
            client = client,
            session = account,
            deviceName = android.os.Build.MODEL ?: "Android",
            // The app's OWN resolved origin — the server's verification page
            // must be on it, or the approval URL is refused rather than opened.
            trustedOrigin = origin,
            now = { System.currentTimeMillis() / 1000L },
        )
        createLink = CreateLinkModel(
            scope = viewModelScope,
            owner = owner,
            client = client,
            session = account,
            origin = origin,
            now = { System.currentTimeMillis() / 1000L },
        )

        val cloudUserAgent = "Relayium-Android/${BuildConfig.VERSION_NAME} (cloud)"
        // Both stores live under `noBackupFilesDir` — the platform's own
        // statement that a path is excluded from backup and device transfer —
        // and both are wrapped by one Keystore alias that is deliberately NOT
        // the bearer's: signing out must hide a pending upload, not shred it.
        val cloudSecrets = KeystoreSecretBox()
        val cloudRoot = File(app.noBackupFilesDir, "cloud")
        val pendingUploads = PendingUploadStore(File(cloudRoot, "pending-uploads"), cloudSecrets)
        cloudPending = pendingUploads
        val storedLinkKeys = StoredLinkKeyStore(File(cloudRoot, "stored-link-keys"), cloudSecrets)
        val cloudClient = CloudClient(origin, cloudUserAgent)
        cloudUpload = CloudUploadModel(
            scope = viewModelScope,
            owner = owner,
            io = Dispatchers.IO,
            client = cloudClient,
            session = account,
            // The link is composed against the app's OWN resolved backend, never
            // against anything the server said.
            origin = origin,
            open = { selection -> openForUpload(app, selection) },
            pending = pendingUploads,
            linkKeys = storedLinkKeys,
        )
        cloudHistory = CloudHistoryModel(
            scope = viewModelScope,
            owner = owner,
            io = Dispatchers.IO,
            client = cloudClient,
            session = account,
            origin = origin,
            keys = storedLinkKeys,
        )
        val storage = cloudStorageExecutor.asCoroutineDispatcher()
        cloudDownload = CloudDownloadModel(
            scope = viewModelScope,
            storage = storage,
            // Bound to the store's own thread, so the chunk callback that drives
            // write/export cannot run beside a rollback.
            clientFor = { io -> CloudClient(origin, cloudUserAgent, io = io) },
            origin = origin,
            store = ReceiveStore(File(app.cacheDir, "cloud-incoming")),
        )

        // A shown upload link is a capability for ONE account's files, and so
        // is a staged job and a file list. When the session changes under them —
        // a sign-out, or a sign-in as somebody else — they stop being this
        // user's to see.
        //
        // Recovery runs on the same signal and only when a session is live: it
        // is an offer made from this device's own disk, never a transfer started
        // on the user's behalf.
        viewModelScope.launch {
            account.state.collect { state ->
                cloudUpload.accountChanged()
                cloudHistory.accountChanged()
                if (state is com.relayium.android.account.AccountState.Ready) {
                    cloudUpload.recoverPendingJob()
                }
            }
        }
    }

    /**
     * Open a chosen document as a forward-only plaintext source.
     *
     * The stream is opened ONCE and held for the whole upload, rather than the
     * URI being reopened per chunk: reopening would resolve the same name a
     * second time, and the second resolution is the one that can point at
     * different bytes than the ones the user approved. What this cannot prevent
     * is the document's CONTENT changing in place — which is why the encoder
     * refuses a source that disagrees with the size the manifest declared.
     */
    private fun openForUpload(app: Application, selection: CloudSelection): PlaintextSource? {
        val stream = runCatching {
            app.contentResolver.openInputStream(selection.uri.toUri())
        }.getOrNull() ?: return null
        return object : PlaintextSource {
            override val name = selection.name
            override val size = selection.size

            override fun read(max: Int): ByteArray {
                if (max <= 0) return ByteArray(0)
                val buffer = ByteArray(max)
                var read = 0
                // A content stream may return a short read at any point; only a
                // -1 means the end. Filling the buffer keeps chunks at the wire
                // size instead of producing a stream of small frames.
                while (read < max) {
                    val n = stream.read(buffer, read, max - read)
                    if (n <= 0) break
                    read += n
                }
                return if (read == max) buffer else buffer.copyOf(read)
            }

            override fun close() {
                runCatching { stream.close() }
            }
        }
    }

    /**
     * Resolve what the cloud file picker returned into a describable selection.
     *
     * A document with no display name or no reported size cannot be sent: the
     * manifest commits to both, and the receiver checks the delivered bytes
     * against them. That is reported as its own failure rather than silently
     * dropping the pick.
     *
     * [request] comes from [CloudUploadModel.beginSelection] and is carried
     * through the picker round trip; the MODEL checks it in the same turn that
     * commits the selection, so a slow first pick cannot land on top of a newer
     * one.
     */
    fun cloudFilesPicked(uris: List<Uri>, request: Int) {
        if (uris.isEmpty()) return
        viewModelScope.launch(Dispatchers.IO) {
            val resolver = getApplication<Application>().contentResolver
            val selections = ArrayList<CloudSelection>(uris.size)
            var unreadable = false
            for (uri in uris) {
                var name: String? = null
                var size = -1L
                runCatching {
                    // Exactly the two columns this needs. A null projection asks
                    // a document provider for every column it has, which is more
                    // of the user's metadata than a file picker requires.
                    resolver.query(
                        uri,
                        arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
                        null,
                        null,
                        null,
                    )?.use { cursor ->
                        if (cursor.moveToFirst()) {
                            val nameIx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                            val sizeIx = cursor.getColumnIndex(OpenableColumns.SIZE)
                            if (nameIx >= 0) name = cursor.getString(nameIx)
                            if (sizeIx >= 0 && !cursor.isNull(sizeIx)) size = cursor.getLong(sizeIx)
                        }
                    }
                }
                val resolved = name
                if (resolved.isNullOrBlank() || size < 0) {
                    unreadable = true
                    break
                }
                selections.add(CloudSelection(uri.toString(), resolved, size))
            }
            if (unreadable) {
                cloudUpload.selectionUnreadable(request)
            } else {
                cloudUpload.select(selections, request)
            }
        }
    }

    /**
     * Hand the cloud folder-picker result to the download model.
     *
     * A null tree is the user backing out — not a failure, and the transfer
     * stays open. A tree that will not RESOLVE is a different thing: the grant
     * was revoked or the provider is gone, and the user needs to be told rather
     * than left looking at a button that did nothing.
     *
     * Resolution runs off the main thread: `DocumentFile.fromTreeUri` and the
     * metadata it reads are provider IO. [transfer] identifies the transfer the
     * folder was chosen FOR, and the model rechecks it at the save — a folder
     * picked for one link must not receive another.
     */
    fun cloudFolderPicked(tree: Uri?, transfer: Int) {
        if (tree == null) return
        viewModelScope.launch(Dispatchers.IO) {
            val node = runCatching { RealDeps.resolveTree(saf, tree) }.getOrNull()
            if (node == null) {
                cloudDownload.destinationUnavailable(transfer)
            } else {
                cloudDownload.save(saf, node, transfer)
            }
        }
    }

    /**
     * Hand a URL to whatever the user's system opens links with.
     *
     * `false` means nothing could handle it, which is a real state on a
     * stripped device or an emulator image with no browser: the UI then shows
     * the URL as selectable text instead of leaving a button that does nothing.
     *
     * `NEW_TASK` because the Application context is what this ViewModel holds;
     * without it the launch throws on every Android version.
     */
    private fun openInBrowser(app: Application, url: String): Boolean {
        // DEBUG ONLY in effect: lets the on-device acceptance observe the exact
        // URL the product would open — and answer "no browser" — without
        // navigating out of the app under test. The RELEASE variant of
        // TestHooks declares the same method but returns a constant `null` and
        // has no field to assign, so a release build always falls through to
        // the real launch below.
        TestHooks.updateLauncher()?.let { return it(url) }
        return runCatching {
            app.startActivity(
                android.content.Intent(android.content.Intent.ACTION_VIEW, url.toUri())
                    .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }.isSuccess
    }

    val state: StateFlow<TransferController.State> get() = controller.state

    /**
     * The plaintext message DRAFT, with the identity of what it was typed
     * against.
     *
     * In memory only, on purpose: the text contract is that message plaintext
     * exists nowhere but this process, so the draft must never enter
     * `rememberSaveable`/`SavedStateHandle` — those are Android
     * saved-instance state, written outside the app's memory. The ViewModel
     * already survives rotation and the picker round-trip, which is exactly
     * the lifetime the field needs; process death honestly ends the session
     * and the draft with it.
     *
     * [Draft.linkId] is the OWNER, not a hint. The UI renders this draft only
     * while its link is the current one, so text composed for one peer is
     * never shown — or sent — against the next, and no asynchronous observer
     * is needed to blank it. An observer would be the wrong mechanism anyway:
     * it races the first keystroke typed for the NEW link and would erase it.
     */
    data class Draft(val linkId: Int, val revision: Int, val text: String)

    private val _draft = MutableStateFlow(Draft(linkId = NO_LINK, revision = 0, text = ""))
    val draft: StateFlow<Draft> = _draft.asStateFlow()

    /** The text to render for [linkId] — empty for any other link's draft. */
    fun draftTextFor(linkId: Int): String =
        _draft.value.let { if (it.linkId == linkId) it.text else "" }

    /** UI-layer join-form state: the last parse rejection, as a string key. */
    private val _joinError = MutableStateFlow<JoinInput.Result.Reason?>(null)
    val joinError: StateFlow<JoinInput.Result.Reason?> = _joinError.asStateFlow()

    /** UI-layer picker problems (unknown size, unnamed document), BOUND to the
     *  link they happened on: the UI shows one only while its [PickError.linkId]
     *  matches the current state, so an old pick's failure can never surface
     *  against a new peer. */
    private val _pickError = MutableStateFlow<PickError?>(null)
    val pickError: StateFlow<PickError?> = _pickError.asStateFlow()

    data class PickError(val kind: Kind, val name: String?, val linkId: Int) {
        enum class Kind { UNKNOWN_SIZE, UNREADABLE, FOLDER_UNAVAILABLE }
    }

    /**
     * Publish (or clear, with null) a pick outcome ON BEHALF OF one link.
     * Link ids are monotonic, and picker completions arrive from IO
     * coroutines in any order — an old link's late completion must neither
     * surface its own error against a newer session nor erase the error the
     * newer session is currently showing. The atomic update is the fence.
     */
    private fun publishPick(linkId: Int, outcome: PickError?) {
        _pickError.update { current ->
            if (current != null && current.linkId > linkId) current else outcome
        }
    }

    // ── joining ─────────────────────────────────────────────────────────────

    /**
     * Raw input from the join field or an incoming relayium.com link.
     *
     * Anonymous: joining has never required an account and still does not. The
     * account is what MINTING needs, because the code's owner pays for whatever
     * is relayed through it.
     *
     * A successful parse retires any code this device minted. That is what
     * keeps the connecting screen honest: the minted-code card is drawn from
     * [createLink], and without this a stale `Showing` would reappear over a
     * session started by pasting somebody else's code — six digits presented as
     * "give these to the other device" that name a different room entirely.
     */
    fun join(raw: String) {
        when (val parsed = JoinInput.parse(raw)) {
            is JoinInput.Result.Code -> {
                _joinError.value = null
                createLink.cancel()
                controller.join(parsed.code)
            }
            is JoinInput.Result.Rejected -> _joinError.value = parsed.reason
        }
    }

    /**
     * Mint a code and join the room it names.
     *
     * The commit runs on the account model's own dispatcher, immediately before
     * the join and after the mint has already been re-checked against the live
     * account and the code's expiry (see [CreateLinkModel]). What it adds is the
     * TRANSFER side of the same question: is this device actually free?
     *
     * `phase` is read as a snapshot and that is sound here, because the only
     * thing that can take this app out of IDLE/ENDED is a local join or a local
     * mint — a peer can move a session forward but cannot start one. So a mint
     * whose answer arrives after the user has already joined somebody else's
     * code refuses, and the live transfer is left alone.
     */
    fun createCrossNetworkLink() = createLink.create { minted: MintedCode ->
        val phase = controller.state.value.phase
        if (phase != TransferController.Phase.IDLE && phase != TransferController.Phase.ENDED) {
            return@create false
        }
        _joinError.value = null
        controller.join(minted.pairCode())
        true
    }

    fun clearJoinError() { _joinError.value = null }

    // ── outgoing files ──────────────────────────────────────────────────────

    /**
     * The multi-document picker's answer, for the link identified by [linkId]
     * — captured from [TransferController.State.linkId] when the picker was
     * LAUNCHED, and enforced by the controller itself, on the session
     * executor, immediately before any lane mutation. Nothing here decides
     * whether the link is still the same one; by the time this coroutine's
     * metadata queries finish, that answer could already be stale.
     *
     * Metadata is queried on IO — a slow provider must not stall the main
     * thread — and each document's size must be the size the provider REPORTS.
     * A document with no name or no known size is refused by name, never
     * guessed: an invented size would become a manifest the transfer then
     * fails to honour.
     */
    fun sendPicked(uris: List<Uri>, linkId: Int) {
        if (uris.isEmpty()) return
        viewModelScope.launch(Dispatchers.IO) {
            val resolver = getApplication<Application>().contentResolver
            val sources = ArrayList<TransferController.OutgoingSource>(uris.size)
            for (uri in uris) {
                var name: String? = null
                var size: Long = -1
                runCatching {
                    resolver.query(uri, null, null, null, null)?.use { cursor ->
                        if (cursor.moveToFirst()) {
                            val nameIx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                            val sizeIx = cursor.getColumnIndex(OpenableColumns.SIZE)
                            if (nameIx >= 0) name = cursor.getString(nameIx)
                            if (sizeIx >= 0 && !cursor.isNull(sizeIx)) size = cursor.getLong(sizeIx)
                        }
                    }
                }
                val fixedName = name
                if (fixedName.isNullOrBlank()) {
                    publishPick(linkId, PickError(PickError.Kind.UNREADABLE, null, linkId))
                    return@launch
                }
                if (size < 0) {
                    publishPick(linkId, PickError(PickError.Kind.UNKNOWN_SIZE, fixedName, linkId))
                    return@launch
                }
                sources.add(
                    TransferController.OutgoingSource(FileMeta(fixedName, size)) {
                        resolver.openInputStream(uri)
                            ?: throw java.io.IOException("provider returned no stream for $fixedName")
                    },
                )
            }
            publishPick(linkId, null)
            controller.sendFiles(sources, expectedLink = linkId)
        }
    }

    fun clearPickError() { _pickError.value = null }

    fun cancelSend() = controller.cancelSend()

    // ── incoming files ──────────────────────────────────────────────────────

    /**
     * The folder-picker answer for [promptId]. The prompt counter is
     * controller-lifetime monotonic — an old link's prompt id can never equal
     * a new one's — and the controller compares it on the session executor,
     * which is the fence that matters. A tree the provider cannot resolve, or
     * that throws resolving, is a REFUSAL the user sees (the controller turns
     * a null tree into the save-failure path), never a crash and never a
     * silent success.
     */
    fun acceptIncoming(promptId: Int, tree: Uri?, linkId: Int) {
        val node = tree?.let { uri ->
            runCatching { saf.openTree(uri) }.getOrNull().also { resolved ->
                if (resolved == null) {
                    publishPick(linkId, PickError(PickError.Kind.FOLDER_UNAVAILABLE, null, linkId))
                }
            }
        }
        controller.acceptIncoming(promptId, node)
    }

    fun rejectIncoming() = controller.rejectIncoming()
    fun cancelReceive() = controller.cancelReceive()

    // ── text ────────────────────────────────────────────────────────────────

    fun requestText() = controller.requestText()
    fun acceptText() = controller.acceptText()
    fun rejectText() = controller.rejectText()
    fun endText() = controller.endText()

    /**
     * Record an edit made against [expectedLink] — the link the composable
     * that produced the keystroke was RENDERING. An edit for a link that is no
     * longer the draft's owner starts that link's own draft rather than
     * appending to the previous peer's text.
     */
    fun updateDraft(text: String, expectedLink: Int) {
        _draft.update { current -> current.edited(text, expectedLink) }
    }

    /**
     * Send the draft belonging to [expectedLink].
     *
     * Three separate things are fenced, because they can each be stale
     * independently:
     *
     * 1. the draft this call is allowed to read — a tap rendered against an
     *    old link must not pick up the current one's text;
     * 2. the SEND itself — [TransferController.sendText] re-checks
     *    `expectedLink` on its session executor, immediately before sealing,
     *    which is the only place a join racing this call can be seen;
     * 3. the CLEAR — the field empties only when the controller confirms this
     *    exact submission entered the channel and the field still holds it
     *    unchanged, so a rejected enqueue (closed lane, full buffer, replaced
     *    link) keeps the text for retry, edits typed after the tap survive,
     *    and a stale success cannot blank a newer session's draft.
     */
    fun sendDraft(expectedLink: Int) {
        val submitted = _draft.value
        if (submitted.linkId != expectedLink) return
        if (submitted.text.isBlank()) return
        controller.sendText(submitted.text, expectedLink = expectedLink) { sent ->
            if (sent) _draft.update { current -> current.clearedBy(submitted) }
        }
    }

    companion object {
        /** No link has been joined yet. Below every controller epoch — which
         *  start at 1 — so the first real link is always the NEWER one and
         *  claims the draft rather than being refused as stale. */
        internal const val NO_LINK = -1

        /**
         * The draft after an edit carrying [expectedLink]. Pure so the
         * ownership rule is directly testable, and DIRECTIONAL, because link
         * ids are the controller's monotonic epochs:
         *
         *  - the OWNING link's edit advances the revision;
         *  - a NEWER link's edit replaces the draft, so the previous peer's
         *    text is neither shown nor extended — and the very first keystroke
         *    typed for a new peer is kept, not dropped;
         *  - an OLDER link's edit is DISCARDED. A composable rendered against
         *    a link that has since been replaced can still deliver a queued
         *    keystroke; letting it through would erase the text the user has
         *    already typed for the current peer, and would walk the owning id
         *    BACKWARDS — after which a stale completion carrying that same
         *    (link, revision) pair could clear a draft it never submitted.
         */
        internal fun Draft.edited(text: String, expectedLink: Int): Draft = when {
            expectedLink == linkId -> copy(revision = revision + 1, text = text)
            expectedLink > linkId -> Draft(linkId = expectedLink, revision = 0, text = text)
            else -> this
        }

        /**
         * The draft after the controller confirmed [submitted] entered the
         * channel. Clear only when the field still holds exactly that
         * submission — same link AND same revision. A later edit bumps the
         * revision, so it survives its own send's completion, and a completion
         * from a previous link never touches the current one's text.
         */
        internal fun Draft.clearedBy(submitted: Draft): Draft =
            if (linkId == submitted.linkId && revision == submitted.revision) copy(text = "")
            else this
    }

    // ── session ─────────────────────────────────────────────────────────────

    // ── account, where it meets the transfer ────────────────────────────────

    /**
     * Leave the check-email or frozen-account notice and go back to the form,
     * as a SIGN-IN.
     *
     * Two things move together, which is why this is one action rather than the
     * session call on its own. The session leaves the notice; the draft
     * explicitly selects the sign-in half — because the way a user reaches the
     * check-email screen is usually by REGISTERING, and the draft still says so.
     * Without this, "Back to sign in" put them on the create-account form, which
     * is the one place that button promises not to go.
     *
     * The typed address is deliberately kept: it is the account they are trying
     * to reach, and it is the field they would otherwise retype. And this is not
     * the ordinary rejected-form recovery — a refused registration stays a
     * registration, and nothing here runs on that path.
     */
    fun returnToSignInForm() {
        accessDraft.setCreating(false)
        account.backToSignIn()
    }

    /** Start a browser approval. The model claims its account-access attempt
     *  and hands the bearer over itself; see [BrowserLoginModel.begin]. */
    fun beginBrowserLogin() = browserLogin.begin()

    /**
     * Sign out, and take everything that depended on the credential with it.
     *
     * Three things are ended together, because a revocation that left any of
     * them running would leave the app acting on an account it no longer has:
     *
     *  * an in-flight **browser approval**, whose whole purpose is to produce a
     *    bearer for the account being signed out of. Cancelling bumps its
     *    generation, so a token that arrives afterwards is revoked rather than
     *    adopted;
     *  * a **minted code that nobody has joined yet**. It names a room reserved
     *    under the credential being revoked, so leaving it on screen would offer
     *    six digits belonging to an account this device no longer holds;
     *  * nothing else. A session a peer has ALREADY joined is left alone: it is
     *    an established end-to-end link that uses no bearer, and tearing down a
     *    running transfer because the user signed out would destroy work they
     *    never asked to lose.
     */
    fun signOutAccount() {
        browserLogin.cancel()
        val phase = controller.state.value.phase
        if (phase == TransferController.Phase.CONNECTING ||
            phase == TransferController.Phase.WAITING_PEER
        ) {
            // Only while the room is still unjoined; see above.
            if (createLink.state.value !is CreateLinkModel.State.Idle) {
                createLink.cancel()
                controller.disconnect()
            }
        } else {
            createLink.cancel()
        }
        account.signOut()
    }

    fun disconnect() {
        // The minted code goes with the session it belonged to: leaving the room
        // it names makes it six digits nothing is listening on.
        createLink.cancel()
        controller.disconnect()
    }
    fun dismissCleanupWarning() = controller.dismissCleanupWarning()

    /** Nonblocking by design; a parked provider cannot ANR this. The cloud
     *  store thread is asked to stop after its queued work drains, so a save in
     *  flight still rolls itself back rather than being killed mid-export. */
    override fun onCleared() {
        controller.shutdown()
        cloudStorageExecutor.shutdown()
    }
}
