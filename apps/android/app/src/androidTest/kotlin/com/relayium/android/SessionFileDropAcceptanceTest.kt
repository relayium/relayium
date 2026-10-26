package com.relayium.android

import android.content.ComponentName
import android.content.Intent
import android.content.res.Configuration
import android.os.LocaleList
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.Composable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.relayium.android.ui.RelayiumTheme
import com.relayium.android.ui.SessionFileDrop
import java.io.Closeable
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.*
import org.junit.Rule
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SessionFileDropAcceptanceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val device get() = UiDevice.getInstance(instrumentation)
    private val feedback = com.relayium.android.ui.SessionFileDropFeedback()
    private val rootDragActions = ConcurrentLinkedQueue<String>()
    private var platformAccepted = false
    private var contentForRecreation: (@Composable () -> Unit)? = null
    private var recreationCallbacks: android.app.Application.ActivityLifecycleCallbacks? = null

    @After fun removeRecreationObserver() {
        recreationCallbacks?.let {
            (context.applicationContext as android.app.Application).unregisterActivityLifecycleCallbacks(it)
        }
    }

    @Test fun englishFileEntryKeepsWorkingPicker() {
        val picks = AtomicInteger()
        render(choose = { picks.incrementAndGet() })
        compose.onNodeWithText(context.getString(R.string.files_drop_title)).assertIsDisplayed()
        compose.onNodeWithText(context.getString(R.string.files_drop_hint)).assertIsDisplayed()
        compose.onNodeWithText(context.getString(R.string.files_pick)).performClick()
        assertEquals(1, picks.get())
        capture("english")
    }

    @Test fun chineseDarkLargeTextGrowsInsideNarrowFileEntry() {
        systemBars(true)
        val configuration = Configuration(context.resources.configuration).apply {
            setLocales(LocaleList.forLanguageTags("zh-CN")); fontScale = 2f
        }
        val localized = context.createConfigurationContext(configuration)
        compose.setContent {
            CompositionLocalProvider(LocalContext provides localized,
                LocalDensity provides Density(context.resources.displayMetrics.density, 2f)) {
                RelayiumTheme(darkTheme = true) {
                    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).windowInsetsPadding(WindowInsets.safeDrawing).padding(8.dp)) {
                        Column(Modifier.width(300.dp)) {
                            SessionFileDrop(7, true, false, {}, { _, _, p -> p.close(); false })
                        }
                    }
                }
            }
        }
        val title = localized.getString(R.string.files_drop_title)
        val hint = localized.getString(R.string.files_drop_hint)
        compose.onNodeWithText(title).assertIsDisplayed()
        compose.onNodeWithText(hint).assertIsDisplayed()
        val button = compose.onNodeWithText(localized.getString(R.string.files_pick)).assertIsDisplayed()
        assertTrue(button.fetchSemanticsNode().boundsInRoot.height >= 48 * context.resources.displayMetrics.density)
        capture("chinese-dark-large")
    }

    @Test fun pendingSelectionDisablesPicker() {
        render(busy = true)
        compose.onNodeWithText(context.getString(R.string.files_pick)).assertIsNotEnabled()
        compose.onNodeWithText(context.getString(R.string.files_drop_preparing)).assertIsDisplayed()
    }

    @Test fun realExternalFileDragKeepsGrantForAsyncReadAndReleasesIt() {
        assertNotEquals(context.packageManager.getApplicationInfo(instrumentation.context.packageName, 0).uid,
            android.os.Process.myUid())
        assertNoReadGrant()
        val calls = AtomicInteger(); val ready = CountDownLatch(1); val read = CountDownLatch(1)
        val done = CountDownLatch(1); val bytes = AtomicReference<ByteArray>()
        val errors = ConcurrentLinkedQueue<Throwable>(); val worker = Executors.newSingleThreadExecutor()
        try {
            render(drop = { uris, link, permission ->
                calls.incrementAndGet(); assertEquals(7, link); assertEquals(1, uris.size)
                worker.execute {
                    ready.countDown()
                    try {
                        check(read.await(5, TimeUnit.SECONDS))
                        bytes.set(context.contentResolver.openInputStream(uris.single())!!.use { it.readBytes() })
                    } catch (e: Throwable) { errors.add(e) }
                    finally { permission.close(); done.countDown() }
                }
                true
            })
            drag()
            assertTrue("system received the target's successful drop result", platformAccepted)
            val arrived = ready.await(5, TimeUnit.SECONDS)
            if (!arrived) capture("actual-drop-no-callback")
            assertTrue("actual framework drop reached callback; feedback=${feedback.refusal}; root=$rootDragActions", arrived)
            // The callback has returned. A grant released at onDrop's return
            // makes this later, real provider open fail with SecurityException.
            read.countDown(); assertTrue(done.await(5, TimeUnit.SECONDS))
            assertTrue(errors.toString(), errors.isEmpty())
            assertArrayEquals(SessionDropFixtureProvider.BODY, bytes.get())
            assertEquals(1, calls.get()); assertNoReadGrant()
        } finally { read.countDown(); worker.shutdownNow(); closeSource() }
    }

    @Test fun textDropDoesNotBecomeFileSelection() {
        val calls = AtomicInteger()
        render(drop = { _, _, p -> calls.incrementAndGet(); p.close(); true })
        try {
            drag(textOnly = true); compose.waitForIdle(); assertFalse(platformAccepted)
            assertEquals(0, calls.get()); assertNull(feedback.refusal)
        }
        finally { closeSource() }
    }

    @Test fun externalFileWithoutReadGrantIsRefused() {
        assertNoReadGrant(); val calls = AtomicInteger()
        render(drop = { _, _, p -> calls.incrementAndGet(); p.close(); true })
        try {
            drag(noReadGrant = true); compose.waitForIdle(); assertFalse(platformAccepted)
            assertEquals(0, calls.get()); assertNoReadGrant()
            assertTrue("actual target refused missing read permission", feedback.refusal in listOf(
                com.relayium.android.ui.SessionFileDropRefusal.NO_GRANT,
                com.relayium.android.ui.SessionFileDropRefusal.NO_READ_PERMISSION))
        }
        finally { closeSource() }
    }

    private fun render(busy: Boolean = false, choose: () -> Unit = {},
        drop: (List<android.net.Uri>, Int, Closeable) -> Boolean = { _, _, p -> p.close(); false }) {
        systemBars(false)
        val content: @Composable () -> Unit = {
            RelayiumTheme(darkTheme = false) {
                Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).windowInsetsPadding(WindowInsets.safeDrawing).padding(24.dp)) {
                    SessionFileDrop(7, true, busy, choose, drop, feedback)
                }
            }
        }
        contentForRecreation = content
        compose.setContent(content)
        compose.waitForIdle()
    }

    private fun drag(textOnly: Boolean = false, noReadGrant: Boolean = false) {
        val host = compose.activity
        instrumentation.runOnMainSync {
            host.findViewById<android.view.View>(android.R.id.content).setOnDragListener { _, event ->
                rootDragActions.add("${event.action}:data=${event.clipData != null}:types=${event.clipDescription?.mimeTypeCount}")
                false // Observe only; normal child dispatch remains authoritative.
            }
        }
        val callbacks = object : android.app.Application.ActivityLifecycleCallbacks {
            override fun onActivityPostCreated(activity: android.app.Activity, state: android.os.Bundle?) {
                if (activity.javaClass == ComponentActivity::class.java) {
                    (activity as ComponentActivity).setContent(content = requireNotNull(contentForRecreation))
                }
            }
            override fun onActivityCreated(a: android.app.Activity, b: android.os.Bundle?) = Unit
            override fun onActivityStarted(a: android.app.Activity) = Unit
            override fun onActivityResumed(a: android.app.Activity) = Unit
            override fun onActivityPaused(a: android.app.Activity) = Unit
            override fun onActivityStopped(a: android.app.Activity) = Unit
            override fun onActivitySaveInstanceState(a: android.app.Activity, b: android.os.Bundle) = Unit
            override fun onActivityDestroyed(a: android.app.Activity) = Unit
        }
        recreationCallbacks = callbacks
        (context.applicationContext as android.app.Application).registerActivityLifecycleCallbacks(callbacks)
        val intent = Intent().setComponent(ComponentName(instrumentation.context.packageName,
            SessionDropSourceActivity::class.java.name))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_LAUNCH_ADJACENT)
            .putExtra("textOnly", textOnly).putExtra("noReadGrant", noReadGrant)
        instrumentation.runOnMainSync { host.startActivity(intent) }
        check(device.wait(Until.hasObject(By.text("Drag fixture")), 5_000))
        device.waitForIdle()
        val destinationHost = compose.activity
        val targetPhase = AtomicReference<androidx.lifecycle.Lifecycle.State>()
        instrumentation.runOnMainSync {
            targetPhase.set(destinationHost.lifecycle.currentState)
            destinationHost.findViewById<android.view.View>(android.R.id.content).setOnDragListener { _, event ->
                rootDragActions.add("${event.action}:data=${event.clipData != null}:types=${event.clipDescription?.mimeTypeCount}")
                false
            }
        }
        check(targetPhase.get().isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED)) {
            "actual drop destination is not visible: ${targetPhase.get()}"
        }
        check(destinationHost.isInMultiWindowMode) { "source and destination are not in real split screen" }
        check(device.wait(Until.hasObject(By.text(context.getString(R.string.files_drop_hint))), 5_000))
        val destination = device.findObject(By.text(context.getString(R.string.files_drop_hint))).visibleBounds
        val source = device.findObject(By.text("Drag fixture")).visibleBounds
        println("DROP_GESTURE source=$source destination=$destination")
        check(device.drag(source.centerX(), source.centerY(), destination.centerX(), destination.centerY(), 60))
        device.waitForIdle()
        check(device.wait(Until.hasObject(By.text(java.util.regex.Pattern.compile("Drop (accepted|refused)"))), 5_000)) {
            "source did not receive the actual platform drag-ended result"
        }
        platformAccepted = device.hasObject(By.text("Drop accepted"))
    }

    private fun systemBars(dark: Boolean) {
        instrumentation.runOnMainSync {
            val window = compose.activity.window
            androidx.core.view.WindowCompat.getInsetsController(window, window.decorView).apply {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
        }
    }

    private fun assertNoReadGrant() {
        try {
            context.contentResolver.openInputStream(SessionDropFixtureProvider.URI)?.close()
            fail("target UID read external provider without a live drag grant")
        } catch (_: SecurityException) { /* Required actual framework refusal. */ }
    }
    private fun closeSource() { device.pressBack(); device.waitForIdle() }
    private fun capture(name: String) {
        val folder = java.io.File(context.getExternalFilesDir(null), "session-drop-acceptance").apply { mkdirs() }
        check(device.takeScreenshot(java.io.File(folder, "$name.png")))
    }
}
