package com.relayium.android.update

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * The manual update check, as a state machine.
 *
 * Deliberately Android-free — no `Context`, no `Intent`, no resources — so
 * every rule below is exercised by ordinary JVM unit tests: the version
 * comparison, the refusal to publish a cancelled result, the single-flight
 * guard, and the no-browser fallback.
 *
 * ## What it will not do
 *
 * * It never polls. There is no timer, no worker, no lifecycle observer; the
 *   only thing that starts a check is [check], and the only thing that calls
 *   [check] is a button the user pressed.
 * * It never installs. [download] hands a URL to the system browser and stops
 *   there; the user downloads it and the system installer asks them to confirm.
 *   That is why this app needs no `REQUEST_INSTALL_PACKAGES`.
 * * It never reports "up to date" for a check that failed. Every transport and
 *   parse failure lands in [UpdateUi.Failed]; not knowing is its own answer.
 */
class UpdateChecker(
    private val scope: CoroutineScope,
    private val source: FeedSource,
    private val feedUrl: String,
    private val installedVersionCode: Int,
    private val installedVersionName: String,
    /** Locale tag used to pick a release note; English is the fallback. */
    private val localeTag: () -> String,
    /** Opens a URL in the system browser. `false` means nothing could handle
     *  it — a device with no browser — which the UI turns into a visible,
     *  copyable URL rather than a dead button. */
    private val openUrl: (String) -> Boolean,
) {

    /** Everything the update row can be showing. */
    sealed interface UpdateUi {

        /** Nothing has been asked yet: the row is just the version and a button. */
        data object Idle : UpdateUi

        /** A check is in flight: a spinner shows, and the control becomes
         *  Cancel rather than a disabled Check. */
        data object Checking : UpdateUi

        /** The publisher distributes nothing right now — the placeholder
         *  manifest, or a withdrawn release. Not an error, and not an offer. */
        data object NoneDistributed : UpdateUi

        /** Published version is not newer than this one. A feed that has gone
         *  backwards lands here too: a downgrade is never offered. */
        data class UpToDate(val installedVersionName: String) : UpdateUi

        /** Strictly newer. The only state with a download action. */
        data class Available(
            val versionName: String,
            val versionCode: Int,
            val downloadUrl: String,
            /** Plain text, already locale-resolved and length-bounded. */
            val note: String,
        ) : UpdateUi

        data class Failed(val error: UpdateError) : UpdateUi
    }

    /** One honest sentence each, in `strings.xml`. Kept granular so a test can
     *  tell a refused document from an unreachable one. */
    enum class UpdateError {
        NETWORK,
        TIMEOUT,
        SERVER,
        TOO_LARGE,
        MALFORMED,
        UNTRUSTED,
    }

    private val _state = MutableStateFlow<UpdateUi>(UpdateUi.Idle)
    val state: StateFlow<UpdateUi> = _state.asStateFlow()

    /**
     * Set when the browser could not be opened, so the UI can show the URL as
     * selectable text instead. Cleared whenever a new check starts, so a stale
     * fallback never lingers over a fresh result.
     */
    private val _browserMissingUrl = MutableStateFlow<String?>(null)
    val browserMissingUrl: StateFlow<String?> = _browserMissingUrl.asStateFlow()

    private var job: Job? = null

    /**
     * Generation guard.
     *
     * Cancelling a coroutine does not un-schedule work that has already got as
     * far as computing its answer, so a late completion could otherwise publish
     * over a newer state — "you are up to date" appearing a second after the
     * user cancelled, or after a second check already started. Every write to
     * [_state] after the suspension point is gated on the generation still
     * being the one this run started with.
     */
    private var generation: Int = 0

    /**
     * Start a check. A second press while one is in flight is IGNORED rather
     * than queued or restarted: restarting would make an impatient double-tap
     * slower than a single one. In practice the UI also replaces Check with
     * Cancel for the duration, so a second Check is not reachable — this guard
     * is what makes that a property of the state machine rather than of one
     * layout.
     */
    fun check() {
        if (job?.isActive == true) return
        val mine = ++generation
        _browserMissingUrl.value = null
        _state.value = UpdateUi.Checking
        job = scope.launch {
            val result = source.fetch(feedUrl)
            if (generation != mine) return@launch
            _state.value = interpret(result)
        }
    }

    /** Abandon an in-flight check and return to the resting state. The
     *  cancelled run cannot publish afterwards — see [generation]. */
    fun cancel() {
        generation++
        job?.cancel()
        job = null
        _state.value = UpdateUi.Idle
    }

    /**
     * Open the published download page in the system browser.
     *
     * Only ever reachable from [UpdateUi.Available], whose `downloadUrl` was
     * validated by [UpdateFeed.isOfficialDownloadUrl] before it got there. The
     * URL is re-checked here anyway: this is the last point before the URL
     * leaves the app, and a cheap re-assertion at the boundary is worth more
     * than the assumption that no future edit will introduce another path to
     * this method.
     */
    fun download() {
        val available = _state.value as? UpdateUi.Available ?: return
        if (!UpdateFeed.isOfficialDownloadUrl(
                available.downloadUrl,
                available.versionName,
                available.versionCode,
            )
        ) {
            _state.value = UpdateUi.Failed(UpdateError.UNTRUSTED)
            return
        }
        _browserMissingUrl.value = if (openUrl(available.downloadUrl)) null else available.downloadUrl
    }

    /**
      * Return to the resting state, abandoning any check in flight.
      *
      * Not currently called: [cancel] covers the one path the UI has. Kept
      * because it is the complete form — it also clears the no-browser
      * fallback — and a caller that needed to clear the row without the user
      * pressing Cancel would want this rather than a second partial reset.
      */
    fun reset() {
        generation++
        job?.cancel()
        job = null
        _browserMissingUrl.value = null
        _state.value = UpdateUi.Idle
    }

    private fun interpret(result: FetchResult): UpdateUi = when (result) {
        is FetchResult.Failed -> UpdateUi.Failed(
            when (result.why) {
                Failure.NETWORK -> UpdateError.NETWORK
                Failure.TIMEOUT -> UpdateError.TIMEOUT
                Failure.STATUS -> UpdateError.SERVER
                Failure.TOO_LARGE -> UpdateError.TOO_LARGE
                Failure.NOT_TEXT -> UpdateError.MALFORMED
            },
        )

        is FetchResult.Body -> when (val parsed = UpdateFeed.parse(result.text)) {
            is UpdateFeed.Parsed.Refused -> UpdateUi.Failed(
                when (parsed.why) {
                    UpdateFeed.Rejection.NOT_JSON,
                    UpdateFeed.Rejection.MALFORMED,
                    UpdateFeed.Rejection.UNKNOWN_SCHEMA,
                    -> UpdateError.MALFORMED

                    UpdateFeed.Rejection.WRONG_APPLICATION,
                    UpdateFeed.Rejection.UNTRUSTED_URL,
                    -> UpdateError.UNTRUSTED
                },
            )

            is UpdateFeed.Parsed.Ok ->
                when (
                    val outcome =
                        UpdateFeed.outcome(parsed.feed, installedVersionCode, installedVersionName)
                ) {
                    is UpdateFeed.Outcome.NoneDistributed -> UpdateUi.NoneDistributed
                    is UpdateFeed.Outcome.UpToDate -> UpdateUi.UpToDate(outcome.installedVersionName)
                    is UpdateFeed.Outcome.Available -> UpdateUi.Available(
                        versionName = outcome.release.versionName,
                        versionCode = outcome.release.versionCode,
                        downloadUrl = outcome.release.downloadUrl,
                        note = UpdateFeed.noteFor(outcome.release.notes, localeTag()),
                    )
                }
        }
    }
}
