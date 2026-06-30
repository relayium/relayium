<script lang="ts">
  import { onMount } from "svelte";
  import {
    session, refreshSession, logout, localDeviceId,
    googleLoginUrl, requestMagicLink,
    register, passwordLogin, fetchAuthMethods, type AuthMethods,
  } from "./auth.svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";

  const t = $derived<Messages>(messages[lang()]);
  let open = $state(false);
  let email = $state("");
  let password = $state("");
  let mode = $state<"login" | "register">("login");
  let error = $state("");
  let methods = $state<AuthMethods>({ password: true, google: false, magic: false });

  // magic-link 备用入口（仅当后端开启）
  let magicSent = $state(false);

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

<div class="account">
  {#if session().user}
    <button class="acct-btn" onclick={() => (open = !open)}>
      {session().user!.email}
    </button>
    {#if open}
      <div class="menu">
        <div class="who">{t.account.signedInAs(session().user!.email)}</div>
        <button class="ghost" onclick={onLogout}>{t.account.signOut}</button>
      </div>
    {/if}
  {:else}
    <button class="acct-btn" onclick={() => (open = !open)}>{t.account.signIn}</button>
    {#if open}
      <div class="menu">
        <input type="email" bind:value={email} placeholder={t.account.email} />
        <input type="password" bind:value={password} placeholder={t.account.password} />
        {#if error}<p class="err">{error}</p>{/if}
        <button class="primary" onclick={onSubmit}>
          {mode === "register" ? t.account.createAccount : t.account.logInBtn}
        </button>
        <button class="link" onclick={() => { mode = mode === "register" ? "login" : "register"; error = ""; }}>
          {mode === "register" ? t.account.toLogin : t.account.toRegister}
        </button>

        {#if methods.google || methods.magic}
          <div class="sep">{t.account.or}</div>
        {/if}
        {#if methods.google}
          <a class="google" href={googleLoginUrl()}>{t.account.continueGoogle}</a>
        {/if}
        {#if methods.magic}
          {#if magicSent}
            <p class="hint">{t.account.linkSent}</p>
          {:else}
            <button class="ghost" onclick={onSendLink}>{t.account.sendLink}</button>
          {/if}
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .account { position: relative; font-size: 13px; }
  .acct-btn {
    padding: 5px 12px; border-radius: 8px; border: 1px solid var(--border);
    background: var(--social-bg); color: var(--text-h); cursor: pointer; font: inherit; font-size: 13px;
  }
  .menu {
    position: absolute; right: 0; margin-top: 6px; width: 240px; z-index: 10;
    display: flex; flex-direction: column; gap: 8px;
    padding: 14px; border-radius: 12px; border: 1px solid var(--border);
    background: var(--bg); box-shadow: var(--shadow);
  }
  .menu input { padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); font: inherit; background: var(--social-bg); color: var(--text-h); }
  .menu .google { text-align: center; padding: 8px; border-radius: 8px; border: 1px solid var(--border); text-decoration: none; color: var(--text-h); }
  .menu .sep { text-align: center; color: var(--text); font-size: 12px; }
  .menu .who { color: var(--text); }
  .menu .hint { color: var(--text); font-size: 13px; margin: 0; }
  .menu .err { color: #c00; font-size: 12px; margin: 0; }
  .menu .link { background: none; border: none; color: var(--text); cursor: pointer; font: inherit; font-size: 12px; padding: 2px; text-decoration: underline; }
  .menu .primary { padding: 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--text-h); color: var(--bg); cursor: pointer; font: inherit; }
  .menu .ghost { padding: 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--social-bg); color: var(--text-h); cursor: pointer; font: inherit; }
</style>
