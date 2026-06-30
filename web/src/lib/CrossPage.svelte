<script lang="ts">
  import Account from "./Account.svelte";
  import CrossNetwork from "./CrossNetwork.svelte";
  import { session } from "./auth.svelte";
  import { lang, messages, legalUrl, type Messages } from "./i18n.svelte";

  let { roomToken = "", linkDead = false }:
    { roomToken?: string; linkDead?: boolean } = $props();

  const t = $derived<Messages>(messages[lang()]);
  // The login notice is only for someone trying to *start* a transfer:
  // a recipient (roomToken present) never needs to log in.
  const needsLogin = $derived(!session().user && !roomToken);

  let loginOpen = $state(false);
</script>

<section class="crosspage">
  <div class="acct"><Account bind:open={loginOpen} /></div>

  <header class="cn-head">
    <h1>{t.nav.crossTab}</h1>
    <p class="tagline">{t.tagline}</p>
  </header>

  {#if needsLogin}
    <section class="login-required">
      <p>{t.crossnet.loginRequired}</p>
      <button class="primary" onclick={() => (loginOpen = true)}>{t.account.signIn}</button>
    </section>
  {/if}

  <CrossNetwork {roomToken} />

  {#if linkDead}
    <p class="notice error">{t.crossnet.linkDead}</p>
  {/if}

  <footer>
    <nav class="legal">
      <a href={legalUrl("privacy", lang())}>{t.legal.privacy}</a>
      <a href={legalUrl("terms", lang())}>{t.legal.terms}</a>
      <a href="https://github.com/relayium/relayium" target="_blank" rel="noopener noreferrer">GitHub</a>
    </nav>
    <span class="fineprint">{t.footer}</span>
  </footer>
</section>

<style>
  .crosspage { position: relative; }
  .acct { display: flex; justify-content: flex-end; min-height: 32px; }

  .cn-head { text-align: center; padding: 12px 0 20px; }
  .cn-head h1 { font-size: 34px; margin: 0 0 8px; letter-spacing: -1px; }
  .cn-head .tagline { color: var(--text); font-size: 15px; max-width: 44ch; margin: 0 auto; }

  .login-required {
    display: flex; flex-direction: column; align-items: center; gap: 12px;
    text-align: center; margin: 0 auto 22px; max-width: 520px;
    padding: 18px; border-radius: 14px;
    color: var(--text-h); background: var(--accent-bg); border: 1px solid var(--accent-border);
  }
  .login-required p { margin: 0; font-size: 14.5px; }
  .login-required .primary {
    font: inherit; font-size: 15px; padding: 9px 22px; border-radius: 9px; cursor: pointer;
    background: var(--accent); border: 1px solid var(--accent); color: #fff;
  }
  .login-required .primary:hover { filter: brightness(1.08); }

  .notice.error {
    margin: 14px auto 0; max-width: 520px; text-align: center;
    padding: 12px 14px; border-radius: 10px;
    color: var(--text-h); background: var(--accent-bg); border: 1px solid var(--accent-border);
  }

  footer {
    margin-top: 32px; padding-top: 18px; border-top: 1px solid var(--border);
    display: flex; flex-direction: column; align-items: center; gap: 10px;
    font-size: 12.5px; color: var(--text); text-align: center;
  }
  footer .legal { display: flex; flex-wrap: wrap; gap: 16px; justify-content: center; }
  footer .legal a { color: var(--text-h); text-decoration: none; }
  footer .legal a:hover { color: var(--accent); }
  footer .fineprint { max-width: 60ch; }
</style>
