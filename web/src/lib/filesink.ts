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

/**
 * 下载总量超过这个数，且浏览器没有流式落盘能力时，下载页会先提示再下载。
 *
 * 保守估计，不是实测出来的硬数字：没有 File System Access API 的浏览器
 * （Firefox、Safari、以及所有手机浏览器——iOS 上全是 WebKit）必须把整个文件
 * 攒在内存里才能交给用户，手机标签页在这个量级上已经很容易被系统回收。真实
 * 崩溃点随设备内存、系统和标签页数量浮动，需要真机验证后再调。
 */
export const LARGE_DOWNLOAD_WARN_BYTES = 256 * 1024 * 1024; // 256 MiB

/**
 * 这一批文件在当前浏览器里能不能流式写盘（而不是先攒进内存）。
 *
 * 必须与下面 pickSaveTarget 的分支选择保持一致——它是同一套条件的提前问法，
 * 供下载页在开始下载前判断要不要提示。两者不一致就意味着下载页会在一条其实
 * 能落盘的路径上误报，或者更糟：在内存路径上一声不吭。filesink.test.ts 里有
 * 一条用例真跑 pickSaveTarget 逐个组合比对，专门守这个耦合。
 *
 * 多文件走的是目录选择器那条路：拿到目录句柄后每个文件仍是原生流式写入，同样
 * 不吃内存。所以单文件看 showSaveFilePicker（拿不到则回落到目录选择器），
 * 多文件只看 showDirectoryPicker。
 */
export function canStreamToDisk(fileCount: number): boolean {
  const w = window as unknown as SavePickerWindow;
  if (fileCount === 1 && w.showSaveFilePicker) return true;
  return !!w.showDirectoryPicker;
}

/**
 * 没有流式落盘能力时，把这一批文件交付给用户的内存峰值估算。
 *
 * 两条内存分支的峰值差一倍：
 * - 文件夹（有 path 含 "/"）走 ZipWriter：每个文件先攒 parts[]，close 时 concat
 *   复制一份进 zip 缓冲，finish 再拼出完整 zip —— 整批同时在内存里且被复制过，
 *   峰值约 2× 批次总量。
 * - 扁平批次走 blobSink 逐个下载，真实峰值约等于最大单文件；这里仍按总量算，
 *   偏保守，与下载页的既有口径一致（宁可多提示一次，不要崩了才知道）。
 *
 * 判文件夹的条件必须与 pickSaveTarget 的 ZIP 分支逐字一致，否则这个估算会
 * 系统性偏低。filesink.test.ts 里有一条用例真跑 pickSaveTarget 比对 label。
 */
export function memoryPeakBytes(files: FileMetaLite[], totalBytes: number): number {
  return files.some((f) => f.path && f.path.includes("/")) ? totalBytes * 2 : totalBytes;
}

/**
 * 开始接收/下载这一批文件之前，要不要先提示内存风险。
 *
 * 阈值只有 LARGE_DOWNLOAD_WARN_BYTES 一个，而且它比的是**估算峰值**而不是批次
 * 总量 —— 这样 ZIP 分支的 2× 不需要第二个常量就能被算进去。两个都是没实测过的
 * 估计值，再拆一个只是多一个同样没底的数字。
 */
export function warnsAboutMemory(files: FileMetaLite[], totalBytes: number): boolean {
  if (canStreamToDisk(files.length)) return false;
  return memoryPeakBytes(files, totalBytes) > LARGE_DOWNLOAD_WARN_BYTES;
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
