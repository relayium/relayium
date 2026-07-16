// Shared open-state for the sign-in modal.
//
// The Account trigger button now lives once in the top nav (Nav.svelte) instead
// of as a lonely right-aligned row at the top of each page. But the in-body
// "Sign in" buttons on the cross / offline / me pages still need to pop the same
// modal, so the open flag lives in a module-level rune both the nav trigger and
// those buttons can reach. Account.svelte keeps its `bind:open` prop unchanged;
// Nav binds it to this store via a Svelte 5 function binding.

let open = $state(false);

export function loginOpen(): boolean {
  return open;
}

export function setLoginOpen(v: boolean): void {
  open = v;
}
