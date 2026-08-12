<script lang="ts">
  // The receiver's surface for files the peer pre-uploaded: its own accept step,
  // its own progress, its own terminal states.
  //
  // A SEPARATE card from the live-link consent card, deliberately and for now.
  // The eventual shape is one received list whose rows carry two origins (see
  // the plan's seam 5), but that is presentation work on an already intricate
  // lane; merging them before the transport is proven would put a new origin
  // inside the state machine that owns save targets, resume checkpoints and
  // consent timeouts. What matters for correctness is that this card asks the
  // SAME question the live one does before anything is written — bytes parked in
  // storage are still bytes a stranger who guessed a code could be sending.

  import { formatSize } from "./format";
  import { messages, lang, type Messages } from "./i18n.svelte";
  import ReceiveActions from "./ReceiveActions.svelte";
  import type { StoredReceiver } from "./preupload-receive.svelte";

  let { receiver }: { receiver: StoredReceiver } = $props();

  const t = $derived<Messages>(messages[lang()]);
  const total = $derived(receiver.total);
  const pct = $derived(total > 0 ? Math.round((receiver.received / total) * 100) : 0);
  const errText = $derived(
    receiver.errorKey === "gone" ? t.storedRecv.errGone
      : receiver.errorKey === "netFail" ? t.storedRecv.errNet
      : receiver.errorKey === "decryptFail" ? t.storedRecv.errDecrypt
      : receiver.errorKey === "saveFail" ? t.storedRecv.errSave
      : "",
  );
  /**
   * What actually happened to the files, as a sentence of its own.
   *
   * Never folded into the error text. On every target that flushes per file — a
   * chosen folder, per-file browser downloads — a batch that stopped partway
   * really did leave the earlier files on disk, and the four error strings used
   * to end in "Nothing was saved." regardless. A user told that has half a
   * folder they do not know about, and no reason to expect the retry to land
   * beside it. `savedCount` is 0 for a target that only delivers on finalise
   * (the ZIP branch), so this cannot overclaim in the other direction either.
   */
  const outcomeText = $derived(
    receiver.savedCount > 0 ? t.storedRecv.savedSome(receiver.savedCount) : t.storedRecv.nothingSaved,
  );
</script>

{#if receiver.status !== "idle"}
  <div class="ui-callout ui-callout-accent stored-incoming">
    {#if receiver.status === "prompt"}
      <p class="si-lead">{t.storedRecv.lead(receiver.files.length, formatSize(total))}</p>
      <ul class="si-files">
        {#each receiver.files as f, i (`${i}:${f.path ?? f.name}`)}
          <li><span class="si-name">{f.path ?? f.name}</span> <span class="si-size">{formatSize(f.size)}</span></li>
        {/each}
      </ul>
      <p class="si-note">{t.storedRecv.note}</p>
      <!-- The SAME control the live lane's consent card uses, not a second pair
           of buttons. It carries the two pre-flight answers that have to be
           given before the click, because the click is the user gesture the save
           picker needs and there is no second chance to ask: whether this batch
           is big enough to be a memory risk on a browser with no streaming sink
           (the ZIP branch peaks at ~2× the batch), and whether pressing it opens
           a location picker or drops the files in the download folder. Writing
           those conditions out again here is exactly how the two receive paths
           drift apart from what pickSaveTarget will actually do.
           Accept runs inside the click on purpose, as the live lane's does. -->
      <ReceiveActions
        files={receiver.files.slice()}
        {total}
        acceptLabel={t.storedRecv.accept}
        rejectLabel={t.storedRecv.reject}
        onAccept={() => void receiver.accept()}
        onReject={() => receiver.reject()}
      />
    {:else if receiver.status === "resolving" || receiver.status === "receiving"}
      <p class="si-lead">{t.storedRecv.receiving}</p>
      {#if receiver.status === "receiving" && total > 0}
        <progress class="si-progress" max="100" value={pct} aria-label={t.storedRecv.receiving}></progress>
        <span class="si-pct">{pct}%</span>
      {/if}
    {:else if receiver.status === "done"}
      <p class="si-lead">{t.storedRecv.done}</p>
      <div class="si-actions">
        <button class="btn btn-secondary" onclick={() => receiver.dismiss()}>{t.storedRecv.dismiss}</button>
      </div>
    {:else if receiver.status === "failed"}
      <!-- Never "saved": a batch that did not complete says so, says what was
           actually left on the disk, and offers the retry only when a retry
           could work. The one failure with a different remedy (the stored
           ciphertext is no longer there) renders no retry control at all,
           because there is nothing left to fetch. Its copy says that and no
           more: the server sends 404/410 without a reason, and the receiver
           holding a handoff is in a joined room that has no deadline to blame
           anyway — see `classify` in preupload-receive.svelte.ts. -->
      <p class="si-lead si-error">{errText}</p>
      <p class="si-note si-outcome">{outcomeText}</p>
      <div class="si-actions">
        {#if receiver.retryable}
          <button class="btn btn-primary si-retry" onclick={() => receiver.retry()}>{t.storedRecv.retry}</button>
        {/if}
        <button class="btn btn-secondary" onclick={() => receiver.dismiss()}>{t.storedRecv.dismiss}</button>
      </div>
    {/if}
    {#if receiver.waitingCount > 0}
      <p class="si-more">{t.storedRecv.more(receiver.waitingCount)}</p>
    {/if}
  </div>
{/if}

<style>
  .stored-incoming { display: grid; gap: 0.6rem; }
  .si-lead { margin: 0; font-weight: 600; }
  .si-error { font-weight: 500; }
  .si-note { margin: 0; font-size: 0.86rem; opacity: 0.8; }
  .si-more { margin: 0; font-size: 0.86rem; opacity: 0.8; }
  .si-files { margin: 0; padding-inline-start: 1.1rem; display: grid; gap: 0.2rem; font-size: 0.9rem; }
  .si-files li { min-width: 0; overflow-wrap: anywhere; }
  .si-size { opacity: 0.7; }
  .si-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .si-progress { inline-size: 100%; }
  .si-pct { font-variant-numeric: tabular-nums; font-size: 0.86rem; }
</style>
