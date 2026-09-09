package com.relayium.android.ui

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * The brand, applied the way the existing clients apply it.
 *
 * `apps/ios/Relayium/Components/DesignTokens.swift` and `web/src/app.css` agree
 * on two things this theme keeps:
 *
 * - The action violet is `#6D28D9` light / `#7C3AED` dark and it carries WHITE
 *   labels. Both were chosen for contrast against white (7.10:1 and 5.70:1).
 * - Accent TEXT in dark mode is a LIGHTER violet, `#C084FC`. Using the fill
 *   colour for text on a dark background is 2.64:1 and unreadable, which is the
 *   mistake the web tokens document at length.
 *
 * ## The surfaces are NEUTRAL, and that is a change
 *
 * They used to be whatever `lightColorScheme()`/`darkColorScheme()` produce,
 * which is a purple-seeded neutral ramp: a lavender page under lavender-grey
 * cards, a small step apart. That spent the brand colour on the background —
 * the one place it says nothing — and left cards without a readable edge.
 *
 * The ramp below is grey. The violet now appears only on the action a screen
 * wants next, on the destination you are on, and on state that has been
 * reached, which is the same rule the iOS `Palette` states.
 *
 * Dynamic colour is deliberately NOT used. It would replace the one thing that
 * makes this app recognisably Relayium with the wallpaper.
 */
private val ActionLight = Color(0xFF6D28D9)
private val ActionDark = Color(0xFF7C3AED)
private val AccentTextDark = Color(0xFFC084FC)
private val AccentTextLight = Color(0xFF7E22CE)

/**
 * The container ramp, and why `surfaceContainerLow` is "a card" in both themes.
 *
 * Material's ramp runs lowest → highest by elevation, which inverts between
 * light and dark: in light the lowest container is the brightest, in dark it is
 * the darkest. A card that reads as raised in both therefore cannot be pinned
 * to an end of that ramp — so `surfaceContainerLow` is given the card value in
 * each scheme (white on a grey page; a lighter grey on a near-black page) and
 * `SectionCard` asks for that role by name.
 *
 * `surfaceContainerHighest` is given the SAME value in both schemes on purpose:
 * it is what an un-migrated `Card {}` picks up by default, and a stray one
 * should look like the rest of the app rather than announce itself.
 */
private val LightColors = lightColorScheme(
    primary = ActionLight,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFEDE4FE),
    onPrimaryContainer = Color(0xFF2A0A5E),
    secondary = AccentTextLight,
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFEFE6FD),
    onSecondaryContainer = Color(0xFF33106A),
    background = Color(0xFFF2F2F5),
    onBackground = Color(0xFF1A1A1E),
    surface = Color(0xFFF2F2F5),
    onSurface = Color(0xFF1A1A1E),
    // Supporting prose. `#5A5A63` measures 6.1:1 on the page and 6.8:1 on a
    // card, so every caption, detail line and byte count clears WCAG 1.4.3 at
    // body size rather than relying on the 3:1 large-text exemption.
    surfaceVariant = Color(0xFFE6E6EB),
    onSurfaceVariant = Color(0xFF5A5A63),
    surfaceContainerLowest = Color(0xFFFFFFFF),
    surfaceContainerLow = Color(0xFFFFFFFF),
    surfaceContainer = Color(0xFFF7F7F9),
    surfaceContainerHigh = Color(0xFFEFEFF3),
    surfaceContainerHighest = Color(0xFFFFFFFF),
    outline = Color(0xFF74747E),
    // The card hairline. Light enough not to be looked at, dark enough that the
    // edge survives a white card on a near-white page.
    outlineVariant = Color(0xFFDCDCE3),
    error = Color(0xFFB3261E),
    onError = Color.White,
    errorContainer = Color(0xFFF9DEDC),
    onErrorContainer = Color(0xFF410E0B),
)

private val DarkColors = darkColorScheme(
    primary = ActionDark,
    onPrimary = Color.White,
    primaryContainer = Color(0xFF2E1065),
    onPrimaryContainer = AccentTextDark,
    // Accent TEXT, not the fill: 6.77:1 on the dark background.
    secondary = AccentTextDark,
    onSecondary = Color(0xFF1A0A33),
    secondaryContainer = Color(0xFF2B1B47),
    onSecondaryContainer = Color(0xFFDDC4FE),
    background = Color(0xFF111114),
    onBackground = Color(0xFFE8E8EC),
    surface = Color(0xFF111114),
    onSurface = Color(0xFFE8E8EC),
    surfaceVariant = Color(0xFF2A2A31),
    // 6.5:1 on a card, 7.3:1 on the page.
    onSurfaceVariant = Color(0xFFA0A0AA),
    surfaceContainerLowest = Color(0xFF0B0B0E),
    surfaceContainerLow = Color(0xFF1C1C22),
    surfaceContainer = Color(0xFF17171C),
    surfaceContainerHigh = Color(0xFF26262E),
    surfaceContainerHighest = Color(0xFF1C1C22),
    outline = Color(0xFF8A8A95),
    outlineVariant = Color(0xFF33333C),
    error = Color(0xFFF2B8B5),
    onError = Color(0xFF601410),
    errorContainer = Color(0xFF8C1D18),
    onErrorContainer = Color(0xFFF9DEDC),
)

/**
 * Type. No custom font file: the platform font renders every supported language
 * — including Simplified Chinese — without shipping a megabyte of glyphs the app
 * would then have to keep current.
 *
 * The weights are raised where the 0.2.0 build had none: a screen title, a card
 * title and a button label all rendered at the same weight as the paragraph
 * under them, so nothing on a screen led. Nothing here sets a fixed `sp` on a
 * container, so the whole UI still scales with the system font size.
 */
private val RelayiumTypography = Typography().let { base ->
    base.copy(
        headlineSmall = base.headlineSmall.copy(fontWeight = FontWeight.Bold),
        titleLarge = base.titleLarge.copy(fontWeight = FontWeight.SemiBold),
        titleMedium = base.titleMedium.copy(fontWeight = FontWeight.SemiBold),
        titleSmall = base.titleSmall.copy(fontWeight = FontWeight.SemiBold),
        labelLarge = base.labelLarge.copy(fontWeight = FontWeight.SemiBold),
    )
}

/** The pairing code and the SAS are digits the user compares character by
 *  character, so they get a monospaced, wide-tracked style. */
val MonospaceDigits = TextStyle(
    fontFamily = FontFamily.Monospace,
    fontSize = 28.sp,
    letterSpacing = 6.sp,
    fontWeight = FontWeight.Medium,
)

@Composable
fun RelayiumTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    // One observer for the app, established here so every surface reads the
    // same live answer rather than sampling the setting independently.
    CompositionLocalProvider(LocalMotionEnabled provides rememberMotionEnabled()) {
        MaterialTheme(
            colorScheme = if (darkTheme) DarkColors else LightColors,
            typography = RelayiumTypography,
            content = content,
        )
    }
}

/** Kept so a future decision about Android 12 dynamic colour is explicit rather
 *  than an omission somebody has to reconstruct. */
internal val SUPPORTS_DYNAMIC_COLOR = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
