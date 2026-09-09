package com.relayium.android.ui

import android.content.ContentResolver
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The app's visual and motion vocabulary, in one file, so a screen inherits its
 * spacing, containers, actions and timings instead of re-deriving them.
 *
 * Two rules run through all of it:
 *
 *  * **No colour literals.** Everything resolves through a Material 3 semantic
 *    role that [RelayiumTheme] defines once, so light and dark are answered in
 *    one place. The brand violet is for the action a screen wants next, the
 *    destination you are on, and state that has been reached.
 *  * **Motion never changes which surface owns an action or a piece of state.**
 *    Only a layer's opacity and offset, a colour, and an already-reported
 *    number animate. An offset does move where a control is drawn and pressed
 *    while it runs, so the guarantee is ownership, not pixels: one destination
 *    is composed at a time, nothing is inserted into an animating height, and
 *    no control outlives the state that justified it. There is no
 *    `animateContentSize` and no `AnimatedVisibility` anywhere: the first clips
 *    newly inserted content to an animating height, the second keeps outgoing
 *    content composed and clickable after its state is gone, and what gets
 *    inserted into these containers is consent prompts, failures and actions.
 */
internal object Metrics {
    /** Between top-level sections of a screen. */
    val section: Dp = 20.dp

    /** Padding inside a card. */
    val inner: Dp = 16.dp

    /** Between a label and the thing it labels. */
    val tight: Dp = 8.dp

    /** Between lines of one thought. */
    val hairline: Dp = 4.dp

    /** Inside a card, between one part and the next. */
    val cardGap: Dp = 12.dp

    /**
     * The touch-target floor, always applied with `defaultMinSize` and never
     * with `height`: a fixed height is also a ceiling, and it clips these
     * labels at font scale 2 on a 320dp screen.
     */
    val touch: Dp = 48.dp

    /** A screen's primary action: the same floor, with more presence. */
    val action: Dp = 52.dp

    /** A leading status marker. Fixed in dp — it sits beside prose rather than
     *  being text, and growing it takes width the sentence needs at 320dp. */
    val statusIcon: Dp = 20.dp
}

// ── motion ──────────────────────────────────────────────────────────────────

/** Every duration in the app. Nothing here loops and nothing decorative moves. */
internal object Motion {
    /** Selection, and a value that merely moved. */
    const val QUICK = 150

    /** The default: a destination arriving. */
    const val STANDARD = 200
}

/** Whether this device wants motion, provided once by [RelayiumTheme] so the
 *  app shares one observer and a change re-renders the tree that reads it. */
internal val LocalMotionEnabled = staticCompositionLocalOf { true }

/**
 * `Settings.Global.ANIMATOR_DURATION_SCALE`, observed rather than sampled.
 *
 * A static read (`ValueAnimator.areAnimatorsEnabled()`) is correct at the
 * instant of composition and then silently stale, so a user who turns animation
 * off while the app is open would keep it. The observer is what makes the
 * setting take effect and what makes it testable.
 *
 * This does not double-scale. Compose applies its own `MotionDurationScale`
 * from the same setting to animation durations, so [uiSpec] hands out an
 * unscaled duration and lets that do the scaling. The zero branch is
 * deliberately redundant with it: it keeps reduced motion a property of this
 * file rather than of a dependency's context propagation.
 */
@Composable
internal fun rememberMotionEnabled(): Boolean {
    val resolver = LocalContext.current.contentResolver
    val scale by produceState(initialValue = animatorScale(resolver), resolver) {
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                value = animatorScale(resolver)
            }
        }
        resolver.registerContentObserver(
            Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE),
            false,
            observer,
        )
        // Re-read AFTER registering: a change landing between the initial read
        // and the registration would otherwise be missed for the life of the
        // screen, which is the failure this observer exists to prevent.
        value = animatorScale(resolver)
        awaitDispose { resolver.unregisterContentObserver(observer) }
    }
    return scale != 0f
}

private fun animatorScale(resolver: ContentResolver): Float =
    Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)

/** The live answer, for a call site that only wants to know. */
@Composable
internal fun motionEnabled(): Boolean = LocalMotionEnabled.current

/** The one spec shape in the app: eased, bounded, absent when motion is off. */
@Composable
internal fun <T> uiSpec(durationMillis: Int = Motion.STANDARD): FiniteAnimationSpec<T> =
    if (motionEnabled()) {
        tween(durationMillis = durationMillis, easing = FastOutSlowInEasing)
    } else {
        snap()
    }

/**
 * A destination arriving.
 *
 * Entrance only, so exactly one destination is composed at any moment. A
 * `Crossfade` or `AnimatedContent` would keep the outgoing subtree alive for
 * the transition — meaning duplicate flow collectors, a second copy of each
 * one-shot `LaunchedEffect`, and a Disconnect or Accept button from the screen
 * the user just left, still hittable on top of the new one.
 *
 * The fade starts at [ENTRANCE_FLOOR] rather than at zero because navigation is
 * often the result of an action and what waits on the other side is often an
 * error; the first frame stays legible. Global warnings are drawn outside this
 * wrapper by [RelayiumApp] and never animate.
 *
 * @param key the destination identity and nothing else — never the transfer
 *   phase or an error, so state changing under the user does not animate.
 */
@Composable
internal fun DestinationEntrance(
    key: Any,
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    val enabled = motionEnabled()
    // Seeded from the setting: with motion off the first frame must already be
    // final, not dim-then-corrected by the effect below.
    val entrance = remember { Animatable(if (enabled) 0f else 1f) }
    LaunchedEffect(key, enabled) {
        if (!enabled) {
            entrance.snapTo(1f)
            return@LaunchedEffect
        }
        entrance.snapTo(0f)
        entrance.animateTo(1f, tween(Motion.STANDARD, easing = FastOutSlowInEasing))
    }
    val rise = with(LocalDensity.current) { ENTRANCE_RISE.toPx() }
    Column(
        modifier = modifier
            .fillMaxWidth()
            .graphicsLayer {
                val progress = entrance.value
                alpha = ENTRANCE_FLOOR + (1f - ENTRANCE_FLOOR) * progress
                translationY = (1f - progress) * rise
            },
        verticalArrangement = Arrangement.spacedBy(Metrics.section),
        content = content,
    )
}

/** A hint that the surface changed, not a slide to sit through. */
private val ENTRANCE_RISE = 12.dp

/** The opacity a destination is already at on its first frame. */
private const val ENTRANCE_FLOOR = 0.6f

/**
 * A progress bar that eases FORWARD only.
 *
 * Progress arrives in bursts, so growth is interpolated to keep the bar from
 * teleporting. Every other change snaps:
 *
 *  * a **decrease** — a new file in the batch, a retry, a reset — snaps,
 *    because interpolating down would show the new operation at the old one's
 *    fraction and overreport work it has not done;
 *  * a change of [operation] snaps for the same reason even when the fraction
 *    happens to rise;
 *  * a non-finite fraction is treated as zero rather than propagated into the
 *    animation.
 *
 * The byte counts beside the bar are never animated; they are the
 * authoritative figures and update in the frame they change.
 */
@Composable
internal fun SmoothLinearProgress(
    fraction: Float,
    operation: Any,
    modifier: Modifier = Modifier,
) {
    val target = if (fraction.isFinite()) fraction.coerceIn(0f, 1f) else 0f
    // Keyed on the operation, so a new one starts AT its own fraction rather
    // than easing there from the previous operation's. That covers the case a
    // decrease check cannot: a new transfer whose first reported fraction
    // happens to be higher than where the last one stopped.
    val shown = remember(operation) { Animatable(target) }
    val enabled = motionEnabled()
    LaunchedEffect(target, shown, enabled) {
        if (!enabled || target <= shown.value) {
            shown.snapTo(target)
        } else {
            shown.animateTo(target, tween(Motion.QUICK, easing = FastOutSlowInEasing))
        }
    }
    LinearProgressIndicator(progress = { shown.value }, modifier = modifier)
}

// ── structure ───────────────────────────────────────────────────────────────

/**
 * A screen's name and one line about what it is for. Every destination has one.
 *
 * The supporting line is `bodyMedium` in the supporting colour rather than
 * `bodyLarge` in the body colour, which is what lets the primary action come
 * first without removing the explanation.
 */
@Composable
internal fun ScreenHeader(title: String, supporting: String? = null) {
    Column(verticalArrangement = Arrangement.spacedBy(Metrics.tight)) {
        Text(text = title, style = MaterialTheme.typography.headlineSmall)
        if (supporting != null) {
            Text(
                text = supporting,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/**
 * The app's one container.
 *
 * A light fill on a neutral page plus a hairline. The border is what states the
 * edge: the fill difference between a card and the page is a small step
 * whichever values are chosen, and it survives a system contrast setting
 * flattening the fills.
 *
 * No size animation, per the file's motion rule — these cards are what consent
 * prompts and failure messages are inserted into.
 */
@Composable
internal fun SectionCard(
    modifier: Modifier = Modifier,
    title: String? = null,
    tone: CardTone = CardTone.PLAIN,
    content: @Composable ColumnScope.() -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    val container = when (tone) {
        // surfaceContainerLow, which `Theme.kt` gives the card value in BOTH
        // schemes. `surfaceContainerLowest` is an END of Material's ramp and
        // therefore inverts between them: it is white in light and the
        // DARKEST grey in dark, which drew cards blacker than the page.
        CardTone.PLAIN -> scheme.surfaceContainerLow
        CardTone.ATTENTION -> scheme.secondaryContainer
        CardTone.ERROR -> scheme.errorContainer
    }
    val border = if (tone == CardTone.PLAIN) scheme.outlineVariant else Color.Transparent
    Card(
        modifier = modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.large,
        colors = CardDefaults.cardColors(containerColor = container),
        border = BorderStroke(1.dp, border),
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(Metrics.inner),
            verticalArrangement = Arrangement.spacedBy(Metrics.cardGap),
        ) {
            if (title != null) {
                Text(text = title, style = MaterialTheme.typography.titleMedium)
            }
            content()
        }
    }
}

/**
 * What a card is about. [ATTENTION] marks something asking the user a question
 * and is the one place a brand-tinted container is correct; [ERROR] is a
 * failure; everything else is [PLAIN].
 */
internal enum class CardTone { PLAIN, ATTENTION, ERROR }

// ── actions ─────────────────────────────────────────────────────────────────

/** The thing this screen wants next. Filled, and the loudest control present. */
@Composable
internal fun PrimaryAction(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = Metrics.action),
    ) {
        Text(label)
    }
}

/**
 * A real alternative to the primary, at a lower volume.
 *
 * Its label takes the accent TEXT role — the lighter violet in dark mode —
 * never the fill colour, which `Theme.kt` documents as unreadable as text on a
 * dark background.
 */
@Composable
internal fun SecondaryAction(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        colors = ButtonDefaults.outlinedButtonColors(
            contentColor = MaterialTheme.colorScheme.secondary,
        ),
        modifier = modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = Metrics.touch),
    ) {
        Text(label)
    }
}

/**
 * Dismiss, cancel, "not now" — present, reachable, and not competing.
 *
 * Takes the accent TEXT role for the same reason [SecondaryAction] does.
 * Material's default for both `TextButton` and `OutlinedButton` is
 * `colorScheme.primary`, which is the action FILL — correct behind a white
 * label, unreadable as a label itself on a dark background.
 */
@Composable
internal fun TertiaryAction(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    TextButton(
        onClick = onClick,
        enabled = enabled,
        colors = ButtonDefaults.textButtonColors(
            contentColor = MaterialTheme.colorScheme.secondary,
        ),
        modifier = modifier.defaultMinSize(minHeight = Metrics.touch),
    ) {
        Text(label)
    }
}

/**
 * A text field whose focused label, border and cursor take the accent TEXT role.
 *
 * `OutlinedTextFieldDefaults` uses `colorScheme.primary` for all three, which is
 * the action FILL — correct behind a white button label, and unreadable as a
 * thin line or a label on a dark background. Error colours and every input
 * behaviour are left at their defaults.
 */
@Composable
internal fun accentFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedLabelColor = MaterialTheme.colorScheme.secondary,
    focusedBorderColor = MaterialTheme.colorScheme.secondary,
    cursorColor = MaterialTheme.colorScheme.secondary,
)

/** The accent-text colours every non-filled control in the app takes, for the
 *  few call sites that still build their own `OutlinedButton` — a bordered
 *  control inside a weighted Row, for instance, where the shared primitive's
 *  `fillMaxWidth` is the wrong shape. */
@Composable
internal fun accentOutlinedColors() = ButtonDefaults.outlinedButtonColors(
    contentColor = MaterialTheme.colorScheme.secondary,
)

// ── saying something ────────────────────────────────────────────────────────

/** What a message is. [NEUTRAL] states a fact, [DONE] reports something that
 *  finished, [WARNING] is a caveat to act on, [ERROR] is a failure. */
internal enum class MessageTone { NEUTRAL, DONE, WARNING, ERROR }

/**
 * One sentence about state, with a marker and a container that agree with it.
 *
 * Appears and disappears in one frame, with no transition in either direction:
 * these are refusals, failures and consent prompts, and none may be delayed,
 * clipped, or left hittable after the state that justified it has gone.
 */
@Composable
internal fun InlineMessage(
    text: String,
    tone: MessageTone,
    modifier: Modifier = Modifier,
    announce: Boolean = false,
) {
    val scheme = MaterialTheme.colorScheme
    val container = when (tone) {
        MessageTone.ERROR -> scheme.errorContainer
        MessageTone.DONE -> scheme.secondaryContainer
        MessageTone.WARNING, MessageTone.NEUTRAL -> scheme.surfaceContainerHigh
    }
    val onContainer = when (tone) {
        MessageTone.ERROR -> scheme.onErrorContainer
        MessageTone.DONE -> scheme.onSecondaryContainer
        MessageTone.WARNING, MessageTone.NEUTRAL -> scheme.onSurface
    }
    val icon: ImageVector = when (tone) {
        MessageTone.ERROR, MessageTone.WARNING -> Icons.Filled.Warning
        MessageTone.DONE -> Icons.Filled.CheckCircle
        MessageTone.NEUTRAL -> Icons.Filled.Info
    }
    Card(
        modifier = modifier
            .fillMaxWidth()
            .then(
                if (announce) {
                    Modifier.semantics { liveRegion = LiveRegionMode.Polite }
                } else {
                    Modifier
                },
            ),
        shape = MaterialTheme.shapes.medium,
        colors = CardDefaults.cardColors(containerColor = container),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(Metrics.inner),
            horizontalArrangement = Arrangement.spacedBy(Metrics.cardGap),
            // TOP, not centre: at font scale 2 these sentences run to several
            // lines and a centred marker drifts into the middle of the
            // paragraph, where it reads as a bullet.
            verticalAlignment = Alignment.Top,
        ) {
            Icon(
                imageVector = icon,
                // Decorative: the sentence beside it already says this.
                contentDescription = null,
                tint = onContainer,
                modifier = Modifier.size(Metrics.statusIcon),
            )
            Text(
                text = text,
                style = MaterialTheme.typography.bodyMedium,
                color = onContainer,
                modifier = Modifier.weight(1f),
            )
        }
    }
}

// ── selection ───────────────────────────────────────────────────────────────

/** The compact destination bar's selection colour, moving rather than
 *  switching. The wide `NavigationBar` animates its own indicator; this form
 *  had nothing. */
@Composable
internal fun selectionColor(selected: Boolean): Color {
    val target = if (selected) {
        MaterialTheme.colorScheme.onSecondaryContainer
    } else {
        MaterialTheme.colorScheme.onSurfaceVariant
    }
    val color by animateColorAsState(
        targetValue = target,
        animationSpec = uiSpec(Motion.QUICK),
        label = "destination-selection",
    )
    return color
}

/** The pill behind the selected destination in the compact bar; transparent
 *  when unselected, so an unselected destination has no container. */
@Composable
internal fun selectionContainer(selected: Boolean): Color {
    val target = if (selected) {
        MaterialTheme.colorScheme.secondaryContainer
    } else {
        Color.Transparent
    }
    val color by animateColorAsState(
        targetValue = target,
        animationSpec = uiSpec(Motion.QUICK),
        label = "destination-selection-container",
    )
    return color
}
