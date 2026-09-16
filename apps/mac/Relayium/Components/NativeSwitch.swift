import AppKit
import SwiftUI

/// An AppKit `NSSwitch`, named, identified and described on the control itself.
///
/// **Why not `Toggle(...).toggleStyle(.switch)`.** On macOS 15 SwiftUI's switch
/// style exposes a check-box proxy whose AppKit switch is not an accessibility
/// child of its parent, and the system accessibility audit reports that orphan.
/// This control is the switch itself, so VoiceOver, keyboard and the audit meet
/// one native element with the switch role.
///
/// **No SwiftUI accessibility modifiers belong on it.** Its name, identifier and
/// help are set here, on the `NSSwitch`; wrapping it in `.accessibilityLabel` or
/// `.accessibilityIdentifier` would put a SwiftUI proxy back in front of it.
/// `.disabled` is fine — it is read from the environment, not the tree.
struct NativeSwitch: NSViewRepresentable {
    /// The spoken name. The visible words beside the switch say the same thing.
    let label: String
    let identifier: String
    /// The tooltip, and the accessibility help VoiceOver reads after the name.
    var help: String?
    /// Read on every update and after every press, so a write the binding's
    /// setter refuses snaps the switch back to the truth.
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
        let state: NSControl.StateValue = isOn.wrappedValue ? .on : .off
        if control.state != state { control.state = state }
        control.isEnabled = context.environment.isEnabled
        control.setAccessibilityLabel(label)
        control.setAccessibilityIdentifier(identifier)
        control.setAccessibilityHelp(help)
        control.toolTip = help
    }

    final class Coordinator: NSObject {
        var isOn: Binding<Bool>

        init(isOn: Binding<Bool>) { self.isOn = isOn }

        @objc func toggled(_ sender: NSSwitch) {
            isOn.wrappedValue = sender.state == .on
            // A setter may refuse (a session claimed since the last render), and
            // a refusal changes no state SwiftUI would redraw for. Re-read on the
            // next turn, after any accepted write has published.
            DispatchQueue.main.async { [weak self, weak sender] in
                guard let self, let sender else { return }
                let state: NSControl.StateValue = self.isOn.wrappedValue ? .on : .off
                if sender.state != state { sender.state = state }
            }
        }
    }
}
