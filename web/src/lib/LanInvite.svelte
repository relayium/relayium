<!-- web/src/lib/LanInvite.svelte
     The LAN empty state's one action. "Open this page on another device on the
     same network" used to be a sentence inside a paragraph; the only control in
     that state was a button that led AWAY from the page. This makes the
     instruction executable: the address to type, a copy control and a QR code
     to scan, in one row. It claims nothing about timing or reachability — the
     radar beside it is what says whether a search is running. -->
<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { copyFeedback } from "./clipboard.svelte";

  const t = $derived<Messages>(messages[lang()]);
  // The page's own origin, not a hard-coded host: a self-hosted Relayium
  // invites to itself.
  const url = typeof location !== "undefined" ? `${location.origin}/` : "";
  const shown = $derived(url.replace(/^https?:\/\//, "").replace(/\/$/, ""));
  const copied = copyFeedback();

  let qr = $state("");
  $effect(() => {
    if (!url) return;
    // Same lazy chunk CodePairing and StoredUpload use; a failure only loses
    // the picture, the address beside it is still there to type.
    let cancelled = false;
    import("qrcode")
      .then((m) => m.toDataURL(url, { margin: 1, width: 176 }))
      .then((u) => { if (!cancelled) qr = u; })
      .catch(() => { /* the address is still shown */ });
    return () => { cancelled = true; };
  });
</script>

<div class="invite">
  {#if qr}
    <img class="qr" src={qr} alt={t.shell.inviteScan} width="88" height="88" />
  {/if}
  <div class="text">
    <p class="title">{t.shell.inviteTitle}</p>
    <div class="addr">
      <code>{shown}</code>
      <button type="button" class="btn btn-ghost btn-sm" class:copied={copied.value === "1"} onclick={() => copied.copy(url)}>
        {copied.value === "1" ? t.pair.copied : t.pair.copyLink}
      </button>
    </div>
    <p class="hint">{t.shell.inviteHint}</p>
  </div>
</div>

<style>
  .invite {
    display: flex; align-items: center; gap: var(--space-4);
    box-sizing: border-box; inline-size: 100%; max-inline-size: 460px;
    padding: var(--space-3) 14px;
    border: 1px solid var(--shell-card-border, var(--border));
    border-radius: var(--radius-card, 11px);
    background: var(--shell-card, var(--surface));
    text-align: start;
  }
  .qr { flex: none; inline-size: 88px; block-size: 88px; border-radius: 6px; background: #fff; }
  .text { display: flex; flex-direction: column; gap: 6px; min-inline-size: 0; }
  .title { margin: 0; font-size: 13px; font-weight: 600; color: var(--text-h); }
  .addr { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
  .addr code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px; color: var(--text-h);
    padding: 3px 8px; border-radius: 6px;
    background: var(--code-bg);
    overflow-wrap: anywhere;
  }
  .hint { margin: 0; font-size: 11.5px; line-height: 1.5; color: var(--text); }
  @media (max-width: 480px) {
    .invite { flex-direction: column; align-items: flex-start; }
  }
</style>
