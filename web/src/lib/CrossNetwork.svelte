<script lang="ts">
  import { session } from "./auth.svelte";
  import { createTransfer, buildTransferLink, HttpError } from "./transfer-link";
  import { enterRoom } from "./room.svelte";
  import { messages, lang, type Messages } from "./i18n.svelte";

  let { roomToken = "" }: { roomToken?: string } = $props();

  const t = $derived<Messages>(messages[lang()]);
  const ORIGIN_KEY = "relayium_xfer_token";
  const isOriginator = $derived(
    !!roomToken && sessionStorage.getItem(ORIGIN_KEY) === roomToken,
  );
  const shareLink = $derived(
    roomToken ? buildTransferLink(location.origin, roomToken) : "",
  );

  let busy = $state(false);
  let copied = $state(false);
  let err = $state("");

  let qrDataUrl = $state("");
  $effect(() => {
    if (!(isOriginator && shareLink)) { qrDataUrl = ""; return; }
    // Lazy-load qrcode so it stays out of the main bundle path. Cancel a slow
    // render if the link changes first, and swallow failures (QR is optional).
    let cancelled = false;
    const target = shareLink;
    import("qrcode")
      .then((m) => m.toDataURL(target, { margin: 1, width: 192 }))
      .then((u) => { if (!cancelled) qrDataUrl = u; })
      .catch(() => { /* link is still shown/copyable without the QR */ });
    return () => { cancelled = true; };
  });

  async function start() {
    err = "";
    if (!session().user) {
      err = t.crossnet.loginFirst;
      return;
    }
    busy = true;
    try {
      const { token } = await createTransfer();
      sessionStorage.setItem(ORIGIN_KEY, token);
      // Enter the token room in place; App rebinds the signaling socket to the
      // 2-peer room without a full page reload.
      enterRoom({ token });
    } catch (e) {
      busy = false;
      if (e instanceof HttpError) {
        err = e.status === 401 ? t.crossnet.sessionExpired : t.crossnet.linkDead;
      } else {
        err = t.crossnet.netError; // fetch threw — never reached the server
      }
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(shareLink);
    } catch {
      return; // clipboard blocked — the link is visible in the read-only field
    }
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }
</script>

<section class="crossnet">
  {#if isOriginator}
    <p>{t.crossnet.shareHint}</p>
    <div class="row">
      <input readonly value={shareLink} />
      <button class="btn btn-ghost" onclick={copy}>{copied ? t.crossnet.copied : t.crossnet.copy}</button>
    </div>
    {#if qrDataUrl}
      <img class="qr" src={qrDataUrl} alt="QR" width="192" height="192" />
    {/if}
  {:else if roomToken}
    <p>{t.crossnet.connecting}</p>
  {:else}
    <button class="btn btn-primary" onclick={start} disabled={busy}>{busy ? t.generating : t.crossnet.sendAcross}</button>
    {#if err}<p class="error">{err}</p>{/if}
  {/if}
</section>

<style>
  .crossnet { display: flex; flex-direction: column; align-items: center; gap: var(--space-3); padding: var(--space-2) 0; }
  .crossnet p { margin: 0; font-size: var(--fs-xs); color: var(--text); text-align: center; }
  .row { display: flex; gap: var(--space-2); width: 100%; }
  .row input {
    flex: 1; min-width: 0; font: inherit; font-size: var(--fs-xs); padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg); color: var(--text-h);
  }
  /* Compact copy button that lines up with the link input beside it. */
  .row .btn { padding: var(--space-2) var(--space-4); white-space: nowrap; }
  .qr { margin-top: var(--space-1); border-radius: var(--radius-sm); background: #fff; padding: 6px; }
  .error { color: var(--accent); font-size: var(--fs-xs); margin: 0; }
</style>
