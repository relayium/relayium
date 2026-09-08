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

    /**
     * A constant `null`, with NO mutable field behind it.
     *
     * The member itself exists in both variants — it has to, because
     * `TransferViewModel.openInBrowser` calls it unconditionally. What differs
     * is that the debug variant reads a settable field, so the acceptance can
     * install a stand-in launcher and observe the download URL without
     * navigating, whereas this one can only ever answer `null`. There is
     * nothing to assign, so a release build has exactly one launch path — the
     * real `startActivity` — and no in-process surface can redirect where an
     * update link sends the user.
     */
    fun updateLauncher(): ((String) -> Boolean)? = null

    /**
     * A constant zero, with NO mutable field behind it.
     *
     * The debug variant reads a settable offset so the acceptance can place the
     * picker lease's expiry precisely rather than waiting out two minutes per
     * case. A release build has exactly one clock: nothing in the process can
     * shift the deadline that ends a presence claim.
     */
    fun clockOffsetMillis(): Long = 0L
}
