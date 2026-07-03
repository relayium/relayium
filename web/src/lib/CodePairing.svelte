<!-- web/src/lib/CodePairing.svelte -->
<script lang="ts">
  import { createPair, CROSS_PATH } from "./transfer-link";
  import { canShare, share } from "./share";
  import { enterRoom } from "./room.svelte";
  import { messages, lang, type Messages } from "./i18n.svelte";
  import { outbox, setOutbox, clearOutbox } from "./outbox.svelte";
  import { pickedFromInput } from "./drag";
  import { formatSize } from "./format";
  import { folderUploadSupported } from "./platform";

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
  let timedOut = $state(false); // the minter's own countdown hit zero — the code is now dead
  $effect(() => {
    if (!roomCode) return;
    const raw = sessionStorage.getItem(EXP_KEY);
    if (!raw) return;
    const exp = Number(raw);
    timedOut = false; // re-armed for each fresh code (roomCode change re-runs this effect)
    const tick = () => {
      const left = exp - Math.floor(Date.now() / 1000);
      // Once it lapses, flip into the expired branch so the minter isn't left
      // showing a live-looking code that the other side can no longer join.
      if (left <= 0) { remaining = "0:00"; timedOut = true; return; }
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

  const queuedBytes = $derived(outbox().reduce((n, p) => n + p.file.size, 0));

  // Files-first entry: pick files, then mint — the batch waits in the outbox
  // and App auto-offers it the moment the recipient joins the code room.
  async function pickAndSend(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const picked = input.files?.length ? pickedFromInput(input.files) : [];
    input.value = ""; // allow re-picking the same files
    if (!picked.length) return;
    setOutbox(picked);
    await send();
  }

  async function send() {
    busy = true; err = "";
    try {
      const { code, expiresAt } = await createPair();
      sessionStorage.setItem(EXP_KEY, String(expiresAt));
      enterRoom({ code }); // rebinds the socket to the code room without reloading
    } catch {
      busy = false;
      // Only the choose state (roomCode "") drops the queue: a roomless stale queue
      // could surprise-send later (Fix-1's room-exit clearing never fires because no
      // room was entered). In the timedOut state the user is still in the room
      // retrying the re-mint — keep the batch; leaving the room (start over / tab
      // switch) clears it via the room-exit path.
      if (!roomCode) clearOutbox();
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
  {#if expired || timedOut}
    <!-- timedOut is the minter's own code lapsing ("expired, regenerate"); `expired`
         (a failed join) may equally be a typo'd code, so it reads "invalid or expired". -->
    <p class="error">{timedOut ? t.pair.expired : t.pair.errExpired}</p>
    <button class="btn btn-primary" onclick={() => { timedOut ? void send() : (sessionStorage.removeItem(EXP_KEY), enterRoom({})); }}>{timedOut ? t.pair.sendCode : t.pair.enterCode}</button>
  {:else if roomCode}
    {#if isMinter}
      <p class="lead">{t.pair.yourCode}</p>
      <div class="code">{roomCode}</div>
      <div class="row wrap">
        <button class="btn btn-ghost" onclick={() => copyText("code")}>{copied === "code" ? t.pair.copied : t.pair.copy}</button>
        <button class="btn btn-ghost" onclick={() => copyText("link")}>{copied === "link" ? t.pair.copied : t.pair.copyLink}</button>
        {#if canShare()}<button class="btn btn-ghost" onclick={() => share({ title: "Relayium", text: `Relayium: ${roomCode}`, url: joinLink })}>{t.share}</button>{/if}
        {#if remaining}<span class="ttl">{t.pair.expiresIn(remaining)}</span>{/if}
      </div>
      {#if qrDataUrl}
        <img class="qr" src={qrDataUrl} alt="QR" width="160" height="160" />
        <p class="scan">{t.pair.scanHint}</p>
      {/if}
      {#if outbox().length}
        <p class="queued">{t.pair.queued(outbox().length, formatSize(queuedBytes))}</p>
      {/if}
    {/if}
    <p class="waiting"><span class="pulse" aria-hidden="true"></span>{t.pair.waiting}</p>
  {:else if mode === "receive"}
    <p class="lead">{t.pair.enterHint}</p>
    <div class="row">
      <input
        inputmode="numeric"
        maxlength="6"
        placeholder="000000"
        bind:value={entry}
        oninput={() => {
          entry = entry.replace(/\D/g, "").slice(0, 6);
          if (entry.length === 6) join(); // full code — join without a second click
        }}
        onkeydown={(e) => { if (e.key === "Enter") join(); }}
      />
      <button class="btn btn-primary" disabled={entry.length !== 6} onclick={join}>{t.pair.joinBtn}</button>
    </div>
    <button class="btn-link" onclick={() => { mode = "choose"; entry = ""; err = ""; }}>{t.pair.back}</button>
  {:else}
    <div class="choices">
      <label class="btn btn-primary" class:disabled={busy}>
        📄 {t.sendFile}
        <input type="file" multiple disabled={busy} onchange={pickAndSend} />
      </label>
      {#if folderUploadSupported}
        <label class="btn btn-primary" class:disabled={busy}>
          📁 {t.sendFolder}
          <input type="file" webkitdirectory multiple disabled={busy} onchange={pickAndSend} />
        </label>
      {/if}
      <button class="btn btn-ghost" onclick={() => (mode = "receive")}>{t.pair.enterCode}</button>
    </div>
    <button class="btn-link" disabled={busy} onclick={send}>{busy ? t.generating : t.pair.bareConnect}</button>
  {/if}
  {#if err}<p class="error">{err}</p>{/if}
</section>

<style>
  .pairing { display: flex; flex-direction: column; align-items: center; gap: var(--space-3); padding: var(--space-2) 0; }
  .choices { display: flex; gap: var(--space-3); flex-wrap: wrap; justify-content: center; }
  .choices label.btn input[type="file"] { display: none; }
  .choices label.btn.disabled { opacity: .55; cursor: not-allowed; }
  .queued { margin: 0; font-size: var(--fs-xs); color: var(--text-h); text-align: center; }
  .qr { margin-top: var(--space-1); border-radius: var(--radius-sm); background: #fff; padding: 6px; }
  .scan { margin: 0; font-size: 12px; color: var(--text); text-align: center; max-width: 30ch; }
  .lead { margin: 0; font-size: var(--fs-sm); color: var(--text); text-align: center; }
  /* Intentional oversized code display — the whole point is at-a-glance readback. */
  .code {
    font-size: 40px; letter-spacing: 10px; font-weight: 700; color: var(--text-h);
    font-variant-numeric: tabular-nums; padding-left: 10px;
  }
  .row { display: flex; align-items: center; gap: var(--space-3); }
  /* The minter's action row can hold copy + copy-link + share + ttl; let it wrap
     on narrow screens instead of overflowing the card. */
  .row.wrap { flex-wrap: wrap; justify-content: center; }
  .ttl { font-size: var(--fs-xs); color: var(--text); font-variant-numeric: tabular-nums; }
  .waiting { display: inline-flex; align-items: center; gap: var(--space-2); margin: 0; font-size: var(--fs-xs); color: var(--text); }
  /* A slow breathing dot so a wait for the other side reads as "live", not stuck. */
  .pulse {
    width: 8px; height: 8px; border-radius: 50%; flex: none;
    background: var(--accent); animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: .25; transform: scale(.7); }
    50% { opacity: 1; transform: scale(1); }
  }
  @media (prefers-reduced-motion: reduce) { .pulse { animation: none; opacity: .7; } }
  /* Intentional oversized code-entry field to match the code display. */
  input {
    font: inherit; font-size: 22px; letter-spacing: 6px; text-align: center; width: 7ch;
    padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); border: 1px solid var(--border);
    background: var(--bg); color: var(--text-h); font-variant-numeric: tabular-nums;
  }
  .error { color: var(--danger); font-size: var(--fs-xs); margin: 0; }
</style>
