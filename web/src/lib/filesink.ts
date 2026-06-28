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
    return {
      label: "已选择目标文件夹",
      file: async (name) => {
        const fh = await dir.getFileHandle(name, { create: true });
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
