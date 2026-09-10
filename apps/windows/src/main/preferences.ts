// Settings the user chose, and nothing else.
//
// ## Why this is not in the secret store
//
// `SecretStore` is encrypted account storage. A preference kept there would need
// a usable store to read — and the two preferences that exist govern LAN and
// pairing transfers, which work **signed out** and must keep working when
// account storage is unreadable. Making "do I ask the user to compare digits?"
// depend on DPAPI would mean a machine with a broken store silently answering
// the wrong way about a security prompt.
//
// So: plain JSON, under the same data root, holding no secret. Everything here
// is a boolean the user set. Nothing here is a credential, and nothing here is
// ever logged.
//
// ## Why a missing file is not an error
//
// An untouched install has no file, and that is the same state as an install
// whose file could not be read: neither has an answer, so both take the default.
// The defaults are chosen so that answer is the safe one — see each field.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * The user's answers. Every field is optional in the FILE and total here, so a
 * file written by an older build is read rather than rejected.
 */
export interface Preferences {
  /**
   * Whether a transfer asks the user to compare a verification code.
   *
   * **Default off, and that is the shipped Mac behaviour**, not a shortcut:
   * `VerificationPreference.swift` backs `com.relayium.verifyPeers` and
   * documents an absent key as "what an untouched install does".
   *
   * What it does NOT govern: commit-reveal and AEAD run unconditionally on
   * every link, so the key exchange is authenticated either way.
   *
   * What it DOES govern is a real, separate protection, and saying otherwise
   * would be an overclaim. Comparing the code out-of-band is what detects an
   * active attacker who sits on the signalling path and completes a handshake
   * with each side — the one adversary the cryptography alone cannot rule out,
   * because both halves are individually well-formed. Turning this off does not
   * weaken the ciphers; it declines a distinct check, and the honest framing is
   * that the user is trading it away rather than losing nothing.
   */
  readonly verifyPeers: boolean;
  /**
   * Whether the "closing does not quit" notice has been answered.
   *
   * Written by the main process, never by the renderer — it is not in `KEYS`,
   * so `prefs-write` cannot reach it. It lives here rather than in a file of its
   * own because this IS the settings file, and a second one would be a second
   * thing to migrate, back up and get wrong.
   */
  readonly firstCloseAcknowledged: boolean;
}

// ## Why same-network receiving is NOT in here
//
// It was, defaulting to off and persisted, on my reading that a desktop app
// should not advertise itself before being asked. That is not what the shipped
// Mac does, and the difference is checkable rather than a matter of taste:
// `RelayiumApp.swift:869` calls `lanDiscovery.startResident()` unconditionally
// on a shipped launch, and `LanDiscovery.swift` contains no `UserDefaults` at
// all — `isPausedByUser` is a plain in-memory field. Its doc comment's "sticky
// across relaunched windows" means WINDOWS, not processes.
//
// So parity is: a fresh process joins automatically, and a pause the user makes
// lasts for that process. Persisting it here would have been a Windows-only
// behaviour dressed as parity, and would have left a first-run user looking at
// an empty screen with a button the Mac never asks anyone to press.
//
// Starting at login is a different setting, is genuinely off by default, and
// belongs to the resident lane.

export const DEFAULT_PREFERENCES: Preferences = {
  verifyPeers: false,
  firstCloseAcknowledged: false,
};

/** A preference name the renderer may set. Nothing else is reachable. */
export type PreferenceKey = keyof Preferences;

/**
 * What the RENDERER may set. Deliberately not `keyof Preferences`.
 *
 * `firstCloseAcknowledged` is a main-process fact about a native dialog the
 * page never sees; a renderer able to write it could suppress the only
 * explanation a user gets for the app not quitting.
 */
const KEYS: readonly PreferenceKey[] = ["verifyPeers"];

export const isPreferenceKey = (value: unknown): value is PreferenceKey =>
  typeof value === "string" && (KEYS as readonly string[]).includes(value);

/**
 * Why a settings file could not be used.
 *
 * `missing` is not a failure — it is a fresh install, and the defaults are the
 * right answer. `unreadable` is: the file is THERE and could not be parsed, so
 * this process does not know what the user chose.
 */
export type PreferenceHealth = "ok" | "missing" | "unreadable";

export interface PreferenceSnapshot {
  readonly values: Preferences;
  readonly health: PreferenceHealth;
}

export class PreferenceStoreError extends Error {
  constructor(readonly health: PreferenceHealth) {
    super(`preferences ${health}`);
    this.name = "PreferenceStoreError";
  }
}

/** Distinguishes "there is no file" from "the file is unusable". */
const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === "ENOENT";

/**
 * Staging-name counter, per PROCESS rather than per store.
 *
 * A per-instance counter is not unique: two `PreferenceStore` objects on one
 * file — which is what a second window produces — both start at 1 and both
 * build `preferences.json.<pid>.1.new`, so one renames the file the other is
 * still writing and the loser fails with ENOENT. That is the same collision the
 * shared `.new` sibling had, moved one level down, and it was caught by the
 * two-store test rather than by reasoning.
 */
let stagingSeq = 0;

/**
 * Reads and writes one small JSON file.
 *
 * ## Writes are serialised, and each one re-reads inside its turn
 *
 * Two concurrent writes used to each read the same old snapshot, spread their
 * own field over it and write it back — so toggling both preferences at once
 * lost whichever landed first. They also shared one `.new` sibling, so the
 * second write could rename a file the first had already moved and fail with
 * ENOENT. Both are ordinary: the settings card has two controls next to each
 * other. So writes queue, the read-modify-write happens inside the queue, and
 * the staging file is unique per write.
 *
 * ## An unreadable file is never overwritten from defaults
 *
 * This is the one that mattered. `verifyPeers: true` is a security decision the
 * user made. If the file becomes temporarily unreadable and a write then
 * rebuilds it from defaults, that decision is silently reverted — and the app
 * reports the save as successful. So a write refuses while the file is
 * unreadable, and the refusal is surfaced rather than swallowed. A MISSING file
 * is different and is written normally: nobody has chosen anything yet.
 */
export class PreferenceStore {
  #cache: Preferences | null = null;
  /** Writes run one at a time, in order. */
  #tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  /** The values, and whether they are known to be the user's. */
  async snapshot(): Promise<PreferenceSnapshot> {
    if (this.#cache) return { values: this.#cache, health: "ok" };
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      // Deliberately NOT cached either way: a transient failure must not become
      // this session's settled truth, and a missing file may be written at any
      // moment by another window.
      return { values: DEFAULT_PREFERENCES, health: isMissing(err) ? "missing" : "unreadable" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { values: DEFAULT_PREFERENCES, health: "unreadable" };
    }
    const values = narrow(parsed);
    if (values === null) {
      // A file that parses as JSON but is not this schema — `null`, an array, a
      // `verifyPeers` that is not a boolean — is a file whose contents this
      // process does not understand. Reading it as "ok, and the defaults apply"
      // silently answers a SECURITY question the user may have answered the
      // other way, and reports the answer as theirs.
      return { values: DEFAULT_PREFERENCES, health: "unreadable" };
    }
    this.#cache = values;
    return { values, health: "ok" };
  }

  async read(): Promise<Preferences> {
    return (await this.snapshot()).values;
  }

  /**
   * Set one field.
   *
   * Queued behind every earlier write, and the read happens inside this turn —
   * so the value written is the current file plus this one field, never a stale
   * snapshot plus this one field.
   */
  write(key: PreferenceKey, value: boolean): Promise<Preferences> {
    const run = this.#tail.then(() => this.#writeNow(key, value));
    this.#tail = run.catch(() => undefined);
    return run;
  }

  async #writeNow(key: PreferenceKey, value: boolean): Promise<Preferences> {
    const current = await this.snapshot();
    // Refused rather than rebuilt. Overwriting here would quietly revert a
    // preference the user set, and report success for it.
    if (current.health === "unreadable") throw new PreferenceStoreError("unreadable");

    const next: Preferences = { ...current.values, [key]: value };
    await mkdir(dirname(this.filePath), { recursive: true });
    // Unique per write, so two writes cannot rename each other's file.
    const staging = `${this.filePath}.${process.pid}.${++stagingSeq}.new`;
    try {
      // Written to a sibling and renamed, so a crash mid-write leaves the
      // previous file intact rather than a truncated one that reads as
      // unreadable — which is now a refusal rather than a silent revert, but is
      // still not a state to leave a user in.
      await writeFile(staging, JSON.stringify(next), "utf8");
      await rename(staging, this.filePath);
    } catch (err) {
      await rm(staging, { force: true }).catch(() => undefined);
      throw err;
    }
    this.#cache = next;
    return next;
  }
}

/**
 * Narrow the file, or refuse it.
 *
 * Tolerant of an ABSENT field — a file written by an older build predates a
 * preference, and the default is genuinely the right answer for one nobody has
 * ever set. Not tolerant of a field of the wrong TYPE, or of a document that is
 * not an object at all: those are a file this build cannot read, and pretending
 * otherwise turns "I do not know what you chose" into "you chose the default".
 *
 * `null` rather than defaults, so the caller can tell the two apart.
 */
function narrow(raw: unknown): Preferences | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const shaped = raw as Record<string, unknown>;
  const verifyPeers = shaped["verifyPeers"];
  if (verifyPeers !== undefined && typeof verifyPeers !== "boolean") return null;
  const firstCloseAcknowledged = shaped["firstCloseAcknowledged"];
  if (firstCloseAcknowledged !== undefined && typeof firstCloseAcknowledged !== "boolean") return null;
  return {
    verifyPeers: verifyPeers ?? DEFAULT_PREFERENCES.verifyPeers,
    firstCloseAcknowledged: firstCloseAcknowledged ?? DEFAULT_PREFERENCES.firstCloseAcknowledged,
  };
}

export const preferencesPath = (dataRoot: string): string => join(dataRoot, "preferences.json");
