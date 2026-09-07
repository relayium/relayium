package com.relayium.android

import android.app.Application

/**
 * Nothing global to set up, and that is deliberate: no analytics, no crash
 * reporter, no Play Services initialiser, no background worker. The class exists
 * so the manifest names something concrete rather than the framework default,
 * and so a future initialiser has one obvious home.
 */
class RelayiumApplication : Application()
