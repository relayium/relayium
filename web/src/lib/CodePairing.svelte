<!-- web/src/lib/CodePairing.svelte -->
<script lang="ts">
  import { createPair, CROSS_PATH } from "./transfer-link";
  import { enterRoom } from "./room.svelte";
  import { messages, lang, type Messages } from "./i18n.svelte";

  let { roomCode = "", expired = false }:
    { roomCode?: string; expired?: boolean } = $props();

  const t = $derived<Messages>(messages[lang()]);
  const EXP_KEY = "relayium_pair_exp";

  let mode = $state<"choose" | "receive">("choose");
  let entry = $state("");
  let busy = $state(false);
  let err = $state("");
  let copied = $state(false);

  // isMinter: true on the device that minted the code (EXP_KEY written to
  // sessionStorage); false on the recipient who typed in a code.
  const isMinter = sessionStorage.getItem(EXP_KEY) !== null;

  // Countdown (only the minting device has the expiry stashed).
  let remaining = $state(""); // "m:ss" or ""
  $effect(() => {
    if (!roomCode) return;
    const raw = sessionStorage.getItem(EXP_KEY);
    if (!raw) return;
    const exp = Number(raw);
    const tick = () => {
      const left = exp - Math.floor(Date.now() / 1000);
      if (left <= 0) { remaining = "0:00"; return; }
      remaining = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    };
    tick();
    const h = setInterval(tick, 1000);
    return () => clearInterval(h);
  });

  // QR of the join link so the other person can scan instead of typing the code.
  let qrDataUrl = $state("");
  $effect(() => {
    if (isMinter && roomCode) {
      const link = `${location.origin}${CROSS_PATH}#c=${roomCode}`;
      import("qrcode").then((m) =>
        m.toDataURL(link, { margin: 1, width: 160 }).then((u) => (qrDataUrl = u)),
      );
    } else {
      qrDataUrl = "";
    }
  });

  async function send() {
    busy = true; err = "";
    try {
      const { code, expiresAt } = await createPair();
      sessionStorage.setItem(EXP_KEY, String(expiresAt));
      enterRoom({ code }); // rebinds the socket to the code room without reloading
    } catch {
      busy = false;
      err = t.pair.errExpired;
    }
  }

  function join() {
    if (/^\d{6}$/.test(entry)) enterRoom({ code: entry });
  }

  async function copy() {
    await navigator.clipboard.writeText(roomCode);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }
</script>

<section class="pairing">
  {#if expired}
    <p class="error">{t.pair.expired}</p>
    <button onclick={() => enterRoom({})}>{t.pair.sendCode}</button>
  {:else if roomCode}
    {#if isMinter}
      <p class="lead">{t.pair.yourCode}</p>
      <div class="code">{roomCode}</div>
      <div class="row">
        <button onclick={copy}>{copied ? t.pair.copied : t.pair.copy}</button>
        {#if remaining}<span class="ttl">{t.pair.expiresIn(remaining)}</span>{/if}
      </div>
      {#if qrDataUrl}
        <img class="qr" src={qrDataUrl} alt="QR" width="160" height="160" />
        <p class="scan">{t.pair.scanHint}</p>
      {/if}
    {/if}
    <p class="waiting">{t.pair.waiting}</p>
  {:else if mode === "receive"}
    <p class="lead">{t.pair.enterHint}</p>
    <div class="row">
      <input
        inputmode="numeric"
        maxlength="6"
        placeholder="000000"
        bind:value={entry}
        oninput={() => (entry = entry.replace(/\D/g, "").slice(0, 6))}
      />
      <button class="primary" disabled={entry.length !== 6} onclick={join}>{t.pair.joinBtn}</button>
    </div>
  {:else}
    <div class="choices">
      <button class="primary" disabled={busy} onclick={send}>{busy ? t.generating : t.pair.sendCode}</button>
      <button onclick={() => (mode = "receive")}>{t.pair.enterCode}</button>
    </div>
    {#if err}<p class="error">{err}</p>{/if}
  {/if}
</section>

<style>
  .pairing { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 8px 0; }
  .choices { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; }
  .qr { margin-top: 4px; border-radius: 8px; background: #fff; padding: 6px; }
  .scan { margin: 0; font-size: 12px; color: var(--text); text-align: center; max-width: 30ch; }
  .lead { margin: 0; font-size: 14px; color: var(--text); text-align: center; }
  .code {
    font-size: 40px; letter-spacing: 10px; font-weight: 700; color: var(--text-h);
    font-variant-numeric: tabular-nums; padding-left: 10px;
  }
  .row { display: flex; align-items: center; gap: 12px; }
  .ttl { font-size: 13px; color: var(--text); font-variant-numeric: tabular-nums; }
  .waiting { margin: 0; font-size: 13.5px; color: var(--text); }
  input {
    font: inherit; font-size: 22px; letter-spacing: 6px; text-align: center; width: 7ch;
    padding: 8px 10px; border-radius: 9px; border: 1px solid var(--border);
    background: var(--bg); color: var(--text-h); font-variant-numeric: tabular-nums;
  }
  button {
    font: inherit; font-size: 15px; padding: 9px 22px; border-radius: 9px; cursor: pointer;
    border: 1px solid var(--border); background: var(--bg); color: var(--text-h);
  }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .error { color: var(--accent); font-size: 13.5px; margin: 0; }
</style>
