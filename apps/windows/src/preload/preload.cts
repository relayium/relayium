// The bridge, and the entire attack surface between renderer and main.
//
// ## Why the channel names are literals here
//
// This file is the trust boundary, so it is written to be read: every capability
// the renderer gets is one line, and the list is short enough to audit at a
// glance. It deliberately does NOT import the shared contract — a sandboxed
// preload runs in a restricted CommonJS context, and more importantly a boundary
// that pulls its own definition from elsewhere is one where a change somewhere
// else silently widens what is exposed. `ipc-contract.test.ts` asserts these
// literals match the contract, so drift is caught without the coupling.
//
// ## What is not here
//
// No `ipcRenderer`, no `require`, no `process`, no path, no filesystem, no
// generic `invoke(channel, ...)`. A generic forwarder would make every present
// and future channel reachable from any script the renderer runs, which is the
// whole property `contextIsolation` exists to give.

import { contextBridge, ipcRenderer } from "electron";

const invoke = (channel: string) => (payload?: unknown) => ipcRenderer.invoke(channel, payload);

/**
 * The one main-to-renderer event, subscribed by its literal name.
 *
 * ## Why this is a named subscription and not `on(channel, cb)`
 *
 * A generic forwarder would make every present and future main-to-renderer
 * message reachable from any script the renderer runs — the exact mirror of the
 * generic `invoke` this bridge already refuses, and it would arrive without
 * anybody reviewing what started being pushed. So the name is spelled here,
 * once, and `ipc-contract.test.ts` asserts the set matches the contract.
 *
 * `ipcRenderer` and the Electron `event` object are both dropped: the callback
 * receives the payload and nothing else, so a renderer cannot reach `sender`
 * and turn a subscription into a channel of its own.
 *
 * Returns an unsubscribe. A room that closes must be able to stop listening —
 * without one, every reopened room would add a listener to the same emitter and
 * the old ones would keep receiving.
 */
const subscribe = (channel: string) => (cb: (payload: unknown) => void) => {
  const listener = (_event: unknown, payload: unknown) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("relayium", {
  appInfo: invoke("relayium:app-info"),
  auth: {
    start: invoke("relayium:auth-start"),
    poll: invoke("relayium:auth-poll"),
    cancel: invoke("relayium:auth-cancel"),
    signOut: invoke("relayium:auth-sign-out"),
    state: invoke("relayium:auth-state"),
  },
  receive: {
    open: invoke("relayium:receive-open"),
    begin: invoke("relayium:receive-begin"),
    write: invoke("relayium:receive-write"),
    finish: invoke("relayium:receive-finish"),
    cancel: invoke("relayium:receive-cancel"),
    publish: invoke("relayium:receive-publish"),
  },
  signaling: {
    open: invoke("relayium:signaling-open"),
    send: invoke("relayium:signaling-send"),
    close: invoke("relayium:signaling-close"),
    subscribe: subscribe("relayium:signaling-event"),
  },
  ice: {
    config: invoke("relayium:ice-config"),
  },
  pair: {
    create: invoke("relayium:pair-create"),
  },
  prefs: {
    read: invoke("relayium:prefs-read"),
    write: invoke("relayium:prefs-write"),
  },
  // The resident surface: main can ask the page to navigate, pause Nearby, stop
  // for a quit, or take a pairing code, and the page answers the question it was
  // asked. Three names, spelled here like the rest.
  resident: {
    onCommand: subscribe("relayium:resident-command"),
    ack: invoke("relayium:resident-ack"),
    snapshot: invoke("relayium:resident-snapshot"),
    notify: invoke("relayium:resident-notify"),
  },
  // Stored receive. `start` carries the pasted link, which is the one payload
  // in this bridge that contains a key — see the contract's note on it.
  stored: {
    receive: invoke("relayium:stored-receive-start"),
    cancel: invoke("relayium:stored-receive-cancel"),
    result: invoke("relayium:stored-receive-result"),
    inventory: invoke("relayium:stored-inventory"),
    retryCleanup: invoke("relayium:stored-cleanup-retry"),
    onProgress: subscribe("relayium:stored-progress"),
    onOutcome: subscribe("relayium:stored-outcome"),
  },
  // Stored send. `start` answers with this job's content key — the one secret
  // that travels main→renderer, because the renderer is what encrypts. `feed`
  // carries ciphertext the other way; neither ever carries a path.
  send: {
    start: invoke("relayium:stored-send-start"),
    feed: invoke("relayium:stored-send-feed"),
    end: invoke("relayium:stored-send-end"),
    cancel: invoke("relayium:stored-send-cancel"),
    history: invoke("relayium:stored-send-history"),
    link: invoke("relayium:stored-send-link"),
    remove: invoke("relayium:stored-send-delete"),
    reconcile: invoke("relayium:stored-send-reconcile"),
    copyLink: invoke("relayium:stored-send-copy-link"),
    onProgress: subscribe("relayium:stored-send-progress"),
    onOutcome: subscribe("relayium:stored-send-outcome"),
    onAccount: subscribe("relayium:stored-send-account"),
  },
  loginItem: {
    read: invoke("relayium:login-item-read"),
    write: invoke("relayium:login-item-write"),
  },
  // The Device Inbox. Every name here takes an id or nothing at all: there is
  // no path, no token and no key on this surface, and `enable` opens a NATIVE
  // folder dialog in main rather than accepting a destination from here.
  inbox: {
    state: invoke("relayium:inbox-state"),
    enable: invoke("relayium:inbox-enable"),
    disable: invoke("relayium:inbox-disable"),
    chooseFolder: invoke("relayium:inbox-choose-folder"),
    pending: invoke("relayium:inbox-pending"),
    accept: invoke("relayium:inbox-accept"),
    reject: invoke("relayium:inbox-reject"),
    messages: invoke("relayium:inbox-messages"),
    open: invoke("relayium:inbox-open-message"),
    copy: invoke("relayium:inbox-copy-message"),
    remove: invoke("relayium:inbox-delete-message"),
    rename: invoke("relayium:inbox-rename"),
    wake: invoke("relayium:inbox-wake"),
    release: invoke("relayium:inbox-release-retained"),
    setPolicy: invoke("relayium:inbox-set-policy"),
    reveal: invoke("relayium:inbox-reveal-folder"),
    receipts: invoke("relayium:inbox-receipts"),
    onState: subscribe("relayium:inbox-state-changed"),
  },
});
