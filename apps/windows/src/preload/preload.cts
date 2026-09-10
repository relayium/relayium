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
  },
});
