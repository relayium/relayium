<!-- The route a LAN send would take, stated once a real recipient is selected.
     Presentational only, like DeviceRadar: it holds no link, transfer or
     protocol state and it is never rendered speculatively — App renders it
     inside the same `selectedPeer` branch as the send card, so the empty and
     still-scanning states have nothing to draw it for.

     What it deliberately does NOT say is most of it. There is no state dot, no
     "connected", no speed, no byte count, no server-bypass claim and no
     encryption claim, because at this point nothing has been negotiated: the
     only facts are which device this is, which route this destination uses, and
     who was picked. The middle label is the SAME t.pathLan the workspace header
     and the message panel use for a live link, so the page has one vocabulary
     for one route rather than a second, softer, invented one. -->
<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";

  let { selfName, peerName }: { selfName: string; peerName: string } = $props();

  const t = $derived<Messages>(messages[lang()]);
  const initial = (name: string) => (name || "?").slice(0, 1).toUpperCase();
</script>

<p class="path-rail">
  <span class="pr-end">
    <span class="pr-avatar" aria-hidden="true">{initial(selfName)}</span>
    <span class="pr-name">{selfName}</span>
  </span>
  <span class="pr-line" aria-hidden="true"></span>
  <span class="pr-path">{t.pathLan}</span>
  <span class="pr-line" aria-hidden="true"></span>
  <span class="pr-end">
    <span class="pr-avatar" aria-hidden="true">{initial(peerName)}</span>
    <span class="pr-name">{peerName}</span>
  </span>
</p>

<style>
  /* One quiet line above the send card: two named ends and the route between
     them. Flex plus logical spacing only, so Arabic mirrors it without a second
     rule and the sender stays the reading-order start in both directions. */
  .path-rail {
    display: flex; align-items: center; gap: var(--space-2);
    max-inline-size: 560px; margin: 0 0 var(--space-3);
    font-size: var(--fs-xs); color: var(--text);
  }
  .pr-end { display: inline-flex; align-items: center; gap: 6px; min-inline-size: 0; }
  .pr-avatar {
    display: grid; place-items: center; flex: none;
    inline-size: 22px; block-size: 22px; border-radius: 50%;
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-h); font-size: 11px; font-weight: 700;
  }
  .pr-name {
    color: var(--text-h); font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  /* The connector is decoration for a fact the text already states, so it takes
     only leftover width and gives it back first. A flex basis of 0 (rather than
     a real width) is what keeps it out of the initial sizing round: at 390px a
     10px basis was enough to push both device names into their ellipsis while
     32px of the row sat unused between them. */
  .pr-line { flex: 1 1 0; min-inline-size: 6px; block-size: 1px; background: var(--border); }
  /* The route label is the point of the row and never truncates; a long device
     name ellipsises instead, and the send card directly below always shows the
     recipient's name in full. */
  .pr-path { flex: none; white-space: nowrap; }
  @media (max-width: 700px) { .path-rail { gap: 6px; } }
</style>
