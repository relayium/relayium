<script lang="ts">
  import { session } from "./auth.svelte";
  import { createTransfer, buildTransferLink, CROSS_PATH } from "./transfer-link";
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
    if (isOriginator && shareLink) {
      // Lazy-load qrcode so it stays out of the main bundle path.
      import("qrcode").then((m) =>
        m.toDataURL(shareLink, { margin: 1, width: 192 }).then((u) => (qrDataUrl = u)),
      );
    } else {
      qrDataUrl = "";
    }
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
      // Rewrite to the cross-network path + token, then reload so the signaling
      // socket reconnects into the 2-peer token room (works from either tab).
      history.replaceState({}, "", `${CROSS_PATH}#t=${token}`);
      location.reload();
    } catch {
      busy = false;
      err = t.crossnet.linkDead;
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(shareLink);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }
</script>

<section class="crossnet">
  {#if isOriginator}
    <p>{t.crossnet.shareHint}</p>
    <div class="row">
      <input readonly value={shareLink} />
      <button onclick={copy}>{copied ? t.crossnet.copied : t.crossnet.copy}</button>
    </div>
    {#if qrDataUrl}
      <img class="qr" src={qrDataUrl} alt="QR" width="192" height="192" />
    {/if}
  {:else if roomToken}
    <p>{t.crossnet.connecting}</p>
  {:else}
    <button onclick={start} disabled={busy}>{t.crossnet.sendAcross}</button>
    {#if err}<p class="error">{err}</p>{/if}
  {/if}
</section>
