package com.relayium.android.inbox

import com.relayium.protocol.Json
import com.relayium.protocol.inbox.InboxCapability
import com.relayium.protocol.inbox.InboxKeyMaterial
import com.relayium.protocol.inbox.InboxProtocol

/**
 * Wire documents shaped exactly like the ones `server/account/deviceinbox*.go`
 * writes.
 *
 * Built as JSON TEXT rather than as decoded objects, because the properties
 * under test are about parsing: a fixture assembled from already-typed values
 * could not express a truthy string where a boolean belongs, or a fractional
 * generation, and those are precisely the documents a strict reader has to
 * refuse. Each builder takes an overrides map so one field can be mutated
 * without restating a whole document.
 */
object InboxFixtures {

    /** A real X25519 public key, so the low-order and length checks in
     *  `validatePublicKey` run against something that actually passes them. */
    val publicKey: String = InboxKeyMaterial.encode(
        InboxKeyMaterial.generateKeyPair().publicKey,
    )

    const val DEVICE_ID = "0123456789abcdef0123456789abcdef"
    const val OTHER_DEVICE_ID = "fedcba9876543210fedcba9876543210"
    const val KEY_ID = "aaaabbbbccccddddeeeeffff00001111"
    const val TASK_ID = "11112222333344445555666677778888"
    const val STORED_ID = "99998888777766665555444433332222"

    fun key(vararg overrides: Pair<String, Json?>): Json.Obj = obj(
        mapOf(
            "ID" to Json.of(KEY_ID),
            "Algorithm" to Json.of(InboxProtocol.KEY_ALGORITHM),
            "PublicKey" to Json.of(publicKey),
            "Generation" to Json.of(1L),
            "CreatedAt" to Json.of(1_700_000_000L),
            "SupersededAt" to Json.of(0L),
            "RevokedAt" to Json.of(0L),
        ),
        overrides,
    )

    fun enrolment(vararg overrides: Pair<String, Json?>): Json.Obj = obj(
        mapOf(
            "Presence" to Json.of("online"),
            "LastHeartbeatAt" to Json.of(1_700_000_000L),
            "PresenceExpiresAt" to Json.of(1_700_000_090L),
            "HeartbeatIntervalSeconds" to Json.of(30),
            "ProtocolVersion" to Json.of(3),
            "Capabilities" to Json.arr(
                listOf(
                    Json.of(InboxCapability.RECEIVE_V3),
                    Json.of(InboxCapability.AUTO_ACCEPT_V1),
                    Json.of(InboxCapability.RESUME_V1),
                    Json.of(InboxCapability.TEXT_V1),
                ),
            ),
            "ReceiveCapability" to Json.of(InboxCapability.RECEIVE_V3),
            "AutoAccept" to Json.of("auto"),
            "ReceiveDirReady" to Json.of(true),
            "Revoked" to Json.of(false),
            "CanReceive" to Json.of(true),
            "RegisteredAt" to Json.of(1_699_000_000L),
            "Key" to key(),
        ),
        overrides,
    )

    fun device(vararg overrides: Pair<String, Json?>): Json.Obj = obj(
        mapOf(
            "ID" to Json.of(DEVICE_ID),
            "Name" to Json.of("Pixel"),
            "Kind" to Json.of("android"),
            "Current" to Json.of(true),
            "Inbox" to enrolment(),
        ),
        overrides,
    )

    fun task(vararg overrides: Pair<String, Json?>): Json.Obj = obj(
        mapOf(
            "ID" to Json.of(TASK_ID),
            "TargetDeviceID" to Json.of(DEVICE_ID),
            "SourceDeviceID" to Json.of(OTHER_DEVICE_ID),
            "IdempotencyKey" to Json.of("idem-1"),
            "StoredFileID" to Json.of(STORED_ID),
            "State" to Json.of("queued"),
            "ErrorCode" to Json.of(""),
            "CiphertextBytes" to Json.of(4096L),
            "WrapAlgorithm" to Json.of(InboxProtocol.KEY_ALGORITHM),
            "TargetKeyID" to Json.of(KEY_ID),
            "TargetKeyGeneration" to Json.of(1L),
            "Attempts" to Json.of(0L),
            "NextAttemptAt" to Json.of(0L),
            "LeaseExpiresAt" to Json.of(0L),
            "CreatedAt" to Json.of(1_700_000_000L),
            "UpdatedAt" to Json.of(1_700_000_000L),
            "ExpiresAt" to Json.of(1_700_600_000L),
            "NotifiedAt" to Json.of(0L),
            "SavedAt" to Json.of(0L),
            "TerminalAt" to Json.of(0L),
            "Terminal" to Json.of(false),
        ),
        overrides,
    )

    /** A claim row: the task plus the three fields only the target device gets. */
    fun delivery(vararg overrides: Pair<String, Json?>): Json.Obj {
        val wrapped = InboxKeyMaterial.encode(ByteArray(InboxProtocol.SEALED_BOX_BYTES) { 7 })
        return obj(
            task().entries + mapOf(
                "EncManifest" to Json.of("AAAA"),
                "WrappedKey" to Json.of(wrapped),
                "ClaimToken" to Json.of("claim-token-value"),
            ),
            overrides,
        )
    }

    /** A syntactically valid sealed box of the exact protocol length. */
    fun wrappedKey(fill: Byte = 7): String =
        InboxKeyMaterial.encode(ByteArray(InboxProtocol.SEALED_BOX_BYTES) { fill })

    /**
     * A Kotlin `null` override REMOVES the field; [Json.Null] sets a real JSON
     * null.
     *
     * The two are deliberately different documents: Go writes `null` for a nil
     * pointer and omits nothing, so an optional reader has to accept both as
     * absent while still refusing a third case — a value of the wrong type. A
     * fixture that collapsed omission and null could not express that at all.
     */
    private fun obj(
        base: Map<String, Json>,
        overrides: Array<out Pair<String, Json?>>,
    ): Json.Obj = obj(base, overrides.toMap())

    private fun obj(base: Map<String, Json>, overrides: Map<String, Json?>): Json.Obj {
        val entries = LinkedHashMap(base)
        for ((key, value) in overrides) {
            if (value == null) entries.remove(key) else entries[key] = value
        }
        return Json.Obj(entries)
    }
}
