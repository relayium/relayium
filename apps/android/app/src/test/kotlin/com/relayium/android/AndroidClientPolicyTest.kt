package com.relayium.android

import com.relayium.android.update.AndroidClientPolicy
import com.relayium.android.update.AndroidPolicyAdvisor
import com.relayium.android.update.FeedSource
import com.relayium.android.update.FetchResult
import com.relayium.android.update.UpdateChecker
import com.relayium.android.update.UpdateFeed
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AndroidClientPolicyTest {
    private fun policy(build: Int = 10, version: String = "0.3.1") =
        """{"schema":1,"android":{"policyRevision":1,"recommendedVersion":"$version","recommendedBuild":$build,"channel":"direct"}}"""

    private fun feed(build: Int = 10, version: String = "0.3.1") =
        """{"schema":1,"android":{"available":true,"applicationId":"com.relayium.android","versionCode":$build,"versionName":"$version","downloadUrl":"https://github.com${UpdateFeed.assetPath(version, build)}","sha256":"${"a".repeat(64)}","size":42,"notes":{"en":"Fixes"}}}"""

    @Test fun `strict policy accepts only direct numeric recommendations`() {
        assertEquals(10, AndroidClientPolicy.parse(policy())?.recommendedBuild)
        for (bad in listOf(
            policy().replace("direct", "play"),
            policy().replace("\"schema\":1", "\"schema\":2"),
            policy().replace("0.3.1", "0.3.1-beta"),
            policy().replace("\"policyRevision\":1", "\"policyRevision\":0"),
        )) assertEquals(null, AndroidClientPolicy.parse(bad))
    }

    @Test fun `foreground is rate limited and exact feed match becomes advisory card`() = runTest {
        var now = 100L
        val policyCalls = AtomicInteger()
        val feedCalls = AtomicInteger()
        val source = FeedSource { url ->
            if (url == AndroidClientPolicy.URL) {
                policyCalls.incrementAndGet(); FetchResult.Body(policy())
            } else {
                feedCalls.incrementAndGet(); FetchResult.Body(feed())
            }
        }
        val checker = UpdateChecker(this, source, UpdateFeed.OFFICIAL_URL, 9, "0.3.0", { "en" }, { true })
        val advisor = AndroidPolicyAdvisor(this, source, checker, 9, { now }, intervalMillis = 1_000)
        advisor.foreground(); advanceUntilIdle()
        assertTrue(checker.state.value is UpdateChecker.UpdateUi.Available)
        advisor.foreground(); advanceUntilIdle()
        assertEquals(1, policyCalls.get())
        assertEquals(1, feedCalls.get())
        now += 1_000
        advisor.foreground(); advanceUntilIdle()
        assertEquals(2, policyCalls.get())
    }

    @Test fun `unavailable malformed stale and mismatched policy remain silent`() = runTest {
        for ((policyBody, feedBody) in listOf(
            "bad" to feed(),
            policy(build = 9, version = "0.3.0") to feed(),
            policy() to feed(build = 11, version = "0.3.2"),
        )) {
            val source = FeedSource { url -> FetchResult.Body(if (url == AndroidClientPolicy.URL) policyBody else feedBody) }
            val checker = UpdateChecker(this, source, UpdateFeed.OFFICIAL_URL, 9, "0.3.0", { "en" }, { true })
            AndroidPolicyAdvisor(this, source, checker, 9, { 1 }).foreground()
            advanceUntilIdle()
            assertEquals(UpdateChecker.UpdateUi.Idle, checker.state.value)
        }
    }

    @Test fun `manual check supersedes a silent advisory feed request`() = runTest {
        val first = CompletableDeferred<Unit>()
        var calls = 0
        val source = FeedSource {
            calls++
            if (calls == 1) first.await()
            FetchResult.Body(feed())
        }
        val checker = UpdateChecker(this, source, UpdateFeed.OFFICIAL_URL, 9, "0.3.0", { "en" }, { true })
        checker.checkRecommendation("0.3.1", 10)
        advanceUntilIdle()
        checker.check()
        advanceUntilIdle()
        assertEquals(2, calls)
        assertTrue(checker.state.value is UpdateChecker.UpdateUi.Available)
        first.complete(Unit)
        advanceUntilIdle()
        assertTrue(checker.state.value is UpdateChecker.UpdateUi.Available)
    }
}
