// Every string this client puts on screen, in the two maintained languages.
//
// ## Why these are here and not imported from `web/src/lib/i18n`
//
// The web catalogue is a page's vocabulary — routes, SEO copy, a download page,
// a browser's permission prompts. Almost none of it describes a desktop app that
// lives in a tray and talks about "this PC". Importing it would give this client
// a large catalogue of strings it must not use and a small number it needs, and
// the maintained-language gate would then be checking the wrong set.
//
// So this is its own catalogue, and it is deliberately small. Where a term is
// genuinely shared product vocabulary it uses the same words the web and Mac
// clients use, because a user who has seen one should recognise the other.
//
// ## The rule the type enforces
//
// `zh` is typed as the same key set as `en`, so a missing translation is a
// compile error rather than a silent English fallback in a Chinese UI. English
// is the source and the fallback; the supported-language policy requires both to
// be complete, and `i18n.test.ts` asserts it at runtime too.

export const en = {
  appName: "Relayium",

  navRealtime: "Transfer now",
  navLan: "Same network",
  navPair: "Pairing code",
  navStored: "Send a link",
  navInbox: "Device Inbox",
  navAccount: "Account",

  thisPc: "This PC",

  // --- Same network -------------------------------------------------------
  lanTitle: "Same network",
  lanSubtitle: "Send to a device on this network, with nothing going through a server.",
  lanOff: "Receiving is off",
  // Says the whole consequence, because it is not obvious and it is not small.
  lanOffBody:
    "This PC is not in the same-network room, so it cannot be seen and cannot see other devices. Turn receiving on to find devices and send to them.",
  lanStart: "Start receiving",
  lanStop: "Stop receiving",
  lanJoining: "Joining…",
  lanEmpty: "No other devices yet",
  lanEmptyBody: "Open Relayium on another device on this network and it will appear here.",
  lanJoiningTitle: "Joining this network…",
  lanJoiningBody: "Looking for Relayium on this network.",
  lanReconnecting: "Reconnecting…",
  lanReconnectingBody: "The connection dropped. Trying again.",
  lanOffline: "Cannot reach Relayium",
  lanOfflineBody:
    "This PC could not join the same-network room, so it cannot see other devices or be seen by them. Check your connection.",
  lanRetry: "Try again",
  lanConnect: "Connect",
  lanConnecting: "Connecting…",
  lanUnsupported: "This device is running an older version and cannot connect.",
  lanDisconnect: "Disconnect",

  // --- Pairing code -------------------------------------------------------
  pairTitle: "Pairing code",
  pairSubtitle: "Transfer between networks using a short code.",
  pairCreate: "Create a code",
  pairCreating: "Creating…",
  pairYourCode: "Your code",
  pairEnterCode: "Enter a code",
  pairJoin: "Join",
  pairJoining: "Joining…",
  pairExpires: "Expires in {minutes} min",
  pairSignedOut: "Sign in to create a code. Joining someone else's code needs no account.",
  pairQuota: "You have used this month's relay allowance. You can still join a code someone else created.",
  pairUnverified: "Verify your email address to create a code.",
  pairRateLimited: "Too many attempts. Wait a moment and try again.",
  pairUnavailable: "Could not reach Relayium. Check your connection and try again.",
  pairBadCode: "A code is six digits.",
  pairRefused: "That code is not valid, or it has expired.",
  pairUnreachable:
    "Could not reach Relayium, so the code could not be checked. This is a connection problem, not a bad code.",

  // --- Connected ----------------------------------------------------------
  linkConnected: "Connected to {peer}",
  linkRequesting: "Asking {peer} to connect…",
  linkConnecting: "Connecting to {peer}…",
  linkInterrupted: "Connection to {peer} was interrupted",
  linkFailed: "Could not connect to {peer}",
  linkCancel: "Cancel",
  pairWaiting: "Waiting for the other device to join…",
  pairDisconnected: "Disconnected",
  pairDisconnectedBody:
    "You disconnected from this device. It is still in the room, so you can connect again.",
  pairReconnect: "Connect again",
  pairRegenerate: "Create a new code",
  pairExpired: "This code has expired",
  pairLeave: "Leave",
  linkSendFiles: "Send files",
  linkSendFolder: "Send a folder",
  linkDropHint: "or drop files here",
  linkMessage: "Message",
  textIncoming: "{peer} wants to start a conversation",
  textAccept: "Accept",
  textDecline: "Decline",
  textWaiting: "Waiting for the other device to accept…",
  textRefused: "The other device declined the conversation.",
  textPeerBusy: "The other device is busy.",
  textUnsupported: "The other device cannot hold a conversation.",
  textTooLong: "That message is too long to send.",
  textDropped: "That message was not sent. It is still in the box.",
  linkSend: "Send",
  linkVerifyTitle: "Check this code matches",
  linkVerifyBody: "Both devices should show the same code.",
  linkVerifyConfirm: "It matches",
  linkVerifyDecline: "It does not match",
  linkVerifyDeclined: "You said the codes did not match, so the connection was closed.",
  linkVerifyPending: "Waiting for the verification code…",
  linkSendFailed: "That message was not sent. It is still in the box.",
  linkStatusIdle: "Not connected",
  linkStatusRequesting: "Asking to connect",
  linkStatusConnecting: "Connecting",
  linkStatusOpen: "Connected",
  linkStatusInterrupted: "Interrupted",
  linkStatusFailed: "Failed",

  // --- Receiving ----------------------------------------------------------
  recvIncoming: "{peer} wants to send {count} file(s)",
  recvAccept: "Choose where to save",
  recvDecline: "Decline",
  recvSaving: "Saving…",
  recvSaved: "Saved to {label}",
  recvPartial: "Saved {done} of {total}. The rest could not be written.",
  recvCancelled: "Cancelled",
  // The honest interim state. Never rendered as a save.
  recvUnsupported:
    "This build can receive the files but cannot yet write them to their final names. Nothing was saved.",
  recvFailedPrefix: "Could not write to the folder you chose.",
  recvFailedPermission: "Relayium is not allowed to write to the folder you chose.",
  recvFailedConflict: "Some files already exist there under the same names.",
  recvFailedTimeout: "The save timed out.",
  recvFailedInternal: "The save could not be completed.",
  recvResidue: "Some incomplete files may still be in that folder.",
  recvSavedCount: "Saved {done} of {total}",

  // --- Account ------------------------------------------------------------
  accountTitle: "Account",
  accountSignedInAs: "Signed in as {email}",
  accountSignedOut: "Not signed in",
  accountWhy: "An account is needed to create a pairing code. Same-network transfers need no account.",
  accountSignIn: "Sign in",
  accountSignOut: "Sign out",
  accountCancel: "Cancel",
  accountRetry: "Try again",
  accountOpening: "Opening your browser…",
  accountEnterCode: "Enter this code in your browser",
  accountExpiresIn: "This code expires in {minutes} min.",
  accountStoreUnreadable:
    "Relayium cannot open its private storage on this PC, so signing in is unavailable. Same-network transfers still work.",

  startingTitle: "Starting Relayium…",
  startingBody: "Preparing secure transfer.",
  startFailedTitle: "Relayium could not start",
  startFailedBody:
    "The encryption library could not be loaded, so transfers cannot run. Nothing has been sent or received.",
  startRetry: "Try again",

  settingsTitle: "Settings",
  settingsVerify: "Ask me to check a verification code",
  settingsVerifyHelp:
    "Every connection is encrypted and authenticated either way. Turn this on to also compare a short code with the other device before anything is sent.",

  settingsUnreadable:
    "Relayium could not read its saved settings on this PC, so it does not know whether you asked to check verification codes. Until you choose below, it asks every time. Nothing has been changed on disk.",
  settingsSaveFailed: "That setting could not be saved.",

  settingsStartup: "Open Relayium at sign-in",
  settingsStartupHelp:
    "Relayium keeps running in the notification area, so it is ready to receive without opening it first.",
  settingsStartupOn: "Relayium starts when you sign in.",
  settingsStartupOff: "Relayium does not start when you sign in.",
  settingsStartupDisabled:
    "Relayium is listed in your startup programs but is turned off there, so it will not start. Turn it back on in Task Manager, under Startup apps.",
  settingsStartupOther: "Something else on this PC starts Relayium when you sign in.",
  settingsStartupUnreadable:
    "Windows could not be asked whether Relayium starts at sign-in, so this is unknown rather than off.",
  settingsStartupWriteFailed: "That could not be changed on this PC.",

  // --- Placeholders -------------------------------------------------------
  soonTitle: "Not in this build yet",
  soonStored: "Sending a download link is not part of this build yet.",
  soonInbox: "Device Inbox is not part of this build yet.",
} as const;

export type MessageKey = keyof typeof en;

export const zh: Record<MessageKey, string> = {
  appName: "Relayium",

  navRealtime: "立即传输",
  navLan: "同一网络",
  navPair: "配对码",
  navStored: "发送链接",
  navInbox: "设备收件箱",
  navAccount: "账户",

  thisPc: "这台电脑",

  lanTitle: "同一网络",
  lanSubtitle: "直接传给同一网络里的设备，不经过服务器。",
  lanOff: "接收已关闭",
  lanOffBody:
    "这台电脑尚未加入同一网络的房间，所以别的设备看不到它，它也看不到别的设备。打开接收后才能发现设备并发送。",
  lanStart: "开始接收",
  lanStop: "停止接收",
  lanJoining: "正在加入…",
  lanEmpty: "还没有其他设备",
  lanEmptyBody: "在同一网络的另一台设备上打开 Relayium，它就会出现在这里。",
  lanJoiningTitle: "正在加入网络…",
  lanJoiningBody: "正在这个网络中查找 Relayium。",
  lanReconnecting: "正在重新连接…",
  lanReconnectingBody: "连接已断开，正在重试。",
  lanOffline: "无法连接 Relayium",
  lanOfflineBody: "这台电脑无法加入同一网络的房间，因此看不到其他设备，也不会被看到。请检查网络连接。",
  lanRetry: "重试",
  lanConnect: "连接",
  lanConnecting: "正在连接…",
  lanUnsupported: "这台设备的版本较旧，无法连接。",
  lanDisconnect: "断开",

  pairTitle: "配对码",
  pairSubtitle: "用一串短码在不同网络之间传输。",
  pairCreate: "创建配对码",
  pairCreating: "正在创建…",
  pairYourCode: "你的配对码",
  pairEnterCode: "输入配对码",
  pairJoin: "加入",
  pairJoining: "正在加入…",
  pairExpires: "{minutes} 分钟后失效",
  pairSignedOut: "创建配对码需要登录。加入别人的配对码不需要账户。",
  pairQuota: "本月的中继流量已用完。你仍然可以加入别人创建的配对码。",
  pairUnverified: "请先验证邮箱地址，然后才能创建配对码。",
  pairRateLimited: "尝试次数过多，请稍候再试。",
  pairUnavailable: "无法连接 Relayium，请检查网络后重试。",
  pairBadCode: "配对码是六位数字。",
  pairRefused: "该配对码无效或已失效。",
  pairUnreachable: "无法连接 Relayium，因此没能校验这串配对码。这是网络问题，不是配对码有误。",

  linkConnected: "已连接到 {peer}",
  linkRequesting: "正在请求连接 {peer}…",
  linkConnecting: "正在连接 {peer}…",
  linkInterrupted: "与 {peer} 的连接已中断",
  linkFailed: "无法连接到 {peer}",
  linkCancel: "取消",
  pairWaiting: "正在等待另一台设备加入…",
  pairDisconnected: "已断开",
  pairDisconnectedBody: "你已与该设备断开连接。对方仍在房间中，可以重新连接。",
  pairReconnect: "重新连接",
  pairRegenerate: "重新创建配对码",
  pairExpired: "配对码已失效",
  pairLeave: "离开",
  linkSendFiles: "发送文件",
  linkSendFolder: "发送文件夹",
  linkDropHint: "也可以把文件拖到这里",
  linkMessage: "消息",
  textIncoming: "{peer} 想开始一段对话",
  textAccept: "接受",
  textDecline: "拒绝",
  textWaiting: "正在等待对方接受…",
  textRefused: "对方拒绝了这段对话。",
  textPeerBusy: "对方正忙。",
  textUnsupported: "对方无法进行对话。",
  textTooLong: "这条消息太长，无法发送。",
  textDropped: "这条消息没有发送成功，内容仍保留在输入框里。",
  linkSend: "发送",
  linkVerifyTitle: "核对这串验证码",
  linkVerifyBody: "两台设备上显示的验证码应当一致。",
  linkVerifyConfirm: "一致",
  linkVerifyDecline: "不一致",
  linkVerifyDeclined: "你选择了「不一致」，连接已关闭。",
  linkVerifyPending: "正在等待验证码…",
  linkSendFailed: "这条消息没有发送成功，内容仍保留在输入框里。",
  linkStatusIdle: "未连接",
  linkStatusRequesting: "正在请求连接",
  linkStatusConnecting: "正在连接",
  linkStatusOpen: "已连接",
  linkStatusInterrupted: "已中断",
  linkStatusFailed: "连接失败",

  recvIncoming: "{peer} 想发送 {count} 个文件",
  recvAccept: "选择保存位置",
  recvDecline: "拒绝",
  recvSaving: "正在保存…",
  recvSaved: "已保存到 {label}",
  recvPartial: "已保存 {done} / {total}，其余未能写入。",
  recvCancelled: "已取消",
  recvUnsupported: "此版本可以接收文件，但还不能把它们写入最终文件名。没有保存任何文件。",
  recvFailedPrefix: "无法写入你选择的文件夹。",
  recvFailedPermission: "Relayium 没有写入该文件夹的权限。",
  recvFailedConflict: "该文件夹中已存在同名文件。",
  recvFailedTimeout: "保存超时。",
  recvFailedInternal: "保存未能完成。",
  recvResidue: "该文件夹中可能仍残留未完成的文件。",
  recvSavedCount: "已保存 {done} / {total}",

  accountTitle: "账户",
  accountSignedInAs: "已登录：{email}",
  accountSignedOut: "未登录",
  accountWhy: "创建配对码需要账户。同一网络的传输不需要账户。",
  accountSignIn: "登录",
  accountSignOut: "退出登录",
  accountCancel: "取消",
  accountRetry: "重试",
  accountOpening: "正在打开浏览器…",
  accountEnterCode: "在浏览器中输入这串代码",
  accountExpiresIn: "此代码将在 {minutes} 分钟后失效。",
  accountStoreUnreadable:
    "Relayium 无法在这台电脑上打开它的私有存储，因此暂时无法登录。同一网络的传输仍然可用。",

  startingTitle: "正在启动 Relayium…",
  startingBody: "正在准备加密传输。",
  startFailedTitle: "Relayium 无法启动",
  startFailedBody: "加密库未能加载，因此无法进行传输。没有发送或接收任何内容。",
  startRetry: "重试",

  settingsTitle: "设置",
  settingsVerify: "每次连接都让我核对验证码",
  settingsVerifyHelp:
    "无论是否开启，每条连接都是加密并经过认证的。开启后，在发送任何内容之前还会让你和对方核对一串短码。",

  settingsUnreadable:
    "Relayium 无法在这台电脑上读取已保存的设置，因此不知道你是否要求核对验证码。在你下面重新选择之前，每次连接都会询问。磁盘上的设置未被改动。",
  settingsSaveFailed: "该设置未能保存。",

  settingsStartup: "登录时启动 Relayium",
  settingsStartupHelp: "Relayium 会在通知区域继续运行，无需先打开就能接收。",
  settingsStartupOn: "登录时会启动 Relayium。",
  settingsStartupOff: "登录时不会启动 Relayium。",
  settingsStartupDisabled:
    "Relayium 已在启动项中，但已被禁用，因此不会启动。可在任务管理器的「启动应用」中重新启用。",
  settingsStartupOther: "此电脑上有其他设置会在登录时启动 Relayium。",
  settingsStartupUnreadable: "无法向 Windows 查询是否登录时启动，因此状态未知，而不是「关闭」。",
  settingsStartupWriteFailed: "该设置在这台电脑上未能更改。",

  soonTitle: "此版本尚未包含",
  soonStored: "此版本尚未包含「发送链接」。",
  soonInbox: "此版本尚未包含「设备收件箱」。",
};

export const CATALOGUES = { en, zh } as const;
export type Lang = keyof typeof CATALOGUES;
