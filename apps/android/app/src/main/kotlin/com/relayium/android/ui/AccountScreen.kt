package com.relayium.android.ui

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.relayium.android.R
import com.relayium.android.TransferViewModel
import com.relayium.android.account.AccountDevice
import com.relayium.android.account.AccountFailure
import com.relayium.android.account.AccountState
import com.relayium.android.account.BrowserLoginModel
import com.relayium.android.account.DevicesState
import com.relayium.android.account.RequestState

/**
 * The account surface: who is signed in, what the server says they may use, and
 * which credentials exist on this account.
 *
 * ## What it deliberately does not contain
 *
 * No checkout, no subscription management, no plan change. Every number here is
 * one the server computed and this screen renders; the app makes no billing
 * request of any kind and offers no control that would start one. The plan card
 * is a statement of fact, not a call to action.
 *
 * ## Passwords
 *
 * The password field's text is ordinary composable state and is deliberately NOT
 * `rememberSaveable`: saved instance state is written outside this process, into
 * a bundle the system persists. A rotation therefore clears the field, which is
 * the correct trade — the alternative is a credential on disk for the
 * convenience of not retyping it.
 */
@Composable
internal fun AccountScreen(viewModel: TransferViewModel) {
    val state by viewModel.account.state.collectAsStateWithLifecycle()
    val note by viewModel.account.signOutNote.collectAsStateWithLifecycle()

    // The one place a restore is started. It is idempotent and refuses to
    // restart anything that already holds something — see AccountSession.restore.
    LaunchedEffect(Unit) { viewModel.account.restore() }

    Text(
        text = stringResource(R.string.account_title),
        style = MaterialTheme.typography.headlineSmall,
    )

    if (note) {
        StatusCard(text = stringResource(R.string.account_signout_note), isError = true)
        TextButton(
            onClick = viewModel.account::dismissSignOutNote,
            modifier = Modifier.height(48.dp),
        ) {
            Text(stringResource(R.string.cleanup_dismiss))
        }
    }

    when (val s = state) {
        is AccountState.Restoring -> Busy(R.string.account_restoring)
        is AccountState.SigningIn -> Busy(R.string.account_signing_in)
        is AccountState.Registering -> Busy(R.string.account_registering)
        is AccountState.SigningOut -> Busy(R.string.account_signing_out)

        is AccountState.SignedOut -> AccessForm(viewModel, rejection = null)
        is AccountState.Rejected -> AccessForm(viewModel, rejection = s.failure)

        is AccountState.CheckEmail -> CheckEmailCard(s.email, viewModel)
        is AccountState.PendingDeletion -> PendingDeletionCard(s.purgeAfter, viewModel)
        is AccountState.Ready -> ReadyCards(s, viewModel)

        is AccountState.Unavailable -> Card {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    text = stringResource(R.string.account_unavailable),
                    style = MaterialTheme.typography.bodyMedium,
                )
                StatusCard(text = accountErrorMessage(s.failure), isError = true)
                Button(
                    onClick = viewModel.account::refresh,
                    modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp),
                ) {
                    Text(stringResource(R.string.account_retry))
                }
                TextButton(
                    onClick = viewModel::signOutAccount,
                    modifier = Modifier.height(48.dp),
                ) {
                    Text(stringResource(R.string.account_sign_out))
                }
            }
        }

        // The credential MAY STILL BE LIVE on the server. Every account action
        // is withheld here on purpose: the account is in an unresolved state,
        // and offering anything but the retry would be acting on a session the
        // user has already asked to end.
        is AccountState.SignOutFailed -> Card {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                StatusCard(text = stringResource(R.string.account_signout_failed), isError = true)
                Text(
                    text = accountErrorMessage(s.failure),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Button(
                    onClick = viewModel.account::retrySignOut,
                    modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp),
                ) {
                    Text(stringResource(R.string.account_signout_retry))
                }
            }
        }

        is AccountState.CredentialUnreadable -> Card {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                StatusCard(text = stringResource(R.string.account_unreadable), isError = true)
                Button(
                    onClick = viewModel.account::discardUnreadableCredential,
                    modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp),
                ) {
                    Text(stringResource(R.string.account_unreadable_discard))
                }
            }
        }
    }
}

@Composable
private fun Busy(label: Int) {
    Row(
        modifier = Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite },
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        CircularProgressIndicator(Modifier.height(20.dp).width(20.dp), strokeWidth = 2.dp)
        Text(text = stringResource(label), style = MaterialTheme.typography.bodyMedium)
    }
}

// ── signed out ──────────────────────────────────────────────────────────────

/**
 * One form with two modes, plus the browser route.
 *
 * The mode is the FORM's state, not the session's: a rejected registration must
 * not silently drop the user back onto the sign-in half, and the fields that
 * produced the rejection are still the ones on screen.
 */
@Composable
private fun AccessForm(viewModel: TransferViewModel, rejection: AccountFailure?) {
    // The address and the mode are owned by the ViewModel, NOT by this
    // composable: this form is REMOVED from the composition while a sign-in is
    // in flight and a new one is put back for the rejection, so anything it
    // remembered — saveable or not — would be gone by the time the user reads
    // the error. See AccountAccessDraft.
    val draft by viewModel.accessDraft.value.collectAsStateWithLifecycle()
    val creating = draft.creating
    val email = draft.email
    // The password is the one thing that stays local, and it is cleared the
    // moment the request owns it. See the file comment.
    var password by remember { mutableStateOf("") }

    val browser by viewModel.browserLogin.state.collectAsStateWithLifecycle()
    val recovery by viewModel.account.recovery.collectAsStateWithLifecycle()

    // A browser approval is already trying to become this account. Offering the
    // password form beside it would let a user start a second route to the same
    // place and leave the first one running with nowhere to land — the sequence
    // that used to end with an abandoned approval signing them back in. The
    // session refuses that adoption on its own (see
    // AccountSession.adoptBearerOnOwner), and the form says so rather than
    // relying on the refusal being invisible.
    val browserBusy = browser is BrowserLoginModel.State.Starting ||
        browser is BrowserLoginModel.State.Waiting

    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                text = stringResource(
                    if (creating) R.string.account_create_title else R.string.account_signin_title,
                ),
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                text = stringResource(
                    if (creating) R.string.account_create_intro else R.string.account_signin_intro,
                ),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            rejection?.let {
                StatusCard(text = accountErrorMessage(it), isError = true)
            }

            OutlinedTextField(
                value = email,
                onValueChange = viewModel.accessDraft::setEmail,
                modifier = Modifier.fillMaxWidth(),
                label = { Text(stringResource(R.string.account_email_label)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Email,
                    imeAction = ImeAction.Next,
                ),
            )
            if (creating) {
                OutlinedTextField(
                    value = draft.displayName,
                    onValueChange = viewModel.accessDraft::setDisplayName,
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text(stringResource(R.string.account_name_label)) },
                    supportingText = { Text(stringResource(R.string.account_name_optional)) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                )
            }
            OutlinedTextField(
                value = password,
                onValueChange = { password = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text(stringResource(R.string.account_password_label)) },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Password,
                    imeAction = ImeAction.Done,
                ),
            )

            Button(
                onClick = {
                    if (creating) {
                        viewModel.account.register(email.trim(), password, draft.displayName.trim())
                    } else {
                        viewModel.account.signIn(email.trim(), password)
                    }
                    // The credential leaves this composable's memory as soon as
                    // the request owns it. It is not saved state and not a
                    // draft; there is nothing to come back to.
                    password = ""
                },
                enabled = !browserBusy && email.isNotBlank() && password.isNotEmpty(),
                modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 52.dp),
            ) {
                Text(
                    stringResource(
                        if (creating) R.string.account_create_action else R.string.account_signin_action,
                    ),
                )
            }

            TextButton(
                onClick = {
                    viewModel.accessDraft.setCreating(!creating)
                    password = ""
                    viewModel.account.backToSignIn()
                },
                enabled = !browserBusy,
                modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp),
            ) {
                Text(
                    stringResource(
                        if (creating) R.string.account_switch_to_signin
                        else R.string.account_switch_to_create,
                    ),
                )
            }

            if (browserBusy) {
                Text(
                    text = stringResource(R.string.account_browser_busy),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            if (!creating) {
                HorizontalDivider()
                // Recovery is a request from here and a completion in the
                // mailbox: the link opens the website's reset page, which owns
                // that flow. Nothing needs a browser to get UN-stuck, so there
                // is no dead end on a device without one.
                when (val r = recovery) {
                    is RequestState.Sending -> Busy(R.string.account_forgot_sending)
                    is RequestState.Requested ->
                        StatusCard(text = stringResource(R.string.account_forgot_sent), isError = false)
                    is RequestState.Failed ->
                        StatusCard(text = accountErrorMessage(r.failure), isError = true)
                    is RequestState.Idle -> Unit
                }
                TextButton(
                    onClick = { viewModel.account.requestPasswordReset(email.trim()) },
                    enabled = !browserBusy && email.isNotBlank() &&
                        recovery !is RequestState.Sending,
                    modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp),
                ) {
                    Text(stringResource(R.string.account_forgot_action))
                }
            }
        }
    }

    BrowserLoginCard(browser, viewModel)
}

/**
 * Approving this device in a browser.
 *
 * The reason this route exists is not convenience: accounts created with Sign in
 * with Apple or Google have no password at all, and this build ships no Google
 * SDK and no Play Services by design, so without it those accounts cannot sign
 * in on Android. The approval happens where the user is already signed in.
 *
 * The address is rendered as selectable text next to the button ALWAYS, not only
 * after a failed launch: it is the page that authorises a credential, so a user
 * is entitled to read where they are being sent before tapping, and a device
 * with no browser at all still has something it can act on.
 */
@Composable
private fun BrowserLoginCard(state: BrowserLoginModel.State, viewModel: TransferViewModel) {
    val context = LocalContext.current
    var noBrowser by rememberSaveable { mutableStateOf(false) }

    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                text = stringResource(R.string.account_browser_title),
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                text = stringResource(R.string.account_browser_intro),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            when (state) {
                is BrowserLoginModel.State.Idle,
                is BrowserLoginModel.State.Failed,
                -> {
                    if (state is BrowserLoginModel.State.Failed) {
                        StatusCard(text = accountErrorMessage(state.failure), isError = true)
                    }
                    Button(
                        onClick = {
                            noBrowser = false
                            viewModel.beginBrowserLogin()
                        },
                        modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 52.dp),
                    ) {
                        Text(stringResource(R.string.account_browser_action))
                    }
                }

                is BrowserLoginModel.State.Starting -> Busy(R.string.account_browser_starting)

                is BrowserLoginModel.State.Waiting -> {
                    Text(
                        text = stringResource(R.string.account_browser_code_hint),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    SelectionContainer {
                        Text(
                            text = state.userCode,
                            style = MaterialTheme.typography.headlineSmall,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    Button(
                        onClick = {
                            val opened = runCatching {
                                context.startActivity(
                                    Intent(Intent.ACTION_VIEW, state.approvalUrl.toUri()),
                                )
                            }.isSuccess
                            noBrowser = !opened
                        },
                        modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 52.dp),
                    ) {
                        Text(stringResource(R.string.account_browser_open))
                    }
                    if (noBrowser) {
                        Text(
                            text = stringResource(R.string.update_no_browser),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                    SelectionContainer {
                        Text(
                            text = state.approvalUrl,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        CircularProgressIndicator(
                            Modifier.height(20.dp).width(20.dp),
                            strokeWidth = 2.dp,
                        )
                        Text(
                            text = stringResource(R.string.account_browser_waiting),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                    OutlinedButton(
                        onClick = viewModel.browserLogin::cancel,
                        modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp),
                    ) {
                        Text(stringResource(R.string.files_cancel))
                    }
                }
            }
        }
    }
}

// ── verification / frozen ───────────────────────────────────────────────────

@Composable
private fun CheckEmailCard(email: String, viewModel: TransferViewModel) {
    val resend by viewModel.account.resend.collectAsStateWithLifecycle()

    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                text = stringResource(R.string.account_verify_title),
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                text = stringResource(R.string.account_verify_body, email),
                style = MaterialTheme.typography.bodyMedium,
            )
            when (val r = resend) {
                is RequestState.Sending -> Busy(R.string.account_verify_resending)
                // "Accepted", never "sent": the endpoint answers 200 whether it
                // mailed anything or swallowed the request under its throttle.
                is RequestState.Requested ->
                    StatusCard(text = stringResource(R.string.account_verify_resent), isError = false)
                is RequestState.Failed ->
                    StatusCard(text = accountErrorMessage(r.failure), isError = true)
                is RequestState.Idle -> Unit
            }
            Button(
                onClick = viewModel.account::resendVerification,
                enabled = resend !is RequestState.Sending,
                modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp),
            ) {
                Text(stringResource(R.string.account_verify_resend))
            }
            TextButton(
                onClick = viewModel::returnToSignInForm,
                modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp),
            ) {
                Text(stringResource(R.string.account_back_to_signin))
            }
        }
    }
}

/**
 * The account is inside its deletion grace period.
 *
 * The way out is the reactivation link that was emailed when the deletion was
 * requested. This app holds no token that could do it and shows none: the
 * server sends one beside this answer, and carrying it would put the single
 * value that can undo a deletion into a state object and onto a screen.
 */
@Composable
private fun PendingDeletionCard(purgeAfter: Long, viewModel: TransferViewModel) {
    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                text = stringResource(R.string.account_frozen_title),
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                text = stringResource(R.string.account_frozen_body, formatDate(purgeAfter)),
                style = MaterialTheme.typography.bodyMedium,
            )
            TextButton(
                onClick = viewModel::returnToSignInForm,
                modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp),
            ) {
                Text(stringResource(R.string.account_back_to_signin))
            }
        }
    }
}

// ── signed in ───────────────────────────────────────────────────────────────

@Composable
private fun ReadyCards(ready: AccountState.Ready, viewModel: TransferViewModel) {
    val stale by viewModel.account.stale.collectAsStateWithLifecycle()

    // The typed address has served its purpose. Forgetting it here is what keeps
    // the next signed-out screen from opening on the previous session's account.
    LaunchedEffect(ready.user.id) { viewModel.accessDraft.clear() }

    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                text = ready.user.email,
                style = MaterialTheme.typography.titleMedium,
            )
            if (ready.user.displayName.isNotBlank()) {
                Text(
                    text = ready.user.displayName,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (ready.user.linkedMethods.isNotEmpty()) {
                Text(
                    text = stringResource(
                        R.string.account_methods,
                        ready.user.linkedMethods.joinToString(", "),
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            // A session that is real now and will NOT survive a restart. Said
            // here rather than discovered on the next launch.
            if (!ready.persisted) {
                StatusCard(text = stringResource(R.string.account_not_persisted), isError = true)
            }
            if (stale) {
                StatusCard(text = stringResource(R.string.account_stale), isError = false)
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(
                    onClick = viewModel.account::refresh,
                    modifier = Modifier.weight(1f).defaultMinSize(minHeight = 48.dp),
                ) {
                    Text(stringResource(R.string.account_refresh))
                }
                OutlinedButton(
                    onClick = viewModel::signOutAccount,
                    modifier = Modifier.weight(1f).defaultMinSize(minHeight = 48.dp),
                ) {
                    Text(stringResource(R.string.account_sign_out))
                }
            }
        }
    }

    PlanCard(ready)
    DevicesCard(viewModel)
}

/** Every number here is the server's. Nothing is recomputed and nothing is
 *  offered for sale: this app makes no billing request of any kind. */
@Composable
private fun PlanCard(ready: AccountState.Ready) {
    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                text = stringResource(R.string.account_plan_title),
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                text = ready.usage.planName.ifBlank { ready.user.planId },
                style = MaterialTheme.typography.bodyLarge,
            )
            QuotaRow(
                label = stringResource(R.string.account_quota_traffic),
                used = ready.usage.traffic.used,
                cap = ready.usage.traffic.cap,
                unlimited = ready.usage.traffic.unlimited,
            )
            QuotaRow(
                label = stringResource(R.string.account_quota_storage),
                used = ready.usage.storage.used,
                cap = ready.usage.storage.cap,
                unlimited = ready.usage.storage.unlimited,
            )
            Text(
                text = stringResource(R.string.account_quota_resets, formatDate(ready.usage.resetsAt)),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun QuotaRow(label: String, used: Long, cap: Long, unlimited: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            text = if (unlimited) {
                // `cap <= 0` is the server's documented spelling of "no limit".
                // A progress bar against no limit would be a bar that can never
                // move, which reads as a broken one.
                stringResource(R.string.account_quota_unlimited, label, formatBytes(used))
            } else {
                stringResource(R.string.account_quota_used, label, formatBytes(used), formatBytes(cap))
            },
            style = MaterialTheme.typography.bodyMedium,
        )
        if (!unlimited) {
            LinearProgressIndicator(
                progress = { (used.toDouble() / cap).toFloat().coerceIn(0f, 1f) },
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun DevicesCard(viewModel: TransferViewModel) {
    val devices by viewModel.account.devices.collectAsStateWithLifecycle()
    var confirming by remember { mutableStateOf<AccountDevice?>(null) }

    LaunchedEffect(Unit) { viewModel.account.loadDevices() }

    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                text = stringResource(R.string.account_devices_title),
                style = MaterialTheme.typography.titleMedium,
            )
            when (val d = devices) {
                is DevicesState.Idle -> Unit
                is DevicesState.Loading -> Busy(R.string.account_devices_loading)
                is DevicesState.Failed -> {
                    StatusCard(text = accountErrorMessage(d.failure), isError = true)
                    TextButton(
                        onClick = viewModel.account::loadDevices,
                        modifier = Modifier.height(48.dp),
                    ) {
                        Text(stringResource(R.string.account_retry))
                    }
                }
                is DevicesState.Loaded -> {
                    if (d.devices.isEmpty()) {
                        Text(
                            text = stringResource(R.string.account_devices_empty),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    d.devices.forEach { device ->
                        DeviceRow(device) { confirming = device }
                    }
                }
            }
        }
    }

    confirming?.let { device ->
        AlertDialog(
            onDismissRequest = { confirming = null },
            title = { Text(stringResource(R.string.account_device_revoke_title)) },
            text = {
                Text(
                    stringResource(
                        // Revoking THIS device's own credential ends this
                        // session, and the confirmation says so rather than
                        // letting the user discover it by being signed out.
                        if (device.current) R.string.account_device_revoke_self
                        else R.string.account_device_revoke_body,
                        device.name.ifBlank { stringResource(R.string.account_device_unnamed) },
                    ),
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirming = null
                    viewModel.account.revokeDevice(device.id)
                }) {
                    Text(stringResource(R.string.account_device_revoke_confirm))
                }
            },
            dismissButton = {
                TextButton(onClick = { confirming = null }) {
                    Text(stringResource(R.string.files_cancel))
                }
            },
        )
    }
}

@Composable
private fun DeviceRow(device: AccountDevice, onRevoke: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    text = device.name.ifBlank { stringResource(R.string.account_device_unnamed) },
                    style = MaterialTheme.typography.bodyLarge,
                )
                Text(
                    text = if (device.current) {
                        stringResource(R.string.account_device_current)
                    } else if (device.lastSeenAt > 0L) {
                        stringResource(R.string.account_device_last_seen, formatDate(device.lastSeenAt))
                    } else {
                        // 0 means the credential has never been used since it
                        // was issued — the state most worth revoking, so it is
                        // preserved rather than rendered as 1970.
                        stringResource(R.string.account_device_never_used)
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            TextButton(onClick = onRevoke, modifier = Modifier.defaultMinSize(minHeight = 48.dp)) {
                Text(stringResource(R.string.account_device_revoke))
            }
        }
        HorizontalDivider()
    }
}

// ── copy ────────────────────────────────────────────────────────────────────

/**
 * Account failures → the localised sentence to show.
 *
 * Every branch is a CLASSIFICATION, never server prose: these endpoints answer
 * in English, written for a different audience, and some answer with a bare
 * `http.Error` string. [AccountFailure.Kind.SERVER] is the one that carries a
 * diagnostic — the numeric status, which a person can quote — and it is the
 * reason this is a `@Composable` returning a STRING rather than a resource id.
 * Its copy has a `%1$d` in it, so an id resolved without the argument renders
 * the placeholder itself to the user.
 */
@Composable
internal fun accountErrorMessage(failure: AccountFailure): String =
    if (failure.kind == AccountFailure.Kind.SERVER) {
        stringResource(R.string.account_error_server, failure.status)
    } else {
        stringResource(accountErrorText(failure))
    }

/** The unformatted branches. Kept separate so the `when` stays exhaustive over
 *  the enum and a new kind cannot ship without copy. */
private fun accountErrorText(failure: AccountFailure): Int = when (failure.kind) {
    AccountFailure.Kind.NETWORK -> R.string.account_error_network
    AccountFailure.Kind.TIMEOUT -> R.string.account_error_timeout
    AccountFailure.Kind.RESPONSE_TOO_LARGE -> R.string.account_error_too_large
    AccountFailure.Kind.MALFORMED -> R.string.account_error_malformed
    // Handled by accountErrorMessage, which supplies the status argument.
    AccountFailure.Kind.SERVER -> R.string.account_error_server
    AccountFailure.Kind.RATE_LIMITED -> R.string.account_error_rate_limited
    AccountFailure.Kind.INVALID_CREDENTIALS -> R.string.account_error_credentials
    AccountFailure.Kind.NOT_SIGNED_IN -> R.string.account_error_not_signed_in
    AccountFailure.Kind.EMAIL_INVALID -> R.string.account_error_email_invalid
    AccountFailure.Kind.PASSWORD_TOO_SHORT -> R.string.account_error_password_short
    AccountFailure.Kind.EMAIL_TAKEN -> R.string.account_error_email_taken
    AccountFailure.Kind.ACCOUNT_PENDING_DELETION -> R.string.account_error_pending_deletion
    AccountFailure.Kind.DEVICE_DENIED -> R.string.account_error_device_denied
    AccountFailure.Kind.DEVICE_EXPIRED -> R.string.account_error_device_expired
    AccountFailure.Kind.UNTRUSTED_VERIFICATION_URL -> R.string.account_error_untrusted_url
    AccountFailure.Kind.PAIR_TRAFFIC_EXHAUSTED -> R.string.account_error_traffic_spent
    AccountFailure.Kind.PAIR_UNAVAILABLE -> R.string.account_error_pair_unavailable
    AccountFailure.Kind.PAIR_CODE_REJECTED -> R.string.account_error_pair_code
    AccountFailure.Kind.CREDENTIAL_UNUSABLE -> R.string.account_error_credential_unusable
}

/** An epoch second as a date in the user's own locale and time zone. Dates
 *  only: the hour a quota resets or an account is purged is not something this
 *  screen can promise to the minute. */
internal fun formatDate(epochSeconds: Long): String =
    java.text.DateFormat.getDateInstance(java.text.DateFormat.MEDIUM)
        .format(java.util.Date(epochSeconds * 1000L))
