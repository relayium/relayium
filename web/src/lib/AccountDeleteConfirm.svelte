<script lang="ts">
  // Landing page for the emailed account-deletion link:
  // /account/delete/confirm?token=<t> (server/account/deletion.go
  // RequestAccountDeletion builds it; the path is pinned by router.test.ts).
  //
  // It needs a click, and that is the point of the page. Mail gateways
  // (Proofpoint / Mimecast / Defender Safe Links) fetch every link in a message
  // before the person sees it, and some run the page's script. A page that
  // confirmed on load would let a scanner delete somebody's account and erase
  // their files. Do not "save a click" here — the same rule as MagicLink.
  import { onMount } from "svelte";
  import { confirmAccountDeletion } from "./auth.svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { navigate } from "./router.svelte";
  import AuthLanding from "./AuthLanding.svelte";

  const t = $derived<Messages>(messages[lang()]);

  type Phase = "boot" | "no-token" | "confirm" | "working" | "done" | "invalid" | "network" | "server-error";
  let phase = $state<Phase>("boot");
  let token = "";

  const status = $derived(
    phase === "confirm" || phase === "working" ? t.accountDelete.lead
      : phase === "done" ? t.accountDelete.done
      : phase === "invalid" ? t.accountDelete.invalid
      : phase === "network" ? t.accountDelete.errNetwork
      : phase === "server-error" ? t.accountDelete.errServer
      : phase === "no-token" ? t.accountDelete.noToken
      : "",
  );
  const tone = $derived<"neutral" | "success" | "danger">(
    phase === "done" ? "success"
      : phase === "invalid" || phase === "no-token" || phase === "network" || phase === "server-error" ? "danger"
      : "neutral",
  );

  onMount(() => {
    const tok = new URLSearchParams(location.search).get("token");
    // Scrub the token from the address bar at once: left there it lands in
    // history and leaks through Referer on the next navigation. It is kept in
    // memory only. Same as /verify-email, /reset-password and /magic-link.
    if (tok) history.replaceState(null, "", location.pathname);
    if (!tok) { phase = "no-token"; return; }
    token = tok;
    phase = "confirm";
  });

  // POST /api/account/delete/confirm (deletion.go handleDeleteConfirm):
  //   200 {status:"ok"}                     → done (also when the account was
  //                                            already scheduled: idempotent)
  //   400 {error:"invalid_or_expired_token"} → invalid (expired, used, unknown)
  //   network                                → errNetwork, button stays
  //   500 / other                            → errServer, button stays (the
  //                                            server only spends the link when
  //                                            the deletion commits)
  async function confirmDelete() {
    if (phase === "working") return;
    phase = "working";
    const res = await confirmAccountDeletion(token);
    if (res.ok) { phase = "done"; token = ""; return; }
    if (res.error === "invalid_or_expired_token") { phase = "invalid"; token = ""; return; }
    phase = res.error === "network" ? "network" : "server-error";
  }
</script>

<AuthLanding title={t.accountDelete.title} {status} {tone}>
  {#if phase === "confirm" || phase === "working" || phase === "network" || phase === "server-error"}
    <p class="consequence" data-testid="delete-consequence">{t.accountDelete.consequence}</p>
    <button type="button" class="btn danger-action auth-action" disabled={phase === "working"} onclick={confirmDelete}>
      {phase === "working" ? t.accountDelete.working : t.accountDelete.cta}
    </button>
    <button type="button" class="btn btn-ghost auth-action" disabled={phase === "working"} onclick={() => navigate("lan")}>
      {t.accountDelete.keep}
    </button>
  {:else if phase === "done"}
    <p class="consequence">{t.accountDelete.doneUndo}</p>
    <button type="button" class="btn btn-ghost auth-action" onclick={() => navigate("lan")}>{t.accountDelete.home}</button>
  {:else if phase === "invalid" || phase === "no-token"}
    <button type="button" class="btn btn-ghost auth-action" onclick={() => navigate("lan")}>{t.accountDelete.home}</button>
  {/if}
</AuthLanding>

<style>
  .consequence {
    margin: 0;
    color: var(--text);
    font-size: var(--fs-sm);
    line-height: 1.55;
    text-align: start;
  }
  /* Destructive, so it is not the brand gradient: the MePage danger-zone look. */
  .danger-action {
    background: none;
    border: 1px solid var(--danger-border);
    color: var(--danger);
  }
  .danger-action:hover:not(:disabled) { background: var(--danger-bg); }
  .danger-action:disabled { opacity: .6; cursor: default; }
  .auth-action { inline-size: 100%; }
  @media (pointer: coarse) { .auth-action { min-block-size: 44px; } }
</style>
