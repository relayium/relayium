import Foundation
import Darwin

/// Descriptor-relative filesystem primitives for the receive path.
///
/// Everything the receive path does below the destination is done with `*at()`
/// syscalls against an already-open directory descriptor, never by pathname.
/// That is not a style preference — it is the only way to close the window a
/// path-based writer leaves open.
///
/// A path-based writer necessarily does check-then-use: it asks whether a
/// component is a symlink, then names that component again in the syscall that
/// acts on it. Between those two moments a local process can `rename`/`symlink`
/// the component, and the second call resolves somewhere else entirely. Nothing
/// stat-based can fix that, because the check and the use are two lookups of the
/// same name at two different times.
///
/// Opening each component once, with `O_NOFOLLOW | O_DIRECTORY`, and then only
/// ever naming the NEXT component relative to that descriptor removes the second
/// lookup: the descriptor refers to the inode that was opened, so a later swap of
/// the name cannot redirect an operation already anchored to it. The leaf is
/// created with `O_CREAT | O_EXCL | O_NOFOLLOW` and the returned descriptor is
/// what gets written — it is never reopened by name.
///
/// The exact property, stated narrowly because the tempting wider version is
/// false: a path lookup cannot be REDIRECTED. A name swapped after its
/// descriptor was opened does not move the operation anchored to it, a symlink
/// at any component fails the open rather than being followed, and a cleanup
/// whose name no longer resolves to the inode it pinned leaves that name alone.
///
/// It is NOT "no operation lands outside the folder the user chose". The
/// descriptor pins an inode, not a location: an actor with write access to the
/// parent can rename the pinned directory anywhere and every subsequent write
/// follows it there (`testAPinnedContainerKeepsWorkingAfterItsNameChanges`
/// asserts precisely that). Nor does anything here stop a process that can
/// already write inside the destination from altering what is in it.

/// Which component an operation was about to touch, for the race tests.
///
/// Fired immediately before the syscall it names, so a test can perform the
/// worst-case swap in exactly the window an attacker would have to win. Never
/// set outside tests.
enum ManifestWriterRaceEvent: Equatable {
    /// About to `openat` this directory component (path relative to the
    /// destination).
    case beforeDirectoryOpen(String)
    /// About to `openat(O_CREAT|O_EXCL|O_NOFOLLOW)` this leaf.
    case beforeLeafCreate(String)
    /// The leaf descriptor is open and about to be written through. A swap of
    /// the NAME after this point must not affect where the bytes land.
    case afterLeafOpen(String)
}

/// Retries a syscall interrupted by a signal. Every raw call below goes through
/// this: an `EINTR` treated as a failure would surface as a spurious refusal.
@inline(__always)
func retryOnEINTR(_ body: () -> Int32) -> Int32 {
    while true {
        let r = body()
        if r >= 0 || errno != EINTR { return r }
    }
}

/// Opens a destination the USER chose — Downloads, a Save-panel folder.
///
/// Deliberately WITHOUT `O_NOFOLLOW`: a user who points the app at a symlinked
/// folder means that folder. This is the one directory in the receive path that
/// is opened by pathname, because it is the one this transfer did not create and
/// therefore cannot have pinned earlier. A container this transfer creates never
/// comes through here — `createOwnedContainer` opens it `O_NOFOLLOW` at creation
/// and the writer duplicates that descriptor.
func openDestinationDirectory(_ url: URL) -> Int32 {
    retryOnEINTR { open(url.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC) }
}

/// Opens (optionally creating) one directory component relative to `parent`.
///
/// Returns nil only when `create` is false and the component does not exist.
/// `created` reports whether this call is the one that made it, so cleanup can
/// remove exactly what this transfer added and nothing else.
///
/// The `mkdirat`-then-`openat` pair is not check-then-use: `mkdirat` is
/// exclusive (it fails `EEXIST` rather than reusing), and the `openat` that
/// follows carries `O_NOFOLLOW | O_DIRECTORY`. A SYMLINK or a plain file swapped
/// into the gap between them fails the open. A real DIRECTORY swapped into it
/// does not fail — it is opened in place of ours, and the transfer writes into
/// it. What the pair guarantees is that the name is resolved once, without
/// following a link, relative to a descriptor we already hold; it does not
/// guarantee the inode is the one `mkdirat` made.
/// `beforeOpen` is the test seam, and its placement is the whole point: it fires
/// in the gap BETWEEN `mkdirat` and `openat`, which is the only window an
/// attacker has here. A hook before `mkdirat` would fire when the name does not
/// exist yet and would prove nothing.
func openSubdirectory(parent: Int32, name: String, create: Bool,
                      beforeOpen: (() -> Void)? = nil) throws -> (fd: Int32, created: Bool)? {
    var created = false
    if create {
        let made = name.withCString { cName in retryOnEINTR { mkdirat(parent, cName, 0o755) } }
        if made == 0 {
            created = true
        } else if errno != EEXIST {
            throw posixFailure()
        }
    }
    beforeOpen?()
    let fd = name.withCString {
        cName in retryOnEINTR { openat(parent, cName, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) }
    }
    if fd < 0 {
        if !create, errno == ENOENT { return nil }
        throw posixFailure()
    }
    return (fd, created)
}

/// Creates the leaf and returns the descriptor the bytes will go through.
///
/// `O_EXCL` is what makes this safe rather than merely careful: it refuses if
/// the name exists at all — including as a dangling symlink, which no `stat`
/// based on existence would notice — and it does so in the same syscall that
/// would otherwise have created the file. There is no window between deciding
/// the name is free and taking it.
func createLeafFile(parent: Int32, name: String) throws -> Int32 {
    let fd = name.withCString { cName in
        retryOnEINTR { openat(parent, cName, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o644) }
    }
    if fd < 0 { throw posixFailure() }
    return fd
}

/// `lstat` relative to `parent`. Nil means "not there", which for the preflight
/// means "no collision" — a symlink, dangling or not, is NOT nil.
func statAt(parent: Int32, name: String) -> stat? {
    var st = stat()
    let r = name.withCString { cName in retryOnEINTR { fstatat(parent, cName, &st, AT_SYMLINK_NOFOLLOW) } }
    return r == 0 ? st : nil
}

/// Writes the whole slice, looping over short writes.
func writeAll(_ fd: Int32, _ bytes: ArraySlice<UInt8>) throws {
    try bytes.withUnsafeBufferPointer { buffer in
        guard var base = buffer.baseAddress else { return }
        var left = buffer.count
        while left > 0 {
            let n = retryOnEINTRSize { Darwin.write(fd, base, left) }
            if n <= 0 { throw posixFailure() }
            base += n
            left -= n
        }
    }
}

@inline(__always)
private func retryOnEINTRSize(_ body: () -> Int) -> Int {
    while true {
        let r = body()
        if r >= 0 || errno != EINTR { return r }
    }
}

/// Removes one name relative to `parent`.
///
/// For a directory this is `AT_REMOVEDIR`, which the kernel refuses with
/// `ENOTEMPTY` if anything is inside. That is the "only remove what is still
/// empty" rule, enforced atomically instead of by a check the caller could lose
/// a race on — a directory that gained a file since this transfer created it is
/// not this transfer's to delete.
@discardableResult
func removeAt(parent: Int32, name: String, isDirectory: Bool) -> Bool {
    let flag = isDirectory ? AT_REMOVEDIR : 0
    return name.withCString { cName in retryOnEINTR { unlinkat(parent, cName, flag) } } == 0
}

/// A directory this transfer created, held open from the first moment it could
/// be opened.
///
/// The descriptor is the identity. Everything that later acts on this
/// directory — writing into it, removing it again — goes through `fd`, never
/// through a fresh lookup of `url`, because a fresh lookup answers "what is at
/// this name NOW", which is precisely the question that has a different answer
/// once an attacker has been at it.
///
/// This type exists because getting that wrong is easy and silent: a cleanup
/// path that opened `url` inside its own failure handler would pin the
/// REPLACEMENT, compare it against itself, find it identical, and delete
/// somebody else's directory while looking exactly like a careful identity
/// check.
///
/// Two things this does NOT claim.
///
/// First, "from the moment it existed" would be false: Darwin has no "make a
/// directory and hand me its descriptor" syscall, so `mkdirat` and `openat` are
/// two calls and there is a gap between them. `O_NOFOLLOW | O_DIRECTORY` means a
/// SYMLINK swapped into that gap fails the open. A real directory swapped into
/// it does NOT fail the open — it is pinned in place of ours, and the transfer
/// then writes into the attacker's directory rather than its own. What holds is
/// that the name was resolved once, under `O_NOFOLLOW`, relative to the parent.
///
/// Second, the descriptor pins an INODE, not a location. An actor who can write
/// to the parent can rename the pinned directory anywhere it likes, and every
/// subsequent write follows it there — see
/// `testAPinnedContainerKeepsWorkingAfterItsNameChanges`, which asserts exactly
/// that behaviour. So this is not containment-by-location: it is that path
/// lookups cannot be REDIRECTED, and that cleanup whose name no longer matches
/// leaves the name alone.
///
/// `init` is `fileprivate` on purpose. The invariant is "this descriptor came
/// from the `mkdirat`/`openat` pair below"; a caller able to pair an arbitrary
/// URL with an arbitrary descriptor could hand the cleanup path a fabricated
/// identity, which is the whole thing the type is meant to make unrepresentable.
/// `createOwnedContainer` is the only way to make one.
final class OwnedContainer {
    let url: URL
    let fd: Int32

    fileprivate init(url: URL, fd: Int32) {
        self.url = url
        self.fd = fd
    }

    deinit { if fd >= 0 { close(fd) } }

    /// Remove it again, using the descriptor pinned at creation.
    @discardableResult
    func removeIfStillOurs() -> Bool { removeDirectoryIfUnchanged(fd: fd, at: url) }
}

/// Create a directory under `parent` and pin it in the same breath.
///
/// Returns nil when the name is already taken — `mkdirat` is exclusive, so that
/// answer is atomic rather than a check the caller could lose a race on.
func createOwnedContainer(parent: URL, name: String) throws -> OwnedContainer? {
    let parentFD = retryOnEINTR { open(parent.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC) }
    guard parentFD >= 0 else { throw posixFailure() }
    defer { close(parentFD) }
    let made = name.withCString { cName in retryOnEINTR { mkdirat(parentFD, cName, 0o755) } }
    if made != 0 {
        if errno == EEXIST { return nil }
        throw posixFailure()
    }
    let fd = name.withCString { cName in
        retryOnEINTR { openat(parentFD, cName, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) }
    }
    guard fd >= 0 else { throw posixFailure() }
    return OwnedContainer(url: parent.appendingPathComponent(name), fd: fd)
}

/// Remove a directory this transfer created — but only if the name still refers
/// to the very directory `fd` was opened on, and only while it is empty.
///
/// `fd` MUST be the descriptor pinned when the directory was created. Passing a
/// descriptor obtained by reopening the name defeats the entire check: it pins
/// whatever is there now and then finds it identical to itself.
///
/// This is the one cleanup step that cannot be made fully descriptor-relative,
/// and the limit is worth stating precisely rather than glossing.
///
/// Removing a directory requires naming it in its PARENT (`unlinkat` with
/// `AT_REMOVEDIR`); neither macOS nor Linux offers "remove the directory this
/// descriptor refers to". So the name is resolved twice: once by `fstatat`, to
/// check that what is there is still the `(st_dev, st_ino)` pair `fd` refers to,
/// and once by `unlinkat`. Between those two calls the name could in principle
/// change again.
///
/// The exact guarantee, therefore:
/// * A container replaced by a SYMLINK is never followed — `AT_REMOVEDIR`
///   refuses one with `ENOTDIR`.
/// * A container replaced by a NON-EMPTY directory is never removed —
///   `AT_REMOVEDIR` refuses with `ENOTEMPTY`.
/// * A container replaced by a different EMPTY directory before the identity
///   check is never removed: the check fails and this returns false, leaving it
///   alone. Leaving a stray empty directory behind is the deliberate choice
///   under ambiguous identity — deleting somebody else's directory is the worse
///   error of the two.
/// * The residual window is a swap landing between `fstatat` and `unlinkat`. If
///   an attacker wins it, an EMPTY directory of theirs is removed. Nothing
///   outside the parent can be reached, and no data can be destroyed, because
///   only an empty directory can be removed at all.
@discardableResult
func removeDirectoryIfUnchanged(fd: Int32, at url: URL) -> Bool {
    var mine = stat()
    guard fstat(fd, &mine) == 0 else { return false }
    let name = url.lastPathComponent
    guard !name.isEmpty, name != "/", name != ".", name != ".." else { return false }
    let parent = retryOnEINTR {
        open(url.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    }
    guard parent >= 0 else { return false }
    defer { close(parent) }
    guard let there = statAt(parent: parent, name: name),
          there.st_dev == mine.st_dev, there.st_ino == mine.st_ino else {
        return false        // not ours any more: leave it alone
    }
    return removeAt(parent: parent, name: name, isDirectory: true)
}

/// Duplicate a descriptor, keeping it close-on-exec.
///
/// `dup(2)` deliberately does NOT copy `FD_CLOEXEC` — the duplicate comes back
/// inheritable no matter how carefully the original was opened with `O_CLOEXEC`.
/// Every descriptor this app holds on a receive directory or a file inside it is
/// close-on-exec so that any child process (Sparkle's installer, a helper, an
/// `NSTask` somebody adds later) cannot inherit a live handle on the user's
/// files. `F_DUPFD_CLOEXEC` duplicates and sets the flag in one call, with no
/// window in between where a `fork`/`exec` could catch it bare.
func dupCloseOnExec(_ fd: Int32) -> Int32 {
    retryOnEINTR { fcntl(fd, F_DUPFD_CLOEXEC, 0) }
}

/// The current `errno`, captured immediately, as a typed error.
func posixFailure() -> DownloadDestinationError {
    .systemError(errno)
}
