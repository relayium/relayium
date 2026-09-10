<!--
  Pairing code.

  Creating a code needs an account; JOINING one does not. That asymmetry is the
  server's, not a UI choice: `/api/pair` requires a session, while relay
  entitlement for a room is derived from the code OWNER (`account/turn.go:63`),
  so the joiner needs no credential and the ICE read carries none.

  Every refusal is its own sentence with its own next action. "Something went
  wrong" at a user who needed to verify an email, or wait sixty seconds, is the
  failure this page exists to avoid.
-->
<script lang="ts">
  import { t } from "../i18n/index.svelte.js";
  import Card from "../shell/Card.svelte";
  import LinkPane from "./LinkPane.svelte";
  import type { RoomController } from "../rooms/room-controller.svelte.js";
  import type { PairMintResult } from "../../shared/ipc-contract.js";

  let {
    room,
    minted,
    minting,
    refusal,
    joinError,
    onCreate,
    onJoin,
    onLeave,
    now,
    verifyPeers,
    codeDraft = $bindable(""),
    messageDraft = $bindable(""),
  }: {
    room: RoomController | null;
    minted: Extract<PairMintResult, { ok: true }> | null;
    minting: boolean;
    refusal: string | null;
    joinError: string | null;
    onCreate: () => void;
    onJoin: (code: string) => void;
    onLeave: () => void;
    /** An owned ticking clock. `Date.now()` in a `$derived` never updates. */
    now: number;
    verifyPeers: boolean;
    /** Hoisted above this component so a sidebar click does not destroy a code
     *  the user is halfway through typing. */
    codeDraft?: string;
    messageDraft?: string;
  } = $props();

  const linkPeerId = $derived(room?.workspace.linkPeerId ?? "");
  /**
   * The user disconnected, and the peer is still here.
   *
   * Its own state, because the alternative was worse than untidy: with the room
   * still joined and the peer still on the roster, the page fell through to
   * "Waiting for the other device to join…" — which is false twice over. The
   * other device had already joined, and nothing was being waited for, because
   * the fence refuses re-offers until the user asks again.
   */
  const disconnected = $derived(
    room !== null && room.userStopped && room.peers.length > 0,
  );
  const stoppedPeer = $derived(room?.peers[0]?.id ?? "");
  const msLeft = $derived(minted ? minted.expiresAt * 1000 - now : 0);
  const minutesLeft = $derived(Math.max(0, Math.ceil(msLeft / 60000)));
  const expired = $derived(minted !== null && msLeft <= 0);
</script>

<h1>{t("pairTitle")}</h1>
<p class="lede">{t("pairSubtitle")}</p>

{#if room && linkPeerId}
  <LinkPane {room} {verifyPeers} bind:messageDraft />
{:else if disconnected}
  <Card>
    <h2 data-test="pair-disconnected">{t("pairDisconnected")}</h2>
    <p class="dim">{t("pairDisconnectedBody")}</p>
    <button
      class="primary"
      data-test="pair-reconnect"
      onclick={() => room?.connectTo(stoppedPeer)}
    >
      {t("pairReconnect")}
    </button>
    <button class="quiet" data-test="pair-leave" onclick={onLeave}>{t("pairLeave")}</button>
  </Card>
{:else}
  <Card title={t("pairYourCode")}>
    {#if minted && expired}
      <!-- Said plainly, with the way out. A dead code left on screen with a
           frozen countdown is the state this replaces. -->
      <p class="problem" data-test="pair-expired">{t("pairExpired")}</p>
      <button class="primary" data-test="pair-create" onclick={onCreate} disabled={minting}>
        {minting ? t("pairCreating") : t("pairRegenerate")}
      </button>
    {:else if minted}
      <p class="code" data-test="pair-code">{minted.code}</p>
      <p class="dim small" data-test="pair-expires">{t("pairExpires", { minutes: minutesLeft })}</p>
      <p class="dim small">{t("pairWaiting")}</p>
      <button class="quiet" data-test="pair-leave" onclick={onLeave}>{t("pairLeave")}</button>
    {:else}
      <button class="primary" data-test="pair-create" onclick={onCreate} disabled={minting}>
        {minting ? t("pairCreating") : t("pairCreate")}
      </button>
      {#if refusal}
        <p class="problem" data-test="pair-refusal">{refusal}</p>
      {/if}
    {/if}
  </Card>

  <Card title={t("pairEnterCode")}>
    <form
      class="row"
      onsubmit={(e) => {
        e.preventDefault();
        onJoin(codeDraft);
      }}
    >
      <label class="sr-only" for="code">{t("pairEnterCode")}</label>
      <input
        id="code"
        data-test="pair-input"
        bind:value={codeDraft}
        inputmode="numeric"
        autocomplete="one-time-code"
        maxlength="6"
      />
      <button class="primary" type="submit" data-test="pair-join">{t("pairJoin")}</button>
    </form>
    {#if joinError}
      <p class="problem" data-test="pair-join-error">{joinError}</p>
    {/if}
  </Card>
{/if}

<style>
  h1 { margin: 0 0 var(--space-hairline); font-size: 20px; font-weight: 600; }
  .lede { margin: 0 0 var(--space-section); color: var(--text-dim); }
  .dim { color: var(--text-dim); margin: 0; }
  .small { font-size: 13px; }
  .problem { margin: var(--space-inner) 0 0; color: var(--text); }
  h2 { margin: 0 0 var(--space-hairline); font-size: 15px; font-weight: 600; }
  .code {
    font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
    font-size: 32px;
    letter-spacing: 0.2em;
    margin: 0 0 var(--space-tight);
  }
  .row { display: flex; gap: var(--space-tight); }
  input {
    min-height: 32px;
    padding: 6px var(--space-inner);
    border: 1px solid var(--border);
    border-radius: var(--corner);
    background: var(--bg);
    color: var(--text);
    font: inherit;
    letter-spacing: 0.2em;
    width: 9ch;
  }
  button {
    min-height: 32px;
    padding: 6px var(--space-section);
    border-radius: var(--corner);
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  button {
    transition:
      background-color var(--motion-base) var(--ease),
      border-color var(--motion-base) var(--ease),
      transform var(--motion-fast) var(--ease);
  }
  button:active:not(:disabled) { transform: scale(0.98); }
  .primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  .quiet { border: 0; background: transparent; color: var(--text-dim); padding-left: 0; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
</style>
