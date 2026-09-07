package com.relayium.android

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/**
 * English and Simplified Chinese are the two maintained product languages, and
 * their coverage is a delivery requirement, not a convention: every key in the
 * source locale exists in zh-rCN and vice versa, and every placeholder set
 * matches — a `%1$s` the translation forgot would crash at format time in
 * exactly one language.
 */
class AppStringsParityTest {

    private fun strings(path: String): Map<String, String> {
        val file = File(path)
        assertTrue("missing resource file $path", file.isFile)
        val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file)
        val nodes = doc.getElementsByTagName("string")
        val out = LinkedHashMap<String, String>()
        for (i in 0 until nodes.length) {
            val element = nodes.item(i) as Element
            out[element.getAttribute("name")] = element.textContent
        }
        return out
    }

    private fun placeholders(value: String): List<String> =
        Regex("%\\d+\\$[sd]").findAll(value).map { it.value }.sorted().toList()

    @Test
    fun `every key exists in both maintained languages`() {
        val en = strings("src/main/res/values/strings.xml")
        val zh = strings("src/main/res/values-zh-rCN/strings.xml")
        assertEquals(
            "keys only in one language",
            emptySet<String>(),
            (en.keys - zh.keys) + (zh.keys - en.keys),
        )
    }

    @Test
    fun `every placeholder set matches between the languages`() {
        val en = strings("src/main/res/values/strings.xml")
        val zh = strings("src/main/res/values-zh-rCN/strings.xml")
        for ((key, value) in en) {
            assertEquals(
                "placeholders differ for $key",
                placeholders(value),
                placeholders(zh.getValue(key)),
            )
        }
    }

    /** Every `error_*` key the controller can emit has copy in the app. The
     *  list is the controller's, read from its source, so a new key cannot
     *  ship silently unlocalised. */
    @Test
    fun `every controller error key has localised copy`() {
        val en = strings("src/main/res/values/strings.xml")
        val controller = File("src/main/kotlin/com/relayium/android/TransferController.kt").readText()
        val emitted = Regex("\"(error_[a-z_]+)\"").findAll(controller).map { it.groupValues[1] }.toSet()
        assertTrue("controller emits no keys? parsing broke", emitted.isNotEmpty())
        val missing = emitted.filterNot { en.containsKey(it) }
        assertEquals("controller error keys with no copy: $missing", emptyList<String>(), missing)
    }
}
