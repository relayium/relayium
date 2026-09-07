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
}
