// The LAN installation identity: what lets the rendezvous hub tell "three tabs
// of one browser" apart from "three devices", so a peer is offered one entry per
// device and its request lands on the page the user is actually looking at.
//
// What this is NOT, and must never become:
//
//   - It is not an account, and not derived from one. The code-less LAN room is
//     joined anonymously, and a signed-in tab must not become linkable to a
//     signed-out one.
//   - It is not derived from the IP address, the device name, the user agent or
//     any other hardware/browser fingerprint. Two different people behind one
//     NAT with the same phone model are two devices, and matching names must
//     never merge them.
//   - The seed itself never leaves this device. Only a seeded, rotating,
//     derivative of it is transmitted, so the value another client (or the
//     server) sees is opaque, cannot be turned back into the seed, and does not
//     stay the same forever.
//
// The claim it supports is deliberately narrow: "these connections share this
// origin's storage". Separate profiles, separate browsers, and a web/native pair
// on one physical machine are NOT provably one device and stay separate.

/** Where the local secret lives. Never sent anywhere. */
export const LAN_SEED_KEY = "relayium.lan.seed";

/** The transmitted value rotates once a day. Long enough that a device stays one
 *  device for any realistic session, short enough that the advertised id is not
 *  a durable cross-session handle for anyone observing the room. */
export const LAN_EPOCH_MS = 24 * 60 * 60 * 1000;

const SEED_BYTES = 32; // 64 hex chars
const ID_BYTES = 16; // 32 hex chars — signal.ValidDeviceID's exact shape

const hex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Which 24h window `nowMs` falls in. */
export function lanEpoch(nowMs: number): number {
  return Math.floor(nowMs / LAN_EPOCH_MS);
}

/** The value actually put on the wire: an opaque digest of (local seed, epoch),
 *  truncated to the id length the server accepts. One-way, so neither the server
 *  nor a peer can recover the seed or link two epochs of the same device. */
export async function deriveLanDeviceId(seed: string, epoch: number): Promise<string> {
  const input = new TextEncoder().encode(`relayium-lan-device/1:${seed}:${epoch}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return hex(new Uint8Array(digest).slice(0, ID_BYTES));
}

/** Read this browser profile's seed, minting one on first use. Returns "" when
 *  storage is unreadable/unwritable (private mode, blocked cookies): with no
 *  shared store there is nothing to group, and inventing a per-page value would
 *  advertise a new "device" on every reload. */
function loadSeed(): string {
  try {
    const saved = localStorage.getItem(LAN_SEED_KEY);
    // Only accept the exact shape we write; anything else (truncated, edited,
    // written by something else) is replaced rather than used.
    if (saved && /^[0-9a-f]{64}$/.test(saved)) return saved;
    const seed = hex(crypto.getRandomValues(new Uint8Array(SEED_BYTES)));
    localStorage.setItem(LAN_SEED_KEY, seed);
    // Some privacy/storage implementations fail writes without throwing. Only
    // claim a cross-tab identity after proving this page can read the same seed
    // back; otherwise each page would advertise an unrelated pseudo-device.
    return localStorage.getItem(LAN_SEED_KEY) === seed ? seed : "";
  } catch {
    return "";
  }
}

// Session cache: the derivation is a digest per page load, not per join, and the
// epoch is what invalidates it.
let cached: { epoch: number; id: string } | null = null;

/** This installation's current LAN presence id, or "" when it has none. */
export async function lanDeviceId(now: () => number = Date.now): Promise<string> {
  const epoch = lanEpoch(now());
  if (cached && cached.epoch === epoch) return cached.id;
  const seed = loadSeed();
  const id = seed ? await deriveLanDeviceId(seed, epoch) : "";
  cached = { epoch, id };
  return id;
}

/** Test-only: drop the session cache so a test can simulate a fresh page. */
export function resetLanDeviceIdCache() {
  cached = null;
}
