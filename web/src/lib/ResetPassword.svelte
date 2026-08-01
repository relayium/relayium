<script lang="ts">
  // Landing page for the emailed password-reset link: /reset-password?token=<t>.
  // Unlike VerifyEmail, the token is only spent on submit (not on mount) — the
  // page just shows the new-password form until the user commits.
  import { onDestroy, onMount } from "svelte";
  import { resetPassword } from "./auth.svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { navigate } from "./router.svelte";
  import AuthLanding from "./AuthLanding.svelte";

  const t = $derived<Messages>(messages[lang()]);

  type Phase = "boot" | "no-token" | "form" | "success" | "invalid";
  let phase = $state<Phase>("boot");
  let token = "";

  let newPw = $state("");
  let confirmPw = $state("");
  let error = $state("");
  let busy = $state(false);
  let redirectTimer: ReturnType<typeof setTimeout> | undefined;

  const status = $derived(
    phase === "form" ? t.resetPassword.lead
      : phase === "success" ? t.resetPassword.successBody
      : phase === "invalid" ? t.resetPassword.invalidBody
      : phase === "no-token" ? t.resetPassword.noToken
      : "",
  );
  const tone = $derived<"neutral" | "success" | "danger">(
    phase === "success" ? "success" : phase === "invalid" || phase === "no-token" ? "danger" : "neutral",
  );

  onMount(() => {
    token = new URLSearchParams(location.search).get("token") ?? "";
    // Strip the token from the URL so it doesn't linger in browser history or
    // leak via the Referer header on a later navigation (it's kept in memory).
    if (token) history.replaceState(null, "", location.pathname);
    phase = token ? "form" : "no-token";
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
        redirectTimer = setTimeout(() => navigate("lan"), 1200);
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

  onDestroy(() => {
    if (redirectTimer) clearTimeout(redirectTimer);
  });
</script>

<AuthLanding title={t.resetPassword.title} {status} {tone}>
  {#if phase === "no-token"}
    <button type="button" class="btn btn-ghost auth-action" onclick={() => navigate("lan")}>{t.resetPassword.backHome}</button>
  {:else if phase === "invalid"}
    <button type="button" class="btn btn-ghost auth-action" onclick={() => navigate("lan")}>{t.resetPassword.backHome}</button>
  {:else if phase === "form"}
    <form class="auth-form" onsubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      <input class="sr-only" type="text" name="username" autocomplete="username" readonly tabindex="-1" aria-hidden="true" />
      <div class="ui-field">
        <label for="reset-new-password">{t.account.newPassword}</label>
        <input class="ui-input" id="reset-new-password" type="password" name="new-password" autocomplete="new-password"
               bind:value={newPw} aria-describedby="reset-password-hint" />
        <p class="ui-field-hint" id="reset-password-hint">{t.resetPassword.minHint}</p>
      </div>
      <div class="ui-field">
        <label for="reset-confirm-password">{t.account.confirmPassword}</label>
        <input class="ui-input" id="reset-confirm-password" type="password" name="confirm-password" autocomplete="new-password"
               bind:value={confirmPw} />
      </div>
      {#if error}<p class="err" role="alert">{error}</p>{/if}
      <button type="submit" class="btn btn-primary auth-action" disabled={busy}>{t.resetPassword.submitBtn}</button>
    </form>
  {/if}
</AuthLanding>

<style>
  .auth-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    width: 100%;
  }
  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }
  .err { color: var(--danger); font-size: var(--fs-xs); margin: 0; }
  .auth-action { inline-size: 100%; }
  @media (pointer: coarse) { .auth-action { min-block-size: 44px; } }
</style>
