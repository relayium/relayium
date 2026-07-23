import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { lang, loadLang, setLang } from './lib/i18n.svelte'
import { initTheme } from './lib/theme.svelte'

// Re-assert the stored theme onto <html> (the inline head snippet usually did it).
initTheme()

// Load the detected language's table before the first render, so components never
// read an unloaded messages[current]. Kept as an async boot (not top-level await)
// so browsers predating TLA still reach App's own "unsupported" screen instead of
// white-screening at module load. Falls back to English if the chunk fails.
async function boot() {
  try {
    await loadLang(lang())
  } catch {
    await setLang('en').catch(() => {})
  }
  mount(App, { target: document.getElementById('app')! })
}

// Not exported: nothing imports main.ts, so an exported boot promise was only a
// promise nobody could await — and an unhandled rejection if mount ever threw.
// A failed mount now leaves a plain-text message instead of a blank white page.
boot().catch((err) => {
  console.error('relayium boot failed', err)
  const root = document.getElementById('app')
  if (root) {
    root.textContent = 'Relayium failed to start. Please reload the page.'
    root.setAttribute('style', 'padding:2rem;font:16px system-ui;text-align:center')
  }
})
