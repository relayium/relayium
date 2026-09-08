package com.relayium.android.inbox

import com.relayium.protocol.inbox.InboxAutoAccept
import com.relayium.protocol.inbox.InboxManifestKind
import com.relayium.protocol.inbox.InboxProtocol
import com.relayium.protocol.inbox.InboxTaskState
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * The Inbox feature, composed: an account's services, the receive loop, the send
 * commands, and the history the surface reads.
 *
 * [InboxModel] owns what is shown and who may show it; this owns what actually
 * happens. The split is what keeps the fence honest — every operation here runs
 * inside [InboxModel.launchOwned], captures its authority once, and re-checks it
 * with [InboxModel.ensureCurrent] after every await and before every external
 * side effect: a durable write, a report to central, an upload.
 *
 * ## What this deliberately does not do
 *
 * There is no background delivery. The receive loop runs while the host says the
 * surface is live ([start]) and stops when it says otherwise ([stop]), which
 * announces `offline` to central so senders are told the truth rather than left
 * waiting out a presence TTL. A policy of [InboxAutoAccept.OFF] runs no loop at
 * all: no heartbeat, no poll, no claim.
 */
class InboxRuntime(
    val model: InboxModel,
    private val factory: InboxServiceFactory,
    private val nowSeconds: () -> Long,
    private val platform: String = "android",
    private val appVersion: String,
    /** Injected so a test can drive the loop's cadence without waiting. */
    private val pause: suspend (Long) -> Unit = { delay(it) },
) {

    /**
     * One adopted account: its authority, its bearer, and the services built
     * from them.
     *
     * The services are opened once, behind [gate], because opening them resolves
     * the CURRENT device row from central — an answer that must be pinned rather
     * than re-derived by whichever operation happens to run first.
     */
    private class Session(
        val authority: InboxModel.Authority,
        val account: InboxAccountId,
        val bearer: String,
    ) {
        val gate = Mutex()

        @Volatile
        var services: InboxServices? = null

        @Volatile
        var policy: InboxAutoAccept = InboxAutoAccept.OFF

        /**
         * The user has chosen a policy in THIS session.
         *
         * The durable policy is read when the services open, which can finish
         * after a choice the user made in the meantime. Without this flag that
         * late read would overwrite the newer choice with the value that was on
         * disk before it.
         */
        @Volatile
        var policyChosen = false

        /** Enrolled, and the device key is usable. Reset on an account change,
         *  never assumed across one. */
        @Volatile
        var prepared = false

        /** The cadence central selected, read from this device's own enrolment
         *  row. Clamped; see [heartbeatSeconds]. */
        @Volatile
        var heartbeatSeconds: Int = InboxProtocol.DEFAULT_HEARTBEAT_SECONDS

        /** Whether central has been told this device is receiving, so a stop
         *  knows whether it has anything to retract. */
        @Volatile
        var announced = false

        @Volatile
        var pending: List<InboxTaskRow> = emptyList()
    }

    @Volatile
    private var session: Session? = null

    /** Whether the host says the surface is live. Receiving happens only here. */
    @Volatile
    private var live = false

    /**
     * Serialises every lifecycle and policy transition.
     *
     * Without it, `stop()` and `start()` are two asynchronous deltas racing:
     * a stop that nulls the worker and then joins it lets a start launch a
     * second loop while the first is still claiming, and the stop's `offline`
     * announcement can land after the start has said the device is listening.
     * Inside this gate a transition does not apply a delta at all — it
     * reconciles the loop with the CURRENT desired state, so whichever
     * transition runs last is the one that decides.
     */
    private val lifecycle = Mutex()

    /**
     * Serialises whole RUNTIME adoptions.
     *
     * [InboxModel.adopt] serialises the model's half, but this half has a
     * second step — installing the session that pairs an authority with its
     * bearer — and the two adoptions can cross between them: B could install
     * its session while A was still waiting for the lifecycle gate, and A would
     * then overwrite it with a session carrying a superseded authority and the
     * wrong bearer.
     */
    private val adopting = Mutex()

    @Volatile
    private var worker: Job? = null


    /** In-flight send attempts by job id, so one can be cancelled without
     *  touching the durable job or any other send. */
    private val attempts = ConcurrentHashMap<String, Job>()

    /** The last stop each job reported. LIVE state: it is never frozen into
     *  history, because a reason can stop being true. */
    private val stops = ConcurrentHashMap<String, InboxSendCoordinator.Result.Stopped>()

    // ── account lifetime ────────────────────────────────────────────────────

    /**
     * Adopt an account, or none.
     *
     * Everything owned by the previous account is cancelled and JOINED before
     * this returns — see [InboxModel.adopt]. Nothing of the old account's
     * services survives: the bundle is replaced whole rather than reassigned,
     * so no store from one account is reachable through a transport
     * authenticated as another. The other account's encrypted data is left
     * exactly where it is.
     */
    suspend fun adopt(account: InboxAccountId?, bearer: String?) {
        adopting.withLock {
            // Everything owned by the previous authority — including any queued
            // lifecycle transition — is cancelled and JOINED here, before a new
            // session exists. The authority returned is this call's own, so it
            // can never be paired with another adoption's account or bearer.
            val authority = model.adopt(account)
            lifecycle.withLock {
                // Checked against the model rather than assumed: an adoption
                // that was cancelled between the two steps must not install a
                // session for an authority that is no longer live.
                if (authority != null && !model.isCurrent(authority)) return@withLock
                worker = null
                stops.clear()
                attempts.clear()
                session = if (authority != null && account != null && !bearer.isNullOrEmpty()) {
                    Session(authority, account, bearer)
                } else {
                    null
                }
            }
        }
        if (session != null && live) start()
    }

    /**
     * The host's surface became live.
     *
     * Returns the transition, so a caller that needs to know the loop is
     * actually running can await it. A host may ignore it.
     */
    fun start(): Job? {
        live = true
        val session = session ?: return null
        // SEQUENCED, and that ordering is the fix for a cold start: the stored
        // policy is only authoritative once the services have opened, so a
        // reconcile that ran first would decide against the placeholder OFF and
        // leave a device whose owner left receiving on sitting idle until they
        // toggled something.
        return model.launchOwned(session.authority) {
            refresh()?.join()
            reconcile()?.join()
        }
    }

    /**
     * The host's surface is no longer live.
     *
     * The intent is recorded synchronously and the loop is brought into line
     * inside the transition gate, which is what stops a stop and a start from
     * crossing: by the time this transition runs, if the surface is live again
     * it reconciles to a RUNNING loop rather than announcing an `offline` the
     * newer start has already contradicted.
     */
    fun stop(): Job? {
        live = false
        if (session == null) return null
        return reconcile()
    }

    /**
     * Bring the receive loop into line with the desired state — the adopted
     * session, whether the surface is live, and the policy.
     *
     * Idempotent and serialized, so rapid stop/start/policy flips converge on
     * exactly one claim loop instead of layering deltas.
     */
    private fun reconcile(): Job? {
        val session = session ?: return null
        return model.launchOwned(session.authority) {
            lifecycle.withLock {
                val active = this@InboxRuntime.session
                // A session that changed while this transition was queued is not
                // this transition's to reconcile.
                if (active !== session) return@withLock
                model.ensureCurrent(session.authority)
                val wanted = live && session.policy != InboxAutoAccept.OFF
                val running = worker?.isActive == true
                if (wanted && !running) {
                    worker = model.launchOwned(session.authority) { loop(session) }
                    return@withLock
                }
                if (!wanted && running) {
                    val ending = worker
                    worker = null
                    ending?.cancelAndJoin()
                    model.ensureCurrent(session.authority)
                }
                if (!wanted) {
                    model.publish(session.authority) { it.copy(receiving = resting(session)) }
                    announceStopped(session)
                }
            }
        }
    }

    // ── reading what is there ───────────────────────────────────────────────

    /**
     * Re-read everything the surface shows.
     *
     * The device list is central's; the current row is the one it marks, checked
     * against the id this session pinned. A disagreement is refused rather than
     * resolved — it means the bearer and the id were paired wrongly, and every
     * path below would then act under an identity that is not this device's.
     */
    fun refresh(): Job? {
        val session = session ?: return null
        return model.launchOwned(session.authority) {
            model.publish(session.authority) { it.copy(loading = true, failure = null) }
            val services = services(session)
            model.ensureCurrent(session.authority)

            val rows = services.sender.devices()
            model.ensureCurrent(session.authority)
            val current = rows.singleOrNull { it.isCurrent }
                ?.takeIf { it.id == services.deviceId }
                ?: throw InboxWireException(InboxWireReason.IDENTITY_MISMATCH, "Current")
            current.inbox?.heartbeatIntervalSeconds?.let { session.heartbeatSeconds = clamp(it) }

            val (targets, blocked) = model.partition(rows)
            val textCapable = rows.filter { InboxTargetEligibility.canReceiveText(it) }
                .map { it.id }.toSet()
            val directory = services.container.probe(session.account)
            model.ensureCurrent(session.authority)
            model.publish(session.authority) {
                it.copy(
                    devices = targets,
                    blockedDevices = blocked,
                    textCapableDevices = textCapable,
                    deviceName = current.name,
                    directory = directory,
                    policy = session.policy,
                    receiving = if (worker == null) resting(session) else it.receiving,
                    loading = false,
                    ready = true,
                )
            }
            reconcileHistory(session, services)
        }
    }

    /**
     * Rebuild the ledger from its durable sources, then publish it.
     *
     * The sources are the receipts and the jobs, not a cache: a journal proves a
     * delivery landed, a message record IS one, and a send job is the user's own
     * outgoing intent. Anything the user deleted stays deleted — the store's
     * tombstones refuse it — and nothing here re-dates or re-reads an entry that
     * already exists.
     */
    private suspend fun reconcileHistory(session: Session, services: InboxServices) {
        val now = nowSeconds()
        for (journal in services.journals.all()) {
            if (!journal.isCompleted) continue
            model.ensureCurrent(session.authority)
            services.conversations.record(received(journal), now)
        }
        for (message in services.messages.all()) {
            model.ensureCurrent(session.authority)
            services.conversations.record(
                InboxConversationEntry(
                    id = message.taskId,
                    peerDeviceId = message.senderDeviceId,
                    direction = InboxConversationEntry.Direction.RECEIVED,
                    kind = InboxConversationEntry.Kind.MESSAGE,
                    names = emptyList(),
                    byteCount = message.text.toByteArray(Charsets.UTF_8).size.toLong(),
                    at = message.receivedAt,
                ),
                now,
            )
        }
        val jobs = services.sendStore.all()
        for (job in jobs) {
            model.ensureCurrent(session.authority)
            services.conversations.record(sent(job), now)
        }
        model.ensureCurrent(session.authority)
        val conversations = services.conversations.conversations()
        model.ensureCurrent(session.authority)
        model.publish(session.authority) {
            it.copy(conversations = conversations, sends = jobs.map(::status))
        }
        refreshSentStates(session, services, jobs)
    }

    /**
     * Ask central what became of the deliveries this device created.
     *
     * `saved` is taken from central saying `saved`, and from nothing else. Every
     * other terminal state — expired, revoked, failed — is recorded as STOPPED:
     * a generic terminal answer is not evidence a file landed, and claiming it
     * was saved would be the one lie this history cannot afford.
     */
    private suspend fun refreshSentStates(
        session: Session,
        services: InboxServices,
        jobs: List<InboxSendJob>,
    ) {
        var changed = false
        for (job in jobs) {
            val taskId = job.taskId ?: continue
            model.ensureCurrent(session.authority)
            val task = try {
                services.sender.task(job.targetDeviceId, taskId)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                // Not knowing is not a state change. The row keeps what it had.
                continue
            }
            model.ensureCurrent(session.authority)
            val state = when {
                task.state == InboxTaskState.SAVED -> InboxConversationEntry.SentState.SAVED
                task.isTerminal -> InboxConversationEntry.SentState.STOPPED
                else -> InboxConversationEntry.SentState.CREATED
            }
            services.conversations.updateSent(job.jobId, state, nowSeconds())
            changed = true
        }
        if (!changed) return
        model.ensureCurrent(session.authority)
        val conversations = services.conversations.conversations()
        model.ensureCurrent(session.authority)
        model.publish(session.authority) { it.copy(conversations = conversations) }
    }

    // ── receiving ───────────────────────────────────────────────────────────

    /**
     * Choose a receive policy, durably.
     *
     * The disk is written BEFORE anything acts on it: a policy that reached
     * central but not this device would come back as OFF on the next launch and
     * silently stop receiving for someone who had switched it on. Switching OFF
     * additionally tells central, because central keeps the last policy a device
     * announced — a device that went quiet without saying so would go on being
     * offered as a target, and every send to it would queue and then expire.
     */
    fun setPolicy(policy: InboxAutoAccept): Job? {
        val session = session ?: return null
        return model.launchOwned(session.authority) {
            val services = services(session)
            model.ensureCurrent(session.authority)
            services.policies.write(policy)
            model.ensureCurrent(session.authority)
            lifecycle.withLock {
                if (this@InboxRuntime.session !== session) return@withLock
                session.policyChosen = true
                session.policy = policy
                if (policy == InboxAutoAccept.OFF) {
                    // The key verdict belongs to an enrolment this device is
                    // withdrawing; keeping it on screen would assert something
                    // about a device that is no longer receiving.
                    model.publish(session.authority) {
                        it.copy(
                            policy = policy,
                            failure = null,
                            keyHealth = null,
                            awaitingAnswer = emptyList(),
                        )
                    }
                    session.prepared = false
                } else {
                    model.publish(session.authority) { it.copy(policy = policy, failure = null) }
                }
            }
            reconcile()?.join()
        }
    }

    /** Answer a task central is holding for a person on this device. The only
     *  way one is resolved: nothing in the loop answers for the user. */
    fun respond(taskId: String, accept: Boolean): Job? {
        val session = session ?: return null
        return model.launchOwned(session.authority) {
            val services = services(session)
            model.ensureCurrent(session.authority)
            model.publish(session.authority) { it.copy(answering = it.answering + taskId) }
            try {
                services.device.accept(taskId, accept)
            } catch (e: CancellationException) {
                model.publish(session.authority) { it.copy(answering = it.answering - taskId) }
                throw e
            } catch (e: Throwable) {
                // The question is NOT removed. Central still holds the task, and
                // dropping the row would leave a delivery waiting for an answer
                // the user believes they gave.
                model.publish(session.authority) {
                    it.copy(answering = it.answering - taskId, failure = model.classify(e))
                }
                return@launchOwned
            }
            model.ensureCurrent(session.authority)
            model.publish(session.authority) {
                it.copy(
                    answering = it.answering - taskId,
                    awaitingAnswer = it.awaitingAnswer.filterNot { row -> row.id == taskId },
                )
            }
        }
    }

    /**
     * The explicit key repair, after the user has been told what it costs.
     *
     * Two different repairs, chosen by the reason rather than by a flag: an
     * unreadable local history is quarantined and replaced, while a remote key
     * this device does not hold is rotated away from under a compare-and-swap.
     * Neither happens on an ordinary path — a device that silently rotated would
     * discard whatever was already sealed to the old key.
     */
    fun repairKey(): Job? {
        val session = session ?: return null
        val health = model.state.value.keyHealth as? InboxKeyHealth.NeedsRepair ?: return null
        if (health.reason == InboxKeyHealth.NeedsRepair.Reason.REMOTE_KEY_AMBIGUOUS) return null
        return model.launchOwned(session.authority) {
            val services = services(session)
            model.ensureCurrent(session.authority)
            model.publish(session.authority) { it.copy(repairing = true, failure = null) }
            try {
                val repaired =
                    if (health.reason == InboxKeyHealth.NeedsRepair.Reason.LOCAL_HISTORY_UNREADABLE) {
                        InboxEnrolment.repairUnreadableHistory(
                            services.device, services.keys, session.account, nowSeconds(),
                        )
                    } else {
                        InboxEnrolment.repairByRotating(
                            services.device, services.keys, session.account,
                            health.remoteKeyId, nowSeconds(),
                        )
                    }
                model.ensureCurrent(session.authority)
                model.publish(session.authority) {
                    it.copy(
                        keyHealth = repaired,
                        repairing = false,
                        failure = if (repaired is InboxKeyHealth.RepairUnavailable) {
                            InboxModel.State.Failure.KEY_REPAIR_UNAVAILABLE
                        } else {
                            it.failure
                        },
                    )
                }
                if (repaired is InboxKeyHealth.Healthy) {
                    // Through the SAME gate as every other transition. Starting
                    // a loop here directly could put one in flight while a stop
                    // that had already nulled the handle was still joining the
                    // previous one — two loops, each holding a claim.
                    //
                    // `prepared` stays false so the restarted loop enrols and
                    // re-verifies the key rather than trusting this verdict.
                    reconcile()?.join()
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                model.publish(session.authority) { it.copy(repairing = false) }
                throw e
            }
        }
    }

    /**
     * The receive loop: prepare once, then one bounded pass at a time.
     *
     * At most ONE claim is outstanding, because that is what the engine's pass
     * guarantees and this never runs two of them. A pass that failed is retried
     * on the cadence central chose, and a failure that a retry cannot fix — a
     * bearer that is gone, a build central refuses — ends the loop instead of
     * hammering.
     */
    private suspend fun loop(session: Session) {
        val services = services(session)
        val engine = services.engine(
            { session.policy },
            { pending -> session.pending = pending },
            { journal -> onDelivered(session, services, journal) },
        )
        while (true) {
            currentCoroutineContext().ensureActive()
            model.ensureCurrent(session.authority)
            if (session.policy == InboxAutoAccept.OFF) {
                model.publish(session.authority) { it.copy(receiving = InboxReceiving.OFF) }
                return
            }

            if (!session.prepared) {
                val health = engine.prepare()
                model.ensureCurrent(session.authority)
                session.announced = true
                model.publish(session.authority) { it.copy(keyHealth = health) }
                if (health !is InboxKeyHealth.Healthy) {
                    // Claiming with a key this device cannot open would take
                    // deliveries off the queue only to fail them terminally —
                    // the sender's file would be destroyed by our own repair
                    // problem. The loop stops until a person resolves it.
                    model.publish(session.authority) { it.copy(receiving = resting(session)) }
                    return
                }
                session.prepared = true
            }

            val result = try {
                engine.pass()
            } catch (e: InboxSupersededException) {
                throw e
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                model.ensureCurrent(session.authority)
                val failure = model.classify(e)
                model.publish(session.authority) {
                    it.copy(failure = failure, receiving = resting(session))
                }
                if (failure == InboxModel.State.Failure.SIGNED_OUT ||
                    failure == InboxModel.State.Failure.UNSUPPORTED_BUILD
                ) {
                    return
                }
                pause(session.heartbeatSeconds * 1000L)
                continue
            }

            model.ensureCurrent(session.authority)
            publishPass(session, result)
            if (result is InboxReceiveEngine.PassResult.Worked) continue
            pause(session.heartbeatSeconds * 1000L)
        }
    }

    private suspend fun publishPass(session: Session, result: InboxReceiveEngine.PassResult) {
        val awaiting = session.pending.filter {
            it.state == InboxTaskState.ATTENTION_REQUIRED && it.errorCode.isNone
        }
        model.publish(session.authority) { state ->
            state.copy(
                awaitingAnswer = awaiting,
                failure = null,
                directory = when (result) {
                    is InboxReceiveEngine.PassResult.NotReceiving -> result.state
                    else -> state.directory
                },
                receiving = when (result) {
                    is InboxReceiveEngine.PassResult.Worked -> InboxReceiving.RECEIVING
                    is InboxReceiveEngine.PassResult.Idle -> InboxReceiving.LISTENING
                    is InboxReceiveEngine.PassResult.NotReceiving ->
                        if (session.policy == InboxAutoAccept.OFF) {
                            InboxReceiving.OFF
                        } else {
                            InboxReceiving.UNAVAILABLE
                        }
                },
            )
        }
    }

    /** A delivery published durably. The ONLY event a history row is built from. */
    private suspend fun onDelivered(
        session: Session,
        services: InboxServices,
        journal: InboxJournal,
    ) {
        if (!journal.isCompleted) return
        model.ensureCurrent(session.authority)
        services.conversations.record(received(journal), nowSeconds())
        model.ensureCurrent(session.authority)
        val conversations = services.conversations.conversations()
        model.publish(session.authority) { it.copy(conversations = conversations) }
    }

    private suspend fun announceStopped(session: Session) {
        if (!session.announced) return
        val services = session.services ?: return
        session.announced = false
        session.prepared = false
        try {
            services.engine({ session.policy }, {}, {}).announceStopped()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            // Best effort. Central's presence TTL is the fallback, and saying
            // nothing is better than failing a lifecycle transition.
        }
    }

    // ── sending ─────────────────────────────────────────────────────────────

    /**
     * Stage files as a durable job, then deliver it.
     *
     * Preparation and delivery are separate steps against one durable record:
     * everything that makes the send reproducible — the content key, the sealed
     * manifest, the framed ciphertext and its identity, the idempotency key — is
     * written before the first request leaves. What that buys is [send] being
     * safe to repeat: a retry names the job, never a new intention.
     */
    fun sendFiles(target: InboxSendTarget, refs: List<InboxSourceRef>): Job? =
        stageThenSend(target) { services ->
            services.sources.withSources(refs) { sources ->
                services.preparer.stageFiles(target.deviceId, sources)
            }
        }

    /**
     * Stage and deliver a real text message: the manifest says `text`, and the
     * recipient commits a message rather than a file named like one.
     *
     * The sender's own copy is written durably HERE, at staging, before
     * anything is sent — so this device's history shows what was actually
     * written rather than "a message, 41 bytes". A body that cannot be stored
     * is reported and the job is left staged: the user can send it, and the
     * history is never quietly wrong about what it holds.
     */
    fun sendText(target: InboxSendTarget, text: String): Job? =
        stageThenSend(target) { services ->
            val job = services.preparer.stageText(target.deviceId, text)
            services.outgoing.commit(job.jobId, target.deviceId, text, nowSeconds())
            job
        }

    private fun stageThenSend(
        target: InboxSendTarget,
        stage: suspend (InboxServices) -> InboxSendJob,
    ): Job? {
        val session = session ?: return null
        return model.launchOwned(session.authority) {
            val services = services(session)
            model.ensureCurrent(session.authority)
            val job = stage(services)
            model.ensureCurrent(session.authority)
            // The user's outgoing intent is durable history from the moment it
            // is staged, so an attempt that stops does not erase the fact that
            // they asked.
            services.conversations.record(sent(job), nowSeconds())
            model.ensureCurrent(session.authority)
            publishSends(session, services)
            deliver(session, services, job.jobId)
        }
    }

    /** Attempt a durable job. Safe to repeat: every step is either already
     *  recorded or reproduces the identical request. */
    fun send(jobId: String): Job? {
        val session = session ?: return null
        return model.launchOwned(session.authority) {
            val services = services(session)
            model.ensureCurrent(session.authority)
            deliver(session, services, jobId)
        }
    }

    /**
     * Stop an attempt that is running now.
     *
     * The DURABLE job is untouched, and that is the whole difference: the spool
     * may be the last copy this app holds of what the user asked to send, and a
     * cancelled attempt is a paused delivery rather than a discarded one.
     * Whatever central may already hold is unchanged; this cancels a local
     * attempt, not a delivery.
     */
    fun cancelSend(jobId: String) {
        attempts.remove(jobId)?.cancel()
    }

    private suspend fun deliver(session: Session, services: InboxServices, jobId: String) {
        val attempt = currentCoroutineContext()[Job]
        // ONE attempt per job, admitted atomically. The coordinator serialises
        // the wire, but a second attempt queued behind the first would also
        // overwrite the handle `cancelSend` uses — so a stop would cancel the
        // waiting retry while the original went on uploading. The durable job
        // is unchanged either way; this simply refuses to run two.
        if (attempt != null && attempts.putIfAbsent(jobId, attempt) != null) return
        try {
            model.publish(session.authority) {
                it.copy(sends = it.sends.map { s -> if (s.jobId == jobId) s.copy(phase = InboxSendStatus.Phase.SENDING) else s })
            }
            val result = services.coordinator.deliver(jobId)
            model.ensureCurrent(session.authority)
            when (result) {
                is InboxSendCoordinator.Result.Delivered -> {
                    stops.remove(jobId)
                    services.conversations.updateSent(
                        jobId,
                        if (result.task.state == InboxTaskState.SAVED) {
                            InboxConversationEntry.SentState.SAVED
                        } else {
                            InboxConversationEntry.SentState.CREATED
                        },
                        nowSeconds(),
                    )
                }

                is InboxSendCoordinator.Result.Stopped -> {
                    stops[jobId] = result
                    model.ensureCurrent(session.authority)
                    // Self-guarded: it reloads the durable record and refuses to
                    // release an ambiguous or non-terminal job whatever this
                    // result says.
                    services.coordinator.release(jobId, result)
                    model.ensureCurrent(session.authority)
                    services.conversations.updateSent(
                        jobId, InboxConversationEntry.SentState.STOPPED, nowSeconds(),
                    )
                }
            }
            model.ensureCurrent(session.authority)
            publishSends(session, services)
            val conversations = services.conversations.conversations()
            model.ensureCurrent(session.authority)
            model.publish(session.authority) { it.copy(conversations = conversations) }
        } finally {
            attempt?.let { attempts.remove(jobId, it) }
        }
    }

    private suspend fun publishSends(session: Session, services: InboxServices) {
        val jobs = services.sendStore.all()
        model.ensureCurrent(session.authority)
        model.publish(session.authority) { it.copy(sends = jobs.map(::status)) }
    }

    // ── history ─────────────────────────────────────────────────────────────

    /** Mark exactly the entries the user was shown as read. Never "everything
     *  from this peer": an entry that arrived while the screen was open was
     *  never on it. */
    fun markRead(ids: Set<String>): Job? {
        val session = session ?: return null
        if (ids.isEmpty()) return null
        return model.launchOwned(session.authority) {
            val services = services(session)
            model.ensureCurrent(session.authority)
            services.conversations.markRead(ids, nowSeconds())
            model.ensureCurrent(session.authority)
            val conversations = services.conversations.conversations()
            model.publish(session.authority) { it.copy(conversations = conversations) }
        }
    }

    /**
     * Delete entries from this device's history.
     *
     * LOCAL, and durable as a tombstone. It cancels no task, declines no
     * delivery and clears no inbox: hiding one of those behind a tidy-up gesture
     * would mean a user cleaning their list silently revoked a transfer. The
     * files that were already saved stay on disk, and the receipts that prevent
     * a duplicate delivery stay exactly where they are.
     */
    fun deleteHistory(ids: Set<String>): Job? {
        val session = session ?: return null
        if (ids.isEmpty()) return null
        return model.launchOwned(session.authority) {
            val services = services(session)
            model.ensureCurrent(session.authority)
            // The BODIES go first, and the order is load-bearing. A tombstone
            // written before them would, on a crash, leave message plaintext on
            // disk that the user believes they deleted and that nothing will
            // ever display or remove again. The other way round costs at worst a
            // row whose body is gone, which the surface states plainly and a
            // second delete finishes.
            for (entry in services.conversations.entries()) {
                if (entry.id !in ids) continue
                if (entry.kind != InboxConversationEntry.Kind.MESSAGE) continue
                model.ensureCurrent(session.authority)
                when (entry.direction) {
                    InboxConversationEntry.Direction.SENT -> services.outgoing.delete(entry.id)
                    InboxConversationEntry.Direction.RECEIVED -> services.messages.delete(entry.id)
                }
            }
            model.ensureCurrent(session.authority)
            services.conversations.delete(ids, nowSeconds())
            model.ensureCurrent(session.authority)
            val conversations = services.conversations.conversations()
            model.ensureCurrent(session.authority)
            model.publish(session.authority) {
                it.copy(
                    conversations = conversations,
                    sends = it.sends.filterNot { s -> s.jobId in ids },
                )
            }
        }
    }

    /**
     * A message entry's own text, in either direction.
     *
     * Read on demand and never held in the published state, which a surface can
     * save. A received body comes from the delivery this device committed; a
     * sent body from the record written when the user staged it. Null means the
     * body is genuinely not here — deleted, or never stored — and the surface
     * says so rather than showing an empty message.
     */
    suspend fun message(entry: InboxConversationEntry): String? {
        val session = session ?: return null
        val services = session.services ?: return null
        model.ensureCurrent(session.authority)
        val body = try {
            when (entry.direction) {
                InboxConversationEntry.Direction.SENT -> services.outgoing.read(entry.id)?.text
                InboxConversationEntry.Direction.RECEIVED -> services.messages.read(entry.id)?.text
            }
        } catch (e: InboxMessageException) {
            null
        } catch (e: InboxOutgoingTextException) {
            null
        }
        // Fenced AFTER the read as well. This one is called from a composition
        // rather than from an owned job, so nothing else stops an account
        // switch landing while the store was being read — and returning the
        // body then would put one account's message on another's screen.
        model.ensureCurrent(session.authority)
        return body
    }

    /**
     * Resolve an entry to the files it published, under the authority that owns
     * them.
     *
     * This is what makes a host's open/export/share real rather than a menu that
     * does nothing: the host receives an account-scoped, entry-scoped answer it
     * can hand to a FileProvider or a document tree, and gets null for an entry
     * whose account is no longer adopted.
     */
    suspend fun locate(entryId: String): InboxEntryFiles? {
        val session = session ?: return null
        val services = session.services ?: return null
        val entry = services.conversations.entries().firstOrNull { it.id == entryId } ?: return null
        model.ensureCurrent(session.authority)
        val directory = entry.directory?.let(::File) ?: return null
        if (!directory.isDirectory) return null
        return InboxEntryFiles(
            account = session.account,
            entryId = entryId,
            directory = directory,
            files = entry.names.map { File(directory, it) }.filter { it.isFile },
        )
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    private suspend fun services(session: Session): InboxServices {
        session.services?.let { return it }
        val opened = session.gate.withLock {
            session.services?.let { return@withLock it }
            val built = factory.open(session.account, session.bearer)
            model.ensureCurrent(session.authority)
            val stored = built.policies.read()
            model.ensureCurrent(session.authority)
            // A choice made while this was loading is NEWER than the disk, and
            // wins. Otherwise the stored policy is the authoritative one: a
            // device whose owner left receiving on must not come back OFF.
            if (!session.policyChosen) {
                session.policy = stored
                model.publish(session.authority) { it.copy(policy = stored) }
            }
            session.services = built
            built
        }
        // The loop is reconciled AFTER the authoritative policy is known.
        // Adoption reconciles against the session's initial OFF, which is a
        // placeholder rather than an answer — without this a cold start with a
        // stored `auto` would sit STOPPED until the user toggled something.
        reconcile()
        return opened
    }

    /** What the surface shows when no loop is running. */
    private fun resting(session: Session): InboxReceiving =
        if (session.policy == InboxAutoAccept.OFF) InboxReceiving.OFF else InboxReceiving.STOPPED

    /** Central chooses the cadence; this build refuses an interval it cannot
     *  honour, in either direction. Presence lives 90 seconds. */
    private fun clamp(seconds: Int): Int = seconds.coerceIn(5, 300)

    private fun received(journal: InboxJournal) = InboxConversationEntry(
        id = journal.taskId,
        peerDeviceId = journal.senderDeviceId,
        direction = InboxConversationEntry.Direction.RECEIVED,
        kind = if (journal.kind == InboxManifestKind.TEXT) {
            InboxConversationEntry.Kind.MESSAGE
        } else {
            InboxConversationEntry.Kind.FILES
        },
        names = if (journal.kind == InboxManifestKind.TEXT) emptyList() else journal.plan.map { it.name },
        byteCount = if (journal.kind == InboxManifestKind.TEXT) {
            journal.messageBytes
        } else {
            journal.plan.sumOf { it.size }
        },
        at = if (journal.completedAt > 0) journal.completedAt else journal.plannedAt,
        directory = journal.taskDirectory.takeIf { it.isNotEmpty() },
    )

    private fun sent(job: InboxSendJob) = InboxConversationEntry(
        id = job.jobId,
        peerDeviceId = job.targetDeviceId,
        direction = InboxConversationEntry.Direction.SENT,
        kind = if (job.kind == InboxManifestKind.TEXT) {
            InboxConversationEntry.Kind.MESSAGE
        } else {
            InboxConversationEntry.Kind.FILES
        },
        names = job.files.map { it.first },
        byteCount = job.totalBytes,
        at = job.createdAt,
        sentState = when {
            job.taskId != null -> InboxConversationEntry.SentState.CREATED
            else -> InboxConversationEntry.SentState.STAGED
        },
    )

    private fun status(job: InboxSendJob): InboxSendStatus {
        val stopped = stops[job.jobId]
        return InboxSendStatus(
            jobId = job.jobId,
            targetDeviceId = job.targetDeviceId,
            kind = job.kind,
            names = job.files.map { it.first },
            totalBytes = job.totalBytes,
            phase = when {
                job.taskId != null -> InboxSendStatus.Phase.DELIVERED
                attempts.containsKey(job.jobId) -> InboxSendStatus.Phase.SENDING
                stopped != null -> InboxSendStatus.Phase.STOPPED
                else -> InboxSendStatus.Phase.STAGED
            },
            stop = stopped?.reason,
            // A job that still records an outstanding create is ambiguous
            // whatever the last attempt said, because an EARLIER request may
            // have created the delivery.
            ambiguous = job.unresolvedCreate || stopped?.ambiguous == true,
            taskId = job.taskId,
        )
    }
}

/**
 * Where an entry's files actually are, for a host to open, export or share.
 *
 * Carries the account, so a host cannot act on one account's delivery while
 * another is adopted, and only files that EXIST — a user who moved or deleted
 * one out from under the app should get a shorter list, not a broken intent.
 */
class InboxEntryFiles(
    val account: InboxAccountId,
    val entryId: String,
    val directory: File,
    val files: List<File>,
) {
    /** No paths: they are the user's own names. */
    override fun toString(): String = "InboxEntryFiles(entry=$entryId, files=${files.size})"
}
