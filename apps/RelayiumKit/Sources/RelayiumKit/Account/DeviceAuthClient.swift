import Foundation

public struct DeviceAuthStart: Equatable {
    public let userCode: String
    public let deviceCode: String
    public let verificationURL: URL
    public let interval: Int
    public let expiresIn: Int

    public init(userCode: String, deviceCode: String, verificationURL: URL,
                interval: Int, expiresIn: Int) {
        self.userCode = userCode
        self.deviceCode = deviceCode
        self.verificationURL = verificationURL
        self.interval = interval
        self.expiresIn = expiresIn
    }

    /// The page with the code already filled in, so approving is one click
    /// instead of transcribing. `/device` reads `?code=` and auto-loads the
    /// request's details (`server/account/devicepage.go:151`).
    public var approvalURL: URL {
        guard var c = URLComponents(url: verificationURL, resolvingAgainstBaseURL: false) else {
            return verificationURL
        }
        c.queryItems = [URLQueryItem(name: "code", value: userCode)]
        return c.url ?? verificationURL
    }
}

public enum DevicePollOutcome: Equatable {
    case pending
    case denied
    case expired
    case ok(token: String, accountEmail: String)
}

/// Terminal poll outcomes that are failures from the caller's point of view.
public enum DeviceAuthOutcomeError: Error, Equatable { case denied, expired }

/// Every poll outcome is HTTP 200 with a `status` field, so the status code is
/// not the signal — a client that waited for a non-200 would poll until the
/// code expired and then report a timeout for a login that had succeeded.
func parseDevicePoll(_ data: Data) throws -> DevicePollOutcome {
    struct Body: Decodable {
        let status: String
        let access_token: String?
        let account_email: String?
    }
    guard let b = try? JSONDecoder().decode(Body.self, from: data) else { throw AccountError.decoding }
    switch b.status {
    case "authorization_pending": return .pending
    case "denied": return .denied
    case "expired": return .expired
    case "ok":
        // An empty token would land the session in .ready with a bearer that
        // 401s on the very next request. Refuse it here.
        guard let t = b.access_token, !t.isEmpty else { throw AccountError.decoding }
        return .ok(token: t, accountEmail: b.account_email ?? "")
    default:
        // Never guess. A future status read as success signs someone in wrongly.
        throw AccountError.decoding
    }
}

func parseDeviceStart(_ data: Data) throws -> DeviceAuthStart {
    struct Body: Decodable {
        let user_code: String
        let device_code: String
        let verification_uri: String
        let interval: Int
        let expires_in: Int
    }
    guard let b = try? JSONDecoder().decode(Body.self, from: data),
          let url = URL(string: b.verification_uri) else { throw AccountError.decoding }
    return DeviceAuthStart(userCode: b.user_code, deviceCode: b.device_code,
                           verificationURL: url, interval: b.interval, expiresIn: b.expires_in)
}

/// The two calls of the device-authorization flow, behind a protocol so the poll
/// loop that drives them is testable without a server.
public protocol DeviceAuthClient {
    func start() async throws -> DeviceAuthStart
    func poll(deviceCode: String) async throws -> DevicePollOutcome
}

public struct HTTPDeviceAuthClient: DeviceAuthClient {
    let baseURL: URL
    let session: URLSession

    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    public func start() async throws -> DeviceAuthStart {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/cli/device/start"))
        req.httpMethod = "POST"
        let (data, http) = try await send(req)
        guard http.statusCode == 200 else { throw statusError(http.statusCode) }
        return try parseDeviceStart(data)
    }

    public func poll(deviceCode: String) async throws -> DevicePollOutcome {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/cli/device/poll"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // `device_code`, matching handleDevicePoll (deviceauth.go:129-132), which
        // rejects an empty one with 400.
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["device_code": deviceCode])
        let (data, http) = try await send(req)
        guard http.statusCode == 200 else { throw statusError(http.statusCode) }
        return try parseDevicePoll(data)
    }

    private func statusError(_ code: Int) -> AccountError {
        code == 429 ? .rateLimited : .server(status: code)
    }

    private func send(_ req: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, resp) = try await session.data(for: req)
            guard let http = resp as? HTTPURLResponse else { throw AccountError.network }
            return (data, http)
        } catch let e as AccountError {
            throw e
        } catch {
            throw AccountError.network
        }
    }
}
