// web/src/lib/drag.ts
// Pure logic for window-wide drag-to-send. Kept DOM-free so it is unit-testable.

/** Whether a drag carries files (vs. dragging a page element or selected text).
 *  `types` may be a DOMStringList (real DataTransfer) or a string[] (tests); both
 *  are indexable, so we iterate by index. */
export function hasFiles(
  types: readonly string[] | DOMStringList | undefined,
): boolean {
  if (!types) return false;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === "Files") return true;
  }
  return false;
}

/** Decide what a window-level file drop should do.
 *  - "off":  inactive (a transfer is in progress, or there is no peer) — let the
 *            page's own drop handling (e.g. the stored-upload card) take over.
 *  - "send": exactly one peer — dropping anywhere sends to it.
 *  - "pick": multiple peers — the user must drop onto a specific device card. */
export function dropTarget(
  peerCount: number,
  busy: boolean,
): "off" | "send" | "pick" {
  if (busy || peerCount <= 0) return "off";
  return peerCount === 1 ? "send" : "pick";
}

/** A file plus its relative path within a sent folder (undefined for a flat file). */
export interface PickedFile {
  file: File;
  path?: string;
}

/** Normalize an <input>'s FileList into PickedFiles. `webkitdirectory` (folder
 *  selection) populates webkitRelativePath; a plain multi-file pick leaves it
 *  empty, which we treat as a flat file (no path). */
export function pickedFromInput(files: FileList | File[]): PickedFile[] {
  return Array.from(files).map((file) => {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    return { file, path: rel && rel.includes("/") ? rel : undefined };
  });
}

// Subset of the non-standard FileSystemEntry surface we depend on, narrowed so
// walkEntry can be unit-tested against a synthetic tree without the DOM.
export interface FsEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  fullPath: string;
  file?: (ok: (f: File) => void, err?: (e: unknown) => void) => void;
  createReader?: () => {
    readEntries: (ok: (entries: FsEntryLike[]) => void, err?: (e: unknown) => void) => void;
  };
}

/** Recursively flatten a dropped file/directory entry into PickedFiles, deriving
 *  each relative path from the entry's fullPath. DOM-free (given entry doubles)
 *  so the traversal is testable. */
export async function walkEntry(entry: FsEntryLike): Promise<PickedFile[]> {
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((res, rej) => entry.file!(res, rej));
    // fullPath is like "/dir/sub/a.txt"; a leading segment only counts as a path
    // when it actually nests (a top-level dropped file is "/a.txt" → flat).
    const rel = entry.fullPath.replace(/^\//, "");
    return [{ file, path: rel.includes("/") ? rel : undefined }];
  }
  if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    const out: PickedFile[] = [];
    // readEntries yields at most ~100 entries per call; drain until it's empty.
    for (;;) {
      const batch = await new Promise<FsEntryLike[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const child of batch) out.push(...(await walkEntry(child)));
    }
    return out;
  }
  return [];
}

/** Extract PickedFiles from a drop, recursing into folders where the browser
 *  supports it (Chromium/Firefox via webkitGetAsEntry); otherwise falls back to
 *  the flat FileList. Entries are captured synchronously — the DataTransfer is
 *  neutered once the handler yields — then walked asynchronously. */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<PickedFile[]> {
  const items = dt.items;
  const flat = () => Array.from(dt.files).map((file) => ({ file }) as PickedFile);
  if (!items || !items.length || typeof (items[0] as unknown as { webkitGetAsEntry?: unknown }).webkitGetAsEntry !== "function") {
    return flat();
  }
  const entries: FsEntryLike[] = [];
  for (let i = 0; i < items.length; i++) {
    const e = (items[i] as unknown as { webkitGetAsEntry: () => FsEntryLike | null }).webkitGetAsEntry();
    if (e) entries.push(e);
  }
  if (!entries.length) return flat();
  const out: PickedFile[] = [];
  for (const e of entries) out.push(...(await walkEntry(e)));
  return out;
}
