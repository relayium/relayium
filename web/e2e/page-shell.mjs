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
import { apiFixtureScript, PRICING_ROUTES } from "./a11y-fixtures.mjs";
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
    JSON.stringify(magic.h1) !== JSON.stringify(["Sign in"]) || magic.headingPx !== 30 ||
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
  const missingCta = ids.filter((id) => !CTA_TARGET[id]);
  if (missingCta.length) {
    throw new Error(`apps card model: no CTA target declared for ${missingCta.join(", ")}`);
  }

  const available = entries.filter((e) => AVAILABILITY[e.expr]()).map((e) => e.id);
  const future = entries.filter((e) => !AVAILABILITY[e.expr]()).map((e) => e.id);

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
  if (
    desktop.firstTierY >= 700 || desktop.pricePx !== 30 || desktop.titlePx !== 34 ||
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

// Fixed, not derived from SCENARIOS.length: a future edit that comments out or
// otherwise drops an entry below must not still see its own shrunken array
// length agree with itself and print a false N/N pass.
const EXPECTED_SCENARIO_COUNT = 4;
const SCENARIOS = [authLandingScenario, appsHierarchyScenario, pricingHierarchyScenario, unsupportedLayoutScenario];

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
