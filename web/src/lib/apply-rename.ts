// applyRename returns a new roster with the peer `fromId`'s display name set to
// newName (trimmed, capped at 64 chars). An empty name or unknown id is a no-op.
export function applyRename<T extends { id: string; name: string }>(peers: T[], fromId: string, newName: string): T[] {
  const name = newName.trim().slice(0, 64);
  if (!name) return peers;
  return peers.map((p) => (p.id === fromId ? { ...p, name } : p));
}
