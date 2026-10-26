import { filesFromDataTransfer, type PickedFile } from "./drag";

/** Identity and admission of the visible LAN workspace, read again after a
 * folder walk. A roster's first peer is never a substitute for the linked peer. */
export interface FileDropWorkspace {
  peerId: string;
  generation: number;
  epoch: number;
}

export async function dropWorkspaceFiles(
  transfer: DataTransfer,
  current: () => FileDropWorkspace | null,
  send: (peerId: string, files: PickedFile[]) => void,
  refused: (reason: "changed" | "unreadable") => void,
): Promise<void> {
  const target = current();
  if (!target) return;
  let files: PickedFile[];
  try {
    // Captures DataTransfer entries synchronously, before the event expires.
    files = await filesFromDataTransfer(transfer);
  } catch {
    refused("unreadable");
    return;
  }
  const now = current();
  if (!now || now.peerId !== target.peerId || now.generation !== target.generation
    || now.epoch !== target.epoch) {
    refused("changed");
    return;
  }
  if (!files.length) { refused("unreadable"); return; }
  send(target.peerId, files);
}
