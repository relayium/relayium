package com.relayium.android.cloud

import com.relayium.android.account.AccountSession
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The files this account is storing, and what this device can still do with
 * them.
 *
 * ## Two sources of truth, and neither borrows the other's authority
 *
 * The SERVER says which objects exist and what they cost: id, size, dates, burn
 * flag, download count. This device says only whether it kept the KEY to one —
 * and a key is not evidence that an object exists, so a key with no matching row
 * produces no row at all. The reverse is ordinary: an object uploaded from
 * another device is listed with everything the server said and no link, because
 * its link cannot be rebuilt here. That is not a missing file, and the copy says
 * so.
 *
 * Every request pins the [AccountSession.Authority] it was issued under and
 * rechecks it before anything is shown or removed.
 */
class CloudHistoryModel(
    private val scope: CoroutineScope,
    /** The dispatcher [AccountSession] confines its state to. */
    private val owner: CoroutineDispatcher,
    /** Where blocking key-store reads happen; never [owner]. */
    private val io: CoroutineDispatcher,
    private val client: CloudClient,
    private val session: AccountSession,
    /** This app's OWN resolved backend, so a rebuilt link is composed against
     *  the origin this build talks to and never against a server's string. */
    private val origin: String,
    private val keys: StoredLinkKeyStore,
    private val now: () -> Long = { System.currentTimeMillis() / 1000L },
) {

    /**
     * One stored object as this device can describe it.
     *
     * [link] is present only when the key is here. [keyUnreadable] separates
     * "this installation never had the key" from "it has one it could not read":
     * the first is normal, the second is a device problem worth naming.
     */
    data class Entry(
        val id: String,
        val size: Long,
        val createdAt: Long,
        val expiresAt: Long,
        val burnAfterRead: Boolean,
        val downloaded: Boolean,
        val downloadCount: Long,
        val link: String?,
        val keyUnreadable: Boolean,
    ) {
        /** The link carries the key. It is shown and shared by explicit user
         *  action and does not belong in a log line or a test failure. */
        override fun toString(): String =
            "Entry(id=$id, size=$size, burn=$burnAfterRead, downloads=$downloadCount, " +
                "link=${if (link == null) "none" else "<redacted>"})"
    }

    sealed interface State {
        /** Nothing asked for yet, or the account left. */
        data object Idle : State
        data object Loading : State
        data class Ready(val entries: List<Entry>) : State
        data class Failed(val failure: CloudFailure) : State
    }

    /** Something true that is not the list itself. */
    enum class Notice {
        /** The server deleted the object this device asked it to. */
        DELETED,

        /** The server answered 404 — missing, owned by somebody else, or not a
         *  share, indistinguishable by design. NOT a deletion this device
         *  performed, and never reported as one. */
        ALREADY_GONE,

        /** Deleted on the server; the local key copy could not be removed. */
        LOCAL_KEY_KEPT,
    }

    private val _state = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = _state.asStateFlow()

    /** The object a delete is in flight for, so exactly one row shows it. */
    private val _deleting = MutableStateFlow<String?>(null)
    val deleting: StateFlow<String?> = _deleting.asStateFlow()

    private val _notice = MutableStateFlow<Notice?>(null)
    val notice: StateFlow<Notice?> = _notice.asStateFlow()

    @Volatile
    private var generation = 0

    /** Which delete owns [_deleting]. Owner-confined, like [generation]. */
    private var deleteEpoch = 0
    private var running: Job? = null

    /** Fetch the account's list and rebuild whatever links this device can. */
    fun refresh() {
        running = scope.launch(owner) {
            generation += 1
            val mine = generation
            _notice.value = null
            val authority = session.authority()
            if (authority == null) {
                _state.value = State.Idle
                return@launch
            }
            _state.value = State.Loading
            val rows = try {
                client.listFiles(authority.token)
            } catch (e: CancellationException) {
                throw e
            } catch (e: CloudException) {
                if (owns(mine, authority)) _state.value = State.Failed(e.failure)
                return@launch
            }
            if (!owns(mine, authority)) return@launch

            val account = authority.accountId
            val entries = withContext(io) {
                rows.map { row ->
                    var unreadable = false
                    val key = try {
                        keys.record(account, row.id)?.keyB64url
                    } catch (_: PendingUploadException) {
                        unreadable = true
                        null
                    }
                    Entry(
                        id = row.id,
                        size = row.size,
                        createdAt = row.createdAt,
                        expiresAt = row.expiresAt,
                        burnAfterRead = row.burnAfterRead,
                        downloaded = row.downloaded,
                        downloadCount = row.downloadCount,
                        link = key?.let { buildDownloadLink(origin, row.id, it) },
                        keyUnreadable = unreadable,
                    )
                }
            }
            if (!owns(mine, authority)) return@launch
            _state.value = State.Ready(entries)

            // Pruned only from a COMPLETE, successful listing for this account,
            // and only for keys whose recorded expiry has already passed. The
            // server's list does not filter expired or burned rows, so absence
            // alone is not evidence that an object is gone.
            val ids = rows.map { it.id }.toSet()
            withContext(NonCancellable + io) {
                runCatching { keys.prune(account, ids, now()) }
            }
        }
    }

    /**
     * Delete one object from the server, then drop the key this device kept.
     *
     * The confirmation belongs to the surface; by the time this runs the user
     * has said yes to this exact object. The two outcomes stay apart: a 200 is a
     * deletion this device caused, and a 404 is the server declining to
     * distinguish gone, not-yours and not-a-share.
     */
    fun delete(id: String) {
        scope.launch(owner) {
            if (_deleting.value != null) return@launch
            generation += 1
            val mine = generation
            // The busy marker is owned by an OPERATION, not by an object id.
            // Clearing it on the way out of whichever delete happens to finish
            // would release a marker a newer one is holding.
            deleteEpoch += 1
            val myDelete = deleteEpoch
            _notice.value = null
            val authority = session.authority()
            if (authority == null) {
                _state.value = State.Idle
                return@launch
            }
            _deleting.value = id
            val gone = try {
                client.deleteFile(id, authority.token)
                false
            } catch (e: CancellationException) {
                release(myDelete)
                throw e
            } catch (e: CloudException) {
                if (e.failure.kind != CloudFailure.Kind.NOT_FOUND) {
                    release(myDelete)
                    if (owns(mine, authority)) _state.value = State.Failed(e.failure)
                    return@launch
                }
                true
            }
            // The account may have changed during the round trip. The server
            // acted, so nothing is undone — but this device must not present the
            // result, and must not touch the new account's keys.
            if (!owns(mine, authority)) {
                release(myDelete)
                return@launch
            }
            val removed = withContext(NonCancellable + io) {
                runCatching { keys.remove(authority.accountId, id) }.getOrDefault(false)
            }
            // Rechecked AFTER the key removal, which is durable work off the
            // owner and is exactly where a sign-out lands. An outcome published
            // into a cleared account is a claim about files nobody is looking
            // at, attached to whoever signed in next.
            if (!owns(mine, authority)) {
                release(myDelete)
                return@launch
            }
            release(myDelete)
            _notice.value = when {
                gone -> Notice.ALREADY_GONE
                removed -> Notice.DELETED
                else -> Notice.LOCAL_KEY_KEPT
            }
            // Dropped locally rather than refetched, so the list never offers a
            // delete over an object this device has just been told is not there.
            val current = _state.value
            if (current is State.Ready) {
                _state.value = State.Ready(current.entries.filterNot { it.id == id })
            }
        }
    }

    /** Release the busy marker only if this operation still holds it. */
    private fun release(epoch: Int) {
        if (deleteEpoch == epoch) _deleting.value = null
    }

    fun dismissNotice() {
        scope.launch(owner) { _notice.value = null }
    }

    /**
     * The account changed. Drop the list on the owner, so no turn exists in
     * which one account's files are on screen under another's session. Only a
     * fresh fetch can say a list belongs to whoever is signed in now.
     */
    fun accountChanged() {
        scope.launch(owner) {
            if (_state.value is State.Idle && _deleting.value == null) return@launch
            generation += 1
            running?.cancel()
            running = null
            _deleting.value = null
            _notice.value = null
            _state.value = State.Idle
        }
    }

    private fun owns(mine: Int, authority: AccountSession.Authority): Boolean =
        mine == generation && session.isCurrent(authority)
}
