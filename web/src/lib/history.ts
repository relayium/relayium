// Client-local, best-effort record of recent transfers (this device only —
// never synced, never sent to the server). Purely a convenience log for the
// "recent transfers" panel; corrupt or unavailable storage degrades to an
// empty list rather than throwing.

export const HISTORY_MAX = 20;
const KEY = "relayium.history";

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
