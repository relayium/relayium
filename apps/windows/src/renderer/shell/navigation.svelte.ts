// Which page is on screen.
//
// ## In memory. No URL, no history, no hash.
//
// Two reasons, and the second is the one that would actually bite. First, this
// is a desktop app: a sidebar selection is not an address, and there is no back
// button, no bookmark and nothing to share. Second, main revokes everything it
// holds for a document when that document is replaced — sockets, in-flight ICE
// reads, receive leases. `IpcRouter` now excludes same-document navigations, so
// a hash route would no longer cancel a transfer, but routing by URL would still
// put the app one ordinary mistake (a real navigation rather than a
// `pushState`) away from tearing down a live transfer because the user clicked
// a sidebar row.
//
// So selection is a variable.

/** The five browseable rows, in sidebar order. Mirrors `AppDestination` in
 *  RelayiumKit minus `storedReceive`, which macOS also routes only by link. */
export type Page = "lan" | "pair" | "stored" | "inbox" | "account";

export const PAGES: readonly Page[] = ["lan", "pair", "stored", "inbox", "account"];

let current = $state<Page>("lan");

export const page = (): Page => current;

export function goTo(next: Page): void {
  current = next;
}
