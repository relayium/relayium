<script lang="ts">
  import { onMount } from "svelte";
  import {
    session, refreshSession, requestMagicLink, logout,
    googleLoginUrl, localDeviceId,
  } from "./auth.svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";

  const t = $derived<Messages>(messages[lang()]);
  let open = $state(false);
  let email = $state("");
  let sent = $state(false);

  // Register this browser as a device, once, after we know who the user is.
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
    await refreshSession();
    if (session().user) claimDevice();
  });

  async function onSendLink() {
    if (!email) return;
    await requestMagicLink(email);
    sent = true;
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
        <a class="google" href={googleLoginUrl()}>{t.account.continueGoogle}</a>
        <div class="sep">{t.account.or}</div>
        {#if sent}
          <p class="hint">{t.account.linkSent}</p>
        {:else}
          <input type="email" bind:value={email} placeholder={t.account.email} />
          <button class="primary" onclick={onSendLink}>{t.account.sendLink}</button>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .account { position: absolute; top: 16px; right: 110px; font-size: 13px; }
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
  @media (max-width: 1024px) { .account { right: 96px; top: 10px; } }
</style>
