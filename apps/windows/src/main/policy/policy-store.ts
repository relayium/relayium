// Where the client policy is remembered between launches.
//
// Two values, and the second is the one that matters:
//
//  * The **raw document**, exactly as it was served. Not the decoded policy —
//    that distinction is the point. A later build may ship a HIGHER embedded
//    floor, and it must re-decode the cached document against its own floor
//    rather than inherit a verdict reached by a build with a lower one. A
//    cached decision would let an old build's leniency survive the upgrade that
//    was meant to end it.
//  * The **highest revision ever accepted**, which is the replay barrier. It is
//    a high-water mark and never goes down, including when a cached document is
//    later refused: a document this build will not read is still a document
//    that was once accepted, and forgetting its revision would reopen the
//    replay this barrier exists to close.
//
// A missing or unreadable file is not an error. It means "no memory", and the
// embedded floor is the policy in force — which is what fail open means here.
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { EMBEDDED_FLOOR, MAX_POLICY_REVISION } from "./client-policy.js";

/** The file's own schema, separate from the document's. */
const STORE_SCHEMA = 1;

export interface PolicyMemory {
  /** The raw served document, or `null` when nothing has ever been accepted. */
  readonly document: unknown;
  /** The replay barrier. Never below the embedded floor's revision. */
  readonly acceptedRevision: number;
}

/** No memory: the embedded floor is in force and its revision is the barrier. */
export const NO_MEMORY: PolicyMemory = Object.freeze({
  document: null,
  acceptedRevision: EMBEDDED_FLOOR.revision,
});

export const policyPath = (dataRoot: string): string => join(dataRoot, "client-policy.json");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class PolicyStore {
  constructor(private readonly filePath: string) {}

  /**
   * What this device remembers.
   *
   * Total: every failure — missing, unreadable, malformed, a revision out of
   * bounds — answers `NO_MEMORY` rather than throwing. A policy cache that
   * could throw on start-up would be a policy cache that can stop the app,
   * which is the opposite of what it is for.
   */
  async read(): Promise<PolicyMemory> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return NO_MEMORY;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return NO_MEMORY;
    }
    if (!isRecord(parsed) || parsed["schema"] !== STORE_SCHEMA) return NO_MEMORY;
    const revision = parsed["acceptedRevision"];
    if (
      typeof revision !== "number" ||
      !Number.isInteger(revision) ||
      revision < EMBEDDED_FLOOR.revision ||
      revision > MAX_POLICY_REVISION
    ) {
      // A barrier this build cannot trust is no barrier. Falling back to the
      // embedded revision is the safe direction: it can only make this device
      // MORE willing to read a document, never less, and every document it then
      // reads is still held against the floor.
      return NO_MEMORY;
    }
    return { document: parsed["document"] ?? null, acceptedRevision: revision };
  }

  /**
   * Remember an accepted document.
   *
   * Written to a sibling and renamed, so a crash mid-write leaves the previous
   * memory rather than a half-file. A failure to write is not raised: the
   * policy is already in force for this session, and a device that could not
   * persist it simply re-fetches next launch.
   */
  async write(memory: PolicyMemory): Promise<void> {
    const body = JSON.stringify({
      schema: STORE_SCHEMA,
      document: memory.document,
      acceptedRevision: memory.acceptedRevision,
    });
    const temporary = `${this.filePath}.tmp`;
    try {
      await writeFile(temporary, body, "utf8");
      await rename(temporary, this.filePath);
    } catch {
      /* see the doc comment: a cache that cannot be written is not a fault */
    }
  }
}
