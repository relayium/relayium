import Foundation

public struct AccountClient {
    let baseURL: URL
    let session: URLSession
    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL; self.session = session
    }

    public func login(email: String, password: String, deviceName: String) async throws -> LoginOutcome {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/auth/native/login"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject:
            ["email": email, "password": password, "deviceName": deviceName])
        let (data, resp) = try await send(req)
        switch resp.statusCode {
        case 200:
            // 200 is EITHER success {token,user} OR pending_deletion {status,...}.
            if let pd = try? JSONDecoder().decode(PendingDeletionBody.self, from: data),
               pd.status == "pending_deletion" {
                return .pendingDeletion(purgeAfter: pd.purgeAfter, reactivateToken: pd.reactivateToken)
            }
            guard let ok = try? JSONDecoder().decode(LoginSuccessBody.self, from: data) else {
                throw AccountError.decoding
            }
            return .success(token: ok.token, user: ok.user)
        case 403:
            guard let b = try? JSONDecoder().decode(ErrorBody.self, from: data), b.error == "email_unverified" else {
                throw AccountError.server(status: 403)
            }
            return .emailUnverified(email: b.email ?? email)
        case 401: throw AccountError.invalidCredentials
        case 429: throw AccountError.rateLimited
        default:  throw AccountError.server(status: resp.statusCode)
        }
    }

    /// Revoke exactly the bearer presented by this native client. A 401 is
    /// idempotent success: the token is already absent or invalid.
    public func logout(token: String) async throws {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/auth/logout"))
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (_, resp) = try await send(req)
        guard resp.statusCode == 200 || resp.statusCode == 401 else {
            throw AccountError.server(status: resp.statusCode)
        }
    }

    func send(_ req: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, resp) = try await session.data(for: req)
            guard let http = resp as? HTTPURLResponse else { throw AccountError.network }
            return (data, http)
        } catch let e as AccountError { throw e }
        catch { throw AccountError.network }
    }
}

private struct PendingDeletionBody: Decodable { let status: String; let purgeAfter: Int64; let reactivateToken: String }
private struct ErrorBody: Decodable { let error: String; let email: String? }

extension AccountClient {
    public func fetchMe(token: String) async throws -> NativeUser {
        try await authedGet("api/me", token: token, as: MeResponse.self).user
    }
    public func fetchUsage(token: String) async throws -> UsageResponse {
        try await authedGet("api/me/usage", token: token, as: UsageResponse.self)
    }

    private func authedGet<T: Decodable>(_ path: String, token: String, as: T.Type) async throws -> T {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = "GET"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await send(req)
        switch resp.statusCode {
        case 200:
            guard let v = try? JSONDecoder().decode(T.self, from: data) else { throw AccountError.decoding }
            return v
        case 401: throw AccountError.invalidCredentials   // stale/invalid bearer
        case 429: throw AccountError.rateLimited
        default:  throw AccountError.server(status: resp.statusCode)
        }
    }
}

/// What the Account tab needs from the server: read this account's devices and
/// stored objects, remove one of either.
///
/// A protocol rather than the concrete client for the same reason `PairClient`
/// and `ResumableTransport` are: the view model's interesting behaviour is what
/// it does when a call is slow, fails, or lands after the account changed, and
/// none of that is reachable through a URL stub.
public protocol AccountManagementService {
    func listDevices(token: String) async throws -> [AccountDevice]
    func deleteDevice(id: String, token: String) async throws
    func listStoredFiles(token: String) async throws -> [StoredFileSummary]
    func deleteStoredFile(id: String, token: String) async throws -> StoredFileDeletion
}

/// How much a stored-file delete actually established.
///
/// The distinction exists because of what a caller may safely destroy on the
/// strength of it. The server answers 404 for an object that is missing, expired
/// or burned — and also when its own read of that row failed. Those are
/// indistinguishable from the client, and the two possible mistakes are not
/// symmetric: keeping the local key for an object that is gone leaves an inert
/// keychain item, while discarding the key for an object that still exists
/// destroys the only thing that could ever open it.
public enum StoredFileDeletion: Equatable {
    /// The server confirmed the object is gone because it removed it.
    case deleted
    /// The server reported nothing there. Almost always true, but not
    /// established: treat the row as gone, keep anything irreplaceable.
    case alreadyGone
}

extension AccountClient: AccountManagementService {}

// MARK: - Account management (devices and stored objects)
//
// Both lists are the same two operations — read the account's rows, remove one —
// against endpoints that already accept a bearer through RequireAuth, so the app
// manages its own credentials and its own ciphertext without a browser.
extension AccountClient {
    public func listDevices(token: String) async throws -> [AccountDevice] {
        try await authedGet("api/devices", token: token, as: DeviceListResponse.self).devices
    }

    /// Revoke one device. Deleting the device a bearer is bound to cascades that
    /// token server-side, so revoking THIS Mac ends this app's own session — the
    /// caller is responsible for signing out locally afterwards.
    public func deleteDevice(id: String, token: String) async throws {
        try await authedDelete("api/devices", id: id, token: token)
    }

    public func listStoredFiles(token: String) async throws -> [StoredFileSummary] {
        try await authedGet("api/files", token: token, as: StoredFileListResponse.self).files
    }

    /// Delete one stored ciphertext object. This removes the bytes; the key that
    /// could decrypt them is a separate, local concern (`StoredLinkKeyStore`),
    /// which is why the outcome distinguishes a confirmed delete from a 404.
    public func deleteStoredFile(id: String, token: String) async throws -> StoredFileDeletion {
        try await authedDelete("api/files", id: id, token: token)
    }

    /// `DELETE {collection}/{id}` with a bearer.
    ///
    /// The id is CHECKED, not escaped. `URL.appendingPathComponent` does not
    /// percent-encode `/` or `.`, so an id of `../me` composes
    /// `https://…/api/devices/../me` — a URL whose dot segments a server, proxy
    /// or `URLSession` may resolve, aiming a DELETE the user authorised for one
    /// row at an unrelated endpoint. Refusing is the only defence that does not
    /// depend on who normalises the path.
    ///
    /// `StoredLinkKeyValidation.checkedID` is deliberately the same contract the
    /// keychain account name uses: both compose a server-supplied id into
    /// something that must stay one inert token, and one rule is one thing to
    /// get right. Every id this app can present here — device and stored-file
    /// alike — is `authx.NewID()`, 32 hex characters, so nothing legitimate is
    /// near the edge of it.
    ///
    /// It throws BEFORE the request is built, so a rejected id costs no round
    /// trip and `URLSession` never sees it.
    ///
    /// 404 is not an error: the endpoints answer it for an object that is
    /// missing, expired, burned — or not the caller's, which a bearer that only
    /// ever listed its own cannot produce. The row the user asked to remove is
    /// gone either way, and reporting a failure would be a lie about it. It is
    /// still reported as `.alreadyGone` rather than `.deleted`, because it is
    /// also what a failed read on the server looks like.
    @discardableResult
    private func authedDelete(_ collection: String, id: String, token: String) async throws -> StoredFileDeletion {
        let id = try StoredLinkKeyValidation.checkedID(id)
        var req = URLRequest(url: baseURL.appendingPathComponent(collection).appendingPathComponent(id))
        req.httpMethod = "DELETE"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (_, resp) = try await send(req)
        switch resp.statusCode {
        case 200, 204: return .deleted
        case 404:      return .alreadyGone
        case 401: throw AccountError.invalidCredentials
        case 429: throw AccountError.rateLimited
        default:  throw AccountError.server(status: resp.statusCode)
        }
    }
}
