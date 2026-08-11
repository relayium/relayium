<!-- web/src/lib/CodePairing.svelte -->
<script lang="ts">
  import { CODE_LEN, isValidCode, normalizeCode } from "./pair-code";
  import { copyFeedback } from "./clipboard.svelte";
  import { createPair, CROSS_PATH, HttpError } from "./transfer-link";
  import { canShare, share } from "./share";
  import { enterRoom } from "./room.svelte";
  import { messages, lang, type Messages } from "./i18n.svelte";
  import { outbox, addToOutbox, removeFromOutbox, clearOutbox, outboxIndexOf } from "./outbox.svelte";
  import { startPreupload, holdPreupload, resetPreupload, preuploadNotice, preuploadProgress, preuploadDeadline, preuploadUnconfirmed } from "./preupload.svelte";
  import { onMount } from "svelte";
  import { pickedFromInput, filesFromDataTransfer, hasFiles } from "./drag";
  import { formatSize } from "./format";
  import { folderUploadSupported } from "./platform";
  import { session } from "./auth.svelte";
  import { relayWarnNote } from "./relay-status";
  import type { RelayAvailability } from "./ice";
  import Icon from "./Icon.svelte";
  import PendingFiles from "./PendingFiles.svelte";

  let { roomCode = "", expired = false, relayStatus = "ok", requireLogin }:
    { roomCode?: string; expired?: boolean; relayStatus?: RelayAvailability; requireLogin?: () => void } = $props();

  const t = $derived<Messages>(messages[lang()]);
  const EXP_KEY = "relayium_pair_exp";

  let mode = $state<"choose" | "receive">("choose");
  let entry = $state("");
  let busy = $state(false);
  let err = $state("");
  // Which copy button last fired ("" = none) so each shows its own "copied" state.
  const copied = copyFeedback();

  // The full join link the recipient opens (same string the QR encodes). Opening
  // it auto-joins the code room, so forwarding this link == sharing the code.
  const joinLink = $derived(`${location.origin}${CROSS_PATH}#c=${roomCode}`);

  // isMinter: true on the device that minted the code (EXP_KEY written to
  // sessionStorage); false on the recipient who typed in a code.
  const isMinter = sessionStorage.getItem(EXP_KEY) !== null;

  // The mint's own window: 300 s from the moment the code was issued, stashed by
  // send(). Re-read whenever the room changes, which is the only thing that can
  // change it — a fresh mint writes it before enterRoom flips roomCode. 0 for a
  // joiner (no marker) and for the choose screen (no room), and that zero is
  // what keeps both of them out of every countdown branch below.
  const mintExpiry = $derived(roomCode ? Number(sessionStorage.getItem(EXP_KEY)) || 0 : 0);

  // What the SERVER last said this room's window ends at, and only if it said it
  // about the room on screen. A deadline is one room's fact: it is earned by
  // bytes bound to that room, it is usually the LATER of the two, and a re-mint
  // or a direct code change must not inherit it — see preupload.svelte.ts.
  const roomExpiry = $derived.by(() => {
    const d = preuploadDeadline();
    return d && d.code === roomCode ? d.expiresAt : 0;
  });

  // The code's real deadline, as far as this page can honestly know it. The
  // later of the two on purpose: the server moves the code's registry entry
  // FORWARD to the room's join deadline and never back, so a room extension
  // supersedes the mint, and a room that has not extended anything leaves the
  // mint exactly as authoritative as it was before pre-upload existed.
  const codeExpiry = $derived(Math.max(mintExpiry, roomExpiry));

  // Bytes are going up against THIS room right now. While that is true the
  // deadline is moving with every chunk the server commits and this page is not
  // told where to until the upload finishes, so there is no number it may show —
  // and, more importantly, no moment at which it may call the code dead.
  const holdingOpen = $derived(!!roomCode && preuploadProgress()?.code === roomCode);

  // Bytes went up against THIS room and no answer about it ever came back, so
  // the deadline may have moved past anything on this page and may not have.
  // Three states, not two: uploading (moving, unknowable), a deadline the server
  // named, and this — which is neither, and must not be collapsed into either.
  const unconfirmed = $derived(!!roomCode && preuploadUnconfirmed() === roomCode);

  // Countdown (only the minting device has the expiry stashed).
  let remaining = $state(""); // "m:ss" or ""
  let timedOut = $state(false); // the minter's own countdown hit zero — the code is now dead
  $effect(() => {
    const exp = codeExpiry;
    // Read HERE, in the effect's own body, so that doubt arriving after the
    // countdown has already lapsed re-arms it in the same turn. Read only inside
    // `tick` it would be a dependency of nothing, and the card would sit in the
    // expired state until the next interval fired — a full second of announcing
    // an expiry it had just learned it was not entitled to.
    const vague = unconfirmed;
    // No number, and nothing to give up on: a joiner, the choose screen, or a
    // room whose upload is still pushing the deadline out.
    if (!exp || holdingOpen) { remaining = ""; timedOut = false; return; }
    timedOut = false; // re-armed for each fresh code / each later deadline
    // Still counted, and counted to the LATER of the mint and whatever the
    // server last named — an acknowledged deadline is a real floor and is worth
    // showing. What lapsing may no longer do is set `timedOut`: see the tick.
    const tick = () => {
      const left = exp - Math.floor(Date.now() / 1000);
      // Once it lapses, flip into the expired branch so the minter isn't left
      // showing a live-looking code that the other side can no longer join.
      //
      // Unless the room's window is one this page could not confirm. "Expired"
      // is a claim about the SERVER, and the only thing that entitles this page
      // to make it is a deadline it knows the server honours — the mint's, or
      // one the server named. After an upload put bytes up and said nothing
      // back, neither is the whole story: the committed bytes may have pushed
      // the room (and the code) past this instant. So the number simply stops
      // and the unknown line takes over, rather than the card flipping to
      // "expired, generate a new one" with a button that burns the rendezvous.
      if (left <= 0) { remaining = vague ? "" : "0:00"; timedOut = !vague; return; }
      remaining = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    };
    tick();
    const h = setInterval(tick, 1000);
    return () => clearInterval(h);
  });

  // The unknown line goes up only when there is nothing better to say. A number
  // to count is better — it is a floor the server named — and so is an upload in
  // flight: bytes committing right now are pushing the deadline out whatever an
  // earlier attempt failed to report, and "could not be confirmed" beside "stays
  // valid while these files upload" is two answers to one question.
  const showUnknown = $derived(unconfirmed && !holdingOpen && !remaining);

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
  const relayWarn = $derived(relayWarnNote(t, relayStatus));

  // Staging inside a waiting room. Every pick ADDS to the batch (addToOutbox,
  // not setOutbox): the user is assembling what to send over several gestures
  // while the code is out, and a replace would silently drop the previous drop —
  // including a batch that arrived from the OS share sheet before the code was
  // minted. App's auto-send effect drains whatever is queued the moment the
  // other device joins, so nothing here needs to know about the transport.
  function stagePicked(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    if (input.files?.length) addToOutbox(pickedFromInput(input.files));
    input.value = ""; // allow re-picking the same files
  }

  // Spend the wait instead of sitting in it: the staged batch goes up as
  // ciphertext bound to this code, one object per file, so a file that is
  // already stored when the other device arrives skips the sender's uplink
  // entirely. Whether anything actually happens is decided inside
  // (preuploadSenderReady) and by the server; until both say yes this is the
  // same live-link-only staging box it was, which is why nothing here branches
  // on it.
  //
  // Deliberately not gated on `timedOut`: that countdown runs from the MINT,
  // while the room's real deadline runs from the last uploaded byte, so a long
  // upload outlives it. The server is the authority — it answers 410 when the
  // room is genuinely over — and the driver stops on that.
  $effect(() => {
    if (!isMinter || !roomCode || !outbox().length) return;
    void startPreupload(roomCode);
  });

  // Leaving this surface — the peer joined, or the user walked away — must stop
  // NEW uploads without touching the one in flight: the protocol refuses only a
  // new init once someone has joined, and the running upload's bytes are already
  // sent and already billed. onMount's teardown rather than the effect's, which
  // re-runs on every staging change.
  //
  // It names the room this instance was mounted for, captured at mount. The
  // choose screen and the waiting room are two instances of this component in
  // two `{#if}` branches, so a mint tears one down while building the other, and
  // an unqualified hold from the outgoing instance would stop the incoming
  // room's driver before it ever started.
  onMount(() => {
    const mounted = roomCode;
    return () => holdPreupload(mounted);
  });

  // Drag state is local to the staging box, so the highlight cannot outlive the
  // branch that renders it.
  let dragOver = $state(false);

  // The upload in flight, resolved back to the file it belongs to. By handle,
  // never by index: the queue moves while an upload runs, and a stale index
  // would name a different file in the very line that claims to be uploading it.
  const uploading = $derived.by(() => {
    const p = preuploadProgress();
    if (!p) return null;
    const at = outboxIndexOf(p.token);
    if (at < 0) return null;
    const pct = p.total > 0 ? Math.min(100, Math.floor((p.sent / p.total) * 100)) : 0;
    return { name: outbox()[at].file.name, pct };
  });

  async function stageDropped(e: DragEvent) {
    e.preventDefault();
    // The window-level handler in App also claims file drops. It is inert here
    // today (it only sends when exactly one peer is visible, and a waiting room
    // has none), but this box owns the drop either way — matching the peer
    // cards, which stop propagation for exactly this reason.
    e.stopPropagation();
    dragOver = false;
    if (!e.dataTransfer) return;
    // Same walker the LAN drop zones use, so a dropped FOLDER expands to its
    // files with their relative paths instead of being silently ignored.
    const picked = await filesFromDataTransfer(e.dataTransfer);
    if (picked.length) addToOutbox(picked);
  }

  async function send() {
    busy = true; err = "";
    try {
      const { code, expiresAt } = await createPair();
      sessionStorage.setItem(EXP_KEY, String(expiresAt));
      // A fresh code is a fresh room. Anything still uploading belongs to the
      // old one — its ciphertext is bound to a room the new code cannot reach,
      // so paying for the rest of those bytes buys nothing; the abort returns
      // that file to the live-link lane. It also drops the previous room's
      // explanation, which is about a code that no longer exists.
      resetPreupload();
      enterRoom({ code }); // rebinds the socket to the code room without reloading
    } catch (e) {
      busy = false;
      // Only the choose state (roomCode "") drops the queue: a roomless stale queue
      // could surprise-send later (Fix-1's room-exit clearing never fires because no
      // room was entered). In the timedOut state the user is still in the room
      // retrying the re-mint — keep the batch; leaving the room (start over / tab
      // switch) clears it via the room-exit path.
      if (!roomCode) { clearOutbox(); resetPreupload(); }
      // A 401 means the session lapsed between render and mint — re-open the login
      // panel instead of a dead-end "couldn't create a code" error.
      if (e instanceof HttpError && e.status === 401) { requireLogin?.(); return; }
      // Minting a brand-new code just failed; it was never issued, so "expired"
      // would be misleading — report a mint/network failure instead.
      err = t.pair.mintFailed;
    }
  }

  function join() {
    if (!isValidCode(entry)) return;
    // A joiner is never the minter — drop any stale mint marker from an earlier
    // "create code" this session so isMinter resolves correctly after start-over.
    sessionStorage.removeItem(EXP_KEY);
    enterRoom({ code: entry });
  }

  const copyText = (what: "code" | "link") =>
    copied.copy(what === "code" ? roomCode : joinLink, what);
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
        <button class="btn btn-ghost" class:copied={copied.value === "code"} onclick={() => copyText("code")}>{copied.value === "code" ? t.pair.copied : t.pair.copy}</button>
        <button class="btn btn-ghost" class:copied={copied.value === "link"} onclick={() => copyText("link")}>{copied.value === "link" ? t.pair.copied : t.pair.copyLink}</button>
        {#if canShare()}<button class="btn btn-ghost" onclick={() => share({ title: "Relayium", text: `Relayium: ${roomCode}`, url: joinLink })}>{t.share}</button>{/if}
        <!-- Three answers to one question, in the order of how much this page
             actually knows. While bytes are moving there is no number at all —
             every committed chunk pushes the deadline out again. Where an
             upload put bytes up and got no answer about the room, there is no
             number either, and no right to call the code dead. Only a deadline
             the server named (or the mint, which it also named) is countable. -->
        {#if holdingOpen}
          <span class="ttl">{t.pair.ttlUploading}</span>
        {:else if showUnknown}
          <span class="ttl">{t.pair.ttlUnknown}</span>
        {:else if remaining}
          <span class="ttl">{t.pair.expiresIn(remaining)}</span>
        {/if}
      </div>
      <!-- The countdown is about the CODE, not about the transfer. Without this
           line a shrinking timer next to a live session reads as "your transfer
           has N minutes left", which is what the owner reported believing. -->
      {#if remaining}
        <p class="ttl-note">{t.pair.ttlNote}</p>
      {:else if showUnknown}
        <!-- The doubt, and something real to do about it. Without the button
             the user is left holding six digits with no way forward but "start
             over", which discards the batch too; with it, minting a fresh code
             stays the user's decision rather than a state the card walked them
             into by claiming an expiry it was never told about. -->
        <p class="ttl-note">{t.pair.ttlUnknownNote}</p>
        <button class="btn btn-ghost" disabled={busy} onclick={() => void send()}>{busy ? t.generating : t.pair.sendCode}</button>
      {/if}
      {#if qrDataUrl}
        <img class="qr" src={qrDataUrl} alt="QR" width="160" height="160" />
        <p class="scan">{t.pair.scanHint}</p>
      {/if}
      <!-- Say what to do with the code that is now on screen. Everything above
           this line is the code itself; without an instruction the screen shows
           six digits and a spinner and leaves the handoff to be guessed. -->
      <p class="handoff">{t.pair.handoff}</p>

      <!-- The staging surface, and the reason the mint moved first. The batch is
           assembled HERE, during the wait, instead of before the code exists.
           `stageNote` says only that the transfer starts by itself on join: it is
           deliberately silent about where the bytes are, because that is exactly
           what changes when pre-upload lands, and a note that has to be corrected
           later is worse than one that was never that specific. It must not say
           "never uploaded" — that is a LAN promise (see lanStagedNote), not a
           code-room one. -->
      <!-- role/label rather than a bare div: this is a drop target, and a drop
           target with no role is invisible to anything that is not a mouse. -->
      <div
        class="staging"
        role="group"
        aria-labelledby="stage-lead"
        class:dragover={dragOver}
        ondragover={(e) => { if (hasFiles(e.dataTransfer?.types)) { e.preventDefault(); dragOver = true; } }}
        ondragleave={() => (dragOver = false)}
        ondrop={stageDropped}
      >
        <!-- labelledby, not a duplicate aria-label: the group's name is this
             visible line, so an aria-label would make a screen reader read the
             same sentence twice — once as the name, once as the content. -->
        <p class="stage-lead" id="stage-lead">{t.pair.stageLead}</p>
        <div class="row wrap">
          <label class="btn btn-ghost">
            <Icon name="file" size={18} /> {t.pair.stageAdd}
            <input class="file-pick-input" type="file" multiple onchange={stagePicked} />
          </label>
          {#if folderUploadSupported}
            <label class="btn btn-ghost">
              <Icon name="folder" size={18} /> {t.pair.stageAddFolder}
              <input class="file-pick-input" type="file" webkitdirectory multiple onchange={stagePicked} />
            </label>
          {/if}
        </div>
        <p class="stage-drop">{t.pair.stageDrop}</p>
        {#if outbox().length}
          <!-- Staging is only honest if it is reversible: without a per-file
               remove, one misdrag can only be undone by "start over", which
               discards the code along with the batch. -->
          <PendingFiles
            files={outbox()}
            summary={t.pair.queued(outbox().length, formatSize(queuedBytes))}
            onRemove={removeFromOutbox}
            removeLabel={t.pair.stageRemove}
          />
          <p class="stage-note">{t.pair.stageNote}</p>
          <!-- The one line in this room that says bytes are leaving the device,
               and it is on screen only while that is happening. -->
          {#if uploading}
            <p class="stage-progress">{t.pair.preuploading(uploading.name, uploading.pct)}</p>
          {/if}
        {/if}
      </div>
    {/if}
    <!-- Deliberately OUTSIDE the isMinter branch: both ends of a code room fetch
         their own /api/ice, and the side that typed or scanned the code is the
         one with nothing else on screen — without this it sees only "waiting"
         and then a connection failure it was never warned about. Rendered once
         for either role. Empty for "ok" and for LAN, which is the normal case. -->
    {#if relayWarn}
      <p class="quota-warn">{relayWarn}</p>
    {/if}
    <p class="waiting"><span class="pulse" aria-hidden="true"></span>{t.pair.waiting}</p>
  {:else if mode === "receive"}
    <p class="lead">{t.pair.enterHint}</p>
    <div class="row">
      <!-- 数字键盘不是装饰：接收端最常见的设备是手机，而 Android 只有在
           inputmode="numeric" **加上** pattern="[0-9]*" 都在的时候才可靠地弹出纯
           数字键盘（Chrome 在只有 inputmode 时对 type="text" 仍会给出全键盘的变体）。
           type 保持 text 而不是 number：number 会带上加减箭头、允许 e/+/- 和小数点、
           并且在部分浏览器里把 "004291" 规范化成 4291——码是字符串，前导零有意义。
           autocomplete="one-time-code" 让 iOS/Android 能从短信/剪贴板直接建议这六位。

           **不要把 maxlength 加回来。** 浏览器把 maxlength 作用在粘贴进来的原始串
           上，发生在 oninput 归一化之前：粘 "483-920" 会先被截成 "483-92"，归一化后
           只剩五位的 "48392"——用户看到一个自己并没有输错的无效码，而且只有在真实
           浏览器里粘贴带格式的码时才复现。长度上限由下面的 normalizeCode() 负责
           （每次 input 都截到 CODE_LEN），绑定值仍然是六位，前导零也不受影响。 -->
      <input
        type="text"
        inputmode="numeric"
        pattern="[0-9]*"
        autocomplete="one-time-code"
        autocorrect="off"
        spellcheck="false"
        placeholder="483920"
        aria-label={t.pair.enterHint}
        bind:value={entry}
        oninput={() => {
          // 归一化收在一处（只留数字），粘贴一段带空格或连字符的码也能直接用。
          entry = normalizeCode(entry);
          if (entry.length === CODE_LEN) join(); // 输满即加入，不用再点一次
        }}
        onkeydown={(e) => { if (e.key === "Enter") join(); }}
      />
      <button class="btn btn-primary" disabled={entry.length !== CODE_LEN} onclick={join}>{t.pair.joinBtn}</button>
    </div>
    <button class="btn-link" onclick={() => { mode = "choose"; entry = ""; err = ""; }}>{t.pair.back}</button>
  {:else if session().user}
    <!-- One sender action, deliberately. This screen used to lead with "Send
         files" / "Send a folder", which mint a code only once a batch is picked;
         the owner inverted that on 2026-08-11 because picking first is exactly
         what left the sender with nothing to do while the code sat unclaimed.
         Minting first turns the wait into working time — the staging surface is
         in the waiting branch above, beside the code there is to pass on.
         No file input belongs here: one would rebuild the old ordering right
         next to the button that replaced it. Entering someone else's code stays,
         and is the only way in for a receiver who was read six digits. -->
    <div class="choices">
      <button class="btn btn-primary create-code" disabled={busy} onclick={send}>
        <Icon name="bolt" size={18} /> {busy ? t.generating : t.pair.sendCode}
      </button>
      <button class="btn btn-ghost" onclick={() => (mode = "receive")}>{t.pair.enterCode}</button>
    </div>
  {:else}
    <div class="signin">
      <button class="btn btn-primary" onclick={() => requireLogin?.()}>{t.account.signIn}</button>
      <p class="hint">{t.crossnet.signInToSend}</p>
    </div>
    <button class="btn btn-ghost" onclick={() => (mode = "receive")}>{t.pair.enterCode}</button>
  {/if}
  <!-- Outside every branch on purpose. The room's deadline runs from the last
       uploaded byte and the on-screen countdown runs from the mint, so a 410
       almost always lands after this card has already flipped to its expired
       state — and that is exactly the moment the user needs to be told that the
       upload bought nothing and their files are still here. -->
  {#if preuploadNotice() === "expired"}<p class="preupload-expired">{t.pair.preuploadExpired}</p>{/if}
  {#if err}<p class="error">{err}</p>{/if}
</section>

<style>
  .pairing { display: flex; flex-direction: column; align-items: center; gap: var(--space-3); padding: var(--space-2) 0; }
  .choices { display: flex; gap: var(--space-3); flex-wrap: wrap; justify-content: center; }
  .signin { display: flex; flex-direction: column; align-items: center; gap: var(--space-2); padding: var(--space-2) 0; }
  .signin .hint { margin: 0; font-size: var(--fs-xs); color: var(--text); text-align: center; max-width: 34ch; }
  .qr { margin-top: var(--space-1); border-radius: var(--radius-sm); background: #fff; padding: 6px; }
  .scan { margin: 0; font-size: 12px; color: var(--text); text-align: center; max-width: 30ch; }
  .lead { margin: 0; font-size: var(--fs-sm); color: var(--text); text-align: center; }
  /* The instruction that turns six digits into an action. Sits between the code
     block and the staging box, so it reads as "pass this on" rather than as a
     caption for either. */
  .handoff {
    margin: 0; font-size: var(--fs-sm); line-height: 1.5; color: var(--text-h);
    text-align: center; max-width: 40ch;
  }
  /* The staging box is a drop target for the whole wait, so it keeps a visible
     boundary even when empty — an invisible one is not a target anyone aims at. */
  .staging {
    inline-size: 100%; max-inline-size: 30rem;
    display: flex; flex-direction: column; align-items: center; gap: var(--space-2);
    padding: var(--space-3);
    border: 1px dashed var(--border); border-radius: var(--radius-sm);
    background: var(--surface-2);
    transition: border-color .15s ease, background-color .15s ease;
  }
  .staging.dragover { border-color: var(--accent); background: var(--code-bg); }
  @media (prefers-reduced-motion: reduce) { .staging { transition: none; } }
  .stage-lead { margin: 0; font-size: var(--fs-sm); color: var(--text-h); text-align: center; }
  .stage-drop { margin: 0; font-size: var(--fs-xs); color: var(--text); text-align: center; }
  .stage-note { margin: 0; font-size: var(--fs-xs); line-height: 1.5; color: var(--text); text-align: center; max-width: 36ch; }
  .stage-progress {
    margin: 0; font-size: var(--fs-xs); line-height: 1.5; color: var(--text-h);
    text-align: center; max-width: 36ch; font-variant-numeric: tabular-nums;
  }
  /* Not `.error`: nothing failed that the user did, and the files are still
     here. It reads as the explanation it is, next to the code they now have to
     re-mint. */
  .preupload-expired {
    margin: 0; font-size: var(--fs-xs); line-height: 1.5; text-align: center; max-width: 40ch;
    color: var(--text-h);
    border: 1px solid var(--accent-border); border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3); background: var(--code-bg);
  }
  /* The list brings its own surface; inside this box that would be a panel in a
     panel. */
  .staging :global(.pending-files) {
    inline-size: 100%; margin-block-end: 0; background: transparent; border: 0; padding: 0;
  }
  /* Intentional oversized code display — the whole point is at-a-glance readback. */
  .code {
    font-size: 40px; letter-spacing: 10px; font-weight: 700; color: var(--text-h);
    font-variant-numeric: tabular-nums; padding-inline-start: 10px;
  }
  .row { display: flex; align-items: center; gap: var(--space-3); }
  /* Copy success: brief green + pop on the button that just fired. */
  .btn.copied { color: var(--ok); border-color: var(--ok-border); animation: pop-in .3s ease; }
  @media (prefers-reduced-motion: reduce) { .btn.copied { animation: none; } }
  /* The minter's action row can hold copy + copy-link + share + ttl; let it wrap
     on narrow screens instead of overflowing the card. */
  .row.wrap { flex-wrap: wrap; justify-content: center; }
  .ttl { font-size: var(--fs-xs); color: var(--text); font-variant-numeric: tabular-nums; }
  .ttl-note { margin: 0; font-size: var(--fs-xs); line-height: 1.5; color: var(--text); text-align: center; max-width: 40ch; }
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
  .quota-warn {
    margin: 0; font-size: var(--fs-xs); line-height: 1.5; text-align: center; max-width: 34ch;
    color: var(--text-h);
    border: 1px solid var(--accent-border); border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3); background: var(--code-bg);
  }
</style>
