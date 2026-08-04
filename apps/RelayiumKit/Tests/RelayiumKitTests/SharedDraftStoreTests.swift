import XCTest
@testable import RelayiumKit
@testable import RelayiumShareKit

/// The App Group hand-off, driven against an injected root.
///
/// Every property here is one a share extension cannot demonstrate on demand: a
/// preparation killed mid-copy, a plan written by a build that does not exist
/// yet, two drafts created in the same second, a staged file that shrank after
/// its plan was written. The store is deliberately a plain class over a URL so
/// all of them are constructible.
final class SharedDraftStoreTests: XCTestCase {
    private var root: URL!
    private var store: SharedDraftStore!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("shared-drafts-\(UUID().uuidString)")
        store = SharedDraftStore(root: root)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    // MARK: - helpers

    private func sourceTree(_ layout: [String: String]) throws -> URL {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("share-source-\(UUID().uuidString)")
        for (path, contents) in layout {
            let file = base.appendingPathComponent(path)
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            try Data(contents.utf8).write(to: file)
        }
        return base
    }

    /// Publish one draft from a tree, adopting `named` — a direct child of the
    /// generated base — exactly as a provider would hand over one shared root.
    private func publishDraft(_ layout: [String: String],
                              named: String,
                              now: Date = Date()) throws -> SharedDraftPlan {
        let tree = try sourceTree(layout)
        let writer = try store.beginDraft(now: now)
        try writer.adopt(tree.appendingPathComponent(named), suggestedName: named)
        return try writer.publish()
    }

    /// A `FileManager` with no App Group, which is what an un-provisioned iOS
    /// build actually gets back.
    ///
    /// Needed because macOS is not iOS here: `containerURL(forSecurityApplicationGroupIdentifier:)`
    /// returns a path on macOS whether or not the caller carries the
    /// entitlement, so a test running under `swift test` cannot reach the
    /// refusal by simply asking. Overriding the one call is what makes the
    /// fail-closed path testable on the machine the suite runs on.
    private final class NoGroupFileManager: FileManager, @unchecked Sendable {
        override func containerURL(forSecurityApplicationGroupIdentifier id: String) -> URL? {
            nil
        }
    }

    /// A `FileManager` that answers for the group with a directory this test
    /// owns.
    ///
    /// The positive half of the App Group rule used to be checked against the
    /// REAL container — `AppGroup.containerURL()` with no argument — which on a
    /// developer's Mac resolves `~/Library/Group Containers/...` and made a
    /// package test inspect, and potentially create state in, a production
    /// container belonging to the machine running it. A `swift test` must not
    /// know that directory exists. The identifier is still checked exactly:
    /// anything but the one group gets the same nil an unentitled process does.
    private final class FakeGroupFileManager: FileManager, @unchecked Sendable {
        let container: URL
        init(container: URL) {
            self.container = container
            super.init()
        }
        override func containerURL(forSecurityApplicationGroupIdentifier id: String) -> URL? {
            id == AppGroup.identifier ? container : nil
        }
    }

    /// A `FileManager` that refuses to delete anything under a given path.
    ///
    /// `EPERM` on `unlink` is not something a test can arrange for real, and it
    /// is exactly the case the retirement tombstone exists for: the app has
    /// durably taken ownership of a draft's bytes and the removal fails anyway.
    private final class UnremovableFileManager: FileManager, @unchecked Sendable {
        var refusedPrefix: String?
        override func removeItem(at url: URL) throws {
            if let refusedPrefix, url.path.hasPrefix(refusedPrefix) {
                throw CocoaError(.fileWriteNoPermission)
            }
            try super.removeItem(at: url)
        }
    }

    /// A `FileManager` that records what a directory held when it was renamed.
    ///
    /// The publication order is not observable after the fact — a directory
    /// renamed-then-described and one described-then-renamed look identical once
    /// both steps are done. This is what makes it an assertion.
    private final class RenameObservingFileManager: FileManager, @unchecked Sendable {
        private(set) var contentsAtRename: [String] = []
        private(set) var renames = 0

        override func moveItem(at srcURL: URL, to dstURL: URL) throws {
            renames += 1
            contentsAtRename = ((try? contentsOfDirectory(atPath: srcURL.path)) ?? []).sorted()
            try super.moveItem(at: srcURL, to: dstURL)
        }
    }

    /// A `FileManager` that blocks the writer inside `attributesOfItem`.
    ///
    /// This is the barrier the cancellation tests need. `SharedDraftWriter
    /// .adopt` holds its ownership lock for the whole of a copy, so proving that
    /// Cancel returns *during* one requires the copy to be genuinely in
    /// progress and genuinely stuck — not merely large, which would be a timing
    /// test that passes on a fast machine for the wrong reason.
    ///
    /// `attributesOfItem` is what `classify` calls before staging each entry, so
    /// blocking it once puts the writer inside `adopt`, holding `lock`, with no
    /// way out until this test says so.
    final class BarrierFileManager: FileManager, @unchecked Sendable {
        /// Raised once the writer is inside the barrier.
        let reached = DispatchSemaphore(value: 0)
        /// Signalled by the test to let it out.
        let release = DispatchSemaphore(value: 0)
        private let lock = NSLock()
        private var armedPath: String?
        private var blocked = false

        /// Block the NEXT `attributesOfItem` for this path, whatever it is.
        func arm(at url: URL) {
            lock.lock()
            armedPath = url.path
            lock.unlock()
        }

        /// Block the next `attributesOfItem` for any path at all. Used where the
        /// blocked path is chosen by the code under test rather than by the
        /// test.
        func armNext() {
            lock.lock()
            armedPath = ""
            lock.unlock()
        }

        /// True while a caller is sitting inside the barrier. Pollable, so a
        /// `@MainActor` test can wait for it with `await` instead of blocking
        /// the actor the code under test needs.
        var isBlocked: Bool {
            lock.lock()
            defer { lock.unlock() }
            return blocked
        }

        override func attributesOfItem(atPath path: String) throws -> [FileAttributeKey: Any] {
            lock.lock()
            let armed = armedPath == path || armedPath == ""
            if armed {
                armedPath = nil
                blocked = true
            }
            lock.unlock()
            if armed {
                reached.signal()
                release.wait()
                lock.lock()
                blocked = false
                lock.unlock()
            }
            return try super.attributesOfItem(atPath: path)
        }
    }

    // MARK: - the bounds are the product's, not this module's

    /// `RelayiumShareKit` may not depend on `RelayiumKit`, so it restates three
    /// constants. Restating them is fine; letting them drift is not — a share
    /// that staged 2000 files would produce a manifest the app's own receiving
    /// side refuses, after the user had been told it was ready.
    func testTheDuplicatedBoundsStillMatchTheWireFormats() {
        XCTAssertEqual(SHARED_DRAFT_MAX_FILES, MAX_FILES)
        XCTAssertEqual(SHARED_DRAFT_MAX_NAME_BYTES, MANIFEST_MAX_NAME_BYTES)
        XCTAssertEqual(SHARED_DRAFT_COPY_CHUNK, STORE_CHUNK_SIZE)
    }

    /// The production identifier, exactly. A typo here is the failure that looks
    /// like everything working.
    func testTheAppGroupIdentifierIsExactAndFailsClosed() throws {
        XCTAssertEqual(AppGroup.identifier, "group.com.relayium.app")

        // No container means a refusal — with no fallback to a temporary
        // directory, Application Support, or this process's own container. A
        // fallback is how a "draft" becomes a copy of the user's files that
        // nothing will ever show them, send, or delete.
        let ungrouped = NoGroupFileManager()
        XCTAssertThrowsError(try AppGroup.containerURL(ungrouped)) { error in
            XCTAssertEqual(error as? SharedDraftError, .unavailableContainer)
        }
        XCTAssertThrowsError(try AppGroup.sharedDraftRoot(ungrouped))
        XCTAssertNil(try? SharedDraftStore.shared(ungrouped))

        // And when there IS a container, the root is inside it under exactly one
        // known name — never the container root itself, which is shared with
        // whatever else the group is used for.
        //
        // Against an INJECTED container, never the real one. `swift test` must
        // not read, create or assert anything in `~/Library/Group Containers`:
        // that is a production directory belonging to whoever is running the
        // suite, and a test that touched it would be a test that behaves
        // differently on a machine where the app has been used.
        let container = root.appendingPathComponent("group-container", isDirectory: true)
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
        let grouped = FakeGroupFileManager(container: container)
        XCTAssertEqual(try AppGroup.containerURL(grouped), container)
        let resolved = try AppGroup.sharedDraftRoot(grouped)
        XCTAssertEqual(resolved, container.appendingPathComponent("SharedDrafts",
                                                                  isDirectory: true))
        XCTAssertEqual(try SharedDraftStore.shared(grouped).root, resolved)
        // Resolving must not CREATE anything: a reader over a directory that
        // does not exist correctly lists nothing, and an app that made the
        // directory just by launching would leave one on every device.
        XCTAssertFalse(FileManager.default.fileExists(atPath: resolved.path))
        // The identifier is matched exactly, so a build asking for some other
        // group gets the same refusal an unentitled one does.
        XCTAssertNil(grouped.containerURL(forSecurityApplicationGroupIdentifier: "group.com.other"))
    }

    // MARK: - publication is atomic and the plan is last

    func testAPublishedDraftKeepsHierarchyOrderAndSizes() throws {
        let plan = try publishDraft(["trip/b.txt": "second",
                                     "trip/a.txt": "first",
                                     "trip/nested/c.txt": "third"],
                                    named: "trip")

        XCTAssertEqual(plan.version, 1)
        XCTAssertTrue(SharedDraftID.isValid(plan.id))
        // Depth-first, entries sorted by their UTF-8 bytes: the same order
        // `expandSelection` produces for a picked folder, so one tree makes one
        // manifest whichever way it reached the app.
        XCTAssertEqual(plan.files.map(\.name),
                       ["trip/a.txt", "trip/b.txt", "trip/nested/c.txt"])
        XCTAssertEqual(plan.files.map(\.staged), ["0", "1", "2"])
        XCTAssertEqual(plan.files.map(\.size), [5, 6, 5])
        XCTAssertEqual(plan.totalBytes, 16)
        XCTAssertEqual(store.drafts(), [plan])
    }

    /// A draft is listed because its plan exists, and for no other reason.
    func testAJobWithNoPlanIsInertNoMatterWhatIsInIt() throws {
        let plan = try publishDraft(["a.txt": "hello"], named: "a.txt")
        XCTAssertEqual(store.drafts().count, 1)

        // Exactly what a crash between the publish rename and the plan write
        // leaves behind: every byte present, nothing describing them.
        try FileManager.default.removeItem(
            at: store.draftURL(id: plan.id).appendingPathComponent("draft.json"))
        XCTAssertEqual(store.drafts(), [], "a plan-less directory is not a draft")
        XCTAssertNil(store.draft(id: plan.id))
    }

    /// Every value that can influence a path, an allocation or what is uploaded
    /// is checked on read. A plan that fails any of them is not returned at all.
    func testAnInvalidPlanIsRefusedRatherThanRepaired() throws {
        let plan = try publishDraft(["a.txt": "hello"], named: "a.txt")
        let planURL = store.draftURL(id: plan.id).appendingPathComponent("draft.json")

        let mutations: [(String, [String: Any])] = [
            ("a future version", ["version": 2]),
            ("an id that is not this directory", ["id": UUID().uuidString]),
            ("a lowercase id", ["id": plan.id.lowercased()]),
            ("no creation time", ["createdAt": 0]),
            ("no files", ["files": []]),
            ("an absolute manifest name",
             ["files": [["name": "/etc/passwd", "size": 5, "staged": "0"]]]),
            ("a traversing manifest name",
             ["files": [["name": "../escape", "size": 5, "staged": "0"]]]),
            ("an empty manifest name",
             ["files": [["name": "", "size": 5, "staged": "0"]]]),
            ("a staged index that is not the position",
             ["files": [["name": "a.txt", "size": 5, "staged": "7"]]]),
            ("a staged name that is a path",
             ["files": [["name": "a.txt", "size": 5, "staged": "../../plan"]]]),
            ("a negative size", ["files": [["name": "a.txt", "size": -1, "staged": "0"]]]),
            ("a size that disagrees with the bytes",
             ["files": [["name": "a.txt", "size": 4, "staged": "0"]]]),
            // Checked here rather than by walking a real tree: Darwin caps a
            // path at PATH_MAX (1024) and a component at 255 bytes, so a source
            // tree whose RELATIVE path exceeds the manifest budget is not
            // constructible under a temp directory at all. `validManifestName`
            // is the one rule both the writer and this reader apply, and its
            // table is below.
            ("a name over the manifest byte budget",
             ["files": [["name": String(repeating: "n", count: SHARED_DRAFT_MAX_NAME_BYTES + 1),
                         "size": 5, "staged": "0"]]]),
            ("two files on one manifest path",
             ["files": [["name": "a.txt", "size": 5, "staged": "0"],
                        ["name": "a.txt", "size": 5, "staged": "1"]]]),
        ]
        for (description, patch) in mutations {
            var document = try XCTUnwrap(
                try JSONSerialization.jsonObject(with: try Data(contentsOf: planURL))
                    as? [String: Any])
            for (key, value) in patch { document[key] = value }
            try JSONSerialization.data(withJSONObject: document).write(to: planURL)
            XCTAssertEqual(store.drafts(), [], "a plan with \(description) was listed")
            XCTAssertNil(store.draft(id: plan.id), "a plan with \(description) was returned")
        }
    }

    /// Duplicate manifest names never reach a plan, and are refused whole rather
    /// than renamed: sending somebody's file under a name they never saw is not
    /// a repair.
    func testTwoItemsOnOnePathAreRefusedAndLeaveNothingBehind() throws {
        let first = try sourceTree(["report.txt": "one"])
        let second = try sourceTree(["report.txt": "two"])
        let writer = try store.beginDraft()
        try writer.adopt(first.appendingPathComponent("report.txt"), suggestedName: "report.txt")
        XCTAssertThrowsError(
            try writer.adopt(second.appendingPathComponent("report.txt"),
                             suggestedName: "report.txt")) { error in
            XCTAssertEqual(error as? SharedDraftError, .duplicatePath("report.txt"))
        }
        writer.abandon()
        XCTAssertEqual(store.drafts(), [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.stagingRoot.path)
                       && !((try? FileManager.default.contentsOfDirectory(
                            atPath: store.stagingRoot.path))?.isEmpty ?? true),
                       "the abandoned staging directory is still on disk")
    }

    /// A symlink is neither followed (which would copy files from outside what
    /// was shared) nor skipped (which would send an incomplete tree silently).
    func testSymlinksAndNonRegularItemsAreRefused() throws {
        let tree = try sourceTree(["folder/real.txt": "real"])
        let link = tree.appendingPathComponent("folder/link.txt")
        try FileManager.default.createSymbolicLink(
            at: link, withDestinationURL: tree.appendingPathComponent("folder/real.txt"))

        let writer = try store.beginDraft()
        XCTAssertThrowsError(try writer.adopt(tree.appendingPathComponent("folder"),
                                              suggestedName: "folder")) { error in
            XCTAssertEqual(error as? SharedDraftWalkError, .symbolicLink("folder/link.txt"))
        }
        writer.abandon()
        XCTAssertEqual(store.drafts(), [], "a refused walk must publish nothing")
    }

    func testAnEmptyFolderIsRefusedRatherThanPublishedAsAnEmptyDraft() throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("empty-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: base.appendingPathComponent("nothing"),
                                                withIntermediateDirectories: true)
        let writer = try store.beginDraft()
        XCTAssertThrowsError(try writer.adopt(base.appendingPathComponent("nothing"),
                                              suggestedName: "nothing"))
        writer.abandon()
        XCTAssertEqual(store.drafts(), [])
    }

    func testTooManyFilesIsRefusedBeforeThePlanExists() throws {
        var layout: [String: String] = [:]
        for index in 0...SHARED_DRAFT_MAX_FILES { layout["many/\(index).txt"] = "x" }
        let tree = try sourceTree(layout)
        let writer = try store.beginDraft()
        XCTAssertThrowsError(try writer.adopt(tree.appendingPathComponent("many"),
                                              suggestedName: "many")) { error in
            XCTAssertEqual(error as? SharedDraftWalkError, .tooManyFiles(SHARED_DRAFT_MAX_FILES))
        }
        writer.abandon()
        XCTAssertEqual(store.drafts(), [])
    }

    // MARK: - the copy is bounded, and what it leaves is immutable

    func testTheCopyIsChunkedAndTheStagedFilesAreReadOnlyAndExcludedFromBackup() throws {
        // Comfortably more than one chunk, so the loop actually loops.
        let big = String(repeating: "R", count: SHARED_DRAFT_COPY_CHUNK * 3 + 17)
        let tree = try sourceTree(["large.bin": big])
        let writer = try store.beginDraft()
        try writer.adopt(tree.appendingPathComponent("large.bin"), suggestedName: "large.bin")
        let plan = try writer.publish()

        XCTAssertEqual(plan.files.first?.size, big.utf8.count)
        XCTAssertEqual(writer.copyBufferPeak, SHARED_DRAFT_COPY_CHUNK,
                       "the copy held more than one chunk at a time")
        XCTAssertLessThan(writer.copyBufferPeak, big.utf8.count,
                          "a whole-file read would put a shared video in an appex's memory")

        let staged = try store.stagedFiles(for: plan)[0].url
        let attributes = try FileManager.default.attributesOfItem(atPath: staged.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.int16Value, 0o400,
                       "staged bytes must not be editable after the plan describes them")
        let job = store.draftURL(id: plan.id)
        XCTAssertEqual(try job.resourceValues(forKeys: [.isExcludedFromBackupKey])
            .isExcludedFromBackup, true,
                       "copies of what the user is sending must not restore onto another device")
        XCTAssertEqual(try Data(contentsOf: staged), Data(big.utf8))
    }

    /// The plan holds names, sizes and indexes. It holds no source URL, no
    /// absolute path, no account and no key — the group container is readable by
    /// both processes for as long as a draft waits.
    func testThePlanRecordsNothingAboutWhereTheFilesCameFrom() throws {
        let tree = try sourceTree(["secret-folder/tax return.pdf": "x"])
        let writer = try store.beginDraft()
        try writer.adopt(tree.appendingPathComponent("secret-folder"),
                         suggestedName: "secret-folder")
        let plan = try writer.publish()

        let document = try String(
            contentsOf: store.draftURL(id: plan.id).appendingPathComponent("draft.json"),
            encoding: .utf8)
        XCTAssertFalse(document.contains(tree.path), "the plan records the source location")
        XCTAssertFalse(document.contains(NSHomeDirectory()))
        XCTAssertFalse(document.contains("/var"))
        XCTAssertFalse(document.contains("/private"))
        XCTAssertEqual(Set(try XCTUnwrap(
            try JSONSerialization.jsonObject(with: Data(document.utf8)) as? [String: Any]).keys),
            ["version", "id", "createdAt", "files"])
    }

    // MARK: - several drafts, and what removes one

    func testSeveralSharesStaySeparateAndListOldestFirst() throws {
        let base = Date(timeIntervalSince1970: 1_700_000_000)
        var ids: [String] = []
        for (offset, name) in [(2.0, "third"), (0.0, "first"), (1.0, "second")] {
            ids.append(try publishDraft(["\(name).txt": name], named: "\(name).txt",
                                        now: base.addingTimeInterval(offset)).id)
        }
        XCTAssertEqual(store.drafts().map(\.files).map { $0[0].name },
                       ["first.txt", "second.txt", "third.txt"],
                       "several shares are several things the user asked for, oldest first")
        XCTAssertEqual(Set(ids).count, 3, "each invocation gets its own opaque id")
    }

    /// Two drafts inside one second still order deterministically, so the list
    /// does not depend on whatever order the directory happened to enumerate.
    func testDraftsCreatedInTheSameSecondStillOrderDeterministically() throws {
        let instant = Date(timeIntervalSince1970: 1_700_000_000)
        var ids: [String] = []
        for name in ["a", "b", "c"] {
            ids.append(try publishDraft(["\(name).txt": name], named: "\(name).txt",
                                        now: instant).id)
        }
        XCTAssertEqual(store.drafts().map(\.id), ids.sorted())
        XCTAssertEqual(store.drafts().map(\.id), store.drafts().map(\.id))
    }

    func testDiscardRemovesExactlyOneDraft() throws {
        let keep = try publishDraft(["keep.txt": "keep"], named: "keep.txt")
        let go = try publishDraft(["go.txt": "go"], named: "go.txt")
        XCTAssertTrue(store.discard(id: go.id))
        XCTAssertEqual(store.drafts().map(\.id), [keep.id])
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.draftURL(id: go.id).path))
        // Idempotent: retirement after a crash calls it for an id that is
        // already gone, and that is a success rather than a failure.
        XCTAssertTrue(store.discard(id: go.id))
        XCTAssertTrue(store.retire(id: go.id))
        XCTAssertFalse(store.retire(id: "not-an-id"), "a malformed id names nothing")
    }

    /// Nothing expires a complete draft. The app tells the user it stays on this
    /// device; a sweep that deleted it on a timer would make that a lie.
    func testTheSweepNeverTouchesACompleteDraftHoweverOldItIs() throws {
        let plan = try publishDraft(["old.txt": "old"], named: "old.txt")
        try FileManager.default.setAttributes(
            [.modificationDate: Date(timeIntervalSince1970: 1)],
            ofItemAtPath: store.draftURL(id: plan.id).path)

        store.sweepIncomplete(grace: 3600, now: Date(timeIntervalSince1970: 4_000_000_000))
        XCTAssertEqual(store.drafts().map(\.id), [plan.id],
                       "a complete draft was expired")
    }

    /// What the sweep IS for: a preparation the system killed outright, which
    /// leaves bytes nothing will ever publish.
    func testTheSweepRemovesOnlyStaleStagingAndPlanlessDirectories() throws {
        let live = try store.beginDraft()
        let tree = try sourceTree(["live.txt": "live"])
        try live.adopt(tree.appendingPathComponent("live.txt"), suggestedName: "live.txt")
        let liveDirectory = store.stagingRoot.appendingPathComponent(live.id)

        let killed = try store.beginDraft()
        let killedDirectory = store.stagingRoot.appendingPathComponent(killed.id)
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 1)],
                                              ofItemAtPath: killedDirectory.path)

        // A plan-less directory in the PUBLISHED area, made just now. Under the
        // old shape this was swept immediately — which is precisely the bug,
        // because the old publish renamed a plan-less directory into place and
        // then wrote the plan, so "just now" was also what a live publication
        // looked like from another process.
        let recentOrphan = root.appendingPathComponent(UUID().uuidString.uppercased())
        try FileManager.default.createDirectory(at: recentOrphan,
                                                withIntermediateDirectories: true)
        let staleOrphan = root.appendingPathComponent(UUID().uuidString.uppercased())
        try FileManager.default.createDirectory(at: staleOrphan, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 1)],
                                              ofItemAtPath: staleOrphan.path)

        store.sweepIncomplete(grace: 3600, now: Date())

        XCTAssertTrue(FileManager.default.fileExists(atPath: liveDirectory.path),
                      "a copy still in progress was swept out from under it")
        XCTAssertFalse(FileManager.default.fileExists(atPath: killedDirectory.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: recentOrphan.path),
                      "a plan-less published directory was swept inside the grace window")
        XCTAssertFalse(FileManager.default.fileExists(atPath: staleOrphan.path))

        // Still publishable afterwards, which is the whole claim.
        XCTAssertEqual(try live.publish().files.map(\.name), ["live.txt"])
        XCTAssertEqual(store.drafts().count, 1)
    }

    /// Publication is ONE atomic step, and the plan is inside the directory
    /// before that step happens.
    ///
    /// This is the cross-process property. The old shape renamed a plan-less
    /// directory into the published area and wrote `draft.json` afterwards, so
    /// there was a window — however short, and on a thousand-file draft not
    /// short at all — in which the app's launch sweep saw a published directory
    /// with no plan and deleted the extension's work mid-publication. No lock
    /// could have fixed that: they are different processes.
    func testAPublicationIsNeverVisibleWithoutItsPlan() throws {
        // Records what the directory being renamed contained AT THE MOMENT of
        // the rename. That is the ordering, stated directly rather than inferred
        // from the state afterwards — which looks identical either way.
        let observer = RenameObservingFileManager()
        let store = SharedDraftStore(root: root, fileManager: observer)
        let writer = try store.beginDraft()
        let tree = try sourceTree(["atomic.txt": "atomic"])
        try writer.adopt(tree.appendingPathComponent("atomic.txt"), suggestedName: "atomic.txt")
        let staging = store.stagingRoot.appendingPathComponent(writer.id)

        // Before publication: nothing in the published area at all, and the plan
        // is not in the staging directory either.
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: store.draftURL(id: writer.id).path))
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: staging.appendingPathComponent("draft.json").path))

        let plan = try writer.publish()

        XCTAssertEqual(observer.renames, 1, "publication is one rename and no more")
        XCTAssertEqual(observer.contentsAtRename, ["draft.json", "staged"],
                       "the directory entered the published area before its plan existed — "
                           + "which is the window the app's sweep deletes into")

        // After it: a complete directory, and the staging directory is gone
        // rather than copied — a rename, not a copy-then-delete.
        XCTAssertFalse(FileManager.default.fileExists(atPath: staging.path),
                       "publication copied rather than renamed")
        let published = store.draftURL(id: plan.id)
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: published.appendingPathComponent("draft.json").path))
        XCTAssertEqual(Set(try FileManager.default.contentsOfDirectory(atPath: published.path)),
                       ["draft.json", "staged"])
        XCTAssertEqual(store.drafts().map(\.id), [plan.id])

        // And a sweep racing that publication cannot have removed it, because
        // at no point was there a plan-less directory in the published area to
        // remove.
        store.sweepIncomplete(grace: 0, now: Date().addingTimeInterval(86_400))
        XCTAssertEqual(store.drafts().map(\.id), [plan.id])
    }

    /// A plan this build cannot read is somebody's complete work, and deleting
    /// it would be destroying the user's files because this build had been
    /// downgraded, upgraded past, or simply confused.
    ///
    /// Both halves matter and they are different failures. A FUTURE version is
    /// the forward-compatibility rule: a plan written by a later build must
    /// survive an earlier one running over it. A MALFORMED plan is the
    /// no-silent-deletion rule: unreadable is not the same as absent.
    func testTheSweepKeepsCompleteWorkItCannotRead() throws {
        let future = try publishDraft(["future.txt": "f"], named: "future.txt")
        let malformed = try publishDraft(["bad.txt": "b"], named: "bad.txt")
        let symlinkedPlan = try publishDraft(["linked.txt": "l"], named: "linked.txt")

        let futurePlan = store.draftURL(id: future.id).appendingPathComponent("draft.json")
        var document = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: try Data(contentsOf: futurePlan))
                as? [String: Any])
        document["version"] = SharedDraftPlan.currentVersion + 1
        try JSONSerialization.data(withJSONObject: document).write(to: futurePlan)

        try Data("{ not json".utf8).write(
            to: store.draftURL(id: malformed.id).appendingPathComponent("draft.json"))

        // A plan that is a symlink — to a perfectly valid plan, so the only
        // thing refusing it can be the indirection itself.
        let linked = store.draftURL(id: symlinkedPlan.id).appendingPathComponent("draft.json")
        let elsewhere = root.appendingPathComponent("elsewhere.json")
        try FileManager.default.moveItem(at: linked, to: elsewhere)
        try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: elsewhere)

        // Far outside any grace window: staleness must not be what saves them.
        store.sweepIncomplete(grace: 0, now: Date().addingTimeInterval(86_400 * 365))

        for (id, description) in [(future.id, "a future version"),
                                  (malformed.id, "a malformed plan"),
                                  (symlinkedPlan.id, "a symlinked plan")] {
            XCTAssertTrue(FileManager.default.fileExists(atPath: store.draftURL(id: id).path),
                          "the sweep deleted the user's bytes over \(description)")
        }
        // Ignored, not offered — quarantined rather than repaired or guessed at.
        XCTAssertEqual(store.drafts(), [])
        XCTAssertNil(store.draft(id: future.id))
        XCTAssertNil(store.draft(id: malformed.id))
        XCTAssertNil(store.draft(id: symlinkedPlan.id))
    }

    // MARK: - path indirection is refused, never resolved

    /// A symlink in this store is never followed and never deleted through.
    ///
    /// The App Group container is writable by every process in the group, so a
    /// reader that opened `<draft>/draft.json` without asking what it is would
    /// follow a link out of the store — and a sweep that removed what it found
    /// there would delete the target rather than the link.
    func testSymlinkedDraftDirectoriesAndStagedEntriesAreRefused() throws {
        let real = try publishDraft(["real.txt": "real"], named: "real.txt")

        // A draft directory that is a symlink to a complete, valid draft.
        let alias = root.appendingPathComponent("44C732CA-2212-4007-9DE3-09FB0E6B420A")
        try FileManager.default.createSymbolicLink(at: alias,
                                                   withDestinationURL: store.draftURL(id: real.id))
        XCTAssertNil(store.draft(id: "44C732CA-2212-4007-9DE3-09FB0E6B420A"),
                     "a symlinked draft directory was followed")
        XCTAssertEqual(store.drafts().map(\.id), [real.id])

        // A staged entry that is a symlink to a file outside the store. Without
        // the refusal this is how a draft names bytes anywhere on the device and
        // has the app upload them under a manifest name the user chose for
        // something else.
        let outside = root.appendingPathComponent("outside.txt")
        try Data("real".utf8).write(to: outside)
        let staged = store.stagedRoot(id: real.id).appendingPathComponent("0")
        try FileManager.default.removeItem(at: staged)
        try FileManager.default.createSymbolicLink(at: staged, withDestinationURL: outside)
        XCTAssertNil(store.draft(id: real.id), "a symlinked staged entry was accepted")
        XCTAssertEqual(store.drafts(), [])

        // And a sweep over all of it removes neither the alias's target nor the
        // file outside the store.
        store.sweepIncomplete(grace: 0, now: Date().addingTimeInterval(86_400 * 365))
        XCTAssertTrue(FileManager.default.fileExists(atPath: outside.path),
                      "the sweep followed a symlink out of the store")
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.draftURL(id: real.id).path))
    }

    /// A `staged/` directory that is a symlink is a refusal too, and it is a
    /// separate one: the entries inside it would each pass their own check.
    func testASymlinkedStagedDirectoryIsRefused() throws {
        let plan = try publishDraft(["a.txt": "hello"], named: "a.txt")
        let staged = store.stagedRoot(id: plan.id)
        let elsewhere = root.appendingPathComponent("elsewhere-staged", isDirectory: true)
        try FileManager.default.moveItem(at: staged, to: elsewhere)
        try FileManager.default.createSymbolicLink(at: staged, withDestinationURL: elsewhere)

        XCTAssertNil(store.draft(id: plan.id))
        XCTAssertEqual(store.drafts(), [])
        XCTAssertThrowsError(try store.stagedFiles(for: plan))
    }

    /// A plan far larger than any legitimate one is refused from `lstat`,
    /// before a byte of it is read into memory.
    func testAnAbsurdlyLargePlanIsRefusedUnread() throws {
        let plan = try publishDraft(["a.txt": "hello"], named: "a.txt")
        let url = store.draftURL(id: plan.id).appendingPathComponent("draft.json")
        // 8 MiB of a JSON document that would otherwise decode.
        var document = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: try Data(contentsOf: url)) as? [String: Any])
        document["padding"] = String(repeating: "p", count: 8 * 1024 * 1024)
        try JSONSerialization.data(withJSONObject: document).write(to: url)

        XCTAssertNil(store.draft(id: plan.id))
        XCTAssertEqual(store.drafts(), [])
    }

    // MARK: - retirement survives a removal that fails

    /// The invariant with teeth: once the app has durably taken ownership, the
    /// draft must never be offered again — and `unlink` returning `EPERM` is not
    /// permission to send the user's files a second time.
    func testARetirementSurvivesAFailedRemovalAndIsRetriedOnRelaunch() throws {
        let manager = UnremovableFileManager()
        let failing = SharedDraftStore(root: root, fileManager: manager)
        let tree = try sourceTree(["owned.txt": "owned"])
        let writer = try failing.beginDraft()
        try writer.adopt(tree.appendingPathComponent("owned.txt"), suggestedName: "owned.txt")
        let plan = try writer.publish()
        XCTAssertEqual(failing.drafts().map(\.id), [plan.id])

        // From here, nothing under this draft can be deleted.
        manager.refusedPrefix = failing.draftURL(id: plan.id).path
        XCTAssertFalse(failing.retire(id: plan.id),
                       "retire reported success over a removal that failed")

        // Hidden anyway. This is the half that matters: the bytes are still
        // there, and the draft is still not on offer.
        XCTAssertEqual(failing.drafts(), [], "a failed removal re-offered a retired draft")
        XCTAssertNil(failing.draft(id: plan.id))
        XCTAssertTrue(FileManager.default.fileExists(atPath: failing.draftURL(id: plan.id).path),
                      "the test did not actually leave the bytes behind")
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: failing.retiredURL(id: plan.id).path), "no durable record was written")

        // Relaunch: a new store over the same directory, with a file manager
        // that works. The retry is idempotent and finishes the job.
        let relaunched = SharedDraftStore(root: root)
        XCTAssertEqual(relaunched.drafts(), [], "the record did not survive the process")
        relaunched.retryRetirements()
        XCTAssertFalse(FileManager.default.fileExists(atPath: relaunched.draftURL(id: plan.id).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: relaunched.retiredURL(id: plan.id).path),
                       "the record outlived the bytes it was hiding")
        XCTAssertEqual(relaunched.drafts(), [])

        // And a second retry over a store with nothing left to do is a no-op.
        relaunched.retryRetirements()
        XCTAssertEqual(relaunched.drafts(), [])
    }

    /// Discard uses the same durable record, for the same reason: a Discard the
    /// filesystem refused must not put the draft back on the Send tab as though
    /// the user had never pressed the button.
    func testADiscardThatCannotDeleteStillRemovesTheOffer() throws {
        let manager = UnremovableFileManager()
        let failing = SharedDraftStore(root: root, fileManager: manager)
        let tree = try sourceTree(["gone.txt": "gone"])
        let writer = try failing.beginDraft()
        try writer.adopt(tree.appendingPathComponent("gone.txt"), suggestedName: "gone.txt")
        let plan = try writer.publish()

        manager.refusedPrefix = failing.draftURL(id: plan.id).path
        XCTAssertFalse(failing.discard(id: plan.id))
        XCTAssertEqual(failing.drafts(), [])
    }

    /// The sweep leaves the retirement bookkeeping alone, and the bookkeeping
    /// does not make a draft look incomplete.
    func testTheSweepDoesNotTouchTheRetirementRecords() throws {
        let manager = UnremovableFileManager()
        let failing = SharedDraftStore(root: root, fileManager: manager)
        let tree = try sourceTree(["kept.txt": "kept"])
        let writer = try failing.beginDraft()
        try writer.adopt(tree.appendingPathComponent("kept.txt"), suggestedName: "kept.txt")
        let plan = try writer.publish()
        manager.refusedPrefix = failing.draftURL(id: plan.id).path
        XCTAssertFalse(failing.retire(id: plan.id))

        let working = SharedDraftStore(root: root)
        working.sweepIncomplete(grace: 0, now: Date().addingTimeInterval(86_400 * 365))
        XCTAssertTrue(FileManager.default.fileExists(atPath: working.retiredURL(id: plan.id).path),
                      "the sweep deleted the record that keeps a retired draft hidden")
        XCTAssertEqual(working.drafts(), [])
    }

    /// A writer that is simply dropped — a cancelled sheet, a view controller
    /// the host tore down — leaves nothing, because `deinit` abandons it.
    ///
    /// It is worth being exact about what that does and does not cover:
    /// `deinit` fires when the last reference goes, which is the teardown case.
    /// It does NOT fire when the system kills the extension outright — nothing
    /// does — and the bytes such a death leaves behind are
    /// `sweepIncomplete`'s to reclaim, from a later process.
    func testADroppedWriterTakesItsBytesWithIt() throws {
        var staging: URL?
        try autoreleasepool {
            let writer = try store.beginDraft()
            let tree = try sourceTree(["dropped.txt": "dropped"])
            try writer.adopt(tree.appendingPathComponent("dropped.txt"),
                             suggestedName: "dropped.txt")
            staging = store.stagingRoot.appendingPathComponent(writer.id)
            XCTAssertTrue(FileManager.default.fileExists(atPath: staging!.path))
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: try XCTUnwrap(staging).path),
                       "a cancelled share left a partial copy of the user's files behind")
        XCTAssertEqual(store.drafts(), [])
    }

    /// Cancellation reaches the copy loop, which runs inside a provider callback
    /// with no task context at all — so a flag is the only signal that gets
    /// there.
    func testCancellationStopsTheWalkAndPublishesNothing() throws {
        var layout: [String: String] = [:]
        for index in 0..<40 { layout["batch/\(index).txt"] = "x" }
        let tree = try sourceTree(layout)
        let writer = try store.beginDraft()
        writer.cancel()
        XCTAssertThrowsError(try writer.adopt(tree.appendingPathComponent("batch"),
                                              suggestedName: "batch")) { error in
            XCTAssertEqual(error as? SharedDraftError, .cancelled)
        }
        XCTAssertThrowsError(try writer.publish())
        XCTAssertEqual(store.drafts(), [])
    }

    /// **Cancel returns while a copy is still running, holding the writer's own
    /// lock.**
    ///
    /// The bug this pins is not theoretical and it was not a race: `adopt` holds
    /// `lock` from its first byte to its last, and a cancellation flag guarded by
    /// that same lock could not be *set* until the copy it was meant to stop had
    /// finished. On a shared video that made Cancel a button that did nothing
    /// for a minute and then reported success.
    ///
    /// Deterministic on purpose. The barrier stops the writer inside `adopt`
    /// with the lock held and keeps it there until this test says otherwise, so
    /// the assertion is about the lock discipline rather than about how fast the
    /// machine running it copies a large file.
    func testCancelReturnsWhileACopyIsBlockedAndTheLateCopyPublishesNothing() throws {
        let barrier = BarrierFileManager()
        let blocking = SharedDraftStore(root: root, fileManager: barrier)
        let tree = try sourceTree(["blocked/a.txt": "a", "blocked/b.txt": "b"])
        let writer = try blocking.beginDraft()
        let staging = blocking.stagingRoot.appendingPathComponent(writer.id)

        final class Box: @unchecked Sendable { var error: Error? }
        let box = Box()
        let copied = DispatchSemaphore(value: 0)
        // The next `attributesOfItem` — which is `classify`, called from inside
        // `adopt` with the ownership lock already held. Armed by call rather than
        // by path because the path the writer builds is its own business.
        barrier.armNext()
        DispatchQueue.global().async {
            do {
                try writer.adopt(tree.appendingPathComponent("blocked"), suggestedName: "blocked")
            } catch {
                box.error = error
            }
            // The copy's own context abandons what it staged. The main actor
            // must never do this: the bytes belong to a copy that still owns
            // them, and reaching for them would mean taking the lock this copy
            // is holding.
            writer.abandon()
            copied.signal()
        }
        XCTAssertEqual(barrier.reached.wait(timeout: .now() + 10), .success,
                       "the copy never reached the barrier")

        let returned = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            writer.cancel()
            returned.signal()
        }
        XCTAssertEqual(returned.wait(timeout: .now() + 2), .success,
                       "Cancel blocked behind a copy that is still in progress")
        XCTAssertTrue(writer.isCancelled)
        // And the copy really is still stuck: nothing has been released.
        XCTAssertEqual(copied.wait(timeout: .now() + 0.2), .timedOut)

        barrier.release.signal()
        XCTAssertEqual(copied.wait(timeout: .now() + 10), .success)

        XCTAssertEqual(box.error as? SharedDraftError, .cancelled,
                       "the copy loop never observed the cancellation")
        XCTAssertThrowsError(try writer.publish(), "a cancelled writer published")
        XCTAssertEqual(blocking.drafts(), [], "a cancelled share published a draft")
        XCTAssertFalse(FileManager.default.fileExists(atPath: staging.path),
                       "a cancelled share left the user's bytes behind")
    }

    // MARK: - names

    func testAProviderNameIsReducedToOneComponent() {
        XCTAssertEqual(sanitizedRootName("/etc/passwd"), "passwd")
        XCTAssertEqual(sanitizedRootName("../../escape.txt"), "escape.txt")
        XCTAssertEqual(sanitizedRootName("holiday:2026.jpg"), "holiday2026.jpg")
        XCTAssertEqual(sanitizedRootName("  spaced.pdf  "), "spaced.pdf")
        XCTAssertEqual(sanitizedRootName(".."), "")
        XCTAssertEqual(sanitizedRootName("."), "")
        XCTAssertEqual(sanitizedRootName(""), "")
    }

    func testTheManifestNameRuleRefusesEverythingThatCouldLeaveTheTree() {
        XCTAssertTrue(validManifestName("a.txt"))
        XCTAssertTrue(validManifestName("trip/day 1/a.txt"))
        XCTAssertFalse(validManifestName(""))
        XCTAssertFalse(validManifestName("/absolute"))
        XCTAssertFalse(validManifestName("a//b"))
        XCTAssertFalse(validManifestName("a/../b"))
        XCTAssertFalse(validManifestName("a/./b"))
        XCTAssertFalse(validManifestName("a\\b"))
        XCTAssertFalse(validManifestName(String(repeating: "n", count: SHARED_DRAFT_MAX_NAME_BYTES + 1)))
    }

    func testTheDraftIdentifierAcceptsOnlyOneSpelling() {
        let id = SharedDraftID.make()
        XCTAssertTrue(SharedDraftID.isValid(id))
        XCTAssertFalse(SharedDraftID.isValid(id.lowercased()))
        XCTAssertFalse(SharedDraftID.isValid(""))
        XCTAssertFalse(SharedDraftID.isValid("../../etc"))
        XCTAssertFalse(SharedDraftID.isValid(String(id.dropLast())))
        XCTAssertFalse(SharedDraftID.isValid(id + "-0000"))
    }
}
