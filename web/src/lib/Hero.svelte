<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  import Group from "./ui/Group.svelte";
  import Row from "./ui/Row.svelte";

  let { connState, unsupported, selfName, selfIP, onRename, workspace = false }:
    { connState: "connecting" | "ready" | "reconnecting"; unsupported: boolean; selfName: string; selfIP: string; onRename: (name: string) => void; workspace?: boolean } = $props();
  const t = $derived<Messages>(messages[lang()]);

  // Inline rename: click the device name to edit it in place. Unchanged from the
  // sentence this block used to be — the control, its keys, its blur-commit and
  // its callback are the same; only what surrounds it moved.
  let editing = $state(false);
  let draft = $state("");

  function startEdit() {
    draft = selfName;
    editing = true;
  }
  function commit() {
    if (!editing) return;
    editing = false;
    onRename(draft);
  }
  function cancelEdit() {
    editing = false;
  }
  function focusAndSelect(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  // The short status noun that goes in the row's value slot. The reference's
  // rule for a right-hand value is "a short noun (Ready / Paused / 9:48), not a
  // whole sentence" — but a short noun is all this may be, never all that is
  // said: whenever the connection is not ready the full existing sentence stays
  // on screen under the group, because "Reconnecting…" alone does not tell
  // anyone what is being reconnected to.
  const status = $derived(
    unsupported ? t.unavailable
    : connState === "ready" ? t.shell.statusReady
    : connState === "reconnecting" ? t.shell.statusReconnecting
    : t.shell.statusConnecting,
  );
  const detail = $derived(
    unsupported || connState === "ready" ? ""
    : connState === "reconnecting" ? t.reconnecting : t.connecting,
  );
</script>

<!-- This device, as the reference's "THIS MAC" group: one card, one fact per
     row, the standing privacy promise as the group's single footnote.
     It was a centred tagline over a status pill that composed a sentence
     ("Connected · this device Mac-938") with the rename control buried inside
     it — so the device's name, its address and its connection state were three
     things a reader had to parse out of one line of prose.

     Deliberately NOT the page's heading: Nav renders the mark and wordmark, and
     the page's <h1> is the localized "Nearby devices" App renders over the task
     column. Every behaviour is unchanged: the inline rename, its keyboard
     handling, the public IP, and the unsupported-browser branch. -->
<header class="hero" class:workspace>
  <Group title={t.shell.deviceGroup} foot={t.tagline} flush>
    <Row label={t.shell.statusRow}>
      <span class="statusbar">
        <span class="dot" class:on={connState === "ready" && !unsupported} aria-hidden="true"></span>
        <span class="status-text">{status}</span>
      </span>
    </Row>

    {#if !unsupported && connState === "ready"}
      <!-- The rename control is the row's value, which is what it always was in
           substance: a button that turns into a field. -->
      <Row label={t.shell.nameRow} interactive>
        {#if editing}
          <input
            class="name-edit"
            aria-label={t.shell.nameRow}
            bind:value={draft}
            use:focusAndSelect
            onkeydown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commit(); }
              else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
            }}
            onblur={commit}
          />
        {:else}
          <button type="button" class="name-btn" onclick={startEdit}>{selfName}</button>
        {/if}
      </Row>

      {#if selfIP}
        <Row label={t.ipLabel}>
          <span class="ip">{selfIP}</span>
        </Row>
      {/if}
    {/if}

    {#if detail}
      <Row block>
        <p class="detail">{detail}</p>
      </Row>
    {/if}
  </Group>
</header>

<style>
  .hero { display: block; padding-block-start: var(--space-3); }
  /* Inside the shell this group is the first thing in the task column, so it
     needs no lead-in of its own. The class is also the marker the unsupported
     -browser layout contract in e2e/page-shell.mjs reads: App withholds it on
     the branch that has no workspace to be the identity of. */
  .hero.workspace { padding-block-start: 0; }
  /* Staggered entrance on mount — the block assembles on load and on each
     return to the LAN page. */
  .hero > :global(*) { animation: fade-up .5s ease both; }
  @media (prefers-reduced-motion: reduce) {
    .hero > :global(*) { animation: none; }
  }

  /* The status value: a dot plus one short noun. `.statusbar` keeps its name —
     it is what the LAN hierarchy test and the real-browser runners select on,
     and it still is the thing that says how this device is doing. */
  .statusbar { display: inline-flex; align-items: center; gap: var(--space-2); }
  .status-text { color: var(--text-h); font-size: 13px; }
  /* Connecting/reconnecting: a soft breathing dot so "working" reads as live.
     Ready: settle on the success token with a one-shot ring that pops outward.
     --ok, not a literal green: the literal was 3.3:1 on white. */
  .dot {
    inline-size: 8px; block-size: 8px; border-radius: 50%; flex: none;
    background: var(--control-border);
    animation: dot-pulse 1.4s ease-in-out infinite;
  }
  .dot.on {
    background: var(--ok);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 20%, transparent);
    animation: ready-pop .6s ease-out;
  }
  @keyframes dot-pulse {
    0%, 100% { opacity: .4; }
    50% { opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot, .dot.on { animation: none; opacity: 1; }
  }

  .name-btn {
    font: inherit; font-size: 13px; color: var(--text-h);
    background: none; border: none; padding: 0;
    cursor: pointer; text-decoration: underline dotted; text-underline-offset: 3px;
    min-inline-size: 0; max-inline-size: 100%; overflow-wrap: anywhere; text-align: end;
  }
  .name-btn:hover { color: var(--accent-fg); }
  /* Touch pointers get a ~44px target without changing the label's metrics or
     the row's height. */
  @media (pointer: coarse) {
    .name-btn { position: relative; }
    .name-btn::after {
      content: "";
      position: absolute;
      inset-inline: -8px;
      inset-block-start: 50%;
      block-size: 44px;
      transform: translateY(-50%);
    }
  }
  .name-edit {
    font: inherit; font-size: 13px; color: var(--text-h);
    background: var(--shell-card, var(--surface)); border: 1px solid var(--accent);
    border-radius: 6px; padding: 2px var(--space-2); inline-size: 12ch; max-inline-size: 45vw;
    box-sizing: border-box;
  }
  /* Addresses are monospace everywhere in the reference, and tabular figures
     stop the value jumping as the octets change. */
  .ip {
    font-family: var(--mono); font-size: 12px; color: var(--text-h);
    font-variant-numeric: tabular-nums; font-feature-settings: "tnum";
    min-inline-size: 0; overflow-wrap: anywhere;
  }
  /* The full sentence behind a non-ready status. It is a row of its own rather
     than a footnote so it sits with the status it explains, and it renders only
     while that status is not "Ready". */
  .detail { margin: 0; font-size: 12px; line-height: 1.5; color: var(--text); }
</style>
