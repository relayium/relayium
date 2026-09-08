package com.relayium.android.inbox

import com.relayium.protocol.inbox.InboxDeviceErrorCode
import com.relayium.protocol.inbox.InboxTaskState

/**
 * What this device tells central about a delivery it could not complete.
 *
 * Every local error is classified into one of these BEFORE it reaches the
 * reporting path, so the caller never has to interpret a filesystem exception to
 * decide what to say. The state and the code are the closed protocol vocabulary;
 * [reason] is local-only detail for a UI and a test, and never travels.
 */
class InboxFailure private constructor(
    val state: InboxTaskState,
    val code: InboxDeviceErrorCode,
    val reason: Reason,
) : RuntimeException("relayium inbox delivery: $reason") {

    /**
     * Why a delivery stopped, in this build's own terms.
     *
     * Kept apart from [code] because the two answer different questions: the
     * code is what central stores from a closed set, and this is what a person
     * can be told. Neither carries a file name.
     */
    enum class Reason {
        NO_LOCAL_PRIVATE_KEY,
        WRAPPED_KEY_UNREADABLE,
        MANIFEST_UNREADABLE,
        MANIFEST_INVALID,
        MANIFEST_EXCEEDS_CIPHERTEXT,
        UNSAFE_NAME,
        DUPLICATE_DESTINATION,
        NAME_CONFLICT,
        DIRECTORY_UNAVAILABLE,
        NOT_ENOUGH_SPACE,
        RANGE_IGNORED,
        DOWNLOAD_FAILED,
        CIPHERTEXT_INVALID,
        STAGED_SIZE_MISMATCH,
        MESSAGE_MALFORMED,
        JOURNAL_UNREADABLE,
        RECEIVE_ROOT_CHANGED,
        UNEXPECTED,
    }

    companion object {
        /** The same bytes will fail the same way on every attempt. */
        fun terminal(code: InboxDeviceErrorCode, reason: Reason) =
            InboxFailure(InboxTaskState.FAILED_TERMINAL, code, reason)

        /** Worth another attempt under central's own backoff and attempt budget. */
        fun retryable(code: InboxDeviceErrorCode, reason: Reason) =
            InboxFailure(InboxTaskState.FAILED_RETRYABLE, code, reason)

        /** A person has to do something here — free space, resolve a conflict. */
        fun attention(code: InboxDeviceErrorCode, reason: Reason) =
            InboxFailure(InboxTaskState.ATTENTION_REQUIRED, code, reason)
    }
}

/**
 * Central has taken the task away, so this device must report NOTHING.
 *
 * Distinct from a failure on purpose: a report under a lease that has been
 * reassigned would mutate a task another worker now holds, and a report on a
 * terminal task would be an attempt at a transition that can never be legal
 * again. Silence is the only safe answer to both.
 */
class InboxAbandon(val why: Cause) : RuntimeException("relayium inbox abandoned: $why") {

    enum class Cause {
        /** The claim token is no longer the task's current lease. */
        STALE_CLAIM,

        /** The task reached a terminal state elsewhere. */
        TASK_TERMINAL,

        /** The ciphertext object is gone; nothing can complete this delivery. */
        STORED_OBJECT_UNAVAILABLE,

        /** A lease renewal was refused, so this worker is no longer authorised
         *  to assert anything about the task. */
        LEASE_RENEWAL_REFUSED,
    }
}
