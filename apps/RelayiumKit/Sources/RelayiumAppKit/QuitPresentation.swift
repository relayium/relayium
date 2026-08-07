import Foundation
import RelayiumShareKit

/// The two independent costs of terminating the macOS process.
///
/// Kept outside AppKit so the decision and every copy branch are unit-testable.
public enum QuitRisk: Equatable {
    case none
    case transfer
    case localText
    case transferAndLocalText
}

public struct QuitPrompt: Equatable {
    public let title: String
    public let body: String
    public let quitAction: String
    public let stayAction: String
}

public enum QuitPresentation {
    public static func risk(transferRunning: Bool, hasLocalText: Bool) -> QuitRisk {
        switch (transferRunning, hasLocalText) {
        case (false, false): return .none
        case (true, false): return .transfer
        case (false, true): return .localText
        case (true, true): return .transferAndLocalText
        }
    }

    public static func prompt(for risk: QuitRisk,
                              language: AppLanguage? = nil) -> QuitPrompt? {
        let title: L10nKey
        let body: L10nKey
        switch risk {
        case .none:
            return nil
        case .transfer:
            title = .quitTitle
            body = .quitBody
        case .localText:
            title = .quitLocalTextTitle
            body = .quitLocalTextBody
        case .transferAndLocalText:
            title = .quitTitle
            body = .quitTransferAndLocalTextBody
        }
        return QuitPrompt(title: L10n.t(title, language: language),
                          body: L10n.t(body, language: language),
                          quitAction: L10n.t(.quitNow, language: language),
                          stayAction: L10n.t(.quitStay, language: language))
    }
}
