import AppKit
import SwiftUI
import RelayiumAppKit

/// Where the window's own controls ended up, measured from the real window.
///
/// The sidebar's top row and the detail toolbar are drawn by SwiftUI under a
/// transparent title bar, so they have to line up with traffic lights AppKit
/// places. Measuring them rather than assuming a constant keeps that true on
/// every macOS version and at every title-bar height.
struct WindowControlsMetrics: Equatable {
    /// The vertical centre of the close button, from the top of the window.
    var controlsMidY: CGFloat = 20
    /// The trailing edge of the zoom button, from the leading edge.
    var controlsMaxX: CGFloat = 70
    /// The title bar's own height.
    var titlebarHeight: CGFloat = 28
}

/// Puts the window into the reference's chrome: the real traffic lights, a
/// transparent title bar, no drawn title, and content running underneath.
///
/// **The title is hidden, not removed.** `navigationTitle` still names the
/// window for Mission Control, the Window menu, VoiceOver and the UI suite's
/// title predicates; it is only not DRAWN, because the detail toolbar draws it
/// beside its subtitle and live status instead.
struct WindowChrome: NSViewRepresentable {
    @Binding var metrics: WindowControlsMetrics

    func makeNSView(context: Context) -> ChromeView {
        let view = ChromeView()
        view.onMetrics = { next in
            if metrics != next { metrics = next }
        }
        return view
    }

    func updateNSView(_ nsView: ChromeView, context: Context) {
        nsView.onMetrics = { next in
            if metrics != next { metrics = next }
        }
        nsView.apply()
    }

    final class ChromeView: NSView {
        var onMetrics: ((WindowControlsMetrics) -> Void)?
        private var observers: [NSObjectProtocol] = []

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            observers.forEach(NotificationCenter.default.removeObserver)
            observers = []
            guard let window else { return }
            for name in [NSWindow.didResizeNotification,
                         NSWindow.didEnterFullScreenNotification,
                         NSWindow.didExitFullScreenNotification] {
                observers.append(NotificationCenter.default.addObserver(
                    forName: name, object: window, queue: .main) { [weak self] _ in
                        self?.measure()
                    })
            }
            apply()
        }

        deinit {
            observers.forEach(NotificationCenter.default.removeObserver)
        }

        func apply() {
            guard let window else { return }
            if !window.styleMask.contains(.fullSizeContentView) {
                window.styleMask.insert(.fullSizeContentView)
            }
            if !window.titlebarAppearsTransparent { window.titlebarAppearsTransparent = true }
            if window.titleVisibility != .hidden { window.titleVisibility = .hidden }
            if window.titlebarSeparatorStyle != .none { window.titlebarSeparatorStyle = .none }
            DispatchQueue.main.async { [weak self] in self?.measure() }
        }

        private func measure() {
            guard let window,
                  let close = window.standardWindowButton(.closeButton),
                  let zoom = window.standardWindowButton(.zoomButton),
                  let frameView = window.contentView?.superview
            else { return }
            let closeFrame = close.convert(close.bounds, to: frameView)
            let zoomFrame = zoom.convert(zoom.bounds, to: frameView)
            let height = frameView.bounds.height
            // The theme frame is not flipped: y grows upward from the bottom.
            let midY = height - closeFrame.midY
            let titlebar = height - window.contentLayoutRect.maxY
            onMetrics?(WindowControlsMetrics(controlsMidY: midY.rounded(),
                                             controlsMaxX: zoomFrame.maxX.rounded(),
                                             titlebarHeight: max(titlebar, 0).rounded()))
        }
    }
}

/// An empty stretch of chrome the window can be moved by, and double-clicked
/// the way the user's Dock setting says a title bar should be.
///
/// Drawn under the sidebar's control row and the detail toolbar, which are
/// SwiftUI content now rather than AppKit's title bar and would otherwise take
/// the mouse without moving anything.
struct WindowDragArea: NSViewRepresentable {
    func makeNSView(context: Context) -> DragView { DragView() }
    func updateNSView(_ nsView: DragView, context: Context) {}

    final class DragView: NSView {
        override var mouseDownCanMoveWindow: Bool { true }

        override func mouseDown(with event: NSEvent) {
            guard let window else { return }
            if event.clickCount == 2 {
                // nonlocalized: system defaults key and values
                switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
                case "Minimize": window.performMiniaturize(nil)
                case "None": break
                default: window.performZoom(nil)
                }
                return
            }
            window.performDrag(with: event)
        }
    }
}

/// What a destination's toolbar needs to know about the shell around it.
struct ShellChrome {
    var sidebarVisible: Bool = true
    var controls: WindowControlsMetrics = WindowControlsMetrics()
    var toggleSidebar: () -> Void = {}
}

private struct ShellChromeKey: EnvironmentKey {
    static let defaultValue = ShellChrome()
}

extension EnvironmentValues {
    var shellChrome: ShellChrome {
        get { self[ShellChromeKey.self] }
        set { self[ShellChromeKey.self] = newValue }
    }
}

/// The reference's sidebar glyph: a rounded pane with a divided leading third.
/// A real control — it hides and shows the sidebar — and it says so.
struct SidebarToggleButton: View {
    let sidebarVisible: Bool
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: "sidebar.left")
                .font(.body)
                .foregroundStyle(hovering ? Palette.text : Palette.textTertiary)
                .frame(width: 28, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .keyboardShortcut("s", modifiers: [.command, .control])
        .help(L10n.t(sidebarVisible ? .navHideSidebar : .navShowSidebar))
        .accessibilityLabel(L10n.t(sidebarVisible ? .navHideSidebar : .navShowSidebar))
        .accessibilityIdentifier("sidebar-toggle")
    }
}
