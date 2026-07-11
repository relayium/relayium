import { ZipWriter, safeSegments } from "./zip";

export interface FileSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface FileMetaLite {
  name: string;
  size: number;
  path?: string; // relative path within a sent folder; absent for a flat file
}

/** A destination for a whole batch: hands out one sink per file, in arrival order. */
export interface SaveTarget {
  /** Human-readable description of where files are going (for the UI). */
  label: string;
  file(name: string, size: number, path?: string): Promise<FileSink>;
  /** Finalise the batch (e.g. flush a bundled ZIP). Called once, after the last
   *  file's sink closes. Optional: streaming targets need no finalisation. */
  done?(): Promise<void>;
}

interface SavePickerWindow {
  showSaveFilePicker?: (o: { suggestedName: string }) => Promise<FsFileHandle>;
  showDirectoryPicker?: () => Promise<FsDirHandle>;
}
interface FsFileHandle { createWritable: () => Promise<FsWritable>; }
interface FsDirHandle {
  getFileHandle: (name: string, o: { create: boolean }) => Promise<FsFileHandle>;
  getDirectoryHandle: (name: string, o: { create: boolean }) => Promise<FsDirHandle>;
}
interface FsWritable {
  write: (d: Uint8Array) => Promise<void>;
  close: () => Promise<void>;
}

function nativeSink(writable: FsWritable): FileSink {
  return { write: (c) => writable.write(c), close: () => writable.close() };
}

/** Split a filename into base + extension, keeping the dot with the extension.
 *  A leading dot (dotfile) or no dot means the whole name is the base. */
export function splitExtension(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { base: name, ext: "" };
  return { base: name.slice(0, dot), ext: name.slice(dot) };
}

/** First non-colliding variant of `name` given a `taken` predicate: returns the
 *  name as-is if free, otherwise "base (1).ext", "base (2).ext", … Pure/testable. */
export function nextAvailableName(name: string, taken: (n: string) => boolean): string {
  if (!taken(name)) return name;
  const { base, ext } = splitExtension(name);
  for (let i = 1; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!taken(candidate)) return candidate;
  }
}

// Fallback: buffer in memory, download as a Blob on close. Memory-bound — fine for
// small files on Firefox/Safari, which lack the File System Access API.
function blobSink(name: string): FileSink {
  const parts: Uint8Array[] = [];
  return {
    write: async (chunk) => { parts.push(chunk); },
    close: async () => download(new Blob(parts as BlobPart[]), name),
  };
}

/**
 * Open a save destination for a batch. MUST be called from a user gesture
 * (e.g. a click handler) so the underlying picker is allowed to open.
 *
 * - 1 file + File System Access API → a familiar "Save As" dialog, streamed to disk.
 * - >1 file + API → one directory picker; files stream into the chosen folder.
 * - No API (Firefox/Safari) → in-memory Blob, downloaded per file on completion.
 */
export async function pickSaveTarget(files: FileMetaLite[]): Promise<SaveTarget> {
  const w = window as unknown as SavePickerWindow;

  if (files.length === 1 && w.showSaveFilePicker) {
    // Open the Save As dialog now, while the gesture is live.
    const handle = await w.showSaveFilePicker({ suggestedName: files[0].name });
    const writable = await handle.createWritable();
    const sink = nativeSink(writable);
    let used = false;
    return {
      label: "已选择保存位置",
      file: async () => {
        if (used) throw new Error("single-file target already consumed");
        used = true;
        return sink;
      },
    };
  }

  if (w.showDirectoryPicker) {
    // Grant folder access now; per-file handles afterwards need no further gesture.
    const root = await w.showDirectoryPicker();
    // Never silently clobber: dedupe both against files already on disk and
    // against earlier files in this same batch ("name (1).ext", "name (2).ext", …).
    // Dedup is scoped per destination directory, keyed by full relative path.
    const claimed = new Set<string>();
    const existsInDir = async (d: FsDirHandle, n: string): Promise<boolean> => {
      try {
        await d.getFileHandle(n, { create: false });
        return true;
      } catch {
        return false;
      }
    };
    // Resolve (creating as needed) the nested subdirectory a relative path lives in.
    const dirFor = async (segments: string[]): Promise<FsDirHandle> => {
      let d = root;
      for (const seg of segments) d = await d.getDirectoryHandle(seg, { create: true });
      return d;
    };
    return {
      label: "已选择目标文件夹",
      file: async (name, _size, path) => {
        // safeSegments drops any ".."/absolute components so a hostile peer
        // path can't escape the chosen directory (matches the ZIP sink).
        const segs = safeSegments(path || name);
        const base = segs.pop() ?? name;
        const dir = segs.length ? await dirFor(segs) : root;
        const prefix = segs.join("/");
        const key = (n: string) => (prefix ? `${prefix}/${n}` : n);
        // Resolve claimed-in-batch synchronously, then probe the folder; loop in
        // case a probed variant is itself already on disk.
        let unique = nextAvailableName(base, (n) => claimed.has(key(n)));
        while (await existsInDir(dir, unique)) {
          claimed.add(key(unique)); // force the next candidate past this on-disk name
          unique = nextAvailableName(base, (n) => claimed.has(key(n)));
        }
        claimed.add(key(unique));
        const fh = await dir.getFileHandle(unique, { create: true });
        return nativeSink(await fh.createWritable());
      },
    };
  }

  // No File System Access API (Firefox/Safari). A folder send can't stream to
  // disk here, and per-file downloads would lose the tree, so bundle the batch
  // into one ZIP that preserves paths. Flat batches keep per-file downloads.
  if (files.some((f) => f.path && f.path.includes("/"))) {
    const zip = new ZipWriter();
    const topDir = files.find((f) => f.path?.includes("/"))!.path!.split("/")[0];
    return {
      label: "将打包为 ZIP 下载",
      file: async (name, _size, path) => {
        const parts: Uint8Array[] = [];
        return {
          write: async (c) => { parts.push(c); },
          close: async () => { zip.add(path || name, concat(parts)); },
        };
      },
      done: async () => download(zip.finish(), `${topDir || "relayium"}.zip`),
    };
  }
  return {
    label: "将逐个下载到默认下载目录",
    file: async (name) => blobSink(name),
  };
}

/** Concatenate chunks into one contiguous buffer (the ZIP writer stores whole files). */
function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** Trigger a browser download of a blob under the given filename. */
function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
