<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";

  let {
    title,
    status = "",
    tone = "neutral",
    children,
  }: {
    title: string;
    status?: string;
    tone?: "neutral" | "success" | "danger";
    children: Snippet;
  } = $props();
</script>

<section class="auth-page page-enter">
  <div class="auth-card ui-card ui-card-raised ui-stack">
    <span class="trust-mark" aria-hidden="true"><Icon name="shield" size={26} /></span>
    <h1>{title}</h1>
    <!-- Keep one live node mounted while phases change. Screen readers reliably
         announce text replacement here; repeatedly inserting new live regions is
         inconsistently announced by Safari/VoiceOver. -->
    <p
      class="status"
      class:success={tone === "success"}
      class:danger={tone === "danger"}
      role={tone === "danger" ? "alert" : "status"}
      aria-live={tone === "danger" ? "assertive" : "polite"}
      aria-atomic="true"
    >{status}</p>
    <div class="content">{@render children()}</div>
  </div>
</section>

<style>
  .auth-page {
    box-sizing: border-box;
    inline-size: min(100%, 480px);
    margin-inline: auto;
    padding-block: var(--space-7);
  }
  .auth-card { align-items: center; text-align: center; }
  .trust-mark {
    display: grid;
    place-items: center;
    inline-size: 48px;
    block-size: 48px;
    border: 1px solid var(--accent-border);
    border-radius: 50%;
    background: var(--accent-bg);
    color: var(--accent-fg);
  }
  h1 {
    margin: 0;
    color: var(--text-h);
    font-size: var(--fs-h2);
    line-height: 1.2;
    overflow-wrap: anywhere;
  }
  .status {
    min-block-size: 1.5em;
    margin: 0;
    color: var(--text);
    line-height: 1.55;
  }
  .status:empty { visibility: hidden; }
  .status.success { color: var(--ok); }
  .status.danger { color: var(--danger); }
  .content { inline-size: 100%; }

  @media (max-width: 520px) {
    .auth-page { padding-block: var(--space-5); }
    .auth-card { padding-inline: var(--space-4); }
    h1 { font-size: 26px; }
  }
</style>
