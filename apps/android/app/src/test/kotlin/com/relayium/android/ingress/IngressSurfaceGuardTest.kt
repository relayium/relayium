package com.relayium.android.ingress

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The absences this module is made of, asserted against its own source.
 *
 * Some properties have no runtime to observe. "This code cannot start a
 * transfer" is not a behaviour that can be measured by calling something; it is
 * true because nothing here can reach the code that would. A test that called a
 * method and watched nothing happen would prove only that today's call did
 * nothing, and would keep passing on the day somebody adds the call that
 * matters.
 *
 * So this reads the module's own files, the way `IOSSurfaceGuardTests` reads
 * the share extension's directory for the same kind of absence. It is a
 * tripwire on the next edit, not a proof about this one.
 */
class IngressSurfaceGuardTest {

    /** The Android-facing adapter. Everything else must be pure. */
    private val adapter = "IngressIntents.kt"

    private val sources: Map<String, String> by lazy {
        val directory = locate()
        val files = directory.listFiles { file: File -> file.name.endsWith(".kt") }.orEmpty()
        assertTrue("no ingress sources found in $directory", files.isNotEmpty())
        files.associate { it.name to it.readText() }
    }

    /**
     * The module's source directory.
     *
     * Gradle runs host tests with the module as the working directory, but a
     * guard that quietly passed when it could not find its files would be worse
     * than no guard, so the walk up is explicit and a miss is a failure.
     */
    private fun locate(): File = locate("src/main/kotlin/com/relayium/android/ingress")

    private fun locate(relative: String): File {
        var here: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (here != null) {
            val candidate = File(here, relative)
            if (candidate.isDirectory) return candidate
            val nested = File(here, "app/$relative")
            if (nested.isDirectory) return nested
            here = here.parentFile
        }
        throw AssertionError("$relative not found from ${System.getProperty("user.dir")}")
    }

    /** The scanner's sources, held to the same absences. */
    private val scanSources: Map<String, String> by lazy {
        val directory = locate("src/main/kotlin/com/relayium/android/scan")
        val files = directory.listFiles { file: File -> file.name.endsWith(".kt") }.orEmpty()
        assertTrue("no scan sources found in $directory", files.isNotEmpty())
        files.associate { it.name to it.readText() }
    }

    /** Source with comments removed: a rule must not trip on its own rationale. */
    private fun code(text: String): String =
        text.replace(Regex("""/\*[\s\S]*?\*/"""), "").replace(Regex("""(?m)//.*$"""), "")

    private fun forbid(vararg symbols: String) {
        for ((name, text) in sources) {
            val body = code(text)
            for (symbol in symbols) {
                assertFalse("$name mentions $symbol", body.contains(symbol))
            }
        }
    }

    @Test
    fun `nothing here can start, join or cancel a transfer`() {
        // The regression this module exists to close is an entry point that
        // called join() on any incoming link. It cannot be reintroduced by
        // accident if the types that could do it are not reachable from here.
        forbid(
            "TransferController",
            "TransferViewModel",
            "CloudUploadModel",
            "CloudDownloadModel",
            "CloudClient",
            "controller.",
            "viewModel.",
        )
    }

    @Test
    fun `nothing here opens a network connection`() {
        // `HttpUrl` is a URL PARSER and is deliberately allowed; a client, a
        // request or a call is not.
        forbid("OkHttpClient", "newCall", "URLConnection", "openConnection", "Socket(")
    }

    @Test
    fun `nothing here writes to instance state or to disk`() {
        // A pairing code, a `#k=` fragment and a shared plaintext path must not
        // reach a Bundle the system may persist and restore into a later
        // process. `CloudLinkDraft` states the same rule for the same reason.
        forbid(
            "Bundle",
            "SavedStateHandle",
            "rememberSaveable",
            "SharedPreferences",
            "getFilesDir",
            "getExternalStorage",
            "FileOutputStream",
        )
        // Not "Parcelable": READING a parcelled extra is the adapter's whole
        // job and the only way an intent's URIs can be reached at all. What
        // must not exist is this module making something parcelable or
        // serialisable of its own — that is how a URI, and the grant it stands
        // for, ends up written somewhere it outlives.
        forbid(": Parcelable", "writeToParcel", "Parcelize", "Serializable")
    }

    @Test
    fun `nothing here takes a lasting claim on somebody else's document`() {
        // A persistable grant is an ongoing claim, offered only under an
        // explicit platform contract that a share intent is not.
        forbid("takePersistableUriPermission", "releasePersistableUriPermission")
    }

    @Test
    fun `nothing here logs`() {
        // Everything this module handles is a code, a key, a document path or a
        // user's message.
        forbid("android.util.Log", "Log.d(", "Log.i(", "Log.w(", "Log.e(", "println(")
    }

    @Test
    fun `only the adapter touches the framework`() {
        // This is what keeps every rule in this module testable on a host JVM,
        // which is where a hostile-input case is cheap enough to actually be
        // written.
        for ((name, text) in sources) {
            if (name == adapter) continue
            val android = Regex("""(?m)^import android[x]?\.""").find(code(text))
            assertFalse("$name imports ${android?.value?.trim()}", android != null)
        }
        assertTrue("$adapter is missing", sources.containsKey(adapter))
    }

    @Test
    fun `only the adapter can open content`() {
        for ((name, text) in sources) {
            if (name == adapter) continue
            assertFalse("$name opens content itself", code(text).contains("openInputStream"))
        }
    }

    @Test
    fun `the scanner cannot join, log, or remember what it saw`() {
        // The same absences, for the module that holds a camera. A scanner is
        // the surface where "just log the payload while debugging" is most
        // tempting, and the payload is the pairing code.
        for ((name, text) in scanSources) {
            val body = code(text)
            for (symbol in listOf(
                "TransferController", "TransferViewModel", "controller.join",
                "android.util.Log", "Log.d(", "Log.e(", "println(",
                "Bundle", "SavedStateHandle",
                "FileOutputStream", "getFilesDir",
                "OkHttpClient", "newCall",
            )) {
                assertFalse("$name mentions $symbol", body.contains(symbol))
            }
            // `rememberSaveable` is allowed in exactly one file and for exactly
            // one value: the permission-request counter in `ScannerSheet`,
            // which has to survive the recreation that happens while the system
            // dialog is in front. The exemption is named rather than implied,
            // so a second use has to be argued for here before it compiles
            // through. Nothing that could carry a code, a key, a payload or a
            // path may be saved.
            if (name != "ScannerSheet.kt") {
                assertFalse("$name saves UI state", body.contains("rememberSaveable"))
            }
        }
    }

    @Test
    fun `the scanner's decision layer needs no framework to be tested`() {
        // The files a hostile payload reaches first — the packer, the codec,
        // the run fence, the state machine — stay host-testable. The camera
        // adapter and the two composables are where the framework lives.
        val android = setOf("QrAnalyzer.kt", "ScannerController.kt", "ScannerSheet.kt", "PairingQrCard.kt")
        for ((name, text) in scanSources) {
            if (name in android) continue
            val found = Regex("""(?m)^import android[x]?\.""").find(code(text))
            assertFalse("$name imports ${found?.value?.trim()}", found != null)
        }
        assertTrue("the pure files are missing", scanSources.keys.containsAll(
            setOf("LuminanceFrame.kt", "QrCodec.kt", "ScanSession.kt", "ScannerState.kt", "PairingQr.kt"),
        ))
    }

    @Test
    fun `every refusal reason is a closed set this module wrote`() {
        // A reason that carried input would be an adversary's text on its way
        // to a toast and a log.
        val refusals = sources.getValue("IngressRequest.kt")
        assertTrue("IngressRefusal must be an enum", refusals.contains("enum class IngressRefusal"))
    }
}
