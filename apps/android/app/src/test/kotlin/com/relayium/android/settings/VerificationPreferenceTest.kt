package com.relayium.android.settings

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The "absent = off" rule Apple and the website follow (A31 a). */
class VerificationPreferenceTest {

    private class MapStore(var refuse: Boolean = false) : VerificationPreference.Store {
        val keys = HashSet<String>()
        override fun isSet(key: String) = key in keys
        override fun set(key: String) {
            if (refuse) error("refused")
            keys += key
        }
        override fun remove(key: String) {
            if (refuse) error("refused")
            keys -= key
        }
    }

    @Test
    fun `an absent key is off, and off is the default`() {
        val pref = VerificationPreference(MapStore())
        assertFalse(pref.enabled.value)
        assertFalse(pref.current())
    }

    @Test
    fun `on is stored as the key, and off removes it rather than writing false`() {
        val store = MapStore()
        val pref = VerificationPreference(store)
        pref.setEnabled(true)
        assertTrue(pref.current())
        assertEquals(setOf(VerificationPreference.KEY), store.keys)
        pref.setEnabled(false)
        assertFalse(pref.current())
        assertTrue("one representation of off: nothing stored", store.keys.isEmpty())
        assertTrue("a fresh read agrees", !VerificationPreference(store).current())
    }

    @Test
    fun `a stored key survives into the next launch`() {
        val store = MapStore().apply { keys += VerificationPreference.KEY }
        assertTrue(VerificationPreference(store).current())
    }

    @Test
    fun `a write the store refused is not shown as on`() {
        val store = MapStore(refuse = true)
        val pref = VerificationPreference(store)
        pref.setEnabled(true)
        assertFalse(pref.current())
    }
}
