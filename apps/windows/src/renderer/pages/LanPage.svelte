<!--
  Same network.

  ## Connect first. Choose what to send afterwards.

  `LanConnectPane.swift` is explicit about this and the reasoning is worth
  keeping: one verb on a chosen device — Connect — and it asks nothing else.
  There is no staged batch here, no drop zone and no picker, because a batch the
  user assembled before a connection exists has nowhere to go. Connect opens one
  `link/1`, and everything after that — messages, and as many file or folder
  batches as the user wants — rides on that one verified connection.

  ## "Receiving off" means not in the room

  `LanDiscovery.pause()` tears the socket down, and the signalling hub has no
  hidden-receiver flag. So off is not "visible but declining": it is not joined.
  No roster, no incoming, and no outgoing either, because there is nobody to send
  to. The empty state says exactly that rather than showing a hopeful spinner.
-->
<script lang="ts">
  import { t } from "../i18n/index.svelte.js";
  import Card from "../shell/Card.svelte";
  import Icon from "../shell/Icon.svelte";
  import LinkPane from "./LinkPane.svelte";
  import type { RoomController } from "../rooms/room-controller.svelte.js";
  import type { RevealController } from "../receive/reveal-controller.svelte.js";
  import type { ReceivedController } from "../receive/received-controller.svelte.js";

  let {
    room,
    reveal,
    received,
    receiving,
    busy,
    onStart,
    onStop,
    verifyPeers,
    messageDraft = $bindable(""),
  }: {
    room: RoomController | null;
    /** "Open the folder", for a receive that already saved. Passed through
     *  rather than reached for globally: the pane renders it, this page does
     *  not use it. */
    reveal: RevealController;
    /** The files a finished receive wrote, passed through to the pane. */
    received: ReceivedController;
    receiving: boolean;
    busy: boolean;
    onStart: () => void;
    onStop: () => void;
    verifyPeers: boolean;
    messageDraft?: string;
  } = $props();

  const peers = $derived(room?.peers ?? []);
  const linkPeerId = $derived(room?.workspace.linkPeerId ?? "");
  const connection = $derived(room?.connection ?? "connecting");
</script>

<h1>{t("lanTitle")}</h1>
<p class="lede">{t("lanSubtitle")}</p>

{#if !receiving}
  <Card>
    <div class="state">
      <Icon name="lan" size={28} />
      <div>
        <h2>{t("lanOff")}</h2>
        <p class="dim">{t("lanOffBody")}</p>
      </div>
    </div>
    <button class="primary" data-test="lan-start" onclick={onStart} disabled={busy}>
      {busy ? t("lanJoining") : t("lanStart")}
    </button>
  </Card>
{:else if room && linkPeerId}
  <LinkPane {room} {reveal} {received} {verifyPeers} bind:messageDraft />
{:else}
  <Card>
    <!-- The roster is only meaningful once this PC is actually in the room.
         Rendering "No other devices yet" for a socket that never opened is the
         same screen for two opposite situations. -->
    {#if connection === "connecting" || (connection === "reconnecting" && !room?.everJoined)}
      <div class="state">
        <span class="pulse"><Icon name="lan" size={28} /></span>
        <div>
          <h2>{t("lanJoiningTitle")}</h2>
          <p class="dim">{t("lanJoiningBody")}</p>
        </div>
      </div>
    {:else if connection === "reconnecting"}
      <div class="state">
        <span class="pulse"><Icon name="lan" size={28} /></span>
        <div>
          <h2 data-test="lan-reconnecting">{t("lanReconnecting")}</h2>
          <p class="dim">{t("lanReconnectingBody")}</p>
        </div>
      </div>
    {:else if connection === "offline"}
      <div class="state">
        <Icon name="lan" size={28} />
        <div>
          <h2 data-test="lan-offline">{t("lanOffline")}</h2>
          <p class="dim">{t("lanOfflineBody")}</p>
        </div>
      </div>
      <button class="primary" data-test="lan-retry" onclick={() => room?.retry()}>{t("lanRetry")}</button>
    {:else if room?.userStopped && peers.length > 0}
      <!-- Disconnected by the user, with the peer still present. Not "no
           devices" and not "waiting": the fence refuses re-offers until asked
           again, so there is nothing to wait for. -->
      <div class="state">
        <Icon name="lan" size={28} />
        <div>
          <h2 data-test="lan-disconnected">{t("pairDisconnected")}</h2>
          <p class="dim">{t("pairDisconnectedBody")}</p>
        </div>
      </div>
      <button class="primary" data-test="lan-reconnect" onclick={() => room?.connectTo(peers[0]!.id)}>
        {t("pairReconnect")}
      </button>
    {:else if peers.length === 0}
      <div class="state">
        <Icon name="lan" size={28} />
        <div>
          <h2 data-test="lan-empty">{t("lanEmpty")}</h2>
          <p class="dim">{t("lanEmptyBody")}</p>
        </div>
      </div>
    {:else}
      <ul class="devices">
        {#each peers as peer (peer.id)}
          <li>
            <span class="who"><Icon name="lan" /><span class="name">{peer.name || t("thisPc")}</span></span>
            {#if room?.caps.supportsLink(peer.id)}
              <button
                class="primary"
                data-test="lan-connect"
                onclick={() => room?.connectTo(peer.id)}
                disabled={room?.workspace.blocksNewIntent(peer.id)}
              >
                {t("lanConnect")}
              </button>
            {:else}
              <!-- A statement, not a greyed control with no stated reason. -->
              <span class="dim small">{t("lanUnsupported")}</span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    <p class="footer">
      <button data-test="lan-stop" onclick={onStop}>{t("lanStop")}</button>
    </p>
  </Card>
{/if}

<style>
  h1 { margin: 0 0 var(--space-hairline); font-size: 20px; font-weight: 600; }
  .lede { margin: 0 0 var(--space-section); color: var(--text-dim); }
  .dim { color: var(--text-dim); margin: 0 0 var(--space-tight); }
  .small { font-size: 13px; }
  .devices { list-style: none; margin: 0 0 var(--space-section); padding: 0; }
  .state { display: flex; gap: var(--space-inner); align-items: flex-start; margin-bottom: var(--space-section); }
  .state :global(svg) { color: var(--text-dim); margin-top: 2px; }
  .state h2 { margin: 0 0 var(--space-hairline); font-size: 15px; font-weight: 600; }
  .state p { margin: 0; }
  .pulse :global(svg) { animation: pulse 1.8s var(--ease) infinite; }
  @keyframes pulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }
  .who { display: flex; align-items: center; gap: var(--space-tight); }
  .who :global(svg) { color: var(--text-dim); }
  .footer { margin: 0; padding-top: var(--space-inner); border-top: 1px solid var(--border); }
  .devices li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-inner);
    min-height: var(--hit-target);
    border-bottom: 1px solid var(--border);
  }
  .devices li:last-child { border-bottom: 0; }
  .name { font-weight: 500; }
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
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
