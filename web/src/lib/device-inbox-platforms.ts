// The /device-inbox page's **locale-invariant** half: which platforms the page
// names, what each one's honest status is, and the literal commands it may show.
//
// It lives outside the component (and outside the i18n tables) for the same
// reason cli-page-data.ts does: a shell command is not prose. It must be byte
// identical in all nine languages, and a status badge must come from one place
// rather than from nine translations that can drift apart. Only the surrounding
// explanation is translated — see `deviceInboxPage.platforms` in i18n/types.ts,
// which is keyed by the ids below, so a new platform is a compile error in every
// locale until it is written.
//
// **The rule this file exists to enforce (PRD §12 "一级产品入口"): a platform whose
// native receiver does not exist gets no native command or button.** A separately
// shipped CLI/Web alternative may appear only with its limitation in the same
// section, whether the native status is testing or planned. iPhone and Android
// therefore have no command at all; macOS shows the launchd CLI while the native
// build is in testing, and Windows shows only the verified foreground CLI.

/** Honest release status of a platform's Device Inbox *receiver*.
 *
 *  - `available` — you can install it today and it survives what its section
 *    promises it survives.
 *  - `testing` — the code exists and is being exercised, but it is not something
 *    a user can install from this page. No download CTA.
 *  - `planned` — the native receiver is not shipped. The section explains the
 *    plan and may point at a distinct, explicitly limited CLI/Web path that
 *    works today. */
export type PlatformStatus = "available" | "testing" | "planned";

export type InboxPlatformId = "server" | "macos" | "iphone" | "windows" | "android" | "linux";

export interface InboxPlatform {
  id: InboxPlatformId;
  status: PlatformStatus;
  /** Decorative only (aria-hidden at the call site). */
  glyph: string;
  /** The literal setup commands, or `null` when this platform has no receiver a
   *  reader could run today. A non-available native app may only have commands
   *  when they belong to a separately shipped CLI alternative whose limitation
   *  is stated in the same section. */
  setup: string | null;
  /** Terminal title for the setup block. `null` iff `setup` is `null`. */
  setupTitle: string | null;
  /** Literal status / pause / stop commands, or `null` when there is no resident
   *  receiver to control. */
  control: string | null;
  controlTitle: string | null;
}

/** Where the published Linux server installer lives. Same origin as the page,
 *  so it is inspectable before it is run. */
export const SERVER_INSTALL_URL = "https://relayium.com/inbox-server-install.sh";

/** Slug of the full hosted server guide (localized twins exist for all nine
 *  languages, so this one is language-prefixed at the call site). */
export const SERVER_GUIDE_SLUG = "guides/device-inbox-server/";

// Server. Every line below is the installer's own documented contract
// (web/public/inbox-server-install.sh) — download, inspect, then install; the
// script creates /srv/relayium-inbox, a dedicated low-privilege `relayium`
// account and a hardened systemd-system unit that starts now and after reboot.
// `inbox run` is deliberately absent from the primary path: in an SSH window it
// dies with the window (WORKFLOW-LEARNINGS, "A foreground command is not an
// always-on server product").
const SERVER_SETUP = `# 1. sign in once, as yourself, and label this machine
relayium login --device-name prod-backup-1

# 2. download the installer and READ it before it gets root
curl -fsSLO https://relayium.com/inbox-server-install.sh
less inbox-server-install.sh

# 3. install the always-on service
sudo sh inbox-server-install.sh --dir /srv/relayium-inbox`;

const SERVER_CONTROL = `sudo systemctl status relayium-inbox.service     # running? enabled at boot?
sudo journalctl -u relayium-inbox.service -f    # live logs

# Relayium's own truth: folder, credential, worker, server
sudo -u relayium relayium inbox status --config-dir /var/lib/relayium-inbox/config

# stop receiving for a while, then continue
sudo -u relayium relayium inbox pause  --config-dir /var/lib/relayium-inbox/config
sudo -u relayium relayium inbox resume --config-dir /var/lib/relayium-inbox/config

# stop the process only
sudo systemctl disable --now relayium-inbox.service
# revoke the inbox and delete its private keys
sudo -u relayium relayium inbox disable --config-dir /var/lib/relayium-inbox/config`;

// Linux desktop. A personal machine, a personal directory, and systemd --user —
// which is NOT the unattended server deployment: without linger it stops when
// you log out. The command set is `relayium inbox service systemd-user`'s own
// printed instructions (server/internal/inboxclient/deploy/deploy.go).
const LINUX_SETUP = `relayium login --device-name my-desktop
relayium inbox enable --dir ~/Relayium-inbox

# print a unit for THIS machine, then follow the steps it prints
relayium inbox service systemd-user`;

const LINUX_CONTROL = `systemctl --user status relayium-inbox.service
journalctl --user -u relayium-inbox.service -f
relayium inbox status

# a user service stops when you log out — unless linger is on (needs root)
sudo loginctl enable-linger "$USER"

systemctl --user disable --now relayium-inbox.service   # stop the process
relayium inbox disable                                  # revoke inbox + keys`;

// macOS. This section sets up the CLI receiver supervised by launchd, because
// that is the one that runs unattended on any Mac whether or not the native app
// is installed. `relayium inbox service launchd` prints the agent and its exact
// commands.
//
// It used to say the native app's Device Inbox was an engineering build. That
// stopped being true when macos-v1.0 was published, and it was never the real
// reason for this choice — an unattended launchd agent is. Whether the page
// offers the app as a download is a separate switch, read from
// native-releases.json by DeviceInboxPage.svelte's `macDownloadable`.
const MACOS_SETUP = `relayium login --device-name my-mac
relayium inbox enable --dir ~/Relayium-inbox

# print a launchd agent for THIS Mac, then follow the steps it prints
relayium inbox service launchd`;

const MACOS_CONTROL = `relayium inbox status
tail -f ~/.config/relayium/logs/relayium-inbox.log \\
        ~/.config/relayium/logs/relayium-inbox.err.log

launchctl bootout gui/$(id -u)/com.relayium.inbox   # stop the agent
relayium inbox disable                              # revoke inbox + keys`;

// Windows. There is no Windows service, no startup entry and no tray app: the
// only thing this repository ships for Windows is the same binary run in the
// foreground. Saying so — including that closing the window ends it — is the
// whole content of this section's honesty.
const WINDOWS_SETUP = `relayium login --device-name my-pc
relayium inbox enable --dir %USERPROFILE%\\Relayium-inbox

# foreground only: this receives while the window stays open
relayium inbox run`;

const WINDOWS_CONTROL = `relayium inbox status
relayium inbox pause      # stop accepting new tasks
relayium inbox resume
relayium inbox disable    # revoke the inbox and delete its private keys`;

/** The six platform sections, in the order the page renders them: what works
 *  today first, then the engineering build, then the three planned clients. */
export const INBOX_PLATFORMS: readonly InboxPlatform[] = [
  {
    id: "server",
    status: "available",
    glyph: "🖥️",
    setup: SERVER_SETUP,
    setupTitle: "linux server · install the always-on receiver",
    control: SERVER_CONTROL,
    controlTitle: "linux server · status, logs, pause, stop",
  },
  {
    id: "linux",
    status: "available",
    glyph: "🐧",
    setup: LINUX_SETUP,
    setupTitle: "linux desktop · systemd --user",
    control: LINUX_CONTROL,
    controlTitle: "linux desktop · status, logout behaviour, stop",
  },
  {
    id: "macos",
    status: "testing",
    glyph: "💻",
    setup: MACOS_SETUP,
    setupTitle: "macOS · CLI receiver under launchd",
    control: MACOS_CONTROL,
    controlTitle: "macOS · status, logs, stop",
  },
  {
    id: "windows",
    status: "planned",
    glyph: "🪟",
    // Windows has no resident receiver, but it DOES have a verified foreground
    // one. It is shown with its limit stated in the same breath; that is why
    // this planned platform is the one exception with a non-null `setup`.
    setup: WINDOWS_SETUP,
    setupTitle: "windows · foreground receiver (terminal must stay open)",
    control: WINDOWS_CONTROL,
    controlTitle: "windows · status, pause, disable",
  },
  {
    id: "iphone",
    status: "planned",
    glyph: "📱",
    setup: null,
    setupTitle: null,
    control: null,
    controlTitle: null,
  },
  {
    id: "android",
    status: "planned",
    glyph: "🤖",
    setup: null,
    setupTitle: null,
    control: null,
    controlTitle: null,
  },
] as const;

/** Every platform the page must name, as required by the PRD. Exported so a test
 *  can assert the set rather than trusting the array literal above to stay whole. */
export const REQUIRED_PLATFORM_IDS: readonly InboxPlatformId[] = [
  "server",
  "macos",
  "iphone",
  "windows",
  "android",
  "linux",
];

/** What the signed-in visitor should be told to do next.
 *
 *  `unknown` is a first-class outcome and is why this is a function rather than
 *  a boolean: `/api/devices` failing must never be rendered as "no devices" or
 *  as "ready". A network error is an absence of knowledge, and the page has to
 *  say that instead of inventing either answer. */
export type StartState = "checking" | "unknown" | "none" | "no-inbox" | "ready";

export interface DeviceCensus {
  /** Devices signed in to this account (CLI or app). */
  total: number;
  /** Of those, how many have actually enrolled a Device Inbox. */
  withInbox: number;
}

export function startState(
  loaded: boolean,
  failed: boolean,
  census: DeviceCensus,
): StartState {
  if (failed) return "unknown";
  if (!loaded) return "checking";
  if (census.withInbox > 0) return "ready";
  if (census.total > 0) return "no-inbox";
  return "none";
}
