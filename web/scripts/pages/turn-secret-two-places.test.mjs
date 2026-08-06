// web/scripts/pages/turn-secret-two-places.test.mjs — the bundled `relay`
// profile needs RELAYIUM_TURN_SECRET in TWO places, and every failure mode of
// getting that wrong is silent. This file pins the three facts that make the
// warning in docker-compose.yml and docs/self-hosting.md true, so that a change
// to any one of them fails here instead of shipping a stale warning.
//
// The trap, concretely:
//   * coturn receives the secret through Compose VARIABLE INTERPOLATION of its
//     `command:`, which Compose resolves from the shell or the project-root
//     .env. An `env_file:` (./server/.env) is injected into a container and is
//     never consulted for interpolation.
//   * The SERVER receives it from its own environment, i.e. ./server/.env.
//   * An empty -turn-secret disables TURN outright in the server.
// So `RELAYIUM_TURN_SECRET=… docker compose --profile relay up -d` starts a
// perfectly healthy coturn that the server never issues credentials for.
// `docker compose ps` is green, nothing is logged, and strict-NAT transfers go
// on failing exactly as they did before the relay was added.
//
// Why not just add a passthrough to the server service and delete the warning:
// `environment:` outranks `env_file:`, and a `${RELAYIUM_TURN_SECRET:-}` default
// counts as set, so it would silently blank the value for everyone who keeps the
// secret in ./server/.env as the security guidance tells them to. That is a
// worse bug than the one it fixes, which is why assertion 1 below is written as
// "must NOT be present" rather than "must be present".
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repo = (p) => readFileSync(resolve(process.cwd(), "..", p), "utf8");

const compose = repo("docker-compose.yml");
const doc = repo("docs/self-hosting.md");
const mainGo = repo("server/main.go");

/** The body of one top-level service in docker-compose.yml, by name. */
function service(name) {
  const lines = compose.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  expect(start, `docker-compose.yml has no \`${name}:\` service`).toBeGreaterThan(-1);
  const rest = lines.slice(start + 1);
  // A service ends at the next line indented exactly two spaces — INCLUDING a
  // comment, because the block comment introducing `coturn:` sits at that indent
  // and belongs to coturn. (Comments written inside a service body are indented
  // deeper, with the key they annotate.) Reading it as part of `server:` is not
  // hypothetical: that comment quotes the very passthrough this test forbids, so
  // a laxer boundary makes assertion 1 fail on the text that explains it.
  const end = rest.findIndex((l) => /^ {2}\S/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

describe("the relay profile's TURN secret must be set in two places", () => {
  it("does not inject RELAYIUM_TURN_SECRET into the server service", () => {
    // Adding it here looks like the obvious fix and is a regression: see the
    // header. If this ever fails, the fix is NOT to delete the assertion — it is
    // to check whether `environment:` still outranks `env_file:`, and to rewrite
    // docs/self-hosting.md's two-place instruction before relaxing anything.
    expect(service("server")).not.toMatch(/RELAYIUM_TURN_(SECRET|URLS)\s*:/);
  });

  it("hands coturn the secret by interpolation, which server/.env cannot satisfy", () => {
    const coturn = service("coturn");
    expect(coturn).toMatch(/--static-auth-secret=\$\{RELAYIUM_TURN_SECRET/);
    // `:?` — Compose refuses to parse the file at all when the variable is
    // missing, which is the one loud part of this whole story. Losing it would
    // turn the missing secret into an empty coturn secret.
    expect(coturn).toMatch(/\$\{RELAYIUM_TURN_SECRET:\?/);
  });

  it("still disables TURN on an empty secret, which is what makes the failure silent", () => {
    // The load-bearing fact under both warnings. If the server ever starts
    // erroring on an empty secret instead of quietly disabling TURN, the
    // "silent" framing in the compose comment and the guide is wrong and both
    // should be rewritten — so this assertion exists to force that reread.
    expect(mainGo).toMatch(
      /flag\.String\(\s*"turn-secret",\s*envStr\("RELAYIUM_TURN_SECRET",\s*""\),\s*"[^"]*empty disables TURN/,
    );
  });

  it("documents both places and gives a check that catches the silent case", () => {
    expect(doc).toMatch(/two places/i);
    // coturn being up proves nothing about the server, so the documented check
    // has to look at the server's own environment.
    expect(doc).toMatch(/docker compose exec server env \| grep RELAYIUM_TURN/);
    // Sourcing beats `VAR=… docker compose …`: the guide's own security section
    // says secrets must stay off the command line, where ps exposes them.
    expect(doc).toMatch(/set -a; \. \.\/server\/\.env; set \+a/);
  });

  it("keeps a project-root .env out of git, since the guide sends secrets there", () => {
    // server/.gitignore has always covered server/.env. The root one is the file
    // Compose interpolates from, and it was not ignored.
    expect(repo(".gitignore")).toMatch(/^\/\.env$/m);
  });
});
