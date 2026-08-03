// A promise-based confirm dialog. confirmDialog(message) opens a single shared
// <ConfirmModal/> and resolves true/false when the user chooses — an async
// drop-in for window.confirm().
//
// `confirmLabel` overrides the affirmative button's generic "Confirm". It exists
// for one case: an action whose dialog says the opposite of what "Confirm" reads
// as. The account-deletion dialog is named by the question "Delete this Relayium
// account?" but the button only asks for an email, and its own message says
// nothing is removed yet — so a generic affirmative would contradict the sentence
// directly above it. Callers that don't pass one keep the default.
export const confirmState = $state<{ open: boolean; message: string; confirmLabel: string }>({
  open: false,
  message: "",
  confirmLabel: "",
});

let pending: ((ok: boolean) => void) | null = null;

export function confirmDialog(message: string, confirmLabel = ""): Promise<boolean> {
  // If a dialog is already open, resolve it as cancelled first.
  if (pending) { pending(false); pending = null; }
  confirmState.open = true;
  confirmState.message = message;
  // Always assigned, never merely left alone: the state is shared across every
  // caller, so a label from a previous dialog must not survive into a later
  // generic one.
  confirmState.confirmLabel = confirmLabel;
  return new Promise<boolean>((resolve) => { pending = resolve; });
}

export function resolveConfirm(ok: boolean): void {
  confirmState.open = false;
  // The message can contain account-scoped data (the account-deletion dialog
  // includes the signed-in address). A closed shared dialog must not retain it
  // in process memory or hand it to a later mount after the owning view left.
  confirmState.message = "";
  confirmState.confirmLabel = "";
  const p = pending;
  pending = null;
  p?.(ok);
}
