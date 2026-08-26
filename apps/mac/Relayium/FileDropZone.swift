import SwiftUI
import UniformTypeIdentifiers
import RelayiumAppKit

/// **The one way a Finder drag becomes a staged selection, wearable by any
/// view.**
///
/// A drop is not a send and it is not a choice of peer. It is another spelling
/// of the picker, so it lands in the same `SelectionStore.add` the picker calls,
/// under the same expansion, the same `MAX_FILES` and per-path bounds, the same
/// symlink refusal, the same de-duplication and the same plan and account gates
/// the Send control already applies. What a surface does with the staged batch
/// afterwards is that surface's business, and every one of them still requires
/// the user to press something.
///
/// It is a modifier rather than a box because the three surfaces that need it
/// look nothing alike: `FileDropZone` is a dashed rectangle that is the whole
/// affordance, `TransferLinkPane` is two buttons and a hint under a live link,
/// and `DeviceConversationPage` is a row inside a grouped `Form` where a dashed
/// rectangle would read as a control the row does not have. One adapter and
/// three presentations is what stops the busy rule, the append rule and the
/// all-or-nothing rule from being written three times and drifting twice.
///
/// ## The two rules that are not obvious
///
/// **Admission is re-read after the suspension, and it is re-read about the same
/// TARGET.** AppKit accepts a drop before the payload exists. Resolving the item
/// providers is asynchronous, and a transfer can start, a link can end or a
/// device can be revoked while it is in flight — so being allowed to accept the
/// drop is not authority to mutate the selection once it lands. `isBusy` is a
/// closure, called again on the far side.
///
/// `isBusy` alone is not enough, because a surface can be *replaced* rather than
/// merely occupied. `TransferLinkPane` survives its link ending and is reused
/// for the next attempt, `@StateObject` selection and all; a drag that began on
/// the old attempt would find the new one open, unverified-free and not busy,
/// and stage a batch onto a peer nobody dropped it on. `context` is that
/// surface's identity, captured SYNCHRONOUSLY while AppKit is still deciding and
/// compared again after the load — the one fact about the far side of the
/// suspension that a state read cannot supply. See `FileDropContext`.
///
/// **A batch is admitted whole or not at all.** See `FileDropAdmission`.
///
/// Sandbox note: URLs from a drag pasteboard are issued a sandbox extension by
/// the OS when the user hands them over, and that extension lasts for the life
/// of this process — which is why staging can enumerate a folder now and open
/// its files afterwards. `startAccessingSecurityScopedResource` is for URLs
/// restored from a security-scoped BOOKMARK, which this app does not use;
/// calling it here would return false and prove nothing.
struct FileDropReceiver: ViewModifier {
    let store: SelectionStore
    /// A live read, never the value from the render that accepted the drop.
    let isBusy: () -> Bool
    /// **Which target this surface is serving, right now.** Read twice — once
    /// while the drop is being accepted and once after the payload arrives — and
    /// the batch is refused if the answer changed. A surface that cannot be
    /// substituted passes `FileDropContext.fixed`, and it has to say so: there
    /// is no default, because the surfaces that need a token are exactly the
    /// ones whose author is most likely to believe theirs is stable.
    let context: () -> FileDropContext
    /// Where the all-or-nothing refusal goes, and `nil` to withdraw one that an
    /// accepted drag has since answered. A surface that passes nothing here is
    /// a surface that would refuse a drag in silence, so nobody may default it.
    let onRefusal: (String?) -> Void
    @Binding var isTargeted: Bool

    func body(content: Content) -> some View {
        content.onDrop(of: [.fileURL], isTargeted: $isTargeted) { providers in
            // Declining at drop time is what makes the cursor say no while a
            // transfer owns the selection. The target still exists — one that
            // vanished mid-drag would be worse than one that declines.
            guard !isBusy() else { return false }
            // Captured HERE, synchronously, while AppKit is still asking. Read
            // inside the `Task` it would be the target that exists after the
            // hop — which on a loaded machine may already be the substitution
            // this exists to catch, recorded as the one the user dropped onto.
            let droppedInto = context()
            Task { @MainActor in
                let items = await droppedItems(providers)
                // The drop was admitted before this load. Re-read ownership AND
                // identity on the far side of the suspension: the surface may
                // have been occupied, and it may have been replaced.
                switch admitFileDrop(items, isBusy: isBusy(),
                                     droppedInto: droppedInto, nowServing: context()) {
                case .refusedBusy, .refusedStaleContext, .empty:
                    // Nothing staged and nothing said: whatever took ownership
                    // is already on screen saying so, and a second sentence
                    // beside it would be a second chance to disagree. A stale
                    // batch is the strongest case for silence — the surface now
                    // in front of the user has nothing to do with the drag, so
                    // an error on it would describe somebody else's mistake.
                    return
                case .refusedUnreadable:
                    onRefusal(L10n.t(.dropRefusedUnreadable))
                case let .accepted(urls):
                    // Staging only. **A drop must never start a transfer by
                    // itself**: the peer or the device is chosen separately, and
                    // a drop that dialled whoever happened to be selected is how
                    // files go to the wrong machine.
                    onRefusal(nil)
                    store.add(urls)
                }
            }
            return true
        }
        // **A refusal is withdrawn by the next thing that changes the batch**,
        // whatever that thing was: another drag, either picker, Clear, or a Send
        // the model took. Without this, "nothing was added" stays on screen
        // beside a selection the user has since successfully built through the
        // button, describing a batch that is no longer what they are looking at.
        //
        // `revision` rather than the file list, because two different selections
        // can have the same count — that is the whole reason the store publishes
        // it. A refusal stages nothing, so it never bumps this itself and cannot
        // clear the message it just set.
        .onChange(of: store.revision) { _ in onRefusal(nil) }
    }
}

extension View {
    /// Accept Finder drags into `store`, refusing while `isBusy` and refusing a
    /// batch whose `context` was replaced while its payload was resolving.
    ///
    /// Neither `context` nor `onRefusal` has a default, on purpose — see
    /// `FileDropReceiver.context` and `FileDropReceiver.onRefusal`.
    func acceptsFileDrop(into store: SelectionStore,
                         isBusy: @escaping () -> Bool,
                         context: @escaping () -> FileDropContext,
                         isTargeted: Binding<Bool>,
                         onRefusal: @escaping (String?) -> Void) -> some View {
        modifier(FileDropReceiver(store: store, isBusy: isBusy, context: context,
                                  onRefusal: onRefusal, isTargeted: isTargeted))
    }
}

/// Resolve a drag's providers to their raw payloads, in the order they were
/// dropped. Decoding and admission are `admitFileDrop`'s, in RelayiumAppKit,
/// where `swift test` can reach them without AppKit or a live drag.
///
/// Serial rather than concurrent: the order becomes manifest order, and a set of
/// promises resolved concurrently would produce a different manifest for the
/// same drag each time.
@MainActor
func droppedItems(_ providers: [NSItemProvider]) async -> [Any?] {
    var items: [Any?] = []
    for provider in providers {
        items.append(await droppedItem(provider))
    }
    return items
}

/// One provider's payload, or nil if it could not be produced.
///
/// Bridged by hand rather than through the generated `async` overload because
/// the completion handler belongs to the **drag source** — code in another
/// application — and resuming a continuation twice is a runtime trap rather
/// than a recoverable error. `OneShotClaim` makes the resume one-shot, so a
/// source that calls back twice is ignored instead of terminating Relayium.
@MainActor
func droppedItem(_ provider: NSItemProvider) async -> Any? {
    await withCheckedContinuation { (continuation: CheckedContinuation<Any?, Never>) in
        let once = OneShotClaim()
        provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier,
                          options: nil) { item, _ in
            guard once.claim() else { return }
            continuation.resume(returning: item)
        }
    }
}

/// The one drop target and the one file picker the app has.
///
/// Every send surface used to grow its own: the cloud pane had a drop zone that
/// filtered directories out, and the two realtime panes had a picker with
/// `canChooseDirectories = false` and no drop at all. Three implementations of
/// "what may a user hand us" is three places for the folder rule, the busy rule
/// and the append rule to be different.
///
/// This is the *dashed box* presentation of `FileDropReceiver`, for a surface
/// where the drop target is the whole affordance. A surface whose file
/// affordance is a button wears the modifier directly instead.
///
/// Readability is not merely checked, it is HELD: `FileURLSource` opens each
/// selected file when the batch is staged and keeps that descriptor until the
/// batch is released, reading through it rather than reopening the path. So a
/// selection this Mac cannot read fails before a connection is opened, and the
/// bytes that go out are the ones the user approved even if the paths are
/// rearranged while the transfer waits for a peer.
struct FileDropZone<Label: View>: View {
    /// Where a drop and a click both land. Both append, so neither a second
    /// drop nor a trip through the picker can discard what is already staged.
    let store: SelectionStore
    /// Drops and clicks are ignored while a transfer owns the selection. The
    /// zone still renders — a target that vanishes mid-drag is worse than one
    /// that declines.
    /// A live read rather than the value from the render that accepted a drop.
    /// Resolving item providers is asynchronous; a transfer may start before
    /// their URLs return.
    let isBusy: () -> Bool
    @ViewBuilder let label: () -> Label

    @State private var isTargeted = false
    /// Owned here rather than reported to the caller, so no construction of this
    /// view can refuse a drag in silence.
    @State private var refusal: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.tight) {
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [6]))
                .foregroundStyle(isTargeted && !isBusy() ? Color.accentColor : Color.secondary)
                .frame(minHeight: 96)
                .overlay(label().padding(8))
                .contentShape(Rectangle())
                .onTapGesture { if !isBusy() { chooseFilesOrFolders(into: store) } }
                // **`fixed`, and this is the one presentation entitled to it.**
                // The dashed box exists for a surface where the drop target is
                // the whole affordance, which is a surface with one destination:
                // the stored-upload pane sends to this account's own storage,
                // chosen by nothing and unaffected by any connection, so there
                // is no substitution for a token to catch. A surface holding a
                // peer, a link or a device is not this shape — it wears
                // `acceptsFileDrop` directly and supplies its own identity.
                .acceptsFileDrop(into: store, isBusy: isBusy,
                                 context: { .fixed },
                                 isTargeted: $isTargeted,
                                 onRefusal: { refusal = $0 })
                .accessibilityLabel(L10n.t(.dropA11yLabel))
                .accessibilityHint(L10n.t(.dropA11yHint))
            if let refusal {
                InlineMessage(.failure, refusal)
                    .accessibilityIdentifier("file-drop-refusal")
            }
        }
    }
}

/// The picker, in the only configuration the app uses: files AND folders, any
/// number of them.
@MainActor
func chooseFilesOrFolders(into store: SelectionStore) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = true
    panel.canChooseFiles = true
    panel.canChooseDirectories = true
    panel.prompt = L10n.t(.pickerPrompt)
    // **The picker appends, exactly like the drop.**
    //
    // It used to replace, on the argument that the panel shows the user their
    // whole intended selection at the moment they press Choose. It does not:
    // `NSOpenPanel` shows the file system, and nothing in it names — or can
    // name — the batch already staged behind it. So a user who dropped a folder
    // and then reached for the button to add one more file silently lost the
    // folder, with no message, no undo and nothing on screen that had said the
    // button was destructive.
    //
    // One rule for every way a file arrives is what makes that impossible:
    // drop appends, an OS-opened batch appends (`adoptOpenedFiles`), and this
    // appends. `SelectionStore.add` de-duplicates against what is already
    // staged, so re-choosing the same items is a no-op rather than a doubled
    // manifest, and **Clear** — already beside this button whenever the
    // selection is non-empty — is the one control that discards a batch, which
    // is where a destructive action belongs.
    if panel.runModal() == .OK { store.add(panel.urls) }
}

/// The same picker restricted to FOLDERS, for a surface that offers "a folder"
/// as a distinct answer from "some files".
///
/// It is a configuration of the one picker rather than a second one: it appends
/// through `SelectionStore.add` exactly as the general form does, so a user who
/// chose files and then reached for Folder adds to the batch instead of silently
/// losing it, and `expandSelection` gives every file inside the chosen folder its
/// `relativePath` — which is what keeps the hierarchy inside the sealed manifest
/// rather than flattening it into a pile on the other device.
///
/// `canChooseFiles = false` is the whole difference and it is not decoration: a
/// control labelled Folder that accepted a file would stage something the user
/// did not choose and describe it as a folder afterwards.
@MainActor
func chooseFolders(into store: SelectionStore) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = true
    panel.canChooseFiles = false
    panel.canChooseDirectories = true
    panel.prompt = L10n.t(.pickerPrompt)
    if panel.runModal() == .OK { store.add(panel.urls) }
}
