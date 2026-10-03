package com.biruni.app.agent

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject

/**
 * On-phone trip store, same tables as apps/phone-offline/db.py plus a cache table that replaces
 * the cached_data JSON files. Lives in app-private storage; no network here.
 */
class TripDb(ctx: Context) : SQLiteOpenHelper(ctx, "trip.db", null, 1) {
    override fun onCreate(db: SQLiteDatabase) {
        listOf(
            """CREATE TABLE itinerary (id INTEGER PRIMARY KEY AUTOINCREMENT, day INTEGER NOT NULL, time_slot TEXT,
               activity TEXT NOT NULL, location TEXT, cost_est REAL DEFAULT 0, status TEXT DEFAULT 'planned', notes TEXT,
               created_at INTEGER, updated_at INTEGER)""",
            """CREATE TABLE budget (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, label TEXT,
               amount REAL NOT NULL, kind TEXT NOT NULL, created_at INTEGER)""",
            """CREATE TABLE contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, role TEXT, phone TEXT,
               location TEXT, notes TEXT)""",
            """CREATE TABLE contingencies (id INTEGER PRIMARY KEY AUTOINCREMENT, trigger_event TEXT, original_plan TEXT,
               alternate_plan TEXT, created_at INTEGER)""",
            """CREATE TABLE discovered_places (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, near_location TEXT,
               description TEXT, source TEXT, source_url TEXT, status TEXT DEFAULT 'pending', created_at INTEGER)""",
            """CREATE TABLE cache (kind TEXT NOT NULL, place TEXT NOT NULL, json TEXT NOT NULL, fetched_at INTEGER NOT NULL,
               PRIMARY KEY (kind, place))""",
            """CREATE TABLE sync_log (id INTEGER PRIMARY KEY AUTOINCREMENT, synced_at INTEGER, source TEXT, summary TEXT)""",
        ).forEach(db::execSQL)
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

    fun insert(table: String, values: Map<String, Any?>): Long = writableDatabase.insertOrThrow(table, null, cv(values))
    fun update(table: String, id: Long, values: Map<String, Any?>): Int = writableDatabase.update(table, cv(values), "id=?", arrayOf(id.toString()))
    fun delete(table: String, id: Long): Int = writableDatabase.delete(table, "id=?", arrayOf(id.toString()))

    fun query(sql: String, vararg args: Any?): JSONArray =
        readableDatabase.rawQuery(sql, args.map { it?.toString() }.toTypedArray()).use(::rows)

    fun putCache(kind: String, place: String, json: String) {
        writableDatabase.insertWithOnConflict("cache", null, cv(mapOf("kind" to kind, "place" to place.lowercase().trim(), "json" to json, "fetched_at" to System.currentTimeMillis())), SQLiteDatabase.CONFLICT_REPLACE)
    }

    fun getCache(kind: String, place: String): Pair<String, Long>? =
        readableDatabase.rawQuery("SELECT json, fetched_at FROM cache WHERE kind=? AND place=?", arrayOf(kind, place.lowercase().trim())).use { c ->
            if (c.moveToFirst()) c.getString(0) to c.getLong(1) else null
        }

    fun cachedPlaces(kind: String): List<String> =
        readableDatabase.rawQuery("SELECT place FROM cache WHERE kind=? ORDER BY place", arrayOf(kind)).use { c ->
            buildList { while (c.moveToNext()) add(c.getString(0)) }
        }

    private fun cv(values: Map<String, Any?>) = ContentValues().apply {
        values.forEach { (k, v) ->
            when (v) {
                null -> putNull(k)
                is Int -> put(k, v)
                is Long -> put(k, v)
                is Double -> put(k, v)
                is Float -> put(k, v.toDouble())
                is Boolean -> put(k, if (v) 1 else 0)
                else -> put(k, v.toString())
            }
        }
    }

    private fun rows(c: Cursor): JSONArray {
        val out = JSONArray()
        while (c.moveToNext()) {
            val o = JSONObject()
            for (i in 0 until c.columnCount) {
                when (c.getType(i)) {
                    Cursor.FIELD_TYPE_NULL -> o.put(c.getColumnName(i), JSONObject.NULL)
                    Cursor.FIELD_TYPE_INTEGER -> o.put(c.getColumnName(i), c.getLong(i))
                    Cursor.FIELD_TYPE_FLOAT -> o.put(c.getColumnName(i), c.getDouble(i))
                    else -> o.put(c.getColumnName(i), c.getString(i))
                }
            }
            out.put(o)
        }
        return out
    }
}
