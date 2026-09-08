package com.relayium.android.cloud

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The link the user is part-way through pasting.
 *
 * ## Why this is not `rememberSaveable`
 *
 * A stored link CONTAINS THE KEY, in its `#k=` fragment. `rememberSaveable`
 * writes into the Activity's saved-instance `Bundle`, which the system may
 * persist to disk and restore into a later process — so remembering the field
 * that way would put a decryption key into saved UI state, which is exactly what
 * this product promises not to do. The invariant is not "do not log the key", it
 * is that the key lives in memory and in the link the user chooses to share, and
 * nowhere else.
 *
 * Owning the text in the ViewModel gives the same user-visible behaviour that
 * matters — it survives an Activity recreation and a tab change — without a
 * `Bundle`, a `SavedStateHandle`, or any other durable copy. It dies with the
 * process, as a key should.
 */
class CloudLinkDraft {

    private val _text = MutableStateFlow("")
    val text: StateFlow<String> = _text.asStateFlow()

    fun set(value: String) {
        _text.value = value
    }

    /** Cleared when the transfer it named is finished with. */
    fun clear() {
        _text.value = ""
    }
}
