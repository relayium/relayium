import XCTest
import RelayiumKit
@testable import RelayiumAppKit

/// The form is ONE view across "typing", "signing in" and "that was wrong",
/// because its email and password are `@State` and each branch of a SwiftUI
/// `switch` is a distinct structural identity — a second branch blanks both
/// fields on every wrong password. Making that one `if let` in the view means
/// the decision lives here, where these assertions can reach it.
final class SignInPresentationTests: XCTestCase {
    private func fixture<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json"))
        return try JSONDecoder().decode(type, from: try Data(contentsOf: url))
    }

    private func readyState() throws -> SessionState {
        let me = try fixture("me", as: MeResponse.self)
        let usage = try fixture("me-usage", as: UsageResponse.self)
        return .ready(user: me.user, usage: usage)
    }

    func testTheFormOwnsExactlyFourStates() throws {
        XCTAssertNotNil(SignInPresentation.form(for: .loggedOut))
        XCTAssertNotNil(SignInPresentation.form(for: .authenticating))
        XCTAssertNotNil(SignInPresentation.form(for: .registering))
        XCTAssertNotNil(SignInPresentation.form(for: .failed(message: "nope")))

        XCTAssertNil(SignInPresentation.form(for: .restoring))
        XCTAssertNil(SignInPresentation.form(for: .emailUnverified(email: "a@b.co")))
        XCTAssertNil(SignInPresentation.form(for: .pendingDeletion(purgeAfter: 1,
                                                                  reactivateToken: "t")))
        XCTAssertNil(SignInPresentation.form(for: .unavailable(message: "down")))
        XCTAssertNil(SignInPresentation.form(for: try readyState()))
    }

    func testOnlyAnInFlightAttemptIsBusy() {
        XCTAssertEqual(SignInPresentation.form(for: .authenticating)?.isBusy, true)
        XCTAssertEqual(SignInPresentation.form(for: .registering)?.isBusy, true)
        XCTAssertEqual(SignInPresentation.form(for: .loggedOut)?.isBusy, false)
        XCTAssertEqual(SignInPresentation.form(for: .failed(message: "nope"))?.isBusy, false)
    }

    /// Busy is not one fact but two, and the label has to say which. A
    /// registration reporting "Signing in…" would name an outcome it cannot
    /// reach — it ends on the check-email screen, never on an account.
    func testTheBusyLabelNamesTheOperationThatIsActuallyRunning() {
        XCTAssertEqual(SignInPresentation.form(for: .authenticating)?.activity, .signingIn)
        XCTAssertEqual(SignInPresentation.form(for: .registering)?.activity, .creatingAccount)
        XCTAssertEqual(AuthActivity.signingIn.busyTitleKey, .loginSigningIn)
        XCTAssertEqual(AuthActivity.creatingAccount.busyTitleKey, .loginCreatingAccount)
        XCTAssertNil(AuthActivity.idle.busyTitleKey)
    }

    /// The two modes name themselves differently in both directions, so the
    /// button that switches modes never reads like the button that submits.
    func testTheModeDecidesBothLabelsAndToggles() {
        XCTAssertEqual(AuthMode.signIn.submitTitleKey, .loginSignIn)
        XCTAssertEqual(AuthMode.register.submitTitleKey, .loginCreateAccount)
        XCTAssertEqual(AuthMode.signIn.titleKey, .loginSignInTitle)
        XCTAssertEqual(AuthMode.signIn.bodyKey, .loginSignInBody)
        XCTAssertEqual(AuthMode.register.titleKey, .loginRegisterTitle)
        XCTAssertEqual(AuthMode.register.bodyKey, .loginRegisterBody)
        XCTAssertEqual(AuthMode.signIn.switchTitleKey, .loginNeedAccount)
        XCTAssertEqual(AuthMode.register.switchTitleKey, .contentBackToSignIn)
        XCTAssertEqual(AuthMode.signIn.toggled, .register)
        XCTAssertEqual(AuthMode.register.toggled, .signIn)
        XCTAssertNotEqual(AuthMode.register.submitTitleKey, AuthMode.signIn.switchTitleKey,
                          "submitting and switching modes must not share one string")
    }

    // MARK: - what the form refuses to send

    /// Emptiness only, and per mode: the confirmation field does not exist on
    /// the sign-in half, so requiring it there would disable a working button.
    func testTheButtonIsLiveOnceTheRequiredFieldsAreNonEmpty() {
        let signIn = RegistrationDraft(email: "a@b.co", password: "pw12345678")
        XCTAssertTrue(SignInPresentation.canSubmit(mode: .signIn, draft: signIn, isBusy: false))
        XCTAssertFalse(SignInPresentation.canSubmit(mode: .register, draft: signIn, isBusy: false),
                       "create-account also needs the confirmation typed")
        XCTAssertFalse(SignInPresentation.canSubmit(mode: .signIn, draft: signIn, isBusy: true),
                       "an attempt is already in flight")

        let full = RegistrationDraft(email: "a@b.co", password: "pw12345678",
                                     confirmPassword: "pw12345678")
        XCTAssertTrue(SignInPresentation.canSubmit(mode: .register, draft: full, isBusy: false))
        XCTAssertFalse(SignInPresentation.canSubmit(
            mode: .register,
            draft: RegistrationDraft(email: "", password: "pw12345678", confirmPassword: "pw12345678"),
            isBusy: false))
    }

    /// A greyed button states no reason, so the substantive checks produce a
    /// SENTENCE on submit instead of disabling the control. These are the three
    /// sentences, in the order the user should fix them.
    func testTheSubstantiveChecksRunOnSubmitAndNameOneFieldEach() {
        XCTAssertEqual(SignInPresentation.problem(in: RegistrationDraft(
            email: "   ", password: "pw12345678", confirmPassword: "pw12345678")),
                       .emailMissing,
                       "whitespace is not an address; the server would trim it and refuse")
        XCTAssertEqual(SignInPresentation.problem(in: RegistrationDraft(
            email: "a@b.co", password: "short12", confirmPassword: "short12")),
                       .passwordTooShort)
        XCTAssertEqual(SignInPresentation.problem(in: RegistrationDraft(
            email: "a@b.co", password: "pw12345678", confirmPassword: "pw1234567")),
                       .passwordsDiffer)
        XCTAssertNil(SignInPresentation.problem(in: RegistrationDraft(
            displayName: "", email: "a@b.co",
            password: "pw12345678", confirmPassword: "pw12345678")),
                     "a name is optional to the server and optional here")
    }

    /// The server counts BYTES (`len(password) < 8` in Go). Counting characters
    /// would refuse a three-character Chinese password the server accepts, which
    /// is a refusal the user cannot understand and cannot appeal.
    func testThePasswordMinimumIsMeasuredInBytesLikeTheServers() {
        XCTAssertEqual(SignInPresentation.minimumPasswordBytes, 8)
        let chinese = "密码密"   // 3 characters, 9 UTF-8 bytes
        XCTAssertEqual(chinese.count, 3)
        XCTAssertNil(SignInPresentation.problem(in: RegistrationDraft(
            email: "a@b.co", password: chinese, confirmPassword: chinese)))
        let ascii = "abcdefg"    // 7 characters, 7 bytes
        XCTAssertEqual(SignInPresentation.problem(in: RegistrationDraft(
            email: "a@b.co", password: ascii, confirmPassword: ascii)), .passwordTooShort)
    }

    /// The form's own refusals and the server's arrive through one message slot,
    /// so the password rule must read identically whichever side noticed it.
    func testTheFormAndTheServerStateThePasswordRuleWithOneString() {
        XCTAssertEqual(RegistrationProblem.passwordTooShort.messageKey,
                       .errorAccountPasswordTooShort)
        for language in AppLanguage.allCases {
            XCTAssertEqual(L10n.t(RegistrationProblem.passwordTooShort.messageKey,
                                  language: language),
                           ErrorCopy.message(for: AccountError.passwordTooShort,
                                             language: language),
                           language.rawValue)
        }
    }

    // The message is the rejection the session carries, verbatim — the form does
    // not invent, translate or summarise it.
    func testOnlyARejectedAttemptCarriesAMessage() {
        XCTAssertEqual(SignInPresentation.form(for: .failed(message: "wrong password"))?.errorMessage,
                       "wrong password")
        XCTAssertNil(SignInPresentation.form(for: .loggedOut)?.errorMessage)
        XCTAssertNil(SignInPresentation.form(for: .authenticating)?.errorMessage)
    }

    /// The form must not be torn down mid-registration. It is the same claim the
    /// three sign-in states rest on — one non-nil answer means one branch in the
    /// view, which is what preserves the typed fields AND the mode.
    func testARegistrationInFlightStillRendersTheForm() {
        let busy = SignInPresentation.form(for: .registering)
        XCTAssertNotNil(busy)
        XCTAssertNil(busy?.errorMessage)
    }

    // A busy form must never also be showing the previous attempt's rejection:
    // the fields are disabled and a request is in flight, so the error is about
    // something that is no longer happening.
    func testABusyFormShowsNoStaleRejection() {
        let busy = SignInPresentation.form(for: .authenticating)
        XCTAssertEqual(busy?.isBusy, true)
        XCTAssertNil(busy?.errorMessage)
    }
}
