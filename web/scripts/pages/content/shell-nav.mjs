// web/scripts/pages/content/shell-nav.mjs — the app sidebar's labels, for the
// generated pages that now render that same sidebar.
//
// ── Not hand-written, and not the source of truth ───────────────────────────
// Every string here was COPIED from the SPA's own i18n: src/lib/i18n/{en,zh}.ts
// for the two maintained languages and src/lib/i18n/archive/*.ts for the seven
// archived ones. `shell-nav-parity.test.ts` imports both sides and fails, naming
// this file, if any of them ever drift. Regenerate rather than edit.
//
// ── Why a copy at all ───────────────────────────────────────────────────────
// Node 25 strips types, so the page builder CAN import the .ts modules directly
// — locally. CI runs Node 24, and binding the whole page generator to type
// stripping to avoid duplicating ten keys is a build-breaking risk taken for
// nothing. Vitest transpiles TypeScript itself, so the guard costs nothing and
// does not depend on which Node is running.
//
// ── The null group titles are the point, not an omission ────────────────────
// `groupDirect` / `groupLinks` / `groupDevices` exist only in en and zh: the
// sidebar's grouping was added after the 2026-08-14 language freeze. The seven
// archived locales therefore render the SAME destinations as one ungrouped
// list. Both alternatives are worse and both are refused by
// PROJECT-GOVERNANCE.md: English group titles on a Japanese page is the
// mixed-language UI it forbids, and translating four titles into seven frozen
// locales breaks the freeze. Every word a reader sees stays in their page's
// own language; an archived page simply gets slightly less structure, which is
// what "archived" should mean.
//
// The archived locales also carry the OLDER destination vocabulary (Japanese
// still says 非同期 where the product now says "Share a link"). That is correct:
// the body copy on those pages uses the same older vocabulary, so the nav and
// the page agree. Updating it would be updating frozen copy.
export const SHELL_NAV = {
  en: {
    navLabel: "Main",
    lan: "LAN", lanFull: "LAN",
    cross: "Cross-network", crossFull: "Cross-network transfer",
    offline: "Share", offlineFull: "Share a link",
    inbox: "Inbox", inboxFull: "Device Inbox",
    cli: "CLI", apps: "Apps", pricing: "Pricing",
    groupDirect: "Live transfer", groupLinks: "Links", groupDevices: "Your devices", groupTools: "Downloads and tools",
  },
  zh: {
    navLabel: "主导航",
    lan: "局域网", lanFull: "局域网传输",
    cross: "跨网络", crossFull: "跨网络传输",
    offline: "链接", offlineFull: "分享链接",
    inbox: "收件箱", inboxFull: "设备收件箱",
    cli: "CLI", apps: "应用", pricing: "定价",
    groupDirect: "实时传输", groupLinks: "链接", groupDevices: "我的设备", groupTools: "下载与工具",
  },
  ja: {
    navLabel: "メインナビゲーション",
    lan: "LAN", lanFull: "LAN",
    cross: "ネットワーク間", crossFull: "ネットワーク間",
    offline: "非同期", offlineFull: "非同期",
    inbox: "デバイス受信箱", inboxFull: "デバイス受信箱",
    cli: "CLI", apps: "アプリ", pricing: "料金",
    groupDirect: null, groupLinks: null, groupDevices: null, groupTools: null,
  },
  ko: {
    navLabel: "기본 탐색",
    lan: "LAN 전송", lanFull: "LAN 전송",
    cross: "네트워크 간 전송", crossFull: "네트워크 간 전송",
    offline: "비동기 전송", offlineFull: "비동기 전송",
    inbox: "기기 수신함", inboxFull: "기기 수신함",
    cli: "CLI", apps: "앱", pricing: "요금제",
    groupDirect: null, groupLinks: null, groupDevices: null, groupTools: null,
  },
  de: {
    navLabel: "Hauptnavigation",
    lan: "LAN", lanFull: "LAN",
    cross: "Netzwerkübergreifend", crossFull: "Netzwerkübergreifend",
    offline: "Asynchron", offlineFull: "Asynchron",
    inbox: "Geräte-Posteingang", inboxFull: "Geräte-Posteingang",
    cli: "CLI", apps: "Apps", pricing: "Preise",
    groupDirect: null, groupLinks: null, groupDevices: null, groupTools: null,
  },
  fr: {
    navLabel: "Navigation principale",
    lan: "LAN", lanFull: "LAN",
    cross: "Entre réseaux", crossFull: "Entre réseaux",
    offline: "Asynchrone", offlineFull: "Asynchrone",
    inbox: "Boîte appareil", inboxFull: "Boîte appareil",
    cli: "CLI", apps: "Applis", pricing: "Tarifs",
    groupDirect: null, groupLinks: null, groupDevices: null, groupTools: null,
  },
  ar: {
    navLabel: "التنقل الرئيسي",
    lan: "LAN", lanFull: "LAN",
    cross: "عبر الشبكات", crossFull: "عبر الشبكات",
    offline: "غير متزامن", offlineFull: "غير متزامن",
    inbox: "بريد الأجهزة", inboxFull: "بريد الأجهزة",
    cli: "CLI", apps: "التطبيقات", pricing: "الأسعار",
    groupDirect: null, groupLinks: null, groupDevices: null, groupTools: null,
  },
  es: {
    navLabel: "Navegación principal",
    lan: "LAN", lanFull: "LAN",
    cross: "Entre redes", crossFull: "Entre redes",
    offline: "Asíncrono", offlineFull: "Asíncrono",
    inbox: "Buzón de dispositivo", inboxFull: "Buzón de dispositivo",
    cli: "CLI", apps: "Apps", pricing: "Precios",
    groupDirect: null, groupLinks: null, groupDevices: null, groupTools: null,
  },
  pt: {
    navLabel: "Navegação principal",
    lan: "LAN", lanFull: "LAN",
    cross: "Entre redes", crossFull: "Entre redes",
    offline: "Assíncrono", offlineFull: "Assíncrono",
    inbox: "Caixa de dispositivo", inboxFull: "Caixa de dispositivo",
    cli: "CLI", apps: "Apps", pricing: "Preços",
    groupDirect: null, groupLinks: null, groupDevices: null, groupTools: null,
  },
};
