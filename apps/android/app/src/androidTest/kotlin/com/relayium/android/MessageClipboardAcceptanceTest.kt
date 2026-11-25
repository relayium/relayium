package com.relayium.android

import android.content.ClipDescription
import android.content.ClipboardManager
import androidx.activity.ComponentActivity
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.relayium.android.ui.MessageRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MessageClipboardAcceptanceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun receivedMessageCopiesOriginalText() {
        assertCopied(TransferController.Message("  第一行\nSecond line 🔑\t ", fromPeer = true))
    }

    @Test fun sentMessageCopiesOriginalText() {
        assertCopied(TransferController.Message("  localhost\n另一行\t ", fromPeer = false))
    }

    private fun assertCopied(message: TransferController.Message) {
        compose.setContent {
            MaterialTheme { MessageRow(message) }
        }
        val activity = compose.activity
        compose.onNodeWithText(activity.getString(R.string.text_copy_message))
            .assertIsDisplayed()
            .performClick()
        compose.onNodeWithText(activity.getString(R.string.text_message_copied)).assertIsDisplayed()
        compose.runOnIdle {
            val clipboard = activity.getSystemService(ClipboardManager::class.java)
            val clip = requireNotNull(clipboard.primaryClip)
            assertEquals(message.body, clip.getItemAt(0).text.toString())
            assertTrue(clip.description.extras?.getBoolean(ClipDescription.EXTRA_IS_SENSITIVE) == true)
        }
    }
}
