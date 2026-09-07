package com.relayium.protocol

import java.io.File
import kotlin.test.assertNotNull

/**
 * The SHARED cross-language fixtures, read-only.
 *
 * Nothing under `apps/android` copies or retypes a fixture value. These files
 * are generated from the shipped Web implementation and gated byte-for-byte by
 * `web/scripts/check-wire-vectors.mjs`; a second transcription here would be a
 * second thing to keep in sync, which is the exact drift that gate exists to
 * prevent.
 *
 * They are located through the `relayium.fixtures` system property, which
 * `protocol/build.gradle.kts` sets to the repository path. A missing property or
 * a missing file FAILS rather than skipping: a conformance suite that silently
 * runs zero vectors is worse than no suite, because it is green.
 *
 * Parsed with this module's own [Json], deliberately. It is the parser the
 * product runs, so every fixture read is also a test of it.
 */
object Fixtures {

    private val root: File by lazy {
        val path = System.getProperty("relayium.fixtures")
            ?: error(
                "relayium.fixtures is not set. protocol/build.gradle.kts points it at " +
                    "apps/RelayiumKit/Tests/Fixtures; without it this suite would assert nothing.",
            )
        File(path).also {
            check(it.isDirectory) { "fixture directory does not exist: $path" }
        }
    }

    private fun load(name: String): Json.Obj {
        val file = File(root, name)
        check(file.isFile) { "fixture $name is missing from ${root.absolutePath}" }
        val parsed = Json.parse(file.readText(Charsets.UTF_8))
        return parsed as? Json.Obj ?: error("fixture $name is not a JSON object")
    }

    val crypto: Json.Obj by lazy { load("crypto-vectors.json") }
    val wire: Json.Obj by lazy { load("realtime-wire-vectors.json") }

    // ── typed accessors, so a test reads like the thing it asserts ──────────

    fun obj(parent: Json.Obj, vararg path: String): Json.Obj {
        var current: Json = parent
        for (key in path) {
            val o = current as? Json.Obj ?: error("not an object at $key")
            current = o[key] ?: error("fixture path ${path.joinToString(".")} is missing at $key")
        }
        return current as? Json.Obj ?: error("fixture path ${path.joinToString(".")} is not an object")
    }

    fun arr(parent: Json.Obj, vararg path: String): List<Json> {
        var current: Json = parent
        for (key in path) {
            val o = current as? Json.Obj ?: error("not an object at $key")
            current = o[key] ?: error("fixture path ${path.joinToString(".")} is missing at $key")
        }
        return (current as? Json.Arr)?.items ?: error("fixture path ${path.joinToString(".")} is not an array")
    }

    fun str(parent: Json.Obj, vararg path: String): String {
        var current: Json = parent
        for (key in path) {
            val o = current as? Json.Obj ?: error("not an object at $key")
            current = o[key] ?: error("fixture path ${path.joinToString(".")} is missing at $key")
        }
        return (current as? Json.Str)?.value ?: error("fixture path ${path.joinToString(".")} is not a string")
    }

    fun num(parent: Json.Obj, vararg path: String): Long {
        var current: Json = parent
        for (key in path) {
            val o = current as? Json.Obj ?: error("not an object at $key")
            current = o[key] ?: error("fixture path ${path.joinToString(".")} is missing at $key")
        }
        val n = (current as? Json.Num)?.value ?: error("fixture path ${path.joinToString(".")} is not a number")
        return n.toLong()
    }

    fun string(value: Json?): String = assertNotNull(value as? Json.Str, "expected a string").value

    fun number(value: Json?): Long = assertNotNull(value as? Json.Num, "expected a number").value.toLong()

    fun bool(value: Json?): Boolean = assertNotNull(value as? Json.Bool, "expected a boolean").value

    fun optionalString(value: Json?): String? = (value as? Json.Str)?.value

    fun optionalBool(value: Json?): Boolean? = (value as? Json.Bool)?.value

    /** A UTF-16 code-unit array from the fixture, rebuilt into a String.
     *
     *  The escaping vectors are written that way so the file stays pure ASCII
     *  and can carry an unpaired surrogate without putting one in the JSON. */
    fun fromUtf16(value: Json?): String {
        val items = (value as? Json.Arr)?.items ?: error("expected a UTF-16 code-unit array")
        val out = StringBuilder(items.size)
        for (item in items) out.append(number(item).toInt().toChar())
        return out.toString()
    }
}
