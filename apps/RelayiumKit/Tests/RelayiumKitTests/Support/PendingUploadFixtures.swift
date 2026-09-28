import Foundation
@testable import RelayiumAppKit
@testable import RelayiumKit

extension PendingUploadStore {
    /// Put a protected-root delivery into the state a finalized upload leaves:
    /// a recorded session, its finalizing phase, and the object — through the
    /// same compare-and-set writes the coordinator uses, so a fixture can never
    /// fabricate a state production cannot reach.
    @discardableResult
    func fixtureFinalized(_ plan: PendingUploadPlan, storedId: String,
                          uploadId: String = "FIXTURESESSION01") throws -> PendingUploadPlan {
        var current = ownedDevicePlan(jobId: plan.jobId) ?? plan
        if current.uploadId == nil {
            current = try setUploadSession(id: uploadId, chunkSize: 64 * 1024, for: current)
        }
        let session = try XCTUnwrapFixture(current.uploadId)
        current = try markFinalizing(uploadId: session, for: current)
        return try markFinalized(current, storedId: storedId, uploadId: session)
    }
}

struct FixtureError: Error {}

func XCTUnwrapFixture<T>(_ value: T?) throws -> T {
    guard let value else { throw FixtureError() }
    return value
}
