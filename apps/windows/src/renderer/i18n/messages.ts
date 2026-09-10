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

  // --- Stored ------------------------------------------------------------
  storedTitle: "Send a link",
  storedSubtitle: "Receive a file someone sent you as a link, or send one yourself.",
  storedReceiveHeading: "Receive from a link",
  storedReceiveBody:
    "Paste the link you were sent. Nothing is downloaded until you choose a folder.",
  storedLinkLabel: "Paste a link",
  storedReceiveAction: "Open link",
  storedCancel: "Cancel",
  storedRetry: "Try again",
  storedFromDeepLink: "A link was opened. Check it, then choose where to save.",
  storedProgress: "Saving… {percent}%",
  storedSaved: "Saved {count} file(s).",
  storedPartial: "Saved {count} of {total}. The rest could not be saved.",
  storedDeclined: "Nothing was downloaded.",
  storedCancelled: "Cancelled. Nothing was saved.",
  storedResidue: "Some partly-written files may still be in that folder.",
  storedUnconfirmed:
    "This could not be confirmed. Check the folder you chose before trying again.",
  storedFailedLinkInvalid: "That is not a Relayium link.",
  storedFailedNotFound: "That link has expired, or has already been used once.",
  storedFailedForbidden: "That link cannot be opened from this account.",
  storedFailedIntegrity:
    "The file did not match its link. Nothing was saved, and trying again will not help — ask the sender for a new link.",
  storedFailedNetwork: "Relayium could not be reached. Check your connection.",
  storedFailedRuntime: "This build could not load what it needs to open the link.",
  storedFailedGeneric: "That link could not be opened.",
  storedAtCapacity: "Finish or cancel a transfer before starting another.",
  storedTooLong: "That link is longer than any Relayium link.",
  storedUnavailable: "Relayium is shutting down.",
  storedRetained: "{count} folder(s) could not be cleaned up.",
  storedRetainedRetry: "Try cleaning up again",
  storedRetainedClean: "Cleaned up.",
  storedRetainedStuck: "Still could not be cleaned up.",
  storedRetainedUnavailable: "Not tried — Relayium is closing. The folder is still tracked.",
  storedSendSoon: "Sending a link is not part of this build yet.",
  storedHistorySoon: "Your sent links will be listed here.",


  // --- Device Inbox -------------------------------------------------------
  inboxTitle: "Device Inbox",
  inboxSubtitle: "Receive files and messages from your own devices, even when this window is closed.",

  // The switch, and what turning it on actually does. Said in full because it
  // is consent: enabling tells Relayium's server this PC can be sent to, and
  // picking the folder is the same act.
  inboxOffTitle: "Receiving is off",
  inboxOffBody:
    "Turn this on to let your other Relayium devices send files and messages to this PC. You choose the folder they arrive in, and you are asked before anything is saved.",
  inboxTurnOn: "Turn on receiving",
  inboxTurnOff: "Turn off receiving",
  inboxOnTitle: "Receiving is on",
  // The resident promise, stated where it can be checked. This is the reason
  // the feature exists on a desktop client rather than in a browser tab.
  inboxBackgroundNote: "Deliveries keep arriving while this window is closed or while you are on another page.",
  inboxCanReceive: "This PC can receive files and messages.",
  inboxCanReceiveFiles: "This PC can receive files.",
  inboxCanReceiveText: "This PC can receive messages.",

  inboxNeedsAccountTitle: "Sign in to use the Device Inbox",
  inboxNeedsAccountBody: "The Device Inbox delivers to your own devices, so it needs the account they share.",
  inboxAccountUnreadableTitle: "This PC's secure storage could not be read",
  // Truthful about the consequence rather than reassuring: the enrolment may
  // well still be live, so this does not say receiving has stopped.
  inboxAccountUnreadableBody:
    "Relayium could not open the encrypted storage that holds this device's keys. Receiving cannot continue until it can, and your messages have not been deleted.",

  inboxFolderMissingTitle: "The receiving folder is not there",
  inboxFolderMissingBody:
    "Receiving is still on, but the folder you chose cannot be found — it may have been moved, renamed, or be on a drive that is disconnected. Choose it again to continue.",
  inboxChooseFolder: "Choose folder",
  inboxChangeFolder: "Change folder",
  inboxFolderChosen: "Files will arrive in the folder you chose.",

  inboxStartingTitle: "Starting…",
  inboxStartingBody: "Registering this PC with your account.",
  inboxIdleTitle: "Waiting for deliveries",
  inboxIdleBody: "Nothing is waiting right now.",
  inboxReceivingTitle: "Receiving…",
  inboxReceivingBody: "A delivery is being saved.",
  inboxBlockedTitle: "Something needs a decision",
  inboxBlockedBody:
    "A delivery stopped in a way Relayium cannot resolve on its own. It has not been discarded and it will not be retried automatically.",
  inboxOfflineTitle: "Cannot reach Relayium",
  inboxOfflineBody: "Trying again in {seconds}s.",
  inboxRetryNow: "Try again now",
  inboxUnavailableTitle: "Not available in this build",
  inboxUnavailableBody: "This build cannot receive deliveries yet, so there is nothing to switch on.",
  inboxWithdrawalPending:
    "Relayium could not tell the server this PC has stopped receiving. It will keep trying; until it succeeds, your other devices may still offer to send here.",

  inboxPendingHeading: "Waiting for you",
  inboxPendingEmpty: "Nothing is waiting.",
  inboxPendingItem: "{bytes} from one of your devices",
  inboxAccept: "Accept",
  inboxReject: "Decline",
  inboxAcceptedSaved: "Saved.",
  inboxAcceptedSavedMessage: "Message saved.",
  inboxAcceptedPartial: "Partly saved: {saved} of {total} files.",
  inboxAcceptedQueued: "Accepted. It will be received shortly.",
  inboxAcceptedBlocked: "This delivery needs a decision and was not received.",
  inboxAcceptedSettled: "That delivery is no longer waiting.",
  inboxAcceptedBusy: "Another delivery is being received. Try again in a moment.",
  inboxAcceptedRefused: "Not accepted — Relayium is closing.",
  inboxAckPending: "Saved. The server has not confirmed yet.",

  inboxMessagesHeading: "Messages",
  inboxMessagesEmpty: "No messages yet.",
  inboxMessageItem: "From one of your devices",
  inboxOpen: "Open",
  inboxClose: "Close",
  inboxCopy: "Copy",
  inboxCopied: "Copied",
  inboxCopyFailed: "Could not copy",
  inboxCopyFailedBody: "The message could not be read just now. Select the text above and copy it.",
  inboxDelete: "Delete",
  inboxMessageKept: "Messages stay on this PC until you delete them. Turning receiving off does not remove them.",

  inboxDeviceHeading: "This device",
  inboxDeviceUnnamed: "Not named yet",
  inboxRenameLabel: "Device name",
  inboxRename: "Rename",
  inboxRenamed: "Renamed.",

  inboxRetainedHeading: "Could not be cleaned up",
  inboxRetainedBody:
    "A delivery was stopped and Relayium could not confirm that the partly-written files were removed. You can ask it to try again.",
  inboxRetainedRetry: "Try cleanup again",

  inboxDeclined: "No folder was chosen, so nothing was turned on.",
  inboxEnabledNotice: "Receiving is on.",
  inboxDisabledNotice: "Receiving is off. Your messages and keys are untouched.",
  inboxRefused: "Not done — Relayium is closing.",
  inboxSuperseded: "That was replaced by a newer change, so nothing was altered.",
  inboxFailed: "That did not work. Relayium will try again on its own.",


  // --- Send a link -------------------------------------------------------
  sendHeading: "Send a link",
  sendBody:
    "Choose files or a folder. They are encrypted on this PC before anything is uploaded, and the key travels in the link rather than to the server.",
  sendPickFiles: "Choose files",
  sendPickFolder: "Choose folder",
  sendPicked: "{count} file(s), {size}",
  sendClear: "Clear",
  sendStart: "Encrypt and upload",
  sendCancel: "Cancel",
  sendUploading: "Uploading… {percent}%",
  sendBurn: "Delete after it is opened once",
  sendExpiry: "Link expires after",
  sendExpiryDays: "{days} day(s)",

  sendPublished: "Ready to share.",
  sendLinkLabel: "Link",
  sendCopy: "Copy link",
  sendCopied: "Copied",
  sendCopyFailed: "Could not copy",
  sendRecheckedPublished: "Confirmed — it is shared.",
  sendRecheckedUnknown: "Still could not be confirmed. Nothing was discarded.",
  // The distinction the whole outcome union exists for. Never softened.
  sendAmbiguous: "Relayium could not confirm what happened",
  sendAmbiguousBody:
    "The upload may or may not have completed. Nothing has been discarded and the key is still here, so you can check again.",
  sendCheckAgain: "Check again",
  sendFailed: "The upload did not finish",
  sendFailedBody: "Nothing was uploaded. You can try again.",
  sendCancelled: "Cancelled. Nothing was uploaded.",
  sendRefusedUnavailable:
    "Not right now. Relayium is either closing or could not confirm your account — nothing was uploaded.",
  sendRefusedCapacity: "Too many uploads are already running. Wait for one to finish.",
  sendRefusedSignedOut: "Sign in to send a link.",
  sendRefusedNothing: "Choose something to send first.",
  sendRefusedManifest: "Those files cannot be sent together. Try choosing them again.",
  sendRefusedGeneric: "That could not be started.",

  sendHistoryHeading: "Sent links",
  sendHistoryEmpty: "You have not sent anything yet.",
  sendHistoryUnavailable:
    "Your sent links could not be read just now. They have not been deleted — this is a problem reading them, not a missing history.",
  sendHistoryItem: "{count} file(s), {size}",
  sendHistoryPublished: "Shared",
  sendHistoryAmbiguous: "Unconfirmed",
  sendHistoryClosed: "Deleted",
  sendHistoryExpires: "Expires {when}",
  sendHistoryBurn: "Opens once",
  sendShowLink: "Show link",
  sendHideLink: "Hide link",
  sendDelete: "Delete",
  sendDeleted: "Deleted.",
  sendDeleteFailed: "It could not be deleted. Nothing was changed.",

  // --- Placeholders -------------------------------------------------------
  soonTitle: "Not in this build yet",
  soonStored: "Sending a download link is not part of this build yet.",
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

  storedTitle: "发送链接",
  storedSubtitle: "接收别人以链接发给你的文件，或者自己发送一个。",
  storedReceiveHeading: "从链接接收",
  storedReceiveBody: "粘贴收到的链接。在你选择文件夹之前，不会下载任何内容。",
  storedLinkLabel: "粘贴链接",
  storedReceiveAction: "打开链接",
  storedCancel: "取消",
  storedRetry: "重试",
  storedFromDeepLink: "已打开一个链接。确认后选择保存位置。",
  storedProgress: "正在保存…… {percent}%",
  storedSaved: "已保存 {count} 个文件。",
  storedPartial: "已保存 {count} / {total}，其余未能保存。",
  storedDeclined: "未下载任何内容。",
  storedCancelled: "已取消，未保存任何内容。",
  storedResidue: "该文件夹中可能仍有写了一半的文件。",
  storedUnconfirmed: "结果无法确认。请先检查你选择的文件夹，再决定是否重试。",
  storedFailedLinkInvalid: "这不是 Relayium 链接。",
  storedFailedNotFound: "该链接已过期，或已被使用过一次。",
  storedFailedForbidden: "此账户无法打开该链接。",
  storedFailedIntegrity:
    "文件与链接不匹配。没有保存任何内容，重试也无济于事——请让发送方重新发一个链接。",
  storedFailedNetwork: "无法连接 Relayium，请检查网络。",
  storedFailedRuntime: "此版本无法加载打开链接所需的组件。",
  storedFailedGeneric: "无法打开该链接。",
  storedAtCapacity: "请先完成或取消一个传输，再开始新的。",
  storedTooLong: "该链接超过了 Relayium 链接的长度。",
  storedUnavailable: "Relayium 正在退出。",
  storedRetained: "有 {count} 个文件夹未能清理。",
  storedRetainedRetry: "再次尝试清理",
  storedRetainedClean: "已清理。",
  storedRetainedStuck: "仍未能清理。",
  storedRetainedUnavailable: "未尝试：Relayium 正在关闭。该文件夹仍在跟踪中。",
  storedSendSoon: "此版本尚未包含「发送链接」。",
  storedHistorySoon: "你发送过的链接会显示在这里。",


  inboxTitle: "设备收件箱",
  inboxSubtitle: "接收来自你自己设备的文件和消息，即使此窗口已关闭。",

  inboxOffTitle: "接收已关闭",
  inboxOffBody:
    "打开后，你的其他 Relayium 设备就可以向这台电脑发送文件和消息。你来选择接收文件夹，保存任何内容前都会先征得你的同意。",
  inboxTurnOn: "打开接收",
  inboxTurnOff: "关闭接收",
  inboxOnTitle: "接收已打开",
  inboxBackgroundNote: "即使此窗口已关闭，或你正在其他页面，也会继续接收。",
  inboxCanReceive: "这台电脑可以接收文件和消息。",
  inboxCanReceiveFiles: "这台电脑可以接收文件。",
  inboxCanReceiveText: "这台电脑可以接收消息。",

  inboxNeedsAccountTitle: "登录后才能使用设备收件箱",
  inboxNeedsAccountBody: "设备收件箱只在你自己的设备之间投递，因此需要它们共用的账号。",
  inboxAccountUnreadableTitle: "无法读取这台电脑的加密存储",
  inboxAccountUnreadableBody:
    "Relayium 无法打开保存本设备密钥的加密存储。在此之前无法继续接收，你的消息不会被删除。",

  inboxFolderMissingTitle: "接收文件夹不存在",
  inboxFolderMissingBody:
    "接收仍处于打开状态，但找不到你选择的文件夹——它可能已被移动、重命名，或所在的磁盘已断开。重新选择即可继续。",
  inboxChooseFolder: "选择文件夹",
  inboxChangeFolder: "更换文件夹",
  inboxFolderChosen: "文件会保存到你选择的文件夹。",

  inboxStartingTitle: "正在启动…",
  inboxStartingBody: "正在将这台电脑注册到你的账号。",
  inboxIdleTitle: "等待投递",
  inboxIdleBody: "当前没有待处理的内容。",
  inboxReceivingTitle: "正在接收…",
  inboxReceivingBody: "正在保存一次投递。",
  inboxBlockedTitle: "有内容需要你决定",
  inboxBlockedBody:
    "一次投递以 Relayium 无法自行解决的方式中断了。它没有被丢弃，也不会自动重试。",
  inboxOfflineTitle: "无法连接 Relayium",
  inboxOfflineBody: "将在 {seconds} 秒后重试。",
  inboxRetryNow: "立即重试",
  inboxUnavailableTitle: "此版本尚未包含",
  inboxUnavailableBody: "此版本还不能接收投递，因此没有可开启的开关。",
  inboxWithdrawalPending:
    "Relayium 未能告知服务器这台电脑已停止接收。它会继续尝试；在此之前，你的其他设备可能仍会显示可以发送到这里。",

  inboxPendingHeading: "等待你处理",
  inboxPendingEmpty: "没有等待处理的内容。",
  inboxPendingItem: "来自你的某台设备，{bytes}",
  inboxAccept: "接受",
  inboxReject: "拒绝",
  inboxAcceptedSaved: "已保存。",
  inboxAcceptedSavedMessage: "消息已保存。",
  inboxAcceptedPartial: "部分保存：{total} 个文件中已保存 {saved} 个。",
  inboxAcceptedQueued: "已接受，稍后开始接收。",
  inboxAcceptedBlocked: "这次投递需要你的决定，尚未接收。",
  inboxAcceptedSettled: "该投递已不在等待中。",
  inboxAcceptedBusy: "正在接收另一次投递，请稍后再试。",
  inboxAcceptedRefused: "未接受：Relayium 正在关闭。",
  inboxAckPending: "已保存。服务器尚未确认。",

  inboxMessagesHeading: "消息",
  inboxMessagesEmpty: "还没有消息。",
  inboxMessageItem: "来自你的某台设备",
  inboxOpen: "打开",
  inboxClose: "关闭",
  inboxCopy: "复制",
  inboxCopied: "已复制",
  inboxCopyFailed: "无法复制",
  inboxCopyFailedBody: "此刻无法读取该消息。请选中上面的文本自行复制。",
  inboxDelete: "删除",
  inboxMessageKept: "消息会保留在这台电脑上，直到你删除它们。关闭接收不会删除消息。",

  inboxDeviceHeading: "本设备",
  inboxDeviceUnnamed: "尚未命名",
  inboxRenameLabel: "设备名称",
  inboxRename: "重命名",
  inboxRenamed: "已重命名。",

  inboxRetainedHeading: "未能清理",
  inboxRetainedBody:
    "一次投递被中断，Relayium 无法确认已写入的部分文件是否已被清除。你可以让它再试一次。",
  inboxRetainedRetry: "重试清理",

  inboxDeclined: "未选择文件夹，因此没有打开任何功能。",
  inboxEnabledNotice: "接收已打开。",
  inboxDisabledNotice: "接收已关闭。你的消息和密钥不受影响。",
  inboxRefused: "未执行：Relayium 正在关闭。",
  inboxSuperseded: "该操作已被更新的更改取代，因此未做任何改动。",
  inboxFailed: "操作未成功。Relayium 会自行重试。",


  sendHeading: "发送链接",
  sendBody:
    "选择文件或文件夹。上传前会先在这台电脑上加密，密钥只存在于链接中，不会发送到服务器。",
  sendPickFiles: "选择文件",
  sendPickFolder: "选择文件夹",
  sendPicked: "{count} 个文件，{size}",
  sendClear: "清除",
  sendStart: "加密并上传",
  sendCancel: "取消",
  sendUploading: "正在上传… {percent}%",
  sendBurn: "被打开一次后即删除",
  sendExpiry: "链接有效期",
  sendExpiryDays: "{days} 天",

  sendPublished: "可以分享了。",
  sendLinkLabel: "链接",
  sendCopy: "复制链接",
  sendCopied: "已复制",
  sendCopyFailed: "无法复制",
  sendRecheckedPublished: "已确认：已分享。",
  sendRecheckedUnknown: "仍无法确认。没有丢弃任何内容。",
  sendAmbiguous: "Relayium 无法确认结果",
  sendAmbiguousBody:
    "本次上传可能已完成，也可能没有。没有丢弃任何内容，密钥仍在，你可以再检查一次。",
  sendCheckAgain: "再检查一次",
  sendFailed: "上传未完成",
  sendFailedBody: "没有上传任何内容。你可以重试。",
  sendCancelled: "已取消，没有上传任何内容。",
  sendRefusedUnavailable:
    "暂时无法进行。Relayium 正在关闭，或者无法确认你的账号——没有上传任何内容。",
  sendRefusedCapacity: "同时进行的上传过多。请等待其中一个完成。",
  sendRefusedSignedOut: "登录后才能发送链接。",
  sendRefusedNothing: "请先选择要发送的内容。",
  sendRefusedManifest: "这些文件无法一起发送。请重新选择。",
  sendRefusedGeneric: "无法开始。",

  sendHistoryHeading: "已发送的链接",
  sendHistoryEmpty: "你还没有发送过任何内容。",
  sendHistoryUnavailable:
    "此刻无法读取你发送过的链接。它们并未被删除——这是读取问题，不是历史为空。",
  sendHistoryItem: "{count} 个文件，{size}",
  sendHistoryPublished: "已分享",
  sendHistoryAmbiguous: "未确认",
  sendHistoryClosed: "已删除",
  sendHistoryExpires: "{when} 过期",
  sendHistoryBurn: "只能打开一次",
  sendShowLink: "显示链接",
  sendHideLink: "隐藏链接",
  sendDelete: "删除",
  sendDeleted: "已删除。",
  sendDeleteFailed: "删除失败，没有做任何更改。",

  soonTitle: "此版本尚未包含",
  soonStored: "此版本尚未包含「发送链接」。",
};

export const CATALOGUES = { en, zh } as const;
export type Lang = keyof typeof CATALOGUES;
