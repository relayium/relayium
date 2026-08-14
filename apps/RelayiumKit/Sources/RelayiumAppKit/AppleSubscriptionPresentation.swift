import Foundation
import RelayiumKit
import RelayiumShareKit

/// How this copy of Relayium reached the user.
///
/// **It decides what the account screen may offer, and that is a compliance
/// boundary rather than a preference.** An App Store build may not send a user
/// to a website to buy the thing it sells; a direct-download build has no
/// in-app purchase to offer and must keep the link it has always had. One value
/// answers both, so the two builds cannot end up with three-quarters of each
/// other's surface.
///
/// It lives in the package rather than in the app so the rules below are
/// reachable from `swift test`. Which value a given binary carries is decided in
/// the app, by target membership — see `AppDistribution` in the macOS target —
/// because that is the only thing a build setting can actually change.
public enum AppDistributionChannel: String, Sendable, CaseIterable, Equatable {
    /// Signed with Developer ID, notarized, downloaded from relayium.com, and
    /// updated by Sparkle. Billing is on the web, where it always has been.
    case directDownload
    /// Distributed by Apple, updated by the App Store, and billed by StoreKit.
    case macAppStore
    /// The iOS app is distributed and billed only through the App Store.
    case iosAppStore

    /// Whether this build sells subscriptions itself.
    public var offersInAppPurchase: Bool {
        switch self {
        case .directDownload: return false
        case .macAppStore, .iosAppStore: return true
        }
    }

    /// Whether the account screen may link out to the website's pricing page.
    ///
    /// **False for the App Store build, and the inverse of the line above by
    /// construction rather than by coincidence.** Two independent booleans could
    /// both be false — an account screen with no way to change a plan at all —
    /// or both true, which is the App Store rule this exists to keep.
    public var showsWebPlanHandoff: Bool { !offersInAppPurchase }
}

/// One purchasable row, already worded.
public struct AppleSubscriptionOfferRow: Equatable, Identifiable, Sendable {
    /// What a purchase is started by.
    public let productID: String
    /// The tier's name, as this deployment names it.
    public let title: String
    /// The store's own price, placed into this language's per-period sentence.
    /// The NUMBER and CURRENCY are Apple's and are never reformatted here.
    public let price: String
    /// Which billing period this row IS — "Monthly" / "Yearly" — as a label of
    /// its own, not only as part of the price sentence.
    ///
    /// It is separate copy because the two products of one tier are otherwise
    /// distinguishable only by their prices, and a reader scanning four rows of
    /// the same tier name is choosing a commitment length, not a number.
    /// `""` for a cycle this build has no word for, which is the same refusal
    /// ``price(_:cycle:language:)`` makes: a WRONG period is a false statement
    /// about what is being agreed to, and a missing one is merely incomplete.
    public let cycleLabel: String
    /// What the tier grants, in this language — storage and monthly traffic.
    ///
    /// `nil` when the server did not say (a deployment older than the catalog's
    /// quota fields). The surface then renders nothing rather than a figure it
    /// made up: an app that carried its own copy of "Pro means 5 GB" would
    /// eventually print a quantity beside Apple's real price that the
    /// deployment does not actually grant.
    public let entitlements: String?
    /// Whether this row's tier AND billing period are the ones the account
    /// already holds.
    ///
    /// Both halves are required. The same tier on the other billing period is a
    /// different product, a real purchase and a real charge, so labelling it
    /// "current" would tell a monthly subscriber that the yearly plan they are
    /// looking at is something they already have.
    public let isCurrentPlan: Bool
    /// Whether this row may start a purchase.
    ///
    /// The inverse of ``isCurrentPlan``, stated as its own field rather than
    /// left for each surface to re-derive: buying the exact product an account
    /// already holds is a second charge for what it is already paying for, and
    /// two view layers deriving that rule independently is how one of them ends
    /// up not deriving it. Eligibility and busy-ness are separate gates the
    /// surface still applies on top.
    public let offersSubscribe: Bool

    public var id: String { productID }
}

/// A sentence the purchase surface shows about itself, and how it should look.
///
/// The KIND is here rather than in the view because it is part of the statement:
/// "the store is thinking" and "the store refused" are not the same message with
/// different colours, and a view that chose the symbol would be making that
/// judgement in a place no test can read.
public enum AppleSubscriptionNotice: Equatable, Sendable {
    /// Something is in flight. The view renders a spinner with this label.
    case progress(String)
    /// True, and nothing is wrong.
    case info(String)
    /// It worked.
    case success(String)
    /// It did not.
    case failure(String)

    public var text: String {
        switch self {
        case .progress(let t), .info(let t), .success(let t), .failure(let t): return t
        }
    }
}

/// Every word the in-app purchase surface says, chosen in one place.
///
/// The surface itself is a handful of SwiftUI rows; everything that decides
/// WHICH sentence is right for a given state is here, because those decisions
/// are the ones with consequences — telling somebody their purchase failed when
/// the App Store will simply deliver it again, or offering a second
/// subscription to somebody already paying through the web.
public enum AppleSubscriptionPresentation {

    /// The rows to render, in the server's tier order.
    ///
    /// `currentPlanID` and `currentCycle` are the account's own plan and
    /// billing period from `/api/me` — the authoritative projection — and never
    /// anything this layer derived from a purchase. A device does not decide
    /// what it holds.
    public static func offerRows(_ offers: [AppleSubscriptionOffer],
                                 currentPlanID: String,
                                 currentCycle: String,
                                 language: AppLanguage? = nil) -> [AppleSubscriptionOfferRow] {
        offers.map { offer in
            // BOTH halves have to match, and both have to be non-empty.
            //
            // '' as a plan id is the free tier and every signed-in account that
            // has never subscribed, so it must never match: marking "Free" as
            // the current plan on a paid row is exactly backwards. '' as a cycle
            // is an account whose billing period could not be resolved — a
            // migrated source, or a cancellation that carried no price — and it
            // must not match either, because "unknown" is not "the one you are
            // looking at". The row then simply carries no badge, and the account
            // can still buy, which is the safe direction: the alternative marks
            // a product current on the strength of a field nobody could read.
            let isCurrent = !currentPlanID.isEmpty && !currentCycle.isEmpty
                && offer.product.planId == currentPlanID
                && offer.product.cycle == currentCycle
            return AppleSubscriptionOfferRow(
                productID: offer.product.productId,
                title: offer.product.planName,
                price: price(offer.store.displayPrice, cycle: offer.product.cycle,
                             language: language),
                cycleLabel: cycleLabel(offer.product.cycle, language: language),
                entitlements: entitlements(storageBytes: offer.product.storageBytes,
                                           trafficBytes: offer.product.trafficBytes,
                                           language: language),
                isCurrentPlan: isCurrent,
                // The exact product an account already holds may not be bought
                // again — that is a second charge for the thing it is already
                // paying for. The other cycle of the same tier is a different
                // product and stays purchasable, which is how an Apple
                // subscriber switches between monthly and yearly at all.
                offersSubscribe: !isCurrent)
        }
    }

    /// The billing period as a label of its own.
    ///
    /// An unrecognised cycle yields `""` rather than a guess, on the same rule
    /// ``price(_:cycle:language:)`` follows: a wrong period is a false statement
    /// about the commitment being made.
    public static func cycleLabel(_ cycle: String,
                                  language: AppLanguage? = nil) -> String {
        switch cycle {
        case "monthly": return L10n.t(.subscriptionCycleMonthly, language: language)
        case "yearly":  return L10n.t(.subscriptionCycleYearly, language: language)
        default:        return ""
        }
    }

    /// What a tier grants, worded: storage and monthly traffic.
    ///
    /// `nil` when the server sent neither figure — a deployment older than the
    /// catalog's quota fields. **Not zero-filled**: `0` is the wire spelling of
    /// UNLIMITED (the same convention `/api/me/usage` uses), so treating an
    /// absent field as `0` would advertise an unlimited plan on every server
    /// that has not been updated.
    ///
    /// The bytes go through `L10n.bytes`, the one primitive the account meters
    /// already use, so the same tier reads the same way on the plan card above
    /// this surface and in the offer row below it.
    public static func entitlements(storageBytes: Int64?,
                                    trafficBytes: Int64?,
                                    language: AppLanguage? = nil) -> String? {
        guard let storageBytes, let trafficBytes else { return nil }
        return L10n.t(.subscriptionEntitlements,
                      [quantity(storageBytes, language: language),
                       quantity(trafficBytes, language: language)],
                      language: language)
    }

    /// A byte cap in words: the figure, or "Unlimited" for the 0 the wire uses.
    private static func quantity(_ bytes: Int64, language: AppLanguage? = nil) -> String {
        bytes <= 0 ? L10n.t(.usageUnlimited, language: language)
                   : L10n.bytes(bytes, language: language)
    }

    /// The store's price inside this language's per-period phrase.
    ///
    /// An unrecognised cycle falls back to the bare price rather than guessing a
    /// period. A wrong period beside a real number is a false statement about
    /// what the user is agreeing to pay; a price with no period is merely
    /// incomplete, and the store's own sheet states the period again before
    /// anything is charged.
    public static func price(_ displayPrice: String,
                             cycle: String,
                             language: AppLanguage? = nil) -> String {
        switch cycle {
        case "monthly":
            return L10n.t(.subscriptionPriceMonthly, [L10n.token(displayPrice, language: language)],
                          language: language)
        case "yearly":
            return L10n.t(.subscriptionPriceYearly, [L10n.token(displayPrice, language: language)],
                          language: language)
        default:
            return L10n.token(displayPrice, language: language)
        }
    }

    /// What the surface says about its current state, or `nil` when the state
    /// speaks for itself through the controls alone.
    ///
    /// `.idle` and `.unavailable` return nothing here on purpose: idle is the
    /// ordinary screen with buttons on it, and "nothing on sale" is rendered by
    /// the caller in place of the list rather than as a message beside it.
    public static func notice(for state: AppleSubscriptionState,
                              language: AppLanguage? = nil) -> AppleSubscriptionNotice? {
        switch state {
        case .idle, .unavailable:
            return nil
        case .purchasesPaused:
            // `.info`, never `.failure`: nothing went wrong, nothing was
            // charged, and there is nothing for the user to retry or repair.
            // The sentence says it is temporary and that existing subscriptions
            // are untouched, because the two questions somebody reading it is
            // about to ask are "is it me?" and "did I lose what I paid for?".
            return .info(L10n.t(.subscriptionPaused, language: language))
        case .loadingOffers:
            return .progress(L10n.t(.subscriptionLoading, language: language))
        case .purchasing:
            return .progress(L10n.t(.subscriptionPurchasing, language: language))
        case .submitting:
            // Named apart from `purchasing` because this is the interval after
            // Apple has charged and before Relayium has recorded it. Saying
            // "waiting for the App Store" here would be false at the one moment
            // a user most needs the truth.
            return .progress(L10n.t(.subscriptionSubmitting, language: language))
        case .restoring:
            return .progress(L10n.t(.subscriptionRestoring, language: language))
        case .deferred:
            // `.info`, never `.failure`: Ask to Buy is the feature working. No
            // transaction exists yet, so nothing was charged and nothing failed.
            return .info(L10n.t(.subscriptionDeferred, language: language))
        case .nothingToRestore:
            return .info(L10n.t(.subscriptionNothingToRestore, language: language))
        case .completed:
            return .success(L10n.t(.subscriptionCompleted, language: language))
        case .failed(let failure):
            return .failure(message(for: failure, language: language))
        }
    }

    /// One sentence per way a purchase can fail to become an entitlement.
    ///
    /// **The recurring clause is the load-bearing one.** Most of these refusals
    /// leave an unfinished transaction that the App Store will deliver again —
    /// the money moved, and the purchase is not lost — and a message that said
    /// only "something went wrong" would send a paying customer to support, or
    /// worse, to buying it a second time. The four that are NOT self-repairing
    /// (another account owns it, another account owns the subscription, this
    /// account has a second Apple subscription, or this build cannot sell) say
    /// what the user has to do instead.
    public static func message(for failure: AppleSubscriptionFailure,
                               language: AppLanguage? = nil) -> String {
        switch failure {
        case .purchaseNotAllowed(let blockedBy):
            return blockedNotice(blockedBy: blockedBy, language: language)
        case .purchasesPaused:
            // The same sentence the paused SURFACE shows, deliberately. This
            // case is only reachable by racing the operator — the screen was
            // drawn while the server was selling — and the user's situation is
            // identical to somebody who opened the screen a second later, so
            // reading a second, differently-worded explanation of it would
            // suggest something else had gone wrong. Nothing was charged.
            return L10n.t(.subscriptionPaused, language: language)
        case .selectionChanged:
            // The offer on screen is no longer what the server sells — retired,
            // remapped, or answered for another app — and nothing was charged.
            // Reuses the already-localized "nothing on sale" sentence: this
            // batch may not add localization keys, and that sentence is the
            // truthful one available — the thing on screen cannot be
            // subscribed to right now.
            return L10n.t(.subscriptionNone, language: language)
        case .unexpected(let type):
            // The type NAME, isolated as a token: it is diagnostic material in a
            // sentence, and it is the only thing carried out of a store error —
            // a StoreKit message can name a product, an account or a receipt.
            return L10n.t(.subscriptionErrorStore, [L10n.token(type, language: language)],
                          language: language)
        case .billing(let error):
            switch error {
            case .notSignedIn:
                return L10n.t(.subscriptionErrorNotSignedIn, language: language)
            case .network:
                return L10n.t(.subscriptionErrorNetwork, language: language)
            case .rateLimited:
                return L10n.t(.subscriptionErrorBusy, language: language)
            case .invalidTransaction, .decoding:
                // Together on purpose. A refused JWS and an answer nobody could
                // read are the same fact to the user — Relayium has not taken
                // this purchase yet — and the same repair applies to both: the
                // store offers it again.
                return L10n.t(.subscriptionErrorNotAccepted, language: language)
            case .tokenMismatch:
                return L10n.t(.subscriptionErrorOtherAccount, language: language)
            case .subscriptionOwned:
                return L10n.t(.subscriptionErrorAlreadyLinked, language: language)
            case .appleSubscriptionConflict:
                return L10n.t(.subscriptionErrorAppleConflict, language: language)
            case .verifierUnavailable:
                return L10n.t(.subscriptionErrorNotReady, language: language)
            case .unknownBundle:
                return L10n.t(.subscriptionErrorWrongBuild, language: language)
            case .server(let status):
                return L10n.t(.subscriptionErrorServer,
                              [L10n.token(String(status), language: language)],
                              language: language)
            }
        }
    }

    /// Why this account may not buy, or `nil` when it may.
    ///
    /// `nil` eligibility — no catalog has been read, or the read failed — is
    /// deliberately silent rather than a refusal notice. The surface is showing
    /// its own loading or failure state at that moment, and a second sentence
    /// claiming the subscription is managed elsewhere would be a guess.
    public static func eligibilityNotice(_ purchase: AppleCatalogPurchase?,
                                         language: AppLanguage? = nil) -> String? {
        guard let purchase, !purchase.allowed else { return nil }
        return blockedNotice(blockedBy: purchase.blockedBy, language: language)
    }

    /// The provider vocabulary the server answers with, worded.
    ///
    /// An unrecognised value — including `""` — gets the general sentence rather
    /// than being treated as permission. This layer never turns "I do not
    /// recognise this" into "go ahead and pay".
    private static func blockedNotice(blockedBy: String,
                                      language: AppLanguage? = nil) -> String {
        switch blockedBy {
        case "stripe": return L10n.t(.subscriptionBlockedByWeb, language: language)
        case "admin":  return L10n.t(.subscriptionBlockedByAdmin, language: language)
        case "apple":  return L10n.t(.subscriptionBlockedByAppleApp, language: language)
        default:       return L10n.t(.subscriptionBlockedByOther, language: language)
        }
    }

    /// Whether the "manage in the App Store" control belongs on screen.
    ///
    /// It is shown when APPLE is the live provider, from `/api/me`'s own
    /// `entitlementProvider`, and not merely because this build can sell. Two
    /// consequences worth stating:
    ///
    ///  - `"multiple"` counts. A double-billed account has a real App Store
    ///    subscription, and the one place it can be cancelled is the App Store;
    ///    hiding the control would leave the user unable to stop the very
    ///    charge they most want to stop.
    ///  - a Stripe-only or free account does not get it. The control leads to a
    ///    subscriptions list that would not have Relayium in it.
    public static func showsAppleManagement(entitlementProvider: String) -> Bool {
        entitlementProvider == "apple" || entitlementProvider == "multiple"
    }
}
