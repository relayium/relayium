<script lang="ts">
  import { onMount } from "svelte";
  import { setFirstPassword } from "./auth.svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { navigate } from "./router.svelte";
  import AuthLanding from "./AuthLanding.svelte";

  const t = $derived<Messages>(messages[lang()]);
  type Phase = "boot" | "form" | "success" | "invalid" | "changed" | "signed-out" | "no-token";
  let phase = $state<Phase>("boot");
  let token = "";
  let newPw = $state("");
  let confirmPw = $state("");
  let error = $state("");
  let busy = $state(false);

  onMount(() => {
    token = new URLSearchParams(location.hash.slice(1)).get("token")
      || new URLSearchParams(location.search).get("token") || "";
    if (token) history.replaceState(null, "", location.pathname);
    phase = token ? "form" : "no-token";
  });

  const status = $derived(
    phase === "form" ? t.account.firstPasswordLead
      : phase === "success" ? t.account.firstPasswordSuccess
      : phase === "invalid" ? t.account.firstPasswordInvalid
      : phase === "changed" ? t.account.firstPasswordChanged
      : phase === "signed-out" ? t.account.errSessionExpired
      : phase === "no-token" ? t.account.firstPasswordNoToken : "",
  );
  const tone = $derived<"neutral" | "success" | "danger">(phase === "success" ? "success" : phase === "form" ? "neutral" : "danger");

  async function submit() {
    if (busy) return;
    error = "";
    if (newPw.length < 8) { error = t.account.errTooShort; return; }
    if (newPw !== confirmPw) { error = t.account.errMismatch; return; }
    busy = true;
    const res = await setFirstPassword(token, newPw);
    busy = false;
    if (res.ok) phase = "success";
    else if (res.error === "invalid_token") phase = "invalid";
    else if (res.error === "credentials_changed") phase = "changed";
    else if (res.error === "signed_out") phase = "signed-out";
    else if (res.error === "password_too_long") error = t.account.errTooLong;
    else if (res.error === "password too short") error = t.account.errTooShort;
    else error = res.error === "network" ? t.account.errNetwork : t.account.errUnrecognised;
  }
</script>

<AuthLanding title={t.account.firstPasswordTitle} {status} {tone}>
  {#if phase === "form"}
    <form class="auth-form" onsubmit={(e) => { e.preventDefault(); submit(); }}>
      <div class="ui-field"><label for="set-password-new">{t.account.newPassword}</label><input class="ui-input" id="set-password-new" type="password" autocomplete="new-password" bind:value={newPw} /></div>
      <div class="ui-field"><label for="set-password-confirm">{t.account.confirmPassword}</label><input class="ui-input" id="set-password-confirm" type="password" autocomplete="new-password" bind:value={confirmPw} /></div>
      {#if error}<p class="err">{error}</p>{/if}
      <button class="btn btn-primary auth-action" type="submit" disabled={busy}>{t.account.setPassword}</button>
    </form>
  {:else}
    <button class="btn btn-ghost auth-action" type="button" onclick={() => navigate("lan")}>{t.resetPassword.backHome}</button>
  {/if}
</AuthLanding>
