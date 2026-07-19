<script lang="ts">
  // Landing page for the emailed password-reset link: /reset-password?token=<t>.
  // Unlike VerifyEmail, the token is only spent on submit (not on mount) — the
  // page just shows the new-password form until the user commits.
  import { onMount } from "svelte";
  import { resetPassword } from "./auth.svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { navigate } from "./router.svelte";

  const t = $derived<Messages>(messages[lang()]);

  type Phase = "no-token" | "form" | "success" | "invalid";
  let phase = $state<Phase>("form");
  let token = "";

  let newPw = $state("");
  let confirmPw = $state("");
  let error = $state("");
  let busy = $state(false);

  onMount(() => {
    token = new URLSearchParams(location.search).get("token") ?? "";
    // Strip the token from the URL so it doesn't linger in browser history or
    // leak via the Referer header on a later navigation (it's kept in memory).
    if (token) history.replaceState(null, "", location.pathname);
    if (!token) phase = "no-token";
  });

  async function onSubmit() {
    if (busy) return;
    error = "";
    if (newPw.length < 8) { error = t.account.errTooShort; return; }
    if (newPw !== confirmPw) { error = t.account.errMismatch; return; }
    busy = true;
    try {
      const res = await resetPassword(token, newPw);
      if (res.ok) {
        phase = "success";
        setTimeout(() => navigate("lan"), 1200);
      } else if (res.error === "invalid_token") {
        phase = "invalid";
      } else if (res.error === "password too short") {
        error = t.account.errTooShort;
      } else if (res.error === "network") {
        error = t.account.errNetwork;
      } else {
        error = t.resetPassword.errGeneric;
      }
    } finally {
      busy = false;
    }
  }
</script>

<section class="reset page-enter">
  {#if phase === "no-token"}
    <p class="msg err">{t.resetPassword.noToken}</p>
    <button type="button" class="btn-link" onclick={() => navigate("lan")}>{t.resetPassword.backHome}</button>
  {:else if phase === "success"}
    <p class="msg">{t.resetPassword.successBody}</p>
  {:else if phase === "invalid"}
    <p class="msg err">{t.resetPassword.invalidBody}</p>
    <button type="button" class="btn-link" onclick={() => navigate("lan")}>{t.resetPassword.backHome}</button>
  {:else}
    <form class="form" onsubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      <input class="sr-only" type="text" name="username" autocomplete="username" readonly tabindex="-1" aria-hidden="true" />
      <input type="password" name="new-password" autocomplete="new-password"
             bind:value={newPw} placeholder={t.account.newPassword} />
      <p class="hint">{t.resetPassword.minHint}</p>
      <input type="password" name="confirm-password" autocomplete="new-password"
             bind:value={confirmPw} placeholder={t.account.confirmPassword} />
      {#if error}<p class="err">{error}</p>{/if}
      <button type="submit" class="btn btn-primary" disabled={busy}>{t.resetPassword.submitBtn}</button>
    </form>
  {/if}
</section>

<style>
  .reset {
    max-width: 420px;
    margin: var(--space-8) auto;
    padding: var(--space-6) var(--space-5);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    align-items: center;
  }
  .msg { color: var(--text-h); font-size: var(--fs-body); margin: 0; }
  .msg.err { color: var(--danger); }
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    width: 100%;
    text-align: start;
  }
  .form input {
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    font: inherit;
    background: var(--social-bg);
    color: var(--text-h);
  }
  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }
  .hint { color: var(--text); font-size: var(--fs-xs); margin: 0; }
  .err { color: var(--danger); font-size: var(--fs-xs); margin: 0; }
  .btn-link {
    font: inherit;
    font-size: var(--fs-xs);
    background: none;
    border: 0;
    color: var(--accent);
    cursor: pointer;
    padding: var(--space-1) 0;
  }
</style>
