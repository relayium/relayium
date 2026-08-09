// web/scripts/pages/content/cli-articles.mjs — the CLI guides, as {slug,title}
// pairs for the /cli shell's "CLI guides" block. Kept as its own module (rather
// than a hand-typed list) so a renamed article or retitled guide can't leave a
// dead link on the hub page: the titles come from the article docs themselves.
import cliGettingStarted from "./articles/cli-getting-started.mjs";
import cliBackupSsh from "./articles/cli-backup-server-ssh.mjs";
import cliSendToSomeone from "./articles/cli-send-to-someone.mjs";
import cliServerToServer from "./articles/cli-server-to-server.mjs";
import cliSyncLargeFolder from "./articles/cli-sync-large-folder.mjs";
import cliCloudAsync from "./articles/cli-cloud-async.mjs";
import guidesReceiveFromCli from "./articles/guides-receive-from-cli.mjs";
import howtoAutomateServerBackups from "./articles/howto-automate-server-backups.mjs";
import guidesDeviceInboxServer from "./articles/guides-device-inbox-server.mjs";

const ARTICLES = [
  cliGettingStarted,
  cliBackupSsh,
  cliSendToSomeone,
  cliServerToServer,
  cliSyncLargeFolder,
  cliCloudAsync,
  guidesReceiveFromCli,
  howtoAutomateServerBackups,
  guidesDeviceInboxServer,
];

export const CLI_ARTICLES = ARTICLES.map((a) => ({ slug: a.slug, title: a.langs.en.title }));
