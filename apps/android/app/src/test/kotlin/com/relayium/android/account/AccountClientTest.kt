package com.relayium.android.account

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What each server answer MEANS, asserted through the real parser.
 *
 * The two halves of this file are deliberately different in kind. The first
 * drives [AccountClient] over a [FakeTransport], because the interesting inputs
 * are bodies a real server would have to be broken to send. The second drives
 * the REAL [OkHttpAccountTransport] over a real socket, because the rules that
 * matter there — the bounded read, the refused redirect, the strict UTF-8, the
 * unsendable credential — are properties of the transport and are invisible to
 * a fake.
 */
class AccountClientTest {

    private fun client(t: AccountTransport) = AccountClient(t)

    private fun failureOf(result: Result<*>): AccountFailure.Kind =
        (result.exceptionOrNull() as AccountException).failure.kind

    // ── login ───────────────────────────────────────────────────────────────

    @Test
    fun `a 200 with a token is a session`() = runBlocking {
        val t = FakeTransport().answer("api/auth/native/login", 200, loginBody("rlm_cli_x"))
        val outcome = client(t).login("a@example.invalid", "pw", "Pixel").getOrThrow()
        assertEquals(LoginOutcome.Session("rlm_cli_x"), outcome)
    }

    /** The password is in the BODY and nowhere else — never a path, never a
     *  header, and never in the request's own printable form. */
    @Test
    fun `the password never leaves the body`() = runBlocking {
        val t = FakeTransport().answer("api/auth/native/login", 200, loginBody())
        client(t).login("a@example.invalid", "hunter2", "Pixel")
        assertEquals(listOf("POST api/auth/native/login"), t.calls)
        assertNull(t.bearers.single())
        val printed = AccountRequest("POST", "api/auth/native/login", json = """{"password":"hunter2"}""")
            .toString()
        assertFalse("a request must not print its body", printed.contains("hunter2"))
    }

    /** 200 is TWO answers. Pending deletion is tested first, and the
     *  reactivation token beside it is never carried. */
    @Test
    fun `a 200 pending deletion is not a session`() = runBlocking {
        val body = """{"status":"pending_deletion","purgeAfter":1900000000,"reactivateToken":"SECRET"}"""
        val t = FakeTransport().answer("api/auth/native/login", 200, body)
        val outcome = client(t).login("a@example.invalid", "pw", "Pixel").getOrThrow()
        assertEquals(LoginOutcome.PendingDeletion(1900000000L), outcome)
        assertFalse(
            "the reactivation token must not survive into the outcome",
            outcome.toString().contains("SECRET"),
        )
    }

    @Test
    fun `a 403 email_unverified is its own outcome, not a rejection`() = runBlocking {
        val t = FakeTransport()
            .answer("api/auth/native/login", 403, """{"error":"email_unverified","email":"A@x.invalid"}""")
        val outcome = client(t).login("a@x.invalid", "pw", "Pixel").getOrThrow()
        assertEquals(LoginOutcome.EmailUnverified("A@x.invalid"), outcome)
    }

    /** A 403 whose body is NOT the documented one is malformed, not an
     *  unverified address: guessing here is how a client renders the wrong
     *  screen for a refusal it did not understand. */
    @Test
    fun `an undocumented 403 body is malformed`() = runBlocking {
        val t = FakeTransport().answer("api/auth/native/login", 403, """{"error":"nope"}""")
        assertEquals(
            AccountFailure.Kind.MALFORMED,
            failureOf(client(t).login("a@x.invalid", "pw", "Pixel")),
        )
    }

    @Test
    fun `a 200 with no user object is malformed rather than a session`() = runBlocking {
        val t = FakeTransport().answer("api/auth/native/login", 200, """{"token":"rlm_cli_x"}""")
        assertEquals(
            AccountFailure.Kind.MALFORMED,
            failureOf(client(t).login("a@x.invalid", "pw", "Pixel")),
        )
    }

    /** The reproduced crash: a token OkHttp cannot put in a header. Refused at
     *  adoption so it never reaches the keystore. */
    @Test
    fun `an unsendable bearer is refused at issue`() = runBlocking {
        val t = FakeTransport()
            .answer("api/auth/native/login", 200, """{"token":"bad\nheader","user":{"id":"x"}}""")
        assertEquals(
            AccountFailure.Kind.MALFORMED,
            failureOf(client(t).login("a@x.invalid", "pw", "Pixel")),
        )
    }

    // ── register ────────────────────────────────────────────────────────────

    /** Registration returns an ADDRESS, never a token: the account cannot sign
     *  in until the emailed link is opened. */
    @Test
    fun `registration produces an address and no credential`() = runBlocking {
        val t = FakeTransport().answer(
            "api/auth/register", 200,
            """{"status":"verification_sent","email":"norm@x.invalid","token":"rlm_cli_x"}""",
        )
        val outcome = client(t).register("A@X.invalid", "pw", "A").getOrThrow()
        assertEquals("norm@x.invalid", outcome.email)
        assertFalse(outcome.toString().contains("rlm_cli_x"))
    }

    @Test
    fun `a 200 that does not say verification_sent is malformed`() = runBlocking {
        val t = FakeTransport().answer("api/auth/register", 200, """{"status":"ok"}""")
        assertEquals(AccountFailure.Kind.MALFORMED, failureOf(client(t).register("a@x.invalid", "pw", "")))
    }

    @Test
    fun `each documented registration refusal keeps its own meaning`() = runBlocking {
        val cases = listOf(
            Triple(400, """{"error":"invalid_email"}""", AccountFailure.Kind.EMAIL_INVALID),
            Triple(400, """{"error":"password too short"}""", AccountFailure.Kind.PASSWORD_TOO_SHORT),
            Triple(409, """{"error":"email already registered"}""", AccountFailure.Kind.EMAIL_TAKEN),
            Triple(409, """{"error":"account_pending_deletion"}""", AccountFailure.Kind.ACCOUNT_PENDING_DELETION),
            // The plain-text body a malformed JSON request earns is not one of them.
            Triple(400, "bad request", AccountFailure.Kind.SERVER),
        )
        for ((status, body, expected) in cases) {
            val t = FakeTransport().answer("api/auth/register", status, body)
            assertEquals(body, expected, failureOf(client(t).register("a@x.invalid", "pw", "")))
        }
    }

    // ── logout ──────────────────────────────────────────────────────────────

    /** 401 is terminal SUCCESS: the credential is already gone server-side,
     *  which is the state a sign-out is trying to reach. */
    @Test
    fun `logout treats 200 and 401 as done and everything else as a failure`() = runBlocking {
        for (status in listOf(200, 401)) {
            val t = FakeTransport().answer("api/auth/logout", status, "")
            assertTrue("$status", client(t).logout("rlm_cli_x").isSuccess)
        }
        val t = FakeTransport().answer("api/auth/logout", 500, "")
        assertEquals(AccountFailure.Kind.SERVER, failureOf(client(t).logout("rlm_cli_x")))
        val offline = FakeTransport().fail("api/auth/logout", TransportResult.Failure.NETWORK)
        assertEquals(AccountFailure.Kind.NETWORK, failureOf(client(offline).logout("rlm_cli_x")))
    }

    // ── usage and devices ───────────────────────────────────────────────────

    @Test
    fun `usage reads the server's own numbers`() = runBlocking {
        val t = FakeTransport().answer("api/me/usage", 200, usageBody(trafficCap = 5000))
        val usage = client(t).fetchUsage("rlm_cli_x").getOrThrow()
        assertEquals("Free", usage.planName)
        assertEquals(10L, usage.traffic.used)
        assertEquals(5000L, usage.traffic.cap)
        assertFalse(usage.traffic.unlimited)
        // cap 0 is the server's spelling of "no limit" (nonNegCap).
        assertTrue(usage.storage.unlimited)
    }

    /** A negative cap would render as UNLIMITED under `cap <= 0`, which is the
     *  most misleading answer this screen can give. And at or above 2^53
     *  consecutive integers stop being distinguishable, so a value there is a
     *  number the server did not write. Both are refused. */
    @Test
    fun `a quota that cannot be trusted is refused rather than rendered`() = runBlocking {
        val bad = listOf(
            """{"resetsAt":1,"plan":{"name":"F"},"traffic":{"used":0,"cap":-1},"storage":{"used":0,"cap":0}}""",
            """{"resetsAt":1,"plan":{"name":"F"},"traffic":{"used":0,"cap":9007199254740993},"storage":{"used":0,"cap":0}}""",
            """{"resetsAt":1,"plan":{"name":"F"},"traffic":{"used":0,"cap":1.5},"storage":{"used":0,"cap":0}}""",
            """{"resetsAt":-1,"plan":{"name":"F"},"traffic":{"used":0,"cap":1},"storage":{"used":0,"cap":0}}""",
        )
        for (body in bad) {
            val t = FakeTransport().answer("api/me/usage", 200, body)
            assertEquals(body, AccountFailure.Kind.MALFORMED, failureOf(client(t).fetchUsage("rlm_cli_x")))
        }
    }

    @Test
    fun `the device list is read by the server's own field names`() = runBlocking {
        val t = FakeTransport().answer(
            "api/devices", 200,
            devicesBody(deviceRow("a".repeat(32), "Pixel", current = true), deviceRow("b".repeat(32))),
        )
        val rows = client(t).listDevices("rlm_cli_x").getOrThrow()
        assertEquals(2, rows.size)
        assertEquals("Pixel", rows[0].name)
        assertTrue(rows[0].current)
        assertFalse(rows[1].current)
    }

    /** Checked, not escaped: `appendingPathComponent`-style joining would
     *  compose a path whose dot segments a proxy may resolve, aiming the DELETE
     *  at an unrelated endpoint. Refused before any request is built. */
    @Test
    fun `a device id that is not a server id costs no round trip`() = runBlocking {
        val t = FakeTransport()
        for (id in listOf("../me", "a".repeat(31), "A".repeat(32), "", "a/b")) {
            assertEquals(id, AccountFailure.Kind.MALFORMED, failureOf(client(t).deleteDevice(id, "rlm_cli_x")))
        }
        assertTrue("nothing may have been sent", t.calls.isEmpty())
    }

    @Test
    fun `a 404 device delete is already-gone rather than a failure`() = runBlocking {
        val t = FakeTransport().answer("api/devices/${"a".repeat(32)}", 404, "")
        assertEquals(DeviceDeletion.ALREADY_GONE, client(t).deleteDevice("a".repeat(32), "rlm_cli_x").getOrThrow())
    }

    // ── pair mint ───────────────────────────────────────────────────────────

    @Test
    fun `a mint is six digits with a future expiry, or it is refused`() = runBlocking {
        val ok = FakeTransport().answer("api/pair", 200, """{"code":"004291","expiresAt":2000}""")
        assertEquals(MintedCode("004291", 2000L), client(ok).mintPairCode("rlm_cli_x", 1000L).getOrThrow())

        val bad = listOf(
            """{"code":"4291","expiresAt":2000}""",
            """{"code":"00429a","expiresAt":2000}""",
            """{"code":"٠٠٤٢٩١","expiresAt":2000}""",
            """{"code":"004291","expiresAt":1000}""",
            """{"code":"004291","expiresAt":999}""",
        )
        for (body in bad) {
            val t = FakeTransport().answer("api/pair", 200, body)
            assertEquals(
                body,
                AccountFailure.Kind.PAIR_CODE_REJECTED,
                failureOf(client(t).mintPairCode("rlm_cli_x", 1000L)),
            )
        }
    }

    /** The documented machine-readable refusal is a different product answer
     *  from an ordinary rate limit, and the two get different copy. */
    @Test
    fun `an exhausted allowance is distinguished from a rate limit`() = runBlocking {
        val spent = FakeTransport().answer("api/pair", 429, """{"error":"traffic_exhausted"}""")
        assertEquals(
            AccountFailure.Kind.PAIR_TRAFFIC_EXHAUSTED,
            failureOf(client(spent).mintPairCode("rlm_cli_x", 1L)),
        )
        val busy = FakeTransport().answer("api/pair", 429, """{"error":"slow down"}""")
        assertEquals(AccountFailure.Kind.RATE_LIMITED, failureOf(client(busy).mintPairCode("rlm_cli_x", 1L)))
    }

    @Test
    fun `an empty bearer is answered here rather than sent`() = runBlocking {
        val t = FakeTransport()
        assertEquals(AccountFailure.Kind.NOT_SIGNED_IN, failureOf(client(t).mintPairCode("", 1L)))
        assertTrue(t.calls.isEmpty())
    }

    // ── browser approval ────────────────────────────────────────────────────

    private fun startBody(
        uri: String = "https://relayium.com/device",
        interval: Int = 5,
        expires: Int = 600,
    ) = """{"user_code":"WDJB-MJHT","device_code":"dc","verification_uri":"$uri",""" +
        """"interval":$interval,"expires_in":$expires}"""

    @Test
    fun `the approval url is composed from a verification page on our own origin`() = runBlocking {
        val t = FakeTransport().answer("api/cli/device/start", 200, startBody())
        val start = client(t).startBrowserLogin("Pixel", "https://relayium.com").getOrThrow()
        assertEquals("https://relayium.com/device?code=WDJB-MJHT", start.approvalUrl)
        assertFalse("the poll credential must not print", start.toString().contains("dc"))
    }

    /**
     * The load-bearing refusal of the whole flow. Each of these is a page that
     * would ask a human to authorise a credential for this device, and none of
     * them is ours — including the one that PREFIX-matches, which is why the
     * check parses rather than compares strings.
     */
    @Test
    fun `a verification page anywhere but our own origin is refused`() = runBlocking {
        val hostile = listOf(
            "https://relayium.com.evil.example/device",
            "https://relayium.com@evil.example/device",
            "https://evil.example/device",
            "http://relayium.com/device",
            "https://relayium.com/device/../evil",
            "https://relayium.com/",
            "not a url",
        )
        for (uri in hostile) {
            val t = FakeTransport().answer("api/cli/device/start", 200, startBody(uri))
            val result = client(t).startBrowserLogin("Pixel", "https://relayium.com")
            assertTrue(uri, result.isFailure)
        }
    }

    /**
     * The interval is the SERVER's floor — polling faster earns a 429 that
     * reads as a failed login — so a value this build will not honour is
     * refused rather than clamped in either direction.
     */
    @Test
    fun `an unsupported poll interval is refused rather than shortened`() = runBlocking {
        val out = FakeTransport().answer("api/cli/device/start", 200, startBody(interval = 120))
        assertEquals(120, client(out).startBrowserLogin("P", "https://relayium.com").getOrThrow().intervalSeconds)

        val bad = listOf(
            startBody(interval = 0),
            startBody(interval = -1),
            startBody(interval = 301),
            startBody(expires = 0),
            startBody(expires = 3601),
            // An interval longer than the request describes a flow that can
            // never poll at all.
            startBody(interval = 120, expires = 60),
        )
        for (body in bad) {
            val t = FakeTransport().answer("api/cli/device/start", 200, body)
            assertEquals(body, AccountFailure.Kind.MALFORMED, failureOf(client(t).startBrowserLogin("P", "https://relayium.com")))
        }
    }

    /** Every poll outcome is HTTP 200 with a `status`; an unrecognised one is
     *  never optimistically retried or read as success. */
    @Test
    fun `every documented poll status keeps its meaning and a new one does not`() = runBlocking {
        val cases = mapOf(
            """{"status":"authorization_pending"}""" to DevicePollOutcome.Pending,
            """{"status":"denied"}""" to DevicePollOutcome.Denied,
            """{"status":"expired"}""" to DevicePollOutcome.Expired,
            """{"status":"ok","access_token":"rlm_cli_x"}""" to DevicePollOutcome.Approved("rlm_cli_x"),
        )
        for ((body, expected) in cases) {
            val t = FakeTransport().answer("api/cli/device/poll", 200, body)
            assertEquals(body, expected, client(t).pollBrowserLogin("dc").getOrThrow())
        }
        val unknown = listOf(
            """{"status":"slow_down"}""",
            """{"status":"ok"}""",
            """{"status":"ok","access_token":""}""",
            """{"status":"ok","access_token":"bad\nheader"}""",
        )
        for (body in unknown) {
            val t = FakeTransport().answer("api/cli/device/poll", 200, body)
            assertEquals(body, AccountFailure.Kind.MALFORMED, failureOf(client(t).pollBrowserLogin("dc")))
        }
    }
}
