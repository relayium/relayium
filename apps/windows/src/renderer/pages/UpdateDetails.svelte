<!--
  The Updates pane.

  All eighteen states render distinctly. Affordances come from `view.actions`,
  which main computed from the core's own predicates — this file never infers a
  button from a state name, and there is no branch here that installs from
  anything but `ready` or reveals from anything but `ready-unsigned`.

  Progress is drawn from `receivedBytes` against the signed `sizeBytes` and from
  nothing else. There is no timer, no interpolation and no indeterminate bar
  standing in for a determinate one.
-->
<script lang="ts">
  import { lang } from "../i18n/index.svelte.js";
  import Card from "../shell/Card.svelte";
  import { ut, type UpdateMessageKey } from "../update/messages.js";
  import { formatBytes, formatDateTime } from "../account/format.js";
  import type { UpdateSummaryController } from "../update/update-controller.svelte.js";
  import type { UpdateCandidateView, UpdateReason } from "../../shared/update-summary.js";

  let { controller }: { controller: UpdateSummaryController } = $props();

  const view = $derived(controller.view);
  const state = $derived(view.state);
  const actions = $derived(view.actions);
  const locale = $derived(lang());

  /** One closed reason, as a sentence. Never the raw code. */
  const REASONS: Record<UpdateReason, UpdateMessageKey> = {
    network: "reasonNetwork",
    timeout: "reasonTimeout",
    cancelled: "reasonCancelled",
    http: "reasonHttp",
    redirect: "reasonRedirect",
    "too-large": "reasonTooLarge",
    "untrusted-host": "reasonUntrustedHost",
    malformed: "reasonMalformed",
    integrity: "reasonIntegrity",
    staging: "reasonStaging",
    corrupt: "reasonCorrupt",
    unreadable: "reasonUnreadable",
    unwritable: "reasonUnwritable",
    unowned: "reasonUnowned",
    "identity-changed": "reasonIdentityChanged",
    publisher: "reasonPublisher",
    "not-lockable": "reasonNotLockable",
    "no-expected-publisher": "reasonNoExpectedPublisher",
    "no-consent-adapter": "reasonNoConsentAdapter",
    "cancelled-late-grant": "reasonCancelledLateGrant",
    "not-resumed": "reasonNotResumed",
    "platform-error": "reasonPlatformError",
    other: "reasonOther",
  };
  const reasonText = (reason: UpdateReason): string => ut(REASONS[reason]);

  const when = (at: number): string => formatDateTime(at, locale) ?? "—";
  const size = (bytes: number): string => formatBytes(bytes, locale);
  const named = (candidate: UpdateCandidateView) => ({ version: candidate.version });

  /**
   * Download progress, as a fraction of the SIGNED length.
   *
   * Clamped, and `null` when there is no denominator — a bar without one would
   * have to invent a position.
   */
  function fraction(received: number, total: number): number | null {
    if (!Number.isFinite(received) || !Number.isFinite(total) || total <= 0) return null;
    return Math.min(1, Math.max(0, received / total));
  }
</script>

<Card title={ut("paneTitle")}>
  <div class="pane" data-test="update-details" data-state={state.kind} data-lang={locale}>
    {#if view.currentVersion}
      <p class="dim small" data-test="update-current">
        {ut("currentVersion", { version: view.currentVersion })}
      </p>
    {/if}

    <!-- ============================ the 18 states ======================= -->
    <!-- Until an actual view has been observed, the starting value is NOT
         rendered as fact. It is `disabled/no-pin`, which is a claim about this
         build's signing configuration; a failed first read confirms none of it. -->
    {#if !controller.confirmed}
      <h3 data-test="update-title">{ut("unconfirmedTitle")}</h3>
      <p class="dim" data-test="update-body">{ut("unconfirmedBody")}</p>
    {:else if state.kind === "disabled"}
      <!-- Both reasons, never collapsed: one is a build flag, the other a
           missing key, and only the second could ever change for a user. -->
      <h3 data-test="update-title">
        {state.reason === "engineering-build" ? ut("disabledEngineeringTitle") : ut("disabledNoPinTitle")}
      </h3>
      <p class="dim" data-test="update-body">
        {state.reason === "engineering-build" ? ut("disabledEngineeringBody") : ut("disabledNoPinBody")}
      </p>
    {:else if state.kind === "idle"}
      <h3 data-test="update-title">{ut("idleTitle")}</h3>
      <p class="dim" data-test="update-body">
        {state.lastCheckedAt === null
          ? ut("idleNeverChecked")
          : ut("idleLastChecked", { when: when(state.lastCheckedAt) })}
      </p>
    {:else if state.kind === "checking"}
      <h3 data-test="update-title">{ut("checkingTitle")}</h3>
      <!-- Indeterminate is CORRECT here: a feed request has no byte total. -->
      <div class="bar indeterminate" data-test="update-indeterminate" role="progressbar" aria-label={ut("checkingTitle")}></div>
    {:else if state.kind === "up-to-date"}
      <h3 data-test="update-title">{ut("upToDateTitle")}</h3>
      <p class="dim" data-test="update-body">{ut("upToDateBody", { when: when(state.checkedAt) })}</p>
    {:else if state.kind === "check-failed"}
      <h3 data-test="update-title">{ut("checkFailedTitle")}</h3>
      <p class="problem" data-test="update-body">{reasonText(state.reason)}</p>
      <!-- A retry only where the core says asking again could differ. -->
      {#if state.retryable}
        <button
          data-test="update-retry"
          disabled={!actions.canCheck}
          onclick={() => void controller.act("check")}
        >{ut("retryAction")}</button>
      {/if}
    {:else if state.kind === "feed-untrusted"}
      <!-- TERMINAL. No retry, no override, and no "continue anyway". -->
      <h3 data-test="update-title">{ut("feedUntrustedTitle")}</h3>
      <p class="problem" data-test="update-body">{ut("feedUntrustedBody")}</p>
    {:else if state.kind === "update-available"}
      <h3 data-test="update-title">{ut("availableTitle", named(state.candidate))}</h3>
      <p class="dim" data-test="update-body">{ut("availableSize", { size: size(state.candidate.sizeBytes) })}</p>
      <div class="row">
        <button
          class="primary"
          data-test="update-download"
          disabled={!actions.canDownload}
          onclick={() => void controller.act("download")}
        >{ut("downloadAction")}</button>
        {#if state.candidate.hasNotes && actions.canOpenNotes}
          <button class="quiet" data-test="update-notes" onclick={() => void controller.openNotes()}>
            {ut("releaseNotes")}
          </button>
        {/if}
      </div>
    {:else if state.kind === "downloading"}
      {@const part = fraction(state.receivedBytes, state.candidate.sizeBytes)}
      <h3 data-test="update-title">{ut("downloadingTitle", named(state.candidate))}</h3>
      <p class="dim small" data-test="update-progress-text">
        {ut("downloadingProgress", {
          received: size(state.receivedBytes),
          total: size(state.candidate.sizeBytes),
        })}
      </p>
      <!-- Driven only by pushed bytes. No timer advances this. -->
      {#if part !== null}
        <div
          class="bar"
          data-test="update-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(part * 100)}
        >
          <div class="fill" style="width: {part * 100}%"></div>
        </div>
      {/if}
    {:else if state.kind === "verify-failed"}
      <h3 data-test="update-title">{ut("verifyFailedTitle")}</h3>
      <p class="problem" data-test="update-body">{ut("verifyFailedBody")}</p>
      <p class="dim small" data-test="update-reason">{reasonText(state.reason)}</p>
    {:else if state.kind === "ready"}
      <h3 data-test="update-title">{ut("readyTitle", named(state.candidate))}</h3>
      <p class="dim" data-test="update-body">{ut("readyBody")}</p>
      <button
        class="primary"
        data-test="update-install"
        disabled={!actions.canInstall}
        onclick={() => void controller.act("install")}
      >{ut("installAction")}</button>
    {:else if state.kind === "ready-unsigned"}
      <!-- Says what was and was not verified. Promises nothing about Windows'
           reaction, and never suggests turning a protection off. -->
      <h3 data-test="update-title">{ut("readyUnsignedTitle", named(state.candidate))}</h3>
      <p data-test="update-body">{ut("readyUnsignedBody")}</p>
      <button
        data-test="update-reveal"
        disabled={!actions.canReveal}
        onclick={() => void controller.act("reveal")}
      >{ut("revealAction")}</button>
    {:else if state.kind === "publisher-mismatch"}
      <h3 data-test="update-title">{ut("publisherMismatchTitle")}</h3>
      <p class="problem" data-test="update-body">{ut("publisherMismatchBody")}</p>
    {:else if state.kind === "verifier-unavailable"}
      <!-- Deliberately NOT the unsigned sentence. -->
      <h3 data-test="update-title">{ut("verifierUnavailableTitle")}</h3>
      <p class="problem" data-test="update-body">{ut("verifierUnavailableBody")}</p>
    {:else if state.kind === "installing"}
      <h3 data-test="update-title">{ut("installingTitle", named(state.candidate))}</h3>
      <p class="dim" data-test="update-body">{ut("installingBody")}</p>
    {:else if state.kind === "install-deferred"}
      <!-- Not an error, and it must not read as a failed update. -->
      <h3 data-test="update-title">{ut("installDeferredTitle")}</h3>
      <p data-test="update-body">{ut("installDeferredBody")}</p>
      <p class="dim small" data-test="update-reason">{reasonText(state.reason)}</p>
    {:else if state.kind === "revealed"}
      <!-- The unsigned terminus. Never a success sentence. -->
      <h3 data-test="update-title">{ut("revealedTitle")}</h3>
      <p data-test="update-body">{ut("revealedBody")}</p>
    {:else if state.kind === "journal-unavailable"}
      <h3 data-test="update-title">{ut("journalUnavailableTitle")}</h3>
      <p class="problem" data-test="update-body">{ut("journalUnavailableBody")}</p>
      <p class="dim small" data-test="update-reason">{reasonText(state.reason)}</p>
    {:else}
      <!-- blocked. Explained, with no retry that could not work. -->
      <h3 data-test="update-title">
        {state.reason === "unresolved-residue" ? ut("blockedResidueTitle") : ut("blockedStagingTitle")}
      </h3>
      <p class="problem" data-test="update-body">
        {state.reason === "unresolved-residue"
          ? ut("blockedResidueBody", { count: state.count })
          : ut("blockedStagingBody")}
      </p>
    {/if}

    <!-- ============================ check + residue ===================== -->
    <!-- Gates are unknown until a view is confirmed, so no update action is
         offered — the read retry above is the only thing to press. -->
    {#if controller.confirmed && state.kind !== "disabled"}
      <div class="row footer">
        <button
          data-test="update-check"
          disabled={!actions.canCheck}
          onclick={() => void controller.act("check")}
        >{actions.busy ? ut("working") : ut("checkAction")}</button>
      </div>
    {/if}

    {#if controller.notesFailed}
      <p class="problem small" data-test="update-notes-failed">{ut("notesFailed")}</p>
    {/if}

    <!-- A request that did not reach main. Rendered rather than swallowed, and
         kept separate from every update state: the channel failing is not a
         fact about signing, staging or installation.

         The retry re-issues the SAME request. For a read that is an IPC call,
         always safe. For an action it is offered only while that action's gate
         still allows it, so this can never become a route to a check the facade
         forbids on a terminal state. -->
    {#if controller.failure !== null}
      {@const failure = controller.failure}
      <p class="problem small" data-test="update-request-failed" data-failure={failure.kind} role="status" aria-live="polite">
        {failure.kind === "read"
          ? ut("requestFailedRead")
          : failure.kind === "notes"
            ? ut("requestFailedNotes")
            : ut("requestFailedAction")}
        {#if controller.retryable}
          <button class="quiet" data-test="update-request-retry" onclick={() => void controller.retry()}>
            {ut("requestRetry")}
          </button>
        {/if}
        <button class="quiet" data-test="update-request-dismiss" onclick={() => controller.dismissFailure()}>
          {ut("requestDismiss")}
        </button>
      </p>
    {/if}

    <!-- Never "nothing outstanding" over a read that did not happen. -->
    <p class="dim small" data-test="update-residue" data-residue={view.residue.kind}>
      {#if view.residue.kind === "unread"}
        {ut("residueUnread")}
      {:else if view.residue.kind === "failed"}
        {ut("residueFailed")}
      {:else if view.residue.total === 0}
        {ut("residueClean")}
      {:else}
        {ut("residueCount", { total: view.residue.total, ambiguous: view.residue.ambiguous })}
      {/if}
    </p>
  </div>
</Card>

<style>
  .pane { display: block; }
  h3 { margin: 0 0 var(--space-tight); font-size: 15px; font-weight: 600; }
  .dim { color: var(--text-dim); }
  .small { font-size: 13px; }
  .problem { margin: 0 0 var(--space-inner); }
  p { margin: 0 0 var(--space-inner); overflow-wrap: anywhere; }
  .row { display: flex; gap: var(--space-tight); flex-wrap: wrap; align-items: center; }
  .footer { margin-top: var(--space-inner); }

  .bar {
    margin: var(--space-tight) 0 var(--space-inner);
    height: 6px;
    border-radius: 3px;
    background: var(--border);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--accent);
    transition: width var(--motion-base) var(--ease);
  }
  .indeterminate::after {
    content: "";
    display: block;
    height: 100%;
    width: 40%;
    background: var(--accent);
    animation: indeterminate 1.4s infinite var(--ease);
  }

  @media (max-width: 680px) {
    .row { flex-direction: column; align-items: stretch; }
  }
</style>
