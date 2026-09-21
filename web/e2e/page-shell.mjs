#!/usr/bin/env node
/**
 * 托管页壳契约 —— 真浏览器验收，只对 `vite preview`，不接真 Go 服务器。
 *
 *   cd web && npm run build && npm run test:e2e:page-shell
 *
 * 这四个场景以前都挂在 `lan-transfer.mjs`（2026-08-30 阶段四已删除）里，靠它的真
 * 服务器/真信令跑起来——但它们
 * 一个都不碰对端、信令或分块传输，测的是**页壳契约**：私密邮件落地页的头信息隔离、
 * `/apps` 的层级/对比度/焦点、`/pricing` 的层级/触摸几何、以及不安全上下文下的单列
 * 兜底布局。没有任何一个断言依赖真的 `/api/*` 响应内容：
 *
 *  - `authLandingScenario` 的三个组件在自己的 `onMount` 里都不发请求；唯一会打的
 *    网络请求是 `Nav.svelte` → `Account.svelte` 触发的匿名会话探测
 *    （`auth.svelte.ts` 的 `refreshSession()`），而它把非 2xx 都当成"未登录"处理，
 *    不抛异常。
 *  - `appsHierarchyScenario` 读的是 `AppsPage.svelte` 打包进产物的
 *    `native-releases.json`，不是运行时请求。
 *  - `pricingHierarchyScenario` 需要 `/api/plans` 解析成功卡片才会渲染，用
 *    `a11y-fixtures.mjs` 已经导出的 `PRICING_ROUTES`（和 `PricingPage.test.ts`
 *    同一份档位表）在页面自己的进程里同源应答，不新造一份夹具数据。
 *  - `unsupportedLayoutScenario` 的断言完全不碰任何 API 调用。
 *
 * 于是这条新增的 CI 步骤只需要 `vite preview`：既不用起 Go 服务器，也不用建
 * SQLite 数据库，是这个 job 里最便宜、最不容易抖的一条新增护栏。
 *
 * 只有一处不是从真服务器测出来的：`/api/plans` 现在量的是一份手工维护的夹具表，
 * 会和 `server/account/settings.go` 的真实档位定义漂移——但这个场景从来只验证
 * **几何**（第一档在折叠线以上、价格/标题字号、卡片顺序），不验证金额，所以这不是
 * 一次回归，只是这份夹具从今往后有了第二个抄写来源。
 *
 * 反悄悄丢场景：`main()` 不靠 `SCENARIOS.length` 自证——删掉数组里的一项会让
 * length 和跑过的数量一起缩水，那样"3/3"照样打印成功。下面按一个写死的
 * `EXPECTED_SCENARIO_COUNT` 校验，删掉一项就会真的报错。
 */
import { readFileSync } from "node:fs";
import { apiFixtureScript, AUTH_METHODS, FREE_USER_ROUTES, PRICING_ROUTES } from "./a11y-fixtures.mjs";
import {
  argFlag, fail, launchBrowser, newTab, ok, setWideViewport, startPreview, withWatchdog,
} from "./harness.mjs";

// 清理只认自己配置的那个调试端口，所以同端口的脚本绝不能并发：mixed-link 9445 /
// a11y+share-target 9446 / code-room+device-discovery+device-inbox 9447
//（都不并发，共用无妨）/ device-inbox-entry 9448。这一份是下一个空位。
// 9444 由已删除的 `lan-transfer.mjs` 用过，不回收。
const DEBUG_PORT = 9449;
const PREVIEW_PORT = Number(argFlag("--preview-port", "4186"));
const GLOBAL_TIMEOUT_MS = 5 * 60_000;

const FORCE_UNSUPPORTED =
  "Object.defineProperty(window, 'isSecureContext', { get: () => false });";

/**
 * 触摸目标地板：44 CSS px。这是**要求**，不是这里量出来的观察值——产品侧的出处是
 * `app.css` 的 `@media (pointer: coarse) { .btn { min-block-size: 44px } }`，
 * `/pricing` 的 `.toggle-btn` 和三张 auth 卡的 `.auth-action` 各自复制了同一个值。
 * 下面三处测量全都对着这一个常量比，不许再抄第二份字面量。
 */
const MIN_TOUCH_TARGET_PX = 44;

/**
 * 几何容差，唯一用途是吸收渲染器把一个 CSS 44px 报成 44 以下时那点浮点尾数。
 *
 * 为什么需要它：托管 Web 道次 33290357209（exact main `9d815c84`）红在 `/apps` 的
 * CTA 上——Linux Chromium 把一个 CSS 44px 的按钮量成了 43.999969482421875，比 44
 * 少 2⁻¹⁵ px ≈ 0.000031px。那不是一个矮下去的按钮，是 `getBoundingClientRect()`
 * 在合成路径上过了一趟 float32。同一份源码在 PR #95 的同一条道次上是绿的，所以裸
 * `< 44` 比的其实是"这台 runner 这一次的浮点尾数"，不是产品几何。
 *
 * 为什么是 1/1024，而不是"松一点算了"：这个界必须严到**不可能**掩盖一个真的矮下去
 * 的目标。Chromium 自己的布局量子是 LayoutUnit = 1/64 px，任何在布局层面真的没到
 * 44px 的元素至少亏这么多。1/1024 比观察到的那次偏差宽 32 倍（够吸收尾数），却比
 * 布局能表达的最小亏空还小 16 倍（接不住任何一个真的矮下去的按钮）。放宽到 1/64
 * 或更大就越过了这条论证，`apps-hierarchy-contract.test.mjs` 会因此判红。
 */
const TOUCH_TARGET_EPSILON_PX = 1 / 1024;

/**
 * 唯一一处触摸目标比较。非有限值算**不合格**而不是悄悄通过：空选择器会让
 * `Math.min(...[])` 返回 `Infinity`，而 `Infinity >= 44` 恰好为真——"一个都没量到"
 * 于是长得和"全都够大"一模一样。这里让它红。
 */
function undersizedTouchTarget(px) {
  return !Number.isFinite(px) || px < MIN_TOUCH_TARGET_PX - TOUCH_TARGET_EPSILON_PX;
}

/**
 * 不安全上下文（`isSecureContext === false`）下的"当前布局"契约：没有 WebRTC，
 * 页面必须掉进单列兜底，而不是留着 grid/two-col 的残影或悄悄漏出 `.peers`。
 */
async function unsupportedLayoutScenario(browser, base) {
  const tab = await newTab(browser, base + "/", FORCE_UNSUPPORTED);
  await setWideViewport(tab);
  await tab.waitFor("!!document.querySelector('.banner')", "the unsupported-browser banner");
  const layout = await tab.evaluate(`(() => {
    const workspace = document.querySelector('.lan-workspace');
    return {
      display: getComputedStyle(workspace).display,
      twoColClass: workspace.classList.contains('two-col'),
      compactHero: document.querySelector('.hero').classList.contains('workspace'),
      banner: !!document.querySelector('.lan-task .banner'),
      peers: !!document.querySelector('.lan-task .peers'),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  if (
    layout.display === "grid" || layout.twoColClass || layout.compactHero ||
    !layout.banner || layout.peers || layout.overflow !== 0
  ) {
    throw new Error(`unsupported LAN layout contract failed: ${JSON.stringify(layout)}`);
  }
  if (tab.errors.length) throw new Error(`unsupported LAN layout logged errors: ${tab.errors.join(" | ")}`);
  ok("unsupported browsers kept the established single-column failure layout");
  await browser.send("Target.closeTarget", { targetId: tab.targetId });
}

/** Private email landings share one trust surface, but keep independent auth
 * state machines. Fake tokens are never submitted here: the browser scenario
 * verifies presentation, URL scrubbing, private head metadata and responsive
 * geometry; component tests own the request/security transitions. */
async function authLandingScenario(browser, base) {
  const tab = await newTab(browser, base + "/magic-link?token=e2e-presentation-only");
  await setWideViewport(tab);
  await tab.waitFor("!!document.querySelector('.auth-card h1')", "magic-link trust surface");
  const magic = await tab.evaluate(`(() => ({
    path: location.pathname,
    search: location.search,
    title: document.title,
    h1: [...document.querySelectorAll('.auth-card h1')].map((el) => el.textContent.trim()),
    headingPx: parseFloat(getComputedStyle(document.querySelector('.auth-card h1')).fontSize),
    sharedCard: document.querySelector('.auth-card').classList.contains('ui-card'),
    canonical: document.querySelector('link[rel="canonical"]')?.href || null,
    alternates: document.querySelectorAll('link[rel="alternate"][hreflang]').length,
    robots: document.querySelector('meta[name="robots"]')?.content || '',
  }))()`);
  if (
    magic.path !== "/magic-link" || magic.search !== "" ||
    // 20px: the auth landings render inside the application shell now, whose
    // page-title token is 20px on every route (app.css `.appshell.shell`).
    JSON.stringify(magic.h1) !== JSON.stringify(["Sign in"]) || magic.headingPx !== 20 ||
    !magic.sharedCard || magic.canonical !== null || magic.alternates !== 0 ||
    magic.robots !== "noindex, nofollow"
  ) throw new Error(`magic-link landing contract failed: ${JSON.stringify(magic)}`);

  for (const [route, labels] of [
    ["verify-email", ["verify-password"]],
    ["reset-password", ["reset-new-password", "reset-confirm-password"]],
  ]) {
    await tab.evaluate(`location.href = ${JSON.stringify(`${base}/${route}?token=e2e-presentation-only`)}`);
    await tab.waitFor(`location.pathname === '/${route}' && !!document.querySelector('.auth-card h1')`, `${route} trust surface`);
    const state = await tab.evaluate(`(() => ({
      search: location.search,
      h1s: document.querySelectorAll('.auth-card h1').length,
      labelTargets: [...document.querySelectorAll('.ui-field > label')].map((el) => el.htmlFor),
      inputBorders: [...document.querySelectorAll('.ui-input')].map((el) => getComputedStyle(el).borderTopColor),
      neutralBorder: (() => { const p = document.createElement('span'); p.style.color = 'var(--control-border)'; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; })(),
      canonical: document.querySelector('link[rel="canonical"]')?.href || null,
      alternates: document.querySelectorAll('link[rel="alternate"][hreflang]').length,
    }))()`);
    if (
      state.search !== "" || state.h1s !== 1 ||
      JSON.stringify(state.labelTargets) !== JSON.stringify(labels) ||
      state.inputBorders.some((color) => color !== state.neutralBorder) ||
      state.canonical !== null || state.alternates !== 0
    ) throw new Error(`${route} landing contract failed: ${JSON.stringify(state)}`);
  }

  await tab.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await setWideViewport(tab, 320, 844);
  const locales = ["zh", "en"];
  const mobile = [];
  for (const code of locales) {
    await tab.evaluate(`(() => {
      const select = document.querySelector('select.lang');
      select.value = ${JSON.stringify(code)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await tab.waitFor(`document.documentElement.lang === ${JSON.stringify(code)}`, `${code} auth locale`);
    mobile.push(await tab.evaluate(`(() => {
      const card = document.querySelector('.auth-card').getBoundingClientRect();
      const action = document.querySelector('.auth-action').getBoundingClientRect();
      return {
        lang: document.documentElement.lang,
        dir: document.documentElement.dir,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        cardLeft: card.left,
        cardRight: card.right,
        actionHeight: action.height,
        h1s: document.querySelectorAll('.auth-card h1').length,
      };
    })()`));
  }
  const bad = mobile.filter((m) =>
    m.pageOverflow !== 0 || m.cardLeft < -.5 || m.cardRight > 320.5 ||
    undersizedTouchTarget(m.actionHeight) || m.h1s !== 1 || m.dir !== "ltr"
  );
  if (bad.length) throw new Error(`mobile auth landing contract failed: ${JSON.stringify(bad)}`);

  await tab.evaluate(`(() => {
    const select = document.querySelector('select.lang');
    select.value = 'en';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await tab.waitFor("document.documentElement.lang === 'en'", "English locale after auth sweep");
  await tab.evaluate("([...document.querySelectorAll('nav button, nav a')].find((element) => element.textContent.trim() === 'LAN'))?.click()");
  await tab.waitFor("location.pathname === '/'", "auth landing to return to LAN");
  const publicHead = await tab.evaluate(`(() => ({
    canonical: document.querySelector('link[rel="canonical"]')?.href || null,
    og: document.querySelector('meta[property="og:url"]')?.content || null,
    alternates: document.querySelectorAll('link[rel="alternate"][hreflang]').length,
    robots: document.querySelector('meta[name="robots"]')?.content || '',
  }))()`);
  if (
    publicHead.canonical !== `${base}/` || publicHead.og !== `${base}/` ||
    publicHead.alternates !== 3 || !publicHead.robots.startsWith("index, follow")
  ) throw new Error(`private-to-public head restoration failed: ${JSON.stringify(publicHead)}`);

  const errs = tab.errors.filter((e) => !/401|Failed to load resource/.test(e));
  if (errs.length) throw new Error(`auth landing pages logged errors:\n    ${errs.join("\n    ")}`);
  ok("auth landings stayed named, private, labelled and responsive in both maintained languages");
  await browser.send("Target.closeTarget", { targetId: tab.targetId });
}

const APPS_SOURCE = readFileSync(new URL("../src/lib/AppsPage.svelte", import.meta.url), "utf8");
const ROUTER_SOURCE = readFileSync(new URL("../src/lib/router.svelte.ts", import.meta.url), "utf8");
const NATIVE_RELEASES = JSON.parse(readFileSync(new URL("../native-releases.json", import.meta.url), "utf8"));
// The Android half has its own canonical manifest — the same document
// `gen-pages` publishes as the update feed and `AppsPage.svelte` imports — so
// this model reads the release state from the same place the page does rather
// than from a second copy that could disagree with it.
const ANDROID_RELEASE = JSON.parse(
  readFileSync(new URL("../android-release.json", import.meta.url), "utf8"),
).android;

/** A required capture out of a source file, or a loud failure saying it moved. */
function grab(source, re, what) {
  const hit = re.exec(source)?.[1];
  if (hit === undefined) {
    throw new Error(`apps card model: ${what} is no longer greppable — this derivation is stale, fix it before trusting the assertions below`);
  }
  return hit;
}

/**
 * Every `available:` expression AppsPage.svelte is allowed to use, resolved
 * against the source that actually decides it.
 *
 * Fail-closed on purpose. A fourth card introduced with a new expression stops
 * this scenario with a named error instead of being silently filed as a future
 * card — the failure mode that let three retired cards stay asserted for months.
 */
const AVAILABILITY = {
  // The cards the component makes executable unconditionally.
  true: () => true,
  // The half-filled-manifest guard, read the way the component reads it: the
  // flag alone is not enough, the download URL has to be there too.
  macAvailable: () =>
    NATIVE_RELEASES.macos.available === true && Boolean(NATIVE_RELEASES.macos.downloadUrl),
  // The same three-part guard the component applies, and for the same reason:
  // the card renders its version, so a manifest that says `available` without
  // saying WHICH version must not produce an executable card either.
  androidAvailable: () =>
    ANDROID_RELEASE.available === true &&
    Boolean(ANDROID_RELEASE.downloadUrl) &&
    Boolean(ANDROID_RELEASE.versionName),
};

/**
 * Where each executable card's CTA must point, from whoever owns the
 * destination: the router for the two in-app routes, the release manifest for
 * the download. Checked for completeness against the derived card list, so a
 * new card cannot reach the assertions with an unstated CTA.
 */
const CTA_TARGET = {
  web: grab(ROUTER_SOURCE, /export const LAN_PATH = "([^"]+)";/, "LAN_PATH"),
  cli: grab(ROUTER_SOURCE, /export const CLI_PATH = "([^"]+)";/, "CLI_PATH"),
  mac: NATIVE_RELEASES.macos.downloadUrl,
  android: ANDROID_RELEASE.downloadUrl,
};

/**
 * The /apps card model, derived from the two sources that own it.
 *
 * This scenario used to pin the answer instead: three available ids, three
 * future ids named ios/android/windows, and the structural counts 6 / 3 / 8.
 * All three future cards were removed on 2026-08-28 — `apps/` contains no
 * Android or Windows target and iOS is paused — and every one of those literals
 * became a second, wrong copy of a decision taken somewhere else. A browser test
 * that has to be hand-edited whenever a platform ships or stops shipping is not
 * testing the product, it is testing a memory of it.
 *
 * So read the model. AppsPage.svelte owns which cards exist and what makes each
 * one executable; native-releases.json owns whether the macOS release is real.
 * The id groups, the heading counts and the CTA hrefs below are all computed
 * from those two, which is why removing a card needs no edit here — and why
 * adding one that this derivation cannot explain fails loudly.
 */
function appsCardModel() {
  const declared = grab(APPS_SOURCE, /type AppId = ([^;]+);/, "the AppId union");
  const list = grab(APPS_SOURCE, /const cards = \$derived<AppCard\[\]>\(\[([\s\S]*?)\n {2}\]\);/, "the cards array");

  const ids = [...declared.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  const entries = [...list.matchAll(/id: "([a-z]+)",[\s\S]*?available: ([A-Za-z]+),/g)]
    .map(([, id, expr]) => ({ id, expr }));
  if (JSON.stringify(entries.map((e) => e.id)) !== JSON.stringify(ids)) {
    throw new Error(`apps card model: AppId ${JSON.stringify(ids)} does not match the cards array ${JSON.stringify(entries.map((e) => e.id))}`);
  }
  const unknown = entries.filter((e) => !(e.expr in AVAILABILITY));
  if (unknown.length) {
    throw new Error(`apps card model: unrecognised availability ${JSON.stringify(unknown)} — teach AVAILABILITY what it means rather than guessing`);
  }
  const available = entries.filter((e) => AVAILABILITY[e.expr]()).map((e) => e.id);
  const future = entries.filter((e) => !AVAILABILITY[e.expr]()).map((e) => e.id);

  // Only the EXECUTABLE cards need a CTA target. An in-development card has no
  // action by definition, and demanding a target for one would make this model
  // fail whenever a manifest is legitimately unpublished — the exact state the
  // page is designed to render honestly. Scoping it to `available` keeps the
  // guard (an executable card with no declared target is still an error) while
  // letting either manifest state through.
  const missingCta = available.filter((id) => !CTA_TARGET[id]);
  if (missingCta.length) {
    throw new Error(`apps card model: no CTA target declared for ${missingCta.join(", ")}`);
  }

  // The chooser's two columns are H3s as well, and they are part of the page's
  // heading structure whether or not a card is in development. Counted from the
  // component so a third column would be reflected, not tripped over.
  const chooserColumns = (APPS_SOURCE.match(/class="ui-card ui-stack choice"/g) ?? []).length;
  if (chooserColumns < 2) throw new Error("apps card model: the chooser columns are no longer greppable");
  // Three group titles in the source; the middle one is inside
  // `{#if futureCards.length}`, so whether it renders is a fact about the
  // manifest rather than a constant. Assert the shape the arithmetic assumes.
  const groupTitles = (APPS_SOURCE.match(/class="group-title"/g) ?? []).length;
  if (groupTitles !== 3 || !/\{#if futureCards\.length\}/.test(APPS_SOURCE)) {
    throw new Error(`apps card model: the group structure changed (${groupTitles} titles) — recheck the heading counts`);
  }

  return {
    available,
    future,
    cards: ids,
    h2: 2 + (future.length ? 1 : 0),
    h3: ids.length + chooserColumns,
  };
}

/**
 * /apps is a release surface, not a four-item wishlist. Executable choices must
 * stay ahead of future products, and a half-finished native release must not
 * leak a dead control. Exercise the real bundled manifest plus the responsive,
 * translated layout here; component tests cover the released/half-filled seams.
 */
async function appsHierarchyScenario(browser, base) {
  const model = appsCardModel();
  const tab = await newTab(browser, base + "/apps");
  await setWideViewport(tab);
  await tab.waitFor("!!document.querySelector('#app-web')", "apps hierarchy to render");

  const desktop = await tab.evaluate(`(() => {
    const contrast = (a, b) => {
      const lum = (value) => value.match(/[\\d.]+/g).slice(0, 3).map(Number).map((v) => {
        v /= 255;
        return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
      }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
      const x = lum(a), y = lum(b);
      return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
    };
    const cardMetrics = (selector) => [...document.querySelectorAll(selector)].map((card) => {
      const el = card.querySelector('.card-desc');
      const foreground = getComputedStyle(el).color;
      let parent = el, background = '';
      while (parent) {
        const candidate = getComputedStyle(parent).backgroundColor;
        if (candidate !== 'rgba(0, 0, 0, 0)' && candidate !== 'transparent') {
          background = candidate;
          break;
        }
        parent = parent.parentElement;
      }
      return { id: card.id, contrast: contrast(foreground, background), opacity: parseFloat(getComputedStyle(card).opacity) };
    });
    // Measured in BOTH themes, and on both groups. The available group is what
    // keeps this probe honest: the in-development group is empty whenever every
    // card ships, and a contrast check that only ever runs over an empty list
    // is a deleted contrast check that still prints a tick.
    const root = document.documentElement;
    const originalTheme = root.getAttribute('data-theme');
    root.dataset.theme = 'light';
    const lightFuture = cardMetrics('.future-card');
    const lightAvailable = cardMetrics('.available-grid .app-card');
    root.dataset.theme = 'dark';
    const darkFuture = cardMetrics('.future-card');
    const darkAvailable = cardMetrics('.available-grid .app-card');
    if (originalTheme === null) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', originalTheme);

    const resolveColor = (value) => {
      const probe = document.createElement('span');
      probe.style.color = value;
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    const platformCard = document.querySelector('.app-card.is-platform');
    return {
      headings: [...document.querySelectorAll('h1, h2, h3')].map((el) => el.tagName),
      available: [...document.querySelectorAll('.available-grid .app-card')].map((el) => el.id),
      future: [...document.querySelectorAll('.future-grid .app-card')].map((el) => el.id),
      actions: [...document.querySelectorAll('.available-grid .cta')].map((el) => el.getAttribute('href')),
      futureControls: document.querySelectorAll('.future-card a, .future-card button, .future-card [disabled]').length,
      sharedCards: document.querySelectorAll('.app-card.ui-card').length,
      lightFuture,
      darkFuture,
      lightAvailable,
      darkAvailable,
      platformMarker: {
        id: platformCard?.id,
        border: platformCard ? getComputedStyle(platformCard).borderTopColor : '',
        neutral: resolveColor('var(--control-border)'),
        accent: resolveColor('var(--accent-border)'),
      },
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  // Everything on the right-hand side comes from appsCardModel(), so the only
  // way to change what this asserts is to change the component or the manifest.
  const wantAvailable = model.available.map((id) => `app-${id}`);
  const wantFuture = model.future.map((id) => `app-${id}`);
  const wantActions = model.available.map((id) => CTA_TARGET[id]);
  if (
    JSON.stringify(desktop.available) !== JSON.stringify(wantAvailable) ||
    JSON.stringify(desktop.future) !== JSON.stringify(wantFuture) ||
    desktop.headings.filter((tag) => tag === "H1").length !== 1 ||
    desktop.headings.filter((tag) => tag === "H2").length !== model.h2 ||
    desktop.headings.filter((tag) => tag === "H3").length !== model.h3 ||
    JSON.stringify(desktop.actions) !== JSON.stringify(wantActions) ||
    desktop.futureControls !== 0 ||
    desktop.sharedCards !== model.cards.length ||
    !desktop.platformMarker.id || desktop.platformMarker.border !== desktop.platformMarker.neutral ||
    desktop.platformMarker.border === desktop.platformMarker.accent ||
    desktop.pageOverflow !== 0
  ) {
    throw new Error(`desktop apps hierarchy contract failed against ${JSON.stringify(model)}: ${JSON.stringify(desktop)}`);
  }

  // ── card contrast, and an explicit account of what it did NOT cover ────────
  //
  // The in-development group is empty whenever every declared card ships, which
  // is true today. Deleting the check in that state would be invisible, so it
  // is not deleted: the same probe runs over the AVAILABLE cards, which are
  // never empty, and the future group's coverage is stated in the output rather
  // than assumed. `metrics` therefore always has something in it.
  const metrics = [
    ["available", model.available, desktop.lightAvailable, desktop.darkAvailable],
    ["in-development", model.future, desktop.lightFuture, desktop.darkFuture],
  ];
  for (const [group, want, light, dark] of metrics) {
    if (light?.length !== want.length || dark?.length !== want.length) {
      throw new Error(`apps ${group} contrast probe measured ${light?.length}/${dark?.length} cards, model says ${want.length}: ${JSON.stringify(desktop)}`);
    }
    const failing = [...light, ...dark].filter((m) => m.contrast < 4.5 || m.opacity !== 1);
    if (failing.length) {
      throw new Error(`apps ${group} card contrast/opacity contract failed: ${JSON.stringify(failing)}`);
    }
  }
  if (!desktop.lightAvailable.length) {
    throw new Error("apps contrast probe measured nothing at all — the check is no longer running");
  }
  // The disclosure, pinned rather than merely printed: a run that reports
  // neither branch, or reports the wrong one for the model it derived, fails
  // here instead of quietly reducing coverage.
  const futureCoverage = model.future.length
    ? `in-development card contrast/opacity EXERCISED on ${model.future.length} card(s): ${wantFuture.join(", ")}`
    : "in-development card contrast/opacity NOT EXERCISED: the release model declares no in-development card";
  if (futureCoverage.includes("NOT EXERCISED") !== (desktop.lightFuture.length === 0)) {
    throw new Error(`apps future-coverage disclosure disagrees with what the browser measured (${desktop.lightFuture.length} card(s)): ${futureCoverage}`);
  }
  ok(`apps card contrast measured in light and dark on ${desktop.lightAvailable.length} available card(s)`);
  ok(futureCoverage);

  await tab.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await setWideViewport(tab, 390, 844);
  const locales = ["zh", "en"];
  const mobile = [];
  for (const code of locales) {
    await tab.evaluate(`(() => {
      const select = document.querySelector('select.lang');
      select.value = ${JSON.stringify(code)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await tab.waitFor(`document.documentElement.lang === ${JSON.stringify(code)}`, `${code} apps locale`);
    mobile.push(await tab.evaluate(`(() => {
      const cmd = document.querySelector('.cmd');
      const cmdRect = cmd.getBoundingClientRect();
      const codeRect = cmd.querySelector('code').getBoundingClientRect();
      const elements = [...document.querySelectorAll('.app-card, .cta, .cmd')];
      return {
        lang: document.documentElement.lang,
        dir: document.documentElement.dir,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        elementOverflow: elements.some((el) => {
          const rect = el.getBoundingClientRect();
          return rect.left < -.5 || rect.right > innerWidth + .5;
        }),
        minAction: Math.min(...[...document.querySelectorAll('.cta')].map((el) => el.getBoundingClientRect().height)),
        futureControls: document.querySelectorAll('.future-card a, .future-card button, .future-card [disabled]').length,
        command: {
          dir: cmd.dir,
          tabIndex: cmd.tabIndex,
          scrollLeft: cmd.scrollLeft,
          codeStartsAt: codeRect.left - cmdRect.left,
        },
      };
    })()`));
  }
  const bad = mobile.filter((m) =>
    m.pageOverflow !== 0 || m.elementOverflow || undersizedTouchTarget(m.minAction) || m.futureControls !== 0 ||
    m.command.dir !== "ltr" || m.command.tabIndex !== 0 || m.command.scrollLeft !== 0 || m.command.codeStartsAt < 0 ||
    m.dir !== "ltr"
  );
  if (bad.length) throw new Error(`mobile apps hierarchy contract failed: ${JSON.stringify(bad)}`);

  // Put keyboard focus on the preceding Web CTA, then reach the command with a
  // real Tab key event. This catches invalid focus-token declarations that a
  // programmatic .focus() does not expose through :focus-visible.
  await tab.evaluate("document.querySelector('#app-web .cta').focus()");
  await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  const keyboard = await tab.evaluate(`(() => {
    const cmd = document.querySelector('.cmd');
    const style = getComputedStyle(cmd);
    return { active: document.activeElement === cmd, outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  })()`);
  if (!keyboard.active || keyboard.outlineStyle !== "solid" || parseFloat(keyboard.outlineWidth) < 2) {
    throw new Error(`apps command keyboard focus contract failed: ${JSON.stringify(keyboard)}`);
  }

  await tab.evaluate(`(() => {
    const select = document.querySelector('select.lang');
    select.value = 'en';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await tab.waitFor("document.documentElement.lang === 'en'", "English locale after the apps sweep");

  const errs = tab.errors.filter((e) => !/401|Failed to load resource/.test(e));
  if (errs.length) throw new Error(`apps page logged errors:\n    ${errs.join("\n    ")}`);
  ok(`apps rendered exactly the ${model.available.length} executable and ${model.future.length} in-development card(s) the release model declares, in both maintained languages`);
  await browser.send("Target.closeTarget", { targetId: tab.targetId });
}

/**
 * 定价页是购买入口：真正的方案必须先于长解释出现，而且这个层级要在中英文下
 * 都成立。`/api/plans` 由这份进程内夹具同源应答（真实档位表的另一份手工抄写，
 * 见文件头注释），所以这里不需要真的 Go 服务器就能量到真实渲染出的卡片。
 */
async function pricingHierarchyScenario(browser, base) {
  const tab = await newTab(browser, base + "/pricing", apiFixtureScript(PRICING_ROUTES));
  await setWideViewport(tab);
  await tab.waitFor("!!document.querySelector('.tier:not(.tier-skeleton)')", "pricing tiers to load");

  const desktop = await tab.evaluate(`(() => {
    const first = document.querySelector('.tier').getBoundingClientRect();
    const price = getComputedStyle(document.querySelector('.tier-price:has(bdi)'));
    const title = getComputedStyle(document.querySelector('.head h1'));
    return {
      firstTierY: first.top + scrollY,
      pricePx: parseFloat(price.fontSize),
      titlePx: parseFloat(title.fontSize),
      pricingBeforeExplainer:
        !!(document.querySelector('.pricing').compareDocumentPosition(document.querySelector('.explainer')) & Node.DOCUMENT_POSITION_FOLLOWING),
      accountControl: !!document.querySelector('.account'),
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  // 20px title / 24px price: /pricing renders inside the application shell,
  // whose page-title token is 20px on every route; the tier price keeps its own
  // 24px so it stays the largest figure on the page after the title.
  if (
    desktop.firstTierY >= 700 || desktop.pricePx !== 24 || desktop.titlePx !== 20 ||
    !desktop.pricingBeforeExplainer || !desktop.accountControl || desktop.pageOverflow !== 0
  ) {
    throw new Error(`desktop pricing hierarchy contract failed: ${JSON.stringify(desktop)}`);
  }

  await tab.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await setWideViewport(tab, 390, 844);
  const locales = ["zh", "en"];
  const mobile = [];
  for (const code of locales) {
    await tab.evaluate(`(() => {
      const select = document.querySelector('select.lang');
      select.value = ${JSON.stringify(code)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await tab.waitFor(`document.documentElement.lang === ${JSON.stringify(code)}`, `${code} pricing locale`);
    mobile.push(await tab.evaluate(`(() => {
      const first = document.querySelector('.tier').getBoundingClientRect();
      return {
        lang: document.documentElement.lang,
        dir: document.documentElement.dir,
        firstTierY: first.top + scrollY,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        cardOverflows: [...document.querySelectorAll('.tier')].map((el) => el.scrollWidth - el.clientWidth),
        controlOverflows: [...document.querySelectorAll('.toggle-btn, .tier .btn')].map((el) => el.scrollWidth - el.clientWidth),
        cycleTargets: [...document.querySelectorAll('.toggle-btn')].map((el) => el.getBoundingClientRect().height),
        priceIsolates: [...document.querySelectorAll('.tier-price bdi')].map((el) => el.getAttribute('dir')),
      };
    })()`));
  }
  // `cycleTargets` 以前是 `Math.round(height)`，那等于一条 ±0.5px 的隐形容差——
  // 比这里真正需要的浮点尾数宽了五百倍，足以放过一个 43.5px 的按钮。现在量原始
  // 高度，走和另外两处同一个 `undersizedTouchTarget`。空数组单独拦：`.some()` 在
  // 空数组上恒为 false，"一个挡位都没量到"不许长得像"挡位都够大"。
  const bad = mobile.filter((m) =>
    m.firstTierY >= 1000 || m.pageOverflow !== 0 ||
    m.cardOverflows.some((n) => n > 1) || m.controlOverflows.some((n) => n > 1) ||
    !m.cycleTargets.length || m.cycleTargets.some(undersizedTouchTarget) ||
    m.priceIsolates.some((dir) => dir !== "ltr") ||
    m.dir !== "ltr"
  );
  if (bad.length) throw new Error(`mobile pricing hierarchy contract failed: ${JSON.stringify(bad)}`);

  // Locale is persisted in localStorage and therefore shared by every later tab
  // in this Chrome profile. Restore the suite's English baseline before closing
  // the pricing tab, matching the other scenarios' own end-of-scenario reset.
  await tab.evaluate(`(() => {
    const select = document.querySelector('select.lang');
    select.value = 'en';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await tab.waitFor("document.documentElement.lang === 'en'", "English locale after the pricing sweep");

  const errs = tab.errors.filter((e) => !/401|Failed to load resource/.test(e));
  if (errs.length) throw new Error(`pricing page logged errors:\n    ${errs.join("\n    ")}`);
  ok("pricing exposed real tiers early in both maintained languages with honest touch targets");
  await browser.send("Target.closeTarget", { targetId: tab.targetId });
}

/**
 * /cli on a phone. This one is here because it is the ONLY place the defect is
 * observable: `.cli` sets `overflow-x: clip`, so a document-level
 * `scrollWidth - clientWidth` — the check every other scenario above uses —
 * reads 0 on a page whose install band is 95px wider than the viewport. The
 * reader still cannot see the right-hand side of it; the clip just removed the
 * scrollbar that would have said so.
 *
 * So this scenario measures the BOXES, not the document: `.cli` and the four
 * grid/flow descendants under it that a wide command block used to stretch.
 * `document.documentElement` is measured too, but as a floor rather than the
 * whole claim.
 *
 * The two positive halves matter as much as the overflow bound, because both
 * are ways of "fixing" this that make the page worse:
 *
 *  - every command `<pre>` must still be a real horizontal scroll container
 *    (`scrollWidth > clientWidth` on at least one of them, and scrollable to a
 *    non-zero offset). Wrapping a shell command instead is a command the reader
 *    cannot retype.
 *  - every terminal title must be fully laid out (`scrollWidth <= clientWidth`)
 *    and every copy button must still clear the 44px touch floor. Ellipsising
 *    the title or shrinking the button would satisfy an overflow-only check.
 */
async function cliMobileScenario(browser, base) {
  const tab = await newTab(browser, base + "/cli");
  await tab.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await setWideViewport(tab, 390, 844);
  await tab.waitFor("!!document.querySelector('.cli .term pre')", "the CLI page's command blocks");

  // The containers the install band used to stretch, plus `.cli` itself. Named
  // rather than derived: a selector that stopped matching would otherwise
  // silently reduce this to "the document did not overflow", which is exactly
  // the check that could not see the bug.
  const CONTAINERS = [".cli", ".layout", ".body", ".install", ".platforms"];
  const locales = ["zh", "en"];
  const measured = [];
  for (const code of locales) {
    await tab.evaluate(`(() => {
      const select = document.querySelector('select.lang');
      select.value = ${JSON.stringify(code)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await tab.waitFor(`document.documentElement.lang === ${JSON.stringify(code)}`, `${code} CLI locale`);
    // Prove a <pre> really scrolls rather than merely reporting a wide
    // scrollWidth: a `white-space: pre` box inside a clipped ancestor reports
    // the same numbers and cannot be read.
    await tab.evaluate(`(() => {
      const pre = [...document.querySelectorAll('.cli .term pre')].find((p) => p.scrollWidth > p.clientWidth);
      if (pre) pre.scrollLeft = 9999;
      return true;
    })()`);
    measured.push(await tab.evaluate(`(() => {
      const boxes = ${JSON.stringify(CONTAINERS)}.map((sel) => {
        const el = document.querySelector(sel);
        return el
          ? { sel, overflow: el.scrollWidth - el.clientWidth, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }
          : { sel, missing: true };
      });
      const pres = [...document.querySelectorAll('.cli .term pre')];
      const scrolled = pres.filter((p) => p.scrollLeft > 0).length;
      return {
        lang: document.documentElement.lang,
        dir: document.documentElement.dir,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        boxes,
        preCount: pres.length,
        widePres: pres.filter((p) => p.scrollWidth > p.clientWidth).length,
        scrolledPres: scrolled,
        titleOverflows: [...document.querySelectorAll('.cli .term .title')]
          .map((el) => ({ text: el.textContent.trim(), over: el.scrollWidth - el.clientWidth }))
          .filter((t) => t.over > 1),
        copyHeights: [...document.querySelectorAll('.cli .term .copy')].map((el) => el.getBoundingClientRect().height),
        copyWidths: [...document.querySelectorAll('.cli .term .copy')].map((el) => el.getBoundingClientRect().width),
        // .term sets overflow:hidden to round its corners, so a title bar that
        // no longer fits would be silently cut off instead of reported by any
        // of the bounds above. Measured directly, it cannot be.
        barOverflows: [...document.querySelectorAll('.cli .term .bar')]
          .map((el) => el.scrollWidth - el.clientWidth).filter((n) => n > 1),
      };
    })()`));
  }

  const bad = measured.filter((m) =>
    m.pageOverflow !== 0 || m.dir !== "ltr" ||
    m.boxes.some((b) => b.missing || b.overflow > 1) ||
    // Vacuity guards: no command blocks, or none of them scrollable, would
    // satisfy every bound above by rendering nothing worth measuring.
    m.preCount === 0 || m.widePres === 0 || m.scrolledPres === 0 ||
    m.titleOverflows.length !== 0 || m.barOverflows.length !== 0 ||
    !m.copyHeights.length || m.copyHeights.some(undersizedTouchTarget) ||
    m.copyWidths.some(undersizedTouchTarget)
  );
  if (bad.length) throw new Error(`mobile CLI layout contract failed: ${JSON.stringify(bad)}`);

  await tab.evaluate(`(() => {
    const select = document.querySelector('select.lang');
    select.value = 'en';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await tab.waitFor("document.documentElement.lang === 'en'", "English locale after the CLI sweep");

  const errs = tab.errors.filter((e) => !/401|Failed to load resource/.test(e));
  if (errs.length) throw new Error(`CLI page logged errors:\n    ${errs.join("\n    ")}`);
  ok(`CLI page fitted a 390px viewport in both maintained languages with ${measured[0].widePres} scrollable command block(s) and honest copy targets`);
  await browser.send("Target.closeTarget", { targetId: tab.targetId });
}

/**
 * 两个真实浏览器回归，对应 rework 里两个只有排版引擎能回答的缺陷。
 *
 * **一、关了 More 之后，页面自己的「登录」必须开出一个看得见的对话框。**
 * Account 曾被放进 `<details class="more">`。DOM 里节点是在的，`querySelector`
 * 找得到，组件也没有被卸载——可是收起的 `<details>` 会隐藏除 `<summary>` 以外的
 * 整棵子树，`position: fixed` 也逃不出去。于是 /cross-network 上点「登录」得到
 * dialogCount 1 / dialogVisible false：一个存在但没人看得见的登录框。
 * 所以这里只认 `getBoundingClientRect()` 和 `checkVisibility()`，不认节点计数——
 * 节点计数正是当初判绿的那种断言。焦点也要真的落在对话框里面，关闭按钮要真的
 * 关得掉。
 *
 * **二、320px 下四个主目的地必须全部可见。**
 * 之前是一条会横向滚动的单行，More 按钮把第四个目的地挤出了右边缘；
 * `document.scrollWidth === clientWidth` 依然成立——文档没有溢出，被裁掉的是
 * rail 内部的一个 chip。所以这里逐个量四个 `a.tab` 的矩形，要求它们都完整落在
 * 视口内且高度够手指点，而不是去数有几个 `<a>`。
 *
 * 夹具全部在页面进程内（apiFixtureScript），不碰真账号、不发写请求：
 * `/api/auth/methods` 让弹窗渲染出密码表单，`/api/me` 不提供，于是走登出分支。
 */
const LOGIN_ROUTES = { "/api/auth/methods": AUTH_METHODS };

/** 三条登录门控路由各自「页面上的那个登录入口」。 */
const SIGN_IN_TARGETS = [
  { path: "/cross-network", container: ".crosspage", button: ".crosspage .signin button.btn-primary" },
  { path: "/offline-transfer", container: ".offlinepage", button: ".offlinepage .signin button.btn-primary" },
  { path: "/device-inbox", container: ".dinbox", button: '.dinbox [data-di="sign-in"]' },
];

/**
 * The offline page's "compare" link, end to end in a real engine.
 *
 * The comparison table exists ONCE, on the cross-network page
 * (`ModeCompare.svelte`, `<section id="compare">`). The offline page links to it
 * (`OfflinePage.svelte` `goCompare` → `navigate("cross", "#compare")`), the
 * router writes path and fragment in ONE history entry when the navigation
 * commits, and `CrossPage.svelte` reads `location.hash` as it mounts: it opens
 * the disclosure that holds the table (signed in) and scrolls the table to the
 * top of the viewport. Unit and component tests own each of those three pieces;
 * what none of them can answer is whether the pieces MEET — whether the hash is
 * already on the URL when the lazily imported page mounts, whether
 * `scrollIntoView` inside a `<details>` that opened in the same tick moves a
 * real viewport, and whether Back returns to an offline URL with no fragment
 * left on it. Those are layout-engine and session-history questions.
 *
 * Both session states run, because they are different DOMs and not a matrix for
 * its own sake: signed out, the link and the table both sit directly on their
 * pages; signed in, BOTH are inside a folded `Help` disclosure — the reader has
 * to open one to find the link, and the landing has to open the other for them.
 * The signed-in session is `a11y-fixtures.mjs`'s existing `FREE_USER_ROUTES`,
 * answered in the page's own process like every other fixture in this file.
 *
 * **What this does NOT cover: the deferred path** — the recorded defect that
 * d0155fc6 fixed, where the navigation guard answers with a promise (a confirm
 * dialog) and the fragment has to survive until the reader confirms. The guard
 * only defers while `App.svelte`'s `busy` is true, i.e. while
 * `workspace.warnsOnLeave` (a live peer link / transfer / message session) or
 * `storedReceiver.active()` holds. Both are driven by a peer that has paired
 * through a real signalling server; this runner talks to `vite preview` and
 * nothing else, by design (see the file header), and the product exposes no
 * hook that would let a page fake `busy`. Reverting d0155fc6 leaves every
 * assertion below green — that was measured, not assumed — so the deferred
 * path's proof remains `router.test.ts` and `OfflinePage.test.ts`.
 *
 * It is a case inside `shellLoginNavScenario` rather than a seventh entry in
 * `SCENARIOS` because the inventory is pinned by `page-shell-contract.test.mjs`
 * and both pages are that scenario's own login-gated targets: the two paths and
 * the two page containers are read from `SIGN_IN_TARGETS`, not retyped.
 */
const COMPARE_FRAGMENT = "#compare";

/**
 * How far ABOVE the viewport's top edge the table's section may rest and still
 * count as landed: not at all, bar a pixel of sub-pixel rounding.
 * `scrollIntoView({ block: "start" })` runs while the route's `.page-enter`
 * entrance animation (`app.css` `fade-up`) is still displacing the page, so
 * without help the section aligns to the top edge and then settles ABOVE it —
 * measured at −13.9px signed out and −19.6px / −20.5px signed in — clipping the
 * table's heading. `ModeCompare.svelte` gives the section a `scroll-margin-top`
 * for exactly that reason, and this bound is what notices if it goes missing.
 * The other bound has no slack either: a landing that did not scroll at all
 * leaves the section more than a full viewport BELOW the top edge.
 */
const COMPARE_LANDING_SLACK_PX = 1;

async function offlineCompareLinkCase(browser, base) {
  const offline = SIGN_IN_TARGETS.find((target) => target.container === ".offlinepage");
  const cross = SIGN_IN_TARGETS.find((target) => target.container === ".crosspage");
  if (!offline || !cross) throw new Error("compare link: SIGN_IN_TARGETS no longer names the offline and cross-network pages");
  const landingUrl = cross.path + COMPARE_FRAGMENT;
  const linkSelector = `${offline.container} .compare-link a`;

  // One expression for "where did the reader end up", used for the click's
  // landing and again for Forward, so the two cannot drift apart.
  const landingProbe = `(() => {
    const target = document.getElementById('compare');
    const grid = target ? target.querySelector('[role="table"]') : null;
    const fold = target ? target.closest('details') : null;
    const rect = target ? target.getBoundingClientRect() : null;
    return {
      url: location.pathname + location.search + location.hash,
      crossPage: !!document.querySelector(${JSON.stringify(cross.container)}),
      offlinePage: !!document.querySelector(${JSON.stringify(offline.container)}),
      targets: document.querySelectorAll('[id="compare"]').length,
      rows: grid ? grid.querySelectorAll('[role="row"]').length : 0,
      visible: !!target && (typeof target.checkVisibility === 'function' ? target.checkVisibility() : true),
      folded: !!fold,
      foldOpen: fold ? fold.open : null,
      top: rect ? rect.top : null,
      height: rect ? rect.height : null,
      gridTop: grid ? grid.getBoundingClientRect().top : null,
      viewport: innerHeight,
      scrollY,
      // Where the section's top edge would be had nothing scrolled.
      unscrolledTop: rect ? rect.top + scrollY : null,
      sameDocument: window.__compareLinkSameDocument === true,
      historyLength: history.length,
    };
  })()`;
  const landed = `(() => {
    const target = document.getElementById('compare');
    if (location.pathname + location.hash !== ${JSON.stringify(landingUrl)} || !target) return false;
    // Measured only once the page's entrance animation has finished. The scroll
    // happens while .page-enter is still translating the page, so a reading
    // (no backticks in this comment: it lives inside a template literal)
    // taken any earlier sees the section exactly at the top edge and cannot tell
    // a landing that then settles above it from one that stays put.
    const entering = document.querySelector('.page-enter');
    if (!entering || entering.getAnimations().some((a) => a.playState !== 'finished')) return false;
    const top = target.getBoundingClientRect().top;
    return top > -${COMPARE_LANDING_SLACK_PX} && top < innerHeight;
  })()`;
  const landingFaults = (at, { signedIn, historyLength }) => {
    const faults = [];
    if (at.url !== landingUrl) faults.push(`URL is ${at.url}, expected exactly ${landingUrl}`);
    if (!at.crossPage) faults.push("the cross-network page is not rendered");
    if (at.offlinePage) faults.push("the offline page is still rendered");
    if (at.targets !== 1) faults.push(`${at.targets} elements carry id="compare"`);
    // Header row plus at least one real row: an empty grid is not a comparison.
    if (at.rows < 2) faults.push(`the comparison grid has ${at.rows} row(s)`);
    if (!at.visible) faults.push("checkVisibility() false — the table is inside something closed or hidden");
    // A hidden box that an engine collapses to 0×0 at y=0 would satisfy every
    // position bound below. (This Chromium keeps a closed <details>' geometry —
    // measured: full height, never scrolled to — so here it is a belt to
    // checkVisibility()'s braces, not the check that fires.)
    if (!(at.height > 0)) faults.push("the table's section has a zero-sized box");
    if (at.folded && !at.foldOpen) faults.push("the disclosure holding the table is closed");
    // Vacuity guards, both directions: the signed-in cell exists to exercise the
    // disclosure, and the signed-out cell to exercise the page without one.
    if (signedIn && !at.folded) faults.push("signed in, but the table is not inside a disclosure — this cell no longer tests the fold");
    if (!signedIn && at.folded) faults.push("signed out, but the table is inside a disclosure — this cell no longer tests the unfolded page");
    if (!(at.top > -COMPARE_LANDING_SLACK_PX && at.top < at.viewport)) {
      faults.push(`the table's section rests at y=${at.top} in a ${at.viewport}px viewport`);
    }
    if (!(at.gridTop >= 0 && at.gridTop < at.viewport)) {
      faults.push(`the comparison grid starts at y=${at.gridTop}, outside the ${at.viewport}px viewport`);
    }
    // "In view" only means "was scrolled to" if it would NOT have been in view
    // anyway. Should the page ever get short enough for the table to sit above
    // the fold unscrolled, this cell needs a shorter viewport, not a free pass.
    if (!(at.unscrolledTop > at.viewport)) {
      faults.push(`the table sits at y=${at.unscrolledTop} unscrolled, inside the ${at.viewport}px viewport — the scroll assertion is vacuous here`);
    }
    if (!(at.scrollY > 0)) faults.push("the document did not scroll");
    // The link's href is the same URL, so a link that lost its in-app handler
    // reaches the same place, table open and in view, by LOADING A NEW DOCUMENT
    // — every bound above holds and the app's state is gone. (Dropping only the
    // handler's preventDefault() is not observable, here or to a reader: the
    // router has already pushed this exact URL, so the default action is a
    // same-URL fragment navigation that neither reloads nor adds an entry.)
    if (!at.sameDocument) faults.push("the document was reloaded — this was not an in-app navigation");
    if (at.historyLength !== historyLength) faults.push(`history.length is ${at.historyLength}, expected ${historyLength}`);
    return faults;
  };

  const cells = [];
  for (const signedIn of [false, true]) {
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      const cell = `${signedIn ? "signed-in" : "signed-out"}/${width}`;
      const tab = await newTab(
        browser,
        base + offline.path,
        `try { localStorage.setItem("relayium-lang", "en"); } catch {}\n`
          + apiFixtureScript(signedIn ? FREE_USER_ROUTES : LOGIN_ROUTES),
      );
      await setWideViewport(tab, width, height);
      // The session decides which branch renders, and a signed-in page paints
      // the signed-out branch first while `/api/me` is in flight — so wait for
      // the branch this cell is about, not merely for a link.
      await tab.waitFor(
        signedIn
          ? `!!document.querySelector('${offline.container} .learn details .compare-link a')`
          : `!!document.querySelector('${offline.button}') && !!document.querySelector('${linkSelector}')`,
        `${cell}: the offline page's compare link`,
      );

      const before = await tab.evaluate(`(() => {
        const links = [...document.querySelectorAll('${linkSelector}')];
        const fold = links[0].closest('details');
        return {
          url: location.pathname + location.search + location.hash,
          links: links.length,
          href: links[0].getAttribute('href'),
          folded: !!fold,
          foldOpen: fold ? fold.open : null,
          visible: links[0].checkVisibility(),
          historyLength: history.length,
        };
      })()`);
      if (
        before.url !== offline.path || before.links !== 1 || before.href !== landingUrl ||
        before.folded !== signedIn || (signedIn && (before.foldOpen || before.visible)) ||
        (!signedIn && !before.visible)
      ) throw new Error(`${cell}: offline page did not start in the expected state: ${JSON.stringify(before)}`);

      if (signedIn) {
        // A reader cannot click a link inside a closed disclosure. Open it the
        // way they would, and require the link to actually become visible.
        await tab.evaluate(`(() => { document.querySelector('${linkSelector}').closest('details').querySelector('summary').click(); return true; })()`);
        await tab.waitFor(`document.querySelector('${linkSelector}').checkVisibility()`, `${cell}: the compare link to become visible`, 5000);
      }

      await tab.evaluate(`(() => {
        window.__compareLinkSameDocument = true;
        document.querySelector('${linkSelector}').click();
        return true;
      })()`);
      // No bare sleep: the URL changes synchronously, the page chunk, the
      // disclosure and the scroll follow it. On timeout, say what was there.
      try {
        await tab.waitFor(landed, `${cell}: the comparison table to land in view`, 10_000);
      } catch (err) {
        throw new Error(`${err.message} — ${JSON.stringify(await tab.evaluate(landingProbe))}`);
      }
      const at = await tab.evaluate(landingProbe);
      const expected = { signedIn, historyLength: before.historyLength + 1 };
      const faults = landingFaults(at, expected);
      if (faults.length) throw new Error(`${cell}: compare link landing — ${faults.join("; ")} — ${JSON.stringify(at)}`);

      // Back: the offline page again, and its URL carries no fragment. One
      // history entry took the reader there, so one Back brings them home.
      await tab.evaluate("(() => { history.back(); return true; })()");
      await tab.waitFor(
        `location.pathname === ${JSON.stringify(offline.path)} && !!document.querySelector('${linkSelector}')`
          + ` && !document.querySelector('${cross.container}')`,
        `${cell}: Back to return to the offline page`,
        10_000,
      );
      const back = await tab.evaluate(`({
        url: location.pathname + location.search + location.hash,
        sameDocument: window.__compareLinkSameDocument === true,
        table: !!document.getElementById('compare'),
      })`);
      if (back.url !== offline.path || !back.sameDocument || back.table) {
        throw new Error(`${cell}: Back from the comparison table — ${JSON.stringify(back)}, expected exactly ${offline.path}`);
      }

      // Forward: the SAME entry has to carry the fragment, or a reader who goes
      // back and forward loses the table they were reading. Same probe, same
      // bounds, and history must not have grown.
      await tab.evaluate("(() => { history.forward(); return true; })()");
      try {
        await tab.waitFor(landed, `${cell}: Forward to land on the comparison table again`, 10_000);
      } catch (err) {
        throw new Error(`${err.message} — ${JSON.stringify(await tab.evaluate(landingProbe))}`);
      }
      const again = await tab.evaluate(landingProbe);
      const forwardFaults = landingFaults(again, expected);
      if (forwardFaults.length) throw new Error(`${cell}: Forward to the comparison table — ${forwardFaults.join("; ")} — ${JSON.stringify(again)}`);

      const errs = tab.errors.filter((e) => !/401|404|Failed to load resource/.test(e));
      if (errs.length) throw new Error(`${cell}: compare link logged errors:\n    ${errs.join("\n    ")}`);
      cells.push(`${cell} (scrolled ${Math.round(at.scrollY)}px)`);
      await browser.send("Target.closeTarget", { targetId: tab.targetId });
    }
  }
  ok(`offline page's compare link landed on ${landingUrl} in one history entry with the table open and in view, and Back/Forward kept it — IMMEDIATE path only, deferred guard not reachable here: ${cells.join(", ")}`);
}

async function shellLoginNavScenario(browser, base) {
  const checked = [];
  for (const width of [320, 390]) {
    for (const code of ["zh", "en"]) {
      for (const target of SIGN_IN_TARGETS) {
        const tab = await newTab(
          browser,
          base + target.path,
          `try { localStorage.setItem("relayium-lang", ${JSON.stringify(code)}); } catch {}\n`
            + apiFixtureScript(LOGIN_ROUTES),
        );
        await tab.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        await setWideViewport(tab, width, 844);
        await tab.waitFor(
          `!!document.querySelector('${target.container}')`,
          `${target.path} at ${width}px in ${code}`,
        );
        await tab.waitFor(`document.documentElement.lang === ${JSON.stringify(code)}`, `${code} locale`);
        await tab.waitFor(`!!document.querySelector('${target.button}')`, `${target.path}'s own sign-in control`);

        // ── 1. More 是关的，然后点页面自己的登录 ──────────────────────────
        const menuClosed = await tab.evaluate(`(() => {
          const more = document.querySelector('details.more');
          return !!more && !more.open;
        })()`);
        if (!menuClosed) throw new Error(`${code}/${width}${target.path}: the utility menu was not closed before signing in`);

        await tab.evaluate(`(() => { document.querySelector('${target.button}').click(); return true; })()`);
        await tab.waitFor(`!!document.querySelector('[role="dialog"]')`, "the sign-in dialog to exist", 5000);

        const dialog = await tab.evaluate(`(() => {
          const d = document.querySelector('[role="dialog"]');
          const r = d.getBoundingClientRect();
          const more = document.querySelector('details.more');
          return {
            // checkVisibility answers content-visibility and display:none on any
            // ancestor, which is exactly what a closed <details> imposes — and
            // exactly what a node-count assertion cannot see.
            visible: typeof d.checkVisibility === 'function' ? d.checkVisibility() : null,
            painted: r.width > 0 && r.height > 0,
            // FULL inline containment, not intersection. The intersection
            // form passed a dialog measured at x=-9 / right=329 in a 320px
            // viewport — 9px of it off each edge, which is a modal whose
            // close control and first field are partly unreachable. A
            // content-box width plus padding and border is exactly how a
            // "calc(100vw - 32px)" box ends up wider than the viewport, and
            // an intersection test cannot see it.
            left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth,
            insideViewport: r.left >= -0.5 && r.right <= innerWidth + 0.5,
            // The block axis may legitimately scroll; it must still start on
            // screen rather than above it.
            blockOnScreen: r.top < innerHeight && r.bottom > 0,
            focusInside: d.contains(document.activeElement),
            insideMenu: !!more && more.contains(d),
            menuOpen: !!more && more.open,
            closeButtons: d.querySelectorAll('button.close-x').length,
          };
        })()`);
        const bad = [];
        if (dialog.visible === false) bad.push("checkVisibility() false");
        if (!dialog.painted) bad.push("zero-sized box");
        if (!dialog.insideViewport) {
          bad.push(`laid out outside the viewport inline bounds (x=${dialog.left}..${dialog.right} in ${dialog.vw}px)`);
        }
        if (!dialog.blockOnScreen) bad.push("laid out off-viewport in the block axis");
        if (!dialog.focusInside) bad.push("focus outside the dialog");
        if (dialog.insideMenu) bad.push("dialog is inside details.more");
        if (dialog.menuOpen) bad.push("opening the dialog forced the menu open");
        if (dialog.closeButtons !== 1) bad.push(`${dialog.closeButtons} close controls`);
        if (bad.length) {
          throw new Error(`${code}/${width}${target.path}: sign-in dialog ${bad.join(", ")} — ${JSON.stringify(dialog)}`);
        }

        // The page behind the dialog must be unavailable while it is open —
        // pointer, keyboard and assistive technology alike. Anything short of
        // that is a modal you can tab out of, and it is also what made the
        // background's own contrast part of the modal's scan.
        const covered = await tab.evaluate(`(() => {
          const named = ['.appshell-main', 'nav.topnav .brand', 'nav.topnav .tabs', 'nav.topnav details.more'];
          return {
            inert: named.map((sel) => {
              const el = document.querySelector(sel);
              return { sel, present: !!el, inert: !!el && el.hasAttribute('inert') };
            }),
            // The slot that owns the dialog stays live, or focus has nowhere to
            // return to when it closes.
            slotLive: !document.querySelector('.util-slot').hasAttribute('inert'),
          };
        })()`);
        for (const region of covered.inert) {
          if (region.present && !region.inert) {
            throw new Error(`${code}/${width}${target.path}: ${region.sel} is still reachable behind the open dialog`);
          }
        }
        if (!covered.slotLive) throw new Error(`${code}/${width}${target.path}: the account slot was made inert with its own dialog`);

        // …and it closes again, from its own control.
        await tab.evaluate(`(() => { document.querySelector('[role="dialog"] button.close-x').click(); return true; })()`);
        await tab.waitFor(`!document.querySelector('[role="dialog"]')`, "the sign-in dialog to close", 5000);
        const restored = await tab.evaluate(`(() => {
          const stuck = ['.appshell-main', 'nav.topnav .brand', 'nav.topnav .tabs', 'nav.topnav details.more']
            .filter((sel) => document.querySelector(sel)?.hasAttribute('inert'));
          return { stuck, focusReturned: document.activeElement !== document.body };
        })()`);
        if (restored.stuck.length) {
          throw new Error(`${code}/${width}${target.path}: still inert after close — ${restored.stuck.join(", ")}`);
        }

        // ── 2. 四个主目的地全部可见、可点 ────────────────────────────────
        const rail = await tab.evaluate(`(() => {
          const row = document.querySelector('.tabs');
          const rowBox = row.getBoundingClientRect();
          const links = [...document.querySelectorAll('.tabs a.tab')];
          return {
            count: links.length,
            row: { left: Math.round(rowBox.left), right: Math.round(rowBox.right) },
            boxes: links.map((a) => {
              const r = a.getBoundingClientRect();
              return {
                nav: a.getAttribute('data-nav'),
                name: a.getAttribute('aria-label'),
                text: a.innerText.trim(),
                left: Math.round(r.left), right: Math.round(r.right),
                w: Math.round(r.width), h: Math.round(r.height),
                clipped: r.left < -0.5 || r.right > innerWidth + 0.5,
                // Containment in the ROW, not merely in the viewport: a
                // border box wider than its own grid column sits inside the
                // window and still spills over its neighbour.
                outsideRow: r.left < rowBox.left - 0.5 || r.right > rowBox.right + 0.5,
                visible: typeof a.checkVisibility === 'function' ? a.checkVisibility() : true,
              };
            }),
            docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        })()`);
        if (rail.count !== 4) throw new Error(`${code}/${width}${target.path}: ${rail.count} destinations, expected 4`);
        for (const box of rail.boxes) {
          const faults = [];
          if (!box.visible) faults.push("not visible");
          if (box.clipped) faults.push("clipped at a viewport edge");
          if (box.outsideRow) faults.push(`outside its own row (${box.left}..${box.right} vs row ${rail.row.left}..${rail.row.right})`);
          if (box.w <= 0) faults.push("zero width");
          // The same touch floor the rest of this file uses, with the same
          // float-tail tolerance.
          if (undersizedTouchTarget(box.h)) faults.push(`${box.h}px tall`);
          // A destination whose own name is not laid out is hidden by another
          // means: an empty innerText is what an `overflow: hidden` parent or a
          // zero-height line box produces.
          if (!box.text) faults.push("no laid-out label");
          if (faults.length) {
            throw new Error(`${code}/${width}${target.path}: destination ${box.nav} ${faults.join(", ")} — ${JSON.stringify(box)}`);
          }
          // The visible short label must still be part of the accessible name.
          if (box.name && !box.name.includes(box.text)) {
            throw new Error(`${code}/${width}${target.path}: "${box.text}" is not part of the accessible name "${box.name}"`);
          }
        }
        // Adjacent destinations may not intersect. Four equal columns that each
        // overflow their column by 10px still report four on-screen boxes and a
        // document that does not overflow — and every one of them overlaps the
        // next by 6px, so a tap near a boundary hits the wrong destination.
        // Measured at 320px before this check existed: [20,97] [91,168]
        // [162,239] [233,310].
        for (let i = 1; i < rail.boxes.length; i++) {
          const prev = rail.boxes[i - 1];
          const next = rail.boxes[i];
          if (next.left < prev.right - 0.5) {
            throw new Error(
              `${code}/${width}${target.path}: ${prev.nav} and ${next.nav} overlap by `
                + `${Math.round(prev.right - next.left)}px — [${prev.left},${prev.right}] [${next.left},${next.right}]`,
            );
          }
        }
        if (rail.docOverflow !== 0) {
          throw new Error(`${code}/${width}${target.path}: document overflowed by ${rail.docOverflow}px`);
        }

        // A route change while the dialog is open unmounts the control that
        // owns it. Nothing may stay inert behind a dialog that no longer
        // exists — the page would be permanently unusable.
        await tab.evaluate(`(() => { document.querySelector('${target.button}').click(); return true; })()`);
        await tab.waitFor(`!!document.querySelector('[role="dialog"]')`, "the dialog to reopen", 5000);
        await tab.evaluate(`(() => { document.querySelector('.tabs a[data-nav="lan"]').click(); return true; })()`);
        await tab.waitFor("location.pathname === '/'", "the route change out from under the dialog", 5000);
        const afterRoute = await tab.evaluate(`(() => ({
          dialog: !!document.querySelector('[role="dialog"]'),
          stuck: ['.appshell-main', 'nav.topnav .brand', 'nav.topnav .tabs', 'nav.topnav details.more']
            .filter((sel) => document.querySelector(sel)?.hasAttribute('inert')),
        }))()`);
        if (afterRoute.dialog) throw new Error(`${code}/${width}${target.path}: the dialog survived a route change`);
        if (afterRoute.stuck.length) {
          throw new Error(`${code}/${width}${target.path}: left inert after navigating away — ${afterRoute.stuck.join(", ")}`);
        }

        checked.push(`${code}/${width}${target.path}`);
        const errs = tab.errors.filter((e) => !/401|404|Failed to load resource/.test(e));
        if (errs.length) throw new Error(`${code}/${width}${target.path} logged errors:\n    ${errs.join("\n    ")}`);
        await browser.send("Target.closeTarget", { targetId: tab.targetId });
      }
    }
  }
  // A wide viewport can still be a touch screen, and the sidebar's own 28px row
  // height outranks the shared coarse floor on specificity — measured 29.5px at
  // 1440px with `pointer: coarse` on a real browser. Narrow-only touch coverage
  // could not see it.
  {
    const tab = await newTab(browser, base + "/cross-network", apiFixtureScript(LOGIN_ROUTES));
    await tab.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await setWideViewport(tab, 1440, 1000);
    await tab.waitFor("!!document.querySelector('nav.topnav.shell .tabs a.tab')", "the desktop sidebar");
    const wide = await tab.evaluate(`(() => ({
      coarse: matchMedia('(pointer: coarse)').matches,
      sidebar: !!document.querySelector('nav.topnav.shell'),
      rows: [...document.querySelectorAll('nav.topnav .tabs a.tab, nav.topnav nav.tools a.tool')]
        .map((a) => ({ label: a.innerText.trim(), h: a.getBoundingClientRect().height })),
    }))()`);
    if (!wide.coarse) throw new Error("wide-coarse case did not actually report a coarse pointer");
    if (!wide.sidebar) throw new Error("wide-coarse case did not reach the sidebar form");
    const short = wide.rows.filter((r) => undersizedTouchTarget(r.h));
    if (short.length) {
      throw new Error(`1440px with a coarse pointer: ${short.map((r) => `${r.label} ${r.h}px`).join(", ")}`);
    }
    if (tab.errors.length) throw new Error(`wide-coarse case logged errors: ${tab.errors.join(" | ")}`);
    ok(`sidebar kept the touch floor on a ${wide.rows.length}-row coarse-pointer desktop`);
    await browser.send("Target.closeTarget", { targetId: tab.targetId });
  }

  ok(`sign-in stayed visible with the utility menu closed, the page behind it was unavailable, and all four destinations stayed on screen, across ${checked.length} narrow cells`);

  // Same two login-gated pages, the link between them. See the case's own header.
  await offlineCompareLinkCase(browser, base);
}

// Fixed, not derived from SCENARIOS.length: a future edit that comments out or
// otherwise drops an entry below must not still see its own shrunken array
// length agree with itself and print a false N/N pass.
const EXPECTED_SCENARIO_COUNT = 6;
const SCENARIOS = [authLandingScenario, appsHierarchyScenario, pricingHierarchyScenario, cliMobileScenario, unsupportedLayoutScenario, shellLoginNavScenario];

async function main() {
  const preview = await startPreview({ port: PREVIEW_PORT });
  const { browser, close } = await launchBrowser({ debugPort: DEBUG_PORT });
  try {
    let ran = 0;
    for (const scenario of SCENARIOS) {
      await scenario(browser, preview.base);
      ran++;
    }
    if (ran !== EXPECTED_SCENARIO_COUNT) {
      throw new Error(`ran ${ran}/${EXPECTED_SCENARIO_COUNT} page-shell scenarios — expected exactly ${EXPECTED_SCENARIO_COUNT}`);
    }
    console.log(`\n${ran}/${EXPECTED_SCENARIO_COUNT} page-shell scenarios passed\n`);
  } catch (err) {
    fail("page-shell", err);
    process.exitCode = 1;
  } finally {
    await close();
    await preview.stop();
  }
}

await withWatchdog("page-shell", GLOBAL_TIMEOUT_MS, main);
