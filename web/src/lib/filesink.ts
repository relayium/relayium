export interface FileSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface FileMetaLite {
  name: string;
  size: number;
}

/** A destination for a whole batch: hands out one sink per file, in arrival order. */
export interface SaveTarget {
  /** Human-readable description of where files are going (for the UI). */
  label: string;
  file(name: string, size: number): Promise<FileSink>;
}

interface SavePickerWindow {
  showSaveFilePicker?: (o: { suggestedName: string }) => Promise<FsFileHandle>;
  showDirectoryPicker?: () => Promise<FsDirHandle>;
}
interface FsFileHandle { createWritable: () => Promise<FsWritable>; }
interface FsDirHandle {
  getFileHandle: (name: string, o: { create: boolean }) => Promise<FsFileHandle>;
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
    close: async () => {
      const blob = new Blob(parts as BlobPart[]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    },
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
    const dir = await w.showDirectoryPicker();
    // Never silently clobber: dedupe both against files already in the folder and
    // against earlier files in this same batch ("name (1).ext", "name (2).ext", …).
    const claimed = new Set<string>();
    const existsInDir = async (n: string): Promise<boolean> => {
      try {
        await dir.getFileHandle(n, { create: false });
        return true;
      } catch {
        return false;
      }
    };
    return {
      label: "已选择目标文件夹",
      file: async (name) => {
        // Resolve claimed-in-batch synchronously, then probe the folder; loop in
        // case a probed variant is itself already on disk.
        let unique = nextAvailableName(name, (n) => claimed.has(n));
        while (await existsInDir(unique)) {
          claimed.add(unique); // force the next candidate past this on-disk name
          unique = nextAvailableName(name, (n) => claimed.has(n));
        }
        claimed.add(unique);
        const fh = await dir.getFileHandle(unique, { create: true });
        return nativeSink(await fh.createWritable());
      },
    };
  }

  // No File System Access API: each file is buffered and downloaded on close.
  return {
    label: "将逐个下载到默认下载目录",
    file: async (name) => blobSink(name),
  };
}
