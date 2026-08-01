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
