import { describe, it, expect } from "vitest";
import { nodeRunCommand, nodePortsCommand } from "./nodes";

describe("nodeRunCommand", () => {
  it("embeds the token and central URL", () => {
    const cmd = nodeRunCommand("TOK123", "https://relayium.com");
    expect(cmd).toContain("RELAYIUM_NODE_TOKEN=TOK123");
    expect(cmd).toContain("RELAYIUM_CENTRAL_URL=https://relayium.com");
  });

  it("produces a single-line, paste-in shell command", () => {
    const cmd = nodeRunCommand("abc", "http://localhost:8080");
    expect(cmd).not.toContain("\n");
  });

  it("installs via the hosted installer rather than assuming the binary exists", () => {
    const cmd = nodeRunCommand("abc", "https://relayium.com");
    expect(cmd).toContain("curl -fsSL https://relayium.com/install-node.sh");
    expect(cmd).toContain("| sudo RELAYIUM_"); // elevates + pipes env into the installer
  });

  it("enables blob storage so the node relays and stores", () => {
    const cmd = nodeRunCommand("abc", "https://relayium.com");
    expect(cmd).toContain("RELAYIUM_NODE_STORAGE_DIR=/var/lib/relayium-node/blobs");
  });

  it("lists the inbound ports a node must open, matching the binary", () => {
    const ports = nodePortsCommand();
    expect(ports).toContain("3478/udp"); // TURN
    expect(ports).toContain("8081/tcp"); // storage
    expect(ports).toContain("49152:65535/udp"); // relay range
  });

  it("differs per token so a stale copy can't be reused silently", () => {
    const a = nodeRunCommand("tok-a", "https://relayium.com");
    const b = nodeRunCommand("tok-b", "https://relayium.com");
    expect(a).not.toBe(b);
  });
});
