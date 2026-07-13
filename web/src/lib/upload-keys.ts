// Local, per-browser store of the zero-knowledge keys for stored/async uploads.
//
// A stored upload's decryption key lives only in the share link's `#k=` fragment;
// the server never receives it (that's what makes the mode zero-knowledge). So if
// the user loses the link, the file on the server is unrecoverable. To let "My
// Files" surface the link again, we keep a local id→key map in localStorage.
//
// This is deliberately best-effort and device-local: it is NOT a substitute for
// saving the link (a different browser/device won't have it), and it holds real
// key material, so it lives in localStorage only, never on the server.

const STORAGE_KEY = "relayium.uploadKeys.v1";

type KeyMap = Record<string, string>; // stored-file id → base64url key

function readAll(): KeyMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as KeyMap) : {};
  } catch {
    return {}; // storage disabled/full or malformed — behave as if empty
  }
}

function writeAll(m: KeyMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(m));
  } catch {
    /* storage disabled/full — the link is still shown on the upload page */
  }
}

/** Remember the key for a freshly uploaded file so its link can be rebuilt later. */
export function rememberUploadKey(id: string, key: string): void {
  if (!id || !key) return;
  const m = readAll();
  m[id] = key;
  writeAll(m);
}

/** The stored key for an upload id, or undefined if this browser never held it. */
export function uploadKey(id: string): string | undefined {
  return readAll()[id];
}

/** Drop a key (e.g. after the file is deleted), keeping the store from growing
 *  without bound. Missing ids are ignored. */
export function forgetUploadKey(id: string): void {
  const m = readAll();
  if (id in m) {
    delete m[id];
    writeAll(m);
  }
}

/** Prune keys whose ids are no longer in the server's file list, so a browser
 *  that uploaded many expired files doesn't accumulate dead keys forever. */
export function pruneUploadKeys(liveIds: Iterable<string>): void {
  const live = new Set(liveIds);
  const m = readAll();
  let changed = false;
  for (const id of Object.keys(m)) {
    if (!live.has(id)) {
      delete m[id];
      changed = true;
    }
  }
  if (changed) writeAll(m);
}
