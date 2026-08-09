// web/scripts/pages/content/spa-pages.mjs — English copy for the SPA routes
// that have no localized static twin: /pricing, /cli and /device-inbox. All are
// public pages (the router calls /pricing "public marketing"), all were
// invisible to any crawler that doesn't run JavaScript, and none was in the
// sitemap before it was added here.
//
// Same doc shape as the mode pages (cross-network.mjs et al.) so shells.mjs can
// render all of them through one prose renderer. Copy mirrors
// src/lib/i18n/en.ts (pricingPage.* / cliPage.*) so the crawlable text and the
// rendered app say the same thing — deliberately with NO prices in it, because
// the plan tiers come from the billing API at runtime and a number hardcoded
// here would be the next "1,000 vs 10" to go stale.

export const pricing = {
  // title/description mirror pageMeta()'s pricing branch exactly (pricingPage
  // title + " · Relayium", and pricingPage.subtitle) — see the note in shells.mjs.
  title: "Simple, honest pricing · Relayium",
  description:
    "Same-network file and live-text transfers are always free. Cross-network browser relay and cloud storage run on a monthly allowance — every account gets one, and paid plans raise it. You can also stay 100% free by running your own node.",
  hero: {
    h1: "Simple, honest pricing",
    pitch:
      "Same-network file and live-text transfers are always free. Cross-network browser relay and cloud storage run on a monthly allowance — every account gets one, and paid plans raise it. You can also stay 100% free by running your own node.",
    cta: "See the plans",
  },
  how: {
    heading: "Always free",
    steps: [
      "Local network (LAN) transfers — instant, no account needed.",
      "Direct peer-to-peer CLI transfers — files over your own SSH, daemon-direct, or a pairing code, plus ephemeral text by pairing code — with nothing metered. Minting a send or text code needs an account; joining one never does.",
      "End-to-end encrypted: files have no size limit, while live text needs both ends online and leaves no message bodies or server-side history on Relayium servers — each device can still copy or keep what it receives. On direct paths, your files and messages go straight between devices — they never touch our servers.",
    ],
  },
  why: {
    heading: "What you pay for",
    items: [
      {
        title: "Relay bandwidth",
        desc: "Cross-network file or text transfers in the browser can run through an encrypted relay, so they connect through strict firewalls and NATs. Every account gets a free monthly allowance; paid plans raise it. This uses real bandwidth.",
      },
      {
        title: "Temporary cloud storage",
        desc: "Send to someone who's offline; we hold the encrypted file until they download it, then it's deleted.",
      },
      {
        title: "Higher limits",
        desc: "More storage, more monthly traffic, and longer retention as you move up tiers.",
      },
      {
        title: "No ads, no data selling",
        desc: "Relay bandwidth and cloud storage are our only real costs, so that's all paid plans fund. It keeps Relayium sustainable and independent.",
      },
    ],
  },
  compare: {
    heading: "Want 100% free? Run your own node",
    items: [
      {
        title: "Bring your own node",
        body: "Relayium is open source. Spin up your own relay + storage node on any machine you control — a VPS, a home server, an old laptop — with a single install command. Your transfers route through your own infrastructure, with no usage limits and nothing to pay. You bring the bandwidth; we provide the software.",
      },
    ],
  },
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Is it really free?",
        a: "Yes. Same-network file or live-text transfers and direct CLI transfers are end-to-end encrypted and completely free — you don't even need an account to receive a file or join a text session. Files are unlimited in size; ephemeral text requires both devices online, and Relayium servers keep no message bodies or server-side history — though each device can copy or keep the text it receives. Cross-network browser relay and cloud storage draw on a monthly allowance that every account gets, Free included; you pay only when you need more.",
      },
      {
        q: "What's the difference between direct and relayed transfers?",
        a: "A direct transfer sends files or live text straight from one device to the other — fastest, and free; that's how same-network browser transfers and the CLI work. Cross-network browser transfers can go through an encrypted relay so they connect reliably through strict firewalls and NATs — the relay only ever carries ciphertext, and the bandwidth it uses is what your monthly allowance and paid plans cover.",
      },
      {
        q: "Why is there a paid tier at all?",
        a: "Relay bandwidth and cloud storage cost real money. Rather than run ads or sell data, we charge for exactly those costs, so the project stays sustainable and independent. Anything that's free for us to run stays free for you.",
      },
      {
        q: "Can I avoid paying entirely?",
        a: "Yes — run your own node. Because Relayium is open source, you can host your own relay and storage on hardware you control and route every transfer through it, with no limits and no fees. Add one from your account page.",
      },
      {
        q: "Can I change plans later?",
        a: "Anytime. Upgrades apply immediately (prorated); downgrades take effect at the end of your current billing period, and you can cancel a pending downgrade whenever you like — no refunds or surprise charges.",
      },
      {
        q: "How does billing and cancellation work?",
        a: "Payments are handled securely by Stripe. Cancel anytime from Manage billing; your plan stays active until the end of the paid period, then reverts to Free.",
      },
    ],
  },
  learnHeading: "Learn more",
};

export const cli = {
  // title/description mirror cliPage.metaTitle / metaDesc exactly — see the note
  // on `pricing` above.
  title: "Relayium CLI — encrypted file and text transfer from the terminal",
  description:
    "A single binary for macOS, Linux and Windows: copy files over your own SSH, send by pairing code, push server-to-server, mirror a folder, share ephemeral text, or upload now and pull later. Free and open source.",
  hero: {
    h1: "Relayium CLI",
    pitch:
      "Free peer-to-peer, end-to-end encrypted, self-hostable. In push/pull, send/receive, text and daemon-direct, your data goes straight between machines and never touches Relayium's servers — only a tiny rendezvous handshake does, and only for send/receive and text. The exception is cloud up/down, which stores your file end-to-end encrypted so another machine can fetch it later.",
    cta: "Install the CLI",
  },
  how: {
    heading: "Install",
    steps: [
      "One command downloads a prebuilt binary for your OS and puts it on your PATH: curl -fsSL https://relayium.com/install.sh | sh",
      "Prefer to pick it yourself, or on Windows? Download a prebuilt binary from the releases page.",
      "Or build from source with Go.",
      "Then run relayium --help to see every command.",
    ],
  },
  why: {
    heading: "Which mode?",
    items: [
      {
        title: "push / pull — over your own SSH",
        desc: "Copy files to (or from) any machine you can already ssh into — a VPS, a home server, a workstation. Bytes travel over your SSH connection and never touch Relayium's servers; you need no account.",
      },
      {
        title: "send / receive — by pairing code",
        desc: "Send to another person across networks. After relayium login, run send with no code: the CLI mints a 6-digit pairing code, good for 5 minutes, and prints the command the other end runs — you pass that on out of band. The receiver needs no account. The connection is direct peer-to-peer: only a small rendezvous handshake passes through Relayium — the file bytes never do. Both terminals also print a 6-digit verification code (SAS) derived from their pinned TLS certificate fingerprints — a different value from the pairing code. Comparing it out of band is optional (add --verify to stop for it) and confirms the fingerprints were not substituted and that the rendezvous service did not impersonate either endpoint; it authenticates the endpoints, not every network hop, and only when someone actually compares it.",
      },
      {
        title: "text — ephemeral messages",
        desc: "Share a snippet, a link or a command instead of a file. One machine runs relayium text to mint a pairing code — that side needs relayium login — and the other joins with the printed relayium text CODE, which needs no login. Both ends stay online for the session: it is its own end-to-end encrypted peer-to-peer session, Relayium servers keep no message bodies and no server-side history — the machine on the other end can of course copy or keep what it receives — and one message is at most 65,536 bytes of UTF-8. Anything larger is a file.",
      },
      {
        title: "daemon direct — server to server",
        desc: "For two hosts you control that already know each other's address: one listens, the other pushes straight to it over pinned TLS 1.3. No relay, no SSH, no code — trust is public-key, set up once.",
      },
      {
        title: "sync — keep a folder mirrored",
        desc: "Incremental one-way folder mirroring instead of a one-shot copy, with optional --delete and --watch.",
      },
      {
        title: "up / down — the far end is offline",
        desc: "Upload now, pull it from another machine later. The file is end-to-end encrypted and the link is the same zero-knowledge link the browser app makes, so the CLI and the web app interoperate.",
      },
    ],
  },
  compare: {
    heading: "Integrity, resume and trust",
    items: [
      {
        title: "Verified and resumable",
        body: "Every file is verified end-to-end with SHA-256, and an interrupted transfer resumes from where it stopped on the next run (disable with --no-resume).",
      },
      {
        title: "Identity files",
        body: "Identity and trust live in ~/.config/relayium/ (override with --config-dir, e.g. /etc/relayium for a systemd service): this host's persistent key, the fingerprints of listeners you've pushed to (pinned after first use), and, on a listener, the pushers allowed to connect.",
      },
    ],
  },
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Does the CLI cost anything?",
        a: "No. push/pull, send/receive, text, daemon-direct and sync connect the two ends directly, so there is nothing to meter. Sending by pairing code needs an account so the server can mint the code — receiving never does — but it still costs nothing. Only cloud up/down draws on your account's storage and traffic allowance.",
      },
      {
        q: "Which platforms does it run on?",
        a: "macOS, Linux and Windows — a single static binary, installed by one command or downloaded from the releases page.",
      },
      {
        q: "Can I point it at my own server?",
        a: "Yes — --server https://your-domain points login, up, down, send and receive at a self-hosted Relayium instance, so pairing codes are minted by your server too.",
      },
    ],
  },
  learnHeading: "CLI guides",
};

export const deviceInbox = {
  // title/description mirror deviceInboxPage.metaTitle / metaDesc exactly — see
  // the note on `pricing` above. shells.test.mjs asserts the equality, because
  // the SPA overwrites the served <head> on boot and a mismatch means a
  // rendering crawler and a non-rendering one read two different pages.
  title: "Device Inbox — browser to your own Mac, PC or server · Relayium",
  description:
    "Send a file from your browser into a folder on a machine you own. Relayium encrypts it in the browser, queues it while that device is offline, and calls it saved only after the device has verified and durably written it to disk.",
  hero: {
    h1: "Device Inbox",
    pitch:
      "Send a file from any browser to a folder on your own Mac, PC, NAS or server. It is encrypted before it leaves the browser, it waits in a queue while the device is offline, and it is only ever called saved once that device says it wrote the file to disk.",
    cta: "Set up a device inbox",
  },
  how: {
    heading: "How it works",
    steps: [
      "On the machine that should receive: sign in, choose the folder it may write to, and switch receiving on there. Nothing arrives until that has been done on that machine.",
      "In any browser: sign in to the same account and pick the device in My Devices. Your browser encrypts the files and seals the content key to that device before anything is uploaded.",
      "Relayium stores ciphertext and routing state. It cannot read the file, its name or the folder it is bound for, and it holds no key that could open it.",
      "The device collects the task, decrypts and verifies it locally, and writes it into the folder you chose — without asking you again, and without ever overwriting a file that is already there.",
      "Uploaded is not saved: while the target is offline, downloading or verifying, the transfer is still on its way. Saved appears only after that device has decrypted the file, checked it against its manifest and committed it durably to the folder.",
    ],
  },
  why: {
    heading: "Your platform",
    items: [
      {
        title: "Linux server — available now",
        desc: "An always-on VPS, NAS or home server. Sign in once, download the short installer and read it before it gets root: it creates /srv/relayium-inbox, makes a dedicated low-privilege account, enrols the receive key and installs a hardened systemd system unit that starts now and after every reboot. Files land in /srv/relayium-inbox, nothing existing is overwritten, and systemctl status, journalctl, inbox pause/resume and inbox disable control it.",
      },
      {
        title: "Linux desktop — available now",
        desc: "Your own workstation receiving into your own home directory, via the CLI and a systemd --user service. Deliberately not the unattended server deployment: a user service stops when you log out unless you enable lingering, which needs root once.",
      },
      {
        title: "macOS — in testing",
        desc: "The native Mac app's Device Inbox is still an engineering build, so there is no download here. What works on macOS today is the same command-line receiver supervised by launchd, which runs while you are logged in and returns after a restart once you log in again.",
      },
      {
        title: "Windows — planned",
        desc: "The native tray receiver is planned and not built. What is verified today is the command-line receiver in the foreground: it receives while the terminal window stays open and ends when you close it. There is no Windows service and no startup entry.",
      },
      {
        title: "iPhone — planned",
        desc: "The native share-sheet sender and background receiving are planned, not built. Today an iPhone signs in to relayium.com in Safari and sends from My Devices to a Mac, PC or server. Receiving on iOS will be best-effort background work scheduled by the system — never always-on and never guaranteed to be immediate.",
      },
      {
        title: "Android — planned",
        desc: "Native sharing and a native receiver are planned, not built. Today an Android phone signs in in its mobile browser and sends from My Devices. A future receiver would have to live within Android's foreground-service and background-work rules, and battery optimisation would make timing best-effort.",
      },
    ],
  },
  compare: {
    heading: "What it needs, and what it never does",
    items: [
      {
        title: "An account on both ends, and receiving switched on at the device",
        body: "Device Inbox is the one part of Relayium that writes to your own disk, so it is tied to an account rather than to a link anyone could hold. A device only accepts work from the account it is signed in to, and receiving stays off until someone with access to that machine picks a folder and turns it on there. If the device is asleep or offline you can still send: the encrypted task waits in the queue and is delivered when it comes back.",
      },
      {
        title: "A share link is a different permission",
        body: "Relayium's public download links stay exactly what they were: whoever holds the full link can download that one file by hand. A link can never make one of your devices write to disk. The two permissions are deliberately separate, and holding a link gives no access to any device inbox.",
      },
      {
        title: "Boundaries that do not move",
        body: "Relayium never holds a key that can open your files, and file names and folder paths travel inside the encrypted manifest it never receives. An existing file is never overwritten, merged or deleted — a name collision gets a safe new name. Nothing received is opened, executed or unpacked, and received files are not made executable. A partly downloaded file is never presented as a complete one. You can pause receiving, revoke a device or delete queued work at any time.",
      },
    ],
  },
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Do I need an account?",
        a: "Yes, on both ends, and it has to be the same account. This is the only part of Relayium that writes to a disk you own, so it is tied to an account rather than to a link. There is no way to make someone else's device receive from you.",
      },
      {
        q: "What happens if the target device is offline?",
        a: "You can still send. The encrypted task waits in the queue at Relayium and is delivered when the device comes back online. An offline device is a valid target, not a refusal.",
      },
      {
        q: "Does 'uploaded' mean the file is on my machine?",
        a: "No, and Relayium never merges the two. While the target is offline, downloading or verifying, the transfer is shown as still on its way. Saved appears only after that device has decrypted the file, verified it against its manifest and committed it durably to the folder you chose.",
      },
      {
        q: "Can someone with a share link write to my device?",
        a: "No. A public download link lets whoever holds it download that one file by hand, and nothing more. Automatic receiving only accepts work from your own account, and only after someone at the device switched it on.",
      },
      {
        q: "Which platforms can receive today?",
        a: "Linux servers, through the published installer and a low-privilege systemd system service, and Linux desktops through the CLI and a systemd --user service. macOS can run the same command-line receiver under launchd while the native app's Device Inbox is still in testing. Windows can run the receiver in the foreground only. iPhone and Android are senders today; their native clients are planned.",
      },
      {
        q: "Can Relayium read my files or their names?",
        a: "No. Your browser encrypts the files and seals the content key to the target device before anything is uploaded. File names and folder paths are inside the encrypted manifest. The server keeps ciphertext, sizes, timestamps and routing state, and holds no key that could open any of it.",
      },
    ],
  },
  learnHeading: "Read more",
};
