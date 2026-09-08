package com.relayium.android.inbox

import com.relayium.protocol.inbox.InboxAutoAccept
import com.relayium.protocol.inbox.InboxCapability
import com.relayium.protocol.inbox.InboxKeyMaterial
import com.relayium.protocol.inbox.InboxProtocol
import com.relayium.protocol.inbox.InboxRejection

/**
 * Getting from "this device has credentials" to "this device holds the private
 * half of the key senders are wrapping to".
 *
 * This is the part of Device Inbox where a mistake is unrecoverable rather than
 * annoying. Central publishes a public key and senders seal content keys to it;
 * if the matching private key is not in this account's history, those tasks
 * cannot be opened by anybody, ever. Three rules follow:
 *
 *  * **PERSIST BEFORE PUBLISH.** A key is durable locally before it is
 *    registered ([InboxKeyStore.append]).
 *  * **RECONCILE, DO NOT REGENERATE.** A lost registration response is repaired
 *    by asking central which id it gave the key we already hold — never by
 *    minting a second key, which would abandon the first.
 *  * **NEVER ROTATE SILENTLY.** When central's active key is one this device
 *    cannot open, rotating would be a decision with a cost: every task already
 *    queued to the old key stays sealed to it and becomes permanently
 *    undecryptable. That is reported as [InboxKeyHealth.NeedsRepair] and left to
 *    a person, rather than performed automatically.
 *
 * The third rule is where this deliberately differs from the shipped macOS/iOS
 * path, which rotates on its own. The queue is the reason: on this platform the
 * repair is offered with its consequence stated, so a user whose sender is
 * mid-delivery can choose when to pay it.
 */

/** What this build may honestly announce. */
object InboxCapabilities {

    /**
     * The set every build of this app can keep: it claims v3 receive, the
     * default-off automatic policy, and frame-boundary resume.
     *
     * `inbox.resume.v1` is included because the receiver genuinely resumes an
     * interrupted download from the last COMPLETE authenticated frame rather
     * than restarting it. It says nothing about surviving process death, and
     * nothing in the token claims that.
     */
    val BASE: List<String> = listOf(
        InboxCapability.RECEIVE_V3,
        InboxCapability.AUTO_ACCEPT_V1,
        InboxCapability.RESUME_V1,
    )

    /**
     * What to announce given whether this build's own surface renders a received
     * message AS a message.
     *
     * Answered by the composing layer, never inferred from the platform: the
     * token is a promise about a SCREEN, and a build that stored messages and
     * showed them nowhere would be making it falsely. Its absence is meaningful
     * and truthful — a sender reads it to decide whether offering "send text"
     * to this device would be honest.
     */
    fun announced(presentingText: Boolean): List<String> =
        if (presentingText) BASE + InboxCapability.TEXT_V1 else BASE
}

/**
 * Whether this device can actually open what senders are sealing to it.
 *
 * Two states, and the second is deliberately not an error: it is a condition a
 * person can resolve, and the UI has to be able to say what it will cost.
 */
sealed interface InboxKeyHealth {

    /** Central's active key is one this device holds the private half of. */
    data class Healthy(val key: InboxKeyRow) : InboxKeyHealth

    /**
     * Central publishes a key this device cannot open, and no local record
     * matches it.
     *
     * Reached by a restored device, a cleared keystore, a re-login that minted a
     * different installation, or an unreadable local history. The remedy is
     * [InboxEnrolment.repairByRotating], and it is NOT free: anything already
     * queued to [remoteKeyId] stays sealed to it and will fail to decrypt here.
     */
    data class NeedsRepair(
        val reason: Reason,
        val remoteKeyId: String,
        val remoteGeneration: Long,
    ) : InboxKeyHealth {

        enum class Reason {
            /** Central's active key has no matching private half on this device. */
            REMOTE_KEY_NOT_HELD,

            /**
             * The local history exists but cannot be read.
             *
             * Kept distinct from [REMOTE_KEY_NOT_HELD] because the honest
             * message differs: the keys may still be there behind a keystore
             * that was invalidated, and telling the user "this device has never
             * had a key" would be false. Its repair is
             * [InboxEnrolment.repairUnreadableHistory], which quarantines rather
             * than deletes.
             */
            LOCAL_HISTORY_UNREADABLE,

            /**
             * A local record matches central's active key id, but not the key
             * itself — a different public key, algorithm or generation.
             *
             * Treated as not-held rather than reconciled: the two sides disagree
             * about what the id MEANS, and binding or using either answer would
             * be a guess about which deliveries this device can open.
             */
            LOCAL_BINDING_DISAGREES,

            /**
             * Central reports more than one active key for this device.
             *
             * There is no first-row rule here: choosing one would mean sealing
             * and unsealing under an identity this build picked rather than one
             * the protocol named.
             */
            REMOTE_KEY_AMBIGUOUS,
        }
    }

    /**
     * The repair cannot be performed on this device right now, and pretending
     * otherwise would destroy the only copy of the private keys.
     *
     * Reported instead of attempting a repair whose destructive half would
     * succeed and whose constructive half would not.
     */
    data class RepairUnavailable(val reason: Reason) : InboxKeyHealth {

        enum class Reason {
            /**
             * Secure storage cannot seal a new history and read it back — a
             * keystore key that is invalidated rather than merely absent.
             *
             * Moving the old history aside would not help: the replacement
             * cannot be written either, so the device would still be unable to
             * receive AND would have lost the records a restored keystore could
             * have opened. The remedy is outside this feature.
             */
            SECURE_STORAGE_UNAVAILABLE,
        }
    }
}

/** Central selected something this build cannot honour, or answered about a
 *  different key than was sent. Each names the exact field, because each has a
 *  different remedy. */
class InboxEnrolmentException(val field: Field) :
    RuntimeException("relayium inbox enrolment: unsupported $field") {

    enum class Field { PROTOCOL_VERSION, RECEIVE_CAPABILITY, KEY_ALGORITHM }
}

object InboxEnrolment {

    /**
     * Announce this build, then fail closed on what central selected.
     *
     * A refusal from enrolment is "upgrade or stop", never "retry with a
     * default". The three checks are separate on purpose: each names the exact
     * field central chose that this build cannot honour, which is the difference
     * between an actionable message and "the server said no".
     */
    suspend fun enrol(
        transport: InboxDeviceTransport,
        platform: String,
        appVersion: String,
        capabilities: List<String>,
        autoAccept: InboxAutoAccept,
        receiveDirReady: Boolean,
    ): InboxEnrolResult {
        val result = transport.enrol(
            InboxEnrolRequest(
                platform = platform, appVersion = appVersion,
                autoAccept = autoAccept, receiveDirReady = receiveDirReady,
                capabilities = capabilities,
            ),
        )
        if (!InboxProtocol.isSupportedVersion(result.protocolVersion)) {
            throw InboxEnrolmentException(InboxEnrolmentException.Field.PROTOCOL_VERSION)
        }
        // Checked against what was ANNOUNCED, not against the library's base
        // set: central selects from the list this device sent, so the announced
        // set is the only one whose contents this build has promised to honour.
        if (!capabilities.contains(result.receiveCapability)) {
            throw InboxEnrolmentException(InboxEnrolmentException.Field.RECEIVE_CAPABILITY)
        }
        if (result.keyAlgorithm != InboxProtocol.KEY_ALGORITHM) {
            throw InboxEnrolmentException(InboxEnrolmentException.Field.KEY_ALGORITHM)
        }
        return result
    }

    /**
     * Make central's ACTIVE key one this account holds the private half of, or
     * report honestly that it cannot be done without a decision.
     *
     * [current] is the active key from the enrolment response, null when there
     * is none. The cases, in the order they are tried:
     *
     *  1. central's active key is in this account's history — nothing to do;
     *  2. it matches a local key whose server id was never recorded (the
     *     registration response was lost). Bind the id; no new key;
     *  3. central has no active key — publish the local one, or mint one if this
     *     account has never had a key here;
     *  4. central's active key is genuinely not ours — [InboxKeyHealth.NeedsRepair].
     *     No rotation happens here. See the file comment.
     */
    suspend fun ensureUsableKey(
        transport: InboxDeviceTransport,
        keys: InboxKeyStoring,
        account: InboxAccountId,
        current: InboxKeyRow?,
        nowSeconds: Long,
    ): InboxKeyHealth {
        if (current != null && current.isActive) {
            return try {
                resolve(keys, account, current)
            } catch (e: InboxKeyStoreException) {
                unreadable(e, current)
            }
        }
        return publishLocalOrNew(transport, keys, account, nowSeconds)
    }

    /**
     * Decide whether this device can open what central is publishing.
     *
     * Matching the ID is not enough, and that is the sharp part. A record filed
     * under central's id whose PUBLIC key, algorithm or generation differs is
     * two sides disagreeing about what the id means — and using it would seal
     * this device's fate to a guess: either it cannot decrypt what arrives, or
     * it advertises custody it does not have.
     */
    private suspend fun resolve(
        keys: InboxKeyStoring,
        account: InboxAccountId,
        active: InboxKeyRow,
    ): InboxKeyHealth {
        if (active.algorithm != InboxProtocol.KEY_ALGORITHM) {
            return InboxKeyHealth.NeedsRepair(
                InboxKeyHealth.NeedsRepair.Reason.LOCAL_BINDING_DISAGREES,
                active.id, active.generation,
            )
        }
        val bound = keys.recordForKeyId(active.id, account)
        if (bound != null) {
            val agrees = bound.publicKey == active.publicKey &&
                bound.algorithm == active.algorithm &&
                bound.generation == active.generation
            if (!agrees) {
                return InboxKeyHealth.NeedsRepair(
                    InboxKeyHealth.NeedsRepair.Reason.LOCAL_BINDING_DISAGREES,
                    active.id, active.generation,
                )
            }
            // The binding agrees; the private half must also actually be there.
            val held = keys.keyPair(active.id, account)
                ?: return InboxKeyHealth.NeedsRepair(
                    InboxKeyHealth.NeedsRepair.Reason.REMOTE_KEY_NOT_HELD,
                    active.id, active.generation,
                )
            held.destroy()
            return InboxKeyHealth.Healthy(active)
        }
        // No binding under that id. The private half may still be here under a
        // record whose registration response was lost — the one case where
        // recording central's id is a repair rather than a guess.
        val record = keys.record(active.publicKey, account)
        if (record != null && !record.isPublished) {
            keys.bind(record.publicKey, active.id, active.generation, account)
            return InboxKeyHealth.Healthy(active)
        }
        return InboxKeyHealth.NeedsRepair(
            InboxKeyHealth.NeedsRepair.Reason.REMOTE_KEY_NOT_HELD,
            active.id, active.generation,
        )
    }

    /**
     * What central's key history says is active.
     *
     * THREE answers, not two. "No active key" and "more than one active key" are
     * different facts with opposite consequences — the first licenses publishing
     * a new key, the second must stop everything — and a nullable result that
     * collapsed them would let an ambiguous history be acted on as if it were an
     * empty one. That is precisely the mistake that would quarantine a local
     * history and register a key while central holds two.
     */
    private sealed interface RemoteActive {
        data class One(val key: InboxKeyRow) : RemoteActive
        data object None : RemoteActive
        data object Ambiguous : RemoteActive
    }

    private fun activeKey(history: List<InboxKeyRow>): RemoteActive {
        val active = history.filter { it.isActive }
        return when (active.size) {
            0 -> RemoteActive.None
            1 -> RemoteActive.One(active.single())
            else -> RemoteActive.Ambiguous
        }
    }

    /** Central's active key, read fresh, or the reason there is not exactly one. */
    private suspend fun readActive(transport: InboxDeviceTransport): RemoteActive = try {
        activeKey(transport.listKeys())
    } catch (e: InboxApiException) {
        // No enrolment at all is "none"; anything else is not this call's to
        // interpret.
        if (e.status == 404) RemoteActive.None else throw e
    }

    /**
     * Start a fresh history after the old one became unreadable, WITHOUT
     * deleting it.
     *
     * Called only when a person has chosen this repair, having been told what it
     * costs: anything already queued to a key in the old history stays sealed to
     * it. The old bytes are moved aside rather than removed, because "this build
     * cannot read it" is not evidence that it is worthless — a keystore entry
     * can come back, and those bytes are the only copy of the private halves.
     *
     * Without this, the repair path would be a loop: [InboxKeyStoring.append]
     * reads before it writes, so an unreadable file fails every attempt forever.
     */
    suspend fun repairUnreadableHistory(
        transport: InboxDeviceTransport,
        keys: InboxKeyStoring,
        account: InboxAccountId,
        nowSeconds: Long,
    ): InboxKeyHealth {
        // Central's history is read and VALIDATED first, before anything
        // irreversible. The compare-and-swap input has to be what central holds
        // now — the enrolment response that produced the health verdict may be
        // old — and an ambiguous history must stop the repair while the local
        // records are still under their live name.
        val remote = readActive(transport)
        if (remote is RemoteActive.Ambiguous) {
            return InboxKeyHealth.NeedsRepair(
                InboxKeyHealth.NeedsRepair.Reason.REMOTE_KEY_AMBIGUOUS, "", 0,
            )
        }
        // Then: can a replacement actually be written? Renaming the old history
        // does nothing for a keystore key that is invalidated rather than
        // absent — the replacement could not be sealed either, so the device
        // would end up unable to receive AND without the records a restored
        // keystore could have opened.
        if (!keys.canStoreNewHistory(account)) {
            return InboxKeyHealth.RepairUnavailable(
                InboxKeyHealth.RepairUnavailable.Reason.SECURE_STORAGE_UNAVAILABLE,
            )
        }
        keys.quarantineUnreadable(account)
        return InboxKeyHealth.Healthy(
            mintAndRegister(
                transport, keys, account,
                (remote as? RemoteActive.One)?.key?.id, nowSeconds,
            ),
        )
    }

    /**
     * The explicit repair: rotate onto a key this device holds.
     *
     * Only called after a person has been told what it costs. The
     * compare-and-swap against [previousKeyId] is what stops two devices, or two
     * passes, racing onto different keys — and a lost CAS is reported rather
     * than retried in a loop, because repeatedly minting keys against a server
     * that keeps disagreeing is how an account ends up with a history nothing
     * can open.
     */
    suspend fun repairByRotating(
        transport: InboxDeviceTransport,
        keys: InboxKeyStoring,
        account: InboxAccountId,
        previousKeyId: String,
        nowSeconds: Long,
    ): InboxKeyHealth = try {
        InboxKeyHealth.Healthy(
            mintAndRegister(transport, keys, account, previousKeyId, nowSeconds),
        )
    } catch (e: InboxApiException) {
        if (e.rejection == InboxRejection.STALE_KEY_ROTATION) {
            // Something rotated between the read and this call. Re-read once and
            // report what is true now; do not mint again.
            reconcile(transport, keys, account)
        } else {
            throw e
        }
    }

    /**
     * Register the newest local key, or mint one first.
     *
     * An unpublished local record is preferred over a fresh key: it may already
     * be registered under an id whose response was lost, and [reconcile] finds
     * that out for certain instead of guessing. This is also why an AMBIGUOUS
     * transport failure here must not be answered with a new key — the record is
     * already durable, so the next pass reuses it.
     */
    private suspend fun publishLocalOrNew(
        transport: InboxDeviceTransport,
        keys: InboxKeyStoring,
        account: InboxAccountId,
        nowSeconds: Long,
    ): InboxKeyHealth {
        val history = try {
            keys.load(account)
        } catch (e: InboxKeyStoreException) {
            return unreadable(e, null)
        }
        // ONLY an unpublished record is a publish candidate. A published one
        // belongs to a binding central already acknowledged — re-registering it
        // is refused as key reuse at best, and at worst would move an id that
        // queued tasks still name. Central having no active key while we hold a
        // published record is a genuinely new remote identity (a cleared
        // enrolment, a re-login that minted a new device row), and the honest
        // answer is a NEW key, with the old record left exactly where it is.
        val candidate = history.lastOrNull { !it.isPublished }
            ?: return InboxKeyHealth.Healthy(
                mintAndRegister(transport, keys, account, null, nowSeconds),
            )
        val record = candidate
        return try {
            val key = transport.registerKey(record.algorithm, record.publicKey, null)
            keys.bind(record.publicKey, key.id, key.generation, account)
            InboxKeyHealth.Healthy(key)
        } catch (e: InboxApiException) {
            // Both of these mean central's history disagrees with ours, and the
            // truth is on central's side. Read it rather than guessing.
            when (e.rejection) {
                InboxRejection.STALE_KEY_ROTATION, InboxRejection.DEVICE_KEY_REUSED ->
                    reconcile(transport, keys, account)
                else -> throw e
            }
        }
    }

    /**
     * Generate a key, make it durable, and only THEN publish it.
     *
     * The ordering is the invariant and the whole reason this is not two lines.
     * If the process dies after the append, an unpublished private key is a
     * recoverable nuisance. If it died after the registration but before the
     * append, central would be handing senders a public key whose private half
     * never existed.
     */
    private suspend fun mintAndRegister(
        transport: InboxDeviceTransport,
        keys: InboxKeyStoring,
        account: InboxAccountId,
        previousKeyId: String?,
        nowSeconds: Long,
    ): InboxKeyRow {
        val keyPair = InboxKeyMaterial.generateKeyPair()
        try {
            val record = keys.append(keyPair, account, nowSeconds)
            val key = transport.registerKey(record.algorithm, record.publicKey, previousKeyId)
            // The transport already refused a reply naming a different public
            // key; binding here records the id central chose for ours.
            keys.bind(record.publicKey, key.id, key.generation, account)
            return key
        } finally {
            keyPair.destroy()
        }
    }

    /**
     * Read central's key history and repair the local record when a response was
     * lost — or report that the active key is genuinely not ours.
     *
     * Bounded: one read, no rotation. Rotating from here would be the silent
     * decision this file refuses to make.
     */
    private suspend fun reconcile(
        transport: InboxDeviceTransport,
        keys: InboxKeyStoring,
        account: InboxAccountId,
    ): InboxKeyHealth {
        val active = when (val remote = activeKey(transport.listKeys())) {
            is RemoteActive.One -> remote.key
            RemoteActive.Ambiguous -> return InboxKeyHealth.NeedsRepair(
                InboxKeyHealth.NeedsRepair.Reason.REMOTE_KEY_AMBIGUOUS, "", 0,
            )
            RemoteActive.None -> return InboxKeyHealth.NeedsRepair(
                InboxKeyHealth.NeedsRepair.Reason.REMOTE_KEY_NOT_HELD, "", 0,
            )
        }
        return try {
            resolve(keys, account, active)
        } catch (e: InboxKeyStoreException) {
            unreadable(e, active)
        }
    }

    /**
     * An unreadable history is reported as its own repair reason, not as "no key
     * here".
     *
     * The distinction is the honest message: the private keys may still exist
     * behind a keystore entry that was invalidated, and a rotation would abandon
     * them along with every task sealed to them. A storage failure that is not
     * about readability is rethrown — it is not a state a person can repair.
     */
    private fun unreadable(e: InboxKeyStoreException, current: InboxKeyRow?): InboxKeyHealth {
        if (e.reason != InboxKeyStoreReason.UNREADABLE_HISTORY) throw e
        return InboxKeyHealth.NeedsRepair(
            InboxKeyHealth.NeedsRepair.Reason.LOCAL_HISTORY_UNREADABLE,
            current?.id.orEmpty(), current?.generation ?: 0,
        )
    }
}
