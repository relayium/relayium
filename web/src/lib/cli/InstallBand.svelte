<script lang="ts">
  // Install, immediately under the H1, because it is what almost everyone who
  // opens /cli came to do.
  //
  // Windows is an ACTION here, not a sentence pointing at the releases page. The
  // previous page said one command "downloads a prebuilt binary for your OS",
  // then mentioned Windows in an aside — which reads as though `curl … | sh`
  // covers Windows too. It does not: install.sh is POSIX sh. So the two
  // platforms are separated, the shell command is labelled macOS and Linux, and
  // Windows gets its own portable-ZIP downloads.
  import CommandBlock from "../CommandBlock.svelte";
  import {
    COMMANDS,
    WINDOWS_BUILDS,
    LATEST_RELEASE_URL,
    releaseAssetUrl,
    copyProps,
  } from "../cli-page-data";
  import type { Messages } from "../i18n.svelte";

  let { cli, id }: { cli: Messages["cliPage"]; id: string } = $props();
</script>

<section class="install" {id} aria-labelledby="cli-install-h">
  <h2 id="cli-install-h">{cli.sections.install}</h2>
  <p class="lead">{cli.installIntro}</p>

  <div class="platforms">
    <div class="posix">
      <h3>{cli.installPosixLabel}</h3>
      <CommandBlock
        code={COMMANDS.install.code}
        title={COMMANDS.install.name}
        {...copyProps(cli.copy, COMMANDS.install.name)}
      />
    </div>

    <div class="windows">
      <h3>{cli.installWindowsLabel}</h3>
      <p>{cli.installWindowsBody}</p>
      <!-- The href is GitHub's `latest/download/` redirect, so it always
           resolves to the newest published release. No version number is
           written into this page to go stale. The visible label carries the
           architecture, so the two buttons are distinguishable by name. -->
      <p class="downloads">
        {#each WINDOWS_BUILDS as b (b.key)}
          <a class="dl" href={releaseAssetUrl(b.file)} download>
            {cli.installWindowsCta} · {b.label}
          </a>
        {/each}
      </p>
      <p class="note">{cli.installWindowsUpdateNote}</p>
    </div>
  </div>

  <p class="alt"><a href={LATEST_RELEASE_URL}>{cli.installReleases}</a></p>
  <p class="alt">{cli.installBuild}</p>
  <CommandBlock
    code={COMMANDS.build.code}
    title={COMMANDS.build.name}
    {...copyProps(cli.copy, COMMANDS.build.name)}
  />
  <p class="alt">{cli.installHelp}</p>
</section>

<style>
  .install h2 {
    font-size: var(--fs-h2);
    color: var(--text-h);
    letter-spacing: -0.4px;
    margin: 0 0 var(--space-2);
  }
  .lead {
    color: var(--text);
    line-height: 1.65;
    margin: 0 0 var(--space-5);
    max-inline-size: 62ch;
  }

  /* Two open columns divided by a hairline, not two cards. The command surface
     is already a bordered block; wrapping it in a second box is one rim too
     many, and it is what makes a page read as a bento grid. */
  /* minmax(0, 1fr), not the implicit `auto` track, for the same reason .layout
     spells it out: an `auto` track floors at its items' min-content, and a
     command block's min-content is a whole shell command wide. On a 390px phone
     that sized this single column at 446px and pushed the band — and every
     ancestor up to .cli — past the viewport. The overflow was invisible only
     because .cli clips; the right-hand side of the install command was still
     unreachable. The column now takes the width it is given and the command
     scrolls inside its own <pre>, which is where the sideways scroll belongs. */
  .platforms {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-5);
  }
  @media (min-width: 760px) {
    .platforms {
      grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
      gap: var(--space-6);
    }
    .windows {
      padding-inline-start: var(--space-6);
      border-inline-start: 1px solid var(--border);
    }
  }

  h3 {
    font-size: var(--fs-h3);
    color: var(--text-h);
    margin: 0 0 var(--space-3);
  }
  .windows p {
    color: var(--text);
    font-size: var(--fs-sm);
    line-height: 1.65;
    margin: 0 0 var(--space-3);
  }

  .downloads {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .dl {
    display: inline-flex;
    align-items: center;
    /* 44px so this is a real target on a phone, where it is the only way to
       install at all. */
    min-block-size: 44px;
    padding: 0 var(--space-4);
    border: 1px solid var(--accent-border);
    border-radius: var(--radius-sm);
    color: var(--accent-fg);
    text-decoration: none;
    font-size: var(--fs-sm);
    transition: background-color 0.13s;
  }
  .dl:hover {
    background: var(--social-bg);
  }
  .dl:focus-visible {
    outline: var(--focus-width) solid var(--focus);
    outline-offset: var(--focus-offset);
  }
  @media (prefers-reduced-motion: reduce) {
    .dl {
      transition: none;
    }
  }

  .note,
  .alt {
    color: var(--text);
    font-size: var(--fs-sm);
    line-height: 1.65;
  }
  .alt {
    margin: var(--space-5) 0 var(--space-3);
    max-inline-size: 62ch;
  }
  .install :global(a) {
    color: var(--accent-fg);
  }
</style>
