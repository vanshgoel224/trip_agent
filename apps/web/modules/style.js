// 🗣️ My style: teach Biruni your own words and way of talking; optionally record your
// voice for a Gnani voice clone (stored encrypted; cloning not connected yet).
const PASSAGE = "Namaste! Main Biruni ke saath travel kar raha hoon. Today I'm going from Pune to Goa by the night bus. Agar bus late ho jaaye, toh mujhe bata dena, aur ek window seat dhoondh dena. Thank you, milte hain!";

export function initStyle({ $, api, esc }) {
  const btn = document.createElement("button");
  btn.className = "side-link";
  btn.id = "styleBtn";
  btn.textContent = "🗣️ My style";
  $("memoryBtn")?.after(btn);

  const dlg = document.createElement("dialog");
  dlg.id = "styleDialog";
  dlg.innerHTML = `<div class="modal wide">
    <div class="row between"><h2>🗣️ My style</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <p class="muted small">Teach Biruni how you talk: your words, phrases and how you like to be addressed. It's vocabulary only, stored encrypted, and it never changes prices, safety advice or what needs your approval.</p>
    <div class="grid2">
      <label>Call me <select id="stAddress"><option value="auto">Biruni decides</option><option value="aap">aap (respectful)</option><option value="tum">tum</option><option value="tu">tu (like a close friend)</option></select></label>
      <label>Language mix <select id="stMix"><option value="auto">Match how I write</option><option value="english">English</option><option value="hinglish">Hinglish</option><option value="hindi">Hindi</option><option value="regional">My regional language</option></select></label>
    </div>
    <label>Region / dialect (optional) <input id="stRegion" maxlength="40" placeholder="e.g. Mumbai Bambaiya, Haryanvi, Madras Tamil" /></label>
    <label>My words — one per line, <code>word = meaning</code>
      <textarea id="stWords" rows="6" placeholder="scene = situation&#10;jugaad = quick fix&#10;bindaas = carefree, no worries&#10;kalti = leave quickly"></textarea></label>
    <label>Phrases I often say — one per line
      <textarea id="stPhrases" rows="3" placeholder="Chal, nikalte hain!&#10;Tension nahi lene ka"></textarea></label>
    <div class="row"><button class="pill accent" id="stSave" type="button">Save my style</button><span class="small muted" id="stMsg"></span></div>

    <h3>My voice <span class="tag">needs Gnani</span></h3>
    <p class="muted small" id="stVoiceStatus"></p>
    <p class="small">Read this out loud (about 20–40 seconds):</p>
    <blockquote class="small">${PASSAGE}</blockquote>
    <div class="row"><button class="pill" id="stRec" type="button">🎙 Record</button><span class="small" id="stRecInfo"></span></div>
    <audio id="stPlay" controls class="hidden" style="width:100%"></audio>
    <label class="row small"><input type="checkbox" id="stConsent" /> This is my own voice, and I agree to it being used to create my Biruni voice. I can delete it any time.</label>
    <div class="row"><button class="pill accent" id="stVoiceSave" type="button" disabled>Save voice sample</button><button class="pill" id="stVoiceDel" type="button">Delete my sample</button></div>
  </div>`;
  document.body.append(dlg);
  dlg.querySelector("[data-close]").onclick = () => dlg.close();

  const parseWords = (t) => t.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const [w, ...m] = l.split(/\s*[=:–-]\s*/); return { word: w, meaning: m.join(" - ") }; });
  async function load() {
    const r = await api("GET", "/api/style");
    const s = r.style;
    $("stAddress").value = s.address;
    $("stMix").value = s.mix;
    $("stRegion").value = s.region ?? "";
    $("stWords").value = s.words.map((w) => (w.meaning ? `${w.word} = ${w.meaning}` : w.word)).join("\n");
    $("stPhrases").value = s.phrases.join("\n");
    voiceStatus(r.voice);
  }
  function voiceStatus(v) {
    $("stVoiceStatus").textContent = `${v.sample ? `Sample saved (${Math.round(v.sample.bytes / 1024)} KB${v.sample.seconds ? `, ${v.sample.seconds}s` : ""}, consent ${new Date(v.sample.consentAt).toLocaleDateString("en-IN")}). ` : "No sample yet. "}${v.clone}`;
  }
  $("stSave").onclick = async () => {
    try {
      await api("POST", "/api/style", { address: $("stAddress").value, mix: $("stMix").value, region: $("stRegion").value, words: parseWords($("stWords").value), phrases: $("stPhrases").value.split("\n") });
      $("stMsg").textContent = "Saved. Biruni will talk more like you from your next message.";
    } catch (e) {
      $("stMsg").textContent = e.message;
    }
  };

  // Recording (MediaRecorder; needs microphone permission)
  let rec = null, chunks = [], started = 0, blob = null, timer = null;
  $("stRec").onclick = async () => {
    if (rec?.state === "recording") return rec.stop();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const type = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((t) => window.MediaRecorder?.isTypeSupported?.(t));
      rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      chunks = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        clearInterval(timer);
        blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        $("stPlay").src = URL.createObjectURL(blob);
        $("stPlay").classList.remove("hidden");
        $("stRec").textContent = "🎙 Record again";
        $("stRecInfo").textContent = `${Math.round((Date.now() - started) / 1000)} s recorded — listen back, then save.`;
        $("stVoiceSave").disabled = !$("stConsent").checked;
      };
      started = Date.now();
      rec.start();
      $("stRec").textContent = "⏹ Stop";
      timer = setInterval(() => {
        const s = Math.round((Date.now() - started) / 1000);
        $("stRecInfo").textContent = `Recording… ${s}s`;
        if (s >= 60) rec.stop();
      }, 500);
    } catch (e) {
      $("stRecInfo").textContent = `Microphone not available: ${e.message}. Allow it in 🛡️ Permissions.`;
    }
  };
  $("stConsent").onchange = () => ($("stVoiceSave").disabled = !($("stConsent").checked && blob));
  $("stVoiceSave").onclick = async () => {
    const audio = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
    try {
      voiceStatus(await api("POST", "/api/style/voice", { audio, consent: true, seconds: Math.round((Date.now() - started) / 1000) }));
      $("stRecInfo").textContent = "Saved (encrypted).";
    } catch (e) {
      $("stRecInfo").textContent = e.message;
    }
  };
  $("stVoiceDel").onclick = async () => {
    if (!confirm("Delete your voice sample?")) return;
    voiceStatus(await api("POST", "/api/style/voice/delete", {}));
  };

  btn.onclick = () => (dlg.showModal(), load().catch((e) => ($("stMsg").textContent = e.message)));
  return { load };
}
