package com.relayium.android.integration

import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.performScrollTo

/**
 * Bring a control into view the way a person can, then require that it really
 * is usable.
 *
 * ## Why `performScrollTo()` cannot simply be called
 *
 * It throws when the node has no scrollable ancestor — "no parent layout with a
 * Scroll semantics property" — and several controls this suite taps have none.
 * The destination bar in its wide `NavigationBar` form is the clearest case:
 * every tab is already on screen, nothing scrolls, and asking to scroll to one
 * fails a test about something else entirely. The same call is REQUIRED at
 * 320dp and font scale 2, where the bar becomes a scrolling row and half the
 * destinations start off screen.
 *
 * So: scroll only when the control is not already showing, and then insist it
 * is displayed and enabled before the single tap. Existing in the semantics
 * tree is not reachability — that is exactly how a control below the fold gets
 * "tapped" by a test and never by a user.
 */
internal fun SemanticsNodeInteraction.reach(): SemanticsNodeInteraction {
    bringIntoView()
    assertIsEnabled()
    return this
}

/**
 * Bring a node into view and require it to be VISIBLE — and nothing about
 * whether it can be pressed.
 *
 * [reach] is for controls the user is meant to act on, and its enabled
 * assertion is deliberate. It is the wrong contract for a control that is
 * disabled ON PURPOSE: the share surface shows "Send to one of your devices"
 * greyed out while signed out, because hiding it would read as a destination
 * this build does not have. Asserting it enabled there fails on correct
 * behaviour — which is exactly what happened, and no amount of waiting for the
 * account to settle could have fixed it, because the state being waited for is
 * the one that makes the control disabled.
 *
 * So a case that means "this is shown and says why it cannot be used" scrolls
 * with this and then states the enabled-ness it actually expects.
 */
internal fun SemanticsNodeInteraction.bringIntoView(): SemanticsNodeInteraction {
    if (runCatching { assertIsDisplayed() }.isFailure) performScrollTo()
    assertIsDisplayed()
    return this
}
