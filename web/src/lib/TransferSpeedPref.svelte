<script lang="ts">
  // Upload speed preference (shared cloud/live cap; cloud-only background).
  // The device-local choice affects the next file frame or upload request,
  // including uploads already
  // running in this tab. Copy states exactly what spacing requests can do.
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { CAP_CHOICES, setSpeedPref, speedPref } from "./transfer-speed-pref.svelte";
  import type { SpeedMode } from "./transfer-control";

  import { untrack } from "svelte";

  let { open = false }: { open?: boolean } = $props();
  // The card's expanded state belongs to the user once rendered: `open` only
  // seeds it. A one-way `{open}` would re-apply the prop on every re-render of
  // this template (each mode/limit/language change) and fold the card shut
  // under the user's hand, hiding the note it just revealed.
  let expanded = $state(untrack(() => open));
  const t = $derived<Messages>(messages[lang()]);
  const pref = $derived(speedPref());
  const name = `speed-${Math.random().toString(36).slice(2, 8)}`;

  function mbit(bps: number): string {
    const v = (bps * 8) / 1_000_000;
    return v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1).replace(/\.0$/, "") : v.toFixed(2).replace(/0$/, "");
  }
  function choose(mode: SpeedMode): void {
    setSpeedPref({ ...pref, mode });
  }
  function chooseCap(e: Event): void {
    const v = Number((e.currentTarget as HTMLSelectElement).value);
    setSpeedPref({ mode: "cap", capBytesPerSec: v });
  }
</script>

<details class="ui-card speed-pref" bind:open={expanded}>
  <summary>{t.speed.title}</summary>
  <p class="speed-note">{t.speed.scope}</p>
  <fieldset>
    <legend class="sr-only">{t.speed.title}</legend>
    <label class="speed-option">
      <input type="radio" {name} value="fast" checked={pref.mode === "fast"} onchange={() => choose("fast")} />
      <span><strong>{t.speed.fast}</strong> <span class="speed-note">{t.speed.fastNote}</span></span>
    </label>
    <label class="speed-option">
      <input type="radio" {name} value="background" checked={pref.mode === "background"} onchange={() => choose("background")} />
      <span><strong>{t.speed.background}</strong> <span class="speed-note">{t.speed.backgroundNote}</span></span>
    </label>
    <label class="speed-option">
      <input type="radio" {name} value="cap" checked={pref.mode === "cap"} onchange={() => choose("cap")} />
      <span><strong>{t.speed.cap}</strong></span>
      <select aria-label={t.speed.capLabel} value={String(pref.capBytesPerSec)} onchange={chooseCap}>
        {#each CAP_CHOICES as bps (bps)}
          <option value={String(bps)}>{t.speed.mbit(mbit(bps))}</option>
        {/each}
      </select>
    </label>
  </fieldset>
  {#if pref.mode === "cap"}<p class="speed-note">{t.speed.capNote}</p>{/if}
</details>

<style>
  .speed-pref { margin-block-start: var(--space-3); }
  .speed-pref summary { cursor: pointer; font-weight: 600; color: var(--text-h); }
  fieldset { border: 0; margin: var(--space-2) 0 0; padding: 0; display: grid; gap: var(--space-2); }
  .speed-option { color: var(--text-h); cursor: pointer; display: flex; gap: var(--space-2); align-items: baseline; flex-wrap: wrap; }
  .speed-note { margin: 4px 0 0; font-size: var(--fs-xs); line-height: 1.5; color: var(--text); }
  select { min-height: 32px; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>
