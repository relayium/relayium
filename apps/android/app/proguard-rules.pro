# Minification is off for this stage, so this file exists to keep the release
# build's configuration explicit rather than implicit. The WebRTC AAR reaches
# its native layer through JNI names, so if minification is ever enabled these
# have to survive it.
-keep class org.webrtc.** { *; }
-keepclasseswithmembernames class * { native <methods>; }
