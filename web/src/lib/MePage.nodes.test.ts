import { describe, it, expect } from "vitest";
import { nodeRunCommand } from "./nodes";

describe("nodeRunCommand", () => {
  it("embeds the token and central URL", () => {
    const cmd = nodeRunCommand("TOK123", "https://relayium.com");
    expect(cmd).toContain("RELAYIUM_NODE_TOKEN=TOK123");
    expect(cmd).toContain("RELAYIUM_CENTRAL_URL=https://relayium.com");
  });

  it("produces a single-line, paste-in shell command", () => {
    const cmd = nodeRunCommand("abc", "http://localhost:8080");
    expect(cmd).not.toContain("\n");
    expect(cmd).toContain("relayium-node");
  });

  it("differs per token so a stale copy can't be reused silently", () => {
    const a = nodeRunCommand("tok-a", "https://relayium.com");
    const b = nodeRunCommand("tok-b", "https://relayium.com");
    expect(a).not.toBe(b);
  });
});
