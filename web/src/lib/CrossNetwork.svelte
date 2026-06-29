<script lang="ts">
  import { session } from "./auth.svelte";
  import { createTransfer, buildTransferLink } from "./transfer-link";
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

  async function start() {
    err = "";
    if (!session()) {
      err = t.crossnet.loginFirst;
      return;
    }
    busy = true;
    try {
      const { token } = await createTransfer();
      sessionStorage.setItem(ORIGIN_KEY, token);
      location.hash = `t=${token}`;
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
  {:else if roomToken}
    <p>{t.crossnet.connecting}</p>
  {:else}
    <button onclick={start} disabled={busy}>{t.crossnet.sendAcross}</button>
    {#if err}<p class="error">{err}</p>{/if}
  {/if}
</section>
