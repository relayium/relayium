import Foundation
import RelayiumShareKit

/// The two independent costs of terminating the macOS process.
///
/// Kept outside AppKit so the decision and every copy branch are unit-testable.
public enum QuitRisk: Equatable {
    case none
    case transfer
    case textHistory
    case transferAndTextHistory
}

public struct QuitPrompt: Equatable {
    public let title: String
    public let body: String
    public let quitAction: String
    public let stayAction: String
}

public enum QuitPresentation {
    public static func risk(transferRunning: Bool, hasTextHistory: Bool) -> QuitRisk {
        switch (transferRunning, hasTextHistory) {
        case (false, false): return .none
        case (true, false): return .transfer
        case (false, true): return .textHistory
        case (true, true): return .transferAndTextHistory
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
        case .textHistory:
            title = .quitHistoryTitle
            body = .quitHistoryBody
        case .transferAndTextHistory:
            title = .quitTitle
            body = .quitTransferAndHistoryBody
        }
        return QuitPrompt(title: L10n.t(title, language: language),
                          body: L10n.t(body, language: language),
                          quitAction: L10n.t(.quitNow, language: language),
                          stayAction: L10n.t(.quitStay, language: language))
    }
}
