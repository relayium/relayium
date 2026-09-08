package com.relayium.android.account

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * What the user has typed on the way into an account, and which half of the
 * form they are on.
 *
 * ## Why this is not composable state
 *
 * The sign-in form is drawn for [AccountState.SignedOut] and
 * [AccountState.Rejected], and NOT for [AccountState.SigningIn] or
 * [AccountState.Registering] — those are a progress indicator. So a submit takes
 * the form out of the composition and a rejection puts a NEW one back, and
 * anything the old one remembered is gone. `rememberSaveable` does not help: it
 * survives recreation, not removal.
 *
 * The observable effect was a user typing an address, mistyping the password,
 * and getting the error beside two empty fields — with the mode reset, so a
 * rejected registration came back as a sign-in form. Owning the draft outside
 * the composition, in the ViewModel, is what makes it survive the round trip
 * (and a rotation, and a tab change) instead.
 *
 * ## What is deliberately NOT here
 *
 * The password. It stays in the composable that collects it and is cleared the
 * moment the request owns it. Keeping it would mean a credential living in the
 * ViewModel for the rest of the process, and re-showing it after a rejection is
 * not worth that; retyping a password after getting it wrong is the expected
 * thing to do. Nothing here reaches saved instance state either — this object is
 * process memory, so it dies with the process, as the message draft does.
 */
class AccountAccessDraft {

    data class Value(
        val email: String = "",
        val displayName: String = "",
        /** True on the create-account half. It is the FORM's state, not the
         *  session's: a rejected registration must come back as a registration,
         *  not silently as a sign-in. */
        val creating: Boolean = false,
    )

    private val _value = MutableStateFlow(Value())
    val value: StateFlow<Value> = _value.asStateFlow()

    fun setEmail(email: String) = _value.update { it.copy(email = email) }

    fun setDisplayName(name: String) = _value.update { it.copy(displayName = name) }

    fun setCreating(creating: Boolean) = _value.update { it.copy(creating = creating) }

    /** Forget everything typed. Used when the account surface reaches a signed-in
     *  account, so the next signed-out screen does not open on the last
     *  session's address. */
    fun clear() { _value.value = Value() }
}
