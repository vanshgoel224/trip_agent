// Battery. Real part: reads your battery (where the browser allows) and, when low or
// when you switch Power saver on, Biruni itself slows down: GPS every 60 s instead
// of 10 s, fewer background refreshes. Demo part: a "smart power" panel showing how
// a native build would favour Biruni and essential apps (phone, SMS, maps) over
// others. A web or Android app cannot really take power from other apps; the panel
// says so.
export const power = { saver: false, level: null, charging: null };

export function initBattery({ $, store }) {
  const btn = document.createElement("button");
  btn.className = "side-link";
  btn.id = "powerBtn";
  btn.textContent = "🔋 Power";
  $("lockBtn")?.before(btn);
  power.saver = store.get("powerSaver", false);

  const dlg = document.createElement("dialog");
  dlg.id = "powerDialog";
  dlg.innerHTML = `<div class="modal">
    <div class="row between"><h2>🔋 Power</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <p id="pwrLevel" class="big-num">—</p>
    <label class="row"><input type="checkbox" id="pwrSaver" /> Power saver for Biruni <span class="muted small">(auto-on below 20%)</span></label>
    <p class="muted small">Saver: location every 60 s instead of 10 s, fewer background refreshes. SOS always works.</p>
    <h3>Smart power <span class="tag">demo</span></h3>
    <p class="muted small">How a native build would share the remaining charge. <b>Simulated:</b> a web or Android app can't take power from other apps.</p>
    <div id="pwrBars"></div>
  </div>`;
  document.body.append(dlg);
  dlg.querySelector("[data-close]").onclick = () => dlg.close();
  $("pwrSaver").checked = power.saver;
  $("pwrSaver").onchange = (e) => {
    power.saver = e.target.checked;
    store.set("powerSaver", power.saver);
    render();
  };

  function render() {
    const lvl = power.level == null ? null : Math.round(power.level * 100);
    $("pwrLevel").textContent = lvl == null ? "Battery level not available in this browser" : `${lvl}%${power.charging ? " ⚡ charging" : ""}${power.saver ? " · saver on" : ""}`;
    const low = lvl != null && lvl < 20;
    const shares = low || power.saver
      ? [["Biruni (SOS, location, alerts)", 40], ["Phone & SMS", 30], ["Maps", 15], ["Everything else", 15]]
      : [["Biruni", 15], ["Phone & SMS", 15], ["Maps", 15], ["Everything else", 55]];
    $("pwrBars").innerHTML = shares.map(([n, v]) => `<div class="pwr-row"><span>${n}</span><span class="pwr-bar"><i style="width:${v}%"></i></span><span class="small">${v}%</span></div>`).join("");
    btn.textContent = `🔋 Power${lvl != null ? ` ${lvl}%` : ""}${power.saver ? " · saver" : ""}`;
  }
  btn.onclick = () => (render(), dlg.showModal());

  navigator.getBattery?.().then((b) => {
    const upd = () => {
      power.level = b.level;
      power.charging = b.charging;
      if (b.level < 0.2 && !b.charging && !power.saver) {
        power.saver = true; // automatic, not persisted
        $("pwrSaver").checked = true;
      }
      render();
    };
    upd();
    b.addEventListener("levelchange", upd);
    b.addEventListener("chargingchange", upd);
  }).catch(() => {});
  render();
}
