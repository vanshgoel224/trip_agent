package com.biruni.app.safety

import android.os.Bundle
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Full-screen "I'm OK" over the lock screen. Any hardware key (volume, power-adjacent keys) also
 * cancels, for when the touch screen is cracked. Shaking the phone 3 times cancels too (service).
 */
class DropAlertActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        setContent {
            val s by DropWatchService.state.collectAsState()
            val st = s
            val bg = when {
                st == null || st.cancelledBy != null -> Color(0xFF14532D)
                st.result != null -> Color(0xFF7F1D1D)
                else -> Color(0xFFB91C1C)
            }
            Column(
                Modifier.fillMaxSize().background(bg).padding(28.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                when {
                    st == null -> Text("No active alert.", color = Color.White, fontSize = 22.sp)
                    st.cancelledBy != null -> {
                        Text("Cancelled. No SOS sent.", color = Color.White, fontSize = 26.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
                        Text("Cancelled by: ${st.cancelledBy}", color = Color.White.copy(alpha = .85f), modifier = Modifier.padding(top = 8.dp))
                    }
                    st.result != null -> {
                        Text("SOS sent", color = Color.White, fontSize = 30.sp, fontWeight = FontWeight.Bold)
                        Text(st.result, color = Color.White, fontSize = 18.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 12.dp))
                        Text("Call 112 if you need help now.", color = Color.White, modifier = Modifier.padding(top = 16.dp))
                    }
                    else -> {
                        Text("Phone dropped", color = Color.White, fontSize = 22.sp)
                        Text("${st.secondsLeft}", color = Color.White, fontSize = 110.sp, fontWeight = FontWeight.Black)
                        Text("seconds until an SOS is sent", color = Color.White, fontSize = 18.sp)
                        Text(
                            "About ${"%.1f".format(st.event.heightM)} m, ${st.event.impactG} g impact, ${st.event.severity} severity",
                            color = Color.White.copy(alpha = .85f), modifier = Modifier.padding(top = 8.dp), textAlign = TextAlign.Center,
                        )
                        Button(
                            onClick = { DropWatchService.cancel(this@DropAlertActivity, "screen") },
                            modifier = Modifier.fillMaxWidth().height(90.dp).padding(top = 28.dp),
                            colors = ButtonDefaults.buttonColors(containerColor = Color.White, contentColor = Color(0xFF7F1D1D)),
                        ) { Text("I'M OK", fontSize = 28.sp, fontWeight = FontWeight.Black) }
                        Text("Screen broken? Press a volume key or shake the phone 3 times.", color = Color.White.copy(alpha = .9f), modifier = Modifier.padding(top = 14.dp), textAlign = TextAlign.Center)
                    }
                }
                if (st == null || !st.active) {
                    Button(onClick = { finish() }, modifier = Modifier.padding(top = 24.dp)) { Text("Close") }
                }
            }
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (DropWatchService.state.value?.active == true) {
            DropWatchService.cancel(this, "key")
            return true
        }
        return super.onKeyDown(keyCode, event)
    }
}
