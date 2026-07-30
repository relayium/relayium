// web/scripts/pages/content/spa-pages.mjs — English copy for the two SPA routes
// that have no localized static twin: /pricing and /cli. Both are public pages
// (the router calls /pricing "public marketing"), both were invisible to any
// crawler that doesn't run JavaScript, and neither was in the sitemap.
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
        desc: "Send to another person across networks. After relayium login, run send with no code: the CLI mints a 6-character pairing code (no 0 or 1), good for 5 minutes, and prints the command the other end runs — you pass that on out of band. The receiver needs no account. The connection is direct peer-to-peer: only a small rendezvous handshake passes through Relayium — the file bytes never do. Both terminals print a 6-digit SAS code to rule out a man-in-the-middle.",
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
