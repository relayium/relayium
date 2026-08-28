import Foundation
import RelayiumAppKit
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

// MARK: - resolve, then authorize, then charge

/// **What the ordering helper actually did, in the order it did it.**
///
/// `resolveAuthorizeThenPurchase` is generic over what is resolved and what
/// charging answers for exactly this reason: the adapter's ordering claim
/// becomes executable under `swift test` with no StoreKit, no network and no
/// Apple account — three closures that write their own name down, and a test
/// that reads the list back.
private final class OrderingRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var _steps: [String] = []
    private var _chargedResolved: [String] = []
    private var _chargedTokens: [UUID] = []

    var steps: [String] { locked { _steps } }
    var chargedResolved: [String] { locked { _chargedResolved } }
    var chargedTokens: [UUID] { locked { _chargedTokens } }

    func recordResolve() { locked { _steps.append("resolve") } }
    func recordAuthorize() { locked { _steps.append("authorize") } }
    func recordCharge(_ resolved: String, _ token: UUID) {
        locked {
            _steps.append("charge")
            _chargedResolved.append(resolved)
            _chargedTokens.append(token)
        }
    }

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}

/// **The one boundary a purchase attempt cannot cross twice.**
///
/// Resolving the product is a call to Apple that fails routinely and provably
/// without charging anybody. Authorizing is the call that arms one sheet on
/// Relayium's server, after which no failure on the device can prove whether
/// Apple charged — so the attempt is reported `failed` and locked, and a locked
/// account cannot buy anything until an operator intervenes.
///
/// These tests state, executably, that the helper every production purchase
/// goes through puts the lookup on the safe side of that boundary and leaves
/// nothing at all on the far side of it except the charge itself.
extension StoreKitSubscriptionStoreTests {

    private static var mintedToken: UUID {
        UUID(uuidString: "3f2504e0-4f89-41d3-9a0c-0305e82c3301")!
    }

    /// The order, and that the token minted by `authorize` is the one charging
    /// is handed — attribution is passed through, never re-derived.
    func testTheHelperResolvesThenAuthorizesThenCharges() async throws {
        let recorder = OrderingRecorder()
        let token = Self.mintedToken

        let charged = try await StoreKitSubscriptionStore.resolveAuthorizeThenPurchase(
            resolve: { () -> String? in
                recorder.recordResolve()
                return "product-A"
            },
            unresolved: SentinelError.failure,
            authorize: {
                recorder.recordAuthorize()
                return token
            },
            charge: { (resolved: String, token: UUID) -> String in
                recorder.recordCharge(resolved, token)
                return "charged:\(resolved)"
            })

        XCTAssertEqual(recorder.steps, ["resolve", "authorize", "charge"],
                       "the adapter no longer resolves before it arms a sheet")
        XCTAssertEqual(recorder.chargedResolved, ["product-A"],
                       "charging did not receive what was resolved")
        XCTAssertEqual(recorder.chargedTokens, [token],
                       "charging was attributed to a token nobody minted for it")
        XCTAssertEqual(charged, "charged:product-A")
    }

    /// **A product that does not resolve arms nothing.**
    ///
    /// This is the defect this seam exists to close: while the attribution token
    /// was a plain parameter, a storefront that does not carry the identifier
    /// threw AFTER the arm, and a post-arm throw is ambiguous about money — so
    /// it locked the account out of buying anything at all.
    func testAnUnresolvedProductNeverAuthorizesAndNeverCharges() async {
        let recorder = OrderingRecorder()
        do {
            _ = try await StoreKitSubscriptionStore.resolveAuthorizeThenPurchase(
                resolve: { () -> String? in
                    recorder.recordResolve()
                    return nil
                },
                unresolved: StoreKitSubscriptionStore.StoreKitStoreError.productUnavailable,
                authorize: {
                    XCTFail("an unresolved product still armed a sheet")
                    return Self.mintedToken
                },
                charge: { (_: String, _: UUID) -> String in
                    XCTFail("an unresolved product still reached the charge")
                    return ""
                })
            XCTFail("a product that resolved to nothing still completed a purchase")
        } catch StoreKitSubscriptionStore.StoreKitStoreError.productUnavailable {
            // Expected: the caller's own unavailable error, raised before the arm.
        } catch {
            XCTFail("an unresolved product failed with the wrong error: \(error)")
        }

        XCTAssertEqual(recorder.steps, ["resolve"])
    }

    /// A lookup that throws — a device with no network, most often — is on the
    /// same side of the boundary, and propagates unchanged so the app can see
    /// it for what it is.
    func testAResolveFailureNeverAuthorizesAndNeverCharges() async {
        let recorder = OrderingRecorder()
        do {
            _ = try await StoreKitSubscriptionStore.resolveAuthorizeThenPurchase(
                resolve: { () -> String? in
                    recorder.recordResolve()
                    throw SentinelError.failure
                },
                unresolved: StoreKitSubscriptionStore.StoreKitStoreError.productUnavailable,
                authorize: {
                    XCTFail("a failed lookup still armed a sheet")
                    return Self.mintedToken
                },
                charge: { (_: String, _: UUID) -> String in
                    XCTFail("a failed lookup still reached the charge")
                    return ""
                })
            XCTFail("a lookup failure still completed a purchase")
        } catch SentinelError.failure {
            // Expected: the lookup's own error, and no arm behind it.
        } catch {
            XCTFail("the lookup failure changed type: \(type(of: error))")
        }

        XCTAssertEqual(recorder.steps, ["resolve"])
    }

    /// **The app's refusal opens no sheet, and reaches the app unchanged.**
    ///
    /// `authorize` is called outside `normalizedPurchaseResult` precisely so
    /// this stays true: that helper turns Apple's typed cancellation into a
    /// cancelled *result*, and a refusal raised above this seam is not a user
    /// cancelling a sheet that was never opened.
    func testAnAuthorizationRefusalNeverCharges() async {
        let recorder = OrderingRecorder()
        do {
            _ = try await StoreKitSubscriptionStore.resolveAuthorizeThenPurchase(
                resolve: { () -> String? in
                    recorder.recordResolve()
                    return "product-A"
                },
                unresolved: SentinelError.failure,
                authorize: {
                    recorder.recordAuthorize()
                    throw StorePurchaseAuthorizationRefused.refused
                },
                charge: { (_: String, _: UUID) -> String in
                    XCTFail("a refused authorization still charged")
                    return ""
                })
            XCTFail("a refused authorization still completed a purchase")
        } catch StorePurchaseAuthorizationRefused.refused {
            // Expected: the app's own refusal, neither widened nor swallowed.
        } catch {
            XCTFail("the refusal reached the app as something else: \(error)")
        }

        XCTAssertEqual(recorder.steps, ["resolve", "authorize"])
    }
}
