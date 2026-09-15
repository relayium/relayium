<script lang="ts">
  import type { Snippet } from "svelte";
  import type { RelayAvailability } from "./ice";
  import CodePairing from "./CodePairing.svelte";
  import HowItWorks from "./HowItWorks.svelte";
  import ModeCompare from "./ModeCompare.svelte";
  import FeatureStrip from "./FeatureStrip.svelte";
  import UseCases from "./UseCases.svelte";
  import Faq from "./Faq.svelte";
  import CrossSell from "./CrossSell.svelte";
  import WhyAccount from "./WhyAccount.svelte";
  import { session } from "./auth.svelte";
  import { enterRoom } from "./room.svelte";
  import { clearOutbox } from "./outbox.svelte";
  import { resetPreupload } from "./preupload.svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { setLoginOpen } from "./login.svelte";
  import PageFooter from "./PageFooter.svelte";
  import Icon from "./Icon.svelte";
  import Group from "./ui/Group.svelte";
  import Help from "./ui/Help.svelte";

  let { roomCode = "", linkDead = false, showTransfer = false, relayStatus = "ok", transferSurface }:
    { roomCode?: string; linkDead?: boolean; showTransfer?: boolean; relayStatus?: RelayAvailability; transferSurface?: Snippet } = $props();

  const t = $derived<Messages>(messages[lang()]);
  const inRoom = $derived(!!roomCode);

  // Leaving a room must also drop the sessionStorage role markers — otherwise a
  // stale "I minted this code" flag makes the next method choice render the
  // wrong side (e.g. showing a waiting screen instead of the code entry). Key
  // mirrors CodePairing (EXP_KEY).
  function startOver() {
    sessionStorage.removeItem("relayium_pair_exp");
    // Queued-but-unsent files belong to the abandoned pairing attempt — drop
    // them so they can't surprise-send to the next peer that appears. Any
    // pre-upload for that attempt goes with them: it is bound to the room being
    // abandoned, so the rest of its bytes would buy nothing.
    clearOutbox();
    resetPreupload();
    // Leaving the room is the whole exit now. This destination draws the
    // transfer surface for its pairing room and for nothing else
    // (`showsTransferSurface`), so dropping the code returns to the method
    // choices — there is no second, LAN-driven reason for the surface to stay
    // up that would need suppressing as well.
    enterRoom({});
  }
</script>

<section class="crosspage page-enter">

  <!-- ONE title. This page used to print its name three times on one screen:
       the toolbar echoes the destination, `crossTitle` was the <h1>, and
       `methods.realtime.name` was the card heading directly under it — the same
       words in both languages. The <h1> stays (it is the page), the card heading
       is gone, and the group label below names the OPERATION instead.

       `crossPitch` used to be two paragraphs between the title and the control.
       They are still here, verbatim, inside the disclosure — the reference's §5
       rule is that an explanation which does not fit on one line folds away by
       default, not that it disappears. What does NOT fold: who needs an account,
       who does not, and what the relay can and cannot read. -->
  <header class="ui-page-head">
    <h1>{t.crossTitle}</h1>
    <p class="tagline">{t.tagline}</p>
  </header>

  <div class="cards">
    {#if showTransfer && transferSurface}
      <!-- Active realtime transfer — one focused group, regardless of how they
           connected. Its two standing facts stay on screen: what the link is
           (sub) and who needs an account (foot). -->
      <Group title={t.shell.liveGroup} foot={t.crossnet.realtimeFoot} flush>
        {#snippet icon()}<Icon name="bolt" size={15} />{/snippet}
        <div class="op">
          <p class="op-sub">{t.crossnet.realtimeSub}</p>
          {@render transferSurface()}
          <button class="btn btn-ghost btn-sm startover" onclick={startOver}>{t.startOver}</button>
        </div>
      </Group>
    {:else if roomCode}
      <!-- In a code room (minter waiting, or recipient who joined via code/link) -->
      <Group title={t.shell.pairGroup} note={t.methods.realtime.badge} flush>
        {#snippet icon()}<Icon name="bolt" size={15} />{/snippet}
        <div class="op">
          <CodePairing {roomCode} expired={linkDead} {relayStatus} />
          <button class="btn btn-ghost btn-sm startover" onclick={startOver}>{t.startOver}</button>
        </div>
      </Group>
    {:else}
      <Group title={t.shell.pairGroup} note={t.methods.realtime.badge} flush>
        {#snippet icon()}<Icon name="bolt" size={15} />{/snippet}
        <div class="op">
          <CodePairing requireLogin={() => setLoginOpen(true)} />
        </div>
      </Group>
      <Help summary={t.shell.howSummary}>
        <p>{t.crossPitch}</p>
        <p>{t.methods.realtime.sub}</p>
      </Help>
    {/if}
  </div>

  {#if !inRoom && !session().user}
    <WhyAccount collapsible />
  {/if}

  {#if !inRoom}
    <CrossSell target="offline" />
    <HowItWorks variant="realtime" />
    <ModeCompare />
    <FeatureStrip />
    <UseCases />
    <Faq variant="cross" />
  {/if}

  <PageFooter fineprint={t.footer} />
</section>

<style>
  /* Layout only. The page header comes from app.css (.ui-page-head); the card,
     its label, its qualifier and its footnote are `ui/Group.svelte`; the folded
     explanation is `ui/Help.svelte`. Nothing in this file styles another
     component's insides. */
  .crosspage { position: relative; }
  @media (max-width: 700px) {
    /* Localized headings include long compound words. At 320px their min-content
       width used to push the whole document sideways; inherit a last-resort
       break opportunity only where it is needed. */
    .crosspage { overflow-wrap: anywhere; }
  }

  .cards { display: flex; flex-direction: column; gap: var(--space-4); max-inline-size: 720px; margin-inline: auto; }

  /* The operation itself, inset to the group's own row padding. */
  .op { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-3) 14px; }
  .op-sub { margin: 0; font-size: 12px; line-height: 1.55; color: var(--text); }
  .startover { align-self: flex-start; flex: none; }
</style>
