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

  const badges = [
    "Completely free",
    "End-to-end encrypted",
    "Self-hostable",
    "macOS · Linux · Windows",
  ];

  const pick = [
    { g: "🔑", title: "push / pull", when: "To a server you can SSH into", cmd: "relayium push … user@host:path" },
    { g: "🔗", title: "send / receive", when: "To another person, cross-network", cmd: "relayium send … <code>" },
    { g: "🖧", title: "daemon direct", when: "Between two servers you own", cmd: "relayium push … relayium://host" },
  ];

  const flags = [
    { flag: "--dir <d>", who: "serve", meaning: "Directory to receive into (default: current dir)" },
    { flag: "--port <n>", who: "serve, relayium://", meaning: "Daemon TCP port (default: 9031)" },
    { flag: "--once", who: "serve", meaning: "Handle a single transfer, then exit" },
    { flag: "--no-resume", who: "all", meaning: "Disable resuming partial files" },
    { flag: "--config-dir <d>", who: "serve / push / id", meaning: "Identity + trust directory (default: ~/.config/relayium)" },
    { flag: "-i <file>", who: "push / pull", meaning: "SSH identity (key) file" },
    { flag: "-p <n>", who: "push / pull", meaning: "SSH port" },
    { flag: "--verify", who: "send / receive", meaning: "Require confirming the SAS code before transferring" },
  ];
</script>

<section class="cli">
  <header class="hero">
    <div class="logo" aria-hidden="true">❯</div>
    <h1>Relayium CLI</h1>
    <p class="sub">{t.cli.subtitle}</p>
    <ul class="badges">
      {#each badges as b (b)}<li>{b}</li>{/each}
    </ul>
    <p class="freenote">
      Your files travel <strong>directly</strong> between machines and never pass through Relayium's
      servers — only a small rendezvous handshake does, and only for <code>send</code>/<code>receive</code>.
    </p>
  </header>

  <!-- Install -->
  <div class="block">
    <h2>Install</h2>
    <p>One command downloads a prebuilt binary for your OS and puts it on your PATH:</p>
    <CommandBlock code={installCmd} title="install" />
    <p class="alt">
      Or grab a binary from the <a href={`${repo}/releases/latest`}>releases page</a>, or build from source:
    </p>
    <CommandBlock code={buildCmd} title="build from source" />
    <p class="alt">Then run <code>relayium --help</code> to see every command.</p>
  </div>

  <!-- Which mode -->
  <div class="block">
    <h2>Which mode?</h2>
    <p>Relayium moves files three ways. Pick by where the other end is:</p>
    <div class="pick">
      {#each pick as p (p.title)}
        <div class="pick-card">
          <span class="g" aria-hidden="true">{p.g}</span>
          <h3>{p.title}</h3>
          <p>{p.when}</p>
          <code>{p.cmd}</code>
        </div>
      {/each}
    </div>
  </div>

  <!-- Mode 1 -->
  <div class="mode">
    <div class="mode-head">
      <span class="g" aria-hidden="true">🔑</span>
      <h2>push / pull — over your own SSH</h2>
      <span class="tag free">free</span>
    </div>
    <p>
      Copy files to (or from) any machine you can already <code>ssh</code> into — a VPS, a home server, a
      workstation. Bytes travel over your SSH connection and <strong>never touch Relayium's servers</strong>;
      you need no account. If <code>relayium</code> is installed on the remote it uses the native protocol
      (per-file resume + SHA-256), otherwise it falls back to a plain <code>tar</code> stream.
    </p>
    <CommandBlock code={sshCmd} title="push / pull" />
  </div>

  <!-- Mode 2 -->
  <div class="mode">
    <div class="mode-head">
      <span class="g" aria-hidden="true">🔗</span>
      <h2>send / receive — by pairing code</h2>
      <span class="tag free">free · direct P2P</span>
    </div>
    <p>
      Send to another person across networks. Agree on a short <em>code</em> out of band (say it over a
      call — it's any short string), then one side sends and the other receives. The connection is
      <strong>direct peer-to-peer</strong>: only a small rendezvous handshake passes through Relayium to
      introduce the two ends — the file bytes never do. If both ends are behind strict NAT and can't
      connect directly, the transfer simply fails (the CLI has no relay). Both terminals print a 6-digit
      <strong>SAS</strong> code — compare them to rule out a man-in-the-middle (add <code>--verify</code>
      to require confirmation before any bytes move).
    </p>
    <CommandBlock code={codeCmd} title="send / receive" />
  </div>

  <!-- Mode 3 -->
  <div class="mode">
    <div class="mode-head">
      <span class="g" aria-hidden="true">🖧</span>
      <h2>daemon direct — server to server</h2>
      <span class="tag free">free</span>
    </div>
    <p>
      For two hosts you control that already know each other's address: one listens, the other pushes
      straight to it over pinned TLS 1.3. <strong>No relay, no SSH, no code</strong> — trust is
      public-key, set up once. Three steps:
    </p>
    <ol class="steps">
      <li>
        <strong>Listener:</strong> start <code>serve</code> and print this host's fingerprint with
        <code>relayium id</code>.
        <CommandBlock code={daemonListenCmd} title="listener" />
      </li>
      <li>
        <strong>Authorize the pusher:</strong> add the pusher's <code>relayium id</code> fingerprint to the
        listener's allow-list (an empty list rejects everyone).
        <CommandBlock code={daemonAuthCmd} title="listener · authorize" />
      </li>
      <li>
        <strong>Pusher:</strong> push to <code>relayium://host</code>. The listener's key is trusted on
        first use and pinned in <code>known_hosts</code>; a later fingerprint change is refused (not
        silently accepted).
        <CommandBlock code={daemonPushCmd} title="pusher" />
      </li>
    </ol>
  </div>

  <!-- Reference -->
  <div class="block">
    <h2>Reference</h2>

    <h3>Common flags</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Flag</th><th>Applies to</th><th>Meaning</th></tr></thead>
        <tbody>
          {#each flags as f (f.flag)}
            <tr><td><code>{f.flag}</code></td><td>{f.who}</td><td>{f.meaning}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>

    <h3>Trust &amp; identity files</h3>
    <p>
      Stored in <code>~/.config/relayium/</code> (override with <code>--config-dir</code>, e.g.
      <code>/etc/relayium</code> for a systemd service):
    </p>
    <ul class="files">
      <li><code>id.key</code> / <code>id.crt</code> — this host's persistent identity (auto-generated, key kept <code>0600</code>).</li>
      <li><code>known_hosts</code> — fingerprints of listeners you've pushed to (TOFU, pinned thereafter).</li>
      <li><code>authorized_fingerprints</code> — on a listener, the pushers allowed to connect.</li>
    </ul>

    <h3>Integrity &amp; resume</h3>
    <p>
      Every file is verified end-to-end with <strong>SHA-256</strong>, and an interrupted transfer
      <strong>resumes</strong> from where it stopped on the next run (disable with <code>--no-resume</code>).
    </p>
  </div>

  <footer>
    <a href={repo}>Source on GitHub ↗</a>
    <span class="dot" aria-hidden="true">·</span>
    <a href={`${repo}/releases/latest`}>Releases</a>
    <span class="dot" aria-hidden="true">·</span>
    <span class="muted">Prefer the browser? It's the home page.</span>
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

  /* Inline code + links */
  p code,
  li code,
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
