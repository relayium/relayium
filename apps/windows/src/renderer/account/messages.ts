// The account detail screen's own vocabulary, in the two maintained languages.
//
// ## Why a local catalogue
//
// `src/renderer/i18n/messages.ts` is the app's catalogue and it is not this
// batch's to edit — the sign-in card, the settings and every other page share
// it. This module adds strings for the surface below it without touching that
// file, and it reads the SAME language signal (`lang()`), so there is still one
// answer to "what language is this app in" rather than two that agree until
// they don't.
//
// The rule from the app catalogue is kept exactly: `zh` is typed as the same key
// set as `en`, so a missing translation is a compile error rather than a silent
// English sentence in a Chinese UI. English is the source and the fallback.
//
// ## Why the wording is careful
//
// Most of what follows is about a person's money, their storage and which of
// their machines can reach their files, and several of these strings exist
// precisely because a shorter one would have been a lie:
//
// * `capUnlimited` rather than a "0" or an empty bar.
// * `usageUnavailable` rather than "0 of 0 used" when a read failed.
// * `mutationUncertain` rather than "failed" — the request may have been
//   performed and this app cannot tell.
// * `planFromProfileOnly` rather than quietly showing a tier id as a plan name.

import { lang } from "../i18n/index.svelte.js";

export const accountEn = {
  detailsTitle: "Account details",

  // --- Profile ------------------------------------------------------------
  profileTitle: "Profile",
  profileName: "Name",
  profileEmail: "Email",
  profileNoName: "No name set",
  profileVerified: "Email verified",
  profileUnverified: "Email not verified",
  // The way out of the state the badge above states. macOS's wording, kept
  // word for word: two clients saying the same thing differently about the
  // same email is two things to learn.
  resendAction: "Send the email again",
  resendSending: "Sending…",
  /**
   * True whatever the server decided.
   *
   * `POST /api/auth/email/resend` answers 200 in every case — it will not say
   * whether an account exists, whether it was already verified, or whether a
   * throttle swallowed the request. So the only honest claim is that it was
   * asked for, and the spam-folder line covers the case where it does not
   * arrive. This is macOS's sentence, unchanged.
   */
  resendRequested: "Requested. If it doesn't arrive, check your spam folder.",
  /** Somebody finished verifying elsewhere while this screen was open. */
  resendAlreadyVerified: "That address is already verified.",
  resendBusy: "That request is already running.",
  profileMethods: "Sign-in methods",
  profileMethodNone: "None recorded",

  // --- Plan and usage -----------------------------------------------------
  planTitle: "Plan",
  /** The tier id, shown only when the plan name could not be read. */
  planFromProfileOnly: "Plan {planId}. Details could not be loaded.",
  planIncludedStorage: "Included storage",
  planIncludedTraffic: "Included transfer, per month",
  planRetention: "Links are kept for",
  planRetentionDays: "{count} days",
  planRetentionHours: "{count} hours",
  planRetentionMinutes: "{count} minutes",
  planRetentionUnlimited: "As long as you keep them",
  capUnlimited: "Unlimited",

  usageTitle: "This month",
  usageTraffic: "Transfer used",
  usageStorage: "Storage used",
  usageOf: "{used} of {cap}",
  usageOfUnlimited: "{used} used · no limit",
  usageResets: "Resets {date}",
  usagePeriod: "Period {period}",
  /**
   * Said in full, because the alternative reading is the dangerous one: a
   * person who sees an empty bar concludes they have used nothing.
   */
  usageEffectiveNote: "Measured against the allowance in force this month.",

  // --- Subscription -------------------------------------------------------
  subscriptionTitle: "Subscription",
  subscriptionStatus: "Status",
  /**
   * The provider's own lifecycle states, in words.
   *
   * The set is `server/account/billing_authority.go:349` — the statuses the
   * server itself enumerates — and nothing beyond it. None of these is a claim
   * about ENTITLEMENT: "Cancelled" means the provider will not renew, not that
   * access has stopped, which is why the period-end date is stated separately
   * and why the plan card is a different card.
   */
  statusActive: "Active",
  statusTrialing: "Free trial",
  statusPastDue: "Payment overdue",
  statusCanceled: "Cancelled",
  statusIncompleteExpired: "Never completed",
  /**
   * A token this build does not recognise.
   *
   * The raw value is kept, because it is the truth and a support conversation
   * may need it, but the sentence around it is translated — an unmapped token
   * used to render as a bare English word in a Chinese UI. Nothing is inferred
   * from it: an unknown status is not treated as active, cancelled, or paid.
   */
  statusUnrecognised: "Unrecognised status ({status})",
  subscriptionProvider: "Managed by",
  providerStripe: "Card subscription",
  providerApple: "The App Store",
  providerAdmin: "An administrator grant",
  providerMultiple: "More than one provider",
  providerNone: "No paid subscription",
  subscriptionCycle: "Billing period",
  cycleMonthly: "Monthly",
  cycleYearly: "Yearly",
  cycleUnknown: "Not known",
  subscriptionEnds: "Current period ends {date}",
  subscriptionScheduled: "Changing to {plan} at the end of this period",
  subscriptionScheduledUnnamed: "A plan change is scheduled for the end of this period",
  renewalOn: "Renews automatically on {date}",
  renewalOff: "Will not renew after {date}",
  renewalRetry: "The App Store is retrying the payment.",
  renewalGrace: "Your subscription is in its grace period until {date}.",
  manageAccount: "Manage account on the web",
  manageFailed: "Could not open your browser.",

  // --- Devices ------------------------------------------------------------
  devicesTitle: "Your devices",
  devicesEmpty: "No devices are signed in to this account.",
  deviceUnnamed: "Unnamed device",
  deviceEnrolled: "Device Inbox on",
  deviceLastSeen: "Last used {date}",
  deviceNeverSeen: "Not used yet",
  deviceAdded: "Added {date}",
  deviceRename: "Rename",
  deviceRenameLabel: "Device name",
  deviceRenameSave: "Save",
  deviceRenameCancel: "Cancel",
  deviceRenameTooLong: "{count} characters over the limit",
  deviceRevoke: "Sign out",
  deviceRevokeConfirm: "Sign {name} out of this account?",
  /** The self-revoke warning. It says the consequence, because it is large. */
  deviceRevokeConfirmSelf:
    "Sign this PC out of your account? Relayium on this PC will be signed out immediately, and you will need to sign in again to use your account.",
  deviceRevokeConfirmYes: "Sign out",
  deviceRevokeConfirmNo: "Keep it",
  deviceWorking: "Working…",

  // --- Failures -----------------------------------------------------------
  retry: "Try again",
  recheck: "Check again",
  failedSignedOut: "You are not signed in.",
  failedUnavailable: "Your account could not be read on this PC.",
  failedNetwork: "Could not reach Relayium.",
  failedTimeout: "Relayium took too long to answer.",
  failedRefused: "Relayium refused this request.",
  failedRefusedStatus: "Relayium refused this request ({status}).",
  /**
   * The closed-schema case, including a NEWER server this build cannot read.
   * Deliberately not "something went wrong": it says which side is out of date.
   */
  failedUnreadable: "This version of Relayium could not read the answer.",
  profileUnavailable: "Your profile could not be loaded.",
  usageUnavailable: "Your usage could not be loaded.",
  devicesUnavailable: "Your device list could not be loaded.",

  // --- Mutation outcomes --------------------------------------------------
  mutationUnknownDevice: "That device is no longer in your list.",
  mutationInvalidName: "That name cannot be used. Try a different one.",
  mutationBusy: "That device is already being changed.",
  mutationSignedOut: "You are not signed in any more.",
  mutationUnavailable: "That could not be done right now.",
  /** Neither "done" nor "failed", because this app genuinely does not know. */
  mutationUncertain:
    "The answer never arrived, so it is not known whether this was applied. Check again before trying it once more.",
  revokedSelfSignedOut: "This PC has been signed out.",
  revokedSelfKept: "That device was signed out. This app is already on a different account.",
} as const;

export type AccountMessageKey = keyof typeof accountEn;

export const accountZh: Record<AccountMessageKey, string> = {
  detailsTitle: "账户详情",

  profileTitle: "个人资料",
  profileName: "名称",
  profileEmail: "邮箱",
  profileNoName: "未设置名称",
  profileVerified: "邮箱已验证",
  profileUnverified: "邮箱未验证",
  resendAction: "重新发送验证邮件",
  resendSending: "正在发送…",
  resendRequested: "已提交请求。如果没有收到，请查看垃圾邮件文件夹。",
  resendAlreadyVerified: "该邮箱地址已经通过验证。",
  resendBusy: "该请求正在进行中。",
  profileMethods: "登录方式",
  profileMethodNone: "没有记录",

  planTitle: "套餐",
  planFromProfileOnly: "套餐 {planId}。详细信息未能加载。",
  planIncludedStorage: "包含存储空间",
  planIncludedTraffic: "每月包含传输量",
  planRetention: "链接保留",
  planRetentionDays: "{count} 天",
  planRetentionHours: "{count} 小时",
  planRetentionMinutes: "{count} 分钟",
  planRetentionUnlimited: "保留到你自己删除",
  capUnlimited: "无限制",

  usageTitle: "本月",
  usageTraffic: "已用传输量",
  usageStorage: "已用存储空间",
  usageOf: "{used} / {cap}",
  usageOfUnlimited: "已用 {used} · 无限制",
  usageResets: "{date} 重置",
  usagePeriod: "计费周期 {period}",
  usageEffectiveNote: "按本月实际生效的额度计算。",

  subscriptionTitle: "订阅",
  subscriptionStatus: "状态",
  statusActive: "有效",
  statusTrialing: "试用中",
  statusPastDue: "付款逾期",
  statusCanceled: "已取消",
  statusIncompleteExpired: "未完成，已过期",
  statusUnrecognised: "无法识别的状态（{status}）",
  subscriptionProvider: "订阅渠道",
  providerStripe: "银行卡订阅",
  providerApple: "App Store",
  providerAdmin: "管理员授予",
  providerMultiple: "多个渠道",
  providerNone: "没有付费订阅",
  subscriptionCycle: "计费周期",
  cycleMonthly: "按月",
  cycleYearly: "按年",
  cycleUnknown: "未知",
  subscriptionEnds: "本期到 {date} 结束",
  subscriptionScheduled: "本期结束后将变更为 {plan}",
  subscriptionScheduledUnnamed: "本期结束后将变更套餐",
  renewalOn: "将于 {date} 自动续订",
  renewalOff: "{date} 之后不再续订",
  renewalRetry: "App Store 正在重试扣款。",
  renewalGrace: "订阅处于宽限期，到 {date} 为止。",
  manageAccount: "在网页端管理账户",
  manageFailed: "无法打开浏览器。",

  devicesTitle: "你的设备",
  devicesEmpty: "这个账户下没有已登录的设备。",
  deviceUnnamed: "未命名设备",
  deviceEnrolled: "已开启设备收件箱",
  deviceLastSeen: "最近使用：{date}",
  deviceNeverSeen: "还没有使用过",
  deviceAdded: "添加于 {date}",
  deviceRename: "重命名",
  deviceRenameLabel: "设备名称",
  deviceRenameSave: "保存",
  deviceRenameCancel: "取消",
  deviceRenameTooLong: "超出 {count} 个字符",
  deviceRevoke: "退出登录",
  deviceRevokeConfirm: "要让 {name} 退出这个账户吗？",
  deviceRevokeConfirmSelf:
    "要让这台电脑退出你的账户吗？这台电脑上的 Relayium 会立即退出登录，需要重新登录才能继续使用账户功能。",
  deviceRevokeConfirmYes: "退出登录",
  deviceRevokeConfirmNo: "保留",
  deviceWorking: "处理中…",

  retry: "重试",
  recheck: "重新检查",
  failedSignedOut: "你还没有登录。",
  failedUnavailable: "这台电脑无法读取你的账户。",
  failedNetwork: "无法连接 Relayium。",
  failedTimeout: "Relayium 响应超时。",
  failedRefused: "Relayium 拒绝了这个请求。",
  failedRefusedStatus: "Relayium 拒绝了这个请求（{status}）。",
  failedUnreadable: "当前版本的 Relayium 无法读取返回的内容。",
  profileUnavailable: "未能加载你的个人资料。",
  usageUnavailable: "未能加载你的用量。",
  devicesUnavailable: "未能加载你的设备列表。",

  mutationUnknownDevice: "这个设备已经不在你的列表里了。",
  mutationInvalidName: "这个名称不能使用，请换一个。",
  mutationBusy: "这个设备正在处理另一项操作。",
  mutationSignedOut: "你已经退出登录了。",
  mutationUnavailable: "现在无法完成这个操作。",
  mutationUncertain: "没有收到结果，因此无法确定是否已经生效。请先重新检查，再决定是否重试。",
  revokedSelfSignedOut: "这台电脑已退出登录。",
  revokedSelfKept: "那个设备已退出登录。这个应用现在使用的是另一个账户。",
};

const CATALOGUES = { en: accountEn, zh: accountZh } as const;

/**
 * One account string, with its placeholders filled.
 *
 * Named `at` rather than `t` on purpose: a component imports both, and two
 * functions called `t` in one file is how a string ends up looked up in the
 * wrong catalogue and silently rendered as its own key.
 */
export function at(key: AccountMessageKey, values: Record<string, string | number> = {}): string {
  const catalogue = CATALOGUES[lang()] as Record<AccountMessageKey, string>;
  const template = catalogue[key] ?? accountEn[key];
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}
