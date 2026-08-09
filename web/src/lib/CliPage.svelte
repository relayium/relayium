<script lang="ts">
  import { onMount } from "svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { navigate, PRICING_PATH, ME_PATH } from "./router.svelte";
  import CommandBlock from "./CommandBlock.svelte";
  import Icon from "./Icon.svelte";
  import { PICK_MODES, FLAG_ROWS, TRUST_FILES, GUIDES } from "./cli-page-data";
  const t = $derived<Messages>(messages[lang()]);
  const repo = "https://github.com/relayium/relayium";

  const installCmd = "curl -fsSL https://relayium.com/install.sh | sh";
  const buildCmd = `git clone ${repo}.git
cd relayium/server
go build -o relayium ./cmd/relayium`;
  const sshCmd = `# push a folder to a server you can SSH into
relayium push ./photos user@host:backups/

# pull it back
relayium pull user@host:backups/ ./restore

# pick an SSH key / port
relayium push -i ~/.ssh/id_ed25519 -p 2222 ./photos user@host:backups/`;
  const codeCmd = `# sender (once per machine: relayium login)
relayium send ./file.zip
# prints:  Code: 483920   (valid 5 minutes)
#          On the other machine:  relayium receive 483920

# receiver — no account needed
relayium receive 483920 ./downloads`;
  const daemonListenCmd = `# on the RECEIVER
relayium serve --dir ~/inbox      # --once to accept one transfer; --port to change 9031`;
  const daemonPushCmd = `# on the SENDER
relayium push ./file.zip relayium://receiver.example.com`;
  const daemonAuthCmd = `# on the RECEIVER, the first push prompts:
Incoming push from 203.0.113.7:54021
  fingerprint: 74318e3b…
Accept and remember this peer? [y/N] y

# no terminal (a systemd service)? pre-authorize instead:
relayium authorize 74318e3b…`;

  // Literal command names / flags / emoji; all prose comes from t.cliPage.
  // 与文案按下标配对的那几组常量住在 cli-page-data.ts —— 那里的类型把"两边等长"
  // 变成了编译期约束（见该文件的 SameLength）。
  const osBadge = "macOS · Linux · Windows";
  const syncCmd = "relayium sync ./site relayium://receiver.example.com --delete --watch";
  const textCmd = `# one machine mints and waits (needs relayium login); the other joins
relayium text
#   → Code: 483920   |   On the other machine:  relayium text 483920

# the other machine joins the printed code — one line per message, Ctrl-D to end
relayium text 483920`;
  const textPipeCmd = `# exact bytes, including multiline: pipe it — no flag needed
pbpaste | relayium text 483920
cat snippet.py | relayium text 483920

# optional: stop to compare the verification code first (needs a terminal)
relayium text 483920 --verify`;
  const loginCmd = "relayium login   # opens relayium.com/device — enter the code to bind this machine";
  // Device Inbox. Every command here exists today (server/cmd/relayium/inbox.go,
  // update.go); nothing in this section may imply a background daemon the CLI
  // does not implement or a container image Relayium does not publish.
  const inboxUpdateCmd = `# on the machine that will RECEIVE
relayium update --check     # is there a newer release?
relayium update             # install it in place
relayium inbox --help       # this build has Device Inbox if this prints`;
  const inboxLoginCmd = `relayium login --device-name prod-backup-1
#   → Open https://relayium.com/device and enter code: WDJB-MJHT
#     This machine will appear in My Devices as: prod-backup-1

# omit --device-name and it registers this host's own name`;
  const inboxEnableCmd = `relayium inbox enable --dir ~/inbox   # the opt-in, made HERE — nothing remote can set it
relayium inbox run                    # the receiver, in the foreground (--once for one pass)
relayium inbox status                 # folder, credential, worker, and what the server thinks`;
  const inboxServiceCmd = `# prints a unit for THIS machine; it installs nothing itself
relayium inbox service systemd-user > relayium-inbox.service
#   also: systemd-system (dedicated account, needs root) · launchd · container`;
  const upCmd = `relayium up ./report.pdf
#   → https://relayium.com/d/7fK2p…#k=Xr8s…

# retention (otherwise your account's default applies)
relayium up ./report.pdf --burn              # one download, then gone
relayium up ./report.pdf --ttl 7d            # kept 7 days (your plan sets the cap)
relayium up ./report.pdf --max-downloads 5   # allow 5 downloads`;
  const downCmd = `# on another machine — no login needed
relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…' ./dest`;
  const guideUrl = (slug: string) => (lang() === "en" ? `/${slug}` : `/${lang()}/${slug}`);

  // Land on the section the link named, not on the top of a long page.
  //
  // The browser's own fragment handling cannot do this here: the SPA shell's
  // <body> is empty when the document loads, so `#device-inbox` does not exist
  // at the moment Chrome looks for it, and it gives up. Verified in a real
  // browser (e2e/device-discovery.mjs) — before this, My Devices' "set up a
  // device inbox" link dropped the reader at the install instructions, which is
  // the same place they were already lost.
  //
  // Focus moves with the scroll. Scrolling alone leaves a keyboard or screen
  // reader user at the document start while the sighted view has jumped: the
  // next Tab would go to the nav, not into what they asked to read.
  onMount(() => {
    const id = location.hash.slice(1);
    if (!id) return;
    const target = document.getElementById(id);
    if (!target) return;
    target.setAttribute("tabindex", "-1");
    target.scrollIntoView({ block: "start" });
    target.focus({ preventScroll: true });
  });
</script>

<section class="cli page-enter">
  <header class="hero">
    <div class="logo" aria-hidden="true">❯</div>
    <h1>Relayium CLI</h1>
    <p class="sub">{t.cli.subtitle}</p>
    <ul class="badges">
      {#each t.cliPage.badges as b (b)}<li>{b}</li>{/each}
      <li>{osBadge}</li>
    </ul>
    <p class="freenote">{t.cliPage.freenote}</p>
  </header>

  <!-- Install -->
  <div class="block">
    <h2>{t.cliPage.installH2}</h2>
    <p>{t.cliPage.installIntro}</p>
    <CommandBlock code={installCmd} title="install" />
    <p class="alt"><a href={`${repo}/releases/latest`}>{t.cliPage.installReleases}</a></p>
    <p class="alt">{t.cliPage.installBuild}</p>
    <CommandBlock code={buildCmd} title="build from source" />
    <p class="alt">{t.cliPage.installHelp}</p>
  </div>

  <!-- Which mode -->
  <div class="block">
    <h2>{t.cliPage.whichH2}</h2>
    <p>{t.cliPage.whichIntro}</p>
    <div class="pick">
      {#each PICK_MODES as p, i (p.title)}
        <div class="pick-card">
          <span class="g" aria-hidden="true">
            {#if p.g === "network"}<Icon name="network" size={22} />{:else}{p.g}{/if}
          </span>
          <h3 id={`pick-title-${i}`}>{p.title}</h3>
          <p>{t.cliPage.pickWhen[i]}</p>
          <!-- Scrolls sideways, so it has to be a keyboard stop — otherwise the
               tail of a long command is readable with a mouse and unreachable
               without one. Named by the card's own visible heading.
               svelte-ignore fires because <code> is non-interactive; that rule
               guards against fake buttons, and this is the opposite case — WCAG
               2.1.1 requires a scrollable region to be reachable, which is exactly
               what axe's scrollable-region-focusable check asks for here. -->
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <code tabindex="0" role="group" aria-labelledby={`pick-title-${i}`}>{p.cmd}</code>
        </div>
      {/each}
    </div>
  </div>

  <!-- Cloud (async, account) -->
  <div class="mode" data-cli-mode="up / down">
    <div class="mode-head">
      <span class="g" aria-hidden="true">☁️</span>
      <h2>{t.cliPage.cloudH2}</h2>
      <span class="tag">{t.cliPage.cloudTag}</span>
    </div>
    <p>{t.cliPage.cloudIntro}</p>
    <CommandBlock code={loginCmd} title="login" />
    <p>{t.cliPage.cloudLoginNote}</p>
    <p>{t.cliPage.cloudBody}</p>
    <CommandBlock code={upCmd} title="up · from the first machine" />
    <CommandBlock code={downCmd} title="down · on the second machine" />
    <p>{t.cliPage.cloudInteropNote}</p>
    <p>{t.cliPage.cloudPrivacyNote}</p>
  </div>

  <!-- Device Inbox remains visually marked because it is the recommended answer
       to "get this file onto my server" and the only mode whose sending half
       lives in the browser. The id is the anchor My Devices links back to. -->
  <div class="mode featured" id="device-inbox" data-cli-mode="inbox">
    <div class="mode-head">
      <span class="g" aria-hidden="true">📥</span>
      <h2>{t.cliPage.inboxH2}</h2>
      <span class="tag rec">{t.cliPage.inboxTag}</span>
    </div>
    <p>{t.cliPage.inboxIntro}</p>
    <ol class="steps">
      <li>
        <strong>{t.cliPage.inboxStep1Label}</strong> {t.cliPage.inboxStep1Body}
        <CommandBlock code={inboxUpdateCmd} title="receiver · install or update" />
      </li>
      <li>
        <strong>{t.cliPage.inboxStep2Label}</strong> {t.cliPage.inboxStep2Body}
        <CommandBlock code={inboxLoginCmd} title="receiver · sign in and name it" />
      </li>
      <li>
        <strong>{t.cliPage.inboxStep3Label}</strong> {t.cliPage.inboxStep3Body}
        <CommandBlock code={inboxEnableCmd} title="receiver · enable, run, check" />
      </li>
      <li>
        <strong>{t.cliPage.inboxStep4Label}</strong> {t.cliPage.inboxStep4Body}
        <p class="cta">
          <a href={ME_PATH} onclick={(e) => { e.preventDefault(); navigate("me"); }}>{t.cliPage.inboxCta}</a>
        </p>
        <p class="alt">{t.cliPage.inboxCtaHint}</p>
      </li>
    </ol>
    <p>{t.cliPage.inboxServiceNote}</p>
    <CommandBlock code={inboxServiceCmd} title="receiver · keep it running" />
    <p class="alt">{t.cliPage.inboxNoImageNote}</p>
    <p>{t.cliPage.inboxQueueNote}</p>
    <p>{t.cliPage.inboxPrivacyNote}</p>
    <p class="alt">
      <a href={`${repo}/blob/main/docs/device-inbox-cli.md`}>{t.cliPage.inboxDocs}</a>
    </p>
  </div>

  <!-- Text (ephemeral messages) -->
  <div class="mode" data-cli-mode="text">
    <div class="mode-head">
      <span class="g" aria-hidden="true">💬</span>
      <h2>{t.cliPage.textH2}</h2>
      <span class="tag">{t.cliPage.textTag}</span>
    </div>
    <p>{t.cliPage.textIntro}</p>
    <CommandBlock code={textCmd} title="text · mint and join" />
    <p>{t.cliPage.textPipeNote}</p>
    <CommandBlock code={textPipeCmd} title="text · exact bytes" />
    <p>{t.cliPage.textSasNote}</p>
    <p>{t.cliPage.textLimitNote}</p>
  </div>

  <!-- Mode 2: send / receive -->
  <div class="mode" data-cli-mode="send / receive">
    <div class="mode-head">
      <span class="g" aria-hidden="true">🔗</span>
      <h2>{t.cliPage.mode2Title}</h2>
      <span class="tag free">{t.cliPage.mode2Tag}</span>
    </div>
    <p>{t.cliPage.mode2Body}</p>
    <CommandBlock code={codeCmd} title="send / receive" />
  </div>

  <!-- Mode 1: push / pull -->
  <div class="mode" data-cli-mode="push / pull">
    <div class="mode-head">
      <span class="g" aria-hidden="true">🔑</span>
      <h2>{t.cliPage.mode1Title}</h2>
      <span class="tag free">{t.cliPage.mode1Tag}</span>
    </div>
    <p>{t.cliPage.mode1Body}</p>
    <CommandBlock code={sshCmd} title="push / pull" />
  </div>

  <!-- Mode 3: daemon direct -->
  <div class="mode" data-cli-mode="daemon direct">
    <div class="mode-head">
      <span class="g" aria-hidden="true"><Icon name="network" size={22} /></span>
      <h2>{t.cliPage.mode3Title}</h2>
      <span class="tag free">{t.cliPage.mode3Tag}</span>
    </div>
    <p>{t.cliPage.mode3Body}</p>
    <ol class="steps">
      <li>
        <strong>{t.cliPage.step1Label}</strong> {t.cliPage.step1Body}
        <CommandBlock code={daemonListenCmd} title="receiver · listen" />
      </li>
      <li>
        <strong>{t.cliPage.step2Label}</strong> {t.cliPage.step2Body}
        <CommandBlock code={daemonPushCmd} title="sender · push" />
      </li>
      <li>
        <strong>{t.cliPage.step3Label}</strong> {t.cliPage.step3Body}
        <CommandBlock code={daemonAuthCmd} title="receiver · approve" />
      </li>
    </ol>
  </div>

  <!-- Sync -->
  <div class="block" data-cli-mode="sync">
    <h2>{t.cliPage.syncH2}</h2>
    <p>{t.cliPage.syncNote}</p>
    <CommandBlock code={syncCmd} title="sync a folder" />
  </div>

  <!-- Guides -->
  <div class="block">
    <h2>{t.cliPage.guidesH2}</h2>
    <div class="guide-cards">
      {#each GUIDES as g, i (g.slug)}
        <a class="guide-card" href={guideUrl(g.slug)}>
          <span class="g" aria-hidden="true">
            {#if g.icon === "network"}<Icon name="network" size={22} />{:else}{g.icon}{/if}
          </span>
          <span class="gt">{t.cliPage.guides[i]}</span>
          <span class="arr" aria-hidden="true">→</span>
        </a>
      {/each}
    </div>
  </div>

  <!-- Reference -->
  <div class="block">
    <h2>{t.cliPage.refH2}</h2>

    <h3>{t.cliPage.flagsH3}</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>{t.cliPage.thFlag}</th><th>{t.cliPage.thApplies}</th><th>{t.cliPage.thMeaning}</th></tr></thead>
        <tbody>
          {#each FLAG_ROWS as f, i (f.flag)}
            <tr><td><code>{f.flag}</code></td><td>{f.who}</td><td>{t.cliPage.flagMeanings[i]}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>

    <h3>{t.cliPage.trustH3}</h3>
    <p>{t.cliPage.trustIntro}</p>
    <ul class="files">
      {#each TRUST_FILES as name, i (name)}
        <li><code>{name}</code> — {t.cliPage.fileDescs[i]}</li>
      {/each}
    </ul>

    <h3>{t.cliPage.integrityH3}</h3>
    <p>{t.cliPage.integrityNote}</p>
  </div>

  <footer>
    <a href={repo}>{t.cliPage.footerSource}</a>
    <span class="dot" aria-hidden="true">·</span>
    <a href={`${repo}/releases/latest`}>{t.cliPage.footerReleases}</a>
    <span class="dot" aria-hidden="true">·</span>
    <a href={PRICING_PATH} onclick={(e) => { e.preventDefault(); navigate("pricing"); }}>{t.pricingPage.navLink}</a>
    <span class="dot" aria-hidden="true">·</span>
    <span class="muted">{t.cliPage.footerBrowser}</span>
  </footer>
</section>

<style>
  .cli {
    max-width: 1120px;
    margin: 0 auto;
    padding: var(--space-4) 0 var(--space-9);
  }

  /* Hero */
  .hero {
    text-align: center;
    padding: var(--space-6) 0 var(--space-4);
  }
  .logo {
    width: 60px;
    height: 60px;
    line-height: 60px;
    margin: 0 auto var(--space-3);
    font-size: 30px;
    font-family: var(--mono);
    color: #fff;
    border-radius: 14px;
    background: var(--grad-accent);
    box-shadow: 0 12px 36px -10px color-mix(in srgb, var(--accent) 55%, transparent);
  }
  .hero h1 {
    font-size: var(--fs-display);
    letter-spacing: -1.2px;
    margin: 0 0 var(--space-2);
  }
  .hero .sub {
    color: var(--text);
    font-size: var(--fs-body);
    max-width: 46ch;
    margin: 0 auto;
  }
  .badges {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-2);
    padding: 0;
    margin: var(--space-4) 0 0;
  }
  .badges li {
    font-size: var(--fs-xs);
    color: var(--text);
    padding: 4px 12px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface-2);
  }
  .freenote {
    color: var(--text);
    font-size: var(--fs-sm);
    line-height: 1.6;
    max-width: 54ch;
    margin: var(--space-4) auto 0;
  }

  /* Generic blocks */
  .block {
    margin-top: var(--space-8);
  }
  .block > h2,
  .mode-head h2 {
    font-size: var(--fs-h2);
    color: var(--text-h);
    margin: 0 0 var(--space-2);
    letter-spacing: -0.4px;
  }
  .block p,
  .mode > p,
  .steps li {
    color: var(--text);
    line-height: 1.65;
    margin-bottom: var(--space-3);
  }
  .alt {
    font-size: var(--fs-sm);
    margin-top: var(--space-3);
  }
  h3 {
    font-size: var(--fs-h3);
    color: var(--text-h);
    margin: var(--space-5) 0 var(--space-2);
  }

  /* Which-mode picker */
  .pick {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-3);
    margin-top: var(--space-4);
  }
  .pick-card {
    flex: 1 1 220px;
    min-width: 200px;
    max-width: 300px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--space-4);
    background: var(--surface);
  }
  .pick-card .g {
    display: flex;
    align-items: center;
    min-height: 26px;
    font-size: 22px;
  }
  .pick-card h3 {
    margin: var(--space-2) 0 4px;
    font-size: var(--fs-body);
    font-family: var(--mono);
  }
  .pick-card p {
    font-size: var(--fs-sm);
    margin-bottom: var(--space-2);
  }
  .pick-card code {
    display: block;
    font-family: var(--mono);
    font-size: var(--fs-xs);
    color: var(--text-h);
    overflow-x: auto;
    white-space: nowrap;
  }

  /* Detailed mode cards */
  .mode {
    margin-top: var(--space-6);
    padding: var(--space-5);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }
  .mode-head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-bottom: var(--space-2);
    flex-wrap: wrap;
  }
  .mode-head .g {
    font-size: 22px;
  }
  .mode-head h2 {
    margin: 0;
    font-size: var(--fs-h3);
  }
  .tag {
    font-size: var(--fs-xs);
    color: var(--text);
    padding: 3px 10px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface-2);
  }
  /* The status tokens, not a second private green. The literal #1a7f37 that used
     to live here was 4.43:1 on its own 10% tint — under AA by a hair, and invisible
     to the token work that already tuned --ok for both themes (it had no dark-mode
     value at all, so dark got the light green too). */
  .tag.free {
    color: var(--ok);
    border-color: var(--ok-border);
    background: var(--ok-bg);
  }
  /* "Recommended" is the accent, not the success green: it is a suggestion
     about which mode to pick, not a statement that something is free. */
  .tag.rec {
    color: var(--accent-fg);
    border-color: var(--accent-border);
    background: var(--social-bg);
  }
  /* The featured card is the first thing under the picker and has to read as
     the answer, not as one of six equals. A left accent rule rather than a
     tinted fill: the card holds four command blocks, and a background wash
     behind them fights the code styling in both themes. */
  .mode.featured {
    border-color: var(--accent-border);
    border-inline-start: 3px solid var(--accent);
  }
  /* The emphasis is on the LINK, not on the paragraph around it. A bolded <p>
     followed by ordinary text is what axe's p-as-heading rule flags, and it is
     right to: a screen-reader user gets a visual hierarchy that is not in the
     document. Giving the anchor a button's affordance says "this is the action"
     without pretending to be a heading. */
  .cta {
    margin: var(--space-3) 0 var(--space-2);
  }
  .cta a {
    display: inline-block;
    color: var(--accent-fg);
    text-decoration: none;
    border: 1px solid var(--accent-border);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-4);
    transition: background-color 0.13s;
  }
  .cta a:hover {
    background: var(--social-bg);
  }
  .cta a:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    .cta a {
      transition: none;
    }
  }

  .steps {
    margin: 0;
    padding-inline-start: 1.3em;
  }
  .steps li {
    margin-bottom: var(--space-4);
  }
  .steps li :global(.term) {
    margin-top: var(--space-2);
  }

  /* Reference table */
  .table-wrap {
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: var(--fs-sm);
  }
  th,
  td {
    text-align: start;
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  thead th {
    color: var(--text-h);
    background: var(--surface-2);
    white-space: nowrap;
  }
  tbody tr:last-child td {
    border-bottom: none;
  }
  td code {
    font-family: var(--mono);
    font-size: var(--fs-xs);
    color: var(--text-h);
    white-space: nowrap;
  }

  .files {
    color: var(--text);
    line-height: 1.7;
    padding-inline-start: 1.2em;
  }

  .guide-cards {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
    margin-top: var(--space-3);
  }
  .guide-card {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text-h);
    text-decoration: none;
    transition: border-color 0.13s;
  }
  .guide-card:hover {
    border-color: var(--accent-border);
  }
  .guide-card .g {
    font-size: 22px;
  }
  .guide-card .gt {
    flex: 1;
    font-weight: 600;
    font-size: var(--fs-sm);
  }
  .guide-card .arr {
    color: var(--accent-fg);
  }
  @media (max-width: 620px) {
    .guide-cards {
      grid-template-columns: 1fr;
    }
  }

  /* Inline code (filenames in the trust-files list) + links */
  .files code {
    font-family: var(--mono);
    font-size: 0.9em;
    color: var(--text-h);
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 1px 5px;
  }
  a {
    color: var(--accent-fg);
  }

  footer {
    margin-top: var(--space-8);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border);
    font-size: var(--fs-sm);
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  footer .dot,
  .muted {
    color: var(--text);
  }

</style>
