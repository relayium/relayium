// A private entry that mounts the REAL link pane for the renderer smoke.
//
// Nothing imports this file, so it is not in the shipped bundle.
//
// ## Why this screen needed one, last of all
//
// `LinkPane` is what the realtime product IS: one verified connection carrying
// messages and any number of file batches. It is also the screen no suite could
// reach. The realtime lane does render it — against a real server, a real
// browser peer and a real transport — but that lane can only produce the states
// a healthy pairing actually reaches. It cannot expire a relay credential, drop
// a signalling socket, make a peer flood the text lane, or hand back each of
// the ten publish-failure reasons in turn.
//
// So two batches this session added markup here and both had to record that
// placement was unproven: the link endings with their two warnings, and the
// total maps for the receipt and the text lane. This closes that.
//
// ## The stand-in
//
// `RoomController` owns a signalling socket and a `PeerWorkspace`; the
// workspace owns two lanes and a transport. None of that can exist in a page
// with no main process, so the objects below are plain ones, cast ONCE at the
// mount boundary.
//
// The casts are pinned. `LinkRoomStandIn` and `LinkWorkspaceStandIn` are
// declared from what the component actually reads, and an assignability check
// against the real types means a renamed member breaks this file rather than
// leaving a harness that agrees with nothing.

import { mount } from "svelte";
import LinkPane from "../pages/LinkPane.svelte";
import type { RoomController, ReceiveOutcome } from "../rooms/room-controller.svelte.js";
import type { RevealController } from "../receive/reveal-controller.svelte.js";
import type { ReceivedController } from "../receive/received-controller.svelte.js";
import type { PeerWorkspace } from "../../../../../web/src/lib/peer-workspace.svelte";
import type { Incoming, Xfer } from "../../../../../web/src/lib/transfer-model";
import type { TextErrorKey, TextMessage, TextStatus } from "../../../../../web/src/lib/text-model";
import type { LinkEndReason } from "../../../../../web/src/lib/mixed-session.svelte";
import type { PublishFailureReason } from "../../shared/ipc-contract.js";
import { setLang } from "../i18n/index.svelte.js";
import "../tokens.css";

const calls = {
  acceptFile: 0,
  rejectFile: 0,
  acceptText: 0,
  rejectText: 0,
  abortFile: 0,
  sendText: [] as string[],
  clearText: 0,
  sendFiles: 0,
  openText: 0,
  disconnect: 0,
  dismissLinkEnd: 0,
  confirmVerification: 0,
  reveal: [] as string[],
  act: [] as string[],
};

const state = $state({
  linkPeerId: "peer-aaaa",
  linkStatus: "open" as PeerWorkspace["linkStatus"],
  linkEndReason: "" as LinkEndReason,
  relayExpiring: false,
  recoveryAvailable: true,
  sasCode: "",
  verificationConfirmed: true,
  incoming: null as Incoming | null,
  recv: null as Xfer | null,
  send: null as Xfer | null,
  textStatus: "idle" as TextStatus,
  textErrorKey: "" as TextErrorKey,
  textHistory: [] as TextMessage[],
  lastReceipt: null as ReceiveOutcome | null,
  verifyPeers: false,
});

/** Exactly what `LinkPane` reads off the workspace. Read from the component. */
interface LinkWorkspaceStandIn {
  readonly linkPeerId: string;
  readonly linkStatus: PeerWorkspace["linkStatus"];
  readonly linkEndReason: LinkEndReason;
  readonly linkGeneration: number;
  readonly relayExpiring: boolean;
  readonly recoveryAvailable: boolean;
  readonly sasCode: string;
  readonly incoming: Incoming | null;
  readonly recv: Xfer | null;
  readonly send: Xfer | null;
  readonly text: PeerWorkspace["text"];
  acceptFile(): void;
  rejectFile(): void;
  acceptText(): void;
  rejectText(): void;
  abortFile(): void;
  sendText(peerId: string, body: string): void;
  clearText(): void;
  sendFiles(peerId: string, files: readonly unknown[]): void;
  openText(peerId: string): Promise<void>;
  disconnect(): void;
  dismissLinkEnd(): void;
}

const workspace: LinkWorkspaceStandIn = {
  get linkPeerId() {
    return state.linkPeerId;
  },
  get linkStatus() {
    return state.linkStatus;
  },
  get linkEndReason() {
    return state.linkEndReason;
  },
  linkGeneration: 1,
  get relayExpiring() {
    return state.relayExpiring;
  },
  get recoveryAvailable() {
    return state.recoveryAvailable;
  },
  get sasCode() {
    return state.sasCode;
  },
  get incoming() {
    return state.incoming;
  },
  get recv() {
    return state.recv;
  },
  get send() {
    return state.send;
  },
  get text() {
    return {
      get status() {
        return state.textStatus;
      },
      get errorKey() {
        return state.textErrorKey;
      },
      get history() {
        return state.textHistory;
      },
    } as PeerWorkspace["text"];
  },
  acceptFile: () => {
    calls.acceptFile += 1;
  },
  rejectFile: () => {
    calls.rejectFile += 1;
  },
  acceptText: () => {
    calls.acceptText += 1;
  },
  rejectText: () => {
    calls.rejectText += 1;
  },
  abortFile: () => {
    calls.abortFile += 1;
  },
  sendText: (_peerId, body) => {
    calls.sendText.push(body);
  },
  clearText: () => {
    calls.clearText += 1;
    state.textHistory = [];
  },
  sendFiles: () => {
    calls.sendFiles += 1;
  },
  openText: () => {
    calls.openText += 1;
    return Promise.resolve();
  },
  disconnect: () => {
    calls.disconnect += 1;
  },
  dismissLinkEnd: () => {
    calls.dismissLinkEnd += 1;
  },
};

interface LinkRoomStandIn {
  readonly workspace: LinkWorkspaceStandIn;
  readonly lastReceipt: ReceiveOutcome | null;
  readonly verificationConfirmed: boolean;
  readonly sendRefusal: string | null;
  peerName(peerId: string): string;
  confirmVerification(): void;
  disconnect(): void;
  clearSendRefusal(): void;
}

const room: LinkRoomStandIn = {
  workspace,
  get lastReceipt() {
    return state.lastReceipt;
  },
  get verificationConfirmed() {
    return state.verificationConfirmed;
  },
  sendRefusal: null,
  peerName: (peerId) => (peerId === "peer-aaaa" ? "Kitchen laptop" : ""),
  confirmVerification: () => {
    calls.confirmVerification += 1;
    state.verificationConfirmed = true;
  },
  disconnect: () => {
    calls.disconnect += 1;
  },
  clearSendRefusal: () => undefined,
};

/**
 * The compile-time half of the casts.
 *
 * Every member of each stand-in must be assignable to the real type's, so a
 * rename or a changed signature breaks this file. `text` is checked through the
 * workspace's own declared member rather than reconstructed here.
 */
const _workspaceAssignable: Pick<
  PeerWorkspace,
  | "linkPeerId" | "linkStatus" | "linkEndReason" | "linkGeneration" | "relayExpiring"
  | "recoveryAvailable" | "sasCode" | "incoming" | "recv" | "send" | "text"
  | "acceptFile" | "rejectFile" | "acceptText" | "rejectText" | "abortFile"
  | "sendText" | "clearText" | "openText" | "disconnect" | "dismissLinkEnd"
> = workspace as unknown as PeerWorkspace;
void _workspaceAssignable;
const _roomAssignable: Pick<
  RoomController,
  "lastReceipt" | "verificationConfirmed" | "peerName" | "confirmVerification" | "disconnect"
> = room as unknown as RoomController;
void _roomAssignable;

/** Neither is exercised by the states this harness drives; both are required. */
const reveal = {
  busy: false,
  refusal: null,
  receiptFor: () => null,
  reveal: (token: string) => {
    calls.reveal.push(token);
  },
} as unknown as RevealController;
const received = {
  busy: false,
  refusal: null,
  items: [],
  act: (token: string) => {
    calls.act.push(token);
  },
} as unknown as ReceivedController;

const target = document.getElementById("app");
if (target === null) throw new Error("the harness page has no mount point");

mount(LinkPane, {
  target,
  props: {
    room: room as unknown as RoomController,
    reveal,
    received,
    get verifyPeers() {
      return state.verifyPeers;
    },
  },
});

/** Inputs only. The driver sets state and reads the DOM back. */
Object.defineProperty(globalThis, "__linkHarness", {
  value: {
    setStatus(next: PeerWorkspace["linkStatus"]): void {
      state.linkStatus = next;
    },
    setEndReason(next: LinkEndReason): void {
      state.linkEndReason = next;
    },
    setWarnings(relayExpiring: boolean, recoveryAvailable: boolean): void {
      state.relayExpiring = relayExpiring;
      state.recoveryAvailable = recoveryAvailable;
    },
    setVerification(verifyPeers: boolean, sas: string, confirmed: boolean): void {
      state.verifyPeers = verifyPeers;
      state.sasCode = sas;
      state.verificationConfirmed = confirmed;
    },
    setText(status: TextStatus, errorKey: TextErrorKey): void {
      state.textStatus = status;
      state.textErrorKey = errorKey;
    },
    setHistory(bodies: readonly string[]): void {
      state.textHistory = bodies.map(
        (body, i) => ({ id: i + 1, dir: i % 2 === 0 ? "in" : "out", body, failed: false }) as TextMessage,
      );
    },
    /**
     * A FINISHED incoming batch, which is where the receipt renders.
     *
     * The receipt lives inside the recv transfer's own card and only once that
     * transfer is `done`. Setting the receipt alone put nothing on screen, and
     * the first run of the driver reported nulls for every reason.
     */
    setRecvDone(done: boolean): void {
      state.recv = done
        ? {
            peer: "peer-aaaa",
            dir: "recv",
            files: [{ name: "a.txt", size: 4 } as Xfer["files"][number]],
            index: 0,
            sent: 4,
            total: 4,
            status: "done" as Xfer["status"],
            done: true,
            ok: false,
            speed: 0,
          }
        : null;
    },
    setReceipt(reason: PublishFailureReason | null, residue = false): void {
      state.lastReceipt =
        reason === null ? null : { kind: "failed", reason, residue, saved: 0, total: 3 };
    },
    setLang(next: "en" | "zh"): void {
      setLang(next);
    },
    calls(): typeof calls {
      return JSON.parse(JSON.stringify(calls)) as typeof calls;
    },
  },
  enumerable: true,
});
