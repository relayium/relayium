import Foundation
import RelayiumKit

public enum BrowserLoginState: Equatable {
    case idle
    case starting
    case waiting(approvalURL: URL)
    case failed(String)
}

/// Drives start → poll → token for the browser-delegated login.
///
/// It publishes the URL to open rather than opening it: presentation needs a
/// window, and keeping that out of here is what leaves every decision testable.
@MainActor
public final class BrowserLoginModel: ObservableObject {
    @Published public private(set) var state: BrowserLoginState = .idle
    /// The last approval URL handed out, kept after the run ends so a view (and
    /// a test) can read what was opened without racing the state machine.
    @Published public private(set) var lastApprovalURL: URL?

    private let client: DeviceAuthClient
    /// Operation identity, as everywhere else in this layer: a callback from a
    /// run the user has abandoned must not resurrect it.
    private var generation = 0

    public init(client: DeviceAuthClient) { self.client = client }

    /// Runs to a terminal state. `onToken` fires once, on success only.
    public func begin(onToken: (String) -> Void) async {
        generation += 1
        let g = generation
        state = .starting
        do {
            let s = try await client.start()
            guard g == generation else { return }
            lastApprovalURL = s.approvalURL
            state = .waiting(approvalURL: s.approvalURL)

            let deadline = Date().addingTimeInterval(TimeInterval(s.expiresIn))
            while Date() < deadline {
                guard g == generation, !Task.isCancelled else { return }
                let outcome = try await client.poll(deviceCode: s.deviceCode)
                // Re-checked after the await: a sheet closed mid-poll bumps the
                // generation, and the token that arrives belongs to nobody.
                guard g == generation else { return }
                switch outcome {
                case .pending:
                    // The server sets the floor; polling faster earns a 429.
                    try await Task.sleep(nanoseconds: UInt64(s.interval) * 1_000_000_000)
                case .denied:
                    state = .failed(ErrorCopy.message(for: DeviceAuthOutcomeError.denied))
                    return
                case .expired:
                    state = .failed(ErrorCopy.message(for: DeviceAuthOutcomeError.expired))
                    return
                case .ok(let token, _):
                    // Handed out exactly once by the server; never poll again.
                    state = .idle
                    onToken(token)
                    return
                }
            }
            guard g == generation else { return }
            state = .failed(ErrorCopy.message(for: DeviceAuthOutcomeError.expired))
        } catch is CancellationError {
            guard g == generation else { return }
            state = .idle
        } catch {
            guard g == generation else { return }
            state = .failed(ErrorCopy.message(for: error))
        }
    }

    /// Closing the sheet. Bumping the generation is the load-bearing half: the
    /// loop is usually parked in a sleep or a request, and it must not resume
    /// into a screen the user has left.
    public func cancel() {
        generation += 1
        state = .idle
    }
}
