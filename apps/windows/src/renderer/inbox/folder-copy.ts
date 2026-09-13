/**
 * Which folder problem the Inbox is reporting, in words.
 *
 * Three situations with three different fixes, which used to be one sentence:
 * reconnect the drive or choose again; move whatever file is sitting at the
 * path; free space or fix permissions. The probe behind them merged all three
 * into a boolean, and the third could not occur at all because writability was
 * never checked.
 *
 * Total with a `never` guard, so a fourth problem cannot inherit somebody
 * else's sentence — which is exactly how "not there" came to be shown for a
 * folder that was right where the user left it.
 */

import type { FolderProblem } from "../../shared/ipc-contract.js";
import type { MessageKey } from "../i18n/messages.js";

export interface FolderCopy {
  readonly title: MessageKey;
  readonly body: MessageKey;
}

export function folderProblemCopy(problem: FolderProblem): FolderCopy {
  switch (problem) {
    case "missing":
      return { title: "inboxFolderMissingTitle", body: "inboxFolderMissingBody" };
    case "not-a-directory":
      return { title: "inboxFolderNotDirTitle", body: "inboxFolderNotDirBody" };
    case "not-writable":
      return { title: "inboxFolderNotWritableTitle", body: "inboxFolderNotWritableBody" };
    default: {
      const unhandled: never = problem;
      void unhandled;
      // The vaguest of the three, deliberately: a problem this build cannot
      // name should not claim the folder is missing, because that is a
      // specific statement about the user's disk.
      return { title: "inboxFolderNotWritableTitle", body: "inboxFolderNotWritableBody" };
    }
  }
}
