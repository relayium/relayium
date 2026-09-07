package com.relayium.android.ui

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
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
 * Everything else is Material 3 semantic colour. The brand appears on actions
 * and on meaningful state, and nowhere else: this is a utility, not a landing
 * page, and decorative brand fills would compete with the transfer state the
 * user is actually watching.
 *
 * Dynamic colour is deliberately NOT used. It would replace the one thing that
 * makes this app recognisably Relayium with the wallpaper.
 */
private val ActionLight = Color(0xFF6D28D9)
private val ActionDark = Color(0xFF7C3AED)
private val AccentTextDark = Color(0xFFC084FC)
private val AccentTextLight = Color(0xFF7E22CE)

private val LightColors = lightColorScheme(
    primary = ActionLight,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFEDE4FE),
    onPrimaryContainer = Color(0xFF2A0A5E),
    secondary = AccentTextLight,
    onSecondary = Color.White,
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
 * Nothing here sets a fixed `sp` on a container, so the whole UI scales with the
 * system font size.
 */
private val RelayiumTypography = Typography().let { base ->
    base.copy(
        headlineSmall = base.headlineSmall.copy(fontWeight = FontWeight.SemiBold),
        titleMedium = base.titleMedium.copy(fontWeight = FontWeight.Medium),
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
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = RelayiumTypography,
        content = content,
    )
}

/** Kept so a future decision about Android 12 dynamic colour is explicit rather
 *  than an omission somebody has to reconstruct. */
internal val SUPPORTS_DYNAMIC_COLOR = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
