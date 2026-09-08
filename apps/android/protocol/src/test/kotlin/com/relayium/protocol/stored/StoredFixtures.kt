package com.relayium.protocol.stored

import com.relayium.protocol.Json
import java.io.File

/**
 * `store-wire-vectors.json`, the shared cross-language fixture, read-only.
 *
 * Located through the same `relayium.fixtures` property `protocol/build.gradle.kts`
 * sets for the crypto and realtime suites, and declared there as a task input so
 * an edit to the fixture really re-runs this suite. Nothing here retypes a
 * fixture value: the file is generated from the shipped Web implementation and
 * gated by `web/scripts/check-wire-vectors.mjs`, so a second transcription would
 * be a second thing to keep in sync. A missing property or file FAILS rather
 * than skipping — a conformance suite that silently asserts nothing is worse
 * than no suite, because it is green.
 */
object StoredFixtures {

    val vectors: Json.Obj by lazy {
        val path = System.getProperty("relayium.fixtures")
            ?: error(
                "relayium.fixtures is not set. protocol/build.gradle.kts points it at " +
                    "apps/RelayiumKit/Tests/Fixtures; without it this suite would assert nothing.",
            )
        val file = File(path, "store-wire-vectors.json")
        check(file.isFile) { "fixture store-wire-vectors.json is missing from $path" }
        Json.parse(file.readText(Charsets.UTF_8)) as? Json.Obj
            ?: error("store-wire-vectors.json is not a JSON object")
    }
}
