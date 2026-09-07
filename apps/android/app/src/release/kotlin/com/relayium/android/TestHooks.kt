package com.relayium.android

/**
 * RELEASE VARIANT: a no-op. The debug source set's version of this object is
 * what the instrumentation acceptance observes; this one stores NOTHING, so a
 * release APK contains no reference to the ViewModel and no observation or
 * control surface — the hook is compiled out, not merely disabled.
 */
object TestHooks {
    @Suppress("UNUSED_PARAMETER")
    fun register(viewModel: TransferViewModel) = Unit
}
