package com.relayium.android.inbox

import com.relayium.protocol.inbox.InboxAutoAccept
import com.relayium.protocol.inbox.InboxCapability
import com.relayium.protocol.inbox.InboxKeyMaterial
import com.relayium.protocol.inbox.InboxPresence

/**
 * "May I send to this device, and what must I say about it?"
 *
 * Pure by construction — no network, no storage, no clock — so every branch is
 * assertable without any of them. It is the Android half of the same decision
 * `InboxSendTarget.swift` and `web/src/lib/device-inbox.ts` make, in the same
 * order and with the same verdicts: two surfaces that disagreed would let a user
 * watch a file upload from the browser and be refused from the phone.
 *
 * Two rules shape the whole file:
 *
 *  1. **Presence is advisory, capability is not.** An offline but properly
 *     enrolled device is a legitimate target — the task queues and lands when it
 *     comes back — so collapsing the two would make "offline" mean "rejected"
 *     and delete the reason the queue exists.
 *  2. **A refusal keeps its name.** Each block below has a different remedy, so
 *     none is flattened into an empty list or a generic failure on the way to
 *     the UI.
 */

/** Why a device cannot be sent to. Closed, one case per distinct remedy. */
enum class InboxTargetBlock {
    /** The device id could not safely become a request path component. */
    UNUSABLE_IDENTIFIER,

    /** No Device Inbox at all: a browser, or a build predating the feature. */
    NOT_ENROLLED,

    /** Enrolment revoked. Only a person at another device can clear it. */
    REVOKED,

    /** Central's own verdict is no — possibly for a reason this build cannot
     *  see, which is exactly why its answer beats a local guess. */
    CANNOT_RECEIVE,

    /** The negotiated receive capability is not one this build can drive. */
    UNSUPPORTED_CAPABILITY,

    /** Missing, superseded, revoked, wrongly-encoded, wrong-algorithm or
     *  low-order key material. One case, because the remedy is the same: that
     *  device has to publish a current key this protocol can wrap to. */
    UNSUPPORTED_KEY,

    /** The device owner turned automatic receiving off. */
    RECEIVE_OFF,
}

/**
 * Truthful qualifications on a send that IS allowed.
 *
 * Never suppressed: a target that is sendable but will not land unattended has
 * to say so BEFORE the file is encrypted and uploaded, not after.
 */
enum class InboxTargetCaveat {
    /** Policy `ask`: a person at that machine has to accept. */
    NEEDS_APPROVAL,

    /** Policy `auto`, but its receive directory was last reported unusable — so
     *  central will start the task at `attention_required` anyway. */
    DIRECTORY_NOT_READY,

    /** Offline but cryptographically able. The task waits. */
    QUEUED_UNTIL_ONLINE,
}

/** The verdict on one device row. */
data class InboxTargetAvailability(
    val sendable: Boolean,
    /** Set exactly when [sendable] is false. */
    val block: InboxTargetBlock?,
    /** Ordered, most consequential first. Possibly empty. */
    val caveats: List<InboxTargetCaveat>,
    val online: Boolean,
    /** The device owner's policy, null when this row has no Device Inbox. Never
     *  an "unknown" member: a policy this build does not know already failed the
     *  strict decode, so such a row never reached here. */
    val policy: InboxAutoAccept?,
    /** This is the device doing the sending. Reported rather than blocked: a
     *  send to yourself is not wrong, it is simply not what the picker offers. */
    val isCurrentDevice: Boolean,
)

/**
 * A device that may be sealed to, with the key material a seal actually needs.
 *
 * Only ever produced from a row that passed every check, so a value of this type
 * is the proof rather than the intention: there is no constructor that takes an
 * unvalidated row.
 */
class InboxSendTarget internal constructor(
    val deviceId: String,
    val name: String,
    val kind: String,
    val keyId: String,
    val keyGeneration: Long,
    val algorithm: String,
    /** Canonical base64url, already validated through `validatePublicKey`. */
    val publicKey: String,
    val availability: InboxTargetAvailability,
) {
    override fun toString(): String = "InboxSendTarget(device=$deviceId, key=$keyId)"
}

object InboxTargetEligibility {

    /**
     * Decide one row, in the order a user would have to act in.
     *
     * The order is the design: checks run from "this is not a Device Inbox at
     * all" outwards to "it is, and its owner turned receiving off", so the block
     * that survives names the FIRST thing that would have to change.
     */
    fun availability(row: InboxDeviceRow): InboxTargetAvailability {
        val inbox = row.inbox
        val online = inbox?.presence == InboxPresence.ONLINE
        val policy = inbox?.autoAccept

        fun no(block: InboxTargetBlock) = InboxTargetAvailability(
            sendable = false, block = block, caveats = emptyList(),
            online = online, policy = policy, isCurrentDevice = row.isCurrent,
        )

        if (!InboxId.isValid(row.id)) return no(InboxTargetBlock.UNUSABLE_IDENTIFIER)
        // `registeredAt == 0` is central's own "this subtree describes nothing":
        // a row can carry a zeroed Inbox for a device that never enrolled.
        if (inbox == null || inbox.registeredAt == 0L) return no(InboxTargetBlock.NOT_ENROLLED)
        if (inbox.revoked) return no(InboxTargetBlock.REVOKED)
        // Before any key inspection, deliberately. Central can refuse for a
        // reason not visible in these fields, and its verdict beats a local
        // guess.
        if (!inbox.canReceive) return no(InboxTargetBlock.CANNOT_RECEIVE)
        // v3 only. A device enrolled under an older receive capability cannot
        // decode a v3 manifest, so it is refused here rather than discovered
        // after the file is already encrypted and uploaded.
        if (inbox.receiveCapability != InboxCapability.REQUIRED_RECEIVE) {
            return no(InboxTargetBlock.UNSUPPORTED_CAPABILITY)
        }
        val key = inbox.key
        if (key == null || !key.isActive || !InboxId.isValid(key.id) || key.generation <= 0 ||
            // The same rules central's own ValidatePublicKey applies, including
            // the low-order refusal — the check that stops a content key being
            // "sealed" to a point whose exchange yields the all-zero secret.
            runCatching { InboxKeyMaterial.validatePublicKey(key.algorithm, key.publicKey) }
                .isFailure
        ) {
            return no(InboxTargetBlock.UNSUPPORTED_KEY)
        }
        // Refused here rather than after a whole encrypted upload: central
        // answers `auto_receive_disabled` and stores nothing at all.
        if (policy == null || policy == InboxAutoAccept.OFF) {
            return no(InboxTargetBlock.RECEIVE_OFF)
        }

        val caveats = ArrayList<InboxTargetCaveat>(2)
        when (policy) {
            InboxAutoAccept.ASK -> caveats.add(InboxTargetCaveat.NEEDS_APPROVAL)
            InboxAutoAccept.AUTO ->
                if (!inbox.receiveDirReady) caveats.add(InboxTargetCaveat.DIRECTORY_NOT_READY)
            InboxAutoAccept.OFF -> Unit // unreachable: refused above
        }
        if (!online) caveats.add(InboxTargetCaveat.QUEUED_UNTIL_ONLINE)

        return InboxTargetAvailability(
            sendable = true, block = null, caveats = caveats,
            online = online, policy = policy, isCurrentDevice = row.isCurrent,
        )
    }

    /**
     * Would offering a TEXT send to this device be honest?
     *
     * Deliberately not folded into [availability], and the separation matters in
     * both directions: a receiver without `inbox.text.v1` is a perfectly good
     * FILE target, so requiring the token generally would refuse ordinary file
     * deliveries to every build that does not render messages; but a receiver
     * without it has not promised a user-visible message surface, so offering
     * "send text" would promise something the recipient cannot read.
     *
     * Central neither requires nor interprets the token and could not verify it
     * if it wanted to — content kind is sealed — so its absence is read as the
     * truthful answer rather than as a stale list.
     *
     * The receive DIRECTORY is deliberately not consulted: a message is never
     * written there, so a directory problem has nothing to do with whether one
     * can land.
     */
    fun canReceiveText(row: InboxDeviceRow): Boolean =
        availability(row).sendable &&
            row.inbox?.capabilities?.contains(InboxCapability.TEXT_V1) == true

    /** The seal target for a TEXT delivery, or null when this device may not be
     *  sent one. Every file-send rule, plus `inbox.text.v1`. */
    fun textTarget(row: InboxDeviceRow): InboxSendTarget? =
        if (canReceiveText(row)) target(row) else null

    /** The seal target for a row, or null when it may not be sent to. */
    fun target(row: InboxDeviceRow): InboxSendTarget? {
        val availability = availability(row)
        val key = row.inbox?.key
        if (!availability.sendable || key == null) return null
        return InboxSendTarget(
            deviceId = row.id, name = row.name, kind = row.kind,
            keyId = key.id, keyGeneration = key.generation,
            algorithm = key.algorithm, publicKey = key.publicKey,
            availability = availability,
        )
    }

    /**
     * Every device on the account that may be sent to, in central's own order.
     *
     * The current device is excluded by default — a product decision, not a
     * safety one, so it is a parameter and `isCurrentDevice` stays readable on
     * the availability for a caller that wants to ask.
     */
    fun targets(
        rows: List<InboxDeviceRow>,
        includingCurrentDevice: Boolean = false,
    ): List<InboxSendTarget> =
        rows.filter { includingCurrentDevice || !it.isCurrent }.mapNotNull(::target)
}
