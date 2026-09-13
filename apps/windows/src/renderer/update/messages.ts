// The update pane's vocabulary, in the two maintained languages.
//
// A local catalogue reading the existing `lang()`, so the app catalogue is not
// this batch's to edit. `zh` is typed as the same key set as `en`, so a missing
// translation is a compile error.
//
// Several strings exist because a shorter one would be false:
//
//   * `revealedTitle`/`revealedBody` never say "updated" — the Windows flow ends
//     in a file, not a replaced application.
//   * `readyUnsignedBody` says why there is no publisher identity, promises
//     nothing about how Windows will react, and never suggests turning a
//     protection off.
//   * `verifierUnavailableTitle` is not the unsigned sentence: a check that
//     could not run is not a check that found nothing.
//   * `residueUnread`/`residueFailed` never render as "nothing outstanding".

import { lang } from "../i18n/index.svelte.js";

export const updateEn = {
  paneTitle: "Updates",
  currentVersion: "You are running Relayium {version}.",

  /**
   * Nothing has been read yet, or the first read failed.
   *
   * Deliberately not the `disabled` sentence: that is a claim about this
   * build's signing configuration, and a read that did not happen confirms
   * nothing about it.
   */
  unconfirmedTitle: "Update status is not known yet",
  unconfirmedBody: "Relayium has not been able to read its update status on this PC.",

  /** A REQUEST failed. Not an update state — the channel did not answer. */
  requestFailedRead: "Relayium could not read its update status just now.",
  requestFailedAction: "That request did not reach Relayium.",
  requestFailedNotes: "Relayium could not be asked to open your browser.",
  requestRetry: "Try again",
  requestDismiss: "Dismiss",

  // --- the eighteen states -------------------------------------------------
  disabledEngineeringTitle: "Updates are off in this build",
  disabledEngineeringBody: "This is an engineering build. It does not check for updates.",
  disabledNoPinTitle: "Updates are not available in this build",
  disabledNoPinBody:
    "This build has no update signing key, so it cannot verify an update and will not download one.",

  idleTitle: "Up to date as far as we know",
  idleNeverChecked: "This build has not checked yet.",
  idleLastChecked: "Last checked {when}.",

  checkingTitle: "Checking for updates…",

  upToDateTitle: "Relayium is up to date",
  upToDateBody: "Checked {when}.",

  checkFailedTitle: "Could not check for updates",
  feedUntrustedTitle: "This update could not be trusted",
  /** Terminal by design. No retry, and never an override. */
  feedUntrustedBody:
    "The update information was not signed by Relayium's key, so this build will not download it. There is nothing to retry here.",

  availableTitle: "Relayium {version} is available",
  availableSize: "Download size {size}.",
  releaseNotes: "Release notes",
  notesFailed: "Could not open your browser.",

  downloadingTitle: "Downloading Relayium {version}…",
  downloadingProgress: "{received} of {total}",

  verifyFailedTitle: "The download did not verify",
  verifyFailedBody: "The file did not match what Relayium signed, so it was discarded.",

  readyTitle: "Relayium {version} is ready to install",
  readyBody: "Installing will close Relayium and run the installer.",

  readyUnsignedTitle: "Relayium {version} is ready, without a publisher signature",
  /**
   * Says what we did and did not verify, and stops. It does not predict
   * Windows' behaviour: reputation is not conferred by certificate type, and
   * Smart App Control can block an unsigned installer outright rather than warn.
   */
  readyUnsignedBody:
    "Relayium verified these bytes against its own signed information, but the installer carries no publisher identity because Relayium has no code-signing certificate. Relayium will not run it for you. You can show the file and decide yourself.",
  revealAction: "Show the file",

  publisherMismatchTitle: "This installer is signed by someone else",
  publisherMismatchBody:
    "The installer carries a publisher identity that is not Relayium's. It will not be run, and it should not be run by hand.",

  verifierUnavailableTitle: "The publisher check could not run",
  verifierUnavailableBody:
    "Relayium could not check who signed this installer, so it will not offer to run it. This is not the same as finding no signature.",

  installingTitle: "Installing Relayium {version}…",
  installingBody: "Relayium is closing so the installer can run.",

  installDeferredTitle: "Relayium could not be interrupted",
  installDeferredBody: "The update was not installed. Nothing was changed, and you can try again.",

  /** The unsigned terminus. Never a success sentence. */
  revealedTitle: "The installer has been saved",
  revealedBody:
    "Relayium has not been updated. The installer is on your PC and shown in File Explorer; run it yourself when you are ready.",

  journalUnavailableTitle: "Relayium's update record could not be read",
  journalUnavailableBody: "Nothing was changed. Any downloaded file was left exactly as it is.",

  blockedResidueTitle: "Updates are paused on this PC",
  blockedResidueBody:
    "Relayium could not confirm removing {count} earlier update file(s), so it will not download another. Nothing was deleted.",
  blockedStagingTitle: "Relayium cannot own its update folder",
  blockedStagingBody:
    "The update folder could not be established as Relayium's, so nothing is downloaded and nothing is deleted.",

  // --- actions -------------------------------------------------------------
  checkAction: "Check for updates",
  downloadAction: "Download",
  installAction: "Install and restart",
  working: "Working…",

  // --- reasons, closed set -------------------------------------------------
  reasonNetwork: "Relayium could not be reached.",
  reasonTimeout: "The request took too long.",
  reasonCancelled: "The request was stopped.",
  reasonHttp: "Relayium's update server answered with an error.",
  reasonRedirect: "The update server redirected somewhere this build will not follow.",
  reasonTooLarge: "The response was larger than this build will read.",
  reasonUntrustedHost: "The download pointed at a host this build will not use.",
  reasonMalformed: "The update information was not in a form this version understands.",
  reasonIntegrity: "The downloaded bytes did not match what was signed.",
  reasonStaging: "The update folder could not hold the download.",
  reasonCorrupt: "The local update record is not in a form this version understands.",
  reasonUnreadable: "The local update record could not be read.",
  reasonUnwritable: "The local update record could not be written.",
  reasonUnowned: "The update folder could not be established as Relayium's.",
  reasonIdentityChanged: "The downloaded file is no longer the one that was verified.",
  reasonPublisher: "The installer's publisher is not the expected one.",
  reasonNotLockable: "The installer could not be held still while it was started.",
  reasonNoExpectedPublisher: "This build has no pinned publisher, so it will not run an installer.",
  reasonNoConsentAdapter: "This build cannot ask the rest of the app to pause, so it will not install.",
  reasonCancelledLateGrant: "Permission arrived after the update was cancelled.",
  reasonNotResumed: "Relayium could not confirm it resumed normal work afterwards.",
  reasonPlatformError: "Windows refused the operation.",
  /** The generic fallback for a code this build does not recognise. */
  reasonOther: "The reason was not one this version recognises.",

  retryAction: "Try again",

  // --- residue -------------------------------------------------------------
  residueUnread: "Relayium has not checked for leftover update files yet.",
  residueFailed: "Relayium could not check for leftover update files.",
  residueClean: "No leftover update files.",
  residueCount: "{total} leftover update file(s), {ambiguous} of which may not be Relayium's.",
} as const;

export type UpdateMessageKey = keyof typeof updateEn;

export const updateZh: Record<UpdateMessageKey, string> = {
  paneTitle: "更新",
  currentVersion: "当前运行的是 Relayium {version}。",

  unconfirmedTitle: "尚未获知更新状态",
  unconfirmedBody: "Relayium 还无法在这台电脑上读取自己的更新状态。",

  requestFailedRead: "Relayium 刚才无法读取更新状态。",
  requestFailedAction: "这个请求没有送达 Relayium。",
  requestFailedNotes: "无法请求 Relayium 打开浏览器。",
  requestRetry: "重试",
  requestDismiss: "关闭",

  disabledEngineeringTitle: "此版本已关闭更新",
  disabledEngineeringBody: "这是一个工程版本，不会检查更新。",
  disabledNoPinTitle: "此版本无法使用更新",
  disabledNoPinBody: "此版本没有更新签名密钥，无法验证更新，因此不会下载。",

  idleTitle: "目前没有已知的新版本",
  idleNeverChecked: "此版本还没有检查过。",
  idleLastChecked: "上次检查：{when}。",

  checkingTitle: "正在检查更新…",

  upToDateTitle: "Relayium 已是最新版本",
  upToDateBody: "检查时间：{when}。",

  checkFailedTitle: "无法检查更新",
  feedUntrustedTitle: "此更新无法被信任",
  feedUntrustedBody: "更新信息没有使用 Relayium 的密钥签名，因此此版本不会下载。这里没有可重试的操作。",

  availableTitle: "Relayium {version} 可以更新",
  availableSize: "下载大小 {size}。",
  releaseNotes: "更新说明",
  notesFailed: "无法打开浏览器。",

  downloadingTitle: "正在下载 Relayium {version}…",
  downloadingProgress: "{received} / {total}",

  verifyFailedTitle: "下载内容未通过验证",
  verifyFailedBody: "文件与 Relayium 签名的内容不一致，已被丢弃。",

  readyTitle: "Relayium {version} 已准备好安装",
  readyBody: "安装会关闭 Relayium 并运行安装程序。",

  readyUnsignedTitle: "Relayium {version} 已就绪，但没有发布者签名",
  readyUnsignedBody:
    "Relayium 已根据自己的签名信息验证了这些字节，但安装程序没有发布者标识，因为 Relayium 没有代码签名证书。Relayium 不会替你运行它。你可以让它显示该文件，然后自行决定。",
  revealAction: "显示文件",

  publisherMismatchTitle: "这个安装程序由其他人签名",
  publisherMismatchBody: "安装程序携带的发布者标识不是 Relayium 的。它不会被运行，也不建议手动运行。",

  verifierUnavailableTitle: "无法完成发布者检查",
  verifierUnavailableBody:
    "Relayium 无法确认这个安装程序由谁签名，因此不会提供运行选项。这与“没有找到签名”并不相同。",

  installingTitle: "正在安装 Relayium {version}…",
  installingBody: "Relayium 正在关闭，以便安装程序运行。",

  installDeferredTitle: "无法中断 Relayium",
  installDeferredBody: "更新没有安装。没有任何内容被更改，你可以稍后再试。",

  revealedTitle: "安装程序已保存",
  revealedBody:
    "Relayium 尚未更新。安装程序已保存在这台电脑上并在文件资源管理器中显示；准备好后请自行运行。",

  journalUnavailableTitle: "无法读取 Relayium 的更新记录",
  journalUnavailableBody: "没有任何内容被更改。已下载的文件保持原样。",

  blockedResidueTitle: "这台电脑上的更新已暂停",
  blockedResidueBody: "Relayium 无法确认删除 {count} 个早前的更新文件，因此不会再下载。没有删除任何内容。",
  blockedStagingTitle: "Relayium 无法确认更新文件夹的归属",
  blockedStagingBody: "无法确认更新文件夹属于 Relayium，因此不会下载，也不会删除任何内容。",

  checkAction: "检查更新",
  downloadAction: "下载",
  installAction: "安装并重启",
  working: "处理中…",

  reasonNetwork: "无法连接 Relayium。",
  reasonTimeout: "请求超时。",
  reasonCancelled: "请求已停止。",
  reasonHttp: "Relayium 更新服务器返回了错误。",
  reasonRedirect: "更新服务器重定向到了此版本不会跟随的位置。",
  reasonTooLarge: "响应内容超过了此版本的读取上限。",
  reasonUntrustedHost: "下载指向了此版本不会使用的主机。",
  reasonMalformed: "更新信息的格式不是此版本能理解的。",
  reasonIntegrity: "下载的内容与签名不一致。",
  reasonStaging: "更新文件夹无法容纳此次下载。",
  reasonCorrupt: "本地更新记录的格式不是此版本能理解的。",
  reasonUnreadable: "无法读取本地更新记录。",
  reasonUnwritable: "无法写入本地更新记录。",
  reasonUnowned: "无法确认更新文件夹属于 Relayium。",
  reasonIdentityChanged: "下载的文件已不是先前验证过的那一个。",
  reasonPublisher: "安装程序的发布者不是预期的发布者。",
  reasonNotLockable: "启动时无法锁定安装程序。",
  reasonNoExpectedPublisher: "此版本没有固定的发布者，因此不会运行安装程序。",
  reasonNoConsentAdapter: "此版本无法请求应用其余部分暂停，因此不会安装。",
  reasonCancelledLateGrant: "许可在更新取消之后才到达。",
  reasonNotResumed: "Relayium 无法确认之后已恢复正常工作。",
  reasonPlatformError: "Windows 拒绝了该操作。",
  reasonOther: "此版本无法识别具体原因。",

  retryAction: "重试",

  residueUnread: "Relayium 还没有检查是否有遗留的更新文件。",
  residueFailed: "Relayium 无法检查是否有遗留的更新文件。",
  residueClean: "没有遗留的更新文件。",
  residueCount: "有 {total} 个遗留的更新文件，其中 {ambiguous} 个可能不属于 Relayium。",
};

const CATALOGUES = { en: updateEn, zh: updateZh } as const;

/** One update string. Named `ut` so it cannot be confused with the app's `t`. */
export function ut(key: UpdateMessageKey, values: Record<string, string | number> = {}): string {
  const catalogue = CATALOGUES[lang()] as Record<UpdateMessageKey, string>;
  const template = catalogue[key] ?? updateEn[key];
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}
