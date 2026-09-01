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
    "Same-network file and live-text transfers are always free. Cross-network browser relay and hosted storage draw on your plan's monthly traffic allowance, with a separate cap on how much you keep stored at once — every account gets both, and paid plans raise them. You can also stay 100% free by running your own node.",
  hero: {
    h1: "Simple, honest pricing",
    pitch:
      "Same-network file and live-text transfers are always free. Cross-network browser relay and hosted storage draw on your plan's monthly traffic allowance, with a separate cap on how much you keep stored at once — every account gets both, and paid plans raise them. You can also stay 100% free by running your own node.",
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
        desc: "Cross-network file or text transfers in the browser go through an encrypted relay by design rather than as a fallback, so they connect through strict firewalls and NATs. Those bytes count against the same monthly traffic allowance as hosted uploads and downloads; every account gets one, and paid plans raise it. This uses real bandwidth.",
      },
      {
        title: "Temporary hosted storage",
        desc: "Send to someone who's offline; we hold the encrypted file until they download it or it expires, then it's deleted. It occupies your storage cap while it is live, and the bytes moved count against your monthly traffic.",
      },
      {
        title: "Higher limits",
        desc: "Four separate limits rise as you move up tiers: the monthly traffic allowance, the cap on storage held live at once, the retention window, and the daily upload quota.",
      },
      {
        title: "No ads, no data selling",
        desc: "Relay bandwidth and hosted storage are our only real costs, so that's all paid plans fund. It keeps Relayium sustainable and independent.",
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
        a: "Yes for the direct paths. Same-network file or live-text transfers and the CLI's direct modes are end-to-end encrypted and completely free — you don't even need an account to receive a file or join a text session. Files are unlimited in size; ephemeral text requires both devices online, and Relayium servers keep no message bodies or server-side history — though each device can copy or keep the text it receives. Cross-network browser relay and hosted storage draw on allowances that every account gets, Free included: a monthly traffic allowance counting relayed bytes together with hosted uploads and downloads, a separate cap on storage held live at once, a retention window, and a daily upload limit. You pay only when you need more.",
      },
      {
        q: "What's the difference between direct and relayed transfers?",
        a: "A direct transfer sends files or live text straight from one device to the other — fastest, and free; that's how same-network browser transfers and the CLI's direct modes work. Cross-network browser transfers go through an encrypted relay by design rather than as a fallback, so they connect reliably through strict firewalls and NATs — the relay only ever carries ciphertext, and the bytes it moves count against the same monthly traffic allowance as hosted uploads and downloads.",
      },
      {
        q: "Why is there a paid tier at all?",
        a: "Relay bandwidth and hosted storage cost real money. Rather than run ads or sell data, we charge for exactly those costs, so the project stays sustainable and independent. Anything that's free for us to run stays free for you.",
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

// The crawlable /cli. It has to carry the same taxonomy and the same product
// claims as the rendered page, because a non-rendering client sees only this.
//
// Three things this shell got wrong until now, all of them claims rather than
// wording:
//
//   * Device Inbox was absent entirely. The one mode whose sender is the Web app
//     — the answer to "get this file onto my server" — did not exist for any
//     crawler, so the mode list read as six.
//   * "Verified and resumable … every file … an interrupted transfer resumes"
//     was a blanket promise over all modes. Neither half is true across the
//     board: the zero-dependency tar fallback verifies nothing, and resume is
//     two different per-mode behaviours rather than one property — `sync`
//     continues a partial destination on a LATER run, `relayium down` reconnects
//     and continues by HTTP Range WITHIN one run (and deletes the partial output
//     when it gives up), and push/pull do neither. The first correction here
//     over-swung to "resume is a sync feature", which is its own untrue
//     sentence; see the security item below.
//   * The --server answer omitted `text`, which takes it too.
//
// And the install step said one command downloads a binary "for your OS", with
// Windows as an aside — which reads as though `curl … | sh` covers Windows.
export const cli = {
  // title/description mirror cliPage.metaTitle / metaDesc exactly — see the note
  // on `pricing` above.
  title: "Relayium CLI — encrypted file and text transfer from the terminal",
  description:
    "A single binary for macOS, Linux and Windows: copy files over your own SSH, send by pairing code, push server-to-server, mirror a folder, share ephemeral text, upload now and pull later, or receive into a Device Inbox. Free and open source.",
  hero: {
    h1: "Relayium CLI",
    pitch: "Move files between machines — directly, through your devices, or with Relayium Cloud.",
    cta: "Install the CLI",
  },
  how: {
    heading: "Install",
    steps: [
      "macOS and Linux: one command downloads a prebuilt binary and puts it on your PATH — curl -fsSL https://relayium.com/install.sh | sh",
      "Windows: download the portable ZIP for x64 or ARM64 from the releases page and put relayium.exe anywhere on your PATH. The installer above is a POSIX shell script and does not run on Windows; relayium update also cannot replace a running .exe there, so it prints the download URL instead.",
      "Or build from source with Go.",
      "Then relayium --help lists every command, and relayium help <command> prints that command's own usage — offline, with no account and no network request.",
    ],
  },
  why: {
    heading: "Choose by task",
    items: [
      {
        title: "Cloud",
        desc: "Another device can be offline. relayium up encrypts on this machine, uploads only the ciphertext and prints a link; relayium down fetches and decrypts it anywhere, with no account. Uploading requires relayium login and counts against your account's storage cap, traffic allowance, daily quota and retention window. The key travels in the link's #k= fragment and never reaches the server, which stores ciphertext including file names: the encrypted copy stays stored until its retention expires, but losing the link loses the only key that can decrypt it. It is the same link the website makes. A download recovers inside the run that started it: relayium down reconnects a dropped or stalled connection up to five attempts and continues by HTTP Range from the last complete encrypted frame, and when those attempts are spent it deletes the partial output instead of leaving a truncated file.",
      },
      {
        title: "Device Inbox",
        desc: "Another device can be offline. Send from a browser or a native app into a folder on a machine you own. In the CLI this is the RECEIVE side only — there is no CLI command that sends into an inbox; to move files between two of your own servers, use serve with push or sync. Both ends must be signed in to the same account, and receiving stays off until someone at that machine picks a folder and turns it on there. If the machine is offline the encrypted task waits in the queue; until that machine reports it wrote the file to disk, the status says the ciphertext is uploaded, never that it arrived. The content key is sealed to a public key that machine published, so Relayium never sees the plaintext, the file names or the folder structure, and an existing file is never overwritten. There is no official Relayium container image.",
      },
      {
        title: "text",
        desc: "Both devices are online. Ephemeral encrypted messages between two terminals: one runs relayium text to mint a 6-digit pairing code — that side needs relayium login — and the other joins with the printed relayium text CODE, which needs no account. Both ends stay online for the session; it is its own end-to-end encrypted peer-to-peer session, Relayium servers keep no message bodies and no server-side history, and the machine on the other end can of course copy or keep what it receives. One message is at most 65,536 bytes of UTF-8; anything larger is a file. Verification is opt-in: --verify stops to compare the SAS and needs a terminal to answer.",
      },
      {
        title: "send / receive",
        desc: "Both devices are online. Send files to another person across networks. relayium send mints a 6-digit pairing code, good for 5 minutes, and prints the exact command the other end runs; minting needs relayium login and the receiver needs no account. Only a short rendezvous handshake passes through Relayium — the file bytes never do, and if no direct connection can be made the transfer fails rather than being relayed. Both terminals print a 6-digit verification code (SAS) derived from their pinned TLS certificate fingerprints, a different value from the pairing code. Comparing it out of band is optional (--verify stops for it) and confirms the fingerprints were not substituted and that the rendezvous service did not impersonate either endpoint; it authenticates the endpoints, not every network hop, and only when someone actually compares it.",
      },
      {
        title: "push / pull",
        desc: "A machine you manage. Copy files to, or from, any machine you can already ssh into. The bytes travel over your SSH connection and never touch Relayium's servers, and no account is involved. With relayium installed on the remote, the batch is checked for collisions before any bytes are sent and each file is verified by SHA-256; without it, push falls back to a tar stream piped into the remote's own tar -x -k, which verifies nothing per file, and pull has no fallback at all. Neither push nor pull resumes: they refuse a destination that already exists, so --no-resume is accepted there and does nothing.",
      },
      {
        title: "serve",
        desc: "A machine you manage. The direct server-to-server listener: one host runs relayium serve, the other pushes straight into its --dir over a pinned TLS 1.3 connection. No relay, no SSH, no pairing code, no account. Trust is that host's authorized_fingerprints file and nothing else — logging in to a Relayium account grants no one filesystem access here. In a terminal it asks you to approve each new pusher once; with no terminal an unknown pusher is rejected, so pre-authorize it with relayium authorize. --bind is empty by default, which listens on every interface including public ones.",
      },
      {
        title: "sync",
        desc: "A machine you manage. One-way incremental folder mirroring over the same transports as push: files whose size and modification time are unchanged are skipped. The files it does transfer are verified, and a partial file left at the destination by an interrupted run is continued by the next run rather than started over. --delete also removes files gone from the source — over relayium:// only if the listener was started with --allow-delete — and --watch keeps it running with debouncing and backoff. A one-way mirror is a copy of the current state, not a versioned backup.",
      },
    ],
  },
  compare: {
    heading: "Security & integrity",
    items: [
      {
        title: "Verification is per-mode, not a blanket promise",
        body: "push and pull verify each file by SHA-256 only when relayium is installed on the remote; the zero-dependency tar fallback verifies nothing per file, so a \"sent\" line is not proof every file landed. send and receive verify each file. sync verifies the files it transfers, but decides what to transfer from size and modification time. Cloud and Device Inbox verify on the receiving side before anything is written, and Device Inbox reports saved only once the file is durably on disk. The SAS that send, receive and text print authenticates the endpoints only if someone actually compares it out of band.",
      },
      {
        title: "Resume means two different things, and neither covers every mode",
        body: "sync resumes across runs: it keeps a partial file at the destination and continues it on the next run, a serve listener receiving a sync honours that, and --no-resume turns it off. relayium down resumes within a single run: it reconnects a dropped or stalled download by itself, up to five attempts, and continues by HTTP Range from the last complete encrypted frame; against a server that ignores Range it restarts the file inside that same run, and once the attempts are spent it deletes the partial output rather than leaving a truncated file — so a fresh relayium down starts from the beginning. push and pull do not resume: they refuse a destination that already exists before any bytes are sent, so there is never a partial file to continue from, and --no-resume is accepted there only for compatibility. A copy or a mirror is also not a versioned backup — sync --delete propagates a deletion at the source, and nothing here keeps an earlier version of a file you overwrote.",
      },
      {
        title: "Logging in grants no filesystem access",
        body: "serve and push relayium:// trust exactly one thing — the fingerprint list on the receiving host — and that decision is separate from any Relayium account. Identity and trust live in ~/.config/relayium/, or wherever --config-dir points: this host's persistent key, the fingerprints of listeners you have pushed to (pinned on first contact and refused if they later change), and, on a listener, the pushers allowed to connect.",
      },
    ],
  },
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Do I need an account?",
        a: "For most of the CLI, no. push, pull, serve, sync, relayium down, and joining a send or text session with a code someone gave you all need no account. An account is required to upload with relayium up, to mint a pairing code for send or text, and on both ends of Device Inbox. Signing in never grants anyone access to your filesystem.",
      },
      {
        q: "Can the other device be offline?",
        a: "In two modes. Cloud stores the encrypted file until someone fetches the link, and Device Inbox queues the encrypted task until that device comes back — an offline target is valid there, not a refusal. Everything else moves bytes straight between two machines, so text, send / receive, push / pull, serve and sync all need the far end available at the same time.",
      },
      {
        q: "Which transfers can resume?",
        a: "Two, and they resume in different senses. sync resumes across runs: it skips files whose size and modification time are unchanged, keeps a partial file at the destination and continues it on the next run; a serve listener receiving a sync honours that, and --no-resume turns it off. relayium down resumes within a single run: it reconnects a dropped or stalled download on its own, up to five attempts, continuing by HTTP Range from the last complete encrypted frame, and deletes the partial output after the last failed attempt — so running it again starts from the beginning. push and pull do not resume: they refuse a destination that already exists before any bytes are sent, and --no-resume is accepted there only for compatibility. The zero-dependency tar fallback resumes nothing.",
      },
      {
        q: "How does verification differ by mode?",
        a: "push and pull verify each file by SHA-256 and stage it before installing, but only when relayium is installed on the remote; the tar fallback verifies nothing per file. send and receive verify each file and additionally print a 6-digit SAS derived from the pinned TLS fingerprints, which proves something only if someone compares it out of band — --verify stops for that. text has the same optional SAS and no files to verify. sync verifies the files it transfers, but decides what to transfer from size and modification time. Cloud and Device Inbox verify on the receiving side before writing.",
      },
      {
        q: "Which platforms does it run on?",
        a: "macOS, Linux and Windows — a single static binary. macOS and Linux install with one shell command; Windows is a portable ZIP from the releases page, because that installer is a POSIX shell script.",
      },
      {
        q: "Can I point it at my own server?",
        a: "Yes — --server https://your-domain points login, up, down, send, receive and text at a self-hosted Relayium instance, so pairing codes are minted by your server too. For up it must be the server you are logged in to; the token is never sent elsewhere.",
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
      "In any browser: sign in to the same account and pick the device on this page. Your browser encrypts the files and seals the content key to that device before anything is uploaded.",
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
        title: "macOS — available now",
        desc: "The Mac app is published: install it from the Apps page, sign in to the same account, choose a receive folder and set Receiving to Ask every time or Automatic. It receives while it is running, including with its window closed, and Open at Login brings it back after you log in again. It is not a system daemon — quit it and it stops receiving, which is what the launchd command-line receiver below is for on a Mac you run unattended or administer over SSH.",
      },
      {
        title: "Windows — no native app",
        desc: "Relayium publishes no Windows app: no tray receiver, no Windows service and no startup entry, and none is offered. What is verified today is the command-line receiver in the foreground: it receives while the terminal window stays open and ends when you close it. For a receiver that survives a logout and a reboot, use the Linux server deployment above.",
      },
      {
        title: "iPhone — no native app",
        desc: "Relayium publishes no iPhone or iPad app, so there is nothing to install here. What works today: an iPhone signs in to relayium.com in Safari and sends from this page to a Mac, PC or server of yours that has Device Inbox switched on. iPhone is a sender here and not a receiver, so nothing is delivered onto the phone.",
      },
      {
        title: "Android — no native app",
        desc: "Relayium publishes no Android app, so there is nothing to install here. Today an Android phone signs in in its mobile browser and sends from this page to any device of yours that has Device Inbox switched on. Android is a sender here and not a receiver, so nothing is delivered onto the phone.",
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
        a: "Linux servers, through the published installer and a low-privilege systemd system service, and Linux desktops through the CLI and a systemd --user service. macOS can receive in the published Mac app, or through the same command-line receiver under launchd on a Mac you run unattended. Windows can run the receiver in the foreground only. iPhone and Android are senders here: Relayium publishes no app for either, and none is offered.",
      },
      {
        q: "Can Relayium read my files or their names?",
        a: "No. Your browser encrypts the files and seals the content key to the target device before anything is uploaded. File names and folder paths are inside the encrypted manifest. The server keeps ciphertext, sizes, timestamps and routing state, and holds no key that could open any of it.",
      },
    ],
  },
  learnHeading: "Read more",
};
