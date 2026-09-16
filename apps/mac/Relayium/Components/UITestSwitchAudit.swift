#if DEBUG
import AppKit
import SwiftUI

/// **DIAGNOSTIC MATRIX, DEBUG and UI-test launches only — not a fix, and never
/// in Release.** The whole file is inside `#if DEBUG`.
///
/// Hosted macOS 15's accessibility audit reports a Parent/Child mismatch with no
/// element — one on Cross-network Transfer, two on LAN Transfer — and the count
/// matches the redesigned switches. One launch argument,
/// `--relayium-ui-testing-switch-variant=<v0…v4>`, selects how BOTH switches
/// (verification and LAN receiving) are built, so one hosted run can compare:
///
///  - `v0` the shipped construction, unchanged (the control);
///  - `v1` `.switch` with its title visible (no `labelsHidden`);
///  - `v2` the shipped switch, with the groups that contain it no longer
///    `.accessibilityElement(children: .contain)` + label;
///  - `v3` an AppKit `NSSwitch` whose name, identifier and help are set on the
///    control itself, with no SwiftUI accessibility modifier;
///  - `v4` the default (checkbox) toggle style with its title hidden.
///
/// Without the argument — every product launch and every other UI test — the
/// switches and their groups take exactly the shipped construction. Any
/// argument (including `v0`) also starts `NativeWalk`, which records the
/// window's own AppKit accessibility parent/child inconsistencies to a named
/// pasteboard, outside the accessibility tree the audit reads.
enum UITestSwitchAudit {
    enum Variant: String, CaseIterable {
        case control = "v0"
        case visibleLabel = "v1"
        case uncontained = "v2"
        case nativeSwitch = "v3"
        case checkbox = "v4"
    }

    // nonlocalized: a test-only launch argument prefix, absent from Release
    static let argumentPrefix = "--relayium-ui-testing-switch-variant="

    /// The variant this launch asked for, or `nil` for every ordinary launch.
    static let requested: Variant? = {
        guard UITestMode.isActive else { return nil }
        for argument in ProcessInfo.processInfo.arguments where argument.hasPrefix(argumentPrefix) {
            return Variant(rawValue: String(argument.dropFirst(argumentPrefix.count)))
        }
        return nil
    }()

    static var variant: Variant { requested ?? .control }

    /// One of the two audited switches: the shipped view unless a variant asks
    /// for another construction of the same control.
    struct Slot<Shipped: View>: View {
        let title: String
        let identifier: String
        let help: String?
        /// Read live, so the native variant never renders a stale state.
        let isOn: Binding<Bool>
        @ViewBuilder let shipped: () -> Shipped

        var body: some View {
            switch UITestSwitchAudit.variant {
            case .control, .uncontained:
                shipped()
            case .visibleLabel:
                decorated(Toggle(title, isOn: isOn).toggleStyle(.switch))
            case .checkbox:
                decorated(Toggle(title, isOn: isOn).labelsHidden())
            case .nativeSwitch:
                NativeSwitch(title: title, identifier: identifier, help: help, isOn: isOn)
                    .fixedSize()
            }
        }

        @ViewBuilder
        private func decorated<V: View>(_ toggle: V) -> some View {
            if let help {
                toggle.help(help).accessibilityHint(help).accessibilityIdentifier(identifier)
            } else {
                toggle.accessibilityIdentifier(identifier)
            }
        }
    }

    /// The group semantics `SectionCard` and `StatusHero` ship, withheld only in
    /// `v2` and only around a group that holds one of the audited switches.
    struct GroupSemantics: ViewModifier {
        let label: String
        @Environment(\.uiTestHoldsAuditedSwitch) private var holdsSwitch

        func body(content: Content) -> some View {
            if UITestSwitchAudit.variant == .uncontained && holdsSwitch {
                content
            } else {
                content
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel(label)
            }
        }
    }

    /// `v3`: an AppKit switch, named and identified on the `NSSwitch` itself.
    ///
    /// The binding's setter keeps its lock re-check; `isEnabled` follows the
    /// SwiftUI environment (`.disabled`) on every update; the state is re-read
    /// from the binding after a press, so a refused write snaps back.
    struct NativeSwitch: NSViewRepresentable {
        let title: String
        let identifier: String
        let help: String?
        let isOn: Binding<Bool>

        func makeCoordinator() -> Coordinator { Coordinator(isOn: isOn) }

        func makeNSView(context: Context) -> NSSwitch {
            let control = NSSwitch()
            control.target = context.coordinator
            control.action = #selector(Coordinator.toggled(_:))
            return control
        }

        func updateNSView(_ control: NSSwitch, context: Context) {
            context.coordinator.isOn = isOn
            control.state = isOn.wrappedValue ? .on : .off
            control.isEnabled = context.environment.isEnabled
            control.setAccessibilityLabel(title)
            control.setAccessibilityIdentifier(identifier)
            control.setAccessibilityHelp(help)
            control.toolTip = help
        }

        final class Coordinator: NSObject {
            var isOn: Binding<Bool>
            init(isOn: Binding<Bool>) { self.isOn = isOn }

            @objc func toggled(_ sender: NSSwitch) {
                isOn.wrappedValue = sender.state == .on
                DispatchQueue.main.async { [weak self, weak sender] in
                    guard let self, let sender else { return }
                    sender.state = self.isOn.wrappedValue ? .on : .off
                }
            }
        }
    }

    /// The window's own accessibility parent/child consistency, walked in
    /// process, written to a named pasteboard the UI test reads after its audit
    /// passes — so the record is never an element of the tree being audited.
    @MainActor
    enum NativeWalk {
        // nonlocalized: a test-only pasteboard name, absent from Release
        static let pasteboardName = NSPasteboard.Name("com.relayium.uitest.switch-audit")
        private static var timer: Timer?

        static func startIfRequested() {
            guard UITestSwitchAudit.requested != nil, timer == nil else { return }
            timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
                MainActor.assumeIsolated { publish() }
            }
        }

        private static func publish() {
            guard let window = NSApp.windows
                .filter({ $0.isVisible && $0.frame.width >= 800 })
                .max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })
            else { return }
            let report = walk(window)
            let board = NSPasteboard(name: pasteboardName)
            board.clearContents()
            board.setString(report, forType: .string)
        }

        private static let nodeCap = 6_000
        private static let depthCap = 60

        static func walk(_ window: NSWindow) -> String {
            var lines: [String] = ["variant=\(UITestSwitchAudit.variant.rawValue) window=\(window.title)"]
            var visited = Set<ObjectIdentifier>()
            var nodes = 0
            var downMismatches = 0

            // Walk 1: down from the window, every child whose parent does not
            // point back at the element that listed it.
            func down(_ element: AnyObject, depth: Int) {
                guard depth < depthCap, nodes < nodeCap,
                      visited.insert(ObjectIdentifier(element)).inserted,
                      let parent = element as? NSAccessibilityProtocol,
                      let children = parent.accessibilityChildren() else { return }
                nodes += 1
                for case let child as AnyObject in children {
                    let back = (child as? NSAccessibilityProtocol)?.accessibilityParent() as AnyObject?
                    if back !== element {
                        downMismatches += 1
                        lines.append("DOWN " + describe(child) + " listedBy=" + describe(element)
                                     + " parentSays=" + describe(back))
                    }
                    down(child, depth: depth + 1)
                }
            }
            down(window, depth: 0)

            // Walk 2: every AppKit view that is an accessibility element, up its
            // parent chain, each parent checked to list the child.
            var upMismatches = 0
            var views = 0
            func up(_ view: NSView, depth: Int) {
                guard depth < depthCap, views < nodeCap else { return }
                views += 1
                if view.isAccessibilityElement() || view.accessibilityRole() != nil {
                    var current: AnyObject = view
                    var hops = 0
                    while hops < depthCap,
                          let parent = (current as? NSAccessibilityProtocol)?
                            .accessibilityParent() as AnyObject? {
                        let listed = (parent as? NSAccessibilityProtocol)?
                            .accessibilityChildren()?.contains { ($0 as AnyObject) === current } ?? false
                        if !listed {
                            upMismatches += 1
                            lines.append("UP " + describe(current) + " parent=" + describe(parent)
                                         + " fromView=" + String(describing: type(of: view)))
                        }
                        if parent === window { break }
                        current = parent
                        hops += 1
                    }
                }
                for subview in view.subviews { up(subview, depth: depth + 1) }
            }
            if let root = window.contentView?.superview ?? window.contentView { up(root, depth: 0) }

            // The two audited switches, as the window itself exposes them.
            for (id, element) in findSwitches(in: window, visitedFrom: visited) {
                let parent = (element as? NSAccessibilityProtocol)?.accessibilityParent() as AnyObject?
                lines.append("SWITCH id=\(id) " + describe(element) + " parent=" + describe(parent))
            }

            lines.insert("nodes=\(nodes) views=\(views) downMismatches=\(downMismatches) "
                         + "upMismatches=\(upMismatches)", at: 1)
            return lines.joined(separator: "\n")
        }

        private static func findSwitches(in window: NSWindow,
                                         visitedFrom: Set<ObjectIdentifier>) -> [(String, AnyObject)] {
            let wanted: Set<String> = ["transfer-verification-toggle", "lan-receiving-switch"]
            var found: [(String, AnyObject)] = []
            var seen = Set<ObjectIdentifier>()
            func search(_ element: AnyObject, depth: Int) {
                guard depth < depthCap, found.count < 8,
                      seen.insert(ObjectIdentifier(element)).inserted,
                      let node = element as? NSAccessibilityProtocol else { return }
                if let id = node.accessibilityIdentifier(), wanted.contains(id) {
                    found.append((id, element))
                }
                for case let child as AnyObject in node.accessibilityChildren() ?? [] {
                    search(child, depth: depth + 1)
                }
            }
            search(window, depth: 0)
            return found
        }

        private static func describe(_ object: AnyObject?) -> String {
            guard let object else { return "nil" }
            guard let node = object as? NSAccessibilityProtocol else {
                return String(describing: type(of: object))
            }
            let role = node.accessibilityRole()?.rawValue ?? "-"
            let subrole = node.accessibilitySubrole()?.rawValue ?? "-"
            let id = node.accessibilityIdentifier() ?? ""
            let label = node.accessibilityLabel() ?? ""
            let frame = node.accessibilityFrame()
            return "[\(type(of: object)) role=\(role) subrole=\(subrole) id=\(id) "
                + "label=\(label.prefix(40)) frame=\(frame)]"
        }
    }
}

private struct UITestHoldsAuditedSwitchKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// Set around a group that holds one of the audited switches, so `v2` can
    /// withhold that group's semantics and no other.
    var uiTestHoldsAuditedSwitch: Bool {
        get { self[UITestHoldsAuditedSwitchKey.self] }
        set { self[UITestHoldsAuditedSwitchKey.self] = newValue }
    }
}
#endif
