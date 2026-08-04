import type { Peer } from "./protocol";

/** Enough of a peer id to tell two same-named devices apart on screen without
 *  putting a full opaque id in front of the user. Same rule and same separator
 *  as the native chooser (RelayiumAppKit's shortPeerID), so one product does not
 *  disambiguate two different ways. */
export function shortPeerId(id: string): string {
  return id.slice(-6);
}

/**
 * Make same-named peers distinguishable on screen.
 *
 * Device grouping already collapses one installation's tabs into a single
 * entry, so anything still sharing a name here is a genuinely different device
 * — two machines the owner called "Mac", or two people on one network. Offering
 * them as two identical rows is what makes a chooser untrustworthy: the user
 * cannot say which one they picked, and cannot tell that they picked wrong.
 *
 * Only the DISPLAYED name changes. Ids are untouched and every selection, file
 * send and message request continues to bind to the full id, never to the name
 * or to a position in the list.
 */
export function labelPeers(peers: Peer[]): Peer[] {
  const counts = new Map<string, number>();
  for (const p of peers) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  return peers.map((p) =>
    (counts.get(p.name) ?? 0) > 1 ? { ...p, name: `${p.name} · ${shortPeerId(p.id)}` } : p,
  );
}
