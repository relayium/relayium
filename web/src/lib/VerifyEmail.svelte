<script lang="ts">
  // Landing page for the emailed verification link: /verify-email?token=<t>.
  // On success the server has already set the session cookie (verifyEmail's
  // postForUser updates auth.svelte's session store too), so this page just
  // shows a brief confirmation and hands off to the app home.
  import { onMount } from "svelte";
  import { verifyEmail, resendVerification } from "./auth.svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { navigate } from "./router.svelte";

  const t = $derived<Messages>(messages[lang()]);

  type Phase = "checking" | "success" | "no-token" | "invalid";
  let phase = $state<Phase>("checking");

  // Resend affordance shown on the invalid/expired state — mirrors Account.svelte's
  // onResend (30s disable + a neutral "sent" ack, since resendVerification never
  // reveals whether the address exists or is already verified).
  let resendEmail = $state("");
  let resendDisabled = $state(false);
  let resendAck = $state(false);

  async function onResend() {
    if (resendDisabled || !resendEmail) return;
    resendDisabled = true;
    resendAck = true;
    try {
      await resendVerification(resendEmail);
    } finally {
      setTimeout(() => { resendDisabled = false; }, 30_000);
    }
  }

  onMount(async () => {
    const token = new URLSearchParams(location.search).get("token");
    // Strip the token from the URL so it doesn't linger in browser history or
    // leak via the Referer header on a later navigation.
    if (token) history.replaceState(null, "", location.pathname);
    if (!token) { phase = "no-token"; return; }
    const res = await verifyEmail(token);
    if (res.ok) {
      phase = "success";
      // Brief pause so the success message is readable before the app takes over.
      setTimeout(() => navigate("lan"), 1200);
    } else {
      phase = "invalid";
    }
  });
</script>

<section class="verify">
  {#if phase === "checking"}
    <p class="msg">{t.verifyEmail.checking}</p>
  {:else if phase === "success"}
    <p class="msg">{t.verifyEmail.successBody}</p>
  {:else if phase === "no-token"}
    <p class="msg err">{t.verifyEmail.noToken}</p>
    <button type="button" class="btn-link" onclick={() => navigate("lan")}>{t.verifyEmail.backHome}</button>
  {:else}
    <p class="msg err">{t.verifyEmail.invalidTitle}</p>
    <p class="hint">{t.account.checkSpamHint}</p>
    <form class="resend" onsubmit={(e) => { e.preventDefault(); onResend(); }}>
      <input type="email" name="email" autocomplete="username" bind:value={resendEmail} placeholder={t.account.email} />
      {#if resendAck}<p class="hint">{t.account.resendVerificationSent}</p>{/if}
      <button type="submit" class="btn btn-primary" disabled={resendDisabled || !resendEmail}>
        {t.account.resendVerificationBtn}
      </button>
    </form>
    <button type="button" class="btn-link" onclick={() => navigate("lan")}>{t.verifyEmail.backHome}</button>
  {/if}
</section>

<style>
  .verify {
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
  .resend {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    width: 100%;
  }
  .resend input {
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    font: inherit;
    background: var(--social-bg);
    color: var(--text-h);
  }
  .hint { color: var(--text); font-size: var(--fs-xs); margin: 0; }
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
