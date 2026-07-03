// Pure i18n types and locale-independent helpers. No message data and no
// runtime state live here, so language tables and the reactive facade can both
// import it without a cycle.

export type Lang = "zh" | "en" | "ja" | "ko" | "de" | "fr";

export const LANGS: { code: Lang; label: string }[] = [
  { code: "zh", label: "中文" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
];

export interface Messages {
  langLabel: string;
  theme: { label: string; system: string; light: string; dark: string };
  tagline: string;
  connected: (name: string) => string;
  ipLabel: string; // prefix shown before the device's server-observed public IP
  connecting: string;
  unavailable: string;
  unsupported: string;
  guideTitle: string;
  step1: string;
  step2: string;
  step3: (max: number) => string;
  step4: string;
  hint: string;
  requestHead: (name: string, count: number, size: string) => string;
  codeLabel: string;
  codeCompare: string;
  pathLan: string; // connection-path badge: host↔host on the local network
  pathP2p: string; // direct P2P over the public internet (NAT-traversed)
  pathRelay: string; // traffic going through a TURN relay
  sharePending: (n: number) => string; // files came in via the OS share sheet; pick a device
  sendFolder: string; // button: choose a folder to send
  accept: string;
  decline: string;
  sendTo: (name: string) => string;
  recvFrom: (name: string) => string;
  fileCounter: (i: number, n: number) => string;
  close: string;
  cancel: string; // abort an in-progress transfer and return to idle
  share: string; // Web Share button label (opens the OS share sheet for a link)
  startOver: string; // leave the current room and return to the method choices
  peersTitle: string;
  crossPeersTitle: string; // heading for the single connected peer on the cross-network page
  emptyPeers: string;
  emptyCrossCta: string; // LAN empty-state escape hatch → cross-network transfer
  dragSendOne: (name: string) => string;
  dragSendMany: string;
  pickHint: (max: number) => string;
  pickSendTo: (name: string) => string; // prominent single-peer send label
  generating: string; // transient "creating…" state while a code/link is minted
  footer: string;
  busy: string;
  tooMany: (max: number, n: number) => string;
  titleDefault: string;
  reconnecting: string; // signalling socket dropped, trying to reconnect
  confirmLeave: string; // confirm() before an action would interrupt an active transfer
  status: {
    connecting: string;
    waitingAccept: string;
    rejected: string;
    sending: string;
    finishing: string;
    sendDone: (n: number) => string;
    sendFail: string;
    receiving: string;
    recvDone: (n: number) => string;
    integrityFail: string;
    recvFail: string;
    resuming: string; // connection dropped mid-transfer, reconnecting to resume
    noSave: string;
    connectFail: string;
    peerBusy: string; // the peer refused the offer because it's already in a transfer
  };
  account: {
    signIn: string;
    signOut: string;
    email: string;
    sendLink: string;
    linkSent: string;
    continueGoogle: string;
    or: string;
    signedInAs: (email: string) => string;
    password: string;
    createAccount: string;
    logInBtn: string;
    toRegister: string;
    toLogin: string;
    errTooShort: string;
    errEmailTaken: string;
    errLogin: string;
    errNetwork: string; // request never reached the server (offline / fetch threw)
    changePassword: string;
    setPassword: string;
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
    pwChanged: string;
    errCurrentWrong: string;
    errMismatch: string;
  };
  nav: { lanTab: string; crossTab: string };
  crossnet: {
    sendAcross: string;
    loginFirst: string;
    shareHint: string;
    copy: string;
    copied: string;
    connecting: string;
    linkDead: string;
    sessionExpired: string; // /api/transfers returned 401 — session lapsed, re-login
    netError: string; // request never reached the server (offline / fetch threw)
    realtimeTitle: string;
    realtimeSub: string;
    realtimeFoot: string;
  };
  methods: {
    pairing: { name: string; sub: string; badge: string };
    share: { name: string; sub: string; badge: string; signIn: string };
    stored: { name: string; sub: string; badge: string };
  };
  pair: {
    sendCode: string;
    enterCode: string;
    enterHint: string;
    joinBtn: string;
    yourCode: string;
    scanHint: string; // caption under the pairing-code QR
    waiting: string;
    expiresIn: (s: string) => string;
    expired: string;
    copy: string;
    copied: string;
    copyLink: string; // copies the full join link for forwarding
    errExpired: string;
    mintFailed: string; // minting a fresh code failed (network/server), not expiry
    back: string; // return from code entry to the send/receive choice
  };
  stored: {
    pick: string;
    uploading: string;
    encrypting: string; // phase 1: encrypting in the browser (progress bar tracks this)
    uploadingNow: string; // phase 2: ciphertext is being POSTed (bar sits full)
    burnLabel: string;
    ttlLabel: string;
    ttl1h: string;
    ttl1d: string;
    ttl3d: string;
    ttl7d: string;
    linkReady: string;
    expiresOn: (when: string) => string; // echoes the link's expiry back to the sender
    copy: string;
    copied: string;
    errTooLarge: string;
    errQuota: string;
    errUpload: string;
  };
  download: {
    loading: string;
    files: string;
    summary: (count: number, size: string) => string; // file count + total size
    expiresIn: (left: string) => string; // countdown, `left` pre-formatted by formatRemaining
    durUnits: { d: string; h: string; m: string }; // suffixes for the countdown
    zeroKnowledge: string; // reassurance + phishing caution
    burnWarning: string; // shown only for burn-after-read links
    sendPrompt: string; // reverse-acquisition lead-in
    sendCta: string; // reverse-acquisition button
    downloadBtn: string;
    downloading: string;
    done: string;
    notFound: string;
    noKey: string;
    decryptFail: string;
    unsupported: string;
    netFail: string; // download connection dropped — retryable, distinct from a decrypt failure
    retry: string; // button: retry a network-failed download
  };
  features: { title: string; sub: string; secureLink: string; items: { title: string; desc: string }[] };
  howItWorks: {
    title: string;
    sub: string;
    ways: { icon: string; name: string; how: string; tag: string }[];
  };
  compare: {
    title: string;
    sub: string;
    colFeature: string;
    colRealtime: string;
    colStored: string;
    rows: { label: string; realtime: string; stored: string }[];
  };
  useCases: {
    title: string;
    sub: string;
    items: { icon: string; title: string; desc: string }[];
  };
  faq: {
    title: string;
    sub: string;
    items: { q: string; a: string }[];
  };
  crossPitch: string; // one-line cross-network pitch under the two cards
  homeCross: { title: string; desc: string; cta: string }; // homepage → cross-network CTA
  legal: { privacy: string; terms: string; security: string };
  // Short footer labels linking to the generated static articles/landing pages.
  learn: {
    compareSnapdrop: string;
    compareAirdrop: string;
    compareWetransfer: string;
    howtoAndroidIphone: string;
    howtoPcPhone: string;
    howtoLargeFiles: string;
  };
}

export function legalUrl(slug: "privacy" | "terms" | "security", l: Lang): string {
  return pageUrl(slug, l);
}

/** URL of a generated static page (article/landing) in the given language. */
export function pageUrl(slug: string, l: Lang): string {
  return l === "en" ? `/${slug}` : `/${l}/${slug}`;
}

export type StatusKey = keyof Messages["status"];
