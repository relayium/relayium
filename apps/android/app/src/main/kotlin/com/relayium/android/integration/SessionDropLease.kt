package com.relayium.android.integration

import java.io.Closeable
import com.relayium.android.TransferController

/** A transient read grant belongs to one drop on one link, including metadata IO. */
internal class SessionDropLease(private val changed: (Boolean) -> Unit = {}) : Closeable {
    data class Context(
        val link: Int,
        val usable: Boolean,
        val acceptsNew: Boolean,
        val completed: Int,
        val outgoing: Boolean,
    )

    class Ticket internal constructor(
        internal val initial: Context,
        internal val permission: Closeable,
    ) {
        internal var admitted = false
        internal var observedOutgoing = false
    }

    companion object {
        fun context(s: TransferController.State) = Context(
            link = s.linkId,
            usable = s.phase == TransferController.Phase.CONNECTED && s.nearby.active &&
                s.canSendFiles && !s.fileLaneDown,
            acceptsNew = !s.linkInterrupted && s.outgoing.isEmpty() && s.heldFiles == 0 &&
                s.verification != TransferController.Verification.PENDING,
            completed = s.sentBatchCount,
            outgoing = s.outgoing.isNotEmpty(),
        )
    }

    private var active: Ticket? = null

    @Synchronized
    fun begin(startLink: Int, current: Context, permission: Closeable): Ticket? {
        if (active != null || startLink != current.link || !current.usable || !current.acceptsNew) {
            runCatching { permission.close() }
            return null
        }
        return Ticket(current, permission).also { active = it; changed(true) }
    }

    @Synchronized
    fun maySubmit(ticket: Ticket, current: Context): Boolean =
        active === ticket && !ticket.admitted && current.usable && current.acceptsNew &&
            current.link == ticket.initial.link && current.completed == ticket.initial.completed

    @Synchronized
    fun admission(ticket: Ticket, accepted: Boolean): Boolean {
        if (active !== ticket) return false
        if (!accepted) { abandon(ticket); return false }
        ticket.admitted = true
        return true
    }

    @Synchronized
    fun observe(current: Context) {
        val ticket = active ?: return
        if (current.outgoing) ticket.observedOutgoing = true
        if (!current.usable || current.link != ticket.initial.link ||
            current.completed > ticket.initial.completed ||
            (ticket.admitted && ticket.observedOutgoing && !current.outgoing)
        ) abandon(ticket)
    }

    @Synchronized
    fun abandon(ticket: Ticket) {
        if (active !== ticket) return
        active = null
        try { runCatching { ticket.permission.close() } } finally { changed(false) }
    }

    @Synchronized
    override fun close() { active?.let(::abandon) }
}
