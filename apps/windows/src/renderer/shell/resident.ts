// The page's half of the resident conversation.
//
// Main can ask this page to do one of a closed set of things — open a page,
// pause Nearby, take a pairing code, stop for a quit, operate again — and can
// ask what quitting would cost. The page answers the question it was asked, by
// its request id, so a quit is never satisfied by a snapshot that describes an
// earlier moment.
//
// Typed here rather than imported from the preload, like `bridge.ts`: this is a
// trust boundary, and `ipc.test.ts` keeps the two spellings honest.

import {
  MAX_RESIDENT_DRAFTS,
  isResidentPage,
  type ResidentCommand,
  type ResidentNotice,
  type ResidentPage,
  type ResidentSnapshot,
} from "../../shared/ipc-contract.js";

export interface ResidentBridge {
  onCommand(cb: (payload: unknown) => void): () => void;
  /** A fact main cannot observe, as a closed kind and nothing else. */
  notify(payload: { kind: ResidentNotice }): Promise<unknown>;
  ack(payload: {
    requestId: string;
    generation: number;
    ok: boolean;
    snapshot?: ResidentSnapshot;
  }): Promise<unknown>;
  snapshot(payload: ResidentSnapshot): Promise<unknown>;
}

export interface ResidentHandlers {
  /** What quitting would cost, right now. Read fresh on every ask. */
  readonly snapshot: () => ResidentSnapshot;
  readonly navigate: (page: ResidentPage) => void;
  readonly setLan: (action: "pause" | "resume") => void;
  /**
   * Start nothing new; keep everything that is running.
   *
   * Not a quiesce. A quit is deciding, and the answer it is about to get must
   * stay true while the user reads the dialog.
   */
  readonly setAdmission: (action: "fence" | "admit") => void;
  /** Stop rooms and transfers. The user has already agreed to quit. */
  readonly quiesce: () => void;
  /** The user stayed. Operate again — do not reopen what was stopped. */
  readonly resume: () => void;
  /** A code from outside. Offered, never merged into what is in progress. */
  readonly pairCode: (code: string, mode?: "text" | "files") => boolean;
}

/** A pairing code is six digits, as text: `004291` is not `4291`. */
const CODE_RE = /^[0-9]{6}$/;

/** Narrow one pushed command, or refuse it. Main is trusted; the payload is
 *  still `unknown` at runtime, and an unrecognised verb must not be guessed. */
function narrow(payload: unknown): { requestId: string; generation: number; command: ResidentCommand } | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = payload as Record<string, unknown>;
  const requestId = raw["requestId"];
  const generation = raw["generation"];
  const body = raw["command"];
  if (typeof requestId !== "string" || typeof generation !== "number") return null;
  if (!body || typeof body !== "object") return null;
  const command = body as Record<string, unknown>;
  switch (command["kind"]) {
    case "navigate":
      return isResidentPage(command["page"])
        ? { requestId, generation, command: { kind: "navigate", page: command["page"] } }
        : null;
    case "lan": {
      const action = command["action"];
      return action === "pause" || action === "resume"
        ? { requestId, generation, command: { kind: "lan", action } }
        : null;
    }
    case "admission": {
      const action = command["action"];
      return action === "fence" || action === "admit"
        ? { requestId, generation, command: { kind: "admission", action } }
        : null;
    }
    case "risk-snapshot":
      return { requestId, generation, command: { kind: "risk-snapshot" } };
    case "quiesce":
      return { requestId, generation, command: { kind: "quiesce" } };
    case "resume":
      return { requestId, generation, command: { kind: "resume" } };
    case "pair-code": {
      const code = command["code"];
      const mode = command["mode"];
      if (typeof code !== "string" || !CODE_RE.test(code)) return null;
      if (mode !== undefined && mode !== "text" && mode !== "files") return null;
      return {
        requestId,
        generation,
        command: mode ? { kind: "pair-code", code, mode } : { kind: "pair-code", code },
      };
    }
    default:
      return null;
  }
}

/**
 * Listen for commands and answer them. Returns its own unsubscribe.
 *
 * Every command is acknowledged, including one that could not be understood —
 * silence would make an unreachable page and an unrecognised verb look the
 * same, and main treats the first as "unknown risk".
 */
export function attachResident(bridge: ResidentBridge, handlers: ResidentHandlers): () => void {
  return bridge.onCommand((payload) => {
    const parsed = narrow(payload);
    if (!parsed) return;
    const { requestId, generation, command } = parsed;
    const reply = (ok: boolean, snapshot?: ResidentSnapshot) =>
      void bridge
        .ack(snapshot ? { requestId, generation, ok, snapshot } : { requestId, generation, ok })
        .catch(() => undefined);

    switch (command.kind) {
      case "risk-snapshot":
        // The snapshot travels WITH the acknowledgement, so it is unmistakably
        // the answer to this question rather than a push that arrived nearby.
        reply(true, clamp(handlers.snapshot()));
        return;
      case "admission":
        handlers.setAdmission(command.action);
        reply(true);
        return;
      case "navigate":
        handlers.navigate(command.page);
        reply(true);
        return;
      case "lan":
        handlers.setLan(command.action);
        reply(true);
        return;
      case "quiesce":
        handlers.quiesce();
        reply(true, clamp(handlers.snapshot()));
        return;
      case "resume":
        handlers.resume();
        reply(true);
        return;
      case "pair-code":
        reply(handlers.pairCode(command.code, command.mode));
        return;
    }
  });
}

/** Counts main will believe. The draft count is only ever read as a boolean. */
function clamp(snapshot: ResidentSnapshot): ResidentSnapshot {
  return {
    sending: snapshot.sending,
    receiving: snapshot.receiving,
    drafts: Math.max(0, Math.min(Math.trunc(snapshot.drafts), MAX_RESIDENT_DRAFTS)),
    locale: snapshot.locale,
    nearby: snapshot.nearby,
  };
}

/** Volunteer the current state. Unsolicited: it never answers a question. */
export function pushSnapshot(bridge: ResidentBridge, snapshot: ResidentSnapshot): void {
  void bridge.snapshot(clamp(snapshot)).catch(() => undefined);
}
