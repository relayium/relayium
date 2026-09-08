package com.relayium.android.cloud

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/**
 * Plural coverage across the two maintained languages.
 *
 * `AppStringsParityTest` walks `<string>` elements, so a count rendered through
 * `<plurals>` is outside it — and a plural that exists in one language and not
 * the other throws at format time in exactly one locale. Simplified Chinese has
 * no plural distinction, so `other` alone is the COMPLETE form there rather than
 * a missing translation; what has to match is the set of names and the
 * placeholders each one uses.
 */
class CloudPluralsParityTest {

    private fun plurals(path: String): Map<String, List<String>> {
        val file = File(path)
        assertTrue("missing resource file $path", file.isFile)
        val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file)
        val nodes = doc.getElementsByTagName("plurals")
        val out = LinkedHashMap<String, List<String>>()
        for (i in 0 until nodes.length) {
            val element = nodes.item(i) as Element
            val items = element.getElementsByTagName("item")
            val forms = ArrayList<String>(items.length)
            for (j in 0 until items.length) forms.add((items.item(j) as Element).textContent)
            out[element.getAttribute("name")] = forms
        }
        return out
    }

    private fun placeholders(value: String): List<String> =
        Regex("%\\d+\\$[sd]").findAll(value).map { it.value }.sorted().toList()

    @Test
    fun `every plural exists in both maintained languages`() {
        val en = plurals("src/main/res/values/strings.xml")
        val zh = plurals("src/main/res/values-zh-rCN/strings.xml")
        assertEquals(
            "plurals only in one language",
            emptySet<String>(),
            (en.keys - zh.keys) + (zh.keys - en.keys),
        )
        assertTrue("this suite must actually cover something", en.isNotEmpty())
    }

    @Test
    fun `every plural form uses the same placeholders in both languages`() {
        val en = plurals("src/main/res/values/strings.xml")
        val zh = plurals("src/main/res/values-zh-rCN/strings.xml")
        for ((name, forms) in en) {
            val expected = placeholders(forms.first())
            for (form in forms) {
                assertEquals("placeholders differ between forms of $name", expected, placeholders(form))
            }
            for (form in zh.getValue(name)) {
                assertEquals("placeholders differ for $name in zh-rCN", expected, placeholders(form))
            }
        }
    }

    @Test
    fun `an every-quantity language declares the forms it needs`() {
        // A missing `one` in English is a real defect: Android would fall back
        // to `other` and render "1 files".
        val en = plurals("src/main/res/values/strings.xml")
        val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder()
            .parse(File("src/main/res/values/strings.xml"))
        val nodes = doc.getElementsByTagName("plurals")
        for (i in 0 until nodes.length) {
            val element = nodes.item(i) as Element
            val quantities = (0 until element.getElementsByTagName("item").length).map { j ->
                (element.getElementsByTagName("item").item(j) as Element).getAttribute("quantity")
            }
            assertTrue("${element.getAttribute("name")} needs a one form", "one" in quantities)
            assertTrue("${element.getAttribute("name")} needs an other form", "other" in quantities)
        }
        assertTrue(en.isNotEmpty())
    }
}
