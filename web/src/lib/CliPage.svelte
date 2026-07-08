<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  import CommandBlock from "./CommandBlock.svelte";
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
  const codeCmd = `# both sides agree on a code (any short string), out of band

# sender
relayium send ./file.zip 123456

# receiver
relayium receive 123456 ./downloads`;
  const daemonListenCmd = `# on the LISTENER
relayium serve --dir ~/inbox      # long-running; --once to accept one transfer
relayium id                       # prints THIS host's fingerprint`;
  const daemonAuthCmd = `# on the listener: authorize a pusher by its fingerprint
echo "<pusher-fingerprint>" >> ~/.config/relayium/authorized_fingerprints`;
  const daemonPushCmd = `# on the PUSHER
relayium push ./file.zip relayium://host.example.com
# first connect is trusted on first use (TOFU) and pinned in known_hosts;
# if the listener's fingerprint later changes, the push refuses and warns.`;

  // Literal command names / flags / emoji; all prose comes from t.cliPage.
  const osBadge = "macOS · Linux · Windows";
  const pick = [
    { g: "🔑", title: "push / pull", cmd: "relayium push … user@host:path" },
    { g: "🔗", title: "send / receive", cmd: "relayium send … <code>" },
    { g: "🖧", title: "daemon direct", cmd: "relayium push … relayium://host" },
  ];
  const flagRows = [
    { flag: "--dir <d>", who: "serve" },
    { flag: "--port <n>", who: "serve, relayium://" },
    { flag: "--once", who: "serve" },
    { flag: "--no-resume", who: "all" },
    { flag: "--config-dir <d>", who: "serve / push / id" },
    { flag: "-i <file>", who: "push / pull" },
    { flag: "-p <n>", who: "push / pull" },
    { flag: "--verify", who: "send / receive" },
  ];
  const fileNames = ["id.key / id.crt", "known_hosts", "authorized_fingerprints"];
</script>

<section class="cli">
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
      {#each pick as p, i (p.title)}
        <div class="pick-card">
          <span class="g" aria-hidden="true">{p.g}</span>
          <h3>{p.title}</h3>
          <p>{t.cliPage.pickWhen[i]}</p>
          <code>{p.cmd}</code>
        </div>
      {/each}
    </div>
  </div>

  <!-- Mode 1 -->
  <div class="mode">
    <div class="mode-head">
      <span class="g" aria-hidden="true">🔑</span>
      <h2>{t.cliPage.mode1Title}</h2>
      <span class="tag free">{t.cliPage.mode1Tag}</span>
    </div>
    <p>{t.cliPage.mode1Body}</p>
    <CommandBlock code={sshCmd} title="push / pull" />
  </div>

  <!-- Mode 2 -->
  <div class="mode">
    <div class="mode-head">
      <span class="g" aria-hidden="true">🔗</span>
      <h2>{t.cliPage.mode2Title}</h2>
      <span class="tag free">{t.cliPage.mode2Tag}</span>
    </div>
    <p>{t.cliPage.mode2Body}</p>
    <CommandBlock code={codeCmd} title="send / receive" />
  </div>

  <!-- Mode 3 -->
  <div class="mode">
    <div class="mode-head">
      <span class="g" aria-hidden="true">🖧</span>
      <h2>{t.cliPage.mode3Title}</h2>
      <span class="tag free">{t.cliPage.mode3Tag}</span>
    </div>
    <p>{t.cliPage.mode3Body}</p>
    <ol class="steps">
      <li>
        <strong>{t.cliPage.step1Label}</strong> {t.cliPage.step1Body}
        <CommandBlock code={daemonListenCmd} title="listener" />
      </li>
      <li>
        <strong>{t.cliPage.step2Label}</strong> {t.cliPage.step2Body}
        <CommandBlock code={daemonAuthCmd} title="listener · authorize" />
      </li>
      <li>
        <strong>{t.cliPage.step3Label}</strong> {t.cliPage.step3Body}
        <CommandBlock code={daemonPushCmd} title="pusher" />
      </li>
    </ol>
  </div>

  <!-- Reference -->
  <div class="block">
    <h2>{t.cliPage.refH2}</h2>

    <h3>{t.cliPage.flagsH3}</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>{t.cliPage.thFlag}</th><th>{t.cliPage.thApplies}</th><th>{t.cliPage.thMeaning}</th></tr></thead>
        <tbody>
          {#each flagRows as f, i (f.flag)}
            <tr><td><code>{f.flag}</code></td><td>{f.who}</td><td>{t.cliPage.flagMeanings[i]}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>

    <h3>{t.cliPage.trustH3}</h3>
    <p>{t.cliPage.trustIntro}</p>
    <ul class="files">
      {#each fileNames as name, i (name)}
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
    <span class="muted">{t.cliPage.footerBrowser}</span>
  </footer>
</section>

<style>
  .cli {
    max-width: 820px;
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
    border-radius: 18px;
    background: linear-gradient(135deg, var(--accent), #6d28d9);
    box-shadow: var(--shadow);
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
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--space-3);
    margin-top: var(--space-4);
  }
  .pick-card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--space-4);
    background: var(--surface);
  }
  .pick-card .g {
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
  .tag.free {
    color: #1a7f37;
    border-color: color-mix(in srgb, #1a7f37 40%, transparent);
    background: color-mix(in srgb, #1a7f37 10%, transparent);
  }

  .steps {
    margin: 0;
    padding-left: 1.3em;
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
    text-align: left;
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
    padding-left: 1.2em;
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
    color: var(--accent);
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

  @media (max-width: 620px) {
    .pick {
      grid-template-columns: 1fr;
    }
  }
</style>
