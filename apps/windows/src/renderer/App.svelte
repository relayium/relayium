<script lang="ts">
  import { onDestroy } from "svelte";
  import { SignInController, type AppInfoView, type Phase, type SignInBridge } from "./sign-in-controller";

  /**
   * The foundation shell.
   *
   * It renders what this slice actually delivers — the build's origin, whether
   * the platform secret store is usable, and the complete device-code sign-in —
   * and nothing it does not. There is deliberately no five-row sidebar here:
   * drawing the macOS navigation over destinations that do not exist would make
   * a screenshot claim progress that has not been made.
   *
   * ## Why the sign-in lifecycle is not in this file
   *
   * It was, and that is where the cancellation defect lived. Timers, attempt
   * generations, deadlines and the fences after every await now live in
   * `sign-in-controller.ts`, which this component OWNS and drives — it is not a
   * copy of the logic, it is the logic. What is left here is markup and one
   * subscription, which is the part a DOM is genuinely needed to review.
   */
  let info = $state<AppInfoView | null>(null);
  let phase = $state<Phase>({ kind: "loading" });

  const bridge = (globalThis as unknown as { relayium: SignInBridge }).relayium;

  const controller = new SignInController({
    bridge,
    onPhase: (next) => {
      phase = next;
    },
    onInfo: (next) => {
      info = next;
    },
  });

  // Not merely a timer sweep: teardown also tells the main process to abandon
  // the attempt, so a component that goes away does not leave a live device
  // code behind it.
  onDestroy(() => controller.dispose());

  void controller.refresh();
</script>

<main>
  {#if info?.banner}
    <p class="banner">{info.banner}</p>
  {/if}

  <h1>Relayium for Windows</h1>
  <p class="dim">Foundation build. Transfer surfaces are not implemented yet.</p>

  <section>
    <h2>Build</h2>
    {#if info}
      <dl>
        <dt>Server</dt><dd>{info.origin}</dd>
        <dt>Version</dt><dd>{info.version}</dd>
      </dl>
    {:else}
      <p class="dim">Loading…</p>
    {/if}
  </section>

  <section>
    <h2>Account</h2>
    {#if phase.kind === "loading"}
      <p class="dim">Loading…</p>
    {:else if phase.kind === "signedIn"}
      <p>Signed in as {phase.accountEmail || "this account"}.</p>
      <button data-test="sign-out" onclick={() => controller.signOut()}>Sign out</button>
    {:else if phase.kind === "starting"}
      <!-- Cancel is real here, not decoration: the attempt is named before the
           request is sent, so there is something for this button to abandon
           even though `start` has not come back yet. -->
      <p class="dim">Opening your browser…</p>
      <button data-test="cancel" onclick={() => controller.cancel()}>Cancel</button>
    {:else if phase.kind === "cancelling"}
      <p class="dim">Cancelling…</p>
      <button data-test="cancel" disabled>Cancel</button>
    {:else if phase.kind === "waiting"}
      <p>Approve this device in the browser window that just opened.</p>
      <p class="code">{phase.userCode}</p>
      <p class="dim">Waiting — this code expires in {Math.ceil(phase.secondsLeft / 60)} min.</p>
      <button data-test="cancel" onclick={() => controller.cancel()}>Cancel</button>
    {:else if phase.kind === "storeProblem"}
      <!-- Not a Sign in button. Signing in would write a credential this
           machine cannot encrypt, and the app refuses to store one in the
           clear, so the attempt could not succeed. -->
      <p class="problem">
        {#if phase.health === "unavailable"}
          Windows cannot encrypt stored credentials on this account, so Relayium
          will not save a sign-in here.
        {:else}
          Relayium could not read its own stored credentials. They may have been
          written by a different Windows account.
        {/if}
      </p>
      <button data-test="retry" onclick={() => controller.refresh()}>Try again</button>
    {:else if phase.kind === "failed"}
      <p class="problem">{phase.message}</p>
      <button data-test="sign-in" onclick={() => controller.signIn()}>Try again</button>
    {:else}
      <button data-test="sign-in" onclick={() => controller.signIn()}>Sign in</button>
    {/if}
  </section>
</main>

<style>
  main {
    padding: var(--space-page);
    max-width: var(--reading-measure);
  }
  h1 { font-size: 20px; margin: 0 0 var(--space-hairline); }
  h2 { font-size: 14px; margin: 0 0 var(--space-inner); }
  section {
    margin-top: var(--space-section);
    padding: var(--space-section);
    border: 1px solid var(--border);
    border-radius: var(--corner);
    background: var(--surface);
  }
  dl { display: grid; grid-template-columns: auto 1fr; gap: var(--space-hairline) var(--space-inner); margin: 0; }
  dt { color: var(--text-dim); }
  dd { margin: 0; }
  .dim { color: var(--text-dim); margin: 0; }
  .problem { color: #b3261e; margin: 0 0 var(--space-tight); }
  .banner {
    margin: 0 0 var(--space-section);
    padding: var(--space-tight);
    border-radius: var(--corner);
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  .code { font-family: ui-monospace, Consolas, monospace; font-size: 24px; letter-spacing: 2px; }
  button {
    min-height: var(--hit-target);
    padding: 0 var(--space-section);
    border: 0;
    border-radius: var(--corner);
    background: var(--accent);
    color: #fff;
    font: inherit;
    cursor: pointer;
  }
  button:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
  button:disabled { opacity: 0.6; cursor: default; }
</style>
