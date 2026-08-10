import Foundation

/// **The command that does, in a terminal, exactly what the link in the window
/// does.**
///
/// The web has shown this since stored send existed (`web/src/lib/temp-downloader.ts`,
/// `downCommand`); the Mac app showed only the link, so a user who works in a
/// shell had to compose the command themselves — and the way people compose it
/// is by pasting the link unquoted, which is the one way to get it wrong.
///
/// ## Why quoting is a function and not a template
///
/// A stored link's key rides in the URL FRAGMENT. Unquoted, `#` opens a comment
/// in every POSIX shell, so `relayium down https://…/d/abc#k=KEY` runs as
/// `relayium down https://…/d/abc` — the key is silently discarded and the
/// download fails with an error about the wrong thing. That is the whole reason
/// this exists.
///
/// The second reason is narrower and does not depend on the first being the only
/// lock: a `'` inside a hand-crafted link would close the quoted word and let
/// whatever follows run as commands in the reader's shell. `'\''` — end the
/// string, an escaped literal quote, reopen — is the standard POSIX form, and it
/// is byte-for-byte what the web's `shQuote` emits. The two are asserted against
/// the same cases so a reader who compares the page and the app sees one answer.
public enum PosixShellQuoting {

    /// One shell word, whatever is in it.
    ///
    /// Single quotes rather than double: inside double quotes a shell still
    /// expands `$`, `` ` `` and `\`, so a link containing any of them would be
    /// rewritten before the command ever ran.
    public static func quote(_ value: String) -> String {
        // nonlocalized: POSIX shell quoting syntax, not user copy
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}

/// The CLI equivalent of a finished stored send.
public enum StoredLinkCommandPresentation {

    /// `relayium down '<link>'`.
    ///
    /// No destination argument. The web builder has a field for one because the
    /// page asks the reader where to save; this is a statement of the equivalent
    /// command rather than a builder, and the CLI's own default — the current
    /// directory — is what a reader would type. Adding a `.` would be a claim
    /// about where they want the file that nothing here knows.
    public static func downCommand(link: String) -> String {
        // nonlocalized: a CLI verb, identical in every language
        "relayium down " + PosixShellQuoting.quote(link)
    }
}
