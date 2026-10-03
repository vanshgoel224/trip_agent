package com.biruni.app.agent

import org.json.JSONArray
import org.json.JSONObject

/**
 * The offline agent's tools: a Kotlin port of apps/phone-offline/tools.py. All local (SQLite);
 * the only network code is OfflineSync, which fills the cache while there's signal.
 * Descriptions are kept short: every token here is re-read by a small on-phone model.
 */
class TripTools(private val db: TripDb) {

    private fun fn(name: String, description: String, props: Map<String, Pair<String, String>> = emptyMap(), required: List<String> = emptyList()) =
        JSONObject().put("type", "function").put(
            "function",
            JSONObject().put("name", name).put("description", description).put(
                "parameters",
                JSONObject().put("type", "object")
                    .put("properties", JSONObject().apply { props.forEach { (k, v) -> put(k, JSONObject().put("type", v.first).put("description", v.second)) } })
                    .put("required", JSONArray(required)),
            ),
        )

    private val S = "string"
    private val I = "integer"
    private val N = "number"

    val schema: JSONArray = JSONArray(
        listOf(
            fn("get_itinerary", "List the trip plan, optionally one day.", mapOf("day" to (I to "Trip day number"))),
            fn("add_itinerary_item", "Add an activity to a trip day.", mapOf("day" to (I to "Trip day"), "activity" to (S to "What"), "time_slot" to (S to "e.g. 09:00 or morning"), "location" to (S to "Where"), "cost_est" to (N to "Estimated cost in rupees"), "notes" to (S to "Notes")), listOf("day", "activity")),
            fn("update_itinerary_item", "Change an item: reschedule, cancel (status=cancelled), mark done.", mapOf("item_id" to (I to "Item id"), "status" to (S to "planned/done/cancelled/skipped"), "activity" to (S to "New activity"), "time_slot" to (S to "New time"), "notes" to (S to "Notes")), listOf("item_id")),
            fn("remove_itinerary_item", "Delete an itinerary item.", mapOf("item_id" to (I to "Item id")), listOf("item_id")),
            fn("set_budget", "Set a budget for a category (transport, stay, food, misc).", mapOf("category" to (S to "Category"), "amount" to (N to "Rupees"), "label" to (S to "Label")), listOf("category", "amount")),
            fn("log_expense", "Record money spent.", mapOf("category" to (S to "Category"), "amount" to (N to "Rupees"), "label" to (S to "What it was")), listOf("category", "amount")),
            fn("get_budget_summary", "Budgeted vs spent per category and what's left."),
            fn("add_contact", "Save a contact (driver, host, hotel, emergency).", mapOf("name" to (S to "Name"), "role" to (S to "driver/hotel/host/emergency/other"), "phone" to (S to "Phone"), "location" to (S to "City/area"), "notes" to (S to "Notes")), listOf("name", "role")),
            fn("get_contacts", "List saved contacts, optionally for one place.", mapOf("location" to (S to "City/area"))),
            fn("lookup_cached_pois", "Places near a synced city from the offline cache (restaurant, atm, hospital, pharmacy, police, fuel, attraction...). May be stale.", mapOf("location" to (S to "Synced city"), "category" to (S to "Optional category")), listOf("location")),
            fn("lookup_cached_weather", "Cached 7-day forecast for a synced city. May be stale.", mapOf("location" to (S to "Synced city")), listOf("location")),
            fn("lookup_cached_transit", "Saved transport options between two places (last-known, not live).", mapOf("origin" to (S to "From"), "destination" to (S to "To")), listOf("origin", "destination")),
            fn("add_transit_option", "Save a known transport option (bus/train timing, fare) for offline use.", mapOf("origin" to (S to "From"), "destination" to (S to "To"), "mode" to (S to "bus/train/taxi/shared jeep..."), "depart" to (S to "Departure time"), "fare" to (N to "Rupees"), "notes" to (S to "Operator, stand, etc.")), listOf("origin", "destination", "mode")),
            fn("get_cache_freshness", "How old the offline cache is. Check before relying on cached data."),
            fn("generate_contingency", "Log a re-plan: what broke, the old plan and the new plan you chose.", mapOf("trigger_event" to (S to "What happened"), "original_plan" to (S to "Old plan"), "alternate_plan" to (S to "New plan")), listOf("trigger_event", "original_plan", "alternate_plan")),
            fn("get_pending_discoveries", "Lesser-known places waiting for the traveller's yes/no.", mapOf("near_location" to (S to "Area"))),
            fn("approve_discovery", "Add a discovered place to the plan. Only after the traveller explicitly says yes.", mapOf("discovery_id" to (I to "Id"), "day" to (I to "Trip day"), "time_slot" to (S to "Time")), listOf("discovery_id", "day")),
            fn("reject_discovery", "Traveller said no to a discovered place.", mapOf("discovery_id" to (I to "Id")), listOf("discovery_id")),
        ),
    )

    private val now get() = System.currentTimeMillis()

    /** Runs one tool. Errors come back as {"error": ...} so the model can recover. */
    fun execute(name: String, a: JSONObject, lastUserText: String): JSONObject = try {
        run(name, a, lastUserText)
    } catch (e: Exception) {
        JSONObject().put("error", e.message ?: e.javaClass.simpleName)
    }

    private fun JSONObject.str(k: String) = optString(k, "").takeIf { has(k) && !isNull(k) }
    private fun JSONObject.req(k: String) = str(k)?.takeIf { it.isNotBlank() } ?: throw IllegalArgumentException("missing $k")
    private fun JSONObject.num(k: String): Double? = if (has(k) && !isNull(k)) optString(k).replace(",", "").replace("₹", "").trim().toDoubleOrNull() else null
    private fun JSONObject.int(k: String): Long? = num(k)?.toLong()

    private fun run(name: String, a: JSONObject, lastUserText: String): JSONObject = when (name) {
        "get_itinerary" -> JSONObject().put(
            "itinerary",
            a.int("day")?.let { db.query("SELECT * FROM itinerary WHERE day=? ORDER BY time_slot", it) }
                ?: db.query("SELECT * FROM itinerary ORDER BY day, time_slot"),
        )
        "add_itinerary_item" -> {
            val id = db.insert("itinerary", mapOf("day" to (a.int("day") ?: throw IllegalArgumentException("missing day")), "activity" to a.req("activity"), "time_slot" to a.str("time_slot"), "location" to a.str("location"), "cost_est" to (a.num("cost_est") ?: 0.0), "notes" to a.str("notes"), "created_at" to now, "updated_at" to now))
            JSONObject().put("status", "added").put("id", id)
        }
        "update_itinerary_item" -> {
            val id = a.int("item_id") ?: throw IllegalArgumentException("missing item_id")
            val v = linkedMapOf<String, Any?>()
            for (k in listOf("status", "activity", "time_slot", "notes")) a.str(k)?.let { v[k] = it }
            if (v.isEmpty()) JSONObject().put("status", "no_change")
            else {
                v["updated_at"] = now
                if (db.update("itinerary", id, v) == 0) JSONObject().put("error", "no item $id") else JSONObject().put("status", "updated").put("id", id)
            }
        }
        "remove_itinerary_item" -> {
            val id = a.int("item_id") ?: throw IllegalArgumentException("missing item_id")
            if (db.delete("itinerary", id) == 0) JSONObject().put("error", "no item $id") else JSONObject().put("status", "deleted").put("id", id)
        }
        "set_budget", "log_expense" -> {
            val amt = a.num("amount") ?: throw IllegalArgumentException("missing amount")
            if (amt <= 0 || amt > 10_000_000) throw IllegalArgumentException("amount must be between ₹1 and ₹1 crore")
            db.insert("budget", mapOf("category" to a.req("category").lowercase(), "label" to a.str("label"), "amount" to amt, "kind" to if (name == "set_budget") "budgeted" else "spent", "created_at" to now))
            JSONObject().put("status", if (name == "set_budget") "set" else "logged")
        }
        "get_budget_summary" -> budgetSummary()
        "add_contact" -> {
            val id = db.insert("contacts", mapOf("name" to a.req("name"), "role" to a.req("role").lowercase(), "phone" to a.str("phone"), "location" to a.str("location"), "notes" to a.str("notes")))
            JSONObject().put("status", "added").put("id", id)
        }
        "get_contacts" -> JSONObject().put(
            "contacts",
            a.str("location")?.takeIf { it.isNotBlank() }?.let { db.query("SELECT * FROM contacts WHERE location LIKE ?", "%$it%") } ?: db.query("SELECT * FROM contacts"),
        )
        "lookup_cached_pois" -> {
            val (json, at) = cached("pois", a.req("location")) ?: return notSynced(a.req("location"))
            val cat = a.str("category")?.lowercase()?.takeIf { it.isNotBlank() }
            val all = JSONArray(json)
            val hits = JSONArray()
            for (i in 0 until all.length()) {
                val p = all.getJSONObject(i)
                if (cat == null || p.optString("category").lowercase().contains(cat) || Guards.editDistance(p.optString("category").lowercase(), cat) <= 1) hits.put(p)
                if (hits.length() >= 15) break
            }
            JSONObject().put("results", hits).put("cache_age_hours", ageHours(at)).put("note", "offline cache, may be stale")
        }
        "lookup_cached_weather" -> {
            val (json, at) = cached("weather", a.req("location")) ?: return notSynced(a.req("location"))
            JSONObject().put("forecast", JSONArray(json)).put("cache_age_hours", ageHours(at)).put("note", "forecast as of last sync")
        }
        "lookup_cached_transit" -> {
            val key = "${a.req("origin").lowercase().trim()}->${a.req("destination").lowercase().trim()}"
            val c = db.getCache("transit", key)
            JSONObject().put("options", c?.let { JSONArray(it.first) } ?: JSONArray()).put("note", "last-known, saved by the traveller; verify when online")
        }
        "add_transit_option" -> {
            val key = "${a.req("origin").lowercase().trim()}->${a.req("destination").lowercase().trim()}"
            val list = db.getCache("transit", key)?.let { JSONArray(it.first) } ?: JSONArray()
            list.put(JSONObject().put("mode", a.req("mode")).put("depart", a.str("depart")).put("fare", a.num("fare")).put("notes", a.str("notes")))
            db.putCache("transit", key, list.toString())
            JSONObject().put("status", "saved").put("options_for_route", list.length())
        }
        "get_cache_freshness" -> {
            val last = db.query("SELECT * FROM sync_log ORDER BY synced_at DESC LIMIT 1")
            if (last.length() == 0) JSONObject().put("synced", false).put("message", "Never synced. Use 'Save city for offline' while you have signal.")
            else JSONObject().put("synced", true).put("last_sync_hours_ago", ageHours(last.getJSONObject(0).getLong("synced_at")))
                .put("cities", JSONArray(db.cachedPlaces("pois")))
        }
        "generate_contingency" -> {
            db.insert("contingencies", mapOf("trigger_event" to a.req("trigger_event"), "original_plan" to a.req("original_plan"), "alternate_plan" to a.req("alternate_plan"), "created_at" to now))
            JSONObject().put("status", "logged")
        }
        "get_pending_discoveries" -> JSONObject().put(
            "pending",
            a.str("near_location")?.takeIf { it.isNotBlank() }?.let { db.query("SELECT * FROM discovered_places WHERE status='pending' AND near_location LIKE ?", "%$it%") }
                ?: db.query("SELECT * FROM discovered_places WHERE status='pending'"),
        )
        "approve_discovery" -> {
            // Consent guard: the model can't add a place on its own.
            if (!Guards.explicitYes(lastUserText)) JSONObject().put("error", "Not added: the traveller's latest message is not an explicit yes. Ask them first.")
            else {
                val id = a.int("discovery_id") ?: throw IllegalArgumentException("missing discovery_id")
                val rows = db.query("SELECT * FROM discovered_places WHERE id=?", id)
                if (rows.length() == 0) JSONObject().put("error", "not found")
                else {
                    val r = rows.getJSONObject(0)
                    db.update("discovered_places", id, mapOf("status" to "approved"))
                    db.insert("itinerary", mapOf("day" to (a.int("day") ?: 1L), "activity" to r.getString("name"), "time_slot" to a.str("time_slot"), "location" to r.optString("near_location"), "cost_est" to 0.0, "notes" to "discovered via ${r.optString("source")}: ${r.optString("description")}", "created_at" to now, "updated_at" to now))
                    JSONObject().put("status", "approved_and_added")
                }
            }
        }
        "reject_discovery" -> {
            val id = a.int("discovery_id") ?: throw IllegalArgumentException("missing discovery_id")
            db.update("discovered_places", id, mapOf("status" to "rejected"))
            JSONObject().put("status", "rejected")
        }
        else -> JSONObject().put("error", "unknown tool $name")
    }

    fun budgetSummary(): JSONObject {
        val rows = db.query("SELECT category, kind, SUM(amount) AS total FROM budget GROUP BY category, kind")
        val by = JSONObject()
        var budgeted = 0.0
        var spent = 0.0
        for (i in 0 until rows.length()) {
            val r = rows.getJSONObject(i)
            val cat = by.optJSONObject(r.getString("category")) ?: JSONObject().put("budgeted", 0.0).put("spent", 0.0).also { by.put(r.getString("category"), it) }
            val t = r.getDouble("total")
            cat.put(r.getString("kind"), t)
            if (r.getString("kind") == "budgeted") budgeted += t else spent += t
        }
        return JSONObject().put("by_category", by).put("total_budgeted", budgeted).put("total_spent", spent).put("remaining", budgeted - spent)
    }

    /** Exact city name first, then a typo-tolerant match against synced cities. */
    private fun cached(kind: String, place: String): Pair<String, Long>? {
        db.getCache(kind, place)?.let { return it }
        val p = place.lowercase().trim()
        val best = db.cachedPlaces(kind).minByOrNull { Guards.editDistance(it, p) } ?: return null
        return if (Guards.editDistance(best, p) <= 2 || best.startsWith(p) || p.startsWith(best)) db.getCache(kind, best) else null
    }

    private fun notSynced(place: String) = JSONObject()
        .put("results", JSONArray())
        .put("note", "$place is not saved for offline. Synced cities: ${db.cachedPlaces("pois").joinToString().ifEmpty { "none" }}")

    private fun ageHours(at: Long) = Math.round((now - at) / 360_000.0) / 10.0
}
