<script lang="ts">
  // Landing page for the emailed reactivation link: /account/reactivate?token=<t>
  // (server/account/deletion.go reactivateLink — sent with the "deletion
  // scheduled" email and the pre-purge reminder). The path is pinned by
  // router.test.ts.
  //
  // One click, never on load: POST /api/account/reactivate spends the token and
  // mints a session cookie, and a mail gateway that prefetches the link must
  // not be the one holding that session. Same rule as MagicLink.
  import { onDestroy, onMount } from "svelte";
  import { reactivateAccount, takeReactivationOffer } from "./auth.svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { navigate, isReactivateFragment, ACCOUNT_REACTIVATE_PATH } from "./router.svelte";
  import AuthLanding from "./AuthLanding.svelte";

  const t = $derived<Messages>(messages[lang()]);

  type Phase = "boot" | "no-token" | "confirm" | "working" | "done" | "invalid" | "network" | "server-error";
  let phase = $state<Phase>("boot");
  let token = "";
  let redirectTimer: ReturnType<typeof setTimeout> | undefined;

  const status = $derived(
    phase === "confirm" || phase === "working" ? t.accountReactivate.lead
      : phase === "done" ? t.accountReactivate.done
      : phase === "invalid" ? t.accountReactivate.invalid
      : phase === "network" ? t.account.errNetwork
      : phase === "server-error" ? t.accountReactivate.errServer
      : phase === "no-token" ? t.accountReactivate.noToken
      : "",
  );
  const tone = $derived<"neutral" | "success" | "danger">(
    phase === "done" ? "success"
      : phase === "invalid" || phase === "no-token" || phase === "network" || phase === "server-error" ? "danger"
      : "neutral",
  );

  onMount(() => {
    // Three ways in, one token:
    //   ?token=<t>                          the emailed link
    //   #account=pending_deletion&token=<t> the frozen-account OAuth redirect to "/"
    //   takeReactivationOffer()             a frozen sign-in on another page
    //                                       (magic link, verify email, reset)
    const fromQuery = new URLSearchParams(location.search).get("token");
    const fromFragment = isReactivateFragment(location.hash)
      ? new URLSearchParams(location.hash.slice(1)).get("token")
      : null;
    const offered = takeReactivationOffer();
    const tok = fromQuery || fromFragment || offered;
    // Scrub the token from the address bar at once (history, Referer). Kept in
    // memory only, like the other emailed-link pages. Rewritten to this page's
    // own path, so a fragment that arrived on "/" does not leave the address
    // bar claiming to be the home page.
    if (fromQuery || fromFragment) history.replaceState(null, "", ACCOUNT_REACTIVATE_PATH);
    if (!tok) { phase = "no-token"; return; }
    token = tok;
    phase = "confirm";
  });

  // POST /api/account/reactivate (deletion.go handleReactivate):
  //   200 {user} + session cookie             → done, signed in
  //   400 {error:"invalid_or_expired_token"}  → invalid. Also what an account
  //                                             that is no longer scheduled gets;
  //                                             the server does not say which.
  //   network                                  → errNetwork, button stays
  //   500 / other                              → errServer. The token may be
  //                                             spent by now, so point at
  //                                             signing in, which hands out a
  //                                             fresh reactivate offer.
  async function reactivate() {
    if (phase === "working") return;
    phase = "working";
    const res = await reactivateAccount(token);
    if (res.ok) {
      phase = "done";
      token = "";
      redirectTimer = setTimeout(() => navigate("lan"), 1500);
      return;
    }
    if (res.error === "invalid_or_expired_token") { phase = "invalid"; token = ""; return; }
    phase = res.error === "network" ? "network" : "server-error";
  }

  onDestroy(() => {
    if (redirectTimer) clearTimeout(redirectTimer);
  });
</script>

<AuthLanding title={t.accountReactivate.title} {status} {tone}>
  {#if phase === "confirm" || phase === "working" || phase === "network"}
    <button type="button" class="btn btn-primary auth-action" disabled={phase === "working"} onclick={reactivate}>
      {phase === "working" ? t.accountReactivate.working : t.accountReactivate.cta}
    </button>
  {:else if phase === "invalid" || phase === "no-token" || phase === "server-error"}
    <button type="button" class="btn btn-ghost auth-action" onclick={() => navigate("lan")}>{t.accountReactivate.home}</button>
  {/if}
</AuthLanding>

<style>
  .auth-action { inline-size: 100%; }
  @media (pointer: coarse) { .auth-action { min-block-size: 44px; } }
</style>
