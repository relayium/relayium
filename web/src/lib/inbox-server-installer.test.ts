import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const path = "public/inbox-server-install.sh";
const script = readFileSync(path, "utf8");

describe("Linux Device Inbox installer", () => {
  it("is valid POSIX shell and installs a reboot-persistent low-privilege unit", () => {
    execFileSync("sh", ["-n", path]);
    expect(script).toContain("useradd --system");
    expect(script).toContain("runuser -u \"$service_user\"");
    expect(script).toContain("systemctl enable --now relayium-inbox.service");
    expect(script).toContain("/etc/systemd/system/relayium-inbox.service");
  });

  it("never prints the credential and archives old foreground state only after start", () => {
    expect(script).not.toMatch(/cat .*credentials/);
    expect(script).not.toMatch(/echo .*credentials/);
    const started = script.indexOf("systemctl enable --now relayium-inbox.service");
    const archived = script.indexOf("inbox.disabled-after-system-service");
    expect(started).toBeGreaterThan(0);
    expect(archived).toBeGreaterThan(started);
  });

  it("rejects home-directory destinations blocked by the hardened service", () => {
    expect(script).toContain("/root/*|/home/*|/run/user/*");
    expect(script).toContain("use /srv/relayium-inbox");
  });
});
