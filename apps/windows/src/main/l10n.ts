// Main-process copy, in Relayium's two maintained languages.
//
// The renderer has the Web i18n runtime; the main process cannot use it — that
// is a Svelte rune store — and until this file existed the main process had no
// localization at all: the tray menu was two English string literals.
//
// Deliberately plain. A closed key union, two complete catalogs, and a lookup.
// No interpolation, no plural engine, no runtime loading. Every value a user
// sees from the main process is one of these strings.

/** The maintained product languages. English is the source and the fallback. */
export type Locale = "en" | "zh-Hans";

/**
 * Every string the resident surfaces can show.
 *
 * `resident.` prefixed so these do not collide with the renderer's key space
 * when the two are eventually reconciled. Some have no Mac counterpart — the
 * first-close notice is Windows-specific, because closing a window on macOS is
 * already understood not to quit.
 */
export type MessageKey =
  | "resident.tray.tooltip"
  | "resident.tray.show"
  | "resident.tray.quit"
  | "resident.tray.nearby"
  | "resident.tray.inbox"
  | "resident.tray.pauseNearby"
  | "resident.tray.resumeNearby"
  | "resident.firstClose.title"
  | "resident.firstClose.body"
  | "resident.firstClose.hide"
  | "resident.firstClose.quit"
  | "resident.firstClose.cancel"
  | "resident.login.title"
  | "resident.login.body"
  | "resident.login.confirmTitle"
  | "resident.login.confirmBody"
  | "resident.login.confirm"
  | "resident.login.cancel"
  | "resident.login.stateOn"
  | "resident.login.stateOff"
  | "resident.login.stateDisabledByUser"
  | "resident.login.stateExternallyEnabled"
  | "resident.quit.transferTitle"
  | "resident.quit.transferBody"
  | "resident.quit.localTextTitle"
  | "resident.quit.localTextBody"
  | "resident.quit.bothBody"
  | "resident.quit.unknownTitle"
  | "resident.quit.unknownBody"
  | "resident.quit.now"
  | "resident.quit.stay"
  | "resident.quit.residueTitle"
  | "resident.quit.residueUnknownTitle"
  | "resident.quit.residueUnknownBody"
  | "resident.quit.residueBody"
  | "resident.quit.residueQuitAnyway"
  | "resident.stopped.title"
  | "resident.stopped.body"
  | "resident.stopped.dismiss"
  | "resident.quit.residueStay"
  | "resident.notify.savedTitle"
  | "resident.notify.messageSavedTitle"
  | "resident.notify.messageSavedBody"
  | "resident.notify.savedBody"
  | "resident.notify.attentionTitle"
  | "resident.notify.attentionBody"
  | "resident.notify.failedTitle"
  | "resident.notify.failedBody";

export type Catalog = Readonly<Record<MessageKey, string>>;

/**
 * The notice a user sees the first time closing the window does not quit.
 *
 * It says the app KEEPS RUNNING. It does not say it is receiving: with LAN
 * discovery off or the Device Inbox disabled that would be false, and a resident
 * notice that overstates reachability is worse than no notice — the user would
 * stop looking for the reason transfers are not arriving. Reachability belongs
 * on a surface that knows the actual state.
 */
export const EN: Catalog = {
  "resident.tray.tooltip": "Relayium",
  "resident.tray.show": "Open Relayium",
  "resident.tray.quit": "Quit Relayium",
  "resident.tray.nearby": "Nearby devices",
  "resident.tray.inbox": "Device Inbox",
  "resident.tray.pauseNearby": "Pause Nearby",
  "resident.tray.resumeNearby": "Resume Nearby",
  "resident.firstClose.title": "Relayium is still running",
  "resident.firstClose.body":
    "Closing this window leaves Relayium running in the notification area, so it is ready when you need it. Open it again from the Relayium icon there, or quit it completely.",
  "resident.firstClose.hide": "Keep running",
  "resident.firstClose.quit": "Quit Relayium",
  "resident.firstClose.cancel": "Cancel",
  "resident.login.title": "Open at login",
  "resident.login.body": "Start Relayium when you sign in to Windows.",
  "resident.login.confirmTitle": "Start Relayium at login?",
  "resident.login.confirmBody":
    "Relayium will be added to your Windows startup programs. You can remove it here or in Task Manager at any time.",
  "resident.login.confirm": "Add to startup",
  "resident.login.cancel": "Cancel",
  "resident.login.stateOn": "Relayium starts when you sign in.",
  "resident.login.stateOff": "Relayium does not start when you sign in.",
  "resident.login.stateDisabledByUser":
    "Relayium is listed in your startup programs but is turned off there, so it will not start. Turn it back on in Task Manager, under Startup apps.",
  "resident.login.stateExternallyEnabled":
    "Something else on this PC starts Relayium when you sign in.",
  "resident.quit.transferTitle": "Quit while a transfer is running?",
  "resident.quit.transferBody": "The transfer will stop and will not finish.",
  "resident.quit.localTextTitle": "Quit with unsent text?",
  "resident.quit.localTextBody": "Text you have not sent will be discarded.",
  "resident.quit.bothBody":
    "The transfer will stop and will not finish, and text you have not sent will be discarded.",
  "resident.quit.unknownTitle": "Quit Relayium?",
  "resident.quit.unknownBody":
    "Relayium could not check whether a transfer is running or whether you have unsent text. Quitting now would stop anything still in progress.",
  "resident.quit.now": "Quit",
  "resident.quit.stay": "Stay open",
  "resident.quit.residueTitle": "Some files could not be cleaned up",
  "resident.quit.residueBody":
    "Relayium could not remove everything it had partly written. Quitting now leaves those files on this PC.",
  "resident.quit.residueUnknownTitle": "Quit before everything has stopped?",
  "resident.quit.residueUnknownBody":
    "Relayium could not confirm that everything has stopped. Something may still be sending, and quitting now would end it.",
  "resident.quit.residueQuitAnyway": "Quit anyway",
  "resident.stopped.title": "Relayium has stopped and needs to be restarted",
  "resident.stopped.body":
    "Shutting down did not finish, so Relayium can no longer send or receive. The window is still here, but nothing will work until you quit it and open it again. Quitting from the notification area will try the shutdown once more.",
  "resident.stopped.dismiss": "OK",
  "resident.quit.residueStay": "Stay open",
  "resident.notify.savedTitle": "Files saved",
  "resident.notify.messageSavedTitle": "Message received",
  "resident.notify.messageSavedBody": "Open Relayium to read it.",
  "resident.notify.savedBody": "Open Relayium to see them.",
  "resident.notify.attentionTitle": "Relayium needs your attention",
  "resident.notify.attentionBody": "Open Relayium to continue.",
  "resident.notify.failedTitle": "A transfer did not finish",
  "resident.notify.failedBody": "Open Relayium for details.",
};

export const ZH_HANS: Catalog = {
  "resident.tray.tooltip": "Relayium",
  "resident.tray.show": "打开 Relayium",
  "resident.tray.quit": "退出 Relayium",
  "resident.tray.nearby": "附近设备",
  "resident.tray.inbox": "设备收件箱",
  "resident.tray.pauseNearby": "暂停附近设备",
  "resident.tray.resumeNearby": "恢复附近设备",
  "resident.firstClose.title": "Relayium 仍在运行",
  "resident.firstClose.body":
    "关闭此窗口后，Relayium 会继续在通知区域运行，随时可用。你可以从那里的 Relayium 图标重新打开，或者完全退出。",
  "resident.firstClose.hide": "继续运行",
  "resident.firstClose.quit": "退出 Relayium",
  "resident.firstClose.cancel": "取消",
  "resident.login.title": "登录时启动",
  "resident.login.body": "登录 Windows 时自动启动 Relayium。",
  "resident.login.confirmTitle": "登录时启动 Relayium？",
  "resident.login.confirmBody":
    "Relayium 将被添加到 Windows 启动项。你随时可以在这里或任务管理器中移除。",
  "resident.login.confirm": "添加到启动项",
  "resident.login.cancel": "取消",
  "resident.login.stateOn": "登录时会启动 Relayium。",
  "resident.login.stateOff": "登录时不会启动 Relayium。",
  "resident.login.stateDisabledByUser":
    "Relayium 已在启动项中，但已被禁用，因此不会启动。可在任务管理器的“启动应用”中重新启用。",
  "resident.login.stateExternallyEnabled": "此电脑上有其他设置会在登录时启动 Relayium。",
  "resident.quit.transferTitle": "传输正在进行，仍要退出吗？",
  "resident.quit.transferBody": "传输将中止，且不会完成。",
  "resident.quit.localTextTitle": "还有未发送的文本，仍要退出吗？",
  "resident.quit.localTextBody": "尚未发送的文本将被丢弃。",
  "resident.quit.bothBody": "传输将中止且不会完成，尚未发送的文本也将被丢弃。",
  "resident.quit.unknownTitle": "退出 Relayium？",
  "resident.quit.unknownBody":
    "Relayium 无法确认当前是否有传输正在进行，也无法确认是否有尚未发送的文本。现在退出会中止仍在进行的操作。",
  "resident.quit.now": "退出",
  "resident.quit.stay": "保持运行",
  "resident.quit.residueTitle": "部分文件未能清理",
  "resident.quit.residueBody":
    "Relayium 未能删除它写入的部分内容。现在退出会把这些文件留在此电脑上。",
  "resident.quit.residueUnknownTitle": "尚未确认全部停止，仍要退出吗？",
  "resident.quit.residueUnknownBody":
    "Relayium 无法确认所有操作都已停止，可能仍有内容正在发送，现在退出会将其中断。",
  "resident.quit.residueQuitAnyway": "仍然退出",
  "resident.stopped.title": "Relayium 已停止，需要重新启动",
  "resident.stopped.body":
    "关闭过程未能完成，Relayium 已无法发送或接收。窗口仍在，但在你退出并重新打开之前都不会正常工作。从通知区域退出会再次尝试关闭。",
  "resident.stopped.dismiss": "好",
  "resident.quit.residueStay": "保持运行",
  "resident.notify.savedTitle": "文件已保存",
  "resident.notify.messageSavedTitle": "收到消息",
  "resident.notify.messageSavedBody": "打开 Relayium 查看。",
  "resident.notify.savedBody": "打开 Relayium 查看。",
  "resident.notify.attentionTitle": "Relayium 需要你的确认",
  "resident.notify.attentionBody": "打开 Relayium 继续。",
  "resident.notify.failedTitle": "传输未完成",
  "resident.notify.failedBody": "打开 Relayium 查看详情。",
};

/**
 * Map an OS locale tag onto a maintained language.
 *
 * Electron's `app.getLocale()` returns tags like `zh-CN`, `zh-TW`, `en-GB`.
 *
 * Only **Simplified** Chinese regions resolve to `zh-Hans`. `zh-TW`, `zh-HK`
 * and an explicit `zh-Hant` fall back to English rather than being served
 * Simplified copy: Traditional Chinese is not a maintained language here, and
 * quietly substituting Simplified would claim a support this product does not
 * offer. English is the declared fallback, so that is what they get.
 */
export function resolveLocale(raw: string | undefined): Locale {
  if (!raw) return "en";
  const tag = raw.toLowerCase().replace(/_/g, "-");
  if (tag === "zh" || tag === "zh-hans") return "zh-Hans";
  if (tag.startsWith("zh-hans-")) return "zh-Hans";
  // Region subtags that use the Simplified script.
  if (tag === "zh-cn" || tag === "zh-sg" || tag === "zh-my") return "zh-Hans";
  return "en";
}

export function catalogFor(locale: Locale): Catalog {
  return locale === "zh-Hans" ? ZH_HANS : EN;
}

export type Translate = (key: MessageKey) => string;

/**
 * A lookup bound to one language.
 *
 * The locale is supplied rather than read from `app` so this module imports no
 * Electron and every case is testable without one.
 */
export function translator(locale: Locale): Translate {
  const catalog = catalogFor(locale);
  return (key) => catalog[key];
}
