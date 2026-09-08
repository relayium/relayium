package com.relayium.android.integration

import androidx.test.platform.app.InstrumentationRegistry
import java.io.File

/**
 * The secrets a live run needs, read once from a file only this app can open.
 *
 * ## Why not an instrumentation argument
 *
 * `am instrument -e name value` puts the value in the **argv of a process**. It
 * is visible to `ps`, it is echoed by a shell that traces, and it lands in the
 * instrumentation log the harness keeps for diagnosis — which is precisely the
 * artifact a failed run gets attached to a report. An ephemeral acceptance
 * password is still a credential for a real account on a real server, and the
 * rule this project applies to bearers applies to it: not in argv, not in an
 * environment dump, not in a log.
 *
 * So the harness writes the values into the app's own `filesDir` over
 * `run-as … cat > …` with the content arriving on **stdin**, never as a shell
 * word. Nothing interpolates a secret into a command line at any point on
 * either side.
 *
 * ## Read once, then gone
 *
 * [load] deletes the file as soon as it has been parsed. A test device is not a
 * secure enclave, and a fixture left behind after the run is a credential
 * sitting in app storage for whoever picks the device up next. The values live
 * in this process's memory for the length of the run and nowhere else.
 *
 * ## Nothing here is printed
 *
 * There is no `toString`, no logging, and the failure messages name the KEY
 * that was missing rather than any value. A fixture that could report its own
 * contents on a parse error would defeat the whole arrangement.
 */
internal class LiveFixture private constructor(private val values: Map<String, String>) {

    /**
     * The value for [key], or a failure naming only the key.
     *
     * Deliberately not defaulting: a live leg that silently ran with a blank
     * password would fail somewhere far from the cause, as a login refusal.
     */
    fun require(key: String): String = values[key]
        ?: error("the live fixture has no '$key'; the harness did not provide it")

    fun optional(key: String): String? = values[key]

    /** No values, ever. */
    override fun toString(): String = "LiveFixture(keys=${values.keys.sorted()})"

    companion object {
        /**
         * Where the harness places the fixture.
         *
         * Inside `filesDir`, which is app-private on every supported version:
         * `run-as` reaches it because the debug build is debuggable and the
         * shell user is allowed to act as it, and nothing else on the device
         * can.
         */
        const val FILE_NAME = "live-fixture.properties"

        /**
         * Read and consume the fixture.
         *
         * The format is deliberately the dullest thing that works —
         * `key=value`, one per line, `#` for comments — because the parser runs
         * before anything else and a parser that could throw on the shape of a
         * value would be a place a secret reaches a stack trace. A line with no
         * `=` is skipped rather than reported.
         */
        fun load(): LiveFixture {
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            val file = File(context.filesDir, FILE_NAME)
            if (!file.isFile) {
                error(
                    "no live fixture at filesDir/$FILE_NAME — run this through " +
                        "scripts/android-host-inbox-acceptance.sh, which provisions it",
                )
            }
            val values = LinkedHashMap<String, String>()
            file.forEachLine { line ->
                val trimmed = line.trim()
                if (trimmed.isEmpty() || trimmed.startsWith("#")) return@forEachLine
                val separator = trimmed.indexOf('=')
                if (separator <= 0) return@forEachLine
                values[trimmed.substring(0, separator).trim()] =
                    trimmed.substring(separator + 1).trim()
            }
            // Consumed. A credential that outlived the run would be sitting in
            // app storage for whoever has the device next.
            file.delete()
            if (values.isEmpty()) error("the live fixture was empty after parsing")
            return LiveFixture(values)
        }
    }
}
