// /cli 页里那些**不翻译**的东西：命令名、flag、文件名、指南 slug、锚点 id。
//
// 这一版把整页从"常量数组 × 翻译数组按下标配对"改成了**按键配对**。
//
// 旧模型的问题不是长度——`SameLength` 早就把长度钉住了——而是**顺序**：往
// PICK_MODES 中间插一项，九份语言文件里那之后的每一条解释都会串位，而类型系统
// 一个字都不会说。这一页的内容是产品事实（哪种模式需要账号、哪种能续传），串
// 位不是排版问题，是**说谎**。
//
// 现在每一条数据自带一个 `key`，翻译表是 `Record<Key, …>`：漏一个键、拼错一个
// 键、删掉一条数据都是编译错误，而重排渲染顺序完全不影响文案配对。
//
// `as const` 仍然是必须的：没有它，下面那些 `(typeof X)[number]["key"]` 会退化成
// `string`，Record 就不再约束任何东西。

export const CLI_REPO = "https://github.com/relayium/relayium";
export const LATEST_RELEASE_URL = `${CLI_REPO}/releases/latest`;

/** The POSIX shell installer. macOS and Linux only — it is `sh`, and saying
 *  "your OS" in front of it is how a Windows reader ends up pasting it. */
export const INSTALL_CMD = "curl -fsSL https://relayium.com/install.sh | sh";

// ── Windows ──────────────────────────────────────────────────────────────────
//
// A first-class action, not a footnote pointing at "the releases page". The
// archive names come from .goreleaser.yaml (`relayium_{{ .Os }}_{{ .Arch }}`
// with a zip override for windows), and the URL is GitHub's `latest/download/`
// redirect: it always resolves to the newest published release, so no version
// number is written down here to go stale.
export const WINDOWS_BUILDS = [
  { key: "x64", arch: "amd64", label: "x64", file: "relayium_windows_amd64.zip" },
  { key: "arm64", arch: "arm64", label: "ARM64", file: "relayium_windows_arm64.zip" },
] as const;

export type WindowsBuildKey = (typeof WINDOWS_BUILDS)[number]["key"];

/** Always-latest download URL for a published release asset. */
export const releaseAssetUrl = (file: string) => `${CLI_REPO}/releases/latest/download/${file}`;

// ── Page skeleton ────────────────────────────────────────────────────────────
//
// One list drives the desktop contents rail, the mobile anchor row, and the
// `id` on each landing section. A rail entry pointing at an id nothing renders
// is a link that silently does nothing, so there is exactly one source.
export const SECTIONS = [
  { key: "install", id: "install" },
  { key: "tasks", id: "choose-by-task" },
  { key: "modes", id: "modes" },
  { key: "guides", id: "guides" },
  { key: "reference", id: "command-reference" },
  { key: "security", id: "security" },
  { key: "faq", id: "faq" },
] as const;

export type SectionKey = (typeof SECTIONS)[number]["key"];

// ── The seven modes ──────────────────────────────────────────────────────────
//
// `name` is the command surface, so it is code-native in every language: a
// reader who translates "send / receive" gets a command that does not exist.
//
// `id` is a URL contract. `device-inbox` in particular is what My Devices links
// back to (/cli#device-inbox) and what e2e/device-discovery.mjs opens; renaming
// it breaks an inbound link that is already in the product.
export const CLI_MODES = [
  { key: "cloud", id: "cloud", name: "Cloud", cmd: "relayium up … / relayium down <link>" },
  { key: "inbox", id: "device-inbox", name: "Device Inbox", cmd: "relayium inbox enable --dir ~/inbox" },
  { key: "text", id: "text", name: "text", cmd: "relayium text [code]" },
  { key: "sendReceive", id: "send-receive", name: "send / receive", cmd: "relayium send … / relayium receive <code>" },
  { key: "pushPull", id: "push-pull", name: "push / pull", cmd: "relayium push … user@host:path" },
  { key: "serve", id: "serve", name: "serve", cmd: "relayium serve --dir ~/inbox" },
  { key: "sync", id: "sync", name: "sync", cmd: "relayium sync ./site relayium://host" },
] as const;

export type ModeKey = (typeof CLI_MODES)[number]["key"];

// ── Choose by task ───────────────────────────────────────────────────────────
//
// The taxonomy is connectivity and ownership — can the other end be offline, is
// it someone else's machine or mine — because that is the question a reader
// actually arrives with, and it is decidable from facts rather than from a
// guess about who they are. Every mode appears in exactly one branch, which the
// tests assert: a mode in two branches is a page that cannot answer "which one".
export const TASK_BRANCHES = [
  { key: "offline", modes: ["cloud", "inbox"] },
  { key: "bothOnline", modes: ["text", "sendReceive"] },
  { key: "managed", modes: ["pushPull", "serve", "sync"] },
] as const;

export type TaskKey = (typeof TASK_BRANCHES)[number]["key"];

// ── Modes at a glance ────────────────────────────────────────────────────────
//
// Four columns, each answering one thing the modes genuinely differ on. There
// is deliberately no "resume" column: resume is a `sync` property, and a column
// that has to read "no" six times is a table that exists to be filled in.
export const COMPARE_COLUMNS = ["account", "online", "path", "verify"] as const;

export type CompareColumn = (typeof COMPARE_COLUMNS)[number];

// ── Command reference ────────────────────────────────────────────────────────
//
// `who` is the scope, and it is derived from the binary rather than from the
// previous version of this page. The three that were wrong:
//
//   --config-dir  was "serve / push / sync / id / authorize". The real scope
//                 (server/cmd/relayium/run.go `usage`) also includes login,
//                 logout and every inbox subcommand — i.e. the credential
//                 directory, which is most of why anyone passes it.
//   --verify      was "send / receive". text takes it too, and text is where a
//                 reader is most likely to want it.
//   --port        was "serve, relayium://". push has no --port at all; a
//                 relayium:// port is written into the URL.
//
// --bind, --local-only, --check/--force and --service-user were simply absent,
// so the page's "Common flags" table could not answer the questions an operator
// installing a service actually has.
//
// --advertise is deliberately NOT here. It is advanced (it only works when the
// address really is reachable from the peer), and the binary's own top-level
// table excludes it for that reason — see help_flagscope_test.go's
// TestAdvertiseStaysOutOfTheCommonFlagTable. It is mentioned once, in prose,
// with that condition attached.
export const FLAG_ROWS = [
  { key: "dir", flag: "--dir <d>", who: "serve · inbox enable · inbox service" },
  { key: "bind", flag: "--bind <addr>", who: "serve" },
  { key: "port", flag: "--port <n>", who: "serve" },
  { key: "once", flag: "--once", who: "serve · inbox run" },
  { key: "allowDelete", flag: "--allow-delete", who: "serve" },
  { key: "noResume", flag: "--no-resume", who: "serve · push · pull" },
  { key: "identity", flag: "-i <file>", who: "push · pull · sync" },
  { key: "sshPort", flag: "-p <n>", who: "push · pull · sync" },
  { key: "delete", flag: "--delete", who: "sync" },
  { key: "watch", flag: "--watch", who: "sync" },
  { key: "verify", flag: "--verify", who: "send · receive · text" },
  { key: "yes", flag: "--yes", who: "text" },
  { key: "burn", flag: "--burn", who: "up" },
  { key: "ttl", flag: "--ttl <dur>", who: "up" },
  { key: "maxDownloads", flag: "--max-downloads <n>", who: "up" },
  { key: "server", flag: "--server <url>", who: "login · up · down · send · receive · text" },
  { key: "deviceName", flag: "--device-name <label>", who: "login" },
  { key: "localOnly", flag: "--local-only", who: "logout · inbox disable" },
  { key: "check", flag: "--check", who: "update" },
  { key: "force", flag: "--force", who: "update" },
  { key: "serviceUser", flag: "--service-user <u>", who: "inbox service" },
  { key: "configDir", flag: "--config-dir <d>", who: "push · sync · serve · id · authorize · login · logout · inbox <any>" },
] as const;

export type FlagKey = (typeof FLAG_ROWS)[number]["key"];

/** Local trust material. Descriptions are in `t.cliPage.trustFiles`. */
export const TRUST_FILES = [
  { key: "identity", name: "id.key / id.crt" },
  { key: "knownHosts", name: "known_hosts" },
  { key: "authorized", name: "authorized_fingerprints" },
] as const;

export type TrustFileKey = (typeof TRUST_FILES)[number]["key"];

// ── Guides ───────────────────────────────────────────────────────────────────
//
// The nine CLI guides, and all nine of them. The authority is
// web/scripts/pages/content/cli-articles.mjs (CLI_ARTICLES), which reads the
// slugs off the article documents themselves; cli-page.guides.test.ts asserts
// this list is exactly that set, so a renamed or added article cannot leave the
// hub page linking at a 404 or quietly dropping a guide.
//
// The trailing slash is not cosmetic: the static article pages are directories,
// and /guides/x redirects to /guides/x/ — a link without it spends a redirect
// on every reader and every crawler.
export const GUIDE_GROUPS = [
  { key: "start", guides: ["terminal", "receiveFromCli"] },
  { key: "offline", guides: ["cloudAsync", "deviceInboxServer"] },
  { key: "bothOnline", guides: ["sendToSomeone"] },
  { key: "managed", guides: ["backupSsh", "serverToServer", "syncLargeFolder", "automateBackups"] },
] as const;

export type GuideGroupKey = (typeof GUIDE_GROUPS)[number]["key"];

export const GUIDES = [
  { key: "terminal", slug: "guides/transfer-files-from-terminal" },
  { key: "backupSsh", slug: "guides/back-up-a-server-over-ssh" },
  { key: "sendToSomeone", slug: "guides/send-a-file-to-someone" },
  { key: "serverToServer", slug: "guides/server-to-server-transfers" },
  { key: "syncLargeFolder", slug: "guides/sync-a-large-folder-between-servers" },
  { key: "cloudAsync", slug: "guides/push-to-cloud-pull-on-another-computer" },
  { key: "receiveFromCli", slug: "guides/receive-files-from-the-command-line" },
  { key: "deviceInboxServer", slug: "guides/device-inbox-server" },
  { key: "automateBackups", slug: "how-to/automate-server-backups" },
] as const;

export type GuideKey = (typeof GUIDES)[number]["key"];

/** Guide href, always with the trailing slash the static pages live at. */
export const guidePath = (slug: string, lang: string) =>
  lang === "en" ? `/${slug}/` : `/${lang}/${slug}/`;

// ── FAQ ──────────────────────────────────────────────────────────────────────
export const FAQ_KEYS = ["account", "offline", "resume", "verification"] as const;

export type FaqKey = (typeof FAQ_KEYS)[number];

// ── Command blocks ───────────────────────────────────────────────────────────
//
// Every copyable command on the page, in one list, each with a code-native
// `name`. The name is the block's visible terminal title, the accessible name
// of its scrollable <pre>, AND the distinguishing half of its copy button's
// aria-label — so seventeen buttons that all read "Copy" visually are still
// seventeen distinct names in a screen reader's element list.
//
// Commands are code-native in every language, including their `#` comments: a
// translated command is a command that does not run.
export const COMMAND_BLOCKS = [
  {
    key: "install",
    name: "install · macOS / Linux",
    code: INSTALL_CMD,
  },
  {
    key: "build",
    name: "build from source",
    code: `git clone ${CLI_REPO}.git
cd relayium/server
go build -o relayium ./cmd/relayium`,
  },
  {
    key: "cloudLogin",
    name: "relayium login",
    code: "relayium login   # opens relayium.com/device — enter the code to bind this machine",
  },
  {
    key: "cloudUp",
    name: "relayium up",
    code: `relayium up ./report.pdf
#   → https://relayium.com/d/7fK2p…#k=Xr8s…

# retention (otherwise your account's default applies)
relayium up ./report.pdf --burn              # one download, then gone
relayium up ./report.pdf --ttl 7d            # kept 7 days (your plan sets the cap)
relayium up ./report.pdf --max-downloads 5   # allow 5 downloads`,
  },
  {
    key: "cloudDown",
    name: "relayium down",
    code: `# on another machine — no login needed
relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…' ./dest`,
  },
  {
    key: "inboxUpdate",
    name: "relayium update",
    code: `# on the machine that will RECEIVE
relayium update --check     # is there a newer release?
relayium update             # install it in place
relayium inbox --help       # this build has Device Inbox if this prints`,
  },
  {
    key: "inboxLogin",
    name: "relayium login --device-name",
    code: `relayium login --device-name prod-backup-1
#   → Open https://relayium.com/device and enter code: WDJB-MJHT
#     This machine will appear in My Devices as: prod-backup-1

# omit --device-name and it registers this host's own name`,
  },
  {
    key: "inboxEnable",
    name: "inbox-server-install.sh",
    code: `# Linux server: download, inspect, then install the always-on service
curl -fsSLO https://relayium.com/inbox-server-install.sh
less inbox-server-install.sh
sudo sh inbox-server-install.sh --dir /srv/relayium-inbox

# creates the directory, uses a low-privilege account, starts now + after reboot`,
  },
  {
    key: "inboxService",
    name: "relayium inbox status",
    code: `relayium inbox status   # folder, credential, worker, and server truth

# foreground is for diagnostics or your own container only
relayium inbox run

# advanced/manual definitions: systemd-user, systemd-system, launchd, container
relayium inbox service systemd-system --service-user relayium`,
  },
  {
    key: "textPair",
    name: "relayium text",
    code: `# one machine mints and waits (needs relayium login); the other joins
relayium text
#   → Code: 483920   |   On the other machine:  relayium text 483920

# the other machine joins the printed code — one line per message, Ctrl-D to end
relayium text 483920`,
  },
  {
    key: "textPipe",
    name: "relayium text · exact bytes",
    code: `# exact bytes, including multiline: pipe it — no flag needed
pbpaste | relayium text 483920
cat snippet.py | relayium text 483920

# optional: stop to compare the verification code first (needs a terminal)
relayium text 483920 --verify`,
  },
  {
    key: "sendReceive",
    name: "relayium send / receive",
    code: `# sender (once per machine: relayium login)
relayium send ./file.zip
# prints:  Code: 483920   (valid 5 minutes)
#          On the other machine:  relayium receive 483920

# receiver — no account needed
relayium receive 483920 ./downloads`,
  },
  {
    key: "pushPull",
    name: "relayium push / pull · SSH",
    code: `# push a folder to a server you can SSH into
relayium push ./photos user@host:backups/

# pull it back
relayium pull user@host:backups/ ./restore

# pick an SSH key / port
relayium push -i ~/.ssh/id_ed25519 -p 2222 ./photos user@host:backups/`,
  },
  {
    key: "serveListen",
    name: "relayium serve",
    code: `# on the RECEIVER
relayium serve --dir ~/inbox --bind 127.0.0.1
#   --bind is optional; empty (the default) listens on every interface
#   --once accepts a single transfer; --port changes 9031`,
  },
  {
    key: "servePush",
    name: "relayium push relayium://",
    code: `# on the SENDER
relayium push ./file.zip relayium://receiver.example.com`,
  },
  {
    key: "serveAuthorize",
    name: "relayium authorize",
    code: `# on the RECEIVER, the first push prompts:
Incoming push from 203.0.113.7:54021
  fingerprint: 74318e3b…
Accept and remember this peer? [y/N] y

# no terminal (a systemd service)? pre-authorize instead:
relayium authorize 74318e3b…`,
  },
  {
    key: "sync",
    name: "relayium sync",
    code: `# one-way incremental mirror: unchanged files (same size and mtime) are skipped
relayium sync ./site relayium://receiver.example.com

# --delete mirrors removals too; on a relayium:// listener it only works if that
# listener was started with --allow-delete. --watch keeps it running.
relayium sync ./site relayium://receiver.example.com --delete --watch`,
  },
] as const;

export type CommandKey = (typeof COMMAND_BLOCKS)[number]["key"];

/** The three localized strings a copy control needs. */
export interface CopyStrings {
  label: string;
  copied: string;
  /** A prefix. The command's code-native name is appended to it. */
  aria: string;
}

/**
 * CommandBlock props for one command.
 *
 * The accessible name is `"<localized prefix>: <code-native command name>"`.
 * Seventeen buttons on this page all read "Copy"; without the name appended
 * they would be seventeen identically-named controls in a screen reader's
 * element list, and choosing between them would mean reading the page again.
 */
export const copyProps = (copy: CopyStrings, name: string) => ({
  copyLabel: copy.label,
  copiedLabel: copy.copied,
  copyAria: `${copy.aria}: ${name}`,
});

/** Command blocks by key, so a section names the block it renders instead of
 *  indexing into a list whose order is a layout decision. */
export const COMMANDS = Object.fromEntries(
  COMMAND_BLOCKS.map((b) => [b.key, b]),
) as Record<CommandKey, (typeof COMMAND_BLOCKS)[number]>;
