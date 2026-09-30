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
/**
 * Where an unreadable map is moved aside before anything new is written.
 *
 * A map that fails to parse may still hold every key this browser ever kept,
 * and each is the ONLY copy of that file's key. Writing a fresh `{id: key}`
 * over it would silently destroy them all; set aside, they can still be
 * recovered by hand. It holds key material too, so logout clears it as well.
 */
const CORRUPT_BACKUP_KEY = STORAGE_KEY + ".corrupt";

type KeyMap = Record<string, string>; // stored-file id → base64url key

/**
 * The current map, and whether it is safe to write a new one over the stored
 * value. `writable` is false only when the stored value is unreadable AND it
 * could not be moved aside — then writing would destroy it.
 */
function readAll(): { map: KeyMap; writable: boolean } {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return { map: {}, writable: true }; // storage disabled — nothing to lose
  }
  if (!raw) return { map: {}, writable: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    // Keep every well-formed entry; drop only the ones that aren't id → string.
    const map: KeyMap = {};
    for (const [id, key] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof key === "string" && key) map[id] = key;
    }
    return { map, writable: true };
  }
  return { map: {}, writable: quarantine(raw) };
}

/** Move an unreadable stored value aside. True when it is safe to overwrite. */
function quarantine(raw: string): boolean {
  try {
    const existing = localStorage.getItem(CORRUPT_BACKUP_KEY);
    if (existing === raw) return true;
    // An earlier, different backup is never replaced: refuse the write instead.
    if (existing !== null) return false;
    localStorage.setItem(CORRUPT_BACKUP_KEY, raw);
    return true;
  } catch {
    return false;
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
  const { map: m, writable } = readAll();
  if (!writable) return; // the link is still shown on the upload page
  m[id] = key;
  writeAll(m);
}

/** The stored key for an upload id, or undefined if this browser never held it. */
export function uploadKey(id: string): string | undefined {
  return readAll().map[id];
}

/** Drop a key (e.g. after the file is deleted), keeping the store from growing
 *  without bound. Missing ids are ignored. */
export function forgetUploadKey(id: string): void {
  const { map: m, writable } = readAll();
  if (writable && id in m) {
    delete m[id];
    writeAll(m);
  }
}

/** Prune keys whose ids are no longer in the server's file list, so a browser
 *  that uploaded many expired files doesn't accumulate dead keys forever. */
export function pruneUploadKeys(liveIds: Iterable<string>): void {
  const live = new Set(liveIds);
  const { map: m, writable } = readAll();
  if (!writable) return;
  let changed = false;
  for (const id of Object.keys(m)) {
    if (!live.has(id)) {
      delete m[id];
      changed = true;
    }
  }
  if (changed) writeAll(m);
}

/**
 * 清空本浏览器保存的全部上传密钥。登出时调用。
 *
 * 每条 id→key 都是一份**完整的能力凭证**：`/d/<id>#k=<key>` 不需要任何会话就能下载。
 * 登出却把它们留在 localStorage 里，等于"退出登录"只退了 UI，实际的文件访问权仍然
 * 躺在这台机器上——共用电脑、二手设备、借人一用的场景下，下一个用户拿到的是你所有
 * 未过期上传的完整链接。
 */
export function forgetAllUploadKeys(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(CORRUPT_BACKUP_KEY);
  } catch {
    /* storage disabled — nothing was persisted either */
  }
}
