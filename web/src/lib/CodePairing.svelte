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
  // Which copy button last fired ("" = none) so each shows its own "copied" state.
  let copied = $state<"" | "code" | "link">("");

  // The full join link the recipient opens (same string the QR encodes). Opening
  // it auto-joins the code room, so forwarding this link == sharing the code.
  const joinLink = $derived(`${location.origin}${CROSS_PATH}#c=${roomCode}`);

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
    if (!(isMinter && roomCode)) { qrDataUrl = ""; return; }
    // Cancel a slow render if the link changes before it resolves, so a stale QR
    // can't overwrite a newer one. Failures degrade silently (no unhandled reject).
    let cancelled = false;
    const target = joinLink;
    import("qrcode")
      .then((m) => m.toDataURL(target, { margin: 1, width: 160 }))
      .then((u) => { if (!cancelled) qrDataUrl = u; })
      .catch(() => { /* QR is a convenience; the code/link are still shown */ });
    return () => { cancelled = true; };
  });

  async function send() {
    busy = true; err = "";
    try {
      const { code, expiresAt } = await createPair();
      sessionStorage.setItem(EXP_KEY, String(expiresAt));
      enterRoom({ code }); // rebinds the socket to the code room without reloading
    } catch {
      busy = false;
      // Minting a brand-new code just failed; it was never issued, so "expired"
      // would be misleading — report a mint/network failure instead.
      err = t.pair.mintFailed;
    }
  }

  function join() {
    if (!/^\d{6}$/.test(entry)) return;
    // A joiner is never the minter — drop any stale mint marker from an earlier
    // "create code" this session so isMinter resolves correctly after start-over.
    sessionStorage.removeItem(EXP_KEY);
    enterRoom({ code: entry });
  }

  async function copyText(what: "code" | "link") {
    try {
      await navigator.clipboard.writeText(what === "code" ? roomCode : joinLink);
    } catch {
      return; // clipboard blocked (permissions/insecure context) — the value is on screen
    }
    copied = what;
    setTimeout(() => { if (copied === what) copied = ""; }, 2000);
  }
</script>

<section class="pairing">
  {#if expired}
    <p class="error">{t.pair.expired}</p>
    <button class="btn btn-primary" onclick={() => { sessionStorage.removeItem(EXP_KEY); enterRoom({}); }}>{t.pair.sendCode}</button>
  {:else if roomCode}
    {#if isMinter}
      <p class="lead">{t.pair.yourCode}</p>
      <div class="code">{roomCode}</div>
      <div class="row">
        <button class="btn btn-ghost" onclick={() => copyText("code")}>{copied === "code" ? t.pair.copied : t.pair.copy}</button>
        <button class="btn btn-ghost" onclick={() => copyText("link")}>{copied === "link" ? t.pair.copied : t.pair.copyLink}</button>
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
      <button class="btn btn-primary" disabled={entry.length !== 6} onclick={join}>{t.pair.joinBtn}</button>
    </div>
  {:else}
    <div class="choices">
      <button class="btn btn-primary" disabled={busy} onclick={send}>{busy ? t.generating : t.pair.sendCode}</button>
      <button class="btn btn-ghost" onclick={() => (mode = "receive")}>{t.pair.enterCode}</button>
    </div>
    {#if err}<p class="error">{err}</p>{/if}
  {/if}
</section>

<style>
  .pairing { display: flex; flex-direction: column; align-items: center; gap: var(--space-3); padding: var(--space-2) 0; }
  .choices { display: flex; gap: var(--space-3); flex-wrap: wrap; justify-content: center; }
  .qr { margin-top: var(--space-1); border-radius: var(--radius-sm); background: #fff; padding: 6px; }
  .scan { margin: 0; font-size: 12px; color: var(--text); text-align: center; max-width: 30ch; }
  .lead { margin: 0; font-size: var(--fs-sm); color: var(--text); text-align: center; }
  /* Intentional oversized code display — the whole point is at-a-glance readback. */
  .code {
    font-size: 40px; letter-spacing: 10px; font-weight: 700; color: var(--text-h);
    font-variant-numeric: tabular-nums; padding-left: 10px;
  }
  .row { display: flex; align-items: center; gap: var(--space-3); }
  .ttl { font-size: var(--fs-xs); color: var(--text); font-variant-numeric: tabular-nums; }
  .waiting { margin: 0; font-size: var(--fs-xs); color: var(--text); }
  /* Intentional oversized code-entry field to match the code display. */
  input {
    font: inherit; font-size: 22px; letter-spacing: 6px; text-align: center; width: 7ch;
    padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); border: 1px solid var(--border);
    background: var(--bg); color: var(--text-h); font-variant-numeric: tabular-nums;
  }
  .error { color: var(--accent); font-size: var(--fs-xs); margin: 0; }
</style>
