package com.relayium.android.ui

import androidx.annotation.StringRes
import com.relayium.android.R

/**
 * The help layer's content, one topic per destination (A31 b), in the shape the
 * Mac's `HelpPresentation.HelpTopic` uses: a purpose, three steps, what
 * Relayium can see, where things end up, the usual failure and what to do
 * about it. Written for this phone app — its folder picker, its foreground-only
 * limits, its Cloud tab — rather than copied from the Mac, whose words ("this
 * Mac", "Downloads folder") are not true here.
 *
 * A guide link appears only where a guide on relayium.com is actually about
 * what this screen does and exists in both maintained languages. The Mac's
 * cross-network and stored-link guides are command-line guides, so they are NOT
 * linked from a phone; Inbox and Account have no guide at all.
 */
internal data class HelpTopic(
    @StringRes val purpose: Int,
    @StringRes val steps: List<Int>,
    @StringRes val boundary: Int,
    @StringRes val where: Int,
    @StringRes val failure: Int,
    @StringRes val recovery: Int,
    /** The guide's slug under `/guides/` and `/zh/guides/`, or null. */
    val guideSlug: String?,
)

internal object HelpTopics {

    fun topic(destination: Destination): HelpTopic = when (destination) {
        Destination.TRANSFER -> HelpTopic(
            purpose = R.string.help_transfer_purpose,
            steps = listOf(R.string.help_transfer_step1, R.string.help_transfer_step2, R.string.help_transfer_step3),
            boundary = R.string.help_transfer_boundary,
            where = R.string.help_transfer_where,
            failure = R.string.help_transfer_failure,
            recovery = R.string.help_transfer_recovery,
            guideSlug = "what-is-peer-to-peer-file-transfer",
        )
        Destination.NEARBY -> HelpTopic(
            purpose = R.string.help_nearby_purpose,
            steps = listOf(R.string.help_nearby_step1, R.string.help_nearby_step2, R.string.help_nearby_step3),
            boundary = R.string.help_nearby_boundary,
            where = R.string.help_nearby_where,
            failure = R.string.help_nearby_failure,
            recovery = R.string.help_nearby_recovery,
            guideSlug = "what-is-peer-to-peer-file-transfer",
        )
        Destination.INBOX -> HelpTopic(
            purpose = R.string.help_inbox_purpose,
            steps = listOf(R.string.help_inbox_step1, R.string.help_inbox_step2, R.string.help_inbox_step3),
            boundary = R.string.help_inbox_boundary,
            where = R.string.help_inbox_where,
            failure = R.string.help_inbox_failure,
            recovery = R.string.help_inbox_recovery,
            guideSlug = null,
        )
        Destination.CLOUD -> HelpTopic(
            purpose = R.string.help_cloud_purpose,
            steps = listOf(R.string.help_cloud_step1, R.string.help_cloud_step2, R.string.help_cloud_step3),
            boundary = R.string.help_cloud_boundary,
            where = R.string.help_cloud_where,
            failure = R.string.help_cloud_failure,
            recovery = R.string.help_cloud_recovery,
            guideSlug = "how-relayium-encrypts-your-files",
        )
        Destination.ACCOUNT -> HelpTopic(
            purpose = R.string.help_account_purpose,
            steps = listOf(R.string.help_account_step1, R.string.help_account_step2, R.string.help_account_step3),
            boundary = R.string.help_account_boundary,
            where = R.string.help_account_where,
            failure = R.string.help_account_failure,
            recovery = R.string.help_account_recovery,
            guideSlug = null,
        )
    }

    /**
     * The guide's address, on the app's OWN origin — never on anything a server
     * said — in the language the app is showing: `/guides/<slug>` for English,
     * `/zh/guides/<slug>` for Simplified Chinese. [language] is the maintained
     * language the resources resolved to (`R.string.help_guide_language`), so a
     * locale this app falls back to English for gets the English guide too.
     */
    fun guideUrl(origin: String, slug: String, language: String): String {
        val base = origin.trimEnd('/')
        return if (language == "zh") "$base/zh/guides/$slug" else "$base/guides/$slug"
    }
}
