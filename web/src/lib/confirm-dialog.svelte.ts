// A promise-based confirm dialog. confirmDialog(message) opens a single shared
// <ConfirmModal/> and resolves true/false when the user chooses — an async
// drop-in for window.confirm().
export const confirmState = $state<{ open: boolean; message: string }>({ open: false, message: "" });

let pending: ((ok: boolean) => void) | null = null;

export function confirmDialog(message: string): Promise<boolean> {
  // If a dialog is already open, resolve it as cancelled first.
  if (pending) { pending(false); pending = null; }
  confirmState.open = true;
  confirmState.message = message;
  return new Promise<boolean>((resolve) => { pending = resolve; });
}

export function resolveConfirm(ok: boolean): void {
  confirmState.open = false;
  const p = pending;
  pending = null;
  p?.(ok);
}
