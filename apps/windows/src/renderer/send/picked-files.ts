// Turning what the user chose into what the protocol sends.
//
// ## No privileged capability is added here, deliberately
//
// `<input type="file">`, `webkitdirectory` and drag-drop all open the NATIVE
// Windows dialogs in Electron, so the UX matches Mac — while the app gains no
// arbitrary-path read channel at all. The renderer never learns a filesystem
// path and never asks main to read one; it gets `File` objects the user handed
// it, and reads them in bounded slices.
//
// That is why there is no `fs` IPC on the send side and none is requested.

import type { PickedFile } from "../../../../../web/src/lib/drag";

/**
 * Files from an `<input>`, with the folder structure preserved.
 *
 * `webkitRelativePath` is what makes a folder send arrive as a folder rather
 * than as a flat pile with colliding names. It is empty for a plain multi-file
 * pick, in which case the name is the whole path.
 */
export function pickedFromInput(input: HTMLInputElement): PickedFile[] {
  const picked = [...(input.files ?? [])].map((file) => ({
    file,
    path: file.webkitRelativePath || file.name,
  }));
  // Cleared so choosing the SAME folder twice in a row fires `change` again.
  // Without it the second pick is silently ignored and the UI looks frozen.
  input.value = "";
  return picked;
}

/**
 * Files from a drop, including dropped folders.
 *
 * `DataTransferItem.webkitGetAsEntry` is the only way to walk a dropped
 * directory; `dataTransfer.files` flattens it to nothing useful. Non-standard,
 * and implemented by Chromium, which is the only engine this renderer runs on.
 */
export async function pickedFromDrop(transfer: DataTransfer | null): Promise<PickedFile[]> {
  if (!transfer) return [];
  const entries = [...transfer.items]
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry !== null);

  if (entries.length === 0) {
    return [...transfer.files].map((file) => ({ file, path: file.name }));
  }
  const out: PickedFile[] = [];
  for (const entry of entries) await walk(entry, "", out);
  return out;
}

/** Bounded by the tree the user dropped. Depth-first, so a folder's files keep
 *  their order relative to each other. */
async function walk(entry: FileSystemEntry, prefix: string, out: PickedFile[]): Promise<void> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) => {
      (entry as FileSystemFileEntry).file(resolve, () => resolve(null));
    });
    if (file) out.push({ file, path });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    // `readEntries` returns a PAGE, not the whole directory, and signals the end
    // with an empty batch. Reading once is the bug that makes a large dropped
    // folder arrive with exactly its first hundred files.
    const batch = await new Promise<FileSystemEntry[]>((resolve) => {
      reader.readEntries(resolve, () => resolve([]));
    });
    if (batch.length === 0) return;
    for (const child of batch) await walk(child, path, out);
  }
}
