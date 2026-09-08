package com.relayium.android.nearby

import com.relayium.protocol.Envelope
import com.relayium.protocol.Filename

/**
 * One OTHER device the user may pick.
 *
 * Selection, signalling and the connection are all bound to [id] and NEVER to
 * the name: names are peer-supplied, arbitrary, and duplicated across devices as
 * a matter of course — two phones both called `Pixel 9` is the normal case, not
 * an attack.
 */
data class NearbyDevice(
    val id: String,
    /**
     * What the peer called itself, sanitised for display, or EMPTY when it gave
     * no usable name. A label, never an identity and never a key.
     *
     * Empty is a real answer that the screen renders as the localised "unnamed
     * device", not a missing one: a peer is entitled to announce nothing
     * readable, and inventing a name for it here would put a word in its mouth.
     */
    val name: String,
    /**
     * Another listed device is showing the SAME name, so the row must be
     * disambiguated before the user picks one.
     *
     * A flag rather than a finished label, because the finished label needs a
     * localised word for a device that gave no name at all, and this type is
     * built by the controller, which holds no resources. The screen composes
     * `name` (or the localised placeholder) plus [shortPeerId] when this is
     * true — so switching the system language actually re-renders the list
     * instead of leaving a string resolved under the previous locale.
     */
    val ambiguous: Boolean,
    /** Whether this peer announced exactly `link/1`. A CAPABILITY, never an
     *  identity and never a security input: anything on the link or in the room
     *  can strip it (the feature is denied) or forge it (a link is offered to a
     *  peer that cannot answer — also a denial). It can never put plaintext on
     *  the wire, because the session keys come from commit-reveal. */
    val supportsLink: Boolean,
    /** Whether this peer announced exactly `text/1`. Read only once
     *  [supportsLink] has already answered false; it is what lets a legacy lane
     *  be chosen from the peer's own announcement instead of by asking the user
     *  a question about a wire. */
    val announcesText: Boolean,
)

/**
 * Turn a raw room roster into the list the user picks from.
 *
 * Pure, because every rule here is a way the feature can go wrong, and each is
 * directly testable:
 *
 *  - **exclude ourselves by id.** Both rendezvous shapes broadcast the whole
 *    room including this device, and before the self id is known nothing is
 *    listed AT ALL rather than offering the user their own phone to send to.
 *  - **never inherit the source's ordering.** The hub builds its roster by
 *    ranging a Go map, so the order differs between broadcasts. Sorting is what
 *    stops the list reshuffling under a finger between two frames — which, with
 *    selection bound to a row's POSITION, is how the wrong device gets picked.
 *    Selection here is bound to the id, and the sort keeps the list from moving
 *    anyway.
 *  - **disambiguate duplicate names**, so two identically named devices are
 *    distinguishable before the tap rather than after the transfer.
 */
fun nearbyDevices(
    roster: List<Envelope.Peer>,
    selfId: String,
    supportsLink: (String) -> Boolean = { false },
    announcesText: (String) -> Boolean = { false },
): List<NearbyDevice> {
    if (selfId.isEmpty()) return emptyList()

    val seen = HashSet<String>()
    val unique = ArrayList<Pair<String, String>>()
    for (peer in roster) {
        if (peer.id == selfId || peer.id.isEmpty()) continue
        if (!seen.add(peer.id)) continue
        // Peer-supplied text rendered in our UI gets the same treatment an
        // incoming file name gets, so a device cannot dress its name up as
        // another one with a right-to-left override.
        unique.add(peer.id to Filename.safeDisplayName(peer.name).trim())
    }

    val counts = HashMap<String, Int>()
    for ((_, name) in unique) counts[name] = (counts[name] ?: 0) + 1

    return unique
        .sortedWith(compareBy({ it.second }, { it.first }))
        .map { (id, name) ->
            NearbyDevice(
                id = id,
                name = name,
                ambiguous = (counts[name] ?: 0) > 1,
                supportsLink = supportsLink(id),
                announcesText = announcesText(id),
            )
        }
}

/** Enough of a peer id to tell two same-named devices apart on screen without
 *  putting a full opaque id in front of the user. */
fun shortPeerId(id: String): String = id.takeLast(6)
