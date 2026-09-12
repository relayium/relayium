<!--
  Everything about an account that is not signing in to it.

  ## Additive by construction

  This is a sibling of the existing sign-in card, not a replacement for it. It
  renders BELOW that card and knows nothing about it: no sign-in phase, no
  sign-out button, no second subscription to authentication state. When nobody
  is signed in it renders nothing at all, because the card above already says so
  and saying it twice is worse than saying it once.

  ## Five cards, five independent truths

  `/api/me`, `/api/me/usage` and `/api/devices` are three separate reads, and
  each card here renders its OWN state. A usage endpoint that is failing shows a
  failed usage card with its own Try again, beside a profile and a device list
  that are fine. The alternative — one loading state for the screen — means one
  slow endpoint blanks everything a person could otherwise have used.

  What no card ever does is turn a read that did not happen into a number. There
  is no path in this file from "could not load" to 0 bytes, to unlimited, or to
  a free plan.

  ## The two numbers that are not the same number

  `usage.traffic.cap` is the allowance actually in force this month, prorated
  across a mid-month tier change. `plan.trafficBytes` is what the tier
  advertises. The progress meter is drawn against the FIRST, and the plan card
  states the second as a plan fact. Drawing the meter against the advertised
  figure would show progress towards a limit nobody is enforcing.

  And a cap of `0` means unlimited. That is why the meter is inside an
  `{#if quota.kind === "limited"}` rather than being drawn with a computed
  percentage: an unlimited quota has no denominator, so there is no bar, no
  percentage, and above all no "100% full".
-->
<script lang="ts">
  import { t, lang } from "../i18n/index.svelte.js";
  import Card from "../shell/Card.svelte";
  import { at } from "../account/messages.js";
  import {
    deviceKindLabel,
    deviceSuffix,
    durationOf,
    formatBytes,
    formatDate,
    formatDateTime,
    formatPercent,
    quotaOf,
    runeLength,
    type Quota,
  } from "../account/format.js";
  import type { AccountSummaryController } from "../account/account-controller.svelte.js";
  import {
    ACCOUNT_DEVICE_NAME_MAX_RUNES,
    type AccountCap,
    type AccountDeviceView,
    type AccountFailure,
    type AccountMutationOutcome,
    type AccountProviderView,
    type AccountCycleView,
  } from "../../shared/account-summary.js";

  let { controller }: { controller: AccountSummaryController } = $props();

  const view = $derived(controller.view);
  const profile = $derived(view.profile);
  const usage = $derived(view.usage);
  const devices = $derived(view.devices);
  const locale = $derived(lang());

  /**
   * Signed out is not a failure to report — it is the ordinary state of
   * somebody who has not signed in, and the card above already says it.
   */
  const signedOut = $derived(
    profile.kind === "failed" && profile.failure.kind === "signed-out",
  );

  /** Nothing has answered yet. Rendered as reading, never as an empty account. */
  const starting = $derived(
    profile.kind === "loading" && usage.kind === "loading" && devices.kind === "loading",
  );

  // --- Sentences for closed values ----------------------------------------

  function failureText(failure: AccountFailure): string {
    switch (failure.kind) {
      case "signed-out":
        return at("failedSignedOut");
      case "unavailable":
        return at("failedUnavailable");
      case "network":
        return at("failedNetwork");
      case "timeout":
        return at("failedTimeout");
      case "refused":
        return failure.status === undefined
          ? at("failedRefused")
          : at("failedRefusedStatus", { status: failure.status });
      case "unreadable":
        return at("failedUnreadable");
      default: {
        // The default used to BE the `unreadable` case, unnamed. Correct, and
        // the wrong structure: a seventh kind would have inherited "this client
        // cannot show you your account right now", which is a specific claim
        // nobody had made about it.
        //
        // An explicit `never` rather than no default at all — without one this
        // returns `undefined` and the card renders blank. And a real sentence
        // after it rather than the `never` value, because this line runs only
        // if the TYPE is wrong, and putting an object on screen is not better
        // than saying the least this build can honestly say.
        const unhandled: never = failure.kind;
        void unhandled;
        return at("failedUnreadable");
      }
    }
  }

  /**
   * What a row was last told.
   *
   * `uncertain` deliberately does not read as a failure. The request may have
   * been performed — a reply that never arrived says nothing about what the
   * server did — so the row stays, the sentence says so, and the only action
   * offered is a re-READ. Never an automatic re-send.
   */
  function outcomeText(outcome: AccountMutationOutcome): string {
    switch (outcome.kind) {
      case "unknown-device":
        return at("mutationUnknownDevice");
      case "invalid-name":
        return at("mutationInvalidName");
      case "busy":
        return at("mutationBusy");
      case "signed-out":
        return at("mutationSignedOut");
      case "unavailable":
        return at("mutationUnavailable");
      case "uncertain":
        return at("mutationUncertain");
      case "revoked":
        return outcome.self
          ? outcome.signedOut
            ? at("revokedSelfSignedOut")
            : at("revokedSelfKept")
          : "";
      case "failed":
        return failureText(outcome.failure);
      case "renamed":
        // Deliberately silent, like the non-self `revoked` above it: the row
        // updates in place and there is nothing to announce. Named rather than
        // left to a default, so the silence is a decision on the record.
        return "";
      default: {
        const unhandled: never = outcome;
        void unhandled;
        return "";
      }
    }
  }

  const providerText = (provider: AccountProviderView): string =>
    provider === "stripe"
      ? at("providerStripe")
      : provider === "apple"
        ? at("providerApple")
        : provider === "admin"
          ? at("providerAdmin")
          : provider === "multiple"
            ? at("providerMultiple")
            : at("providerNone");

  /**
   * The provider's lifecycle state, in words rather than as a wire token.
   *
   * A token outside the server's own enumerated set keeps its raw value inside a
   * translated sentence: the truth is preserved, the UI stops being half
   * English, and nothing is inferred — an unrecognised status is not quietly
   * read as active, cancelled or paid.
   */
  function statusText(status: string): string {
    switch (status) {
      case "active":
        return at("statusActive");
      case "trialing":
        return at("statusTrialing");
      case "past_due":
        return at("statusPastDue");
      // Stripe's own spelling is the one the server stores; the double-l form is
      // accepted too because it is the same word, not a different state.
      case "canceled":
      case "cancelled":
        return at("statusCanceled");
      case "incomplete_expired":
        return at("statusIncompleteExpired");
      default:
        return at("statusUnrecognised", { status });
    }
  }

  /** `""` is UNKNOWN and says so. It does not quietly become monthly. */
  const cycleText = (cycle: AccountCycleView): string =>
    cycle === "monthly"
      ? at("cycleMonthly")
      : cycle === "yearly"
        ? at("cycleYearly")
        : at("cycleUnknown");

  /** A ceiling, or the word for having none. Never "0". */
  const capText = (cap: AccountCap): string =>
    cap === 0 ? at("capUnlimited") : formatBytes(cap, locale);

  function retentionText(seconds: AccountCap): string {
    if (seconds === 0) return at("planRetentionUnlimited");
    const span = durationOf(seconds);
    if (span === null) return at("planRetentionUnlimited");
    return span.unit === "day"
      ? at("planRetentionDays", { count: span.value })
      : span.unit === "hour"
        ? at("planRetentionHours", { count: span.value })
        : at("planRetentionMinutes", { count: span.value });
  }

  const quotaText = (quota: Quota): string =>
    quota.kind === "unlimited"
      ? at("usageOfUnlimited", { used: formatBytes(quota.used, locale) })
      : quota.kind === "limited"
        ? at("usageOf", {
            used: formatBytes(quota.used, locale),
            cap: formatBytes(quota.cap, locale),
          })
        : "—";

  /**
   * A sign-in method, capitalised.
   *
   * `web/src/lib/Account.svelte:113` does exactly this and no more. Matching it
   * is the point: a person who has seen "Google" in the browser should see
   * "Google" here, and a provider this build has never heard of renders as its
   * own name rather than being dropped or guessed at.
   */
  const methodLabel = (method: string): string =>
    method.charAt(0).toUpperCase() + method.slice(1);

  const deviceName = (device: AccountDeviceView): string =>
    device.name.length > 0 ? device.name : at("deviceUnnamed");

  /**
   * Whether there is anything truthful to say about a subscription.
   *
   * Deliberately not "is there a paid plan", which this screen does not compute:
   * the card appears when the server has actually said something — a provider, a
   * status, a scheduled change or an Apple renewal. An account with none of
   * those gets no card rather than an empty one full of dashes.
   */
  const hasSubscriptionFacts = $derived(
    profile.kind === "ready" &&
      (profile.value.entitlementProvider !== "" ||
        profile.value.subscriptionStatus !== "" ||
        profile.value.scheduledPlanId !== "" ||
        profile.value.appleRenewal.available),
  );

  // The two quotas are derived INSIDE the usage card with `{@const}`, not here.
  // Deriving them at this level meant they had to be nullable for the failed
  // case, and a nullable quota beside a narrowed `usage` is how a template ends
  // up with a branch that renders a meter for a read that never happened.

  /** Escape closes whatever is open, which is what a person expects of it. */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && controller.prompt !== null) {
      event.stopPropagation();
      controller.dismissPrompt();
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
{#if !signedOut}
  <section
    class="details"
    data-test="account-details"
    data-lang={locale}
    onkeydown={onKeydown}
    aria-label={at("detailsTitle")}
  >
    {#if starting}
      <Card>
        <p class="dim" data-test="account-loading">…</p>
      </Card>
    {:else}
      <!-- ============================ Profile ============================ -->
      <Card title={at("profileTitle")}>
        {#if profile.kind === "ready"}
          <dl class="facts" data-test="profile-facts">
            <dt>{at("profileName")}</dt>
            <dd data-test="profile-name">
              {profile.value.displayName || at("profileNoName")}
            </dd>
            <dt>{at("profileEmail")}</dt>
            <dd data-test="profile-email">
              {profile.value.email || "—"}
              <!-- An unverified address is stated, not hidden: it is the reason
                   several server actions will refuse later. -->
              <span class="badge" class:warn={!profile.value.emailVerified}>
                {profile.value.emailVerified ? at("profileVerified") : at("profileUnverified")}
              </span>
            </dd>
            <dt>{at("profileMethods")}</dt>
            <dd data-test="profile-methods">
              <!-- `linkedMethods` ALREADY contains "password" when the account
                   has one: `loginMethods` in `server/account/native.go:165`
                   prepends it and then skips the identities row for it,
                   specifically to avoid a duplicate. Prepending `hasPassword`
                   here as well produced "Password · password" on screen, which
                   is what the real-renderer capture showed. The server's list is
                   the list. -->
              {#if profile.value.linkedMethods.length > 0}
                {profile.value.linkedMethods.map(methodLabel).join(" · ")}
              {:else}
                {at("profileMethodNone")}
              {/if}
            </dd>
          </dl>
        {:else if profile.kind === "loading"}
          <p class="dim">…</p>
        {:else}
          <p class="problem" data-test="profile-failed">
            {at("profileUnavailable")}
            <span class="dim block small">{failureText(profile.failure)}</span>
          </p>
          <button
            data-test="profile-retry"
            disabled={controller.refreshing.includes("profile")}
            onclick={() => void controller.refresh("profile")}
          >
            {at("retry")}
          </button>
        {/if}
      </Card>

      <!-- ============================== Plan ============================= -->
      <Card title={at("planTitle")}>
        {#if usage.kind === "ready"}
          <p class="plan-name" data-test="plan-name">{usage.value.plan.name || usage.value.plan.id}</p>
          <dl class="facts">
            <dt>{at("planIncludedStorage")}</dt>
            <dd data-test="plan-storage">{capText(usage.value.plan.storageBytes)}</dd>
            <dt>{at("planIncludedTraffic")}</dt>
            <!-- The tier's NOMINAL figure. The meter below is drawn against the
                 effective allowance, which is a different number after a
                 mid-month change; they are stated separately on purpose. -->
            <dd data-test="plan-traffic">{capText(usage.value.plan.trafficBytes)}</dd>
            <dt>{at("planRetention")}</dt>
            <dd data-test="plan-retention">{retentionText(usage.value.plan.retentionSecs)}</dd>
          </dl>
        {:else if usage.kind === "loading"}
          <p class="dim">…</p>
        {:else if profile.kind === "ready"}
          <!-- The usage read failed but the profile did not, so the EFFECTIVE
               tier id is known and the plan's details are not. Both facts are
               stated. Rendering the id as though it were the full plan would
               present a partial read as a complete one. -->
          <p class="problem" data-test="plan-partial">
            {at("planFromProfileOnly", { planId: profile.value.planId || "—" })}
            <span class="dim block small">{failureText(usage.failure)}</span>
          </p>
          <button
            data-test="plan-retry"
            disabled={controller.refreshing.includes("usage")}
            onclick={() => void controller.refresh("usage")}
          >
            {at("retry")}
          </button>
        {:else}
          <p class="problem" data-test="plan-failed">
            {at("usageUnavailable")}
            <span class="dim block small">{failureText(usage.failure)}</span>
          </p>
          <button
            data-test="plan-retry"
            disabled={controller.refreshing.includes("usage")}
            onclick={() => void controller.refresh("usage")}
          >
            {at("retry")}
          </button>
        {/if}
      </Card>

      <!-- ============================= Usage ============================= -->
      <Card title={at("usageTitle")}>
        {#if usage.kind === "ready"}
          {@const traffic = quotaOf(usage.value.traffic.used, usage.value.traffic.cap)}
          {@const storage = quotaOf(usage.value.storage.used, usage.value.storage.cap)}
          {@const resets = formatDate(usage.value.resetsAt, locale)}
          <div class="meter-row" data-test="usage-traffic">
            <div class="meter-head">
              <span>{at("usageTraffic")}</span>
              <span class="dim">{quotaText(traffic)}</span>
            </div>
            {#if traffic.kind === "limited"}
              <div
                class="meter"
                role="progressbar"
                aria-label={at("usageTraffic")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(traffic.fraction * 100)}
                aria-valuetext={quotaText(traffic)}
              >
                <div
                  class="fill"
                  class:full={traffic.fraction >= 1}
                  style="width: {traffic.fraction * 100}%"
                ></div>
              </div>
              <p class="dim small" data-test="usage-traffic-percent">
                {formatPercent(traffic, locale)} · {at("usageEffectiveNote")}
              </p>
            {/if}
          </div>

          <div class="meter-row" data-test="usage-storage">
            <div class="meter-head">
              <span>{at("usageStorage")}</span>
              <span class="dim">{quotaText(storage)}</span>
            </div>
            {#if storage.kind === "limited"}
              <div
                class="meter"
                role="progressbar"
                aria-label={at("usageStorage")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(storage.fraction * 100)}
                aria-valuetext={quotaText(storage)}
              >
                <div
                  class="fill"
                  class:full={storage.fraction >= 1}
                  style="width: {storage.fraction * 100}%"
                ></div>
              </div>
            {/if}
          </div>

          <p class="dim small" data-test="usage-period">
            {at("usagePeriod", { period: usage.value.period })}
            {#if resets}· {at("usageResets", { date: resets })}{/if}
          </p>
        {:else if usage.kind === "loading"}
          <p class="dim">…</p>
        {:else}
          <!-- A failed usage read stays a failed usage read. There is no branch
               here that renders zero bytes or an empty meter. -->
          <p class="problem" data-test="usage-failed">
            {at("usageUnavailable")}
            <span class="dim block small">{failureText(usage.failure)}</span>
          </p>
          <button
            data-test="usage-retry"
            disabled={controller.refreshing.includes("usage")}
            onclick={() => void controller.refresh("usage")}
          >
            {at("retry")}
          </button>
        {/if}
      </Card>

      <!-- ========================== Subscription ========================= -->
      {#if profile.kind === "ready" && hasSubscriptionFacts}
        {@const p = profile.value}
        <Card title={at("subscriptionTitle")}>
          <dl class="facts" data-test="subscription-facts">
            <dt>{at("subscriptionProvider")}</dt>
            <dd data-test="subscription-provider">{providerText(p.entitlementProvider)}</dd>
            {#if p.subscriptionStatus}
              <dt>{at("subscriptionStatus")}</dt>
              <!-- The provider's own word, shown as the provider's own word.
                   Mapping it to a friendlier vocabulary here would be a second
                   opinion about an entitlement this client does not compute. -->
              <dd data-test="subscription-status">{statusText(p.subscriptionStatus)}</dd>
            {/if}
            <dt>{at("subscriptionCycle")}</dt>
            <dd data-test="subscription-cycle">{cycleText(p.billingCycle)}</dd>
          </dl>

          {@const endsOn = formatDate(p.subscriptionEnd, locale)}
          {#if endsOn}
            <p class="dim small" data-test="subscription-ends">
              {at("subscriptionEnds", { date: endsOn })}
            </p>
          {/if}

          {#if p.scheduledPlanId}
            <p class="dim small" data-test="subscription-scheduled">
              {#if usage.kind === "ready" && usage.value.plan.scheduledPlanName}
                {at("subscriptionScheduled", { plan: usage.value.plan.scheduledPlanName })}
              {:else}
                <!-- The server's own note says `scheduledPlanName` is
                     best-effort and may be empty while the id is set. An id is
                     not a plan name, so the unnamed sentence is used instead of
                     printing one. -->
                {at("subscriptionScheduledUnnamed")}
              {/if}
            </p>
          {/if}

          {#if p.appleRenewal.available}
            {@const renewal = p.appleRenewal}
            <p class="dim small" data-test="subscription-renewal">
              {#if renewal.autoRenewEnabled}
                {at("renewalOn", { date: formatDate(renewal.renewalAt, locale) ?? "—" })}
              {:else}
                {at("renewalOff", { date: formatDate(renewal.renewalAt, locale) ?? "—" })}
              {/if}
            </p>
            {#if renewal.inBillingRetry}
              <p class="dim small" data-test="subscription-retry">{at("renewalRetry")}</p>
            {/if}
            {#if renewal.inGracePeriod}
              <!-- The SERVER's computation, rendered as given. Re-deriving it
                   from `graceUntil` against this machine's clock would disagree
                   with what is enforced, on the machine whose clock is wrong. -->
              <p class="dim small" data-test="subscription-grace">
                {at("renewalGrace", { date: formatDate(renewal.graceUntil, locale) ?? "—" })}
              </p>
            {/if}
          {/if}

          <!-- The only journey out of this app. It carries a closed token, not
               a URL: main owns the address and validates it against this
               build's pinned origin. Nothing here can buy, cancel or change a
               subscription — that happens on the page this opens. -->
          <button
            data-test="manage-account"
            onclick={() => void controller.manage()}
          >
            {at("manageAccount")}
          </button>
          {#if controller.manageFailed}
            <p class="problem small" data-test="manage-failed">{at("manageFailed")}</p>
          {/if}
        </Card>
      {/if}

      <!-- ============================ Devices ============================ -->
      <Card title={at("devicesTitle")}>
        {#if devices.kind === "ready"}
          {#if devices.value.length === 0}
            <p class="dim" data-test="devices-empty">{at("devicesEmpty")}</p>
          {:else}
            <ul class="devices" data-test="device-list">
              {#each devices.value as device (device.id)}
                {@const row = controller.rowState(device.id)}
                {@const suffix = deviceSuffix(device.id)}
                {@const lastSeen = formatDateTime(device.lastSeenAt, locale)}
                {@const addedOn = formatDate(device.createdAt, locale)}
                <li class="device" class:current={device.current} data-test="device-row" data-device={device.id}>
                  <div class="device-head">
                    <div class="device-id">
                      <span class="device-name" data-test="device-name">{deviceName(device)}</span>
                      {#if device.current}
                        <span class="badge accent" data-test="device-current">{t("thisPc")}</span>
                      {/if}
                      {#if device.enrolled}
                        <span class="badge" data-test="device-enrolled">{at("deviceEnrolled")}</span>
                      {/if}
                      <!-- Two machines can honestly share a name. Without this,
                           a confirmation about "Laptop" names nothing. -->
                      {#if suffix}<span class="suffix" data-test="device-suffix">#{suffix}</span>{/if}
                    </div>
                    <div class="device-actions">
                      {#if row.busy}
                        <span class="dim small" data-test="device-busy">{at("deviceWorking")}</span>
                      {:else}
                        <button
                          class="quiet"
                          data-test="device-rename"
                          onclick={() => controller.beginRename(device)}
                        >
                          {at("deviceRename")}
                        </button>
                        <button
                          class="quiet danger"
                          data-test="device-revoke"
                          onclick={() => controller.askRevoke(device)}
                        >
                          {at("deviceRevoke")}
                        </button>
                      {/if}
                    </div>
                  </div>

                  <p class="dim small device-meta">
                    {#if device.kind}<span data-test="device-kind">{deviceKindLabel(device.kind)}</span> · {/if}
                    {#if lastSeen}
                      {at("deviceLastSeen", { date: lastSeen })}
                    {:else}
                      {at("deviceNeverSeen")}
                    {/if}
                    {#if addedOn}· {at("deviceAdded", { date: addedOn })}{/if}
                  </p>

                  {#if controller.prompt?.kind === "rename" && controller.prompt.id === device.id}
                    <div class="prompt" data-test="rename-prompt">
                      <label class="field">
                        <span class="small">{at("deviceRenameLabel")}</span>
                        <!-- svelte-ignore a11y_autofocus -->
                        <input
                          type="text"
                          autofocus
                          data-test="rename-input"
                          maxlength={ACCOUNT_DEVICE_NAME_MAX_RUNES * 2}
                          bind:value={controller.renameDraft}
                          onkeydown={(e) => {
                            if (e.key === "Enter" && controller.renameValid) {
                              e.preventDefault();
                              void controller.submitRename();
                            }
                          }}
                        />
                      </label>
                      {#if controller.renameOverBy > 0}
                        <p class="problem small" data-test="rename-too-long">
                          {at("deviceRenameTooLong", { count: controller.renameOverBy })}
                        </p>
                      {:else}
                        <p class="dim small" data-test="rename-count">
                          {runeLength(controller.renameDraft)}/{ACCOUNT_DEVICE_NAME_MAX_RUNES}
                        </p>
                      {/if}
                      <div class="prompt-actions">
                        <button
                          class="primary"
                          data-test="rename-save"
                          disabled={!controller.renameValid}
                          onclick={() => void controller.submitRename()}
                        >
                          {at("deviceRenameSave")}
                        </button>
                        <button data-test="rename-cancel" onclick={() => controller.dismissPrompt()}>
                          {at("deviceRenameCancel")}
                        </button>
                      </div>
                    </div>
                  {/if}

                  {#if controller.prompt?.kind === "revoke" && controller.prompt.id === device.id}
                    <!-- Confirmed against THIS row's id. Main resolves that id
                         against the list main holds, so a row that has gone away
                         between the question and the answer is refused rather
                         than silently resolved to whatever took its place. -->
                    <div class="prompt warn" role="alertdialog" aria-label={at("deviceRevoke")} data-test="revoke-prompt">
                      <p class="confirm" data-test="revoke-question">
                        {#if device.current}
                          <!-- Signing THIS PC out is the one action here that
                               takes the app away from the person doing it, so it
                               says the whole consequence rather than "are you
                               sure". -->
                          {at("deviceRevokeConfirmSelf")}
                        {:else}
                          {at("deviceRevokeConfirm", { name: deviceName(device) })}
                        {/if}
                      </p>
                      <div class="prompt-actions">
                        <button
                          class="danger"
                          data-test="revoke-confirm"
                          onclick={() => void controller.confirmRevoke()}
                        >
                          {at("deviceRevokeConfirmYes")}
                        </button>
                        <button data-test="revoke-cancel" onclick={() => controller.dismissPrompt()}>
                          {at("deviceRevokeConfirmNo")}
                        </button>
                      </div>
                    </div>
                  {/if}

                  {#if row.outcome && outcomeText(row.outcome)}
                    <p
                      class="small"
                      class:problem={row.outcome.kind !== "revoked"}
                      class:dim={row.outcome.kind === "revoked"}
                      data-test="device-outcome"
                      data-outcome={row.outcome.kind}
                      role="status"
                      aria-live="polite"
                    >
                      {outcomeText(row.outcome)}
                      {#if row.outcome.kind === "uncertain"}
                        <!-- A re-READ, never a re-send. The mutation may have
                             been applied, and repeating it is exactly the wrong
                             thing to offer. -->
                        <button
                          class="quiet"
                          data-test="device-recheck"
                          disabled={controller.refreshing.includes("devices")}
                          onclick={() => void controller.refresh("devices")}
                        >
                          {at("recheck")}
                        </button>
                      {/if}
                      <button
                        class="quiet"
                        data-test="device-dismiss"
                        onclick={() => controller.dismissRow(device.id)}
                      >
                        ×
                      </button>
                    </p>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        {:else if devices.kind === "loading"}
          <p class="dim">…</p>
        {:else}
          <p class="problem" data-test="devices-failed">
            {at("devicesUnavailable")}
            <span class="dim block small">{failureText(devices.failure)}</span>
          </p>
          <button
            data-test="devices-retry"
            disabled={controller.refreshing.includes("devices")}
            onclick={() => void controller.refresh("devices")}
          >
            {at("retry")}
          </button>
        {/if}
      </Card>
    {/if}
  </section>
{/if}

<style>
  /* Controls come from `tokens.css`; only what is specific to this surface is
     declared here. See the note in that file about why button styling is
     global. */
  .dim { color: var(--text-dim); }
  .small { font-size: 13px; }
  .block { display: block; margin-top: var(--space-hairline); }
  .problem { margin: 0 0 var(--space-inner); }

  /* A two-column term/value list that becomes one column when the window is
     narrow. 680px is where the reading measure stops being comfortable beside a
     label column, not an arbitrary breakpoint. */
  .facts {
    display: grid;
    grid-template-columns: minmax(120px, 200px) 1fr;
    gap: var(--space-tight) var(--space-section);
    margin: 0;
  }
  .facts dt { color: var(--text-dim); font-size: 13px; }
  .facts dd { margin: 0; overflow-wrap: anywhere; }

  .plan-name { margin: 0 0 var(--space-inner); font-size: 17px; font-weight: 600; }

  .badge {
    display: inline-block;
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 12px;
    color: var(--text-dim);
    white-space: nowrap;
  }
  .badge.accent { border-color: var(--accent); color: var(--accent); }
  .badge.warn { border-color: currentColor; }
  .suffix {
    font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
    font-size: 12px;
    color: var(--text-dim);
  }

  .meter-row { margin-bottom: var(--space-section); }
  .meter-row:last-of-type { margin-bottom: var(--space-inner); }
  .meter-head { display: flex; justify-content: space-between; gap: var(--space-inner); }
  .meter {
    margin-top: var(--space-tight);
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
  /* Full is stated with colour as well as length, because a bar that has run
     out and a bar that is nearly full look the same at a glance. */
  .fill.full { background: currentColor; }

  .devices { list-style: none; margin: 0; padding: 0; }
  .device {
    padding: var(--space-inner) 0;
    border-top: 1px solid var(--border);
  }
  .device:first-child { border-top: none; padding-top: 0; }
  .device-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--space-inner);
    flex-wrap: wrap;
  }
  .device-id { display: flex; align-items: center; gap: var(--space-tight); flex-wrap: wrap; }
  .device-name { font-weight: 600; overflow-wrap: anywhere; }
  .device-actions { display: flex; gap: var(--space-tight); align-items: center; }
  .device-meta { margin: var(--space-hairline) 0 0; }

  .prompt {
    margin-top: var(--space-inner);
    padding: var(--space-inner);
    border: 1px solid var(--border);
    border-radius: var(--corner);
    background: var(--bg);
  }
  .prompt.warn { border-color: var(--accent); }
  .confirm { margin: 0 0 var(--space-inner); }
  .prompt-actions { display: flex; gap: var(--space-tight); flex-wrap: wrap; }
  .field { display: block; }
  .field span { display: block; color: var(--text-dim); margin-bottom: var(--space-hairline); }
  .field input { width: 100%; }

  /* At a narrow window the label column and the row actions both stop fitting.
     The Mac app reflows rather than scrolling horizontally, and so does this. */
  @media (max-width: 680px) {
    .facts { grid-template-columns: 1fr; gap: var(--space-hairline); }
    .facts dd { margin-bottom: var(--space-tight); }
    .device-head { flex-direction: column; align-items: stretch; }
    .device-actions { justify-content: flex-start; }
  }
</style>
