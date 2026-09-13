// The notification path, including the branch nothing used to take.
//
// A toast the OS refuses is the failure worth catching: the user never sees it
// and the app goes on believing it told them. In a product whose job is to stay
// reachable while its window is hidden, a delivery nobody is told about is —
// from the user's side — a delivery that did not happen.
//
// The real `Notification` cannot be made to fail from a test, and a CI runner
// has no shortcut carrying this app's AppUserModelID, so asserting a real toast
// there would measure the runner rather than the product. The constructor is
// injected so the branch is reachable at all.

import { describe, expect, it, vi } from "vitest";
import { showNotification, type NotificationHandle, type NotifyDeps } from "../../src/main/notify.js";
import { RESIDENT_NOTICES, isResidentNotice } from "../../src/shared/ipc-contract.js";

/** A stand-in that records its listeners so a test can fire them. */
function fakeNotification() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const shown = { count: 0 };
  const handle: NotificationHandle = {
    on(event: string, listener: (...args: never[]) => void) {
      listeners.set(event, listener as (...args: unknown[]) => void);
      return handle;
    },
    show() {
      shown.count += 1;
    },
  } as NotificationHandle;
  return { handle, listeners, shown };
}

function deps(over: Partial<NotifyDeps> = {}) {
  const reported: unknown[] = [];
  const fake = fakeNotification();
  const base: NotifyDeps = {
    isSupported: () => true,
    create: () => fake.handle,
    onClick: () => undefined,
    report: (err) => reported.push(err),
    ...over,
  };
  return { base, reported, fake };
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

describe("showing a notification", () => {
  it("shows it, and says nothing when nothing went wrong", () => {
    const { base, reported, fake } = deps();
    expect(showNotification(base, "Title", "Body")).toBe(true);
    expect(fake.shown.count).toBe(1);
    expect(reported).toEqual([]);
  });

  it("brings the window forward when the toast is clicked", () => {
    const onClick = vi.fn();
    const { base, fake } = deps({ onClick });
    showNotification(base, "Title", "Body");
    fake.listeners.get("click")!();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  // The branch that did not exist. Electron emits this on Windows when the OS
  // could not create or show the toast.
  it("reports a toast the platform refused, with the platform's own reason", () => {
    const { base, reported, fake } = deps();
    showNotification(base, "Title", "Body");
    expect(reported).toEqual([]);
    fake.listeners.get("failed")!({}, "toast could not be created");
    expect(reported).toHaveLength(1);
    expect(message(reported[0])).toContain("toast could not be created");
    expect(message(reported[0])).toContain("not shown");
  });

  it("reports a platform that supports no notifications, instead of shrugging", () => {
    const { base, reported, fake } = deps({ isSupported: () => false });
    expect(showNotification(base, "Title", "Body")).toBe(false);
    expect(fake.shown.count).toBe(0);
    expect(reported).toHaveLength(1);
    expect(message(reported[0])).toContain("no notification support");
  });

  // Constructing or showing one can throw. Letting that escape would take down
  // whatever produced the event — a completed transfer, say — rather than
  // merely failing to announce it.
  it("does not let a throwing constructor escape into the caller", () => {
    const { base, reported } = deps({
      create: () => {
        throw new Error("no toast for you");
      },
    });
    expect(() => showNotification(base, "Title", "Body")).not.toThrow();
    expect(showNotification(base, "Title", "Body")).toBe(false);
    expect(message(reported[0])).toContain("no toast for you");
  });

  it("does not let a throwing show() escape either", () => {
    const fake = fakeNotification();
    const reported: unknown[] = [];
    const base: NotifyDeps = {
      isSupported: () => true,
      create: () => ({ ...fake.handle, show: () => { throw new Error("show refused"); } }) as NotificationHandle,
      onClick: () => undefined,
      report: (err) => reported.push(err),
    };
    expect(() => showNotification(base, "Title", "Body")).not.toThrow();
    expect(message(reported[0])).toContain("show refused");
  });
});

describe("the page-reported notice set", () => {
  it("accepts every member at the boundary", () => {
    // The guard used to be a chain of comparisons, under a comment warning that
    // a restated set is how a new kind gets refused at the boundary while every
    // type checks. Adding `incoming-text` would have done exactly that: the
    // page would have sent it, the union would have allowed it, and main would
    // have thrown `unknown notice`.
    for (const notice of RESIDENT_NOTICES) {
      expect(isResidentNotice(notice), notice).toBe(true);
    }
  });

  it("refuses anything else", () => {
    for (const other of ["", "incoming-file", "INCOMING", "saved", "link-ready", null, 3, {}]) {
      expect(isResidentNotice(other), JSON.stringify(other)).toBe(false);
    }
  });

  it("keeps main's own events out of the page's set", () => {
    // `saved`, `failed` and `link-ready` are main's to raise. A page that could
    // claim "files saved" would be announcing something it cannot know.
    for (const mains of ["saved", "failed", "link-ready"]) {
      expect(isResidentNotice(mains), mains).toBe(false);
    }
  });
});
