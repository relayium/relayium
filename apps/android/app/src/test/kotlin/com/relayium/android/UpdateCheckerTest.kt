package com.relayium.android

import com.relayium.android.update.Failure
import com.relayium.android.update.FeedSource
import com.relayium.android.update.FetchResult
import com.relayium.android.update.UpdateChecker
import com.relayium.android.update.UpdateFeed
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The state machine: what the row shows, and what it refuses to show.
 *
 * No Android types and no sockets — the checker is deliberately built to be
 * driven from here, so the properties that matter most (a failed check is never
 * "up to date", a cancelled check publishes nothing, a downgrade is never
 * offered) are ordinary assertions rather than things only an emulator run
 * could observe.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class UpdateCheckerTest {

    private val installedCode = 2
    private val installedName = "0.1.1"

    private fun releaseDoc(versionCode: Int = 3, versionName: String = "0.1.2"): String =
        """{"schema":1,"android":{"available":true,"applicationId":"com.relayium.android",""" +
            """"versionCode":$versionCode,"versionName":"$versionName",""" +
            """"downloadUrl":"https://github.com${UpdateFeed.assetPath(versionName, versionCode)}",""" +
            """"sha256":"${"a".repeat(64)}","size":40000000,"notes":{"en":"Fixes","zh":"修复"}}}"""

    private fun checker(
        scope: kotlinx.coroutines.CoroutineScope,
        source: FeedSource,
        locale: String = "en",
        open: (String) -> Boolean = { true },
    ) = UpdateChecker(
        scope = scope,
        source = source,
        feedUrl = "https://relayium.com/apps/android/update.json",
        installedVersionCode = installedCode,
        installedVersionName = installedName,
        localeTag = { locale },
        openUrl = open,
    )

    // ── outcomes ────────────────────────────────────────────────────────────

    @Test
    fun `offers a strictly newer release with a localised note`() = runTest {
        val c = checker(this, { FetchResult.Body(releaseDoc()) }, locale = "zh-Hans-CN")
        c.check()
        advanceUntilIdle()
        val state = c.state.value
        assertTrue("got $state", state is UpdateChecker.UpdateUi.Available)
        state as UpdateChecker.UpdateUi.Available
        assertEquals("0.1.2", state.versionName)
        assertEquals("修复", state.note)
    }

    @Test
    fun `falls back to the english note`() = runTest {
        val c = checker(this, { FetchResult.Body(releaseDoc()) }, locale = "fr-FR")
        c.check()
        advanceUntilIdle()
        assertEquals("Fixes", (c.state.value as UpdateChecker.UpdateUi.Available).note)
    }

    @Test
    fun `reports the same version as up to date and offers nothing`() = runTest {
        val c = checker(this, { FetchResult.Body(releaseDoc(versionCode = 2, versionName = "0.1.1")) })
        c.check()
        advanceUntilIdle()
        assertEquals(UpdateChecker.UpdateUi.UpToDate(installedName), c.state.value)
    }

    /** A feed that has gone BACKWARDS — a rolled-back release, or a stale CDN
     *  copy — must never become a downgrade offer. */
    @Test
    fun `never offers a downgrade`() = runTest {
        val c = checker(this, { FetchResult.Body(releaseDoc(versionCode = 1, versionName = "0.1.0")) })
        c.check()
        advanceUntilIdle()
        assertEquals(UpdateChecker.UpdateUi.UpToDate(installedName), c.state.value)
    }

    @Test
    fun `treats available false as its own answer`() = runTest {
        val c = checker(this, { FetchResult.Body("""{"schema":1,"android":{"available":false}}""") })
        c.check()
        advanceUntilIdle()
        assertEquals(UpdateChecker.UpdateUi.NoneDistributed, c.state.value)
    }

    // ── never a bogus "latest" ──────────────────────────────────────────────

    /** The single most important property in this file. Every way a check can
     *  fail must render as a failure; a check that could not reach the
     *  publisher has learned NOTHING about whether an update exists. */
    @Test
    fun `never reports up to date for a check that failed`() = runTest {
        val cases = mapOf(
            FetchResult.Failed(Failure.NETWORK) to UpdateChecker.UpdateError.NETWORK,
            FetchResult.Failed(Failure.TIMEOUT) to UpdateChecker.UpdateError.TIMEOUT,
            FetchResult.Failed(Failure.STATUS) to UpdateChecker.UpdateError.SERVER,
            FetchResult.Failed(Failure.TOO_LARGE) to UpdateChecker.UpdateError.TOO_LARGE,
            FetchResult.Failed(Failure.NOT_TEXT) to UpdateChecker.UpdateError.MALFORMED,
        )
        for ((result, expected) in cases) {
            val c = checker(this, { result })
            c.check()
            advanceUntilIdle()
            assertEquals(result.toString(), UpdateChecker.UpdateUi.Failed(expected), c.state.value)
        }
    }

    @Test
    fun `renders a refused document as an error, not as an offer`() = runTest {
        val cases = mapOf(
            "<!doctype html>404" to UpdateChecker.UpdateError.MALFORMED,
            """{"schema":9,"android":{"available":false}}""" to UpdateChecker.UpdateError.MALFORMED,
            // Right shape, wrong package.
            releaseDoc().replace("com.relayium.android", "com.evil.app")
                to UpdateChecker.UpdateError.UNTRUSTED,
            // Right shape, URL pointing at the PREVIOUS release's asset.
            releaseDoc().replace(
                UpdateFeed.assetPath("0.1.2", 3),
                UpdateFeed.assetPath("0.1.1", 2),
            ) to UpdateChecker.UpdateError.UNTRUSTED,
        )
        for ((doc, expected) in cases) {
            val c = checker(this, { FetchResult.Body(doc) })
            c.check()
            advanceUntilIdle()
            assertEquals(doc.take(40), UpdateChecker.UpdateUi.Failed(expected), c.state.value)
        }
    }

    // ── concurrency ─────────────────────────────────────────────────────────

    /** An impatient double-tap must not fire two requests, and must not restart
     *  the one already running. */
    @Test
    fun `is single flight across repeated presses`() = runTest {
        val calls = AtomicInteger(0)
        val gate = CompletableDeferred<Unit>()
        val c = checker(
            this,
            {
                calls.incrementAndGet()
                gate.await()
                FetchResult.Body(releaseDoc())
            },
        )
        c.check()
        // Let the first check actually reach the fetch and suspend there, so
        // the presses below happen while a request is genuinely in flight —
        // which is the case the guard exists for.
        advanceUntilIdle()
        assertEquals(UpdateChecker.UpdateUi.Checking, c.state.value)
        assertEquals(1, calls.get())

        c.check()
        c.check()
        advanceUntilIdle()
        assertEquals("a second press started another request", 1, calls.get())
        assertEquals(UpdateChecker.UpdateUi.Checking, c.state.value)

        gate.complete(Unit)
        advanceUntilIdle()
        assertEquals(1, calls.get())
        assertTrue(c.state.value is UpdateChecker.UpdateUi.Available)
    }

    /** A cancelled check goes back to rest AND its late completion must not
     *  overwrite that. Cancelling a coroutine does not un-schedule work that
     *  already computed its answer, which is what the generation guard is for. */
    @Test
    fun `a cancelled check publishes nothing afterwards`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val c = checker(
            this,
            {
                gate.await()
                FetchResult.Body(releaseDoc())
            },
        )
        c.check()
        assertEquals(UpdateChecker.UpdateUi.Checking, c.state.value)
        c.cancel()
        assertEquals(UpdateChecker.UpdateUi.Idle, c.state.value)
        gate.complete(Unit)
        advanceUntilIdle()
        assertEquals("a cancelled check published a stale result", UpdateChecker.UpdateUi.Idle, c.state.value)
    }

    /** After cancelling, a fresh check must still work — the guard must not
     *  latch the checker shut. */
    @Test
    fun `can check again after cancelling`() = runTest {
        val c = checker(this, { FetchResult.Body(releaseDoc()) })
        c.check()
        c.cancel()
        c.check()
        advanceUntilIdle()
        assertTrue(c.state.value is UpdateChecker.UpdateUi.Available)
    }

    // ── download hand-off ───────────────────────────────────────────────────

    @Test
    fun `opens the official url and reports no fallback`() = runTest {
        var opened: String? = null
        val c = checker(this, { FetchResult.Body(releaseDoc()) }, open = { opened = it; true })
        c.check()
        advanceUntilIdle()
        c.download()
        assertEquals("https://github.com" + UpdateFeed.assetPath("0.1.2", 3), opened)
        assertNull(c.browserMissingUrl.value)
    }

    /** A device with no browser: the URL becomes visible, copyable text rather
     *  than a button that silently does nothing. */
    @Test
    fun `surfaces the url when no browser can open it`() = runTest {
        val c = checker(this, { FetchResult.Body(releaseDoc()) }, open = { false })
        c.check()
        advanceUntilIdle()
        c.download()
        assertEquals("https://github.com" + UpdateFeed.assetPath("0.1.2", 3), c.browserMissingUrl.value)
        // The offer itself survives, so the user can retry or copy.
        assertTrue(c.state.value is UpdateChecker.UpdateUi.Available)
    }

    @Test
    fun `download does nothing unless an update is actually on offer`() = runTest {
        var opened = 0
        val c = checker(this, { FetchResult.Failed(Failure.NETWORK) }, open = { opened++; true })
        c.download() // before any check
        c.check()
        advanceUntilIdle()
        c.download() // after a failure
        assertEquals(0, opened)
    }

    @Test
    fun `a new check clears a previous no browser fallback`() = runTest {
        val c = checker(this, { FetchResult.Body(releaseDoc()) }, open = { false })
        c.check()
        advanceUntilIdle()
        c.download()
        assertTrue(c.browserMissingUrl.value != null)
        c.check()
        assertNull(c.browserMissingUrl.value)
    }
}
