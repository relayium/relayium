// Which language the UI is in, and how a string gets its values.

import { CATALOGUES, en, type Lang, type MessageKey } from "./messages.js";

/**
 * The language, taken from the OS.
 *
 * There is no in-app language control, and that is parity rather than an
 * omission: `SettingsView.swift:28` says language is "deliberately absent (it
 * follows the system, by design)". A Windows client that added a picker would
 * be a different product decision, not a port.
 *
 * `navigator.language` is Chromium's read of the Windows display language.
 */
function detect(): Lang {
  const raw = (globalThis.navigator?.language ?? "en").toLowerCase();
  return raw.startsWith("zh") ? "zh" : "en";
}

let current = $state<Lang>(detect());

export const lang = (): Lang => current;

/**
 * Set the language directly.
 *
 * No UI calls this — the app follows the OS, per the note above. It exists so a
 * test can drive both catalogues without spawning a differently-configured
 * process, and so a future owner decision to add a picker has one place to
 * change rather than a global to hunt down.
 */
export function setLang(next: Lang): void {
  current = next;
  if (globalThis.document) globalThis.document.documentElement.lang = next === "zh" ? "zh-Hans" : "en";
}

/**
 * One string, with its placeholders filled.
 *
 * English is the fallback, and it is a real fallback rather than a key: a
 * missing translation shows readable English, never `pairYourCode`. The type
 * makes that unreachable for the two maintained languages, so this only ever
 * matters if a catalogue is loaded that the compiler did not check.
 */
export function t(key: MessageKey, values: Record<string, string | number> = {}): string {
  const catalogue = CATALOGUES[current] as Record<MessageKey, string>;
  const template = catalogue[key] ?? en[key];
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}
