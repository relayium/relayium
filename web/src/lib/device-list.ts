// The account's device list, as both /me and /device-inbox need it.
//
// Two surfaces now render the same rows for two different reasons — /me manages
// the credentials, /device-inbox sends to them — and the rules about WHICH rows
// exist and in WHAT order are product rules, not per-page choices. They live
// here so the two pages cannot answer them differently: a device that /me shows
// and /device-inbox silently drops would be a device the owner is told they can
// revoke but not send to, with no sentence anywhere explaining the difference.
//
// Everything here is pure. Fetching, polling and rendering stay in the pages and
// components that own them.
import { parseDeviceInbox, sendAvailability } from "./device-inbox";
import { deviceSuffix } from "./device-identity";
import type { DeviceCensus } from "./device-inbox-platforms";
import type { Messages } from "./i18n/types";

/** One `/api/devices` row.
 *
 *  `Inbox` is the additive Device Inbox subtree (protocol §9) and stays
 *  `unknown` on purpose: exactly one place parses it — `parseDeviceInbox` —
 *  and a second, looser reading of it here is how "revoked" would become
 *  "ready" on one page and not the other. */
export interface DeviceRow {
  ID: string;
  Name: string;
  CreatedAt: number;
  LastSeenAt: number;
  LastIP?: string;
  Kind: string;
  Inbox?: unknown;
}

/** The device kinds this account list is about, each with its own row badge.
 *
 *  Only these two: both hold a bearer token that can act for the account (CLI
 *  through `relayium login`, App through the native sign-in), so revoking either
 *  means the same sentence, and either can enrol a Device Inbox.
 *
 *  The browser kind is deliberately absent — it enrols itself locally and holds
 *  a session cookie rather than a token anyone could carry away — and so is any
 *  kind a future server invents, because this build cannot say what revoking or
 *  sending to it would mean.
 *
 *  A `Map`, not an object literal: `Kind` is a server-provided string, and
 *  `kinds["toString"]` on a plain object walks up to `Object.prototype` — which
 *  would wave through an unknown kind AND render a built-in function as its
 *  badge. A Map only has its own keys. */
const DEVICE_KIND_LABELS = new Map<string, (t: Messages) => string>([
  ["app", (t) => t.me.deviceKindApp],
  ["cli", (t) => t.me.deviceKindCli],
]);

/** The kinds above, as a plain list, for tests and for anything that needs to
 *  state the set rather than probe it. */
export const SUPPORTED_DEVICE_KINDS: readonly string[] = [...DEVICE_KIND_LABELS.keys()];

export function isSupportedDeviceKind(kind: unknown): boolean {
  return typeof kind === "string" && DEVICE_KIND_LABELS.has(kind);
}

/** The localized "App"/"CLI" badge, or `""` for a kind with no badge — which
 *  cannot reach a rendered row, because such rows are filtered out above. */
export function deviceKindLabel(kind: string, t: Messages): string {
  return DEVICE_KIND_LABELS.get(kind)?.(t) ?? "";
}

// ── The three sentences that identify a row ────────────────────────────────
//
// Shared rather than owned by the list component, because /me needs the very
// same three OUTSIDE a row: its revoke confirmation names the device by kind, id
// fragment and sign-in time, since a name alone cannot tell two machines apart —
// before anyone renames them they are all called "CLI". A confirmation that
// described the row differently from the row itself would be the one place that
// mismatch could delete the wrong credential.

/** Last used. `0` is not "never" in the alarming sense — a credential approved a
 *  minute ago has simply not been used yet, and saying so is the truth. */
export function deviceLastUsedText(d: DeviceRow, t: Messages, locale: string): string {
  if (!d.LastSeenAt) return t.me.deviceNotUsedSinceSignIn;
  return t.me.deviceLastUsed(new Date(d.LastSeenAt * 1000).toLocaleString(locale));
}

/** When this credential was approved. */
export function deviceSignedInText(d: DeviceRow, t: Messages, locale: string): string {
  return t.me.deviceSignedIn(new Date(d.CreatedAt * 1000).toLocaleString(locale));
}

/** The short id suffix, or `""` when the id is too short to shorten — in which
 *  case the caller renders nothing rather than an empty badge. */
export function deviceRefText(d: DeviceRow, t: Messages): string {
  const suffix = deviceSuffix(d.ID);
  return suffix ? t.me.deviceRef(suffix) : "";
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Coerce one raw row into the shape the cards assume.
 *
 *  Not paranoia about our own server: it is what stops a missing `CreatedAt`
 *  from reaching `new Date(undefined * 1000).toLocaleString()` and printing
 *  "Invalid Date" where a sign-in time belongs. `Inbox` is passed through
 *  untouched — `parseDeviceInbox` is its one reader. */
function normalizeRow(raw: unknown): DeviceRow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.ID);
  if (!id) return null; // a row with no identity cannot be revoked or sent to
  const row: DeviceRow = {
    ID: id,
    Name: str(r.Name),
    CreatedAt: num(r.CreatedAt),
    LastSeenAt: num(r.LastSeenAt),
    Kind: str(r.Kind),
    Inbox: r.Inbox,
  };
  if (typeof r.LastIP === "string") row.LastIP = r.LastIP;
  return row;
}

/** The rows an account page may render, most recently used first.
 *
 *  One ordering promise across both pages: "the one you used last is at the
 *  top". Grouping by kind would break it, and rows that have never been used
 *  (`LastSeenAt === 0`) fall back to newest-approved-first rather than to an
 *  arbitrary order. */
export function supportedDevices(rows: readonly unknown[]): DeviceRow[] {
  return rows
    .map(normalizeRow)
    .filter((d): d is DeviceRow => d !== null && isSupportedDeviceKind(d.Kind))
    .sort((a, b) => b.LastSeenAt - a.LastSeenAt || b.CreatedAt - a.CreatedAt);
}

/** How many devices this account has, and how many could actually be sent to.
 *
 *  `withInbox` is decided by `sendAvailability` — the same function the send
 *  control itself uses — rather than by a looser "has an Inbox subtree" rule
 *  that would count a revoked or key-less device as a ready target. */
export function censusOf(devices: readonly DeviceRow[]): DeviceCensus {
  return {
    total: devices.length,
    withInbox: devices.filter((d) => sendAvailability(d.ID, parseDeviceInbox(d.Inbox)).sendable).length,
  };
}

/** Is this row a Device Inbox target the send controls will offer? */
export function isSendable(d: DeviceRow): boolean {
  return sendAvailability(d.ID, parseDeviceInbox(d.Inbox)).sendable;
}
