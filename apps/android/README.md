# Biruni native Android app

Kotlin + Jetpack Compose, with **llama.cpp running on the phone through JNI**. It replaces the Termux/CLI
route in `apps/phone-offline` with a proper app.

## What it does

| Tab | |
|---|---|
| **Chat** | An on-device agent (no internet) that plans your trip, tracks the budget, keeps contacts and re-plans when something breaks. It calls real tools, so changes land in the Plan tab. With a Biruni server linked, a switch sends the chat to the full server agent instead. |
| **Plan** | Itinerary and budget. **Save a city for offline** stores nearby ATMs, hospitals, police, food, sights and a 7-day forecast (OpenStreetMap + Open-Meteo, no keys). |
| **Safety** | SOS button; emergency numbers; **drop & crash watch** that runs with the screen off. |
| **Model** | Download Qwen 2.5 (0.5B / 1.5B / 3B, Q4_K_M) with resume, or import any `.gguf`. |
| **More** | Link your own Biruni server; legal notice. |

### The on-device agent

`llm/` wraps llama.cpp (`cpp/biruni_llama.cpp`, modelled on llama.cpp's own `examples/llama.android`).
The model's own chat template renders the conversation and tool list; llama.cpp's parser turns the output
into tool calls; `agent/LocalAgent.kt` runs them (`agent/TripTools.kt`, a port of `apps/phone-offline/tools.py`)
and loops until the model answers. The KV cache is reused for the shared prompt prefix, so each tool step
only processes the new tokens. Context is 4,096 tokens by default.

Guards that don't depend on the model (ported from the server): safety words (English, typo-tolerant, plus
Hindi/Hinglish) answer with 112 guidance **before** the model is asked; adding a discovered place needs an
explicit, unhedged yes in your latest message; the agent never pays or books anything.

### Drop watch (native)

`safety/DropWatchService.kt` is a foreground service, so the accelerometer keeps running with the screen
off, which a web app can't do. Same thresholds as the web detector (`safety/FallDetector.kt`).

1. Free fall then impact → full-screen alarm over the lock screen, vibration and alarm sound.
2. The fall is reported to your server (if linked), which runs its own countdown; the phone runs one too.
3. **Cancel:** tap *I'M OK*, shake 3 times, press any key on the alert, or tap *I'm OK* on another device.
4. At zero: SOS through the server (trip members, helpers) **and** SMS with a map link to your emergency numbers.
   With no server, the SMS still goes out. The countdown length is configurable (15–300 s, default 60).

Emergency numbers and the server PIN are encrypted with an Android Keystore key.

## Build

Needs JDK 17+, Android SDK 36, NDK 27.2.12479018, CMake 3.31.6.

```bash
git submodule update --init --depth 1        # llama.cpp, pinned
cd apps/android
echo "sdk.dir=$ANDROID_HOME" > local.properties
./gradlew :app:testDebugUnitTest             # 12 JVM tests (detector, guards, URL rules)
./gradlew :app:assembleDebug                 # app/build/outputs/apk/debug/app-debug.apk
```

arm64 only by default (all current phones). For the emulator: `-PbiruniAbis=arm64-v8a,x86_64`.
CI: `.github/workflows/android-native.yml` builds it and uploads `biruni-native-apk`.

## Honest limits

- **Verified on a PC, not a phone.** The same JNI file was compiled for x86 Linux and run against real Qwen 2.5 1.5B: chat template, streaming, tool-call parsing and prefix-cache reuse all worked (about 2.5 s for a short tool call on 4 CPU cores; a phone will differ). In that run the model once emitted malformed tool JSON, so the agent retries once and then asks you to rephrase. **Not run on a real phone:** It compiles and the pure logic is unit-tested, but I could not run the app, the
  model, the sensors or SMS on a device here. Expect first-run fixes. Speed numbers are not measured.
- **Small models are weak at tools.** Qwen 2.5 1.5B calls tools often but gets arguments wrong sometimes; the
  3B is better and slower. Check anything that matters.
- Drop thresholds are tuned on synthetic data. Test with a real (cheap) drop onto a bed before trusting it.
- Android may stop background services on aggressive battery managers (Xiaomi, Oppo, Vivo, Samsung "sleeping
  apps"): exempt Biruni from battery optimisation. Android 14+ may also require you to grant full-screen
  notifications and "Alarms & reminders" for the alert to wake the screen.
- The OpenStreetMap places query (Overpass) could not be exercised from my build sandbox; if the city sync
  fails, retry later (it tries three public mirrors, which are rate-limited).
- Debug-signed sideload build; no Play Store release. Hindi/other-language answers depend on the model.
- No voice input/output in this app yet.
