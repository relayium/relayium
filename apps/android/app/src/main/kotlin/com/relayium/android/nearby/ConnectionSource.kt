package com.relayium.android.nearby

import com.relayium.android.TransferController
import com.relayium.protocol.PairCode

/**
 * WHY this device is in a room, and therefore how a peer becomes THE peer of a
 * session.
 *
 * Before this type there was one answer, because there was one way in: a
 * six-digit pairing code names a room the server holds to exactly two
 * participants, so "the other peer" is unambiguous and the controller may take
 * it without asking. Both Nearby paths break that assumption in the same way and
 * for different reasons, and neither may be handled by pretending to be a
 * pairing room:
 *
 *  - the code-less HUB room is keyed by the address the server observes, so it
 *    lists every device behind one public address. Some of them may have nothing
 *    to do with this user.
 *  - the local link lists whatever is advertising `_relayium._tcp` on it.
 *
 * So the source carries the decision rather than leaving it implicit. A
 * [PeerAdmission.AUTOMATIC] source keeps the shipped two-peer behaviour byte for
 * byte; an [PeerAdmission.EXPLICIT] one connects to nobody until a person says
 * which device, and admits nobody until a person says yes.
 *
 * It lives beside the Nearby code because the Nearby paths are what made the
 * distinction necessary, and the pairing case is written out HERE rather than
 * left as the absence of a flag — an implicit default is exactly how the
 * two-peer assumption came to be spread across two call sites in the first
 * place.
 */
sealed interface ConnectionSource {

    /** How a peer becomes the peer of a session. */
    val admission: PeerAdmission

    /**
     * Whether this path may talk to the Relayium backend AT ALL.
     *
     * False is a hard property, not a preference: the direct path's entire claim
     * is that nothing about the transfer leaves the local link, so it must not
     * open a rendezvous socket and must not ask for ICE credentials. The
     * controller skips the ICE fetch on this answer and the composition layer
     * refuses such a source a second time, because one fence that a future edit
     * can move is not a promise.
     */
    val usesBackend: Boolean

    /** A human-readable tag for logs and tests. Never rendered. */
    val kind: Kind

    enum class Kind { PAIRING, HUB, DIRECT }

    /** The shipped six-digit room: exactly two participants, so the other one
     *  is unambiguous and no selection UI exists or is wanted. */
    data class Pairing(
        val code: PairCode,
        /** Who offers on the shipped legacy wire. See [TransferController.Intent]. */
        val intent: TransferController.Intent,
    ) : ConnectionSource {
        override val admission get() = PeerAdmission.AUTOMATIC
        override val usesBackend get() = true
        override val kind get() = Kind.PAIRING
    }

    /**
     * The code-less rendezvous room, shared with the Web and macOS clients.
     *
     * The server routes it by the address it OBSERVES, which is why selection
     * and inbound consent are mandatory here: two households behind one carrier
     * NAT are one room as far as the hub is concerned. This client says so in
     * its copy rather than describing the room as "your network".
     */
    data object Hub : ConnectionSource {
        override val admission get() = PeerAdmission.EXPLICIT
        override val usesBackend get() = true
        override val kind get() = Kind.HUB
    }

    /**
     * Bonjour discovery and direct TCP signalling on the local link, with no
     * server of any kind — the same rendezvous the iOS client uses.
     *
     * ICE is EMPTY here, which is not a degraded configuration: two devices on
     * one link reach each other on host candidates, and asking a server for
     * relay credentials would be the one network call this path promises not to
     * make.
     */
    data object Direct : ConnectionSource {
        override val admission get() = PeerAdmission.EXPLICIT
        override val usesBackend get() = false
        override val kind get() = Kind.DIRECT
    }
}

enum class PeerAdmission {
    /** The room holds one other participant; take it. */
    AUTOMATIC,

    /**
     * Nothing establishes without a person.
     *
     * Outbound: the user picks a device from the list. Inbound: an offer or a
     * link request raises a prompt naming the peer, and is answered only when
     * the user accepts. Neither is a security boundary on its own — the
     * commit-reveal handshake and the SAS are — but both are the difference
     * between a device the user chose and a device that chose them.
     */
    EXPLICIT,
}
