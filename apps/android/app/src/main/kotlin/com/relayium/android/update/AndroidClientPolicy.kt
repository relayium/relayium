package com.relayium.android.update

import com.relayium.protocol.Json
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/** A non-blocking recommendation. The official release feed remains the only
 * source of an install URL and must independently confirm this exact build. */
data class AndroidClientPolicy(
    val revision: Int,
    val recommendedVersion: String,
    val recommendedBuild: Int,
) {
    companion object {
        const val URL = "https://relayium.com/api/client-policy/android"
        const val MIN_REVISION = 1
        const val MAX_BODY_BYTES = 16 * 1024

        fun parse(text: String): AndroidClientPolicy? {
            if (text.toByteArray(Charsets.UTF_8).size > MAX_BODY_BYTES) return null
            val root = Json.parseOrNull(text) as? Json.Obj ?: return null
            if (root.keys != setOf("schema", "android")) return null
            if (root["schema"].integer() != 1) return null
            val android = root["android"] as? Json.Obj ?: return null
            if (android.keys != setOf(
                    "policyRevision", "recommendedVersion", "recommendedBuild", "channel",
                )
            ) return null
            val revision = android["policyRevision"].integer() ?: return null
            val version = (android["recommendedVersion"] as? Json.Str)?.value ?: return null
            val build = android["recommendedBuild"].integer() ?: return null
            val channel = (android["channel"] as? Json.Str)?.value ?: return null
            if (revision < MIN_REVISION || build < 1 || channel != "direct") return null
            if (!Regex("^(0|[1-9][0-9]{0,4})\\.(0|[1-9][0-9]{0,4})\\.(0|[1-9][0-9]{0,4})$").matches(version)) {
                return null
            }
            return AndroidClientPolicy(revision, version, build)
        }

        private fun Json?.integer(): Int? {
            val number = this as? Json.Num ?: return null
            if (!number.value.isFinite() || number.value < Int.MIN_VALUE || number.value > Int.MAX_VALUE) {
                return null
            }
            val integer = number.value.toInt()
            return integer.takeIf { it.toDouble() == number.value }
        }
    }
}

/** Launch/foreground refresher. Failures are silent because this is advisory;
 * the manual checker remains available and is the surface that reports them. */
class AndroidPolicyAdvisor(
    private val scope: CoroutineScope,
    private val source: FeedSource,
    private val updates: UpdateChecker,
    private val installedBuild: Int,
    private val nowMillis: () -> Long,
    private val policyUrl: String = AndroidClientPolicy.URL,
    private val intervalMillis: Long = 6 * 60 * 60 * 1000L,
) {
    private var lastAttempt = Long.MIN_VALUE
    private var job: Job? = null

    fun foreground() {
        val now = nowMillis()
        if (job?.isActive == true) return
        if (lastAttempt != Long.MIN_VALUE && now - lastAttempt < intervalMillis) return
        lastAttempt = now
        job = scope.launch {
            val result = source.fetch(policyUrl) as? FetchResult.Body ?: return@launch
            val policy = AndroidClientPolicy.parse(result.text) ?: return@launch
            if (policy.recommendedBuild <= installedBuild) return@launch
            updates.checkRecommendation(policy.recommendedVersion, policy.recommendedBuild)
        }
    }
}
