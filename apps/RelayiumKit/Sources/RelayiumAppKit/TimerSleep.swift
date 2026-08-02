import Foundation

/// The real delay behind every cancellable timer in this package: the nearby
/// answer timeouts, the text idle timer, and the room reconnect backoff.
///
/// It is a named function, and the models that use it take an *optional*
/// closure resolved against it, rather than the obvious
/// `sleep: @escaping @Sendable (UInt64) async -> Void = { … }`.
///
/// That shape is not a preference. An `async` closure literal in a
/// default-argument position is miscompiled in unoptimised builds: the task
/// allocator's LIFO discipline is violated when the task that ran it completes,
/// and the process aborts with "freed pointer was not the last allocation" —
/// on completion, not only on cancellation. Reproduced on Swift 5.9 /
/// Xcode 16.4 with exactly the previous `RealtimeSessionModel` shape; the same
/// body passed explicitly at the call site is fine, and an optimised build is
/// fine, which is why it survived the release-mode gates and only ever showed
/// up in a Debug run of a nearby transfer or a text session.
///
/// So: no `async` closure literal may be a default argument in this package.
/// Injecting a test double still works exactly as before — the parameter simply
/// accepts `nil` for "use the real one".
@Sendable
func realSleep(_ nanoseconds: UInt64) async {
    try? await Task.sleep(nanoseconds: nanoseconds)
}
