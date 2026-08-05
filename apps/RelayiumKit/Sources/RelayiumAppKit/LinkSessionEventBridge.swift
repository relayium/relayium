import Foundation

/// Carries one `LinkSessionRuntime`'s events from whatever thread produced them
/// onto the main actor, in order, one at a time, until the attempt they belong
/// to is over.
///
/// ## Why this exists at all
///
/// `LinkSessionRuntime` delivers on whichever thread is draining — see its
/// `onEvent` parameter, which says so explicitly — and a presentation model is
/// `@MainActor`. Something has to hop, and the two obvious ways of doing it are
/// both wrong:
///
///  - **A `Task { @MainActor in ... }` per event.** Nothing orders two
///    independent tasks, so a runtime that decided `sas` before `opened` can
///    paint them in either order. The bug this produces is not a crash; it is a
///    screen that shows the wrong digits, occasionally, under load.
///  - **Requiring the model to be bound before anything can be published.** That
///    is safe only for a producer that provably cannot speak before its screen
///    exists, and it is not a property of this seam. Today's
///    `LinkSessionRuntime` happens to be such a producer — it installs the
///    transport's four callbacks in its own initializer, its seam expressly
///    forbids a conformer from calling back from those setters, and every
///    publication path is gated on a state only `start()` sets — so as things
///    stand nothing is published inside that initializer. But a factory is free
///    to change that: one that establishes eagerly, or that reports a failure it
///    hit while assembling the runtime, produces events before the presentation
///    owner has been constructed, let alone bound. A bridge that could only be
///    bound first would turn that into a silent loss of the FIRST event, which
///    is the one that decides what the screen opens as.
///
///    So late binding here is a defensive, directly testable property rather
///    than a description of what the current runtime does — see
///    `LinkSessionEventBridgeTests`, which publishes before binding on purpose.
///
/// So this is the same mailbox `LinkSessionRuntime` already runs internally
/// (one lock, one queue, one consumer), with the consumer pinned to the main
/// actor and with a bind step that is allowed to arrive late.
///
/// ## The contract
///
///  - `publish` is callable from any thread, including from inside a delivery.
///  - Deliveries happen on the main actor, one at a time, in publication order,
///    and never nested inside one another.
///  - Events published before `bind` are kept and delivered after it, in order.
///    `bind` itself delivers nothing inline.
///  - `bind` takes effect once. A second one is inert in every build: it takes
///    no ownership, receives nothing, and leaves the first binding untouched.
///  - The wrapper `bind` stores captures the explicit owner weakly, so a handler
///    that uses the supplied `owner` parameter and does not separately capture
///    that owner strongly leaves the bridge holding no strong reference to it.
///  - `invalidate` is terminal, idempotent, callable from any thread, and never
///    calls the handler — not even for the events it drops.
///
/// ## Threading
///
/// A leaf: `lock` guards `pending`, `handler`, `scheduled` and `invalidated`,
/// and NOTHING is held while a handler runs. That is what lets a handler call
/// straight back into `publish` — on a non-recursive `NSLock`, a handler running
/// under the lock would deadlock on exactly that call.
///
/// The same rule is why `bind` refuses a second binding instead of overwriting:
/// an overwrite would release the stored closure — and transitively run whatever
/// its captures' `deinit`s do — inside this object's critical section.
///
/// One bridge belongs to one attempt. A superseded attempt is invalidated, and
/// its replacement gets its own bridge; rebinding this one is a programmer error
/// rather than a supported way to move a screen between runtimes.
final class LinkSessionEventBridge: @unchecked Sendable {

    /// Guards everything below, which all have to agree.
    private let lock = NSLock()

    /// Events admitted but not yet delivered, in the order they were admitted.
    private var pending: [LinkSessionRuntimeEvent] = []

    /// Where they go, once somebody is there to take them: `bind`'s wrapper,
    /// which holds the explicit owner weakly. `nil` before `bind` and again after
    /// `invalidate` — the second one is what releases whatever the model's
    /// handler captured.
    private var handler: (@MainActor (LinkSessionRuntimeEvent) -> Void)?

    /// Whether a consumer is already on its way to the main actor. This single
    /// flag is the whole ordering mechanism: while it is true, a publish only
    /// appends, because the drain that is already coming will pick the event up.
    private var scheduled = false

    /// Terminal. Set once, never cleared.
    private var invalidated = false

    /// How many consumers this bridge has scheduled over its whole life.
    ///
    /// Instrumentation, and it exists because the property that matters most
    /// here — ONE consumer, not one per event — has no other observable form. A
    /// bridge that spawned a task per event would still deliver in order, since
    /// they all drain the same FIFO queue, so every behavioural test would pass
    /// and the regression would only show up as contention under load. The
    /// counter makes it a thing a test can simply read.
    var scheduledDrains: Int {
        lock.lock()
        defer { lock.unlock() }
        return _scheduledDrains
    }
    private var _scheduledDrains = 0

    init() {}

    /// Admit one event, from any thread.
    ///
    /// Callable from inside a delivery: the event is appended and consumed by
    /// the drain that is already running, behind the one being handled, rather
    /// than nested inside it.
    func publish(_ event: LinkSessionRuntimeEvent) {
        lock.lock()
        guard !invalidated else { lock.unlock(); return }
        pending.append(event)
        // Nobody bound yet means nobody to wake: `bind` starts the drain for
        // whatever accumulated before it.
        let wake = handler != nil && !scheduled
        if wake {
            scheduled = true
            _scheduledDrains += 1
        }
        lock.unlock()

        // OUTSIDE the lock, always. A `Task` construction that ran under it
        // would put an executor hop inside this object's critical section.
        guard wake else { return }
        Task { @MainActor [weak self] in self?.drain() }
    }

    /// Bind the owner this bridge paints, and hand it everything that has
    /// already accumulated.
    ///
    /// Deliberately `@MainActor` and deliberately not delivering inline: the
    /// caller is a model being constructed, and running a whole event stream
    /// inside its own construction is exactly the re-entrancy this type exists
    /// to remove. The queued events arrive on the next main-actor turn instead.
    ///
    /// ## The explicit owner is captured weakly
    ///
    /// The owner arrives as a PARAMETER of the handler and the wrapper stored
    /// here captures THAT owner weakly, so the standard form
    ///
    /// ```swift
    /// bridge.bind(to: self) { owner, event in owner.apply(event) }
    /// ```
    ///
    /// is cycle-free without the caller writing `[weak self]`. The guarantee is
    /// exactly that and no more: Swift cannot stop a handler body from capturing
    /// `self` — or the same owner under another name — strongly on its own, and
    /// such a capture is retained by this bridge like any other. Callers should
    /// therefore reach the owner through the supplied parameter and must not
    /// separately capture it strongly.
    ///
    /// Bound that way, a runtime that outlives its screen cannot keep that screen
    /// alive, and delivering into an owner that has gone is a no-op rather than a
    /// resurrection. That no-op is not a substitute for retirement: an attempt
    /// that is over still calls `invalidate`, which is what drops the queue and
    /// releases the handler — including anything it did capture strongly.
    ///
    /// The wrapper captures the owner and the handler, and NOT this bridge —
    /// a bridge that appeared in its own stored closure would be a cycle of its
    /// own, and the drain has `self` already.
    ///
    /// ## Once
    ///
    /// Bound once, enforced rather than asserted: a second `bind` is refused in
    /// every build, so a Release binary cannot quietly hand this attempt's stream
    /// to a second owner (nor release the first owner's closure under `lock`).
    /// It is deliberately NOT an `assert` as well — the only proof that the
    /// refusal works is a test that calls `bind` twice, and a debug trap would
    /// make that test unrunnable in the configuration tests actually run in.
    ///
    /// Binding after `invalidate` is refused too, because a finished attempt has
    /// nothing to give anybody.
    @MainActor
    func bind<Owner: AnyObject>(to owner: Owner,
                                _ handler: @escaping @MainActor (Owner, LinkSessionRuntimeEvent) -> Void) {
        let wrapper: @MainActor (LinkSessionRuntimeEvent) -> Void = { [weak owner] event in
            guard let owner else { return }
            handler(owner, event)
        }

        lock.lock()
        guard !invalidated else { lock.unlock(); return }
        // Refused, not replaced: see above. `wrapper` and the handler it captured
        // are released when this call returns, which is outside the lock.
        guard self.handler == nil else { lock.unlock(); return }
        self.handler = wrapper
        let wake = !pending.isEmpty && !scheduled
        if wake {
            scheduled = true
            _scheduledDrains += 1
        }
        lock.unlock()

        guard wake else { return }
        Task { @MainActor [weak self] in self?.drain() }
    }

    /// End this bridge, from any thread, as many times as anybody likes.
    ///
    /// Everything still queued is dropped and the handler is released. A drain
    /// already scheduled finds nothing to do, one already running stops after
    /// the event it is on, and any later publish is refused. The handler is
    /// never called on this path — a retired attempt has nothing left to say to
    /// a model it no longer owns.
    func invalidate() {
        lock.lock()
        invalidated = true
        pending.removeAll()
        // Moved out rather than dropped in place: releasing it here would run
        // arbitrary `deinit` code — the model's, transitively — under the lock.
        let released = handler
        handler = nil
        lock.unlock()

        withExtendedLifetime(released) {}
    }

    /// The ONE consumer. Takes one event at a time, with `lock` released across
    /// every call out.
    ///
    /// The loop re-reads `pending` under the lock on every turn, so an event a
    /// handler published re-entrantly is picked up here rather than nesting a
    /// second delivery. It exits only while holding the lock, clearing
    /// `scheduled` in the same critical section that observed the queue empty —
    /// which is what makes a lost wakeup impossible: a publisher either appends
    /// before that observation, and this loop takes the event, or after it, and
    /// finds `scheduled == false` and starts a new consumer.
    @MainActor
    private func drain() {
        while true {
            lock.lock()
            guard !invalidated, !pending.isEmpty, let handler else {
                scheduled = false
                lock.unlock()
                return
            }
            let event = pending.removeFirst()
            lock.unlock()

            handler(event)
        }
    }
}
