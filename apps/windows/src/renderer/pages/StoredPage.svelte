<!--
  Send a link — receive, send and history, in one page.

  Only RECEIVE is built. The other two modes say so in their own words rather
  than showing controls that do nothing: a greyed button reads as "broken" and a
  spinner reads as "nearly there", and both are lies a user acts on.

  ## Opening a link is not downloading it

  Pasting a link, or having Windows hand one to this window, puts it on screen.
  Nothing is fetched until the user asks, and nothing is WRITTEN until they pick
  a folder in a native dialog main opens. That ordering is the product's consent
  model, not a nicety, and it is why there is no "save automatically".

  ## The link is a secret

  Its fragment is the decryption key. It goes to main on `receive` and nowhere
  else: never rendered back into a message, never put in a title, never logged.
  What this page shows about a failure is a closed code from main.
-->
<script lang="ts">
  import { t } from "../i18n/index.svelte.js";
  import Card from "../shell/Card.svelte";
  import type { StoredController, StoredFailure } from "../stored/stored-controller.svelte.js";
  import { TTL_CHOICES, type StoredSendController } from "../send/stored-send-controller.svelte.js";

  let { stored, send, offered = "", onConsumed }: {
    /** App-lived: a transfer, its progress and the draft all outlive this page. */
    stored: StoredController;
    /** App-lived for the same reasons, plus one that is stronger: the picked
     *  `File` objects cannot be recovered without asking the user again. */
    send: StoredSendController;
    /** A link Windows handed this window. Shown, never acted on by itself. */
    offered?: string;
    onConsumed?: () => void;
  } = $props();

  // A link that arrived from outside lands in the box, and only there. The user
  // still has to ask, and still has to choose a folder.
  $effect(() => {
    if (offered === "" || stored.busy) return;
    stored.offer(offered);
    onConsumed?.();
  });

  const percent = $derived(stored.total > 0 ? Math.min(100, Math.round((stored.received / stored.total) * 100)) : 0);

  /** One sentence per closed code. Never the link, never a path. */
  function failureText(failure: StoredFailure): string {
    if (failure.code === "link-invalid") return t("storedFailedLinkInvalid");
    if (failure.code === "not-found") return t("storedFailedNotFound");
    if (failure.code === "forbidden") return t("storedFailedForbidden");
    if (failure.code === "integrity") return t("storedFailedIntegrity");
    if (failure.code === "network" || failure.code === "timeout") return t("storedFailedNetwork");
    if (failure.code === "runtime-unavailable") return t("storedFailedRuntime");
    return t("storedFailedGeneric");
  }

  /** Bytes as a person reads them. */
  function bytes(count: number): string {
    if (count < 1024) return `${String(count)} B`;
    if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;
    if (count < 1024 * 1024 * 1024) return `${(count / (1024 * 1024)).toFixed(1)} MB`;
    return `${(count / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function when(seconds: number): string {
    return seconds > 0 ? new Date(seconds * 1000).toLocaleDateString() : "";
  }

  function rowNoticeOf(kind: string): string {
    if (kind === "deleted") return t("sendDeleted");
    if (kind === "delete-failed") return t("sendDeleteFailed");
    if (kind === "rechecked") return t("sendRecheckedPublished");
    return t("sendRecheckedUnknown");
  }

  function stateOf(state: string): string {
    if (state === "published") return t("sendHistoryPublished");
    if (state === "ambiguous") return t("sendHistoryAmbiguous");
    if (state === "closed") return t("sendHistoryClosed");
    return state;
  }

  /** One sentence per closed refusal. Never a file name. */
  function refusalOf(refusal: NonNullable<StoredSendController["refusal"]>): string {
    if (refusal.kind === "unavailable") return t("sendRefusedUnavailable");
    if (refusal.kind === "at-capacity") return t("sendRefusedCapacity");
    if (refusal.kind === "signed-out") return t("sendRefusedSignedOut");
    if (refusal.kind === "nothing-picked") return t("sendRefusedNothing");
    if (refusal.kind === "refused" && refusal.manifest !== null) return t("sendRefusedManifest");
    return t("sendRefusedGeneric");
  }

  /**
   * The job the shown link belongs to.
   *
   * The COPY names a job rather than carrying the string: main composes the
   * link itself, so there is no channel that puts arbitrary text on the
   * clipboard.
   */

  /** A past send's link, held only while its row is showing it. */
  let shownLink = $state<string | null>(null);
  let shownLinkValue = $state<string | null>(null);
  async function toggleLink(jobId: string): Promise<void> {
    if (shownLink === jobId) {
      shownLink = null;
      shownLinkValue = null;
      return;
    }
    const link = await send.linkFor(jobId);
    shownLink = jobId;
    shownLinkValue = link;
  }

  function refusalText(code: string): string {
    if (code === "at-capacity") return t("storedAtCapacity");
    if (code === "too-long") return t("storedTooLong");
    return t("storedUnavailable");
  }
</script>

<h1>{t("storedTitle")}</h1>
<p class="lede">{t("storedSubtitle")}</p>

<Card title={t("storedReceiveHeading")}>
  <p class="dim">{t("storedReceiveBody")}</p>
  {#if stored.fromDeepLink}
    <p class="dim small" data-test="stored-from-link">{t("storedFromDeepLink")}</p>
  {/if}

  <form
    class="row"
    onsubmit={(e) => {
      e.preventDefault();
      void stored.open();
    }}
  >
    <label class="sr-only" for="stored-link">{t("storedLinkLabel")}</label>
    <input
      id="stored-link"
      data-test="stored-link"
      bind:value={stored.link}
      placeholder={t("storedLinkLabel")}
      disabled={stored.busy}
    />
    <button class="primary" type="submit" data-test="stored-open" disabled={stored.busy || stored.link.trim() === ""}>
      {t("storedReceiveAction")}
    </button>
  </form>

  {#if stored.busy}
    <p class="dim small" data-test="stored-progress">{t("storedProgress", { percent })}</p>
    <progress max="100" value={percent}></progress>
    <button data-test="stored-cancel" onclick={() => void stored.cancel()}>{t("storedCancel")}</button>
  {/if}

  {#if stored.refusal}
    <p class="problem" data-test="stored-refusal">{refusalText(stored.refusal)}</p>
  {/if}

  {#if stored.report}
    {#if stored.report.status === "saved"}
      <p data-test="stored-outcome">{t("storedSaved", { count: stored.report.publishedCount })}</p>
      {#if stored.report.residue}<p class="dim small" data-test="stored-residue">{t("storedResidue")}</p>{/if}
    {:else if stored.report.status === "partially-saved"}
      <p class="problem" data-test="stored-outcome">
        {t("storedPartial", { count: stored.report.publishedCount, total: stored.report.total })}
      </p>
      {#if stored.report.residue}<p class="dim small" data-test="stored-residue">{t("storedResidue")}</p>{/if}
    {:else if stored.report.status === "declined"}
      <p class="dim" data-test="stored-outcome">{t("storedDeclined")}</p>
    {:else if stored.report.status === "cancelled"}
      <p class="dim" data-test="stored-outcome">{t("storedCancelled")}</p>
      {#if stored.report.residue}<p class="dim small" data-test="stored-residue">{t("storedResidue")}</p>{/if}
    {:else}
      <p class="problem" data-test="stored-outcome">{failureText(stored.report.failure)}</p>
      <!-- "Nothing was saved" is only said when it is PROVEN. An unconfirmed
           publication gets its own sentence, and it asks the user to look. -->
      {#if stored.report.failure.published === "unknown"}
        <p class="dim small" data-test="stored-unconfirmed">{t("storedUnconfirmed")}</p>
      {/if}
      {#if stored.report.failure.residue}
        <p class="dim small" data-test="stored-residue">{t("storedResidue")}</p>
      {/if}
      <!-- Offered only where a fresh attempt could genuinely differ. After an
           integrity or destination failure it is absent, because suggesting a
           retry there implies the key or the disk might be fine. -->
      {#if stored.report.failure.retryable}
        <button data-test="stored-retry" onclick={() => void stored.open()}>{t("storedRetry")}</button>
      {/if}
    {/if}
  {/if}

  {#if stored.retained.length > 0}
    <p class="problem small" data-test="stored-retained">{t("storedRetained", { count: stored.retained.length })}</p>
    {#each stored.retained as ticket (ticket)}
      <button data-test="stored-cleanup-retry" onclick={() => void stored.retryCleanup(ticket)}>
        {t("storedRetainedRetry")}
      </button>
    {/each}
    {#if stored.cleanupNote}
      <p class="dim small" data-test="stored-cleanup-note">{t(stored.cleanupNote)}</p>
    {/if}
  {/if}
</Card>

<!--
  Send.

  The files are encrypted HERE, by the shared `encryptFiles` the Web client
  runs, before a byte is uploaded. The key travels in the link's fragment and
  never to the server — which is why the link is shown once, next to a Copy
  button, and is not stored anywhere.
-->
<Card title={t("sendHeading")}>
  <p class="dim">{t("sendBody")}</p>

  <!-- The native pickers. `webkitdirectory` opens the Windows folder dialog;
       neither gives this page a path it can name to main. -->
  <div class="row">
    <input
      id="send-files"
      class="sr-only"
      type="file"
      multiple
      data-test="send-files"
      onchange={(e) => send.pick([...((e.currentTarget as HTMLInputElement).files ?? [])])}
    />
    <label class="button" for="send-files">{t("sendPickFiles")}</label>
    <input
      id="send-folder"
      class="sr-only"
      type="file"
      webkitdirectory
      data-test="send-folder"
      onchange={(e) => send.pick([...((e.currentTarget as HTMLInputElement).files ?? [])])}
    />
    <label class="button" for="send-folder">{t("sendPickFolder")}</label>
  </div>

  {#if send.files.length > 0}
    <p class="dim" data-test="send-picked">
      {t("sendPicked", { count: send.files.length, size: bytes(send.totalBytes) })}
    </p>
    <div class="row">
      <label class="check">
        <input type="checkbox" data-test="send-burn" bind:checked={send.burnAfterRead} disabled={send.busy} />
        <span>{t("sendBurn")}</span>
      </label>
    </div>
    <div class="row">
      <label for="send-ttl">{t("sendExpiry")}</label>
      <select id="send-ttl" data-test="send-ttl" bind:value={send.ttlDays} disabled={send.busy}>
        {#each TTL_CHOICES as days (days)}
          <option value={days}>{t("sendExpiryDays", { days })}</option>
        {/each}
      </select>
    </div>
  {/if}

  {#if send.busy}
    <p class="dim" data-test="send-progress">
      {t("sendUploading", { percent: send.total > 0 ? Math.min(100, Math.round((send.committed / send.total) * 100)) : 0 })}
    </p>
    <progress value={send.committed} max={Math.max(1, send.total)}></progress>
    <button type="button" data-test="send-cancel" onclick={() => void send.cancel()}>{t("sendCancel")}</button>
  {:else}
    <div class="row">
      <button
        class="primary"
        type="button"
        data-test="send-start"
        disabled={send.files.length === 0}
        onclick={() => void send.send()}
      >
        {t("sendStart")}
      </button>
      {#if send.files.length > 0}
        <button type="button" data-test="send-clear" onclick={() => send.clear()}>{t("sendClear")}</button>
      {/if}
    </div>
  {/if}

  {#if send.refusal}
    <p class="problem" data-test="send-refusal">{refusalOf(send.refusal)}</p>
  {/if}

  {#if send.outcome}
    {#if send.outcome.status === "published"}
      <p data-test="send-published">{t("sendPublished")}</p>
      {#if send.link}
        <div class="row">
          <label class="sr-only" for="send-link">{t("sendLinkLabel")}</label>
          <input id="send-link" data-test="send-link" readonly value={send.link} />
          <button type="button" data-test="send-copy" onclick={() => void send.copyShownLink()}>
            {send.copied === "copied" ? t("sendCopied") : send.copied === "failed" ? t("sendCopyFailed") : t("sendCopy")}
          </button>
        </div>
      {/if}
    {:else if send.outcome.status === "ambiguous"}
      <!-- Never softened into either neighbour: no object id exists to put in a
           link, and asserting nothing was created is a claim this app cannot
           make. The key is retained, so checking again is real. -->
      <p class="problem" data-test="send-ambiguous">
        <strong>{t("sendAmbiguous")}</strong><br />{t("sendAmbiguousBody")}
      </p>
    {:else if send.outcome.status === "failed"}
      <p class="problem" data-test="send-failed">
        <strong>{t("sendFailed")}</strong><br />{t("sendFailedBody")}
      </p>
    {:else}
      <p class="dim" data-test="send-cancelled">{t("sendCancelled")}</p>
    {/if}
  {/if}
</Card>

<Card title={t("sendHistoryHeading")}>
  {#if send.historyUnavailable}
    <!-- NOT "you have not sent anything": the record could not be read, and
         claiming an empty history over it would be the reassuring lie. -->
    <p class="problem" data-test="send-history-unavailable">{t("sendHistoryUnavailable")}</p>
  {:else if send.history.length === 0}
    <p class="dim" data-test="send-history-empty">{t("sendHistoryEmpty")}</p>
  {:else}
    <ul class="list" data-test="send-history">
      {#each send.history as entry (entry.jobId)}
        <li>
          <div class="who">
            <span>{t("sendHistoryItem", { count: entry.fileCount, size: bytes(entry.totalBytes) })}</span>
            <span class="dim small">{stateOf(entry.state)}</span>
          </div>
          <div class="who">
            <span class="dim small">
              {entry.burnAfterRead ? t("sendHistoryBurn") : ""}
              {entry.expiresAt > 0 ? t("sendHistoryExpires", { when: when(entry.expiresAt) }) : ""}
            </span>
          </div>
          <div class="row">
            {#if entry.linkable}
              <button
                type="button"
                data-test="send-history-link"
                disabled={send.working.includes(entry.jobId)}
                onclick={() => void toggleLink(entry.jobId)}
              >
                {shownLink === entry.jobId ? t("sendHideLink") : t("sendShowLink")}
              </button>
              <button
                type="button"
                data-test="send-history-copy"
                disabled={send.working.includes(entry.jobId)}
                onclick={() => void send.copyLink(entry.jobId)}
              >
                {t("sendCopy")}
              </button>
              <button
                class="danger"
                type="button"
                data-test="send-history-delete"
                disabled={send.working.includes(entry.jobId)}
                onclick={() => void send.remove(entry.jobId)}
              >
                {t("sendDelete")}
              </button>
            {:else if entry.state === "ambiguous"}
              <button
                type="button"
                data-test="send-history-recheck"
                disabled={send.working.includes(entry.jobId)}
                onclick={() => void send.reconcile(entry.jobId)}
              >
                {t("sendCheckAgain")}
              </button>
            {/if}
          </div>
          {#if shownLink === entry.jobId && shownLinkValue}
            <input class="full" data-test="send-history-link-value" readonly value={shownLinkValue} />
          {/if}
          {#if send.rowNotice?.jobId === entry.jobId}
            <!-- A delete or a re-check ALWAYS says what it did. A failed delete
                 that said nothing left the user believing an object was gone
                 when it is still there. -->
            <p class="dim small" data-test="send-row-notice">{rowNoticeOf(send.rowNotice.kind)}</p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</Card>

<style>
  h1 { margin: 0 0 var(--space-hairline); font-size: 20px; font-weight: 600; }
  .lede { margin: 0 0 var(--space-section); color: var(--text-dim); }
  .dim { color: var(--text-dim); margin: 0 0 var(--space-tight); }
  .small { font-size: 13px; }
  .problem { margin: 0 0 var(--space-inner); }
  .row { display: flex; gap: var(--space-tight); margin-bottom: var(--space-inner); }
  .row input { flex: 1; }
  progress { width: 100%; }
  .list { list-style: none; margin: 0; padding: 0; }
  .list li { padding: var(--space-inner) 0; border-top: 1px solid var(--border); }
  .list li:first-child { border-top: none; }
  .who { display: flex; gap: var(--space-inner); justify-content: space-between; align-items: baseline; }
  .check { display: flex; gap: var(--space-tight); align-items: center; }
  .full { width: 100%; margin-top: var(--space-tight); }
  progress { width: 100%; margin-bottom: var(--space-tight); }
  /* A `<label>` driving a hidden file input IS the control, so it wears the
     shared button vocabulary rather than a second set of rules. */
  .button {
    display: inline-flex;
    align-items: center;
    min-height: 32px;
    padding: 6px var(--space-section);
    border-radius: var(--corner);
    border: 1px solid var(--border);
    background: var(--bg);
    cursor: pointer;
    font-weight: 500;
  }
  .button:hover { background: var(--surface); }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
