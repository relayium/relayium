<!--
  A row that exists so the shell matches Mac, for a feature this build does not
  have.

  It offers no control that appears to work, and it claims nothing. That is the
  whole design: a greyed button, a spinner, or an empty list would all read as
  "this is broken" or "this will finish in a moment", and one of those is a lie
  the user acts on. Naming the absence is the only honest option.

  This state is acceptable for an INTERNAL build only. It is not a launch, and a
  build containing it is not a release candidate.
-->
<script lang="ts">
  import { t } from "../i18n/index.svelte.js";
  import Card from "../shell/Card.svelte";
  import type { MessageKey } from "../i18n/messages.js";

  let { title, body }: { title: string; body: MessageKey } = $props();
</script>

<h1>{title}</h1>
<Card title={t("soonTitle")}>
  <p class="dim">{t(body)}</p>
</Card>

<style>
  h1 { margin: 0 0 var(--space-section); font-size: 20px; font-weight: 600; }
  .dim { margin: 0; color: var(--text-dim); }
</style>
