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
import com.relayium.android.nearby.ConnectionSource
import com.relayium.android.cloud.StoredLinkKeyStore
import com.relayium.android.cloud.buildDownloadLink
import com.relayium.android.inbox.InboxAndroidServices
import com.relayium.android.inbox.InboxModel
import com.relayium.android.inbox.InboxRuntime
import com.relayium.android.inbox.InboxSourceRef
import com.relayium.android.ingress.IngressRefusal
import com.relayium.android.ingress.IngressRequest
import com.relayium.android.integration.AccountBinding
import com.relayium.android.integration.Credential
import com.relayium.android.integration.DispatchAuthority
import com.relayium.android.integration.ExportCoordinator
import com.relayium.android.integration.HostPresence
import com.relayium.android.integration.InboxHost
import com.relayium.android.integration.IngressHost
import com.relayium.android.integration.PickerLease
import com.relayium.android.integration.RuntimeReceiving
import com.relayium.android.integration.ShareEpoch
import com.relayium.android.integration.SharedFileGrants
import com.relayium.android.scan.ScannerController
import com.relayium.android.storage.ProviderOps
import com.relayium.android.storage.ReceiveStore
import java.io.File
import com.relayium.android.update.UpdateChecker
import com.relayium.android.update.UpdateEndpoint
import com.relayium.protocol.FileMeta
import com.relayium.protocol.JoinInput
import com.relayium.protocol.stored.PlaintextSource
import java.util.Base64
import java.util.concurrent.Executors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

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
     * The name this device announces on the signalling roster, resolved once.
     *
     * Exposed for the same reason [backendOrigin] is: the legacy acceptance
     * needs its Apple half to find THIS app among the room's peers by exact
     * name, and a harness that re-derived the name instead of reading the
     * resolved one is a harness that can be wrong about the app under test.
     * That is not hypothetical — the first run of that lane matched on an
     * invented constant, found no peer, and reported it as the app never being
     * offered a connection.
     *
     * Read-only, and nothing in the product reads it: it announces nothing new
     * and changes no behaviour.
     */
    val signalingDeviceName: String

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

    // ── host integration ────────────────────────────────────────────────────

    /**
     * Whether the whole app is in front of the user, as ONE answer.
     *
     * Both presence claims — Nearby's advertisement and the Inbox's "this
     * device is listening" to central — read it. See [HostPresence] for why
     * `ON_STOP` is not that question.
     */
    private val presence = HostPresence()

    /**
     * The one export, owned so it can actually be stopped.
     *
     * ## Declared HERE, above `init`, and that is not style
     *
     * Kotlin runs property initialisers and `init` blocks in DECLARATION order.
     * The account collector started in `init` runs on `Dispatchers.Main.immediate`,
     * so it does not wait for anything — it observes the initial `SignedOut`
     * emission synchronously, inside `init`, and calls straight into this
     * object. Declared below `init`, the field is still null at that moment and
     * the app dies with an NPE before its first frame.
     *
     * Nothing caught it: the JVM suite never constructs a `TransferViewModel`,
     * which needs a real `Application`. Every field an immediate collector can
     * reach therefore belongs above `init`, and the ordering rule is asserted in
     * `scripts/test/android-policy-test.mjs` because a compiler that accepts
     * both orders cannot.
     *
     * See [ExportCoordinator] for why a check between files is not
     * cancellation, and why "cancel the previous job then publish mine" is not
     * serialisation.
     */
    private val _exportCleanup = MutableStateFlow<ExportOutcome?>(null)

    /**
     * What an export left behind when it could not tell its own caller.
     *
     * An export stopped by an account change takes the coroutine awaiting it
     * with it, so there is nobody to receive a return value — and "some files
     * could not be removed from the folder you chose" is exactly the fact the
     * user must not lose.
     */
    val exportCleanup: StateFlow<ExportOutcome?> = _exportCleanup.asStateFlow()

    fun clearExportCleanup() {
        _exportCleanup.value = null
    }

    private val exports = ExportCoordinator(
        // Completion-driven, and bound to the run that ended.
        //
        // The account collector used to call `stop()` and then read a field.
        // `stop()` only cancels and closes: the export still has to unwind and
        // run its deletes afterwards, so that read saw `null` or the previous
        // run's result. A user whose folder had been left with files this app
        // could not remove was told nothing at all.
        onCleanup = { _exportCleanup.value = ExportOutcome.FAILED_INCOMPLETE },
    )

    /**
     * A staged share a dispatch is reading from, per destination.
     *
     * Above `init` for the same reason as [exports]: the account collector
     * reaches them through `releaseStaleDispatches` on its very first emission.
     */
    private var sessionDispatch: Dispatched? = null
    private var cloudDispatch: Dispatched? = null
    private var inboxDispatch: Dispatched? = null

    /** Whether a session send has been seen to start, so its finishing can be
     *  told apart from its not having begun yet. */
    private var sessionSendObserved = false

    /**
     * The identity the destructive invalidations have already been applied for.
     *
     * `null` is a real value here — signed out — so this starts at a sentinel
     * rather than at `null`, or a launch that begins signed out would compare
     * equal and skip the first application.
     */
    private var lastAuthority: AccountBinding? = NO_AUTHORITY_YET

    private val _foreground = MutableStateFlow(false)

    /**
     * Whether the app is, honestly, in front of the user.
     *
     * Published because it is the ONE input both presence claims read, and
     * because "switching tabs did not stop the Inbox" is otherwise only
     * observable by waiting to see whether a delivery arrives. The owning
     * acceptance asserts against this rather than against a proxy.
     *
     * `internal`: nothing outside this module reads it, and it is state the
     * host already owns rather than a test-only field.
     */
    internal val foreground: StateFlow<Boolean> = _foreground.asStateFlow()

    /**
     * The bounded lease on this app's own system pickers.
     *
     * Owned HERE rather than by the composition, which is the whole mechanism:
     * the ViewModel survives the recreation that happens behind a picker, so
     * there is no path on which a rotation could restart the two-minute clock.
     * `internal`, because the owning acceptance asserts against the real one.
     */
    internal val pickerLease = PickerLease()

    /** Sweeps expired picker leases at their own deadline rather than polling. */
    private var leaseSweep: kotlinx.coroutines.Job? = null

    /** The generation a staged share is held under. Deliberately not the
     *  account's; see [ShareEpoch]. */
    private val shareEpoch = ShareEpoch()

    /** What another app has handed this one, until the user says where it goes. */
    val ingress = IngressHost()

    private val ingressCoordinator: com.relayium.android.ingress.IngressCoordinator

    /** The Device Inbox, as ONE runtime adopted into each account in turn. */
    private val inboxRuntime: InboxRuntime

    /** The Inbox surface's state. */
    val inbox: StateFlow<InboxModel.State>

    private val inboxHost: InboxHost

    private val _inboxAccountUnusable = MutableStateFlow(false)

    /**
     * The signed-in account cannot name an Inbox store.
     *
     * Server ids are 32 lowercase hex, so this is unreachable today; it is
     * surfaced rather than swallowed because the alternative — an Inbox that
     * silently shows nothing — would look like a sign-out the user did not
     * perform. See [Credential.inboxAccount].
     */
    val inboxAccountUnusable: StateFlow<Boolean> = _inboxAccountUnusable.asStateFlow()

    /** The camera scanner, for the ViewModel's lifetime rather than the sheet's:
     *  a rotation must not re-ask for the camera. */
    val scanner: ScannerController

    /**
     * The pairing code the user is part-way through entering.
     *
     * Owned here rather than by the join composable because a scanned code and
     * a tapped link both PREFILL it, and a value the composable owned could not
     * be written from outside the composition. In memory only: the ViewModel
     * already survives rotation and the picker round trip, which is the
     * lifetime the field needs.
     */
    private val _joinDraft = MutableStateFlow("")
    val joinDraft: StateFlow<String> = _joinDraft.asStateFlow()

    init {
        val origin = Backend.resolve(Backend.readDebugOverride())
        backendOrigin = origin
        // ONE resolution, read by everything that announces this device. It was
        // written out four times, and four copies of an expression are four
        // places for the name a peer actually sees to drift from the name
        // anything else believes it sends.
        val model = android.os.Build.MODEL ?: "Android"
        signalingDeviceName = model
        val (deps, safOps) = RealDeps.create(app, origin, model)
        saf = safOps
        controller = TransferController(viewModelScope, model, deps)

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
            deviceName = signalingDeviceName,
        )
        browserLogin = BrowserLoginModel(
            scope = viewModelScope,
            owner = owner,
            client = client,
            session = account,
            deviceName = signalingDeviceName,
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

        // ── the host's own composition ──────────────────────────────────────

        // Only files under this root can ever be offered to another app. Set
        // once, before anything can register a grant.
        SharedFileGrants.useRoot(app.noBackupFilesDir)

        val seconds = { System.currentTimeMillis() / 1000L }
        val inboxModel = InboxModel(viewModelScope, seconds)
        inboxRuntime = InboxRuntime(
            model = inboxModel,
            // The production factory, with ONE seam substituted so a file that
            // arrived on a share intent can be sent without the Inbox ever
            // being handed a raw `Uri`. See [StagedInboxSources].
            factory = com.relayium.android.integration.StagedInboxSources(
                delegate = InboxAndroidServices(
                    context = app,
                    origin = origin,
                    userAgent = "Relayium-Android/${BuildConfig.VERSION_NAME} (inbox)",
                    appVersion = BuildConfig.VERSION_NAME,
                    cloud = cloudClient,
                    nowSeconds = seconds,
                ),
                staged = { inboxDispatch?.share },
            ),
            nowSeconds = seconds,
            appVersion = BuildConfig.VERSION_NAME,
        )
        inbox = inboxModel.state
        inboxHost = InboxHost(
            receiving = RuntimeReceiving(inboxRuntime),
            onUnusableAccount = { _inboxAccountUnusable.value = true },
        )

        // ONE collector, so adoptions are applied in the order the credentials
        // arrived. `authority()` answers only from a live `Ready` session and
        // must be read on the account model's own dispatcher, which is the one
        // `viewModelScope` collects on.
        inboxHost.run(viewModelScope, account.state.map { credential() })

        // The identity fences every staged share and every outstanding grant is
        // measured against. Separate from the adoption above because it is a
        // different question — see [ShareEpoch] — and because releasing a share
        // must not wait on a runtime adoption completing.
        viewModelScope.launch {
            account.state.collect {
                val binding = accountBinding()
                _inboxAccountUnusable.value = false
                val epoch = shareEpoch.observe(binding?.accountId)
                ingress.releaseStale(epoch)
                // A dispatch authorised under an identity that has been
                // replaced may not go on reading the user's documents. Released
                // here rather than left to the reader noticing, because the
                // reader is what must be stopped.
                releaseStaleDispatches()
                // A URI minted for one session must stop resolving in the next,
                // even though the bytes on disk are the same bytes.
                SharedFileGrants.revokeExcept(binding?.let(::grantAuthority))

                // ── the two that DESTROY work, and only on a real change ────
                //
                // `account.state` emits for reasons that are not identity: a
                // usage refresh, a device-list load, a `persisted` flag
                // settling. Running these on every emission cancelled an export
                // that was writing correctly and discarded a file the user had
                // just chosen — because a quota number moved.
                //
                // The calls above are safe to repeat because each COMPARES
                // something: the epoch only advances on a replacement, the
                // dispatch helper checks its own authority, and `revokeExcept`
                // is keyed by the authority it is handed. These two are not
                // comparisons, they are actions, so the comparison has to be
                // made here.
                if (binding != lastAuthority) {
                    lastAuthority = binding
                    // An export authorised under an identity that has been
                    // replaced must stop WRITING, not merely stop being
                    // awaited: the stop closes its streams, which is what ends
                    // a provider write that is already blocked.
                    // Asking for it to stop is all this does. What it left, if
                    // anything, is reported when the run itself completes.
                    exports.stop()
                    // A file or folder chosen under one session is not one the
                    // next may act on. The choice stops being recognisable now,
                    // rather than waiting for a callback that may never arrive.
                    pickerLease.invalidateRetained()
                }
            }
        }

        ingressCoordinator = ingress.coordinator(
            isBusy = ::ingressBusy,
            applyLink = ::applyIngressLink,
        )

        // Retained requests are applied on the BUSY EDGE, not on every progress
        // update: a transfer publishes state continuously, and asking on each
        // would be thousands of calls to answer one question.
        viewModelScope.launch {
            controller.state
                .map { it.phase != TransferController.Phase.IDLE && it.phase != TransferController.Phase.ENDED }
                .distinctUntilChanged()
                .collect { ingressCoordinator.applyIfIdle() }
        }
        viewModelScope.launch {
            cloudDownload.state
                .map {
                    it is CloudDownloadModel.State.Loading || it is CloudDownloadModel.State.Saving
                }
                .distinctUntilChanged()
                .collect { ingressCoordinator.applyIfIdle() }
        }

        // ── when a staged dispatch is actually finished with its share ──────

        // The upload reads the staged streams while it is SELECTING and while
        // it is STAGING the ciphertext onto this device; everything after that
        // replays the spool. Leaving those two states is therefore the terminal
        // for the share, whether the job went on to upload, failed, or was
        // discarded.
        viewModelScope.launch {
            cloudUpload.state.collect { state ->
                val reading = state is CloudUploadModel.State.Selected ||
                    state is CloudUploadModel.State.Staging
                if (!reading) cloudDispatch = own(cloudDispatch, null)
            }
        }

        // A session send opens its sources as the batch is pumped. `sendProgress`
        // going from present to absent is that batch ending; a changed link, or
        // a session that is no longer connected, ends it too — and either way
        // the sources can no longer be read.
        viewModelScope.launch {
            controller.state.collect { state ->
                val owner = sessionDispatch ?: return@collect
                if (state.sendProgress != null) {
                    sessionSendObserved = true
                    return@collect
                }
                if (sessionSendObserved ||
                    state.linkId != owner.linkId ||
                    state.phase != TransferController.Phase.CONNECTED
                ) {
                    sessionDispatch = own(sessionDispatch, null)
                    sessionSendObserved = false
                }
            }
        }

        // ── the stored credential, read at STARTUP ──────────────────────────
        //
        // Last in `init`, and that position is the whole point: restoring emits
        // account state immediately on `Main.immediate`, and every collector
        // above — the Inbox adoption, the staging epoch, the grant authority —
        // must already be running, with the fields they touch already
        // constructed, or the first emission lands on a half-built object.
        //
        // ## Why it cannot live on the Account screen
        //
        // It did, in a `LaunchedEffect` inside `AccountScreen`, and that made
        // the credential's restoration depend on the user VISITING that tab.
        // Anyone who opened the app and stayed on Cross-network, Nearby, Inbox
        // or Cloud — which is the ordinary case, and the launch destination —
        // sat on `Restoring` forever: the Inbox never adopted, so it never
        // received; the cloud surfaces looked signed out; and nothing on screen
        // explained any of it. The account is app-wide state that four
        // destinations read, so the app, not one of its screens, is what asks
        // for it.
        //
        // `restore` is idempotent and refuses to restart anything already
        // holding a credential, a check-email address or a failed sign-out —
        // see `AccountSession.restore` — so being called once here is complete.
        account.restore()

        scanner = ScannerController(trustedOrigin = origin) { prefill ->
            // Through the SAME coordinator a tapped link crosses, so a scanned
            // code cannot overwrite the code a live session is running on. It
            // prefills; there is no case in the vocabulary that could connect.
            ingressCoordinator.deliver(com.relayium.android.ingress.IngressOutcome.Accepted(prefill))
                ?.let(ingress::refuse)
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
        // A staged share is read through the staging, never through a `Uri`:
        // the ingress module keeps the real handles private on purpose, and
        // this is the sanctioned reader for them.
        val stream = if (selection.uri.startsWith(com.relayium.android.integration.StagedInboxSources.PREFIX)) {
            val share = cloudDispatch?.share ?: return null
            runCatching {
                share.open(com.relayium.android.integration.StagedInboxSources.incomingUri(selection.uri))
            }.getOrNull() ?: return null
        } else {
            runCatching {
                app.contentResolver.openInputStream(selection.uri.toUri())
            }.getOrNull()
        } ?: return null
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
                // JOINER, and the distinction is on the wire rather than
                // cosmetic: a peer on the shipped older generation decides who
                // offers from exactly this, so a device that typed a code must
                // never behave like the one that minted it.
                controller.join(parsed.code, TransferController.Intent.JOINER)
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
        // MINTER: this device created the code, so on the older wire it is the
        // side that offers. See [TransferController.Intent].
        controller.join(minted.pairCode(), TransferController.Intent.MINTER)
        true
    }

    fun clearJoinError() { _joinError.value = null }

    // ── nearby ──────────────────────────────────────────────────────────────

    /**
     * Whether a Nearby session may be started right now.
     *
     * One [TransferController] owns one connection, so Nearby and the
     * cross-network code are two doors into the same room. Starting one while
     * the other holds a live or connecting session would silently end work the
     * user did not ask to lose, so the screen says so instead of doing it.
     */
    val canStartNearby: Boolean
        get() {
            val current = controller.state.value
            if (current.nearby.active) return true
            return current.phase == TransferController.Phase.IDLE ||
                current.phase == TransferController.Phase.ENDED
        }

    /**
     * Start discovery on the local link — Bonjour and direct TCP, no server.
     *
     * A minted cross-network code goes with it, for the reason [join] gives: it
     * names a room nothing is listening on once this device has left it.
     */
    fun startNearbyDirect() = startNearby(ConnectionSource.Direct)

    /** Start discovery through the code-less rendezvous room, which is what the
     *  Web and macOS clients join. */
    fun startNearbyHub() = startNearby(ConnectionSource.Hub)

    private fun startNearby(source: ConnectionSource) {
        if (!canStartNearby) return
        _joinError.value = null
        createLink.cancel()
        controller.join(source)
    }

    /** [expectedRoom] is [TransferController.Nearby.roomId] as the tapped row was
     *  RENDERED; the controller enforces it on its session executor. */
    fun connectToPeer(peerId: String, expectedRoom: Int) =
        controller.connectToPeer(peerId, expectedRoom)

    /** [expectedPrompt] is [TransferController.Nearby.incomingPromptId] as the
     *  answered question was RENDERED. */
    fun admitPeer(peerId: String, expectedPrompt: Int) = controller.admitPeer(peerId, expectedPrompt)

    fun rejectPeer(peerId: String, expectedPrompt: Int) = controller.rejectPeer(peerId, expectedPrompt)

    fun retryNearby() = controller.retryNearby()

    fun stopNearby() = controller.stopNearby()

    /**
     * The user LEFT the app, and Nearby stops completely: advertising, browsing,
     * every socket and any live transfer.
     *
     * This build has no foreground service, no background permission and no way
     * to keep a WebRTC link alive with the process stopped, so a device that
     * kept announcing itself would be offering a delivery it cannot make — and
     * one that kept a half-open session would show the peer a transfer that is
     * not going to finish.
     *
     * "Left the app" is a narrower thing than "the Activity stopped", and the
     * caller is what tells them apart — see the lifecycle observer in
     * `RelayiumApp`. The system document picker STOPS this Activity while it is
     * in front, and so does a locale change; treating either as abandonment
     * would kill the transfer the user is in the middle of arranging.
     *
     * Deliberately does NOT touch a cross-network session: that one is entered
     * from a code the user is holding and is left by the Disconnect they press.
     * Only the discovery surface makes a presence claim to other devices.
     */
    fun nearbyLeftForeground() {
        if (controller.state.value.nearby.active) controller.stopNearby()
    }

    /**
     * End whatever session is running so the OTHER surface can start one.
     *
     * Both directions are explicit and neither is silent. `join`/`createLink`
     * would tear a Nearby session down through `TransferController.join`, and
     * starting Nearby during a pairing session is refused by [canStartNearby];
     * in both cases the screen shows what is running and offers this, so
     * whatever is destroyed is destroyed by a button the user pressed.
     */
    fun endSessionForSwitch() {
        if (controller.state.value.nearby.active) controller.stopNearby() else controller.disconnect()
    }

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

        /** No live session. Distinct from any real account generation. */
        internal const val NO_ACCOUNT = -1

        /** Distinct from every real value INCLUDING the `null` of signed out,
         *  so the first observation always counts as a change. */
        private val NO_AUTHORITY_YET = AccountBinding("", Int.MIN_VALUE)

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

    // ── the host's own surface ──────────────────────────────────────────────

    /**
     * The live credential, or null.
     *
     * `AccountSession.authority` answers only from a live `Ready` session and
     * MUST be read on the account model's own dispatcher — which is the one
     * `viewModelScope` collects on. Reading it anywhere else would sample a
     * session that is mid-transition.
     */
    private fun credential(): Credential? = account.authority()?.let {
        Credential(accountId = it.accountId, generation = it.generation, bearer = it.token)
    }

    private fun accountBinding(): AccountBinding? = account.authority()?.let {
        AccountBinding(accountId = it.accountId, generation = it.generation)
    }

    /**
     * The live account's generation, or [NO_ACCOUNT].
     *
     * An `Int` because it is captured at a picker LAUNCH and written into saved
     * instance state, which must carry no identifier — a generation is a
     * counter and names nobody. It is compared against the live session when
     * the result comes back, so a pick made under one account cannot be
     * delivered under the next.
     */
    internal fun accountGeneration(): Int = account.authority()?.generation ?: NO_ACCOUNT

    /** The session a file grant belongs to. Never leaves this process. */
    private fun grantAuthority(binding: AccountBinding): String =
        "${binding.accountId}:${binding.generation}"

    // ── lifecycle ───────────────────────────────────────────────────────────

    /** The Activity is on screen. */
    fun hostStarted() {
        applyPresence(presence.onStart())
    }

    /**
     * The Activity stopped.
     *
     * [changingConfigurations] and an outstanding owned picker are the two
     * stops that are NOT the user leaving; see [HostPresence].
     */
    fun hostStopped(changingConfigurations: Boolean) {
        applyPresence(
            presence.onStop(
                changingConfigurations = changingConfigurations,
                ownedPickerOutstanding = pickerLease.outstandingCount() > 0,
            ),
        )
    }

    /**
     * Both presence claims follow the one answer.
     *
     * The Inbox is told app-wide, never per destination: switching to Account
     * or Nearby must not stop receiving, or a sender would be told this device
     * is offline because its owner looked at another tab.
     */
    private fun applyPresence(foreground: Boolean) {
        _foreground.value = foreground
        inboxHost.foreground(foreground)
        if (!foreground) nearbyLeftForeground()
    }

    /**
     * The monotonic clock the picker lease is measured against.
     *
     * `elapsedRealtime` rather than wall time: an NTP correction or a user
     * changing the date moves wall time, and a lease measured against it can
     * expire an hour early or never. It deliberately INCLUDES deep sleep — a
     * device that slept for ten minutes with the picker on screen was away for
     * ten minutes, and the presence claim was false for all of them.
     *
     * The offset is zero in release, with no field behind it. See [TestHooks].
     */
    private fun leaseNow(): Long =
        android.os.SystemClock.elapsedRealtime() + TestHooks.clockOffsetMillis()

    /**
     * A system picker this app owns is going to the front.
     *
     * [replacing] is the token this launcher was last used with, if any. It is
     * retired here, so a result for the launch being replaced is refused rather
     * than applied to the one starting now — the binding between a callback and
     * its launch, without depending on whether the platform can have two of
     * them outstanding.
     */
    fun pickerLaunched(claim: PickerLease.Claim, replacing: String = ""): String {
        if (replacing.isNotEmpty()) pickerLease.retire(replacing)
        val token = pickerLease.launch(leaseNow(), claim)
        scheduleLeaseSweep()
        return token
    }

    /** A picker came back. The verdict says whether its answer may be used. */
    fun pickerReturned(token: String): PickerLease.Verdict {
        val verdict = pickerLease.consume(token, leaseNow())
        scheduleLeaseSweep()
        return verdict
    }

    /**
     * Wake at the soonest deadline rather than polling.
     *
     * This is the whole Home-from-`DocumentsUI` mechanism: no lifecycle event
     * announces that journey, so the only thing that can end the claim is a
     * timer the app set when it launched the picker.
     */
    private fun scheduleLeaseSweep() {
        // ONLY the sweep timer. This must not touch the export coordinator:
        // scheduling runs on every picker launch, every picker result and every
        // sweep, so an `exports.stop()` here cancelled a perfectly valid Inbox
        // export the moment the user opened an unrelated Cloud or Nearby
        // picker. Export cancellation belongs to the three things that actually
        // invalidate one — an account change, the caller, and a superseding
        // export — and to the host being cleared.
        leaseSweep?.cancel()
        val deadline = pickerLease.nextDeadline() ?: return
        leaseSweep = viewModelScope.launch {
            val wait = deadline - leaseNow()
            if (wait > 0) kotlinx.coroutines.delay(wait)
            sweepPickerLease()
        }
    }

    /**
     * Retire every picker whose deadline has passed, and withdraw the presence
     * claim if that leaves nothing holding the app in front of the user.
     *
     * `internal` so the owning acceptance drives the real method rather than a
     * copy of the rule: this is the path with the ordering bug in it, and a
     * test that re-implemented the decision would have agreed with the broken
     * version.
     */
    internal fun sweepPickerLease() {
        val expired = pickerLease.sweep(leaseNow())
        if (expired.isEmpty()) return
        // The covered state is about the APP being behind one of its own
        // pickers, and every owned picker produces it — `HostPresence.onStop`
        // is given `outstandingCount > 0`, not a claim kind. So the claim kind
        // decides what happens to the OPERATION, never whether the app is
        // present: gating this on a PRESENCE expiry left a DATA-only picker
        // abandoned in the background holding the covered state open forever,
        // and with it the Inbox's "this device is listening" claim to central.
        //
        // Withdrawn only once nothing is outstanding, and only if the app is
        // genuinely away: a lease expiring while the user is back on screen
        // means a pick was lost, not that they left, and stopping Nearby there
        // would be a session destroyed by navigation. The stale pick is retired
        // either way — `sweep` already removed the token, so its late result
        // answers UNKNOWN and cannot retarget the current session.
        if (pickerLease.outstandingCount() == 0) {
            applyPresence(presence.onPickerLeaseExpired())
        }
        scheduleLeaseSweep()
    }

    // ── things arriving from outside ────────────────────────────────────────

    /**
     * An `ACTION_VIEW`, `ACTION_SEND` or `ACTION_SEND_MULTIPLE` this app was
     * handed.
     *
     * Everything the accepted boundary decides is decided there: the origin,
     * the `#k=` refusal, own-provider and file-URI refusals, the item budget,
     * an unreadable `Bundle`. This method routes the outcome and stages what
     * came with it; it starts nothing.
     */
    fun deliverIntent(intent: android.content.Intent) {
        val app = getApplication<Application>()
        val read = com.relayium.android.ingress.IngressIntents.read(
            intent = intent,
            ownAuthorities = com.relayium.android.ingress.IngressIntents.ownAuthorities(app),
            trustedOrigin = backendOrigin,
        ) ?: return
        when (val outcome = read.outcome) {
            is com.relayium.android.ingress.IngressOutcome.Refused -> ingress.refuse(outcome.reason)
            is com.relayium.android.ingress.IngressOutcome.Accepted -> {
                // Staged BEFORE the coordinator navigates, so the surface it
                // selects already has something truthful to show.
                when (val request = outcome.request) {
                    is IngressRequest.StageFiles -> ingress.stage(
                        request = request,
                        contentAccess = read.access(app.contentResolver),
                        epoch = shareEpoch.current,
                        scope = viewModelScope,
                    )
                    is IngressRequest.StageText -> ingress.stage(request, shareEpoch.current)
                    else -> Unit
                }
                ingressCoordinator.deliver(outcome)?.let(ingress::refuse)
            }
        }
    }

    /**
     * Whether a write this app was asked to make must wait.
     *
     * Exactly the two the accepted coordinator names. A staged share answers
     * false — see [IngressHost].
     */
    private fun ingressBusy(request: IngressRequest): Boolean = when (request) {
        is IngressRequest.PrefillCode -> {
            val phase = controller.state.value.phase
            phase != TransferController.Phase.IDLE && phase != TransferController.Phase.ENDED
        }
        is IngressRequest.OpenStoredLink -> {
            val state = cloudDownload.state.value
            state is CloudDownloadModel.State.Loading || state is CloudDownloadModel.State.Saving
        }
        else -> false
    }

    /**
     * Write what a link asked for. **Never joins and never downloads.**
     *
     * A prefilled code fills the field the user then presses Join on. A stored
     * link is resolved to its ENCRYPTED metadata, which is the reversible read
     * that shows them what they opened; writing plaintext stays a tap.
     */
    private fun applyIngressLink(request: IngressRequest) {
        when (request) {
            is IngressRequest.PrefillCode -> {
                // The lane hint the link carried is deliberately NOT consumed:
                // what a session speaks is decided on the wire by
                // `LegacyLane.mode`, and a value written by whoever wrote the
                // link may not select a transport. See `IngressTransferMode`.
                _joinDraft.value = request.code.digits
                _joinError.value = null
            }
            is IngressRequest.OpenStoredLink -> {
                // Rebuilt from the VALIDATED link rather than from the raw
                // input: the parser already refused a foreign origin, a
                // credential-bearing URL and a key of the wrong size, and
                // re-composing from what it accepted cannot reintroduce any of
                // them. The key never leaves memory.
                val key = Base64.getUrlEncoder().withoutPadding().encodeToString(request.link.key)
                cloudDownload.open(buildDownloadLink(backendOrigin, request.link.id, key))
            }
            else -> Unit
        }
    }

    /** The scanned or pasted code the join field shows. */
    fun updateJoinDraft(text: String) {
        _joinDraft.value = text
        if (_joinError.value != null) _joinError.value = null
    }

    /** Join whatever is in the field. */
    fun joinFromDraft() = join(_joinDraft.value)

    // ── a staged share, and where the user sends it ─────────────────────────

    /** The user dismissed the staged share. Grants are released with it. */
    fun cancelStagedShare() = ingress.cancel()

    /**
     * Send the staged files on the CURRENT session.
     *
     * Anonymous: a cross-network or Nearby transfer presents no bearer and
     * nobody pays for it, so the authority carries no account binding. What it
     * does carry is the share id and the staging epoch, and the controller's
     * own link fence decides whether the session is still the one the user was
     * looking at.
     */
    fun dispatchStagedToSession(shareId: Long) {
        val authority = DispatchAuthority(
            shareId = shareId,
            epoch = shareEpoch.current,
            account = null,
        )
        if (!authority.isCurrent(shareEpoch.current, accountBinding())) return
        val current = controller.state.value
        val linkId = current.linkId
        val items = ingress.staged.value?.items ?: return
        // Everything that can refuse this dispatch is decided BEFORE the share
        // is taken. Taking it first and failing afterwards consumes the staged
        // data on a path that sends nothing: the surface would go empty and the
        // user's share would be gone for a reason nothing explains.
        if (current.phase != TransferController.Phase.CONNECTED) return
        for (item in items) {
            if (item.displayName.isNullOrBlank() || item.size == null || item.size < 0) {
                // The same rule the document picker follows: a name or a size
                // this app had to invent would become a manifest the transfer
                // then fails to honour.
                publishPick(linkId, PickError(PickError.Kind.UNKNOWN_SIZE, item.displayName, linkId))
                return
            }
        }
        val share = ingress.take(shareId, shareEpoch.current) ?: return
        val sources = items.map { item ->
            TransferController.OutgoingSource(FileMeta(item.displayName!!, item.size!!)) {
                share.open(item.uri)
            }
        }
        sessionSendObserved = false
        sessionDispatch = own(sessionDispatch, Dispatched(authority, share, linkId))
        publishPick(linkId, null)
        controller.sendFiles(sources, expectedLink = linkId)
    }

    /**
     * Upload the staged files to this account's storage.
     *
     * Account-bound, so the authority carries the credential and is re-checked
     * before the upload begins. A share staged while signed out survives the
     * sign-in that makes this possible — that is the ordinary flow — but it
     * cannot be uploaded under an account that replaced the one it was
     * authorised for.
     */
    fun dispatchStagedToCloud(shareId: Long) {
        val binding = accountBinding() ?: return
        val authority = DispatchAuthority(
            shareId = shareId,
            epoch = shareEpoch.current,
            account = binding,
        )
        val items = ingress.staged.value?.items ?: return
        if (!authority.isCurrent(shareEpoch.current, accountBinding())) return
        // Refused before the share is consumed, for the reason the session
        // dispatch gives: a path that cannot send must not empty the surface.
        for (item in items) {
            if (item.displayName.isNullOrBlank() || item.size == null || item.size < 0) return
        }
        val share = ingress.take(shareId, shareEpoch.current) ?: return
        val selections = items.map { item ->
            CloudSelection(uri = stagedKey(item.uri), name = item.displayName!!, size = item.size!!)
        }
        cloudDispatch = own(cloudDispatch, Dispatched(authority, share))
        // A selection request of its own, exactly as a picker choice claims
        // one: the upload model's fence must be able to tell this dispatch from
        // a document pick the user made a moment earlier.
        cloudUpload.select(selections, cloudUpload.beginSelection())
    }

    /**
     * Send the staged files to a device in this account's Inbox.
     *
     * The target is captured in the authority alongside the credential: a late
     * callback must not deliver to a device that was chosen from a different
     * account's device list.
     */
    fun dispatchStagedToInbox(shareId: Long, target: com.relayium.android.inbox.InboxSendTarget) {
        val binding = accountBinding() ?: return
        val authority = DispatchAuthority(
            shareId = shareId,
            epoch = shareEpoch.current,
            account = binding,
            target = target.deviceId,
        )
        val items = ingress.staged.value?.items ?: return
        if (!authority.isCurrent(shareEpoch.current, accountBinding())) return
        for (item in items) {
            if (item.displayName.isNullOrBlank() || item.size == null || item.size < 0) return
        }
        val refs = items.map { item ->
            InboxSourceRef(
                uri = com.relayium.android.integration.StagedInboxSources.refUri(item.uri),
                name = item.displayName!!,
                size = item.size!!,
            )
        }
        val share = ingress.take(shareId, shareEpoch.current) ?: return
        val owner = Dispatched(authority, share)
        inboxDispatch = own(inboxDispatch, owner)
        // The staged streams are read inside the send's own `withSources`
        // scope, so the job completing IS the terminal for this owner —
        // whether it succeeded, failed or was cancelled.
        val job = inboxRuntime.sendFiles(target, refs)
        viewModelScope.launch {
            job?.join()
            if (inboxDispatch === owner) inboxDispatch = own(inboxDispatch, null)
        }
    }

    /** Put the staged text in the message draft of the current session. */
    fun dispatchStagedTextToSession() {
        val text = ingress.textFor(shareEpoch.current) ?: return
        updateDraft(text, controller.state.value.linkId)
        ingress.cancel()
    }

    /** Send the staged text as an Inbox message. */
    fun dispatchStagedTextToInbox(target: com.relayium.android.inbox.InboxSendTarget) {
        val binding = accountBinding() ?: return
        val text = ingress.textFor(shareEpoch.current) ?: return
        val authority = DispatchAuthority(
            shareId = -1L,
            epoch = shareEpoch.current,
            account = binding,
            target = target.deviceId,
        )
        if (!authority.isCurrent(shareEpoch.current, accountBinding())) return
        inboxRuntime.sendText(target, text)
        ingress.cancel()
    }

    /**
     * A staged share that a dispatch is reading from, and the identity it was
     * authorised under.
     *
     * ## Why an owner and not a flag
     *
     * `take` moves the share OUT of the staging: from that moment nothing else
     * refers to it, and if the dispatch does not release it its grants are held
     * over somebody's documents until the process dies. One staging slot does
     * not imply one dispatched job — a share can be taken, a second intent
     * staged, and that second one taken too — so each dispatch carries its own
     * owner, and installing a new one for the same destination releases the one
     * it replaces.
     *
     * Released at a real terminal: the reader finishing, the account that
     * authorised it changing, or the host going away. Never left to `onCleared`
     * alone, which is process exit.
     */
    private class Dispatched(
        val authority: DispatchAuthority,
        val share: com.relayium.android.ingress.StagedShare,
        /** The link a session send was authorised on, so a new one releases it. */
        val linkId: Int = 0,
    )

    /** Install an owner, releasing whatever it replaces. */
    private fun own(existing: Dispatched?, fresh: Dispatched?): Dispatched? {
        if (existing !== fresh) existing?.share?.release()
        return fresh
    }

    /** Release every dispatch whose authority is no longer the live one. */
    private fun releaseStaleDispatches() {
        val epoch = shareEpoch.current
        val account = accountBinding()
        if (sessionDispatch?.authority?.isCurrent(epoch, account) == false) {
            sessionDispatch = own(sessionDispatch, null)
        }
        if (cloudDispatch?.authority?.isCurrent(epoch, account) == false) {
            cloudDispatch = own(cloudDispatch, null)
        }
        if (inboxDispatch?.authority?.isCurrent(epoch, account) == false) {
            inboxDispatch = own(inboxDispatch, null)
        }
    }

    /** The `CloudSelection.uri` a staged item is named by. */
    private fun stagedKey(uri: com.relayium.android.ingress.IncomingUri): String =
        com.relayium.android.integration.StagedInboxSources.refUri(uri)

    // ── the Inbox surface ───────────────────────────────────────────────────

    fun inboxRefresh() = inboxRuntime.refresh()
    fun inboxSetPolicy(policy: com.relayium.protocol.inbox.InboxAutoAccept) =
        inboxRuntime.setPolicy(policy)
    fun inboxRespond(taskId: String, accept: Boolean) = inboxRuntime.respond(taskId, accept)
    fun inboxRepairKey() = inboxRuntime.repairKey()
    fun inboxSend(jobId: String) = inboxRuntime.send(jobId)
    fun inboxCancelSend(jobId: String) = inboxRuntime.cancelSend(jobId)
    fun inboxMarkRead(ids: Set<String>) = inboxRuntime.markRead(ids)
    fun inboxDelete(ids: Set<String>) = inboxRuntime.deleteHistory(ids)
    fun inboxSendText(target: com.relayium.android.inbox.InboxSendTarget, text: String) =
        inboxRuntime.sendText(target, text)

    suspend fun inboxMessage(entry: com.relayium.android.inbox.InboxConversationEntry): String? =
        inboxRuntime.message(entry)

    /**
     * The files an entry published, as content URIs another app may read.
     *
     * Every step is re-checked against the account that is adopted NOW:
     * `locate` refuses an entry whose account is no longer current, and the
     * grant records the session so an account change revokes it. A URI is
     * minted only for a file that actually exists inside the app's own
     * no-backup root.
     */
    suspend fun inboxGrantFiles(
        entry: com.relayium.android.inbox.InboxConversationEntry,
    ): List<android.net.Uri> {
        val binding = accountBinding() ?: return emptyList()
        val located = inboxRuntime.locate(entry.id) ?: return emptyList()
        // The authority may have moved while `locate` was reading the ledger.
        val now = accountBinding() ?: return emptyList()
        if (now != binding) return emptyList()
        if (located.account.value != now.accountId) return emptyList()
        val packageName = getApplication<Application>().packageName
        return SharedFileGrants
            .offer(located.files, grantAuthority(now), android.os.SystemClock.elapsedRealtime())
            .map { token ->
                com.relayium.android.integration.InboxSharedFileProvider.uriFor(packageName, token)
            }
    }

    /**
     * Documents the user picked for an Inbox send.
     *
     * The target is re-resolved from the CURRENT device list rather than taken
     * on trust from the launch: a device that has since been revoked, turned
     * receiving off, or belongs to an account that has been replaced is no
     * longer a device this send may address. Names and sizes are the provider's
     * own answers; one it will not give is a refusal, never a guess, for the
     * same reason a cross-network pick refuses it.
     */
    fun inboxSendPicked(uris: List<Uri>, targetDeviceId: String, launchedUnder: Int) {
        if (uris.isEmpty()) return
        val binding = accountBinding() ?: return
        // The account the user was looking at when they chose the device. A
        // sign-out and sign-in during the picker round trip — or a switch to
        // another account — makes this a delivery nobody authorised, to a
        // device id that means something else in the new account's list.
        if (binding.generation != launchedUnder) return
        viewModelScope.launch {
            val refs = withContext(Dispatchers.IO) {
                val resolver = getApplication<Application>().contentResolver
                val out = ArrayList<InboxSourceRef>(uris.size)
                for (uri in uris) {
                    var name: String? = null
                    var size = -1L
                    runCatching {
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
                    if (resolved.isNullOrBlank() || size < 0) return@withContext null
                    out.add(InboxSourceRef(uri.toString(), resolved, size))
                }
                out
            } ?: return@launch
            // The account may have changed while the provider was answering.
            if (accountBinding() != binding) return@launch
            val target = inbox.value.devices.firstOrNull { it.deviceId == targetDeviceId }
                ?: return@launch
            inboxRuntime.sendFiles(target, refs)
        }
    }

    /** What an export into a chosen folder did, as the surface renders it. */
    enum class ExportOutcome { DONE, UNAVAILABLE, FAILED, FAILED_INCOMPLETE }

    /**
     * Copy an entry's files into a folder the user chose.
     *
     * ## The identity is read where it is allowed to be read
     *
     * `AccountSession.authority` must be called on the account model's own
     * dispatcher — it is the serialising owner of every account transition, and
     * sampling it from an IO thread reads a session that may be mid-change. So
     * every check hops to [Dispatchers.Main.immediate] and the copying stays on
     * IO.
     *
     * ## What stops it
     *
     * A change of account stops it through [ExportCoordinator.stop], which
     * closes the streams — ending a write that is already blocked inside the
     * provider — and cancels the job. A newer export supersedes it the same
     * way. Between chunks the loop also checks, which is what makes a long file
     * stop promptly once it is no longer blocked.
     *
     * ## Names, including their directories
     *
     * `InboxEntryFiles.files` is built from the manifest's own relative names,
     * which may contain directories. Exporting `File.name` alone would flatten
     * `photos/a.jpg` and `scans/a.jpg` onto one document and silently lose one
     * of the user's files, so the relative path is reproduced in the tree.
     */
    suspend fun inboxExport(entryId: String, tree: Uri?, launchedUnder: Int): ExportOutcome {
        val destination = tree ?: return ExportOutcome.UNAVAILABLE
        val binding = onOwner { accountBinding() } ?: return ExportOutcome.UNAVAILABLE
        // Captured at the folder choice, compared here: an export authorised as
        // one account must not write another's delivery into the tree.
        if (binding.generation != launchedUnder) return ExportOutcome.UNAVAILABLE
        val located = inboxLocate(entryId) ?: return ExportOutcome.UNAVAILABLE
        if (located.files.isEmpty()) return ExportOutcome.UNAVAILABLE

        val outcome = exports.export { session ->
            val root = runCatching { saf.openTree(destination) }.getOrNull()
                ?: return@export ExportCoordinator.Outcome.UNAVAILABLE
            var result = ExportCoordinator.Outcome.DONE
            for (file in located.files) {
                // Between files, on the dispatcher that owns the answer. The
                // per-chunk check and the stream lease are what cover the file
                // being written right now.
                if (onOwner { accountBinding() } != binding) {
                    result = ExportCoordinator.Outcome.UNAVAILABLE
                    break
                }
                val segments = runCatching {
                    located.directory.toPath().relativize(file.toPath()).map { it.toString() }
                }.getOrNull()
                if (segments.isNullOrEmpty()) {
                    result = ExportCoordinator.Outcome.FAILED
                    break
                }
                var parent = root
                var broke = false
                for (directory in segments.dropLast(1)) {
                    // An existing folder is REUSED and never recorded: it is not
                    // this export's to remove, whatever happens next.
                    val existing = runCatching { saf.findChild(parent, directory) }.getOrNull()
                    val node = if (existing != null) {
                        existing
                    } else {
                        val made = runCatching { saf.createDirectory(parent, directory) }.getOrNull()
                        // Counted, never queued for deletion: a SAF directory
                        // delete is recursive with no empty-only form, so
                        // removing one could destroy what the user put inside
                        // it. A run that leaves these does not claim a clean
                        // folder.
                        if (made != null) session.recordCreatedDirectory()
                        made
                    }
                    if (node == null || !node.isDirectory) {
                        broke = true
                        break
                    }
                    parent = node
                }
                if (broke) {
                    result = ExportCoordinator.Outcome.FAILED
                    break
                }
                val document = runCatching { saf.createFile(parent, segments.last()) }.getOrNull()
                if (document == null) {
                    result = ExportCoordinator.Outcome.FAILED
                    break
                }
                // Recorded BEFORE a byte is written, so a cancellation during
                // the very first chunk still knows what to remove.
                session.recordCreated(ExportCoordinator.Session.Deletable { document.delete() })
                val copied = runCatching {
                    session.copy({ file.inputStream() }, { document.openOut() })
                }
                if (copied.isFailure) {
                    // A cancellation is not a failure of the copy and must not
                    // be reported as one — it is rethrown so the coordinator's
                    // own cancellation path runs.
                    val error = copied.exceptionOrNull()
                    if (error is kotlinx.coroutines.CancellationException) throw error
                    result = ExportCoordinator.Outcome.FAILED
                    break
                }
            }
            result
        }
        return when (outcome) {
            ExportCoordinator.Outcome.DONE -> ExportOutcome.DONE
            ExportCoordinator.Outcome.UNAVAILABLE -> ExportOutcome.UNAVAILABLE
            ExportCoordinator.Outcome.FAILED -> ExportOutcome.FAILED
            ExportCoordinator.Outcome.FAILED_INCOMPLETE -> ExportOutcome.FAILED_INCOMPLETE
        }
    }

    /**
     * Read something on the account model's own dispatcher.
     *
     * `Dispatchers.Main.immediate` is the owner `AccountSession` was built
     * with; a caller already on it does not hop at all.
     */
    private suspend fun <T> onOwner(read: () -> T): T =
        withContext(Dispatchers.Main.immediate) { read() }

    /** Where an entry's files are, for an export into a chosen folder. */    /** Where an entry's files are, for an export into a chosen folder. */
    suspend fun inboxLocate(entryId: String): com.relayium.android.inbox.InboxEntryFiles? {
        val binding = accountBinding() ?: return null
        val located = inboxRuntime.locate(entryId) ?: return null
        val now = accountBinding() ?: return null
        if (now != binding || located.account.value != now.accountId) return null
        return located
    }

    /** Nonblocking by design; a parked provider cannot ANR this. The cloud
     *  store thread is asked to stop after its queued work drains, so a save in
     *  flight still rolls itself back rather than being killed mid-export. */
    override fun onCleared() {
        controller.shutdown()
        cloudStorageExecutor.shutdown()
        // Presence claims first: a host that is going away must not leave a
        // device advertising itself or a `listening` announcement standing.
        applyPresence(presence.onDestroyed())
        leaseSweep?.cancel()
        // Retired rather than expired: reporting a timeout that did not happen
        // would be a false statement about why a pick was dropped.
        pickerLease.retireAll()
        // Every outstanding capability over this account's deliveries ends with
        // the process that granted it. Nothing here survives into a new one.
        SharedFileGrants.revokeAll()
        sessionDispatch = own(sessionDispatch, null)
        cloudDispatch = own(cloudDispatch, null)
        inboxDispatch = own(inboxDispatch, null)
        ingress.cancel()
    }
}
