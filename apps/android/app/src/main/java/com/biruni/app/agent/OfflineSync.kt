package com.biruni.app.agent

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * The only network code for the offline agent (the role sync_online.py had): run it while there's
 * signal to save a city's places and forecast. Free, keyless services:
 *   Nominatim (geocode), Overpass (places), Open-Meteo (forecast).
 * They have fair-use limits, so one sync per city is the expected use.
 */
class OfflineSync(private val db: TripDb) {
    private val OVERPASS = listOf("https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter")
    private val ua = "BiruniNative/0.1 (travel safety app; offline cache)"

    data class Result(val city: String, val places: Int, val weatherDays: Int)

    suspend fun syncCity(name: String): Result = withContext(Dispatchers.IO) {
        val geo = JSONArray(get("https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=in&q=${enc(name)}"))
        if (geo.length() == 0) throw IllegalArgumentException("Couldn't find \"$name\" in India")
        val g = geo.getJSONObject(0)
        val lat = g.getString("lat").toDouble()
        val lon = g.getString("lon").toDouble()
        val city = g.optString("name").ifBlank { name }

        val places = pois(lat, lon)
        db.putCache("pois", city, places.toString())
        if (!city.equals(name.trim(), ignoreCase = true)) db.putCache("pois", name, places.toString())

        val weather = forecast(lat, lon)
        db.putCache("weather", city, weather.toString())
        if (!city.equals(name.trim(), ignoreCase = true)) db.putCache("weather", name, weather.toString())

        db.insert("sync_log", mapOf("synced_at" to System.currentTimeMillis(), "source" to "osm+open-meteo", "summary" to "$city: ${places.length()} places, ${weather.length()} days"))
        Result(city, places.length(), weather.length())
    }

    private fun pois(lat: Double, lon: Double): JSONArray {
        val q = """
            [out:json][timeout:25];
            (
              node["amenity"~"^(restaurant|cafe|atm|bank|hospital|clinic|pharmacy|police|fuel|bus_station|toilets)$"](around:4000,$lat,$lon);
              node["tourism"~"^(attraction|viewpoint|museum|hotel|guest_house|hostel)$"](around:4000,$lat,$lon);
              node["railway"="station"](around:6000,$lat,$lon);
            );
            out body 400;
        """.trimIndent()
        var body: String? = null
        var last: Exception? = null
        for (ep in OVERPASS) {
            try { body = post(ep, "data=${enc(q)}"); break } catch (e: Exception) { last = e }
        }
        val els = JSONObject(body ?: throw last ?: IllegalStateException("Overpass unavailable")).optJSONArray("elements") ?: JSONArray()
        val out = JSONArray()
        for (i in 0 until els.length()) {
            val e = els.getJSONObject(i)
            val tags = e.optJSONObject("tags") ?: continue
            val nm = tags.optString("name").ifBlank { tags.optString("name:en") }
            if (nm.isBlank()) continue
            val cat = tags.optString("amenity").ifBlank { tags.optString("tourism").ifBlank { if (tags.has("railway")) "railway_station" else "place" } }
            val o = JSONObject().put("name", nm).put("category", cat).put("lat", e.optDouble("lat")).put("lon", e.optDouble("lon"))
            tags.optString("phone").takeIf { it.isNotBlank() }?.let { o.put("phone", it) }
            tags.optString("opening_hours").takeIf { it.isNotBlank() }?.let { o.put("hours", it) }
            if (tags.optString("diet:vegetarian") in setOf("yes", "only")) o.put("vegetarian", true)
            out.put(o)
        }
        return out
    }

    private fun forecast(lat: Double, lon: Double): JSONArray {
        val j = JSONObject(get("https://api.open-meteo.com/v1/forecast?latitude=$lat&longitude=$lon&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FKolkata&forecast_days=7"))
        val d = j.getJSONObject("daily")
        val out = JSONArray()
        val days = d.getJSONArray("time")
        for (i in 0 until days.length()) {
            out.put(
                JSONObject().put("date", days.getString(i))
                    .put("summary", wmo(d.getJSONArray("weather_code").optInt(i)))
                    .put("max_c", d.getJSONArray("temperature_2m_max").optDouble(i))
                    .put("min_c", d.getJSONArray("temperature_2m_min").optDouble(i))
                    .put("rain_chance_pct", d.getJSONArray("precipitation_probability_max").optInt(i)),
            )
        }
        return out
    }

    // WMO weather interpretation codes (as documented by Open-Meteo).
    private fun wmo(c: Int) = when (c) {
        0 -> "clear"; 1, 2 -> "partly cloudy"; 3 -> "overcast"; 45, 48 -> "fog"
        in 51..57 -> "drizzle"; in 61..67 -> "rain"; in 71..77 -> "snow"; in 80..82 -> "rain showers"
        85, 86 -> "snow showers"; in 95..99 -> "thunderstorm"; else -> "code $c"
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    private fun get(url: String) = request(url, null)
    private fun post(url: String, form: String) = request(url, form)

    private fun request(url: String, form: String?): String {
        val c = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 40_000
            setRequestProperty("User-Agent", ua)
            if (form != null) {
                requestMethod = "POST"
                doOutput = true
                setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
                outputStream.use { it.write(form.toByteArray()) }
            }
        }
        val code = c.responseCode
        if (code !in 200..299) throw IllegalStateException("${URL(url).host} answered HTTP $code")
        return c.inputStream.bufferedReader().use { it.readText() }
    }
}
