// The privileged side of every renderer request.
//
// ## Four checks on every single call, in this order
//
//   1. **The channel is one this app declares.** Registration is driven by the
//      contract object, so an unregistered channel has no handler at all.
//   2. **The sender is OUR window.** `event.senderFrame` identifies the exact
//      frame. A message from any other WebContents — a devtools extension, a
//      window opened by content, a webview — is refused.
//   3. **The frame is the top-level one, on our own origin.** A subframe that
//      somehow loaded remote content cannot borrow the parent's capabilities.
//   4. **The payload is shaped and bounded.** Sizes are checked before anything
//      is allocated or planned.
//
// A refusal is logged as a refusal and never falls through to a permissive
// default: an `else` that returns success is how a validated channel becomes an
// unvalidated one.

import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { IPC_CHANNELS } from "../shared/ipc-contract.js";
import { isAppBundleURL } from "./window.js";

export class IpcRefusal extends Error {
  constructor(readonly reason: string) {
    super(`refused: ${reason}`);
    this.name = "IpcRefusal";
  }
}

/**
 * Is this invocation from the one window this app created, at its top frame,
 * loaded from this app's own bundle?
 *
 * ## Why the frame URL is not compared by `origin`
 *
 * `app:` is a non-special scheme, so WHATWG `URL` reports its origin as the
 * opaque string `"null"` — and so do `file:`, `data:` and every other custom
 * scheme. An origin comparison would therefore accept a frame at
 * `file:///C:/…` as the app's own page. `isAppBundleURL` compares scheme, host,
 * port and credentials instead, none of which an opaque origin can satisfy.
 *
 * Pure and exported so the hostile cases are testable without an Electron
 * runtime — the checks that matter most are the ones a unit test can drive.
 */
export function isTrustedSender(args: {
  readonly senderId: number;
  readonly expectedId: number | null;
  readonly frameUrl: string;
  readonly isMainFrame: boolean;
  readonly scheme: string;
  readonly host: string;
}): boolean {
  if (args.expectedId === null) return false;
  if (args.senderId !== args.expectedId) return false;
  if (!args.isMainFrame) return false;
  return isAppBundleURL(args.frameUrl, args.scheme, args.host);
}

/**
 * The registry. Holds the one WebContents id that is allowed to talk to it, so
 * "our window" is an identity rather than a description.
 */
export class IpcRouter {
  private expectedId: number | null = null;

  constructor(
    private readonly scheme: string,
    private readonly host: string,
  ) {}

  /** Called once, with the window this app created. */
  bind(contents: WebContents): void {
    this.expectedId = contents.id;
    contents.once("destroyed", () => {
      this.expectedId = null;
    });
  }

  handle<T>(channel: string, body: (payload: unknown) => Promise<T>): void {
    if (!IPC_CHANNELS.includes(channel)) {
      // A channel absent from the contract is a capability nobody reviewed.
      throw new Error(`refusing to register undeclared IPC channel: ${channel}`);
    }
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, payload: unknown) => {
      const frame = event.senderFrame;
      const trusted = isTrustedSender({
        senderId: event.sender.id,
        expectedId: this.expectedId,
        frameUrl: frame?.url ?? "",
        isMainFrame: frame ? frame.parent === null : false,
        scheme: this.scheme,
        host: this.host,
      });
      if (!trusted) {
        // Deliberately no detail to the caller: an untrusted sender learns
        // nothing about why it was refused.
        throw new IpcRefusal(`untrusted sender on ${channel}`);
      }
      return body(payload);
    });
  }
}

/** Payload guards. Each returns the narrowed value or throws. */
export const expectObject = (payload: unknown): Record<string, unknown> => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new IpcRefusal("expected an object");
  }
  return payload as Record<string, unknown>;
};

export const expectString = (value: unknown, max: number): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new IpcRefusal("expected a bounded string");
  }
  return value;
};

export const expectIndex = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new IpcRefusal("expected a non-negative index");
  }
  return value;
};

export const expectChunk = (value: unknown, max: number): Uint8Array => {
  // `Uint8Array` after structured clone; anything else is refused rather than
  // coerced, because coercing a string here would allocate on the sender's say-so.
  if (!(value instanceof Uint8Array)) throw new IpcRefusal("expected binary data");
  if (value.byteLength > max) throw new IpcRefusal("chunk exceeds the ceiling");
  return value;
};
