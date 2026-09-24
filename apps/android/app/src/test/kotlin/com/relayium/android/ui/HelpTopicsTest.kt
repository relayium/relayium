package com.relayium.android.ui

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/**
 * The help layer's table (A31 b): every destination has a complete topic, and a
 * guide link exists only where a real guide page exists in BOTH maintained
 * languages under `web/public`.
 */
class HelpTopicsTest {

    @Test
    fun `every destination has a complete topic with three steps and no shared copy`() {
        for (destination in Destination.entries) {
            val topic = HelpTopics.topic(destination)
            assertEquals("$destination has three steps", 3, topic.steps.size)
            val all = listOf(topic.purpose, topic.boundary, topic.where, topic.failure, topic.recovery) +
                topic.steps
            assertTrue("$destination: every field is its own string", all.toSet().size == all.size)
        }
        val purposes = Destination.entries.map { HelpTopics.topic(it).purpose }
        assertEquals("no two destinations share a purpose", purposes.size, purposes.toSet().size)
    }

    @Test
    fun `exactly the destinations with a real guide link one, and nothing else does`() {
        assertNull(HelpTopics.topic(Destination.INBOX).guideSlug)
        assertNull(HelpTopics.topic(Destination.ACCOUNT).guideSlug)
        val web = File("../../../web/public")
        assertTrue("the web tree is part of this checkout", web.isDirectory)
        for (destination in Destination.entries) {
            val slug = HelpTopics.topic(destination).guideSlug ?: continue
            for (dir in listOf("guides", "zh/guides")) {
                assertTrue(
                    "$destination links $dir/$slug, which must exist",
                    File(web, "$dir/$slug/index.html").isFile,
                )
            }
        }
    }

    @Test
    fun `a guide opens on the app's own origin, in the language the app shows`() {
        assertEquals(
            "https://relayium.com/guides/what-is-peer-to-peer-file-transfer",
            HelpTopics.guideUrl("https://relayium.com", "what-is-peer-to-peer-file-transfer", "en"),
        )
        assertEquals(
            "https://relayium.com/zh/guides/what-is-peer-to-peer-file-transfer",
            HelpTopics.guideUrl("https://relayium.com/", "what-is-peer-to-peer-file-transfer", "zh"),
        )
        assertEquals(
            "a debug build's own backend, never another host",
            "http://10.0.2.2:8080/guides/x",
            HelpTopics.guideUrl("http://10.0.2.2:8080", "x", "en"),
        )
    }

    /** The resource the card reads to choose the language must say what each
     *  locale's copy is written in. */
    @Test
    fun `each locale's copy names its own guide language`() {
        fun value(dir: String): String {
            val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder()
                .parse(File("src/main/res/$dir/help.xml"))
            val nodes = doc.getElementsByTagName("string")
            for (i in 0 until nodes.length) {
                val element = nodes.item(i) as Element
                if (element.getAttribute("name") == "help_guide_language") return element.textContent
            }
            error("help_guide_language missing in $dir")
        }
        assertEquals("en", value("values"))
        assertEquals("zh", value("values-zh-rCN"))
    }
}
