// The document the server actually serves, read by the decoder that will
// actually read it.
//
// The Windows supported-version gate is two halves in two languages. The
// client half (`src/main/policy/`) had ten invariants and adversarial cases for
// each of them, and no server end at all: `GET /api/client-policy/windows` did
// not exist, so every launch fell back to the floor compiled into its own
// binary and the fetch path had never once succeeded.
//
// Now that it exists, the risk moves. A Go handler and a TypeScript decoder are
// two statements of one contract, and when they drift the symptom is INVISIBLE:
// `decodePolicy` refuses a document whole, `policy-source` falls back silently
// — by design, so a policy outage cannot brick a client — and the product looks
// exactly the same as it did when there was no route. Nothing goes red. The
// lever is simply gone, and the first person to find out is whoever needed it
// in an emergency.
//
// So there is one artefact. `server/account/windows_client_policy.json` is
// embedded and served byte for byte, and this file runs the shipped decoder
// over those same bytes.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  decodePolicy,
  supportState,
  thisBuild,
  EMBEDDED_FLOOR,
  MAX_POLICY_BYTES,
  PolicyError,
} from "../../src/main/policy/client-policy.js";
import { POLICY_PATH } from "../../src/main/policy/policy-source.js";

const SERVED = fileURLToPath(new URL("../../../../server/account/windows_client_policy.json", import.meta.url));
const raw = readFileSync(SERVED, "utf8");
const document: unknown = JSON.parse(raw);

describe("the document the server serves", () => {
  it("is the one this route asks for", () => {
    // Guards everything below: a test reading a file the server does not serve
    // would report a working contract for a route that answers 404.
    expect(POLICY_PATH).toBe("/api/client-policy/windows");
    const handlers = readFileSync(fileURLToPath(new URL("../../../../server/account/handlers.go", import.meta.url)), "utf8");
    expect(handlers).toContain(`GET ${POLICY_PATH}`);
    const served = readFileSync(fileURLToPath(new URL("../../../../server/account/version_policy.go", import.meta.url)), "utf8");
    expect(served).toContain("//go:embed windows_client_policy.json");
  });

  it("is accepted by the shipped decoder", () => {
    // The whole point. Not a hand-written fixture shaped like the server's
    // output — the server's output.
    const policy = decodePolicy(document, EMBEDDED_FLOOR.revision);
    expect(policy.revision).toBeGreaterThanOrEqual(1);
  });

  it("blocks nothing, which is what the owner asked for", () => {
    // OA-033: no minimum version for now. The mechanism ships, the teeth do
    // not. A served document that blocked a build would be this batch
    // overriding a product decision by accident.
    const policy = decodePolicy(document, EMBEDDED_FLOOR.revision);
    expect(supportState(thisBuild("0.1.0"), policy)).toBe("supported");
    expect(supportState(thisBuild("0.0.1"), policy)).toBe("supported");
    // And for a build number that has been provisioned, which is the case the
    // placeholder cannot exercise.
    expect(supportState({ version: "0.1.0", build: 1, buildProvisioned: true }, policy)).toBe("supported");
  });

  it("is not weaker than the floor it will be held against", () => {
    // The failure this catches is a route that looks healthy and does nothing.
    // A document below `EMBEDDED_FLOOR` is refused by invariant 2, the client
    // falls back silently, and every symptom is identical to having no route.
    const policy = decodePolicy(document, EMBEDDED_FLOOR.revision);
    expect(policy.minimumSupported).toEqual(EMBEDDED_FLOOR.minimumSupported);
    expect(policy.minimumSupportedBuild).toBe(EMBEDDED_FLOOR.minimumSupportedBuild);
  });

  it("survives the replay barrier a device will hold it to", () => {
    // A fresh install starts at the floor's revision. If the served revision
    // were below it the document would be refused as replayed — on the first
    // fetch, forever, on every install.
    expect(() => decodePolicy(document, EMBEDDED_FLOOR.revision)).not.toThrow();
    // And one revision higher is refused, which is the barrier working rather
    // than the document being lucky.
    expect(() => decodePolicy(document, EMBEDDED_FLOOR.revision + 1)).toThrow(PolicyError);
  });

  it("fits the bound the fetch will apply to it", () => {
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThan(MAX_POLICY_BYTES);
  });

  it("carries no URL of any kind", () => {
    // Invariant 6, from the other end. The decoder drops unknown fields; this
    // is so the server never offers one to drop. A policy that could name where
    // an update comes from would be a remote redirect for the one action that
    // installs code on the user's PC.
    for (const needle of ["http", "://", "url", "href", "feed", "endpoint"]) {
      expect(raw.toLowerCase()).not.toContain(needle);
    }
  });
});
