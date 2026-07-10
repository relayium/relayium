// Helpers for the "My Nodes" (BYO relay node) section of the account page.
// Pure/no-DOM so they're unit-testable without mounting MePage.svelte.

/**
 * nodeRunCommand builds the one-line command a user pastes on their own box to
 * run their BYO relay node bound to their account. The token is minted once by
 * POST /api/nodes/provision and must never be shown again after this — so this
 * command line is the only place it's rendered.
 */
export function nodeRunCommand(token: string, centralURL: string): string {
  return `RELAYIUM_CENTRAL_URL=${centralURL} RELAYIUM_NODE_TOKEN=${token} relayium-node -storage-dir /var/lib/relayium-node/blobs`;
}
