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

/** One page's "how it works" walkthrough: three sequential step cards. */
export interface HowSection {
  title: string;
  sub: string;
  ways: { icon: string; name: string; how: string; tag: string }[];
}

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
  sendFile: string; // button: choose files to send
  sendFolder: string; // button: choose a folder to send
  accept: string;
  decline: string;
  sendTo: (name: string) => string;
  recvFrom: (name: string) => string;
  fileCounter: (i: number, n: number) => string;
  close: string;
  cancel: string; // abort an in-progress transfer and return to idle
  dialogConfirm: string; // ConfirmModal's affirmative button label
  dialogCancel: string; // ConfirmModal's dismiss button label
  share: string; // Web Share button label (opens the OS share sheet for a link)
  startOver: string; // leave the current room and return to the method choices
  peersTitle: string;
  crossPeersTitle: string; // heading for the single connected peer on the cross-network page
  emptyPeers: string;
  emptyCrossCta: string; // LAN empty-state escape hatch → cross-network transfer
  dragSendOne: (name: string) => string;
  dragSendMany: string;
  pickHint: (max: number) => string;
  maxSize: (size: string) => string; // upload max-size hint shown near the file picker, e.g. "Max 200 MB"
  pickSendTo: (name: string) => string; // prominent single-peer send label
  generating: string; // transient "creating…" state while a code/link is minted
  footer: string;
  offlineFooter: string; // async page's own footer: random-key AES-256-GCM, ciphertext durably stored (NOT the LAN/realtime X25519 footer)
  busy: string;
  tooMany: (max: number, n: number) => string;
  titleDefault: string;
  descDefault?: string; // home <meta description>; falls back to titleDefault when absent
  titleCross: string; // <title> for the cross-network (realtime) route
  titleOffline: string; // <title> for the offline-transfer (stored-link) route
  descCross: string; // <meta description> for the cross-network route
  descOffline: string; // <meta description> for the offline-transfer route
  reconnecting: string; // signalling socket dropped, trying to reconnect
  confirmLeave: string; // confirm() before an action would interrupt an active transfer
  confirmRecv: (name: string) => string; // "<name> wants to receive"
  confirmRecvSend: string;
  confirmRecvCancel: string;
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
    personalCenter: string; // menu entry → /me
    verifySentBody: (email: string) => string; // "check your email" panel body after register
    resendVerification: string; // resend button label on the "check your email" panel
    resendVerificationBtn: string; // resend button label on the inline unverified-login notice
    resendVerificationSent: string; // ack shown after a resend click
    unverifiedNotice: string; // inline notice when passwordLogin returns unverified
    forgotPasswordLink: string; // "忘记密码？" link on the login form
    resetPasswordSend: string; // submit button on the forgot-password panel
    resetPasswordSent: string; // neutral post-submit message (never reveals account existence)
    checkSpamHint: string; // muted follow-up under any "we emailed you" state: check spam + allowlist noreply@relayium.com. Also reused (via t.account.*) on VerifyEmail.svelte's invalid-token panel.
  };
  me: {
    title: string;
    back: string; // link back to the home page
    loginRequired: string; // shown when /me is opened without a session
    signIn: string; // sign-in button on the login-required state
    transfers: string; // stat card: stored links created
    downloads: string; // stat card: total downloads of my files
    traffic: string; // stat card: total bytes
    trafficParts: (up: string, down: string, relay: string) => string; // breakdown line
    privacyNote: string; // reassurance: aggregate only, no downloader info
    filesTitle: string;
    filesEmpty: string;
    noName: string; //列表标题旁的说明：零知识加密，无文件名
    downloadsN: (n: number) => string; // per-file download count
    burnTag: string; // burn-after-read badge
    expiresIn: (left: string) => string; // per-file expiry countdown
    expiringSoon: string; // <1h marker
    del: string; // delete button
    confirmDel: string; // confirm() before deleting a file
    nodesTitle: string; // "My Nodes" section heading
    nodesEmpty: string; // no BYO relay nodes registered yet
    strictLabel: string; // checkbox: restrict this account to only its own nodes
    strictHint: string; // one-line explanation under the strict-mode checkbox
    addNode: string; // "Add node" button
    nodeNamePlaceholder: string; // placeholder for the new-node name field
    addNodeSubmit: string; // confirm button inside the add-node mini-form
    addNodeCancel: string; // cancel button inside the add-node mini-form
    tokenNote: string; // instruction shown above the one-time paste-in command
    tokenPortsNote: string; // note above the firewall/ports block
    tokenPortsTitle: string; // title of the ufw ports CommandBlock
    tokenGuideLink: string; // link text to the full "bring your own node" guide
    tokenDone: string; // "Done" button that clears the one-time token from memory
    nodeOnline: string; // online-status label
    nodeOffline: string; // offline-status label
    nodeRelayed: (bytes: string) => string; // relayed-traffic figure through this node
    nodeStored: (bytes: string) => string; // bytes stored on this node
    nodeFreeTag: string; // "(free)" tag next to relayed/stored figures — own-node traffic isn't billed
    nodeStorageFree: (free: string, total: string) => string; // "X free of Y" disk line
    delNode: string; // remove-node button
    confirmDelNode: string; // confirm() before removing a node
  };
  // Shared "why an account?" explainer shown on the two login-gated feature pages
  // (/cross-network, /offline-transfer) and, compact, on the /me login gate.
  why: {
    heading: string; // small eyebrow above the three points (compact variant hides it)
    costTitle: string; // point 1 — why login is required
    costBody: string; // these features cost us; free allowance then paid
    selfhostTitle: string; // point 2 — run your own node for free
    selfhostBody: string; // traffic goes through your node, not us, so we don't charge
    selfhostCta: string; // link text to the bring-your-own-node guide
    privacyTitle: string; // point 3 — our promise
    privacyBody: string; // your data and config are only ever usable by you
  };
  // /verify-email — landing page for the emailed verification link (?token=).
  verifyEmail: {
    checking: string; // transient state while the token is being verified
    successBody: string; // token accepted, session cookie set, redirecting home
    noToken: string; // opened without a ?token= param
    invalidTitle: string; // token rejected (expired / already used / malformed)
    backHome: string; // link back to the app
  };
  // /reset-password — landing page for the emailed reset link (?token=).
  resetPassword: {
    noToken: string; // opened without a ?token= param
    minHint: string; // client-side password-length hint under the new-password field
    submitBtn: string;
    successBody: string; // token accepted, new password set, session cookie set, redirecting home
    invalidBody: string; // fuller explanation + prompts a fresh forgot-password request
    errGeneric: string; // any other server error on submit
    backHome: string; // link back to the app
  };
  nav: { lanTab: string; crossTab: string; offlineTab: string; cliTab: string };
  // Full page headings for the cross/offline pages. The nav.*Tab strings are the
  // short pill labels; these are the descriptive <h1> titles.
  crossTitle: string;
  offlineTitle: string;
  cli: { subtitle: string };
  cliCallout: { heading: string; blurb: string; cta: string };
  // /cli docs page body. Command blocks stay literal English (code); only prose
  // and labels are localised. Arrays keep a fixed length matching CliPage.svelte:
  // badges 3, pickWhen 3, flagMeanings 8, fileDescs 3.
  cliPage: {
    badges: string[];
    freenote: string;
    installH2: string;
    installIntro: string;
    installReleases: string;
    installBuild: string;
    installHelp: string;
    whichH2: string;
    whichIntro: string;
    pickWhen: string[];
    mode1Title: string;
    mode1Tag: string;
    mode1Body: string;
    mode2Title: string;
    mode2Tag: string;
    mode2Body: string;
    mode3Title: string;
    mode3Tag: string;
    mode3Body: string;
    step1Label: string;
    step1Body: string;
    step2Label: string;
    step2Body: string;
    step3Label: string;
    step3Body: string;
    refH2: string;
    flagsH3: string;
    thFlag: string;
    thApplies: string;
    thMeaning: string;
    flagMeanings: string[];
    trustH3: string;
    trustIntro: string;
    fileDescs: string[];
    integrityH3: string;
    integrityNote: string;
    footerSource: string;
    footerReleases: string;
    footerBrowser: string;
    guidesH2: string;
    guides: string[];
    syncH2: string;
    syncNote: string;
  };
  crossnet: {
    realtimeTitle: string;
    realtimeSub: string;
    realtimeFoot: string;
    signInToSend: string; // gate hint on the mint card when signed out
    relayQuotaWarn: string; // proactive banner on the minter's code card when over the monthly relay cap
    relayQuotaFail: string; // shown when a cross-network transfer fails and no relay was available (over cap)
  };
  offline: {
    tagline: string; // page subtitle — encrypt-then-store, ciphertext-only server
    pitch: string; // one-paragraph how/why under the header
    signIn: string; // hint beside the sign-in button on the gated card
  };
  crossSell: {
    // Directional cross-links between the two cross-network pages.
    realtime: { lead: string; cta: string }; // rendered on the OFFLINE page → go realtime
    offline: { lead: string; cta: string }; // rendered on the REALTIME page → go offline
  };
  methods: {
    realtime: { name: string; sub: string; badge: string };
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
    queued: (n: number, size: string) => string; // files picked before pairing, auto-send on join
    bareConnect: string; // secondary: open a room without picking files (receiver-initiated flows)
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
    realtime: HowSection;
    offline: HowSection;
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
  crossPitch: string; // one-line pitch under the realtime page header
  homeCross: { title: string; desc: string; realtimeCta: string; offlineCta: string }; // homepage → the two cross-network pages
  legal: { privacy: string; terms: string; security: string };
  // Footer link label for the generated static Guides hub page.
  learn: { hub: string };
  // Client-local "recent transfers" panel (localStorage-backed, this device only).
  historyTitle: string;
  historyEmpty: string;
  historyClear: string;
}

export function legalUrl(slug: "privacy" | "terms" | "security", l: Lang): string {
  return pageUrl(slug, l);
}

/** URL of a generated static page (article/landing) in the given language. */
export function pageUrl(slug: string, l: Lang): string {
  return l === "en" ? `/${slug}` : `/${l}/${slug}`;
}

export type StatusKey = keyof Messages["status"];
