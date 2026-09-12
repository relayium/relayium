<!--
  Account, and the settings that belong with it.

  The sign-in flow is moved here unchanged, including every `data-test` hook the
  installed-acceptance smoke drives (`sign-in`, `cancel`, `sign-out`, `retry`).
  The lifecycle still lives in `sign-in-controller.ts` — this is markup and one
  subscription, exactly as before.

  What is new is the framing: an account is for creating pairing codes, and
  same-network transfers need none. A user who never signs in still has a
  working product, and this page says so rather than implying a gate.
-->
<script lang="ts">
  import { t } from "../i18n/index.svelte.js";
  import Card from "../shell/Card.svelte";
  import type { FailureReason, Phase, SignInController } from "../sign-in-controller.js";
  import AccountDetails from "./AccountDetails.svelte";
  import type { AccountSummaryController } from "../account/account-controller.svelte.js";
  import UpdateDetails from "./UpdateDetails.svelte";
  import type { UpdateSummaryController } from "../update/update-controller.svelte.js";
  import type { LoginItemOutcome } from "../../main/login-item.js";

  /**
   * A failure code to the sentence that says it.
   *
   * A total map, so a reason added to the controller without copy is a compile
   * error here rather than a blank paragraph on the account screen.
   */
  const FAILURE_KEY = {
    unreachable: "accountFailedUnreachable",
    declined: "accountFailedDeclined",
    expired: "accountFailedExpired",
    "credential-remains": "accountFailedCredentialRemains",
    "credential-uncertain": "accountFailedCredentialUncertain",
  } as const satisfies Record<FailureReason, string>;

  let {
    controller,
    account,
    update,
    phase,
    verifyPeers,
    prefsUnreadable = false,
    prefsSaveFailed = false,
    onVerifyPeers,
    startup,
    onStartup,
  }: {
    controller: SignInController;
    /** The account screen's own state. ONE prop; the component reads it all. */
    account: AccountSummaryController;
    /**
     * The update pane's state.
     *
     * On this page rather than a page of its own: it is a setting about the
     * app, it sits beside "start at sign-in", and a build with no pinned key
     * has nothing to put on a page of its own.
     */
    update: UpdateSummaryController;
    phase: Phase;
    verifyPeers: boolean;
    prefsUnreadable?: boolean;
    prefsSaveFailed?: boolean;
    onVerifyPeers: (value: boolean) => void;
    /** What Windows says right now, re-read after every change. */
    startup: LoginItemOutcome | null;
    onStartup: (enabled: boolean) => void;
  } = $props();

  /**
   * The system's answer, in a sentence.
   *
   * "Could not be asked" is its own state, not "off": one is a claim about the
   * machine and the other about this call, and showing the first when it means
   * the second invites the user to fix something that may not be broken. Same
   * for "listed but disabled in Task Manager", which no checkbox here can undo.
   */
  const startupSentence = $derived.by(() => {
    if (!startup) return "";
    if (!startup.ok) {
      return startup.failure.kind === "unreadable"
        ? t("settingsStartupUnreadable")
        : t("settingsStartupWriteFailed");
    }
    if (startup.state === "on") return t("settingsStartupOn");
    if (startup.state === "disabled-by-user") return t("settingsStartupDisabled");
    if (startup.state === "on-by-other-means") return t("settingsStartupOther");
    return t("settingsStartupOff");
  });
  const startupChecked = $derived(startup?.ok === true && startup.state === "on");
</script>

<h1>{t("accountTitle")}</h1>

<Card title={t("accountTitle")}>
  {#if phase.kind === "loading"}
    <p class="dim">…</p>
  {:else if phase.kind === "signedIn"}
    <p>{t("accountSignedInAs", { email: phase.accountEmail || "—" })}</p>
    <button data-test="sign-out" onclick={() => controller.signOut()}>{t("accountSignOut")}</button>
  {:else if phase.kind === "starting"}
    <!-- Cancel is real here, not decoration: the attempt is named before the
         request is sent, so there is something to abandon even though `start`
         has not come back yet. -->
    <p class="dim">{t("accountOpening")}</p>
    <button data-test="cancel" onclick={() => controller.cancel()}>{t("accountCancel")}</button>
  {:else if phase.kind === "cancelling"}
    <p class="dim">{t("accountCancel")}…</p>
    <button data-test="cancel" disabled>{t("accountCancel")}</button>
  {:else if phase.kind === "waiting"}
    <p>{t("accountEnterCode")}</p>
    <p class="code">{phase.userCode}</p>
    <p class="dim">{t("accountExpiresIn", { minutes: Math.ceil(phase.secondsLeft / 60) })}</p>
    <button data-test="cancel" onclick={() => controller.cancel()}>{t("accountCancel")}</button>
  {:else if phase.kind === "storeProblem"}
    <!-- Not a Sign in button. Signing in would write a credential this machine
         cannot encrypt, and the app refuses to store one in the clear, so the
         attempt could not succeed. -->
    <p class="problem">{t("accountStoreUnreadable")}</p>
    <button data-test="retry" onclick={() => controller.refresh()}>{t("accountRetry")}</button>
  {:else if phase.kind === "failed"}
    <p class="problem">{t(FAILURE_KEY[phase.reason])}</p>
    <button data-test="sign-in" onclick={() => controller.signIn()}>{t("accountRetry")}</button>
  {:else}
    <p class="dim">{t("accountSignedOut")}</p>
    <p class="dim small">{t("accountWhy")}</p>
    <button class="primary" data-test="sign-in" onclick={() => controller.signIn()}>
      {t("accountSignIn")}
    </button>
  {/if}
</Card>

<Card title={t("settingsTitle")}>
  <label class="check">
    <input
      type="checkbox"
      data-test="verify-peers"
      checked={verifyPeers}
      onchange={(e) => onVerifyPeers(e.currentTarget.checked)}
    />
    <span>
      {t("settingsVerify")}
      <span class="dim small block">{t("settingsVerifyHelp")}</span>
    </span>
  </label>
  <!-- A security preference that could not be read must not render as "off" —
       that is indistinguishable from the user having turned it off. -->
  {#if prefsUnreadable}
    <p class="problem" data-test="prefs-unreadable">{t("settingsUnreadable")}</p>
  {/if}
  {#if prefsSaveFailed}
    <p class="problem" data-test="prefs-save-failed">{t("settingsSaveFailed")}</p>
  {/if}

  <label class="check">
    <input
      type="checkbox"
      data-test="startup"
      checked={startupChecked}
      disabled={startup === null}
      onchange={(e) => onStartup(e.currentTarget.checked)}
    />
    <span>
      {t("settingsStartup")}
      <span class="dim small block">{t("settingsStartupHelp")}</span>
    </span>
  </label>
  <!-- The system's own answer, read back after every change rather than assumed
       from the click: on Windows the write can succeed while the run key stays
       deactivated. -->
  {#if startupSentence}
    <p class="dim small" data-test="startup-state">{startupSentence}</p>
  {/if}
</Card>

<!--
  The account itself: profile, usage and this account's devices.

  BELOW the two existing cards and purely additive — neither is touched. The
  component renders nothing at all while the profile section is `signed-out`, so
  the sign-in card above keeps sole responsibility for saying that; there is no
  state in which both speak.

  One prop, by its own contract: the controller. Everything it shows comes from
  a snapshot main already holds, and every mutation it offers is one of the two
  that already existed — rename and revoke. Nothing here buys, upgrades or
  cancels anything.
-->
<AccountDetails controller={account} />

<!--
  Updates, as a setting about the app.

  A build with no pinned key renders a DISABLED state here and offers nothing —
  that is this build's truth, not a placeholder, and the component says which of
  the two reasons applies rather than hiding the section and leaving somebody to
  wonder whether the app updates at all.
-->
<UpdateDetails controller={update} />

<style>
  h1 { margin: 0 0 var(--space-section); font-size: 20px; font-weight: 600; }
  .dim { color: var(--text-dim); margin: 0 0 var(--space-tight); }
  .small { font-size: 13px; }
  .block { display: block; margin-top: var(--space-hairline); }
  .problem { margin: 0 0 var(--space-inner); }
  .code {
    font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
    font-size: 28px;
    letter-spacing: 0.18em;
    margin: 0 0 var(--space-tight);
  }
  .check { display: flex; gap: var(--space-inner); align-items: flex-start; min-height: var(--hit-target); }
  .check input { margin-top: 3px; }
  /* Controls come from `tokens.css`. This block was the ONLY page that had
     them, which is precisely why every page that did not looked broken next to
     it — see the note there. */
</style>
