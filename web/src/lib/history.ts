// Client-local, best-effort record of recent transfers (this device only —
// never synced, never sent to the server). Purely a convenience log for the
// "recent transfers" panel; corrupt or unavailable storage degrades to an
// empty list rather than throwing.

export const HISTORY_MAX = 20;
const KEY = "relayium.history";
// Opt-OUT flag rather than an opt-in one: the panel has always recorded, and a
// key that only exists once you've touched the setting keeps the default
// unchanged for everyone who never opens it.
const OFF_KEY = "relayium.history.off";

export type HistEntry = {
  id: string;
  name: string;
  size: number;
  direction: "send" | "recv";
  peer: string;
  at: number;
};

function randId(): string {
  return (globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2));
}

/** Whether transfers are recorded at all. Storage being unreadable (private
 *  mode, blocked cookies) must not silently turn recording OFF — that would be
 *  a surprising loss of a feature — so it degrades to the default: on. */
export function historyEnabled(): boolean {
  try {
    return localStorage.getItem(OFF_KEY) !== "1";
  } catch {
    return true;
  }
}

/** Turn recording on or off. Turning it OFF also drops what is already stored:
 *  "don't keep transfer history" that leaves yesterday's filenames and peer
 *  names sitting in localStorage would not be the setting it claims to be. */
export function setHistoryEnabled(on: boolean): void {
  try {
    if (on) localStorage.removeItem(OFF_KEY);
    else localStorage.setItem(OFF_KEY, "1");
  } catch {
    /* best-effort: quota / private mode */
  }
  if (!on) clearHistory();
}

export function loadHistory(): HistEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HistEntry[]) : [];
  } catch {
    return [];
  }
}

export function recordTransfer(e: Omit<HistEntry, "id" | "at">): void {
  if (!historyEnabled()) return;
  try {
    const entry: HistEntry = { ...e, id: randId(), at: Date.now() };
    const next = [entry, ...loadHistory()].slice(0, HISTORY_MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* best-effort: quota / private mode */
  }
}

export function clearHistory(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
