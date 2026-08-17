<script lang="ts">
  // The account's devices, rendered as rows. One component, two callers:
  //
  //   /me            manage = true   — the credential directory it has always been
  //   /device-inbox  manage = false  — the same rows as send targets, nothing else
  //
  // It exists so the second surface is a CONFIGURATION of the first rather than a
  // copy of it. Every hard part — parsing the inbox subtree, deciding
  // sendability, encrypting, uploading, polling, cancelling, drag/drop — already
  // lives in DeviceCard and device-inbox.ts, and a second implementation of any
  // of it would drift the moment either page changed.
  //
  // Deliberately presentational: it owns no fetch, no timer and no session
  // effect. The list it is given is the list it renders, so the page that owns
  // the data keeps owning when that data may be replaced — which is what lets a
  // failed background refresh preserve the rows instead of unmounting a card
  // with a send running inside it.
  import { lang, messages, type Messages } from "./i18n.svelte";
  import {
    deviceKindLabel,
    deviceLastUsedText,
    deviceRefText,
    deviceSignedInText,
    type DeviceRow,
  } from "./device-list";
  import DeviceCard, { type RenameOutcome } from "./DeviceCard.svelte";

  interface Props {
    devices: DeviceRow[];
    /** Show the destructive/credential controls. Off by default: a caller that
     *  has not thought about revoke should not be given it. */
    manage?: boolean;
    /** Accessible name for the list, since the rows themselves are not headings. */
    label?: string;
    onRevoke?: (d: DeviceRow) => void;
    onRename?: (d: DeviceRow, name: string) => Promise<RenameOutcome>;
    onOpen?: (d: DeviceRow) => void;
    openLabel?: (d: DeviceRow) => string;
  }

  const { devices, manage = false, label, onRevoke, onRename, onOpen, openLabel }: Props = $props();
  const t = $derived<Messages>(messages[lang()]);
</script>

<!-- Keyed by ID so a background presence refresh replaces the DATA of a row
     without destroying the card. An in-flight send and its status poll live
     inside that component; re-creating it would abort the upload and lose the
     only place the outcome was being reported. -->
<ul class="devicelist" aria-label={label}>
  {#each devices as d (d.ID)}
    <DeviceCard
      device={d}
      kind={deviceKindLabel(d.Kind, t)}
      lastUsed={deviceLastUsedText(d, t, lang())}
      signedIn={deviceSignedInText(d, t, lang())}
      deviceRef={deviceRefText(d, t)}
      {manage}
      onRevoke={onRevoke ? () => onRevoke(d) : undefined}
      onRename={onRename ? (name) => onRename(d, name) : undefined}
      onOpen={onOpen ? () => onOpen(d) : undefined}
      openLabel={openLabel ? openLabel(d) : undefined}
    />
  {/each}
</ul>

<style>
  /* The row's own styling lives in DeviceCard.svelte — Svelte scopes CSS per
     component, so a `.devicelist li` rule written here would not reach it. */
  .devicelist {
    list-style: none;
    margin: var(--space-3) 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
</style>
