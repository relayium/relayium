import { forgetAllUploadKeys } from "./upload-keys";
import { clearHistory } from "./history";
// Session + account state for Relayium, driven by Svelte 5 runes. The LAN transfer
// flow does not depend on this; login only gates future cross-network features.

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  hasPassword: boolean;
  // Ways this account can sign in: "password" (if set) + linked OAuth providers
  // ("google"/"apple"). Absent on older responses → treated as empty.
  linkedMethods?: string[];
  // Billing (phase-2, all optional so older mocks/tests without them still
  // typecheck): current plan id ("free" absent a subscription), the raw
  // Stripe subscription status ("", "active", "past_due", "canceled", ...),
  // its current-period end (unix seconds, 0 = none), and whether a Stripe
  // customer exists yet (gates the "Manage billing" button).
  planId?: string;
  subscriptionStatus?: string;
  subscriptionEnd?: number;
  hasBilling?: boolean;
  // Tier a pending period-end downgrade will switch to ("" / absent = none). Lets
  // the pricing UI show a "scheduled downgrade" banner with a cancel action.
  scheduledPlanId?: string;
  // Billing cycle of the active subscription: "monthly" | "yearly", or ""/absent
  // when unknown (a subscription predating the column). Unknown must NOT be read
  // as monthly — that would offer "switch to yearly" to someone already yearly.
  billingCycle?: string;
}

let user = $state<SessionUser | null>(null);

export function session(): { user: SessionUser | null } {
  return { user };
}

/**
 * 带凭据的 JSON 请求。**永不抛**：请求根本没到服务器（离线 / DNS / CORS）时返回
 * null，调用方一律把它翻译成 `{ ok: false, error: "network" }`——这个区分对表单很
 * 重要，"没发出去" 和 "服务器拒绝了" 要给用户不同的话术。
 *
 * 抽出来之前这段 try/fetch/catch 在本文件里逐字重复了七遍，每一遍都得记得
 * credentials 和 Content-Type 两件事，漏一个就是一次静默的未登录请求。
 */
async function apiSend(path: string, init: RequestInit = {}): Promise<Response | null> {
  try {
    return await fetch(path, {
      credentials: "include",
      ...init,
      headers: init.body ? { "Content-Type": "application/json", ...init.headers } : init.headers,
    });
  } catch {
    return null;
  }
}

/** JSON body 里的 `error` 字段；body 不是 JSON（网关的 HTML 错误页）时给回退值。 */
async function errorCode(res: Response, fallback = "error"): Promise<string> {
  try {
    return ((await res.json()) as { error?: string }).error ?? fallback;
  } catch {
    return fallback; // 非 JSON 响应体
  }
}

export async function refreshSession(): Promise<void> {
  const res = await fetch("/api/me", { credentials: "include" });
  if (res.ok) {
    const body = (await res.json()) as { user: SessionUser };
    user = body.user;
  } else {
    user = null;
  }
}

export async function requestMagicLink(
  email: string,
): Promise<{ ok: boolean; error?: string }> {
  const form = new URLSearchParams({ email });
  const res = await apiSend("/api/auth/magic/request", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!res) return { ok: false, error: "network" };
  // A 429/500 must not read as "link sent" — the caller shows an error instead.
  if (!res.ok) return { ok: false, error: "error" };
  return { ok: true };
}

// Session/role markers stashed by the cross-network flows; cleared on logout so a
// later sign-in doesn't inherit a stale "I minted this code" side.
const ROLE_KEYS = ["relayium_pair_exp"];

export async function logout(): Promise<void> {
  try {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
  } catch {
    /* offline — clear local state regardless so the UI reflects signed-out */
  }
  user = null;
  try {
    for (const k of ROLE_KEYS) sessionStorage.removeItem(k);
  } catch {
    /* storage may be unavailable */
  }
  // 本机留下的东西也要一起清，否则「退出登录」只退了 UI：
  //  - 上传密钥：每条 id→key 都是一份完整能力凭证，/d/<id>#k=<key> 无需会话即可下载；
  //  - 传输历史：文件名 + 对端设备名，是一份相当直白的活动记录。
  // 两者都是**本机便利**功能，不是账号数据——所以登出时清掉不会丢任何服务端的东西，
  // 而留着的话，下一个用这台机器的人就继承了它们。
  forgetAllUploadKeys();
  clearHistory();
}

export function googleLoginUrl(): string {
  return "/api/auth/google/start";
}

export function appleLoginUrl(): string {
  return "/api/auth/apple/web/start";
}

export interface AuthMethods {
  password: boolean;
  google: boolean;
  apple: boolean;
  magic: boolean;
}

export async function fetchAuthMethods(): Promise<AuthMethods> {
  try {
    const res = await fetch("/api/auth/methods", { credentials: "include" });
    if (res.ok) return (await res.json()) as AuthMethods;
  } catch {
    /* fall through to default */
  }
  return { password: true, google: false, apple: false, magic: false };
}

// Shared shape for endpoints that, on success, receive {user} and set the
// session cookie — verifyEmail/resetPassword today, passwordLogin below.
async function postForUser(
  path: string,
  payload: Record<string, string>,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiSend(path, { method: "POST", body: JSON.stringify(payload) });
  if (!res) return { ok: false, error: "network" };
  if (res.ok) {
    const body = (await res.json()) as { user: SessionUser };
    user = body.user;
    return { ok: true };
  }
  return { ok: false, error: await errorCode(res) };
}

// Flat like the rest of this module's result shapes (ok + optional error) —
// `status`/`email` are only populated on success.
export interface RegisterResult {
  ok: boolean;
  status?: "verification_sent";
  email?: string;
  error?: string;
}

// Registration only queues a verification email — the server does NOT set a
// session cookie or return a user, so the caller must show a "check your
// email" state rather than treating this like a login.
export async function register(
  email: string,
  password: string,
  displayName = "",
): Promise<RegisterResult> {
  const res = await apiSend("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, displayName }),
  });
  if (!res) return { ok: false, error: "network" };
  if (res.ok) {
    const body = (await res.json()) as { status: "verification_sent"; email: string };
    return { ok: true, status: "verification_sent", email: body.email };
  }
  return { ok: false, error: await errorCode(res) };
}

// Flat like RegisterResult — `unverified`/`email` are only populated when the
// server rejected the login as HTTP 403 email_unverified, distinguishing it
// from a generic "wrong email/password" (401) so the UI can offer a resend.
export interface LoginResult {
  ok: boolean;
  unverified?: boolean;
  email?: string;
  error?: string;
}

export async function passwordLogin(email: string, password: string): Promise<LoginResult> {
  const res = await apiSend("/api/auth/password/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (!res) return { ok: false, error: "network" };
  if (res.ok) {
    const body = (await res.json()) as { user: SessionUser };
    user = body.user;
    return { ok: true };
  }
  let payload: { error?: string; email?: string } = {};
  try {
    payload = (await res.json()) as { error?: string; email?: string };
  } catch {
    /* non-JSON body */
  }
  // A 403 email_unverified is not a generic auth failure — the UI shows a
  // resend affordance instead of "wrong email/password".
  if (res.status === 403 && payload.error === "email_unverified") {
    return { ok: false, unverified: true, email: payload.email ?? email };
  }
  return { ok: false, error: payload.error ?? "error" };
}

// Verifies the emailed token; on success the server sets the session cookie
// and returns {user}, which updates the current-user store just like
// passwordLogin does.
// verifyEmail confirms the emailed token. password (optional) is the one the user
// chose at signup: presenting it proves they set it, so the server keeps it;
// verifying without it leaves the account passwordless (the pre-hijack defense —
// a victim clicking the link can't activate an attacker's registration password).
export async function verifyEmail(token: string, password = ""): Promise<{ ok: boolean; error?: string }> {
  return postForUser("/api/auth/email/verify", { token, password });
}

/** Result of spending an emailed sign-in link. */
export interface MagicResult {
  ok: boolean;
  /** The account is scheduled for deletion: no session was issued, but a fresh
   *  reactivate token came back so the user can undo it. */
  pendingDeletion?: boolean;
  reactivateToken?: string;
  error?: string;
}

/**
 * 花掉邮件里的登录令牌。**只能由一次真实点击触发。**
 *
 * 邮件里的链接指向 GET /api/auth/magic/verify，那个 GET 只把浏览器重定向到本页、
 * 不碰令牌；真正消费它的是这里的 POST。这个分工是有意的：企业邮件网关会在投递前
 * 预取邮件里的每个链接，如果 GET 就消费，用户点开时永远看到"链接已过期"，而那张
 * 30 天的会话 cookie 已经发给扫描器了。
 *
 * 所以**不要**在页面挂载时自动调用它——那等于把防线又搬回 GET 上。
 */
export async function completeMagicLink(token: string): Promise<MagicResult> {
  const res = await apiSend("/api/auth/magic/verify", { method: "POST", body: JSON.stringify({ token }) });
  if (!res) return { ok: false, error: "network" };
  if (!res.ok) return { ok: false, error: await errorCode(res) };
  const body = (await res.json()) as { status?: string; reactivateToken?: string };
  if (body.status === "pending_deletion") {
    return { ok: false, pendingDeletion: true, reactivateToken: body.reactivateToken };
  }
  // 服务端只回 {status:"ok"} 并种下 cookie，用户信息另外拉一次。
  await refreshSession();
  return { ok: true };
}

// Fire-and-forget resend; the server always answers 200 (anti-enumeration —
// it does not reveal whether the address exists or is already verified).
export async function resendVerification(email: string): Promise<void> {
  // best-effort; the caller shows a generic "check your email" regardless
  await apiSend("/api/auth/email/resend", { method: "POST", body: JSON.stringify({ email }) });
}

// Fire-and-forget forgot-password request; the server always answers 200 for
// the same anti-enumeration reason as resendVerification.
export async function forgotPassword(email: string): Promise<void> {
  await apiSend("/api/auth/password/forgot", { method: "POST", body: JSON.stringify({ email }) }); // best-effort
}

// On success the server sets the session cookie and returns {user}; update
// the current-user store just like passwordLogin/verifyEmail do.
export async function resetPassword(
  token: string,
  newPassword: string,
): Promise<{ ok: boolean; error?: string }> {
  return postForUser("/api/auth/password/reset", { token, newPassword });
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiSend("/api/auth/password/change", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  if (!res) return { ok: false, error: "network" };
  if (res.ok) {
    if (user) user = { ...user, hasPassword: true };
    return { ok: true };
  }
  return { ok: false, error: await errorCode(res) };
}

/** Remove a linked OAuth provider from the current account. The server refuses
 *  (409) to remove the last remaining login method. On success the returned
 *  linkedMethods are folded back into the session so the UI updates live. */
export async function unlinkIdentity(
  provider: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiSend(`/api/auth/identities/${provider}`, { method: "DELETE" });
  if (!res) return { ok: false, error: "network" };
  if (res.ok) {
    try {
      const body = (await res.json()) as { linkedMethods?: string[] };
      if (user && body.linkedMethods) user = { ...user, linkedMethods: body.linkedMethods };
    } catch {
      /* non-JSON body — leave session as-is; a refresh will reconcile */
    }
    return { ok: true };
  }
  if (res.status === 409) return { ok: false, error: "last_login_method" };
  return { ok: false, error: "error" };
}

const DEVICE_KEY = "relayium_device_id";

// localStorage throws outright in Safari private mode (and when storage is
// blocked by policy), so every access in this codebase is guarded — this one was
// the exception, and it sits on the login path. A fresh id per call is a fine
// degradation: the id only labels a session, it doesn't authenticate anything.
export function localDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}
