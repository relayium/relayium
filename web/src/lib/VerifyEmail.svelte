<script lang="ts">
  // Landing page for the emailed verification link: /verify-email?token=<t>.
  // On success the server has already set the session cookie (verifyEmail's
  // postForUser updates auth.svelte's session store too), so this page just
  // shows a brief confirmation and hands off to the app home.
  import { onDestroy, onMount } from "svelte";
  import { verifyEmail, resendVerification } from "./auth.svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { navigate } from "./router.svelte";
  import AuthLanding from "./AuthLanding.svelte";

  const t = $derived<Messages>(messages[lang()]);

  type Phase = "boot" | "confirm" | "checking" | "success" | "no-token" | "invalid";
  let phase = $state<Phase>("boot");
  // The token is kept out of the URL (stripped on mount) and confirmed with the
  // password the user chose at signup — proving they set it so the server keeps
  // it, rather than a victim's click activating an attacker's password.
  let token = $state("");
  let password = $state("");
  let redirectTimer: ReturnType<typeof setTimeout> | undefined;

  async function runVerify() {
    phase = "checking";
    const res = await verifyEmail(token, password);
    if (res.ok) {
      phase = "success";
      redirectTimer = setTimeout(() => navigate("lan"), 1200);
    } else {
      phase = "invalid";
    }
  }

  // Resend affordance shown on the invalid/expired state — mirrors Account.svelte's
  // onResend (30s disable + a neutral "sent" ack, since resendVerification never
  // reveals whether the address exists or is already verified).
  let resendEmail = $state("");
  let resendDisabled = $state(false);
  let resendAck = $state(false);
  let resendTimer: ReturnType<typeof setTimeout> | undefined;

  const status = $derived(
    phase === "confirm" ? t.verifyEmail.confirmPrompt
      : phase === "checking" ? t.verifyEmail.checking
      : phase === "success" ? t.verifyEmail.successBody
      : phase === "no-token" ? t.verifyEmail.noToken
      : phase === "invalid" ? t.verifyEmail.invalidTitle
      : "",
  );
  const tone = $derived<"neutral" | "success" | "danger">(
    phase === "success" ? "success" : phase === "invalid" || phase === "no-token" ? "danger" : "neutral",
  );

  async function onResend() {
    if (resendDisabled || !resendEmail) return;
    resendDisabled = true;
    resendAck = true;
    try {
      await resendVerification(resendEmail);
    } finally {
      resendTimer = setTimeout(() => { resendDisabled = false; }, 30_000);
    }
  }

  onMount(() => {
    const tok = new URLSearchParams(location.search).get("token");
    // Strip the token from the URL so it doesn't linger in browser history or
    // leak via the Referer header on a later navigation.
    if (tok) history.replaceState(null, "", location.pathname);
    if (!tok) { phase = "no-token"; return; }
    token = tok;
    // Ask the user to confirm their signup password before verifying, instead of
    // auto-verifying — see the token/password rationale above.
    phase = "confirm";
  });

  onDestroy(() => {
    if (resendTimer) clearTimeout(resendTimer);
    if (redirectTimer) clearTimeout(redirectTimer);
  });
</script>

<AuthLanding title={t.verifyEmail.title} {status} {tone}>
  {#if phase === "confirm"}
    <form class="auth-form" onsubmit={(e) => { e.preventDefault(); runVerify(); }}>
      <div class="ui-field">
        <label for="verify-password">{t.account.password}</label>
        <input class="ui-input" id="verify-password" type="password" name="password" autocomplete="current-password"
               bind:value={password} />
      </div>
      <button type="submit" class="btn btn-primary auth-action">{t.verifyEmail.confirmBtn}</button>
    </form>
    <button type="button" class="btn btn-link auth-link" onclick={() => runVerify()}>{t.verifyEmail.noPasswordLink}</button>
  {:else if phase === "no-token"}
    <button type="button" class="btn btn-ghost auth-action" onclick={() => navigate("lan")}>{t.verifyEmail.backHome}</button>
  {:else if phase === "invalid"}
    <p class="hint">{t.account.checkSpamHint}</p>
    <form class="auth-form" onsubmit={(e) => { e.preventDefault(); onResend(); }}>
      <div class="ui-field">
        <label for="resend-email">{t.account.email}</label>
        <input class="ui-input" id="resend-email" type="email" name="email" autocomplete="username" bind:value={resendEmail} />
      </div>
      {#if resendAck}<p class="hint" role="status">{t.account.resendVerificationSent}</p>{/if}
      <button type="submit" class="btn btn-primary auth-action" disabled={resendDisabled || !resendEmail}>
        {t.account.resendVerificationBtn}
      </button>
    </form>
    <button type="button" class="btn btn-link auth-link" onclick={() => navigate("lan")}>{t.verifyEmail.backHome}</button>
  {/if}
</AuthLanding>

<style>
  .auth-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    width: 100%;
  }
  .hint { color: var(--text); font-size: var(--fs-xs); margin: 0 0 var(--space-3); line-height: 1.5; }
  .auth-action { inline-size: 100%; }
  .auth-link { margin-block-start: var(--space-2); }
  @media (pointer: coarse) { .auth-action, .auth-link { min-block-size: 44px; } }
</style>
