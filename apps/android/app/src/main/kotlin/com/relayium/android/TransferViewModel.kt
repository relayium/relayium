package com.relayium.android

import android.app.Application
import android.net.Uri
import android.provider.OpenableColumns
import androidx.core.net.toUri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.relayium.android.storage.ProviderOps
import com.relayium.android.update.UpdateChecker
import com.relayium.android.update.UpdateEndpoint
import com.relayium.protocol.FileMeta
import com.relayium.protocol.JoinInput
import kotlinx.coroutines.Dispatchers
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

    /** Raw input from the join field or an incoming relayium.com link. */
    fun join(raw: String) {
        when (val parsed = JoinInput.parse(raw)) {
            is JoinInput.Result.Code -> {
                _joinError.value = null
                controller.join(parsed.code)
            }
            is JoinInput.Result.Rejected -> _joinError.value = parsed.reason
        }
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

    fun disconnect() = controller.disconnect()
    fun dismissCleanupWarning() = controller.dismissCleanupWarning()

    /** Nonblocking by design; a parked provider cannot ANR this. */
    override fun onCleared() = controller.shutdown()
}
