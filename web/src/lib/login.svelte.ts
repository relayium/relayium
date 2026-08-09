// Shared open-state for the sign-in modal.
//
// The Account trigger button now lives once in the top nav (Nav.svelte) instead
// of as a lonely right-aligned row at the top of each page. But the in-body
// "Sign in" buttons on the cross / offline / me / device-inbox pages still need
// to pop the same modal, so the open flag lives in a module-level rune both the
// nav trigger and those buttons can reach. Account.svelte keeps its `bind:open`
// prop unchanged; Nav binds it to this store via a Svelte 5 function binding.

let open = $state(false);

/** Which half of the modal the opener asked for.
 *
 *  A page that offers BOTH "Sign in" and "Create an account" needs the second
 *  button to actually differ from the first: two controls that open the same
 *  login form make one of them a lie about what it does. The intent is a
 *  request, not state — Account applies it once when the modal opens, and the
 *  user is free to switch panels afterwards. */
export type LoginIntent = "login" | "register";

let intent = $state<LoginIntent>("login");

export function loginOpen(): boolean {
  return open;
}

/** Open or close the modal. `want` is only meaningful when opening. */
export function setLoginOpen(v: boolean, want: LoginIntent = "login"): void {
  if (v) intent = want;
  open = v;
}

/** The panel Account should show for the current open request. */
export function loginIntent(): LoginIntent {
  return intent;
}
