package com.biruni.app.safety

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Small settings store. Secrets (server PIN, emergency numbers) are AES-256-GCM encrypted with a
 * key that lives in the Android Keystore and never leaves the device's secure hardware/TEE.
 */
class SafetyPrefs(ctx: Context) {
    private val p = ctx.getSharedPreferences("safety", Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey("biruni-secrets", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("biruni-secrets", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).build())
        }.generateKey()
    }

    private fun seal(plain: String): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        return Base64.encodeToString(c.iv + c.doFinal(plain.toByteArray()), Base64.NO_WRAP)
    }

    private fun open(sealed: String): String? = runCatching {
        val raw = Base64.decode(sealed, Base64.NO_WRAP)
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, 12)) }
        String(c.doFinal(raw, 12, raw.size - 12))
    }.getOrNull()

    private fun getSecret(k: String) = p.getString(k, null)?.let(::open)
    private fun putSecret(k: String, v: String?) = p.edit().apply { if (v == null) remove(k) else putString(k, seal(v)) }.apply()

    var serverUrl: String
        get() = p.getString("server", "") ?: ""
        set(v) = p.edit().putString("server", v).apply()
    var username: String
        get() = p.getString("user", "") ?: ""
        set(v) = p.edit().putString("user", v).apply()
    var pin: String?
        get() = getSecret("pin")
        set(v) = putSecret("pin", v)
    /** Phone numbers to SMS when the server can't be reached. Comma separated in storage. */
    var emergencyNumbers: List<String>
        get() = getSecret("emerg")?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() } ?: emptyList()
        set(v) = putSecret("emerg", v.joinToString(","))
    var dropWatch: Boolean
        get() = p.getBoolean("dropWatch", false)
        set(v) = p.edit().putBoolean("dropWatch", v).apply()
    var cancelWindowSec: Int
        get() = p.getInt("cancelSec", 60)
        set(v) = p.edit().putInt("cancelSec", v.coerceIn(15, 300)).apply()
    var everyoneOnSos: Boolean
        get() = p.getBoolean("everyone", false)
        set(v) = p.edit().putBoolean("everyone", v).apply()
    var legalAccepted: Boolean
        get() = p.getBoolean("legal", false)
        set(v) = p.edit().putBoolean("legal", v).apply()
}
