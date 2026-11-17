// Hörbuch-Wandler: holt die Tonspur aus einem Video, komplett im Browser.
// Das Video wird nie hochgeladen. FFmpeg läuft als WebAssembly lokal in einem Web Worker
// und liest die Datei direkt von der Festplatte (WORKERFS), ohne sie ganz in den Speicher zu laden.
import { FFmpeg } from "./engine/ffmpeg/index.js";

const MAX_BYTES = 1024 * 1024 * 1024; // 1 GB
const CORE_URL = new URL("engine/core/ffmpeg-core.js", location.href).href;
const WASM_URL = new URL("engine/core/ffmpeg-core.wasm", location.href).href;

const $ = (id) => document.getElementById(id);
const schritte = ["s-waehlen", "s-format", "s-arbeit", "s-fertig", "s-fehler"];
function zeige(id) { schritte.forEach((s) => ($(s).hidden = s !== id)); }

let ff = null;
let ladeVersprechen = null;
let logZeilen = [];
let aktuelleDatei = null;
let laeuft = false;
let abgebrochen = false;
let ergebnisUrls = [];
let wachHalten = null;

// ---------- Werkzeug laden ----------
function motorStatus(text, art) {
  $("motor-text").textContent = text;
  $("motor").className = "motor" + (art ? " " + art : "");
}

function neuesFFmpeg() {
  ff = new FFmpeg();
  ff.on("log", ({ message }) => {
    logZeilen.push(message);
    if (logZeilen.length > 4000) logZeilen.splice(0, 2000);
    fortschrittAusLog(message);
  });
  ladeVersprechen = ff.load({ coreURL: CORE_URL, wasmURL: WASM_URL });
  return ladeVersprechen;
}

function werkzeugLaden() {
  motorStatus("Werkzeug wird vorbereitet …");
  neuesFFmpeg()
    .then(() => motorStatus("Werkzeug bereit", "bereit"))
    .catch((e) => {
      console.error(e);
      motorStatus("Werkzeug konnte nicht geladen werden. Bitte Seite neu laden oder einen aktuellen Browser nutzen.", "fehler");
    });
}

// ---------- Hilfen ----------
function groesse(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toLocaleString("de-DE", { maximumFractionDigits: 2 }) + " GB";
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toLocaleString("de-DE", { maximumFractionDigits: 1 }) + " MB";
  return Math.max(1, Math.round(bytes / 1024)).toLocaleString("de-DE") + " KB";
}
function dauerText(sek) {
  sek = Math.round(sek);
  const h = Math.floor(sek / 3600), m = Math.floor((sek % 3600) / 60), s = sek % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")} Std.` : `${m}:${String(s).padStart(2, "0")} Min.`;
}
function zeitInSek(t) {
  const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(t);
  return m ? +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]) : null;
}
function basisName(name) {
  const ohne = name.replace(/\.[^.]+$/, "").trim();
  return (ohne || "audio").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 120);
}
function endung(name) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name);
  return m ? m[1].toLowerCase() : "mp4";
}

// ---------- Fortschritt ----------
let dauerGesamt = 0;
let teilFortschritt = 0;
let schrittPlan = [];   // [{gewicht}]
let schrittIndex = 0;
let startZeit = 0;

function fortschrittAusLog(msg) {
  if (!laeuft || !dauerGesamt) return;
  const m = /time=\s*(-?\d+:\d+:\d+(?:\.\d+)?)/.exec(msg);
  if (!m) return;
  const t = zeitInSek(m[1]);
  if (t == null || t < 0) return;
  teilFortschritt = Math.min(1, t / dauerGesamt);
  zeichneFortschritt();
}

function zeichneFortschritt() {
  const summe = schrittPlan.reduce((a, s) => a + s.gewicht, 0) || 1;
  let fertig = 0;
  for (let i = 0; i < schrittIndex; i++) fertig += schrittPlan[i].gewicht;
  const aktuell = schrittPlan[schrittIndex] ? schrittPlan[schrittIndex].gewicht * teilFortschritt : 0;
  const p = Math.min(0.995, (fertig + aktuell) / summe);
  $("balken").classList.toggle("unbestimmt", !dauerGesamt);
  $("balken-i").style.width = (p * 100).toFixed(1) + "%";
  $("balken").setAttribute("aria-valuenow", String(Math.round(p * 100)));
  $("a-prozent").textContent = dauerGesamt ? Math.floor(p * 100) + " %" : "";
  const vergangen = (performance.now() - startZeit) / 1000;
  if (p > 0.05 && vergangen > 8) {
    const rest = (vergangen / p) * (1 - p);
    $("a-rest").textContent = rest < 60 ? "noch wenige Sekunden" : "noch ca. " + Math.ceil(rest / 60) + " Min.";
  } else {
    $("a-rest").textContent = "";
  }
}

// ---------- Datei wählen ----------
function dateiGewaehlt(datei) {
  if (!datei || laeuft) return;
  if (datei.size > MAX_BYTES) {
    fehler("Dein Video ist größer als 1 GB.",
      `Die Datei „${datei.name}“ hat ${groesse(datei.size)}. Bitte verkleinere sie vorher, zum Beispiel kostenlos mit HandBrake (Anleitung unten bei „Häufige Fragen“), und zieh sie dann nochmal hier rein.`);
    return;
  }
  if (datei.size === 0) {
    fehler("Die Datei ist leer.", "Bitte wähle eine andere Videodatei aus.");
    return;
  }
  bereitmachen();
  aktuelleDatei = datei;
  $("f-name").textContent = datei.name;
  $("f-meta").textContent = groesse(datei.size);
  zeige("s-format");
  $("start").focus({ preventScroll: true });
}

const ablage = $("ablage");
$("datei").addEventListener("change", (e) => { dateiGewaehlt(e.target.files[0]); e.target.value = ""; });
["dragenter", "dragover"].forEach((t) => ablage.addEventListener(t, (e) => { e.preventDefault(); ablage.classList.add("drauf"); }));
["dragleave", "dragend"].forEach((t) => ablage.addEventListener(t, () => ablage.classList.remove("drauf")));
ablage.addEventListener("drop", (e) => {
  e.preventDefault();
  ablage.classList.remove("drauf");
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  dateiGewaehlt(f);
});
// Daneben fallen gelassene Dateien nicht im Browser öffnen, sondern trotzdem annehmen
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  if (!$("s-waehlen").hidden || !$("s-format").hidden) {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) dateiGewaehlt(f);
  }
});

$("anderes").addEventListener("click", () => { aktuelleDatei = null; zeige("s-waehlen"); });
$("neu").addEventListener("click", zuruecksetzen);
$("nochmal").addEventListener("click", zuruecksetzen);
$("start").addEventListener("click", () => {
  const fmt = document.querySelector('input[name="fmt"]:checked').value;
  umwandeln(aktuelleDatei, fmt);
});
$("abbrechen").addEventListener("click", abbrechen);

function zuruecksetzen() {
  ergebnisUrls.forEach((u) => URL.revokeObjectURL(u));
  ergebnisUrls = [];
  $("ergebnisse").textContent = "";
  aktuelleDatei = null;
  zeige("s-waehlen");
}

function fehler(titel, text) {
  $("e-titel").textContent = titel;
  $("e-text").textContent = text;
  zeige("s-fehler");
}

// ---------- Umwandeln ----------
async function bildschirmAnLassen() {
  try { if (navigator.wakeLock) wachHalten = await navigator.wakeLock.request("screen"); } catch (_) { /* egal */ }
}
function bildschirmFreigeben() {
  try { if (wachHalten) wachHalten.release(); } catch (_) { /* egal */ }
  wachHalten = null;
}
function warnenBeimVerlassen(e) { e.preventDefault(); e.returnValue = ""; }

async function ausfuehren(args) {
  const code = await ff.exec(args);
  if (abgebrochen) throw new Error("abgebrochen");
  return code;
}

async function umwandeln(datei, fmt) {
  if (!datei) return;
  laeuft = true;
  abgebrochen = false;
  dauerGesamt = 0;
  teilFortschritt = 0;
  schrittPlan = [{ gewicht: 0.02 }];
  schrittIndex = 0;
  startZeit = performance.now();
  $("a-titel").textContent = "Wird vorbereitet …";
  $("a-rest").textContent = "";
  $("a-prozent").textContent = "";
  $("balken-i").style.width = "0%";
  $("balken").classList.add("unbestimmt");
  zeige("s-arbeit");
  window.addEventListener("beforeunload", warnenBeimVerlassen);
  bildschirmAnLassen();

  const ordner = "/video";
  const eingabe = `${ordner}/eingabe.${endung(datei.name)}`;
  let eingehaengt = false;

  try {
    if (!ladeVersprechen) neuesFFmpeg();
    $("a-titel").textContent = "Werkzeug wird geladen …";
    await ladeVersprechen;
    motorStatus("Werkzeug bereit", "bereit");
    $("a-titel").textContent = "Video wird gelesen …";

    // Datei nur "einhängen": FFmpeg liest sie stückweise direkt von deinem Gerät.
    try { await ff.createDir(ordner); } catch (_) { /* gibt es schon */ }
    await ff.mount("WORKERFS", { blobs: [{ name: eingabe.split("/").pop(), data: datei }] }, ordner);
    eingehaengt = true;

    // 1) Video ansehen: Länge und Tonspur
    logZeilen = [];
    await ausfuehren(["-hide_banner", "-i", eingabe]);
    const info = logZeilen.join("\n");
    const d = /Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/.exec(info);
    dauerGesamt = d ? zeitInSek(d[1]) || 0 : 0;
    const audio = /Stream #\d+:\d+[^\n]*?: Audio: ([a-z0-9_]+)[^\n]*/i.exec(info);
    if (!audio) {
      if (/Invalid data found|could not find codec|moov atom not found|End of file/i.test(info) || !/Stream #/.test(info)) {
        throw nutzerFehler("Diese Datei kann nicht gelesen werden.",
          "Sie ist entweder beschädigt, noch nicht fertig gespeichert oder kein Video. Öffne sie einmal in deinem Videoplayer. Wenn sie dort läuft, speichere sie als MP4 und versuch es nochmal.");
      }
      throw nutzerFehler("In diesem Video ist kein Ton.",
        "Die Datei hat keine Tonspur, deshalb kann keine Audiodatei entstehen. Prüf, ob beim Aufnehmen das Mikrofon aktiv war.");
    }
    const codec = audio[1].toLowerCase();
    const zeile = audio[0];
    const mono = /\bmono\b/.test(zeile);
    const kanaele = mono ? ["-ac", "1"] : ["-ac", "2"];
    const aacKopieren = codec === "aac";

    if (dauerGesamt) $("f-meta").textContent = groesse(datei.size) + " · " + dauerText(dauerGesamt);

    // 2) Plan
    const plan = [];
    if (fmt === "m4a" || fmt === "beide") plan.push({ typ: "m4a", gewicht: aacKopieren ? 0.06 : 0.8 });
    if (fmt === "mp3" || fmt === "beide") plan.push({ typ: "mp3", gewicht: 1 });
    schrittPlan = [{ gewicht: 0.01 }, ...plan];
    schrittIndex = 1;

    const basis = basisName(datei.name);
    const ergebnisse = [];
    const gemeinsam = ["-hide_banner", "-stats_period", "0.5", "-i", eingabe, "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1"];

    for (const schritt of plan) {
      teilFortschritt = 0;
      $("a-titel").textContent = schritt.typ === "mp3" ? "MP3 wird erstellt …" : "M4A wird erstellt …";
      zeichneFortschritt();
      const aus = "/ausgabe." + schritt.typ;
      let args;
      if (schritt.typ === "m4a") {
        args = aacKopieren
          ? [...gemeinsam, "-c:a", "copy", "-movflags", "+faststart", aus]
          : [...gemeinsam, ...kanaele, "-c:a", "aac", "-b:a", mono ? "96k" : "160k", "-movflags", "+faststart", aus];
      } else {
        args = [...gemeinsam, ...kanaele, "-c:a", "libmp3lame", "-b:a", mono ? "96k" : "128k", aus];
      }
      logZeilen = [];
      let code = await ausfuehren(args);
      // Falls das Herauslösen ohne Neuberechnung scheitert: neu berechnen
      if (code !== 0 && schritt.typ === "m4a" && aacKopieren) {
        try { await ff.deleteFile(aus); } catch (_) { /* egal */ }
        logZeilen = [];
        code = await ausfuehren([...gemeinsam, ...kanaele, "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", aus]);
      }
      if (code !== 0) throw technikFehler(logZeilen);
      const daten = await ff.readFile(aus);
      try { await ff.deleteFile(aus); } catch (_) { /* egal */ }
      if (!daten || daten.length < 200) throw technikFehler(logZeilen);
      ergebnisse.push({
        typ: schritt.typ,
        name: `${basis}.${schritt.typ}`,
        blob: new Blob([daten], { type: schritt.typ === "mp3" ? "audio/mpeg" : "audio/mp4" }),
      });
      schrittIndex++;
      teilFortschritt = 0;
    }

    zeigeErgebnisse(ergebnisse);
  } catch (e) {
    if (abgebrochen) return; // abbrechen() hat schon aufgeräumt
    console.error(e);
    if (e && e.nutzer) fehler(e.titel, e.text);
    else {
      const speicher = /memory|Out of bounds|RangeError|allocation/i.test(String(e && (e.message || e)));
      fehler("Das hat leider nicht geklappt.",
        speicher
          ? "Deinem Browser ist der Arbeitsspeicher ausgegangen. Schließ andere Tabs, nimm einen Computer statt eines Handys oder verkleinere das Video vorher (zum Beispiel mit HandBrake)."
          : "Beim Umwandeln ist ein Fehler passiert. Lade die Seite neu und versuch es nochmal. Wenn es wieder nicht klappt, speichere das Video als MP4 und probier es damit.");
      // Werkzeug sicherheitshalber frisch starten
      try { ff.terminate(); } catch (_) { /* egal */ }
      eingehaengt = false;
      werkzeugLaden();
    }
  } finally {
    if (eingehaengt && !abgebrochen) {
      try { await ff.unmount(ordner); } catch (_) { /* egal */ }
    }
    laeuft = false;
    window.removeEventListener("beforeunload", warnenBeimVerlassen);
    bildschirmFreigeben();
  }
}

function nutzerFehler(titel, text) { return { nutzer: true, titel, text }; }
function technikFehler(log) {
  const text = log.slice(-30).join("\n");
  if (/memory|Cannot allocate/i.test(text)) {
    return nutzerFehler("Zu wenig Arbeitsspeicher.",
      "Schließ andere Tabs, nimm einen Computer statt eines Handys oder verkleinere das Video vorher (zum Beispiel mit HandBrake).");
  }
  console.warn(text);
  return new Error("ffmpeg fehlgeschlagen");
}

function abbrechen() {
  if (!laeuft) return;
  abgebrochen = true;
  try { ff.terminate(); } catch (_) { /* egal */ }
  laeuft = false;
  window.removeEventListener("beforeunload", warnenBeimVerlassen);
  bildschirmFreigeben();
  werkzeugLaden();
  zeige("s-format");
}

function zeigeErgebnisse(liste) {
  const box = $("ergebnisse");
  box.textContent = "";
  for (const e of liste) {
    const url = URL.createObjectURL(e.blob);
    ergebnisUrls.push(url);
    const zeile = document.createElement("div");
    zeile.className = "ergebnis";
    const typ = document.createElement("span");
    typ.className = "typ";
    typ.textContent = e.typ.toUpperCase();
    const info = document.createElement("div");
    info.className = "info";
    const n = document.createElement("strong");
    n.textContent = e.name;
    const m = document.createElement("span");
    m.textContent = groesse(e.blob.size) + (dauerGesamt ? " · " + dauerText(dauerGesamt) : "");
    info.append(n, m);
    const a = document.createElement("a");
    a.className = "knopf";
    a.href = url;
    a.download = e.name;
    a.textContent = e.typ.toUpperCase() + " herunterladen";
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "metadata";
    audio.src = url;
    zeile.append(typ, info, a, audio);
    box.append(zeile);
  }
  $("balken-i").style.width = "100%";
  zeige("s-fertig");
}

// Werkzeug (ca. 10 MB) erst laden, wenn jemand es wirklich braucht. Danach bleibt es im Browser gespeichert.
let angestossen = false;
function bereitmachen() { if (!angestossen) { angestossen = true; werkzeugLaden(); } }
ablage.addEventListener("pointerenter", bereitmachen, { once: true });
ablage.addEventListener("focusin", bereitmachen, { once: true });
document.addEventListener("dragenter", bereitmachen, { once: true });
