// Which title the save-destination dialog asks with.
//
// ## Why it is not in `l10n.ts`
//
// It was, and the dead-copy pin refused it: that pin excludes the catalogue
// file from its own haystack — a key referenced only where it is defined has
// no reader — so a chooser living beside the catalogue made
// `native.download.pickTitleBurn` look dead. The pin was right. A key is read
// when some SURFACE asks for it, and the surface here is the picker.
//
// ## Why it is a function at all
//
// The call site is the `dialog.showOpenDialog` branch in `handlers.ts`, which
// composition replaces with a test seam, so the choice itself sits on a path no
// unit test can execute. Extracted, it is callable — not because a boolean can
// drift, but because a user-facing decision nothing can run is a decision
// nobody has checked.

import type { CountedMessageKey } from "./l10n.js";

/**
 * A burn-after-read link is spent by saving it.
 *
 * The server deletes the object after one successful GET, so the link stops
 * working for everybody — including the person who just used it. macOS says so
 * on its facts screen (`download.burnNotice`); Windows has no facts screen, and
 * this dialog is the last moment anyone could be told.
 */
export function downloadPickTitleKey(burnAfterRead: boolean): CountedMessageKey {
  return burnAfterRead ? "native.download.pickTitleBurn" : "native.download.pickTitle";
}
