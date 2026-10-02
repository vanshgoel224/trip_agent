// Plain-language terms, shown once per version and always reachable from the footer.
const VERSION = "2026-10";
const SUMMARY = `
<p><b>Biruni™ is an assistant, not the final word.</b> It suggests, books within the limits you set, and alerts people you trust. <b>You stay responsible</b> for your decisions, your bookings and payments, your safety and the safety of people travelling with you.</p>
<ul>
  <li>Always check prices, times and bookings with the operator before you rely on them. Some features are <b>simulated</b> until real partner keys are added, and the app labels them so.</li>
  <li>In an emergency, <b>call 112 first</b>. Biruni's SOS alerts other people; it does not dispatch police, ambulance or rescue.</li>
  <li>Translations, maps and AI answers can be wrong. Use your judgement.</li>
  <li>Your data is encrypted with your PIN. If you forget the PIN, nobody (including us) can recover your data.</li>
</ul>`;

export function initLegal({ $, store }) {
  const dlg = document.createElement("dialog");
  dlg.id = "legalDialog";
  dlg.innerHTML = `<form method="dialog" class="modal"><h2>Before you start</h2>${SUMMARY}
    <label class="row"><input type="checkbox" id="legalOk" required /> I understand: Biruni helps, I decide and I'm responsible.</label>
    <div class="row between"><a href="legal.html" target="_blank" rel="noopener" class="pill">Full terms &amp; licence</a><button class="pill accent" value="ok">Continue</button></div></form>`;
  document.body.append(dlg);
  dlg.querySelector("form").addEventListener("submit", (e) => {
    if (!dlg.querySelector("#legalOk").checked) return e.preventDefault();
    store.set("termsAccepted", VERSION);
  });
  dlg.addEventListener("cancel", (e) => e.preventDefault()); // must be acknowledged once
  const foot = $("footNote");
  if (foot) foot.insertAdjacentHTML("beforeend", ` <span class="legal-line">Biruni™ helps — you decide. <a href="legal.html" target="_blank" rel="noopener">Terms</a></span>`);
  return {
    ensureAccepted() {
      if (store.get("termsAccepted", "") !== VERSION) dlg.showModal();
    },
  };
}
