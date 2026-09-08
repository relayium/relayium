package com.relayium.android.ingress

import com.relayium.protocol.PairCode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What happens to something from outside while this device is busy.
 *
 * The behaviour being replaced joined on any `ACTION_VIEW`, so the case that
 * matters most is the one that used to destroy a running transfer: a link
 * arrives, and NOTHING is written until the transfer the user is watching has
 * finished.
 */
class IngressCoordinatorTest {

    private val navigated = ArrayList<IngressSurface>()
    private val applied = ArrayList<IngressRequest>()
    private var busy = false

    /** A coordinator whose busy answer is a field this test moves. */
    private fun coordinator(
        onNavigate: (IngressSurface) -> Unit = {},
        onApply: (IngressRequest) -> Unit = {},
        isBusy: (IngressRequest) -> Boolean = { busy },
    ) = IngressCoordinator(
        navigate = { navigated += it; onNavigate(it) },
        apply = { applied += it; onApply(it) },
        isBusy = isBusy,
    )

    private fun code(digits: String) =
        IngressOutcome.Accepted(IngressRequest.PrefillCode(PairCode(digits)))

    private fun malformed() = IngressOutcome.Refused(IngressRefusal.NO_CODE_IN_LINK)

    private fun digitsOf(request: IngressRequest) =
        (request as IngressRequest.PrefillCode).code.digits

    @Test
    fun `an idle device navigates once and writes once`() {
        val ingress = coordinator()
        assertNull(ingress.deliver(code("042913")))
        assertEquals(listOf(IngressSurface.JOIN), navigated)
        assertEquals(1, applied.size)
        assertEquals("042913", digitsOf(applied[0]))
        assertNull(ingress.pendingSurface)
    }

    @Test
    fun `a live transfer is shown the link and is not interrupted by it`() {
        busy = true
        val ingress = coordinator()
        ingress.deliver(code("042913"))
        // Navigated — the user tapped something and must see that it arrived.
        assertEquals(listOf(IngressSurface.JOIN), navigated)
        // And NOTHING was written. This is the whole regression: the previous
        // entry point called join() here and tore the session down.
        assertTrue(applied.isEmpty())
        assertEquals(IngressSurface.JOIN, ingress.pendingSurface)
    }

    @Test
    fun `only the newest waiting link is kept, and older ones never land`() {
        busy = true
        val ingress = coordinator()
        ingress.deliver(code("111111"))
        ingress.deliver(code("222222"))
        ingress.deliver(code("333333"))
        assertTrue(applied.isEmpty())

        busy = false
        ingress.applyIfIdle()
        assertEquals(1, applied.size)
        assertEquals("333333", digitsOf(applied[0]))
    }

    @Test
    fun `a deferred write lands exactly once and never navigates again`() {
        busy = true
        val ingress = coordinator()
        ingress.deliver(code("042913"))
        val navigationsWhileWaiting = navigated.size

        busy = false
        ingress.applyIfIdle()
        ingress.applyIfIdle()
        ingress.applyIfIdle()

        assertEquals(1, applied.size)
        // The user may have walked somewhere else during the transfer. A second
        // selection minutes later would yank the screen away.
        assertEquals(navigationsWhileWaiting, navigated.size)
        assertNull(ingress.pendingSurface)
    }

    @Test
    fun `an idle edge while still busy changes nothing`() {
        busy = true
        val ingress = coordinator()
        ingress.deliver(code("042913"))
        ingress.applyIfIdle()
        assertTrue(applied.isEmpty())
        assertEquals(IngressSurface.JOIN, ingress.pendingSurface)
    }

    @Test
    fun `a malformed link does not erase the good one that is waiting`() {
        busy = true
        val ingress = coordinator()
        ingress.deliver(code("042913"))
        // Junk arriving during the wait is the likeliest way to lose the good
        // link, and losing it would be silent.
        assertEquals(IngressRefusal.NO_CODE_IN_LINK, ingress.deliver(malformed()))
        assertEquals(IngressRefusal.FOREIGN_ORIGIN, ingress.deliver(IngressOutcome.Refused(IngressRefusal.FOREIGN_ORIGIN)))
        assertEquals(IngressSurface.JOIN, ingress.pendingSurface)

        busy = false
        ingress.applyIfIdle()
        assertEquals("042913", digitsOf(applied.single()))
    }

    @Test
    fun `a refusal does not navigate`() {
        coordinator().deliver(malformed())
        assertTrue(navigated.isEmpty())
        assertTrue(applied.isEmpty())
    }

    @Test
    fun `a code-less link is never held back, however busy the device is`() {
        busy = true
        val ingress = coordinator(isBusy = { error("a code-less link must not be asked about busy state") })
        ingress.deliver(IngressOutcome.Accepted(IngressRequest.ShowJoinSurface))
        assertSame(IngressRequest.ShowJoinSurface, applied.single())
        assertNull(ingress.pendingSurface)
    }

    @Test
    fun `a newer link that can be applied supersedes one that is waiting`() {
        busy = true
        val ingress = coordinator()
        ingress.deliver(code("111111"))
        busy = false
        ingress.deliver(code("222222"))
        assertEquals("222222", digitsOf(applied.single()))
        assertNull(ingress.pendingSurface)
        // And the superseded one never lands afterwards.
        ingress.applyIfIdle()
        assertEquals(1, applied.size)
    }

    // ── re-entrancy ─────────────────────────────────────────────────────────
    //
    // One thread is not one call at a time. Navigation drops screens, and a
    // screen coming down can deliver; an apply can sign an account out. Each of
    // these drives the callback into the coordinator DETERMINISTICALLY, which
    // is the only way this window is ever exercised.

    @Test
    fun `a link delivered from inside navigation is not overwritten by the outer one`() {
        var nested = false
        lateinit var ingress: IngressCoordinator
        ingress = coordinator(onNavigate = {
            if (!nested) {
                nested = true
                busy = true
                ingress.deliver(code("222222"))
            }
        })
        ingress.deliver(code("111111"))

        // The nested delivery is the newer statement of what the user wants, so
        // it is the one that is waiting. The outer call resumed holding a
        // request the app had already moved past and dropped it.
        assertEquals(IngressSurface.JOIN, ingress.pendingSurface)
        assertTrue(applied.isEmpty())
        busy = false
        ingress.applyIfIdle()
        assertEquals("222222", digitsOf(applied.single()))
    }

    @Test
    fun `an outer delivery cannot apply over a newer one applied beneath it`() {
        var nested = false
        lateinit var ingress: IngressCoordinator
        ingress = coordinator(onNavigate = {
            if (!nested) {
                nested = true
                ingress.deliver(code("222222"))
            }
        })
        ingress.deliver(code("111111"))
        assertEquals(1, applied.size)
        assertEquals("222222", digitsOf(applied[0]))
    }

    @Test
    fun `an account reset raised while delivering is not undone by that delivery`() {
        var reset = false
        lateinit var ingress: IngressCoordinator
        ingress = coordinator(isBusy = {
            // The wiring's own code: asking about busy state reached a model
            // that noticed the session was gone and dropped everything.
            if (!reset) {
                reset = true
                ingress.discardPending()
            }
            true
        })
        ingress.deliver(code("042913"))
        // Retaining here would put a request from the OLD session into the new
        // one, to be applied the moment the new one goes idle.
        assertNull(ingress.pendingSurface)
        assertTrue(applied.isEmpty())
    }

    @Test
    fun `a reset from inside an idle edge stops the write it was about to make`() {
        busy = true
        lateinit var ingress: IngressCoordinator
        var reset = false
        ingress = coordinator(isBusy = {
            if (busy) return@coordinator true
            if (!reset) {
                reset = true
                ingress.discardPending()
            }
            false
        })
        ingress.deliver(code("042913"))
        assertEquals(IngressSurface.JOIN, ingress.pendingSurface)

        busy = false
        ingress.applyIfIdle()
        assertTrue(applied.isEmpty())
        assertNull(ingress.pendingSurface)
    }

    @Test
    fun `a link delivered from inside an apply is not lost by the applying call`() {
        var nested = false
        lateinit var ingress: IngressCoordinator
        ingress = coordinator(onApply = {
            if (!nested) {
                nested = true
                busy = true
                ingress.deliver(code("222222"))
            }
        })
        ingress.deliver(code("111111"))
        assertEquals("111111", digitsOf(applied.single()))
        // The nested one arrived while busy and is waiting; the outer call must
        // not have cleared it on its way out.
        assertEquals(IngressSurface.JOIN, ingress.pendingSurface)
        busy = false
        ingress.applyIfIdle()
        assertEquals(listOf("111111", "222222"), applied.map(::digitsOf))
    }
}
