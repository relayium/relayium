import { describe, it, expect } from "vitest";
import { messages, LANGS } from "./i18n.svelte";

describe("i18n completeness", () => {
  it("every language has nav tab labels and the login-required string", () => {
    for (const { code } of LANGS) {
      const m = messages[code];
      expect(m.nav.lanTab, `${code}.nav.lanTab`).toBeTruthy();
      expect(m.nav.crossTab, `${code}.nav.crossTab`).toBeTruthy();
      expect(m.crossnet.loginRequired, `${code}.crossnet.loginRequired`).toBeTruthy();
    }
  });
});
