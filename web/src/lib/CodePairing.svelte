<!-- web/src/lib/CodePairing.svelte -->
<script lang="ts">
  import { createPair, CROSS_PATH } from "./transfer-link";
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

  function enterRoom(code: string) {
    history.replaceState({}, "", `${CROSS_PATH}#c=${code}`);
    location.reload();
  }

  async function send() {
    busy = true; err = "";
    try {
      const { code, expiresAt } = await createPair();
      sessionStorage.setItem(EXP_KEY, String(expiresAt));
      enterRoom(code);
    } catch {
      busy = false;
      err = t.pair.errExpired;
    }
  }

  function join() {
    if (/^\d{6}$/.test(entry)) enterRoom(entry);
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
    <button onclick={() => enterRoom("")}>{t.pair.sendCode}</button>
  {:else if roomCode}
    <p class="lead">{t.pair.yourCode}</p>
    <div class="code">{roomCode}</div>
    <div class="row">
      <button onclick={copy}>{copied ? t.pair.copied : t.pair.copy}</button>
      {#if remaining}<span class="ttl">{t.pair.expiresIn(remaining)}</span>{/if}
    </div>
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
      <button class="primary" disabled={busy} onclick={send}>{t.pair.sendCode}</button>
      <button onclick={() => (mode = "receive")}>{t.pair.enterCode}</button>
    </div>
    {#if err}<p class="error">{err}</p>{/if}
  {/if}
</section>

<style>
  .pairing { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 8px 0; }
  .choices { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; }
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
