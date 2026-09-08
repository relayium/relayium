package com.relayium.protocol.inbox

import com.relayium.protocol.Json
import java.io.File

/**
 * `device-inbox-manifest-v3-vectors.json`, the frozen cross-language fixture,
 * read-only.
 *
 * Located through the same `relayium.fixtures` property `protocol/build.gradle.kts`
 * sets for the crypto, realtime and stored suites, and declared there as a task
 * input so an edit to the fixture really re-runs this suite. Nothing here
 * retypes a fixture value: the file is hand-authored and gated by
 * `compat / wire-vectors`, so a second transcription would be a second thing to
 * keep in sync. A missing property or file FAILS rather than skipping — a
 * conformance suite that silently asserts nothing is worse than no suite,
 * because it is green.
 */
object InboxFixtures {

    val manifestVectors: Json.Obj by lazy {
        val path = System.getProperty("relayium.fixtures")
            ?: error(
                "relayium.fixtures is not set. protocol/build.gradle.kts points it at " +
                    "apps/RelayiumKit/Tests/Fixtures; without it this suite would assert nothing.",
            )
        val file = File(path, "device-inbox-manifest-v3-vectors.json")
        check(file.isFile) { "fixture device-inbox-manifest-v3-vectors.json is missing from $path" }
        Json.parse(file.readText(Charsets.UTF_8)) as? Json.Obj
            ?: error("device-inbox-manifest-v3-vectors.json is not a JSON object")
    }
}
