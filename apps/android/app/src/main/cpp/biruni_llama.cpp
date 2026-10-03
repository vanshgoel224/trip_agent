// JNI bridge between the Kotlin agent and llama.cpp (pinned submodule, tag b11366).
// Modelled on llama.cpp's own examples/llama.android/lib/src/main/cpp/ai_chat.cpp.
//
// Design:
// - Kotlin keeps the conversation (OpenAI-style JSON) and calls applyTemplate(), which uses the
//   model's own chat template (jinja) with the tool list, so tool calling works for any GGUF model
//   whose template supports tools (Qwen 2.5 does).
// - generate() reuses the KV cache for the longest common token prefix with the previous call.
//   In an agent loop each step only appends a tool result, so only the new tokens are processed.
// - parse() runs llama.cpp's chat parser for the format the template selected, returning an
//   OpenAI-style assistant message (content + tool_calls).
// All calls are serialised by the Kotlin side (one Mutex); nothing here is thread-safe.

#include <android/log.h>
#include <jni.h>
#include <unistd.h>

#include <algorithm>
#include <string>
#include <vector>

#include "chat.h"
#include "common.h"
#include "llama.h"
#include "sampling.h"

#define TAG "biruni-llama"
#define LOGi(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGe(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

namespace {

constexpr int BATCH_SIZE = 512;

llama_model *g_model = nullptr;
llama_context *g_ctx = nullptr;
common_batch g_batch;
common_chat_templates_ptr g_templates;
common_sampler *g_sampler = nullptr;
common_chat_params g_chat_params;          // from the last applyTemplate(), used by parse()
std::vector<llama_token> g_cached;         // tokens currently in the KV cache (seq 0)
int g_n_ctx = 0;

void log_cb(ggml_log_level level, const char *text, void *) {
    if (level >= GGML_LOG_LEVEL_ERROR) __android_log_print(ANDROID_LOG_ERROR, TAG, "%s", text);
    else if (level >= GGML_LOG_LEVEL_WARN) __android_log_print(ANDROID_LOG_WARN, TAG, "%s", text);
}

std::string jstr(JNIEnv *env, jstring s) {
    if (!s) return {};
    const char *c = env->GetStringUTFChars(s, nullptr);
    std::string out(c);
    env->ReleaseStringUTFChars(s, c);
    return out;
}

// NewStringUTF needs valid (modified) UTF-8; build the string from UTF-16 instead so that any
// emoji or Indic text survives the trip intact.
jstring to_jstring(JNIEnv *env, const std::string &s) {
    std::u16string u16;
    u16.reserve(s.size());
    size_t i = 0;
    while (i < s.size()) {
        unsigned char c = s[i];
        uint32_t cp;
        int n;
        if (c < 0x80) { cp = c; n = 1; }
        else if ((c >> 5) == 0x6) { cp = c & 0x1F; n = 2; }
        else if ((c >> 4) == 0xE) { cp = c & 0x0F; n = 3; }
        else if ((c >> 3) == 0x1E) { cp = c & 0x07; n = 4; }
        else { i++; continue; }
        if (i + n > s.size()) break;
        bool ok = true;
        for (int k = 1; k < n; k++) {
            unsigned char cc = s[i + k];
            if ((cc & 0xC0) != 0x80) { ok = false; break; }
            cp = (cp << 6) | (cc & 0x3F);
        }
        if (!ok) { i++; continue; }
        i += n;
        if (cp >= 0x10000) {
            cp -= 0x10000;
            u16.push_back(char16_t(0xD800 + (cp >> 10)));
            u16.push_back(char16_t(0xDC00 + (cp & 0x3FF)));
        } else {
            u16.push_back(char16_t(cp));
        }
    }
    return env->NewString(reinterpret_cast<const jchar *>(u16.data()), (jsize) u16.size());
}

// Length of the longest prefix of `s` that is complete UTF-8 (a token can end mid-character).
size_t utf8_complete_prefix(const std::string &s) {
    size_t i = s.size();
    int back = 0;
    while (i > 0 && back < 4) {
        unsigned char c = s[i - 1];
        if ((c & 0xC0) == 0x80) { i--; back++; continue; }
        int need = c < 0x80 ? 1 : (c >> 5) == 0x6 ? 2 : (c >> 4) == 0xE ? 3 : (c >> 3) == 0x1E ? 4 : 1;
        return (back + 1 >= need) ? s.size() : i - 1;
    }
    return s.size();
}

int decode_from(const std::vector<llama_token> &tokens, size_t start) {
    for (size_t i = start; i < tokens.size(); i += BATCH_SIZE) {
        const size_t n = std::min(tokens.size() - i, (size_t) BATCH_SIZE);
        g_batch.clear();
        for (size_t j = 0; j < n; j++) {
            const bool last = (i + j == tokens.size() - 1);
            g_batch.add(tokens[i + j], (llama_pos) (i + j), 0, last);
        }
        if (llama_process(g_ctx, LLAMA_PROCESS_TYPE_DECODE, g_batch.get()) != 0) return 1;
    }
    return 0;
}

void free_all() {
    if (g_sampler) { common_sampler_free(g_sampler); g_sampler = nullptr; }
    g_templates.reset();
    g_batch = common_batch();
    if (g_ctx) { llama_free(g_ctx); g_ctx = nullptr; }
    if (g_model) { llama_model_free(g_model); g_model = nullptr; }
    g_cached.clear();
}

}  // namespace

extern "C" JNIEXPORT void JNICALL
Java_com_biruni_app_llm_LlamaNative_init(JNIEnv *env, jobject, jstring nativeLibDir) {
    llama_log_set(log_cb, nullptr);
    const std::string dir = jstr(env, nativeLibDir);
    ggml_backend_load_all_from_path(dir.c_str());
    llama_backend_init();
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_biruni_app_llm_LlamaNative_systemInfo(JNIEnv *env, jobject) {
    return to_jstring(env, llama_print_system_info());
}

// Returns "" on success, otherwise an error message.
extern "C" JNIEXPORT jstring JNICALL
Java_com_biruni_app_llm_LlamaNative_load(JNIEnv *env, jobject, jstring jpath, jint nCtx, jint nThreads) {
    free_all();
    const std::string path = jstr(env, jpath);
    llama_model_params mp = llama_model_default_params();
    g_model = llama_model_load_from_file(path.c_str(), mp);
    if (!g_model) return to_jstring(env, "could not load model file (corrupt, incomplete or unsupported GGUF)");

    const int threads = nThreads > 0 ? nThreads
                                     : std::max(2, std::min(4, (int) sysconf(_SC_NPROCESSORS_ONLN) - 2));
    llama_context_params cp = llama_context_default_params();
    const int trained = llama_model_n_ctx_train(g_model);
    g_n_ctx = std::min((int) nCtx, trained > 0 ? trained : (int) nCtx);
    cp.n_ctx = g_n_ctx;
    cp.n_batch = BATCH_SIZE;
    cp.n_ubatch = BATCH_SIZE;
    cp.n_threads = threads;
    cp.n_threads_batch = threads;
    g_ctx = llama_init_from_model(g_model, cp);
    if (!g_ctx) { free_all(); return to_jstring(env, "not enough memory for the model context; try a smaller model"); }

    g_batch = common_batch(g_ctx);
    g_templates = common_chat_templates_init(g_model, "");
    common_params_sampling sp;
    sp.temp = 0.3f;  // low temperature: tool arguments must be exact
    g_sampler = common_sampler_init(g_model, sp);
    LOGi("loaded %s, n_ctx=%d, threads=%d", path.c_str(), g_n_ctx, threads);
    return to_jstring(env, "");
}

extern "C" JNIEXPORT jint JNICALL
Java_com_biruni_app_llm_LlamaNative_contextSize(JNIEnv *, jobject) { return g_n_ctx; }

// messagesJson / toolsJson are OpenAI-format arrays. Returns the prompt, or "\u0001error" on failure.
extern "C" JNIEXPORT jstring JNICALL
Java_com_biruni_app_llm_LlamaNative_applyTemplate(JNIEnv *env, jobject, jstring jmessages, jstring jtools) {
    if (!g_templates) return to_jstring(env, "\001model not loaded");
    try {
        common_chat_templates_inputs in;
        in.messages = common_chat_msgs_parse_oaicompat(common_json::parse(jstr(env, jmessages)));
        const std::string tools = jstr(env, jtools);
        if (!tools.empty() && tools != "[]") in.tools = common_chat_tools_parse_oaicompat(common_json::parse(tools));
        in.add_generation_prompt = true;
        in.use_jinja = true;
        in.enable_thinking = false;  // speed: no hidden reasoning on a phone CPU
        g_chat_params = common_chat_templates_apply(g_templates.get(), in);
        return to_jstring(env, g_chat_params.prompt);
    } catch (const std::exception &e) {
        return to_jstring(env, std::string("\001") + e.what());
    }
}

// Streams pieces to callback.onToken(String): Boolean (false = stop). Returns the raw output,
// or "\u0001error" on failure. "\u0001too_long" means the prompt does not fit the context.
extern "C" JNIEXPORT jstring JNICALL
Java_com_biruni_app_llm_LlamaNative_generate(JNIEnv *env, jobject, jstring jprompt, jint maxTokens, jobject callback) {
    if (!g_ctx) return to_jstring(env, "\001model not loaded");
    jclass cls = env->GetObjectClass(callback);
    jmethodID onToken = env->GetMethodID(cls, "onToken", "(Ljava/lang/String;)Z");
    if (!onToken) return to_jstring(env, "\001bad callback");

    const std::string prompt = jstr(env, jprompt);
    std::vector<llama_token> tokens = common_tokenize(g_ctx, prompt, true, true);
    if (tokens.empty()) return to_jstring(env, "\001empty prompt");
    if ((int) tokens.size() + maxTokens >= g_n_ctx) return to_jstring(env, "\001too_long");

    // Reuse the cached prefix; always re-decode at least the last prompt token for fresh logits.
    size_t keep = 0;
    while (keep < g_cached.size() && keep < tokens.size() && g_cached[keep] == tokens[keep]) keep++;
    if (keep == tokens.size()) keep--;
    llama_memory_t mem = llama_get_memory(g_ctx);
    if (!llama_memory_seq_rm(mem, 0, (llama_pos) keep, -1)) {
        llama_memory_clear(mem, false);
        keep = 0;
    }
    g_cached.resize(keep);
    if (decode_from(tokens, keep) != 0) {
        llama_memory_clear(mem, false);
        g_cached.clear();
        return to_jstring(env, "\001decode failed");
    }
    g_cached = tokens;

    common_sampler_reset(g_sampler);
    const llama_vocab *vocab = llama_model_get_vocab(g_model);
    std::string out, pending;
    bool stopped = false;
    for (int i = 0; i < maxTokens && !stopped; i++) {
        const llama_token id = common_sampler_sample(g_sampler, g_ctx, -1);
        common_sampler_accept(g_sampler, id, true);
        if (llama_vocab_is_eog(vocab, id)) break;

        pending += common_token_to_piece(g_ctx, id);
        const size_t ok = utf8_complete_prefix(pending);
        if (ok > 0) {
            const std::string piece = pending.substr(0, ok);
            pending.erase(0, ok);
            out += piece;
            jstring jp = to_jstring(env, piece);
            const jboolean go = env->CallBooleanMethod(callback, onToken, jp);
            env->DeleteLocalRef(jp);
            if (env->ExceptionCheck()) { env->ExceptionClear(); stopped = true; }
            if (!go) stopped = true;
        }
        for (const auto &stop : g_chat_params.additional_stops) {
            if (!stop.empty() && out.size() >= stop.size() && out.compare(out.size() - stop.size(), stop.size(), stop) == 0) {
                out.erase(out.size() - stop.size());
                stopped = true;
            }
        }
        if (stopped) break;
        g_batch.clear();
        g_batch.add(id, (llama_pos) g_cached.size(), 0, true);
        if (llama_process(g_ctx, LLAMA_PROCESS_TYPE_DECODE, g_batch.get()) != 0) {
            LOGe("decode failed during generation");
            break;
        }
        g_cached.push_back(id);
        if ((int) g_cached.size() >= g_n_ctx - 1) break;
    }
    return to_jstring(env, out + pending);
}

// Parses raw model output with the parser chosen by the last applyTemplate(). Returns an
// OpenAI-style message JSON, or "\u0001error".
extern "C" JNIEXPORT jstring JNICALL
Java_com_biruni_app_llm_LlamaNative_parse(JNIEnv *env, jobject, jstring jraw) {
    try {
        common_chat_parser_params pp(g_chat_params);
        if (!g_chat_params.parser.empty()) pp.parser.load(g_chat_params.parser);
        pp.parse_tool_calls = true;
        const common_chat_msg msg = common_chat_parse(jstr(env, jraw), false, pp);
        return to_jstring(env, msg.to_json_oaicompat().dump());
    } catch (const std::exception &e) {
        return to_jstring(env, std::string("\001") + e.what());
    }
}

extern "C" JNIEXPORT void JNICALL
Java_com_biruni_app_llm_LlamaNative_unload(JNIEnv *, jobject) { free_all(); }
