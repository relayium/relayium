<!-- Decorative one-peer illustration: "this device ── that device".
     Shown instead of the radar when exactly one peer is visible, because a radar
     with a single blip is a selector with nothing to select — it only pushes the
     actual send action past the fold.

     Deliberately inert: aria-hidden as a whole, with no focusable content. The
     peer card rendered immediately below is the single actionable, announced
     representation of this peer; duplicating its name into the accessibility
     tree here would just make screen-reader users hear it twice. -->
<script lang="ts">
  let { selfName, peerName }: { selfName: string; peerName: string } = $props();

  const selfInitial = $derived((selfName || "?").slice(0, 1).toUpperCase());
  const peerInitial = $derived((peerName || "?").slice(0, 1).toUpperCase());
</script>

<div class="peerlink" aria-hidden="true">
  <span class="node">
    <span class="avatar">{selfInitial}</span>
    <span class="label">{selfName}</span>
  </span>
  <span class="wire"><span class="pulse"></span></span>
  <span class="node">
    <span class="avatar target">{peerInitial}</span>
    <span class="label">{peerName}</span>
  </span>
</div>

<style>
  .peerlink {
    display: flex; align-items: flex-start; justify-content: center;
    gap: var(--space-3);
    margin-block: var(--space-4) var(--space-3);
  }
  .node {
    display: flex; flex-direction: column; align-items: center; gap: 6px;
    min-width: 0; max-inline-size: 12ch;
  }
  .avatar {
    display: grid; place-items: center;
    width: 38px; height: 38px; border-radius: 50%;
    background: var(--surface); border: 1px solid var(--border);
    color: var(--text-h); font-weight: 700; font-size: var(--fs-sm);
  }
  .avatar.target {
    background: var(--grad-action); border-color: transparent; color: #fff;
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 22%, transparent);
  }
  .label {
    font-size: var(--fs-xs); color: var(--text);
    max-inline-size: 100%; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
  }
  /* Sits on the avatars' centre line, not the labels'. */
  .wire {
    position: relative; flex: 1 1 auto; max-inline-size: 180px;
    block-size: 2px; margin-block-start: 18px; border-radius: 2px;
    background: linear-gradient(to right,
      var(--border),
      color-mix(in srgb, var(--accent) 55%, transparent));
  }
  .pulse {
    position: absolute;
    inset-block-start: 50%;
    inset-inline-start: 0;
    width: 6px; height: 6px; margin-block-start: -3px;
    border-radius: 50%; background: var(--accent);
    /* Logical inset so the dot travels self → peer in RTL as well. */
    animation: wire-travel 2.2s cubic-bezier(.4, 0, .6, 1) infinite;
  }
  @keyframes wire-travel {
    0% { inset-inline-start: 0; opacity: 0; }
    18% { opacity: 1; }
    82% { opacity: 1; }
    100% { inset-inline-start: calc(100% - 6px); opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .pulse { animation: none; opacity: 0; }
  }
  /* Phone: this is a decoration sitting directly above the primary action, so it
     pays for itself in as few pixels as possible. */
  @media (max-width: 700px) {
    .peerlink { margin-block: var(--space-3) var(--space-2); }
    .avatar { width: 34px; height: 34px; }
    .wire { margin-block-start: 16px; }
  }
</style>
