// Helpers for the "My Nodes" (BYO relay node) section of the account page.
// Pure/no-DOM so they're unit-testable without mounting MePage.svelte.

/**
 * nodeRunCommand builds the one-line command a user pastes on their own box to
 * install and start their BYO relay node bound to their account. It pipes the
 * hosted install-node.sh installer (served at ${centralURL}/install-node.sh)
 * into sh with the required env: the installer downloads the relayium-node
 * binary, and — when run as root with systemd — writes an env file + service
 * unit and starts it. RELAYIUM_NODE_STORAGE_DIR is passed so the node also
 * stores blobs (not just relays), matching the "relay/storage" feature.
 *
 * We install rather than assume `relayium-node` is already on PATH: the token is
 * minted once by POST /api/nodes/provision and must never be shown again after
 * this — so this command line is the only place it's rendered.
 *
 * The pipe elevates via `sudo` (a no-op when already root) because the installer
 * writes to /usr/local/bin and installs a systemd unit — both need root. sudo
 * takes the RELAYIUM_* assignments as leading args so they reach the piped sh's
 * environment even though sudo resets the caller's env by default.
 */
export function nodeRunCommand(token: string, centralURL: string): string {
  return `curl -fsSL ${centralURL}/install-node.sh | sudo RELAYIUM_CENTRAL_URL=${centralURL} RELAYIUM_NODE_TOKEN=${token} RELAYIUM_NODE_STORAGE_DIR=/var/lib/relayium-node/blobs sh`;
}

/**
 * nodePortsCommand returns the copy-paste ufw block that opens the inbound ports
 * a node needs to actually serve peers (only relevant when a host firewall is
 * on). Kept in sync with server/cmd/relayium-node/main.go: TURN 3478/udp,
 * blob storage 8081/tcp, and the relay UDP range 49152–65535.
 */
export function nodePortsCommand(): string {
  return [
    "sudo ufw allow 3478/udp        # TURN",
    "sudo ufw allow 8081/tcp        # storage",
    "sudo ufw allow 49152:65535/udp # relay",
  ].join("\n");
}
