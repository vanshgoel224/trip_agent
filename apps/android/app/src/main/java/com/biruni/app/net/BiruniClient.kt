package com.biruni.app.net

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

class ApiException(val code: Int, message: String) : Exception(message)

/**
 * Talks to a Biruni server (apps/api) with the same cookie session the web app uses.
 * Endpoints: /api/lock/unlock|setup, /api/chats, /api/sos, /api/falls, /api/device/location.
 */
class BiruniClient(baseUrl: String) {
    val base: String = normalise(baseUrl)
    private var cookie: String? = null

    companion object {
        /** https:// anywhere; http:// only for localhost, private LAN and Tailscale (100.64/10). */
        fun normalise(raw: String): String {
            var u = raw.trim().trimEnd('/')
            if (u.isEmpty()) throw IllegalArgumentException("Enter your Biruni server address")
            if (!u.contains("://")) u = "https://$u"
            val uri = URI(u)
            val host = uri.host ?: throw IllegalArgumentException("Bad server address")
            if (uri.scheme == "http" && !isPrivateHost(host)) throw IllegalArgumentException("Use https:// (plain http is only allowed on your own network)")
            if (uri.scheme != "http" && uri.scheme != "https") throw IllegalArgumentException("Address must start with https://")
            return u
        }

        fun isPrivateHost(h: String): Boolean {
            if (h == "localhost" || h.endsWith(".local")) return true
            val p = h.split('.').mapNotNull { it.toIntOrNull() }
            if (p.size != 4) return false
            return p[0] == 10 || p[0] == 127 || (p[0] == 192 && p[1] == 168) || (p[0] == 172 && p[1] in 16..31) || (p[0] == 100 && p[1] in 64..127)
        }
    }

    val signedIn get() = cookie != null

    fun signIn(username: String, pin: String) = auth("/api/lock/unlock", username, pin)
    fun signUp(username: String, pin: String) = auth("/api/lock/setup", username, pin)
    fun signOut() { runCatching { call("POST", "/api/lock/lock", JSONObject()) }; cookie = null }

    private fun auth(path: String, username: String, pin: String): JSONObject = call("POST", path, JSONObject().put("username", username).put("pin", pin))

    fun chats(): JSONArray = call("GET", "/api/chats").optJSONArray("_array") ?: JSONArray()
    fun newChat(mode: String): JSONObject = call("POST", "/api/chats", JSONObject().put("mode", mode))
    fun send(chatId: String, text: String): JSONObject = call("POST", "/api/chats/$chatId/messages", JSONObject().put("text", text))
    fun sos(message: String, lat: Double?, lng: Double?, everyone: Boolean): JSONObject {
        val b = JSONObject().put("message", message).put("everyone", everyone)
        if (lat != null && lng != null) b.put("location", JSONObject().put("lat", lat).put("lng", lng))
        return call("POST", "/api/sos", b)
    }
    fun reportFall(f: JSONObject): JSONObject = call("POST", "/api/falls", f)
    fun cancelFall(id: String, by: String): JSONObject = call("POST", "/api/falls/$id/cancel", JSONObject().put("by", by))
    fun activeFall(): JSONObject = call("GET", "/api/falls/active")
    fun health(): JSONObject = call("GET", "/api/health")

    /** Returns parsed JSON (object, or array wrapped as {"_array": [...]}). */
    fun call(method: String, path: String, body: JSONObject? = null): JSONObject {
        val c = (URL(base + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 10_000
            readTimeout = 60_000
            setRequestProperty("Accept", "application/json")
            cookie?.let { setRequestProperty("Cookie", it) }
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                outputStream.use { it.write(body.toString().toByteArray()) }
            }
        }
        val code = c.responseCode
        c.headerFields["Set-Cookie"]?.firstOrNull { it.startsWith("biruni_session=") }?.substringBefore(';')?.let { cookie = it }
        val text = (if (code in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
        if (code !in 200..299) {
            val msg = runCatching { JSONObject(text).getJSONObject("error").getString("message") }.getOrNull() ?: "Server answered HTTP $code"
            if (code == 401) cookie = null
            throw ApiException(code, msg)
        }
        return when {
            text.isBlank() -> JSONObject()
            text.trimStart().startsWith("[") -> JSONObject().put("_array", JSONArray(text))
            else -> JSONObject(text)
        }
    }
}
