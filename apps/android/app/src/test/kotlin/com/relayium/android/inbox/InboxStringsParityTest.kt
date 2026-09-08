package com.relayium.android.inbox

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/**
 * The Inbox surface's own English / Simplified Chinese coverage.
 *
 * `AppStringsParityTest` reads `strings.xml` by path and so does not see this
 * feature's resources at all; until an all-resource parity check lands, this is
 * the check that stops an untranslated Inbox string shipping. It also asserts
 * the other direction — that every `inbox_` key the screen READS exists — which
 * is the failure that would otherwise be a crash at composition rather than a
 * missing translation.
 */
class InboxStringsParityTest {

    private val en = "src/main/res/values/inbox.xml"
    private val zh = "src/main/res/values-zh-rCN/inbox.xml"

    private fun document(path: String) = DocumentBuilderFactory.newInstance()
        .newDocumentBuilder()
        .parse(File(path).also { assertTrue("missing resource file $path", it.isFile) })

    private fun strings(path: String): Map<String, String> {
        val nodes = document(path).getElementsByTagName("string")
        val out = LinkedHashMap<String, String>()
        for (i in 0 until nodes.length) {
            val element = nodes.item(i) as Element
            out[element.getAttribute("name")] = element.textContent
        }
        return out
    }

    private fun plurals(path: String): Map<String, List<String>> {
        val nodes = document(path).getElementsByTagName("plurals")
        val out = LinkedHashMap<String, List<String>>()
        for (i in 0 until nodes.length) {
            val element = nodes.item(i) as Element
            val items = element.getElementsByTagName("item")
            out[element.getAttribute("name")] =
                (0 until items.length).map { (items.item(it) as Element).textContent }
        }
        return out
    }

    private fun placeholders(value: String): List<String> =
        Regex("%\\d+\\$[sd]").findAll(value).map { it.value }.sorted().toList()

    @Test
    fun `every inbox key exists in both maintained languages`() {
        val english = strings(en)
        val chinese = strings(zh)
        assertTrue("no inbox strings? parsing broke", english.isNotEmpty())
        assertEquals(
            "keys only in one language",
            emptySet<String>(),
            (english.keys - chinese.keys) + (chinese.keys - english.keys),
        )
    }

    /** A `%1$s` a translation forgot crashes at format time in exactly one
     *  language, which is the least testable way to find it. */
    @Test
    fun `every inbox placeholder set matches between the languages`() {
        val english = strings(en)
        val chinese = strings(zh)
        for ((key, value) in english) {
            assertEquals(
                "placeholders differ for $key",
                placeholders(value),
                placeholders(chinese.getValue(key)),
            )
        }
    }

    /**
     * Plurals exist in both languages with matching placeholders.
     *
     * The QUANTITY sets are deliberately not compared: Simplified Chinese has
     * only `other`, and requiring `one` there would be a wrong translation, not
     * a complete one.
     */
    @Test
    fun `every inbox plural exists in both languages`() {
        val english = plurals(en)
        val chinese = plurals(zh)
        assertEquals(english.keys, chinese.keys)
        for ((key, items) in english) {
            assertTrue("empty plural $key", items.isNotEmpty())
            assertTrue("empty plural $key", chinese.getValue(key).isNotEmpty())
            assertEquals(
                "plural placeholders differ for $key",
                placeholders(items.first()),
                placeholders(chinese.getValue(key).first()),
            )
        }
    }

    /**
     * Every `inbox_` resource the screen reads has copy.
     *
     * Read from the screen's own source, so a control added without a string
     * cannot ship: the failure it would otherwise produce is a crash when that
     * branch first composes.
     */
    @Test
    fun `every inbox resource the screen reads exists`() {
        val screen = File("src/main/kotlin/com/relayium/android/ui/InboxScreen.kt").readText()
        val english = strings(en).keys
        val englishPlurals = plurals(en).keys

        val readStrings = Regex("R\\.string\\.(inbox_[a-z_]+)").findAll(screen)
            .map { it.groupValues[1] }.toSet()
        val readPlurals = Regex("R\\.plurals\\.(inbox_[a-z_]+)").findAll(screen)
            .map { it.groupValues[1] }.toSet()
        assertTrue("the screen reads no inbox strings? parsing broke", readStrings.isNotEmpty())

        assertEquals("strings with no copy", emptySet<String>(), readStrings - english)
        assertEquals("plurals with no copy", emptySet<String>(), readPlurals - englishPlurals)
    }

    /**
     * And nothing here is dead copy.
     *
     * An unused string is not merely clutter: `lint` fails the build on it, and
     * finding that out at `lintRelease` rather than here wastes a whole gate.
     */
    @Test
    fun `every inbox resource is used by the screen`() {
        val screen = File("src/main/kotlin/com/relayium/android/ui/InboxScreen.kt").readText()
        val unusedStrings = strings(en).keys.filterNot { screen.contains("R.string.$it") }
        val unusedPlurals = plurals(en).keys.filterNot { screen.contains("R.plurals.$it") }
        assertEquals("unused inbox strings", emptyList<String>(), unusedStrings)
        assertEquals("unused inbox plurals", emptyList<String>(), unusedPlurals)
    }
}
