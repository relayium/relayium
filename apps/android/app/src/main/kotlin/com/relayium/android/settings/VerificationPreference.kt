package com.relayium.android.settings

import android.content.Context
import androidx.core.content.edit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * "Compare verification codes with the other device" — the Android half of the
 * preference Apple keeps in `VerificationPreference.swift` and the website in
 * `verify-pref.svelte.ts` (A31 a).
 *
 * **Off by default, opt-in, and stored only when on.** An absent key means off,
 * and turning it off REMOVES the key rather than writing `false`, so there is
 * exactly one representation of each state — the same "absent = off" rule the
 * other two clients follow.
 *
 * Why off does not weaken anything: the handshake's commit-reveal, the AEAD on
 * every frame and the relay's ciphertext-only view are identical either way.
 * What this changes is whether a person is asked to compare six digits, out
 * loud, BEFORE any work moves on a new link — which is what detects a
 * substituted signalling endpoint, and only if someone actually compares.
 *
 * The value is read by [com.relayium.android.TransferController] once per link,
 * when the link becomes ready. Changing it while a link is up applies to the
 * next link and neither releases nor re-gates the current one, which is why the
 * toggle is disabled while a session runs.
 */
class VerificationPreference(private val store: Store) {

    /** The persistence seam, so the rule is testable on the JVM. */
    interface Store {
        fun isSet(key: String): Boolean
        fun set(key: String)
        fun remove(key: String)
    }

    private val _enabled = MutableStateFlow(runCatching { store.isSet(KEY) }.getOrDefault(false))
    val enabled: StateFlow<Boolean> = _enabled.asStateFlow()

    /** Read at the moment a link becomes ready. */
    fun current(): Boolean = _enabled.value

    fun setEnabled(on: Boolean) {
        // Published only after the write held: a toggle that says "on" over a
        // store that refused it would be a promise the next launch breaks.
        val written = runCatching { if (on) store.set(KEY) else store.remove(KEY) }.isSuccess
        if (written) _enabled.value = on
    }

    companion object {
        const val FILE = "relayium.verify"
        const val KEY = "verify_peers"

        fun sharedPreferences(context: Context): VerificationPreference {
            val prefs = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)
            return VerificationPreference(
                object : Store {
                    override fun isSet(key: String): Boolean = prefs.getBoolean(key, false)
                    // `commit`, not `apply`: the toggle publishes only a
                    // write that held, and the read-back is that proof.
                    override fun set(key: String) {
                        prefs.edit(commit = true) { putBoolean(key, true) }
                        check(prefs.getBoolean(key, false))
                    }
                    override fun remove(key: String) {
                        prefs.edit(commit = true) { remove(key) }
                        check(!prefs.contains(key))
                    }
                },
            )
        }
    }
}
