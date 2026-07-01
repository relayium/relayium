<script lang="ts">
  import { onMount } from "svelte";
  import {
    session, refreshSession, logout, localDeviceId,
    googleLoginUrl, requestMagicLink,
    register, passwordLogin, fetchAuthMethods, changePassword, type AuthMethods,
  } from "./auth.svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";

  const t = $derived<Messages>(messages[lang()]);
  let { open = $bindable(false) }: { open?: boolean } = $props();
  let email = $state("");
  let password = $state("");
  let mode = $state<"login" | "register">("login");
  let error = $state("");
  let methods = $state<AuthMethods>({ password: true, google: false, magic: false });

  // magic-link 备用入口（仅当后端开启）
  let magicSent = $state(false);

  // 改密表单
  let pwOpen = $state(false);
  let curPw = $state("");
  let newPw = $state("");
  let confirmPw = $state("");
  let pwError = $state("");
  let pwDone = $state(false);

  $effect(() => {
    if (!open) {
      pwOpen = false;
      pwError = "";
      curPw = "";
      newPw = "";
      confirmPw = "";
    }
  });

  function mapPwError(code?: string): string {
    if (code === "current password incorrect") return t.account.errCurrentWrong;
    if (code === "password too short") return t.account.errTooShort;
    return t.account.errLogin;
  }

  async function onChangePassword() {
    pwError = "";
    pwDone = false;
    if (newPw.length < 8) { pwError = t.account.errTooShort; return; }
    if (newPw !== confirmPw) { pwError = t.account.errMismatch; return; }
    const res = await changePassword(curPw, newPw);
    if (res.ok) {
      pwDone = true;
      curPw = ""; newPw = ""; confirmPw = "";
      pwOpen = false;
    } else {
      pwError = mapPwError(res.error);
    }
  }

  async function claimDevice() {
    try {
      await fetch("/api/devices", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: localDeviceId(), name: navigator.platform || "device" }),
      });
    } catch { /* non-fatal */ }
  }

  onMount(async () => {
    methods = await fetchAuthMethods();
    await refreshSession();
    if (session().user) claimDevice();
  });

  function mapError(code?: string): string {
    if (code === "password too short") return t.account.errTooShort;
    if (code === "email already registered") return t.account.errEmailTaken;
    if (code === "invalid credentials") return t.account.errLogin;
    return t.account.errLogin;
  }

  async function onSubmit() {
    error = "";
    if (!email || !password) return;
    const res = mode === "register"
      ? await register(email, password)
      : await passwordLogin(email, password);
    if (res.ok) {
      open = false;
      password = "";
      claimDevice();
    } else {
      error = mapError(res.error);
    }
  }

  async function onSendLink() {
    if (!email) return;
    await requestMagicLink(email);
    magicSent = true;
  }

  async function onLogout() {
    await logout();
    open = false;
  }
</script>

<svelte:window onkeydown={(e) => { if (e.key === "Escape" && open) open = false; }} />

<div class="account">
  {#if session().user}
    <button class="acct-btn" onclick={() => (open = !open)}>
      {session().user!.email}
    </button>
  {:else}
    <button class="acct-btn" onclick={() => (open = !open)}>{t.account.signIn}</button>
  {/if}

  {#if open}
    <button type="button" class="backdrop" aria-label={t.close} onclick={() => (open = false)}></button>
    <div class="modal" role="dialog" aria-modal="true">
      <button class="close-x" onclick={() => (open = false)} aria-label={t.close}>✕</button>
      {#if session().user}
        <div class="menu">
          <div class="who">{t.account.signedInAs(session().user!.email)}</div>

          {#if pwOpen}
            {#if session().user!.hasPassword}
              <input type="password" bind:value={curPw} placeholder={t.account.currentPassword} />
            {/if}
            <input type="password" bind:value={newPw} placeholder={t.account.newPassword} />
            <input type="password" bind:value={confirmPw} placeholder={t.account.confirmPassword} />
            {#if pwError}<p class="err">{pwError}</p>{/if}
            <button class="btn btn-primary" onclick={onChangePassword}>
              {session().user!.hasPassword ? t.account.changePassword : t.account.setPassword}
            </button>
            <button class="btn-link" onclick={() => { pwOpen = false; pwError = ""; curPw = ""; newPw = ""; confirmPw = ""; }}>{t.close}</button>
          {:else}
            {#if pwDone}<p class="hint">{t.account.pwChanged}</p>{/if}
            <button class="btn btn-ghost" onclick={() => { pwOpen = true; pwDone = false; }}>
              {session().user!.hasPassword ? t.account.changePassword : t.account.setPassword}
            </button>
          {/if}

          <button class="btn btn-ghost" onclick={onLogout}>{t.account.signOut}</button>
        </div>
      {:else}
        <div class="menu">
          <input type="email" bind:value={email} placeholder={t.account.email} />
          <input type="password" bind:value={password} placeholder={t.account.password} onkeydown={(e) => { if (e.key === "Enter") onSubmit(); }} />
          {#if error}<p class="err">{error}</p>{/if}
          <button class="btn btn-primary" onclick={onSubmit}>
            {mode === "register" ? t.account.createAccount : t.account.logInBtn}
          </button>
          <button class="btn-link" onclick={() => { mode = mode === "register" ? "login" : "register"; error = ""; }}>
            {mode === "register" ? t.account.toLogin : t.account.toRegister}
          </button>

          {#if methods.google || methods.magic}
            <div class="sep">{t.account.or}</div>
          {/if}
          {#if methods.google}
            <a class="btn btn-ghost" href={googleLoginUrl()}>{t.account.continueGoogle}</a>
          {/if}
          {#if methods.magic}
            {#if magicSent}
              <p class="hint">{t.account.linkSent}</p>
            {:else}
              <button class="btn btn-ghost" onclick={onSendLink}>{t.account.sendLink}</button>
            {/if}
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .account { position: relative; font-size: var(--fs-xs); }
  .acct-btn {
    padding: var(--space-1) var(--space-3); border-radius: var(--radius-sm); border: 1px solid var(--border);
    background: var(--social-bg); color: var(--text-h); cursor: pointer; font: inherit; font-size: var(--fs-xs);
    max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    transition: border-color .13s;
  }
  .acct-btn:hover { border-color: var(--accent-border); }
  .backdrop {
    position: fixed; inset: 0; z-index: 40; border: 0; padding: 0; cursor: default;
    background: rgba(0, 0, 0, .45); backdrop-filter: blur(1px);
  }
  .modal {
    position: fixed; z-index: 41; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: min(340px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto;
    padding: var(--space-5); border-radius: var(--radius); border: 1px solid var(--border);
    background: var(--bg); box-shadow: var(--shadow);
    text-align: left;
  }
  .close-x {
    position: absolute; top: 10px; right: 10px;
    width: 28px; height: 28px; padding: 0; border-radius: var(--radius-sm); cursor: pointer;
    border: 1px solid transparent; background: none; color: var(--text); font-size: var(--fs-sm);
    transition: background .13s, color .13s;
  }
  .close-x:hover { background: var(--social-bg); color: var(--text-h); }
  .menu {
    display: flex; flex-direction: column; gap: var(--space-3);
  }
  .menu input {
    padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); border: 1px solid var(--border);
    font: inherit; background: var(--social-bg); color: var(--text-h);
  }
  .menu .sep { text-align: center; color: var(--text); font-size: 12px; }
  .menu .who { color: var(--text); }
  .menu .hint { color: var(--text); font-size: var(--fs-xs); margin: 0; }
  .menu .err { color: var(--danger); font-size: 12px; margin: 0; }
</style>
