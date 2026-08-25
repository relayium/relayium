import StoreKit
import XCTest
@testable import RelayiumStoreKit

final class StoreKitSubscriptionStoreTests: XCTestCase {
    private enum SentinelError: Error {
        case failure
    }

    func testThrownStoreKitUserCancellationBecomesCancelledResult() async throws {
        let result = try await StoreKitSubscriptionStore.normalizedPurchaseResult {
            throw StoreKitError.userCancelled
        }

        guard case .userCancelled = result else {
            return XCTFail("an explicit StoreKit cancellation was not normalized")
        }
    }

    func testOtherStoreKitErrorsStillPropagate() async {
        do {
            _ = try await StoreKitSubscriptionStore.normalizedPurchaseResult {
                throw StoreKitError.unknown
            }
            XCTFail("an ambiguous StoreKit error was widened into a cancellation")
        } catch let error as StoreKitError {
            guard case .unknown = error else {
                return XCTFail("the wrong StoreKit error escaped: \(error)")
            }
        } catch {
            XCTFail("the StoreKit error changed type: \(type(of: error))")
        }
    }

    func testNonStoreKitErrorsStillPropagate() async {
        do {
            _ = try await StoreKitSubscriptionStore.normalizedPurchaseResult {
                throw SentinelError.failure
            }
            XCTFail("an unrelated error was widened into a cancellation")
        } catch SentinelError.failure {
            // Expected: only Apple's typed cancellation is recoverable.
        } catch {
            XCTFail("the unrelated error changed type: \(type(of: error))")
        }
    }
}
