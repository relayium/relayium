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
  return mount(App, { target: document.getElementById('app')! })
}

export default boot()
