import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const repo = path.resolve(import.meta.dirname, "../../..");
const read = (name) => fs.readFileSync(path.join(repo, name), "utf8");
const eligible = /coturn TURN servers can also contribute accepted usage when configured for billable accounting, subject to authentication, attribution and accounting acceptance/;
const retired = /coturn TURN servers bill nothing today|coturn TURN 服务器目前不计费|billed by neither coturn path/;
describe("release accounting truth outside generated page exports", () => {
  it.each(["README.md", "web/public/llms.txt"])("%s states conditional billable eligibility", (file) => {
    const text = read(file);
    expect(text).toMatch(eligible);
    expect(text).not.toMatch(retired);
    expect(text).not.toContain("bytes a billing relay carries do count");
    expect(text).toContain("if configured in shadow mode");
    expect(text).toMatch(/no per-transfer charge|not a per-transfer charge|not a separate charge|does not mean a per-transfer charge/);
  });
  it("implementation guide separates deployment mode from accepted allocation usage", () => {
    const text = read("docs/billing-transparency.md");
    expect(text).not.toMatch(retired);
    expect(text).toContain("both the preceding and");
    expect(text).toContain("does not prove that any particular allocation or every relayed byte");
  });
  it("release record names the actual published repair while retaining deferred scopes", () => {
    const text = read("docs/cli-repair-candidate.md");
    expect(text).toContain("e46dc8e18945596abc72ed6a4a78a663006a41c6");
    expect(text).toContain("v0.27.1");
    expect(text).not.toMatch(/UNRELEASED|neither released|Not released/);
    expect(text).toContain("A2 deferred");
    expect(text).toContain("D2 deferred");
  });
  it("negative control rejects obsolete no-billing claims", () => {
    expect("coturn TURN servers bill nothing today").toMatch(retired);
    expect("coturn TURN 服务器目前不计费").toMatch(retired);
    expect("coturn TURN servers bill nothing today").not.toMatch(eligible);
  });
});
