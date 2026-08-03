import XCTest

/// The words that belong to the SIGN-IN token store's failure copy and to
/// nothing else.
///
/// `KeychainError` is raised by two unrelated stores: the one holding this Mac's
/// bearer token, whose failure really does mean the session was not persisted,
/// and the one holding each upload's E2E key, whose failure means one file's key
/// was not written, read or removed. They share a type, so the shared copy table
/// used to answer for both — telling someone their sign-in was at risk because a
/// file key could not be saved. Shared rather than repeated per test file so the
/// list cannot drift into three different definitions of "false here".
let loginOnlyWording = ["sign-in", "sign in", "signed in", "signing in",
                        "login", "log in", "logged in", "quit"]

/// Asserts `text` says nothing about the session. Used on every rendered
/// stored-link-key failure the user can actually read.
func assertSaysNothingAboutSigningIn(_ text: String,
                                     _ what: String,
                                     file: StaticString = #filePath,
                                     line: UInt = #line) {
    let lowered = text.lowercased()
    for word in loginOnlyWording {
        XCTAssertFalse(lowered.contains(word),
                       "\(what) borrows the sign-in copy (“\(word)”): \(text)",
                       file: file, line: line)
    }
}

/// Ways of saying that a request which already succeeded did not happen.
///
/// Every stored-link-key failure follows a completed request: a save runs after
/// the upload landed, a read after the file list came back, a remove after a
/// CONFIRMED server delete. `StoredLinkKeyError`'s shared wording was written
/// for `AccountClient`, which raises it before a DELETE is ever sent, so reusing
/// it here would tell someone nothing went out when in fact everything did — and
/// send them to repeat an upload the server already has.
///
/// Deliberately narrow: "never sent" is NOT on this list, because the upload
/// pane's success copy earns it — the key really is never sent to Relayium's
/// servers, and that claim is the privacy guarantee, not a denial.
let completedRequestDenials = ["was not sent", "wasn't sent", "nothing was sent",
                               "was not uploaded", "wasn't uploaded",
                               "was not deleted", "wasn't deleted"]

/// Asserts `text` does not deny work the server has already done.
func assertDoesNotDenyACompletedRequest(_ text: String,
                                        _ what: String,
                                        file: StaticString = #filePath,
                                        line: UInt = #line) {
    let lowered = text.lowercased()
    for phrase in completedRequestDenials {
        XCTAssertFalse(lowered.contains(phrase),
                       "\(what) denies a request that succeeded (“\(phrase)”): \(text)",
                       file: file, line: line)
    }
}
