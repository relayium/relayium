<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  const t = $derived<Messages>(messages[lang()]);
  const repo = "https://github.com/relayium/relayium";
  const installCmd = "curl -fsSL https://relayium.com/install.sh | sh";
</script>

<section class="cli">
  <header>
    <h1>Relayium CLI</h1>
    <p class="sub">{t.cli.subtitle}</p>
  </header>

  <div class="block">
    <h2>Install</h2>
    <pre><code>{installCmd}</code></pre>
    <p class="alt">
      Or download a prebuilt binary from
      <a href={`${repo}/releases/latest`}>Releases</a>, or build from source:
    </p>
    <pre><code>{`git clone ${repo}.git
cd relayium/server
go build -o relayium ./cmd/relayium`}</code></pre>
  </div>

  <div class="block">
    <h2>push / pull — over your own SSH</h2>
    <p>Bytes travel over SSH to a host you already control. No Relayium account.</p>
    <pre><code>{`relayium push ./photos user@host:backups/
relayium pull user@host:backups/ ./restore`}</code></pre>
  </div>

  <div class="block">
    <h2>send / receive — by pairing code</h2>
    <p>Cross-network transfer between two people. Direct when reachable (free), metered relay as a fallback.</p>
    <pre><code>{`# sender
relayium send ./file.zip 123456
# receiver
relayium receive 123456 ./downloads`}</code></pre>
  </div>

  <div class="block">
    <h2>serve / push relayium:// — daemon direct</h2>
    <p>Two servers you control: one listens, the other pushes straight over pinned TLS. No relay, no SSH, no code.</p>
    <pre><code>{`# on the listener
relayium serve --dir ~/inbox
relayium id                 # prints this host's fingerprint

# authorize the pusher: add its \`relayium id\` output to
# ~/.config/relayium/authorized_fingerprints on the listener

# on the pusher
relayium push ./file.zip relayium://host.example.com`}</code></pre>
  </div>

  <footer><a href={repo}>Source on GitHub ↗</a></footer>
</section>

<style>
  .cli { max-width: 760px; margin: 0 auto; padding: var(--space-4) 0 var(--space-9); }
  header h1 { font-size: var(--fs-h2); color: var(--text-h); letter-spacing: -0.5px; }
  .sub { color: var(--text); margin-top: var(--space-1); }
  .block { margin-top: var(--space-7); }
  .block h2 { font-size: var(--fs-h3); color: var(--text-h); margin-bottom: var(--space-2); }
  .block p { color: var(--text); margin-bottom: var(--space-2); }
  .alt { font-size: var(--fs-sm); }
  pre {
    background: var(--social-bg); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: var(--space-3);
    overflow-x: auto; margin-bottom: var(--space-2);
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: var(--fs-sm); color: var(--text-h); white-space: pre;
  }
  footer { margin-top: var(--space-7); }
  a { color: var(--accent); }
</style>
