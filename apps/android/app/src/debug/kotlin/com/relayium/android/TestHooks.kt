package com.relayium.android

/**
 * DEBUG VARIANT. The instrumentation acceptance's window onto the REAL app:
 * it observes the actual [TransferViewModel] the running MainActivity created
 * — the same controller, storage and transport the user's taps drive — so the
 * interop run asserts production behaviour rather than a parallel object.
 *
 * This is not an exported surface: nothing outside the process can reach it
 * (instrumentation shares the app's uid and process), and the RELEASE variant
 * of this file stores nothing at all, so a release APK carries no observation
 * or control path.
 */
object TestHooks {
    @Volatile
    var viewModel: TransferViewModel? = null

    fun register(viewModel: TransferViewModel) {
        this.viewModel = viewModel
    }

    /**
     * DEBUG ONLY. A stand-in for "open this in the browser".
     *
     * The update acceptance needs to see the exact URL the product would hand
     * to the system, and it needs to exercise the no-browser fallback — both
     * WITHOUT actually navigating out of the app under test or installing
     * anything. Installing one of these answers both: the URL is recorded, and
     * the returned boolean is what the product treats as "a browser took it".
     *
     * The RELEASE variant declares the same [updateLauncher] method — it has
     * to, because `TransferViewModel.openInBrowser` calls it unconditionally —
     * but there it returns a constant `null` with no field behind it to set. So
     * a release build always falls through to the real launch, and no
     * in-process surface can redirect where an update link sends the user.
     * `scripts/test/android-policy-test.mjs` asserts that asymmetry.
     */
    @Volatile
    var installedLauncher: ((String) -> Boolean)? = null

    /** The last URL the product asked to open, for the acceptance to assert. */
    @Volatile
    var lastUpdateDownloadUrl: String? = null

    /**
     * DEBUG ONLY. An offset added to the monotonic clock the picker lease reads.
     *
     * The lease is two minutes long by design, and the behaviour worth asserting
     * is what happens WHEN IT RUNS OUT: the presence claim withdrawn, the exact
     * pending operation retired, a late result refused. A test that waited out
     * the real interval would spend two minutes per case and still not be able
     * to place the expiry precisely between a launch and a callback.
     *
     * So the acceptance moves the clock instead. It is the same code path with
     * the same deadline arithmetic — only `now` is shifted — so what is proven
     * is the product's own rule rather than a shortened copy of it.
     *
     * The RELEASE variant declares the same method returning a constant `0`,
     * with no field behind it, so a shipped build has exactly one clock and no
     * in-process surface can move it. `scripts/test/android-policy-test.mjs`
     * asserts that asymmetry for the update launcher; the same shape is used
     * here deliberately.
     */
    @Volatile
    var pickerClockOffsetMillis: Long = 0L

    fun clockOffsetMillis(): Long = pickerClockOffsetMillis

    fun updateLauncher(): ((String) -> Boolean)? {
        val installed = installedLauncher ?: return null
        return { url ->
            lastUpdateDownloadUrl = url
            installed(url)
        }
    }
}
