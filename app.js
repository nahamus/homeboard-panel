// HomeBoard Control: the panel's script (loaded by index.html).
// Kept out of the page so its Content-Security-Policy can allow only script-src 'self':
// any script injected into the page would be refused.
// Refuse to run inside another site's frame (clickjacking); GitHub Pages can't send frame-ancestors.
if (window.top !== window.self) { document.body.replaceChildren(); throw new Error("HomeBoard Control can't run in a frame"); }
const CONFIG = {
  repo: "nahamus/homeboard-data", path: "board.json",
  digestUrl: "https://news.nahamus.com/latest.json", digestName: "News Digest", maxStories: 8,
};
const TOKEN_KEY = "homeboard.token";
// News sections: Top Stories, Following, then every category in the digest (filled in when it loads)
const SECTION_NAMES = { top: "Top Stories", following: "Following" };
const DEFAULT_SECTIONS = ["top", "following"];
const sectionKey = (v) => String(v ?? "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40);
const sectionName = (k) => SECTION_NAMES[k] || k.charAt(0).toUpperCase() + k.slice(1);
const SPEEDS = { slow: 80, normal: 110, fast: 150 };   // px per second, same as the TV
const SKIES = ["auto", "night", "dawn", "day", "dusk", "cloudy", "rain", "snow", "storm", "fog"];
const SPOT_NAMES = { markets: "Markets", onthisday: "On this day", countdowns: "Countdowns" };
const ALL_SPOT = Object.keys(SPOT_NAMES);
const REPEATS = { "": "Once", weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly", yearly: "Yearly" };
let state = { notes: [], location: { name: "Home", latitude: "", longitude: "" },
  settings: { ticker: { sections: [...DEFAULT_SECTIONS], speed: "normal" }, sky: "auto", spotlight: { modules: [...ALL_SPOT], tickers: ["BTC-USD"], seconds: 45 },
    night: { enabled: false, start: "22:00", end: "06:30" } }, message: null };
let dirty = false;
let savedBoard = {};   // board.json as last loaded or saved, for Cancel
let sha = null;   // version of board.json we loaded; GitHub rejects a save if it changed meanwhile

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

async function github(method, body) {
  const r = await fetch(`https://api.github.com/repos/${CONFIG.repo}/contents/${CONFIG.path}`, {
    method, cache: "no-store",
    headers: { Authorization: "Bearer " + store.get(TOKEN_KEY), Accept: "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}
const toB64 = (text) => { const bytes = new TextEncoder().encode(text); let bin = ""; bytes.forEach((b) => (bin += String.fromCharCode(b))); return btoa(bin); };
const fromB64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

// Same cleanup the TV expects (and the old local server did).
function cleanBoard(b) {
  const t = (v, n) => String(v ?? "").trim().slice(0, n);
  const notes = (b.notes || []).filter((n) => n && t(n.title, 200) && t(n.date, 10)).map((n) => ({
    show: n.show !== false, title: t(n.title, 200), date: t(n.date, 10), time: t(n.time, 8), details: t(n.details, 200),
    repeat: REPEATS[n.repeat] && n.date ? n.repeat : "" }));
  const tk = (b.settings || {}).ticker || {};
  let sections = [...new Set((tk.sections || []).map(sectionKey).filter(Boolean))];
  if (!sections.length) sections = [...DEFAULT_SECTIONS];
  const speed = SPEEDS[tk.speed] ? tk.speed : "normal";
  const loc = b.location || {};
  const sky = SKIES.includes((b.settings || {}).sky) ? b.settings.sky : "auto";
  const sp = (b.settings || {}).spotlight || {};
  const modules = Array.isArray(sp.modules) ? [...new Set(sp.modules.filter((k) => ALL_SPOT.includes(k)))] : [...ALL_SPOT];
  const tickers = Array.isArray(sp.tickers) ? sp.tickers.map((x) => t(x, 15).toUpperCase()).filter(Boolean).slice(0, 6) : ["BTC-USD"];
  const seconds = [20, 30, 45, 60, 90, 120].includes(+sp.seconds) ? +sp.seconds : 45;
  const nt = (b.settings || {}).night || {}, hhmm = (v, d) => (/^\d{2}:\d{2}$/.test(v || "") ? v : d);
  const night = { enabled: nt.enabled === true, start: hhmm(nt.start, "22:00"), end: hhmm(nt.end, "06:30") };
  // A flash message is kept until it expires (the panel sends and clears it on its own commits)
  const mg = b.message && b.message.pending ? stampMessage(b.message) : b.message || {};
  const msgUntil = Number.isFinite(+mg.until) ? Math.floor(+mg.until) : 0;
  const message = t(mg.text, 160) && (!msgUntil || msgUntil * 1000 > Date.now())
    ? { text: t(mg.text, 160), sentAt: Math.floor(+mg.sentAt) || 0, until: msgUntil } : null;
  return { notes, settings: { ticker: { sections, speed }, sky, spotlight: { modules, tickers, seconds }, night },
           location: { name: t(loc.name, 60) || "Home", latitude: t(loc.latitude, 20), longitude: t(loc.longitude, 20) },
           ...(message ? { message } : {}) };
}

const $ = (id) => document.getElementById(id);
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

// Next occurrence (on or after today) of a repeating event. Mirrors hbNextOccurrence() in components/utils/Util.brs.
function nextOccurrence(start, rpt, today = todayKey()) {
  if (!rpt || !start || start >= today) return start;
  const p2 = (v) => String(v).padStart(2, "0"), key = (y, m, d) => `${y}-${p2(m)}-${p2(d)}`;
  const dim = (y, m) => new Date(y, m, 0).getDate();
  const [sy, sm, sd] = start.split("-").map(Number), [ty, tm, td] = today.split("-").map(Number);
  if (rpt === "weekly" || rpt === "biweekly") {
    const per = rpt === "weekly" ? 7 : 14, s = Date.UTC(sy, sm - 1, sd) / 864e5, t = Date.UTC(ty, tm - 1, td) / 864e5;
    const d = new Date((s + Math.ceil((t - s) / per) * per) * 864e5);
    return key(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  if (rpt === "monthly") {
    let y = ty, m = tm;
    for (let i = 0; i < 2; i++) { const k = key(y, m, Math.min(sd, dim(y, m))); if (k >= today) return k; if (++m > 12) { m = 1; y++; } }
  }
  if (rpt === "yearly") for (const y of [ty, ty + 1]) { const k = key(y, sm, Math.min(sd, dim(y, sm))); if (k >= today) return k; }
  return start;
}
const eventDate = (n) => nextOccurrence(n.date, n.repeat);
const isPast = (n) => !!n.date && eventDate(n) < todayKey();
const rowClass = (n) => "note" + (n.show ? "" : " hidden") + (isPast(n) ? " past" : "");
const prettyDate = (k) => new Date(k + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

// ---------- Flash message: edited like everything else, previewed live, written by Save ----------
// state.message is the saved { text, sentAt, until }, or a draft { text, minutes, pending: true }
// whose clock starts when it's saved.
const nowSec = () => Math.floor(Date.now() / 1000);
function stampMessage(m) {
  const sent = nowSec();
  let until = sent + (+m.minutes || 15) * 60;
  if (m.minutes === "midnight") { const d = new Date(); d.setHours(24, 0, 0, 0); until = Math.floor(d / 1000); }
  return { text: m.text, sentAt: sent, until };
}
const activeMessage = () => {
  const m = state.message;
  if (!m || !m.text) return null;
  if (m.pending) return stampMessage(m);
  return !m.until || m.until > nowSec() ? m : null;
};
const clockText = (sec) => { const d = new Date(sec * 1000); return !d.getHours() && !d.getMinutes() ? "midnight" : hm(d.getHours(), d.getMinutes()); };
const forText = (v) => (v === "midnight" ? "until midnight" : "for " + $("msgFor").selectedOptions[0].textContent);

function renderMessage(force = false) {
  const m = state.message, box = $("msgState");
  if (m && !m.pending && !activeMessage()) state.message = null;   // expired while the page was open
  if (force || document.activeElement !== $("msgText")) $("msgText").value = state.message ? state.message.text : "";
  if (state.message && state.message.pending) $("msgFor").value = state.message.minutes;
  $("msgClear").hidden = !state.message;
  if (!state.message) box.replaceChildren();
  else if (state.message.pending) box.replaceChildren(el("b", { textContent: "Not on the TV yet. " }), `Save to show it ${forText(state.message.minutes)}.`);
  else box.replaceChildren(el("b", { textContent: "On the TV" }), state.message.until ? ` until ${clockText(state.message.until)}.` : ".");
}
function editMessage() {
  const text = $("msgText").value.trim().slice(0, 160);
  state.message = text ? { text, minutes: $("msgFor").value, pending: true } : null;
  renderMessage(); markDirty();
}

// ---------- Night mode (mirrors applyNight() in components/HomeBoardScene.brs) ----------
const clockMin = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ""); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : -1; };
function inWindow(now, start, end) {
  if (start < 0 || end < 0 || start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}
function nightActive() {
  if (tv.previewNight) return true;
  const n = state.settings.night, d = new Date();
  return n.enabled && inWindow(d.getHours() * 60 + d.getMinutes(), clockMin(n.start), clockMin(n.end));
}
function renderNightSettings() {
  const n = state.settings.night;
  $("nightOn").checked = n.enabled; $("nightStart").value = n.start; $("nightEnd").value = n.end;
  $("nightTimes").hidden = !n.enabled;
}

function setStatus(text, cls = "") { const s = $("status"); s.textContent = text; s.className = "status " + cls; }
function setDirty(on) {
  dirty = on; $("save").disabled = !on; $("cancel").disabled = !on; $("tvDirty").hidden = !on;
}
function markDirty() { setDirty(true); setStatus("Unsaved changes", "dirty"); renderTv(); }
function renderAll() {
  $("locName").value = state.location.name; $("locLat").value = state.location.latitude; $("locLon").value = state.location.longitude;
  sortEvents(); renderNotes(); renderBanner(); renderSpotlightSettings(); renderNightSettings(); renderMessage(true); renderTv();
}
// Cancel: back to the board as it was last loaded or saved
function cancelChanges() {
  if (!dirty || !confirm("Undo all changes since the last save?")) return;
  state = cleanBoard(savedBoard); setDirty(false);
  renderAll(); restartSpot();
  setStatus("Changes undone", "ok"); setTimeout(() => { if (!dirty) setStatus("Up to date"); }, 3000);
}

function renderNotes() {
  const box = $("notes"); box.replaceChildren();
  if (!state.notes.length) { box.append(el("div", { className: "empty", textContent: "No events yet." })); }
  state.notes.forEach((n, i) => {
    const row = el("div", { className: rowClass(n) });
    const next = el("div", { className: "next" });
    const showNext = () => { const k = n.repeat && n.date ? eventDate(n) : ""; next.textContent = k && k !== n.date ? `Next: ${prettyDate(k)}` : ""; next.hidden = !next.textContent; };
    const bind = (input, key) => { input.addEventListener("input", () => {
      n[key] = input.type === "checkbox" ? input.checked : input.value;
      row.className = rowClass(n); showNext(); updatePast(); markDirty(); }); return input; };
    const show = bind(el("input", { type: "checkbox", checked: n.show, title: "Show on TV" }), "show");
    const title = bind(el("input", { type: "text", value: n.title, placeholder: "Title", className: "title" }), "title");
    const date = bind(el("input", { type: "date", value: n.date, required: true, className: "date" }), "date");
    date.addEventListener("change", () => { if (!date.value) { date.value = n.date = n.date || todayKey(); } });
    const time = bind(el("input", { type: "time", value: n.time, className: "time" }), "time");
    const repeat = bind(el("select", { className: "repeat", title: "Repeat" }, ...Object.entries(REPEATS).map(([v, label]) => el("option", { value: v, textContent: label }))), "repeat");
    repeat.value = n.repeat || "";
    const details = bind(el("input", { type: "text", value: n.details, placeholder: "Details (optional)", className: "details" }), "details");
    const del = el("button", { className: "icon del", textContent: "✕", title: "Delete", onclick: () => { state.notes.splice(i, 1); renderNotes(); markDirty(); } });
    row.append(el("label", { className: "show", title: "Show on TV" }, show), title, date, time, repeat, details, el("div", { className: "row-actions" }, del), next);
    showNext();
    box.append(row);
  });
  updatePast();
}

// "Remove 2 past" only when there are any
function updatePast() {
  const past = state.notes.filter(isPast).length, b = $("clearPast");
  b.hidden = !past; b.textContent = `Remove ${past} past`;
}
const sortEvents = () => state.notes.sort((a, b) => (eventDate(a) + " " + (a.time || "")).localeCompare(eventDate(b) + " " + (b.time || "")));

function addEvent() {
  state.notes.push({ show: true, title: "", date: todayKey(), time: "", details: "", repeat: "" });
  renderNotes(); markDirty();
  const inputs = $("notes").querySelectorAll("input.title"); inputs[inputs.length - 1].focus();
}

// Tap-to-toggle chips; selected ones show their position (the order the TV uses).
function renderChips(box, keys, enabled, name, onChange, opts = {}) {
  box.replaceChildren();
  for (const key of keys) {
    const pos = enabled.indexOf(key), on = pos >= 0;
    const chip = el("button", { className: "chip" + (on ? " on" : "") + (opts.gone && opts.gone(key) ? " gone" : ""),
      title: opts.gone && opts.gone(key) ? "Not in today's digest" : "", onclick: () => {
        const next = on ? enabled.filter((k) => k !== key) : [...enabled, key];
        if (!next.length && opts.keepOne) return;
        onChange(next); markDirty();
      } });
    chip.setAttribute("aria-pressed", String(on));
    if (on) chip.append(el("span", { className: "n", textContent: String(pos + 1) }));
    chip.append(name(key));
    box.append(chip);
  }
}

function renderSpotlightSettings() {
  renderChips($("spotMods"), ALL_SPOT, state.settings.spotlight.modules, (k) => SPOT_NAMES[k],
    (next) => { state.settings.spotlight.modules = next; renderSpotlightSettings(); });
  $("tickers").value = state.settings.spotlight.tickers.join(", ");
  $("spotSecs").value = String(state.settings.spotlight.seconds);
}

function renderBanner() {
  const n = news(), enabled = state.settings.ticker.sections;
  const keys = [...Object.keys(SECTION_NAMES), ...enabled.filter((k) => !(k in SECTION_NAMES))];
  renderChips($("banner"), keys, enabled, sectionName,
    (next) => { state.settings.ticker.sections = next; renderBanner(); },
    { keepOne: true, gone: (k) => !!n && !(n[k] || []).length });
  $("speed").value = state.settings.ticker.speed;
  $("sky").value = state.settings.sky;
}

// ---------- TV preview: mirrors the SceneGraph layout (components/*.xml/.brs) ----------
const C = { text: "#F5F7FA", white: "#FFFFFF", secondary: "#C3CCD5", muted: "#7F8C99", accent: "#6CB4FF", heading: "#8CC6FF",
            warm: "#FFC857", hair: "rgba(255,255,255,.15)", band: "rgba(5,8,13,.7)", ink: "#0B0F14" };
// Same art the TV uses (tools/make-assets.py). Local preview serves the repo root; Pages serves a copy.
const ASSETS = location.pathname.includes("/control/") ? "../images/ui/" : "images/ui/";
const DEG = "\u00b0", DOT = "  \u00b7  ";
let tv = { data: null, markets: null, otd: null, spotIdx: 0, otdOffset: 0 };

function L(parent, text, x, y, w, h, size, bold, color, align = "left") {
  const e = el("div", { className: "l", textContent: text ?? "" });
  Object.assign(e.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px", lineHeight: h + "px",
    fontSize: size + "px", fontWeight: bold ? "700" : "400", color, textAlign: align });
  parent.append(e); return e;
}
function R(parent, x, y, w, h, color) {
  const e = el("div", { className: "r" });
  Object.assign(e.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px", background: color });
  parent.append(e); return e;
}
function Glass(parent, x, y, w, h, cls = "glass") {
  const e = el("div", { className: cls });
  Object.assign(e.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
  parent.append(e); return e;
}
function Icon(parent, name, x, y, size) {
  if (!name) return;
  const e = el("img", { className: "icon", src: ASSETS + "wx/" + name + ".png", alt: "" });
  Object.assign(e.style, { left: x + "px", top: y + "px", width: size + "px", height: size + "px" });
  parent.append(e);
}
function G(parent, x, y) { const g = el("div", { className: "r" }); Object.assign(g.style, { left: x + "px", top: y + "px" }); parent.append(g); return g; }

const hm = (h, m) => `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
const num = (v) => (v === null || v === undefined ? "--" : String(v));

function notesView() {
  const today = todayKey();
  const shown = state.notes.filter((n) => n.show && n.title.trim());
  const events = shown.filter((n) => n.date).map((n) => ({ ...n, date: eventDate(n) })).filter((n) => n.date >= today)
    .sort((a, b) => (a.date + " " + (a.time || "")).localeCompare(b.date + " " + (b.time || "")));
  return { events, total: events.length };
}
function news() { return tv.data && tv.data.news && !tv.data.news.error ? tv.data.news : null; }

function drawHeader(root) {
  const now = new Date(), h = now.getHours();
  const t = `${h % 12 || 12}:${String(now.getMinutes()).padStart(2, "0")}`;
  const clock = L(root, t, 56, 24, 0, 140, 124, true, C.white);
  clock.style.width = "auto";
  L(root, h >= 12 ? "PM" : "AM", 56 + clock.offsetWidth + 14, 74, 120, 70, 44, true, C.secondary);
  L(root, now.toLocaleDateString("en-US", { weekday: "long" }), 964, 38, 900, 64, 54, true, C.white, "right");
  L(root, now.toLocaleDateString("en-US", { month: "long", day: "numeric" }), 964, 102, 900, 50, 40, false, C.secondary, "right");
}

// Left column (x 56, w 1176, y 190..950): "Coming up" shrinks to its notes, "Today" fills the rest.
// Mirrors layoutLeft() in components/HomeBoardScene.brs and NotesPage.brs.
// At most 3 rows; more events page every 12 s (mirrors NotesPage.brs maxRows / pageSeconds).
const NOTE_ROWS = 3, PAGE_MS = 12000;
function notesRows() {
  const { events, total } = notesView();
  const today = new Date(todayKey() + "T00:00:00");
  const pages = Math.max(1, Math.ceil(events.length / NOTE_ROWS));
  const page = pages > 1 ? Math.floor(Date.now() / PAGE_MS) % pages : 0;
  const rows = events.slice(page * NOTE_ROWS, page * NOTE_ROWS + NOTE_ROWS).map((n, i) => {
    const d = new Date(n.date + "T00:00:00");
    return { n, y: i * 118, h: 118, d, days: Math.round((d - today) / 86400000) };
  });
  return { rows, used: Math.min(events.length, NOTE_ROWS) * 118, total, page, pages };
}

function drawLeft(root) {
  const colTop = 190, colH = 760, gap = 24, minSpot = 250;
  const view = notesRows();
  const notesH = view.total ? view.used + 108 : 104;
  if (colH - notesH - gap >= minSpot) {
    view.total ? drawNotes(root, view, notesH) : drawNotesStrip(root);
    drawSpotlight(root, colTop + notesH + gap, colH - notesH - gap);
  } else drawNotes(root, view, colH);
}

function drawNotesStrip(root) {
  Glass(root, 56, 190, 1176, 104);
  const p = G(root, 92, 218);
  L(p, "COMING UP", 0, 0, 220, 48, 28, true, C.heading);
  L(p, "Nothing scheduled", 230, 0, 420, 48, 34, false, C.secondary);
  const next = countdownList()[0];
  if (next) L(p, `Next: ${next.title}${DOT}${daysText(next.days)}`, 660, 0, 1104 - 660, 48, 30, false, C.warm, "right");
}

let lastNotesPage = 0;
function drawNotes(root, { rows, total, page, pages }, cardH) {
  Glass(root, 56, 190, 1176, cardH);
  const W = 1104, p = G(root, 92, 218);
  L(p, "COMING UP", 0, 0, 700, 40, 28, true, C.heading);
  const list = G(p, 0, 58);
  if (page !== lastNotesPage) list.style.animation = "tvfade .8s ease";   // cross-fade on a new page
  lastNotesPage = page;
  if (pages > 1) {
    // "5 events" and page dots, the current page a wider pill
    const dotsW = 30 + (pages - 1) * 22;
    L(p, `${total} events`, W - dotsW - 18 - 400, 0, 400, 40, 26, false, C.muted, "right");
    for (let i = 0, x = W - dotsW; i < pages; i++) {
      const dw = i === page ? 30 : 12, dot = R(p, x, 14, dw, 12, i === page ? C.heading : "rgba(255,255,255,.25)");
      dot.style.borderRadius = "6px"; x += dw + 10;
    }
  }
  rows.forEach((r, i) => {
    if (i) R(list, 0, r.y, W, 1, "rgba(255,255,255,.1)");
    const n = r.n;
    const yy = r.y + 4, d = r.d, days = r.days;
    if (days === 0) {
      const g = Glass(list, -14, yy - 2, W + 28, 112, "chip");
      Object.assign(g.style, { background: "rgba(255,200,87,.16)", borderColor: "rgba(255,200,87,.22)" });
    }
    Glass(list, 0, yy + 4, 128, 104, "chip");
    L(list, d.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase(), 0, yy + 6, 128, 30, 26, true, days === 0 ? C.warm : C.accent, "center");
    L(list, String(d.getDate()), 0, yy + 30, 128, 52, 50, true, C.text, "center");
    L(list, d.toLocaleDateString("en-US", { month: "short" }).toUpperCase(), 0, yy + 78, 128, 26, 22, false, C.muted, "center");
    L(list, n.title, 160, yy + 4, W - 160, 60, 48, true, C.text);
    let when = days === 0 ? "Today" : days === 1 ? "Tomorrow" : `In ${days} days`;
    if (n.time) { const [hh, mm] = n.time.split(":").map(Number); when += DOT + hm(hh, mm); }
    if (n.details) when += DOT + n.details;
    L(list, when, 160, yy + 62, W - 160, 44, 34, false, days === 0 ? C.warm : C.secondary);
  });
}

// ---------- Spotlight ----------
function keyOf(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function nthWeekday(y, mo, dow, n) {
  if (n > 0) { const first = new Date(y, mo - 1, 1).getDay(); return keyOf(new Date(y, mo - 1, 1 + ((dow - first + 7) % 7) + (n - 1) * 7)); }
  const last = new Date(y, mo, 0); return keyOf(new Date(y, mo - 1, last.getDate() - ((last.getDay() - dow + 7) % 7)));
}
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return keyOf(new Date(y, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1));
}
function holidays(y) {
  const k = (mo, d) => keyOf(new Date(y, mo - 1, d));
  return [["New Year's Day", k(1, 1)], ["Martin Luther King Jr. Day", nthWeekday(y, 1, 1, 3)], ["Valentine's Day", k(2, 14)], ["Presidents' Day", nthWeekday(y, 2, 1, 3)],
    ["Daylight saving time starts", nthWeekday(y, 3, 0, 2)], ["St. Patrick's Day", k(3, 17)], ["Easter", easter(y)], ["Mother's Day", nthWeekday(y, 5, 0, 2)],
    ["Memorial Day", nthWeekday(y, 5, 1, -1)], ["Father's Day", nthWeekday(y, 6, 0, 3)], ["Juneteenth", k(6, 19)], ["Independence Day", k(7, 4)],
    ["Labor Day", nthWeekday(y, 9, 1, 1)], ["Halloween", k(10, 31)], ["Daylight saving time ends", nthWeekday(y, 11, 0, 1)], ["Veterans Day", k(11, 11)],
    ["Thanksgiving", nthWeekday(y, 11, 4, 4)], ["Christmas Eve", k(12, 24)], ["Christmas", k(12, 25)], ["New Year's Eve", k(12, 31)]];
}
// Same as hbCountdowns() in components/utils/Util.brs
function countdownList() {
  const today = new Date(todayKey() + "T00:00:00"), y = today.getFullYear();
  const all = [...holidays(y), ...holidays(y + 1)].map(([title, dateKey]) => ({ title, dateKey, mine: false }));
  return all.map((c) => ({ ...c, days: Math.round((new Date(c.dateKey + "T00:00:00") - today) / 86400000) }))
    .filter((c) => c.days >= 0 && c.days <= 365).sort((a, b) => a.days - b.days || a.title.localeCompare(b.title));
}
const daysText = (d) => (d === 0 ? "Today" : d === 1 ? "Tomorrow" : `In ${d} days`);
const money = (v) => (typeof v !== "number" ? "--" : v.toLocaleString("en-US", { minimumFractionDigits: v >= 10000 ? 0 : 2, maximumFractionDigits: v >= 10000 ? 0 : 2 }));

function spotModules() {
  const out = [];
  for (const k of state.settings.spotlight.modules) {
    if (k === "markets") out.push(k);   // shown even without live data (the TV has it)
    if (k === "onthisday" && tv.otd && tv.otd.items.length) out.push(k);
    if (k === "countdowns") out.push(k);
  }
  return out;
}

function drawSpotlight(root, cardY, cardH) {
  const mods = spotModules();
  if (!mods.length) return;
  Glass(root, 56, cardY, 1176, cardH);
  const W = 1104, H = cardH - 56, p = G(root, 92, cardY + 28);
  const key = mods[tv.spotIdx % mods.length];
  if (key === "markets") drawMarkets(p, W, H);
  if (key === "onthisday") drawOnThisDay(p, W, H);
  if (key === "countdowns") drawCountdowns(p, W, H);
}

function drawMarkets(p, W, H) {
  const mk = tv.markets;
  L(p, "MARKETS", 0, 0, 700, 40, 28, true, C.heading);
  L(p, mk ? "" : "Live market data shows on the TV", W - 500, 0, 500, 40, 26, false, C.muted, "right");
  const syms = ["S&P 500", "Dow", "Nasdaq", ...state.settings.spotlight.tickers.map((t) => (t === "BTC-USD" ? "Bitcoin" : t === "ETH-USD" ? "Ethereum" : t))];
  const items = mk ? mk.items : syms.map((name) => ({ name }));
  const rowH = 78, maxRows = Math.floor((H - 58) / rowH);
  items.slice(0, maxRows).forEach((it, n) => {
    const y = 58 + n * rowH;
    if (n) R(p, 0, y, W, 1, "rgba(255,255,255,.08)");
    const up = typeof it.changePct === "number" && it.changePct >= 0, live = typeof it.changePct === "number";
    const tone = !live ? C.muted : up ? "#4ADE80" : "#FF7B7B";
    L(p, it.name, 0, y, 300, rowH, 38, true, C.text);
    L(p, money(it.price), 300, y, 270, rowH, 38, false, C.text, "right");
    R(p, 600, y + 16, 150, 46, !live ? "rgba(255,255,255,.06)" : up ? "rgba(46,204,113,.18)" : "rgba(255,107,107,.18)");
    L(p, live ? `${up ? "+" : "-"}${Math.abs(it.changePct).toFixed(2)}%` : "--", 600, y + 16, 150, 46, 30, true, tone, "center");
  });
}

function drawOnThisDay(p, W, H) {
  const od = tv.otd;
  L(p, `ON THIS DAY${DOT}${od.dateLabel.toUpperCase()}`, 0, 0, 900, 40, 28, true, C.heading);
  const blockH = 156, count = Math.max(1, Math.floor((H - 58) / blockH));
  for (let i = 0; i < count && i < od.items.length; i++) {
    const e = od.items[(tv.otdOffset * count + i) % od.items.length], y = 62 + i * blockH;
    if (i) R(p, 0, y - 10, W, 1, "rgba(255,255,255,.08)");
    L(p, String(e.year), 0, y, 170, 60, 52, true, C.warm);
    const t = L(p, e.text, 190, y + 4, W - 190, blockH - 24, 34, false, C.text);
    Object.assign(t.style, { whiteSpace: "normal", lineHeight: "44px", display: "-webkit-box", webkitLineClamp: 3, webkitBoxOrient: "vertical" });
  }
}

function drawCountdowns(p, W, H) {
  L(p, "COUNTDOWNS", 0, 0, 700, 40, 28, true, C.heading);
  const rowH = 80, maxRows = Math.floor((H - 58) / rowH);
  countdownList().slice(0, maxRows).forEach((c, n) => {
    const y = 58 + n * rowH;
    if (n) R(p, 0, y, W, 1, "rgba(255,255,255,.08)");
    if (c.days === 0) L(p, "Today", 0, y, 160, rowH, 40, true, C.warm, "center");
    else { L(p, String(c.days), 0, y - 8, 160, rowH - 10, 52, true, c.mine ? C.warm : C.accent, "center"); L(p, c.days === 1 ? "DAY" : "DAYS", 0, y + rowH - 30, 160, 24, 20, true, C.muted, "center"); }
    L(p, c.title, 190, y, W - 190 - 260, rowH, 40, true, C.text);
    L(p, new Date(c.dateKey + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }), W - 260, y, 260, rowH, 30, false, C.secondary, "right");
  });
}

async function loadOnThisDay() {
  const now = new Date(), mm = String(now.getMonth() + 1).padStart(2, "0"), dd = String(now.getDate()).padStart(2, "0");
  try {
    const j = await fetch(`https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/selected/${mm}/${dd}`).then((r) => r.json());
    const items = (j.selected || []).filter((e) => e.text && e.year && e.text.length <= 190).map((e) => ({ year: e.year, text: e.text }))
      .sort((a, b) => a.text.length - b.text.length);
    tv.otd = { dateLabel: now.toLocaleDateString("en-US", { month: "long", day: "numeric" }), items };
  } catch { tv.otd = null; }
  renderTv();
}

// Weather card: glass 600 x 760 at (1264, 190)
function drawWeather(root) {
  const w = tv.data && tv.data.weather;
  Glass(root, 1264, 190, 600, 760);
  const p = G(root, 1264, 190);
  const alerts = activeAlerts();
  if (alerts.length) {
    // Alert strip replaces the location title (mirrors WeatherPanel.brs onAlerts)
    const a = alerts[0], warn = a.warning;
    const bg = R(p, 30, 24, 540, 48, warn ? "#FF5A4E" : "#FFC857"); bg.style.borderRadius = "24px";
    const until = warn ? "" : untilText(a.ends);   // warnings show their end time in the crawl
    L(p, a.event + (until ? DOT + until : "") + (alerts.length > 1 ? `  +${alerts.length - 1}` : ""), 50, 24, 500, 48, 24, true, warn ? C.white : C.ink);
  } else L(p, state.location.name.toUpperCase(), 36, 28, 380, 40, 28, true, C.heading);
  if (!w || w.error) { L(p, "--" + DEG, 186, 80, 390, 140, 128, true, C.white); L(p, (w && w.error) || "Loading...", 36, 284, 528, 40, 28, false, C.secondary); return; }
  Icon(p, w.icon, 24, 76, 150);
  L(p, num(w.temp) + DEG, 186, 80, 390, 140, 128, true, C.white);
  // AQI, pollen, UV rows (mirrors WeatherPanel.brs showReadings). Pollen comes from pollen.com,
  // which browsers can't fetch, so the preview shows where it goes.
  const readings = [];
  if (typeof w.aqi === "number") readings.push(["AQI " + w.aqi, ...aqiLevel(w.aqi)]);
  readings.push(["Pollen", "TV only", C.muted]);
  if (w.isDay && typeof w.uvMax === "number") readings.push(["UV " + w.uvMax, ...uvLevel(w.uvMax)]);
  readings.forEach(([name, level, color], i) => {
    const row = G(p, 304, 86 + i * 44);
    Object.assign(row.style, { width: "260px", height: "40px", display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "12px", whiteSpace: "nowrap" });
    row.append(Object.assign(el("span", { textContent: name }), { style: `font-size:24px;color:${C.secondary}` }),
               Object.assign(el("span", { textContent: level }), { style: `font-size:26px;font-weight:700;color:${color}` }));
  });
  L(p, w.description + DOT + "H " + num(w.high) + DEG + "  L " + num(w.low) + DEG, 36, 234, 528, 50, 38, false, C.text);
  L(p, "Feels " + num(w.feelsLike) + DEG + DOT + (w.windDir ? w.windDir + " " : "") + num(w.windMph) + " mph" + DOT + num(w.humidity) + "% humidity",
    36, 284, 528, 40, 28, false, C.secondary);
  R(p, 36, 344, 528, 1, C.hair);
  // From 6 PM a "Tomorrow" summary replaces the next hours, and the day list starts a day later
  const days = w.days || [], evening = new Date().getHours() >= 18 && days.length > 0;
  if (evening) {
    const t = days[0], tn = tomorrowNote(), when = new Date(todayKey() + "T12:00:00");
    when.setDate(when.getDate() + 1);
    L(p, "TOMORROW" + DOT + when.toLocaleDateString("en-US", { weekday: "long" }).toUpperCase(), 36, 358, 528, 32, 24, true, C.heading);
    Icon(p, t.icon, 36, 400, 104);
    L(p, num(t.high) + DEG + " / " + num(t.low) + DEG, 160, 394, 404, 52, 44, true, C.white);
    L(p, t.description + (t.precip >= 20 ? DOT + t.precip + "% rain" : ""), 160, 446, 404, 36, 26, false, C.secondary);
    L(p, tn || "Nothing scheduled", 160, 486, 404, 40, 26, false, tn ? C.warm : C.muted);
  } else (w.hours || []).slice(0, 5).forEach((h, i) => {
    const x = 36 + Math.floor(i * 105.6);
    L(p, h.label, x, 358, 106, 32, 24, false, C.muted, "center");
    Icon(p, h.icon, x + 19, 394, 68);
    L(p, num(h.temp) + DEG, x, 464, 106, 44, 36, true, C.text, "center");
    L(p, h.precip >= 10 ? h.precip + "%" : "", x, 506, 106, 28, 22, false, C.accent, "center");
  });
  R(p, 36, 542, 528, 1, C.hair);
  days.slice(evening ? 1 : 0, evening ? 5 : 4).forEach((d, i) => {
    const y = 554 + i * 50;
    Icon(p, d.icon, 36, y + 4, 42);
    L(p, d.name, 94, y, 80, 50, 30, true, C.text);
    L(p, num(d.high) + DEG + " / " + num(d.low) + DEG, 174, y, 154, 50, 30, false, C.text);
    L(p, d.description + (d.precip >= 20 ? DOT + d.precip + "%" : ""), 328, y, 236, 50, 24, false, C.muted);
  });
}

// ---------- Air quality, UV, NWS alerts (mirror Util.brs hbAqiLevel / hbUvLevel / hbUntilText) ----------
function aqiLevel(v) {
  if (v <= 50) return ["Good", "#7BD389"]; if (v <= 100) return ["Moderate", "#FFD866"]; if (v <= 150) return ["Sensitive", "#FF9F43"];
  if (v <= 200) return ["Unhealthy", "#FF6B6B"]; if (v <= 300) return ["Very unhealthy", "#C38BFF"]; return ["Hazardous", "#C0546A"];
}
function uvLevel(v) {
  if (v <= 2) return ["Low", "#7BD389"]; if (v <= 5) return ["Moderate", "#FFD866"]; if (v <= 7) return ["High", "#FF9F43"];
  if (v <= 10) return ["Very high", "#FF6B6B"]; return ["Extreme", "#C38BFF"];
}
function untilText(iso) {
  if (!iso || iso.length < 16) return "";
  const day = iso.slice(0, 10), dow = new Date(day + "T12:00:00").toLocaleDateString("en-US", { weekday: "short" });
  const h = +iso.slice(11, 13), mi = +iso.slice(14, 16), t = new Date(todayKey() + "T12:00:00");
  t.setDate(t.getDate() + 1);
  if (!h && !mi && day === keyOf(t)) return "until midnight";
  return "until " + (day !== todayKey() ? dow + " " : "") + hm(h, mi);
}
const activeAlerts = () => (tv.alerts || []).filter((a) => !a.endsAt || a.endsAt > Date.now());
const activeWarnings = () => activeAlerts().filter((a) => a.warning);

async function fetchAlerts() {
  const lat = parseFloat(state.location.latitude), lon = parseFloat(state.location.longitude);
  if (!lat && !lon) return [];
  const j = await fetch(`https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`, { headers: { Accept: "application/geo+json" } }).then((r) => r.json());
  const rank = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3 }, seen = new Set(), out = [];
  for (const f of j.features || []) {
    const p = f.properties || {};
    if (!p.event || p.status === "Test" || p.messageType === "Cancel" || seen.has(p.event)) continue;
    seen.add(p.event);
    const ends = p.ends || p.expires || "";
    const warning = /(Warning|Emergency)$/.test(p.event) || p.severity === "Extreme";
    out.push({ event: p.event, warning, ends, endsAt: ends ? Date.parse(ends) : 0, sort: (rank[p.severity] ?? 4) - (warning ? 10 : 0) });
  }
  return out.sort((a, b) => a.sort - b.sort || a.event.localeCompare(b.event));
}
async function fetchAqi() {
  const { latitude: lat, longitude: lon } = state.location;
  const j = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&current=us_aqi&timezone=auto`).then((r) => r.json());
  return rnd(j.current && j.current.us_aqi);
}
async function loadAlerts() {
  try { tv.alerts = await fetchAlerts(); } catch { return; }
  renderTv();
}

// ---------- Night face and flash message (mirror HomeBoardScene.xml night / msg groups) ----------
function drawNight(root) {
  R(root, 0, 0, 1920, 1080, "rgba(0,0,0,.78)");
  if (activeMessage()) return;   // the face hides while a message shows
  // The TV picks a random spot every 3 minutes; the preview does the same from the clock
  const slot = Math.floor(Date.now() / 180000), rand = (k) => { const v = Math.sin(slot * 12.9898 + k * 78.233) * 43758.5453; return v - Math.floor(v); };
  const f = G(root, 60 + Math.floor(rand(1) * 900), 60 + Math.floor(rand(2) * 530));
  const now = new Date(), h = now.getHours();
  const row = G(f, 0, 0);
  Object.assign(row.style, { width: "900px", display: "flex", justifyContent: "center", alignItems: "flex-start", whiteSpace: "nowrap" });
  row.append(Object.assign(el("span", { textContent: `${h % 12 || 12}:${String(now.getMinutes()).padStart(2, "0")}` }), { style: "font-size:200px;font-weight:700;line-height:230px;color:#B8C2CC" }),
             Object.assign(el("span", { textContent: h >= 12 ? "PM" : "AM" }), { style: "font-size:64px;font-weight:700;line-height:80px;margin:116px 0 0 16px;color:#7F8C99" }));
  L(f, now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }), 0, 232, 900, 56, 40, false, "#8C97A3", "center");
  const w = tv.data && tv.data.weather;
  if (w && typeof w.temp === "number") {
    const wr = G(f, 0, 300);
    Object.assign(wr.style, { width: "900px", height: "70px", display: "flex", justifyContent: "center", alignItems: "center", gap: "14px", whiteSpace: "nowrap" });
    if (w.icon) wr.append(Object.assign(el("img", { src: ASSETS + "wx/" + w.icon + ".png", alt: "" }), { style: "width:64px;height:64px;object-fit:contain;opacity:.7" }));
    wr.append(Object.assign(el("span", { textContent: w.temp + DEG + DOT + w.description }), { style: "font-size:40px;color:#8C97A3" }));
  }
  const a = activeAlerts()[0];
  if (a) L(f, a.event, 0, 380, 900, 50, 34, true, a.warning ? "#FF8A80" : "#E0B45A", "center");
}

// Mirrors the msg group in HomeBoardScene.xml (same card and badge art)
function drawMessage(root, m) {
  R(root, -40, 150, 2000, 830, "rgba(5,8,13,.65)");
  const img = (file, x, y, w, h) => { const e = el("img", { src: ASSETS + file, alt: "" });
    Object.assign(e.style, { position: "absolute", left: x + "px", top: y + "px", width: w + "px", height: h + "px" }); root.append(e); };
  img("message.png", 220, 270, 1480, 600);
  img("msg-badge.png", 324, 374, 120, 120);
  const head = G(root, 476, 374);
  Object.assign(head.style, { height: "44px", display: "flex", alignItems: "center", gap: "18px", whiteSpace: "nowrap", fontSize: "26px" });
  head.append(Object.assign(el("span", { textContent: "MESSAGE" }), { style: "font-weight:700;color:#FFC857" }),
              Object.assign(el("span", { textContent: m.sentAt ? clockText(m.sentAt) : "" }), { style: "color:#8C97A3" }));
  const size = m.text.length > 80 ? 54 : m.text.length > 40 ? 64 : 76;
  const box = G(root, 476, 418);
  Object.assign(box.style, { width: "1120px", height: "276px", display: "flex", alignItems: "center" });
  box.append(Object.assign(el("div", { textContent: m.text }), { style: `font-size:${size}px;font-weight:700;color:#fff;line-height:1.18;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden` }));
  const now = nowSec();
  if (m.until) L(root, "Until " + clockText(m.until), 476, 708, 700, 40, 26, false, C.secondary);
  if (m.until > now && m.sentAt && m.until > m.sentAt) {
    const mins = Math.ceil((m.until - now) / 60);
    L(root, (mins >= 60 ? `${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ""}` : `${mins} min`) + " left", 1196, 708, 400, 40, 26, false, "#8C97A3", "right");
    const track = R(root, 476, 758, 1120, 10, "rgba(255,255,255,.14)"); track.style.borderRadius = "5px";
    const fill = R(root, 476, 758, Math.max(12, Math.min(1120, Math.floor(1120 * (m.until - now) / (m.until - m.sentAt)))), 10, "#FFC857");
    fill.style.borderRadius = "5px";
  }
}

// Tomorrow's first event: all-day first, then by time (mirrors tomorrowNote() in HomeBoardScene.brs)
function tomorrowNote() {
  const d = new Date(todayKey() + "T12:00:00"); d.setDate(d.getDate() + 1);
  const tk = keyOf(d);
  const list = state.notes.filter((n) => n.show && n.title.trim() && n.date && nextOccurrence(n.date, n.repeat, tk) === tk)
    .sort((a, b) => (a.time || "").localeCompare(b.time || ""));
  if (!list.length) return "";
  const n = list[0], [h, mi] = (n.time || "").split(":").map(Number);
  return (n.time ? hm(h, mi) : "All day") + "  " + n.title.trim() + (list.length > 1 ? `  +${list.length - 1} more` : "");
}

// Static layers are redrawn on every edit; the news crawl lives in its own layer so it keeps moving.
let tvFrame = 0;
function renderTv() { if (!tvFrame) tvFrame = requestAnimationFrame(() => { tvFrame = 0; renderTvNow(); }); }
function renderTvNow() {
  const root = $("tvStatic");
  if (!root) return;
  renderSky();
  root.replaceChildren();
  const night = nightActive();
  (tv.bandEls || []).forEach((e) => (e.style.visibility = night ? "hidden" : ""));
  if (night) drawNight(root);
  else { drawHeader(root); drawLeft(root); drawWeather(root); }
  const m = activeMessage();
  if (m) drawMessage(root, m);
}

// ---------- News crawl (mirrors components/NewsTicker.brs) ----------
const crawl = { x: 0, width: 0, section: -1, last: 0, track: null, tag: null };
const CLIP_W = 1528;

function buildTvLayers() {
  const stage = $("tv");
  stage.replaceChildren();
  const skyLayer = el("div", { id: "tvSky", className: "r" });
  Object.assign(skyLayer.style, { left: 0, top: 0, width: "1920px", height: "1080px", overflow: "hidden" });
  stage.append(skyLayer);
  tv.bandEls = [R(stage, 0, 980, 1920, 100, C.band), R(stage, 0, 980, 1920, 1, "rgba(255,255,255,.2)")];
  stage.append(Object.assign(el("div", { id: "tvStatic", className: "r" }), { style: "left:0;top:0;width:1920px;height:1080px" }));
  const pill = crawl.pill = R(stage, 56, 1002, 256, 56, C.accent);
  Object.assign(pill.style, { borderRadius: "28px", boxShadow: "inset 0 0 0 1.5px #8CC6FF" });
  crawl.tag = L(stage, "NEWS", 56, 1002, 256, 56, 26, true, C.ink, "center");
  const clip = el("div", { className: "r" });
  Object.assign(clip.style, { left: "336px", top: "980px", width: CLIP_W + "px", height: "100px", overflow: "hidden",
    maskImage: "linear-gradient(90deg, transparent 0, #000 72px, #000 calc(100% - 72px), transparent 100%)",
    webkitMaskImage: "linear-gradient(90deg, transparent 0, #000 72px, #000 calc(100% - 72px), transparent 100%)" });
  crawl.track = el("div", { className: "r" });
  Object.assign(crawl.track.style, { left: "0", top: "0", height: "100px", display: "flex", alignItems: "center", whiteSpace: "nowrap" });
  clip.append(crawl.track); stage.append(clip);
  tv.bandEls.push(pill, crawl.tag, clip);   // hidden in night mode
}

function crawlSections() {
  const n = news();
  if (!n) return [];
  return state.settings.ticker.sections.filter((k) => (n[k] || []).length);
}

function crawlItem(title, meta, metaColor) {
  crawl.track.append(span(title, 40, true, C.text, 16));
  if (meta) { const sp = span(meta, 28, false, metaColor, 0); sp.style.opacity = 0.8; crawl.track.append(sp); }
  const dot = el("span"); Object.assign(dot.style, { display: "inline-block", width: "8px", height: "8px", background: "rgba(255,255,255,.4)", margin: "0 32px" });
  crawl.track.append(dot);
}
function setTag(text, warn) {
  crawl.tag.textContent = text; crawl.tag.style.color = warn ? C.white : C.ink;
  Object.assign(crawl.pill.style, { background: warn ? "#FF5A4E" : C.accent, boxShadow: warn ? "none" : "inset 0 0 0 1.5px #8CC6FF" });
}

function startPass() {
  const keys = crawlSections();
  crawl.track.replaceChildren();
  // Severe weather warnings replace the news until they expire (mirrors NewsTicker.brs startWarningPass)
  const warnings = activeWarnings();
  if (warnings.length) {
    setTag("WARNING", true);
    for (const a of warnings) { const u = untilText(a.ends); crawlItem(a.event, (u ? u + DOT : "") + "National Weather Service", "#FFB3AD"); }
    crawl.width = crawl.track.scrollWidth; crawl.x = CLIP_W;
    return;
  }
  setTag("NEWS", false);
  if (!keys.length) {
    crawl.tag.textContent = "NEWS";
    crawl.track.append(span("Loading headlines...", 40, false, C.secondary));
    crawl.x = 0; crawl.width = 0; crawl.track.style.transform = "translateX(0)";
    return;
  }
  crawl.section = (crawl.section + 1) % keys.length;
  const key = keys[crawl.section];
  crawl.tag.textContent = sectionName(key).toUpperCase();
  for (const it of news()[key]) crawlItem(it.title, it.source, C.accent);
  crawl.width = crawl.track.scrollWidth;
  crawl.x = CLIP_W;
}
function span(text, size, bold, color, gap = 0) {
  const e = el("span", { textContent: text });
  Object.assign(e.style, { fontSize: size + "px", fontWeight: bold ? "700" : "400", color, marginRight: gap + "px", flex: "none" });
  return e;
}
function tickCrawl(t) {
  const dt = crawl.last ? Math.min(0.1, (t - crawl.last) / 1000) : 0;
  crawl.last = t;
  if (crawl.width) {
    crawl.x -= SPEEDS[state.settings.ticker.speed] * dt;
    if (crawl.x < -crawl.width) startPass();
    crawl.track.style.transform = `translateX(${crawl.x}px)`;
  }
  requestAnimationFrame(tickCrawl);
}

// ---------- Living sky (mirrors components/SkyScene.brs) ----------
const SKY = { key: "", flashTimer: null };
const minsOf = (iso) => { const m = /T(\d\d):(\d\d)/.exec(iso || ""); return m ? +m[1] * 60 + +m[2] : -1; };
function skyTimeOfDay(w) {
  const now = new Date(), mins = now.getHours() * 60 + now.getMinutes();
  let rise = w ? minsOf(w.sunrise) : -1, set = w ? minsOf(w.sunset) : -1;
  if (rise < 0) rise = 420; if (set < 0) set = 1080;
  if (Math.abs(mins - rise) <= 45) return "dawn";
  if (Math.abs(mins - set) <= 45) return "dusk";
  return mins > rise && mins < set ? "day" : "night";
}
function skyCondition(w) {
  const c = w && typeof w.code === "number" ? w.code : 0;
  if (c <= 1) return "clear"; if (c === 2) return "partly"; if (c === 3) return "cloudy";
  if (c === 45 || c === 48) return "fog"; if (c >= 51 && c <= 57) return "drizzle";
  if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return "rain";
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return "snow";
  return c >= 95 ? "storm" : "cloudy";
}
const FORCED = { night: ["night", "clear"], dawn: ["dawn", "partly"], day: ["day", "partly"], dusk: ["dusk", "clear"],
  cloudy: ["day", "cloudy"], rain: ["day", "rain"], snow: ["day", "snow"], storm: ["night", "storm"], fog: ["dawn", "fog"] };
function cloudLook(tod, cond) {
  if (cond === "storm") return ["#5C6474", 1];
  if (tod === "night") return cond === "clear" || cond === "partly" ? ["#6E7A96", 0.6] : ["#55607A", 0.9];
  if (cond === "drizzle" || cond === "rain") return ["#AAB4C2", 0.95];
  if (cond === "snow") return ["#DCE2EA", 0.85];
  if (cond === "fog") return ["#DCE2EA", 0.5];
  if (tod === "dawn") return ["#FFD6C8", 0.8];
  if (tod === "dusk") return ["#FFC8BE", 0.75];
  return ["#FFFFFF", 0.9];
}
function skyImg(file, x, y, w, h) {
  const e = el("img", { src: ASSETS + "sky/" + file, alt: "" });
  Object.assign(e.style, { position: "absolute", left: 0, top: 0, width: w + "px", height: h + "px", transform: `translate(${x}px, ${y}px)` });
  return e;
}
// Roku's blendColor multiplies the cloud's colours; do the same on a canvas.
function tintedCloud(file, w, h, tint, alpha) {
  const cv = el("canvas", { width: w, height: h });
  Object.assign(cv.style, { position: "absolute", left: 0, top: 0, opacity: alpha });
  const img = new Image();
  img.onload = () => {
    const g = cv.getContext("2d");
    g.drawImage(img, 0, 0, w, h);
    g.globalCompositeOperation = "multiply"; g.fillStyle = tint; g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = "destination-in"; g.drawImage(img, 0, 0, w, h);
  };
  img.src = ASSETS + "sky/" + file;
  return cv;
}
function fallingLayer(file, opacity, seconds) {
  const e = el("div");
  Object.assign(e.style, { position: "absolute", left: 0, top: 0, width: "1920px", height: "1080px", opacity,
    backgroundImage: `url(${ASSETS}sky/${file})`, backgroundSize: "1920px 1080px", backgroundRepeat: "repeat" });
  e.animate([{ backgroundPosition: "0 0" }, { backgroundPosition: "0 1080px" }], { duration: seconds * 1000, iterations: Infinity, easing: "linear" });
  return e;
}
function renderSky() {
  const layer = $("tvSky");
  if (!layer) return;
  const w = tv.data && tv.data.weather && !tv.data.weather.error ? tv.data.weather : null;
  let tod = skyTimeOfDay(w), cond = skyCondition(w);
  const f = state.settings.sky;
  if (FORCED[f]) [tod, cond] = FORCED[f];
  const key = tod + "/" + cond;
  if (key === SKY.key) return;
  SKY.key = key;
  clearTimeout(SKY.flashTimer);
  layer.replaceChildren();
  const clearish = cond === "clear" || cond === "partly";
  const base = cond === "storm" ? "storm" : clearish ? tod : tod === "night" ? "overcast-night" : "overcast-day";
  layer.append(skyImg(base + ".jpg", 0, 0, 1920, 1080));
  if (clearish) {
    const g = tod === "night" ? ["moon-glow", 600, 1380, -200] : tod === "dawn" ? ["sun-glow", 900, -250, 520]
      : tod === "dusk" ? ["sun-glow", 900, 1250, 540] : ["sun-glow", 900, 1200, -380];
    layer.append(skyImg(g[0] + ".png", g[2], g[3], g[1], g[1]));
  }
  if (tod === "night" && clearish) {
    const groups = [[4, [0.3, 1, 0.3]], [5.5, [1, 0.35, 1]], [7, [0.5, 1, 0.5]]].map(([secs, vals]) => {
      const gr = el("div"); Object.assign(gr.style, { position: "absolute", left: 0, top: 0 });
      gr.animate(vals.map((o) => ({ opacity: o })), { duration: secs * 1000, iterations: Infinity, easing: "ease-in-out" });
      layer.append(gr); return gr;
    });
    let seed = 42; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 72; i++) { const sz = 6 + Math.floor(rnd() * 12); groups[i % 3].append(skyImg("star.png", Math.floor(rnd() * 1900), Math.floor(rnd() * 640), sz, sz)); }
  }
  const count = cond === "partly" ? 2 : cond === "fog" ? 1 : ["cloudy", "drizzle", "rain", "snow", "storm"].includes(cond) ? 3 : 0;
  const [tint, alpha] = cloudLook(tod, cond);
  [[1400, 560, 30, 200, 420], [1120, 448, 230, 1150, 300], [1400, 560, 110, -700, 540]].slice(0, count).forEach(([cw, ch, y, x0, secs], i) => {
    const c = tintedCloud(`cloud${i + 1}.png`, cw, ch, tint, alpha);
    const a = Math.min(0.999, Math.max(0.001, (1920 - x0) / (1920 + cw)));
    c.animate([{ transform: `translate(${x0}px, ${y}px)` }, { transform: `translate(1920px, ${y}px)`, offset: a },
               { transform: `translate(${-cw}px, ${y}px)`, offset: a + 0.0001 }, { transform: `translate(${x0}px, ${y}px)` }],
              { duration: secs * 1000, iterations: Infinity, easing: "linear" });
    layer.append(c);
  });
  if (cond === "fog") {
    const fg = el("div"); Object.assign(fg.style, { position: "absolute", left: 0, top: 0 });
    fg.append(skyImg("fog.png", 0, 540, 1920, 360), skyImg("fog.png", 160, 760, 1920, 360));
    fg.animate([{ transform: "translateX(-160px)" }, { transform: "translateX(0)" }, { transform: "translateX(-160px)" }],
               { duration: 70000, iterations: Infinity, easing: "ease-in-out" });
    layer.append(fg);
  }
  if (cond === "drizzle") layer.append(fallingLayer("rain.png", 0.35, 1.1));
  if (cond === "rain") layer.append(fallingLayer("rain.png", 0.6, 0.75));
  if (cond === "storm") layer.append(fallingLayer("rain.png", 0.8, 0.6));
  if (cond === "snow") layer.append(fallingLayer("snow-far.png", 1, 40), fallingLayer("snow-near.png", 1, 22));
  if (cond === "storm") {
    const flash = el("div"); Object.assign(flash.style, { position: "absolute", left: 0, top: 0, width: "1920px", height: "1080px", background: "#DDE6FF", opacity: 0 });
    layer.append(flash);
    const strike = () => {
      flash.animate([{ opacity: 0, offset: 0 }, { opacity: 0.5, offset: 0.04 }, { opacity: 0.05, offset: 0.12 }, { opacity: 0.3, offset: 0.2 }, { opacity: 0, offset: 0.32 }, { opacity: 0 }],
                    { duration: 1200, easing: "linear" });
      SKY.flashTimer = setTimeout(strike, 12000 + Math.random() * 24000);
    };
    SKY.flashTimer = setTimeout(strike, 2500);
  }
}

function fitTv() { const vp = $("tvViewport"); $("tv").style.transform = `scale(${vp.clientWidth / 1920})`; }
const WMO = { 0: ["Sunny", "Clear"], 1: ["Mostly Sunny", "Mostly Clear"], 2: "Partly Cloudy", 3: "Cloudy", 45: "Fog", 48: "Fog",
  51: "Drizzle", 53: "Drizzle", 55: "Drizzle", 56: "Freezing Drizzle", 57: "Freezing Drizzle", 61: "Light Rain", 63: "Rain",
  65: "Heavy Rain", 66: "Freezing Rain", 67: "Freezing Rain", 71: "Light Snow", 73: "Snow", 75: "Heavy Snow", 77: "Snow Grains",
  80: "Rain Showers", 81: "Rain Showers", 82: "Heavy Showers", 85: "Snow Showers", 86: "Snow Showers", 95: "Thunderstorms",
  96: "Storms with Hail", 99: "Storms with Hail" };
const rnd = (v) => (v === null || v === undefined ? null : Math.round(v));
// WMO code -> icon name (same as weatherIcon() in components/tasks/FetchTask.brs)
function weatherIcon(code, isDay) {
  if (code === 0) return isDay ? "clear-day" : "clear-night";
  if (code === 1 || code === 2) return isDay ? "partly-day" : "partly-night";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "storm";
  return "cloudy";
}

async function fetchWeather() {
  const { latitude: lat, longitude: lon } = state.location;
  if (!parseFloat(lat) && !parseFloat(lon)) return { error: "Set latitude/longitude under Connection" };
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}` +
    "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,is_day" +
    "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,weather_code,uv_index_max" +
    "&hourly=temperature_2m,precipitation_probability,weather_code,is_day" +
    "&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=6";
  const j = await fetch(url).then((r) => r.json());
  const c = j.current, d = j.daily, first = (k) => (d[k] || [null])[0];
  const desc = WMO[c.weather_code] ?? "--";
  const dayDesc = (code) => { const v = WMO[code] ?? "--"; return Array.isArray(v) ? v[0] : v; };
  const hourLabel = (iso) => { const h = +iso.slice(11, 13); return `${h % 12 || 12} ${h >= 12 ? "PM" : "AM"}`; };
  const start = j.hourly.time.findIndex((t) => t > c.time);
  const hours = [];
  for (let i = start; start >= 0 && i < j.hourly.time.length && hours.length < 5; i += 2)
    hours.push({ label: hourLabel(j.hourly.time[i]), temp: rnd(j.hourly.temperature_2m[i]), precip: rnd(j.hourly.precipitation_probability[i]),
                 icon: weatherIcon(j.hourly.weather_code[i], j.hourly.is_day[i] !== 0) });
  let cur = 0;
  j.hourly.time.forEach((t, i) => { if (t <= c.time) cur = i; });
  const next24 = j.hourly.time.slice(cur, cur + 24).map((t, k) => ({
    hour: +t.slice(11, 13), temp: rnd(j.hourly.temperature_2m[cur + k]), precip: rnd(j.hourly.precipitation_probability[cur + k]) }));
  const days = [1, 2, 3, 4, 5].filter((i) => d.time[i]).map((i) => ({
    name: new Date(d.time[i] + "T12:00:00").toLocaleDateString("en-US", { weekday: "short" }),
    high: rnd(d.temperature_2m_max[i]), low: rnd(d.temperature_2m_min[i]),
    precip: rnd(d.precipitation_probability_max[i]), description: dayDesc(d.weather_code[i]), icon: weatherIcon(d.weather_code[i], true) }));
  return { temp: rnd(c.temperature_2m), feelsLike: rnd(c.apparent_temperature), humidity: rnd(c.relative_humidity_2m),
    windMph: rnd(c.wind_speed_10m),
    windDir: c.wind_direction_10m == null ? null : ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.floor((c.wind_direction_10m + 22.5) / 45) % 8],
    description: Array.isArray(desc) ? desc[c.is_day === 1 ? 0 : 1] : desc,
    high: rnd(first("temperature_2m_max")), low: rnd(first("temperature_2m_min")),
    precipChance: rnd(first("precipitation_probability_max")), uvMax: rnd(first("uv_index_max")), aqi: await fetchAqi().catch(() => null), sunrise: first("sunrise"), sunset: first("sunset"), hours, days, next24,
    icon: weatherIcon(c.weather_code, c.is_day === 1), isDay: c.is_day === 1, code: c.weather_code };
}

async function fetchNews() {
  const j = await fetch(CONFIG.digestUrl, { cache: "no-store" }).then((r) => r.json());
  const meta = (st) => { const also = (st.also || []).filter((a) => typeof a === "string"); let m = st.source || "";
    if (also.length) m += "  ·  also " + also.slice(0, 2).join(", ") + (also.length > 2 ? ` +${also.length - 2}` : ""); return m; };
  const out = { sourceName: CONFIG.digestName, stamp: `${j.edition} edition · ${j.updated_time}`, top: [], following: [] };
  for (const b of j.blocks || []) {
    const key = b.kind === "top" ? "top" : b.kind === "follow" ? "following" : b.kind === "category" ? sectionKey(b.slug) : "";
    if (key && b.kind === "category" && b.name) SECTION_NAMES[key] = b.name;   // so the Display list offers it
    if (key) out[key] = (b.stories || []).filter((st) => st.title).slice(0, CONFIG.maxStories).map((st) => ({ title: st.title, source: st.source || "", meta: meta(st) }));
  }
  return out;
}

async function loadTvData() {
  const [w, n] = await Promise.allSettled([fetchWeather(), fetchNews(), loadAlerts()]);
  tv.data = { weather: w.status === "fulfilled" ? w.value : { error: "Weather unavailable" },
              news: n.status === "fulfilled" ? n.value : { error: "News unavailable" } };
  renderBanner();   // the digest's categories are known now
  renderTv();
  if (!crawl.width) startPass();   // otherwise new headlines show from the next pass
}
window.addEventListener("resize", fitTv);

function showSignin(message = "") {
  $("app").hidden = true; $("signin").hidden = false; $("save").hidden = true; $("cancel").hidden = true; document.body.classList.remove("signed-in");
  $("repoName").textContent = CONFIG.repo; $("signinMsg").textContent = message;
  setStatus("");
}

async function load() {
  if (!store.get(TOKEN_KEY)) return showSignin();
  setStatus("Loading…");
  let res;
  try { res = await github("GET"); } catch (e) { setStatus("Could not reach GitHub: " + e.message, "err"); return; }
  if (res.status === 401) return showSignin("That token was rejected (expired or revoked). Paste a new one.");
  // GitHub answers 404 (not 403) when a token can't see a private repo. board.json always
  // exists in the data repo, so treat 404 as "wrong token" rather than starting from an
  // empty board that a save would then write over the real notes.
  if (res.status === 403 || res.status === 404) {
    store.del(TOKEN_KEY);
    return showSignin(`This token can't see ${CONFIG.repo}. Edit it on GitHub: Repository access → Only select repositories → ${CONFIG.repo.split("/")[1]} (the private data repo, not homeboard-panel), Contents: Read and write. Then sign in again.`);
  }
  let board = {};
  if (res.status === 200) { sha = res.json.sha; board = JSON.parse(fromB64(res.json.content)); }
  else { setStatus("GitHub error " + res.status, "err"); return; }
  savedBoard = board; state = cleanBoard(board);
  $("signin").hidden = true; $("app").hidden = false; $("save").hidden = false; $("cancel").hidden = false; setDirty(false); document.body.classList.add("signed-in");
  $("pubRepo").textContent = `${CONFIG.repo}/${CONFIG.path}`;
  $("pubWhen").textContent = board.updated ? "· last saved " + new Date(board.updated).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
  fitTv(); renderAll();
  setStatus(board.updated ? "Up to date" : "");
  loadTvData();
  loadOnThisDay();
  restartSpot();
}

async function save() {
  const board = { ...cleanBoard(state), updated: new Date().toISOString() };
  $("save").disabled = true; $("cancel").disabled = true; setStatus("Saving…");
  let res;
  try {
    res = await github("PUT", { message: "Update HomeBoard notes", content: toB64(JSON.stringify(board, null, 2) + "\n"), ...(sha ? { sha } : {}) });
  } catch (e) { setDirty(true); setStatus("Save failed: " + e.message, "err"); return; }
  if (res.status === 200 || res.status === 201) {
    sha = res.json.content.sha; savedBoard = board; state = cleanBoard(board); setDirty(false);
    $("pubWhen").textContent = "· last saved " + new Date(board.updated).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    renderAll();
    setStatus("Saved. The TV picks it up within about 30 seconds.", "ok");
    setTimeout(() => { if (!dirty) setStatus("Up to date"); }, 4000);
  } else if (res.status === 409 || res.status === 422) {
    setDirty(true);
    setStatus("Changed on another device since you opened it.", "err");
    if (confirm("The notes were changed on another device. Load the latest version? (Your unsaved edits here will be lost.)")) load();
  } else if (res.status === 401 || res.status === 403 || res.status === 404) {
    setDirty(true);
    const why = res.json && res.json.message ? ` GitHub says: "${res.json.message}".` : "";
    setStatus(`Save refused (${res.status}).${why} This token can read but not write: give it Contents: Read and write on ${CONFIG.repo} (or sign out and use a panel token, not the TV's read-only one).`, "err");
  } else { setDirty(true); setStatus("Save failed: GitHub error " + res.status, "err"); }
}

$("save").onclick = save;
$("cancel").onclick = cancelChanges;
$("addEvent").onclick = addEvent;
$("clearPast").onclick = () => { state.notes = state.notes.filter((n) => !isPast(n)); renderNotes(); markDirty(); };
$("speed").addEventListener("change", () => { state.settings.ticker.speed = $("speed").value; markDirty(); });
$("tickers").addEventListener("input", () => {
  state.settings.spotlight.tickers = $("tickers").value.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean).slice(0, 6);
  markDirty();
});
$("spotSecs").addEventListener("change", () => { state.settings.spotlight.seconds = +$("spotSecs").value; markDirty(); restartSpot(); });
$("sky").addEventListener("change", () => { state.settings.sky = $("sky").value; markDirty(); renderSky(); });
$("tvRefresh").onclick = () => loadTvData();
$("msgText").addEventListener("input", editMessage);
$("msgText").addEventListener("blur", () => renderMessage());
$("msgFor").addEventListener("change", () => { if (state.message) editMessage(); });
$("msgClear").onclick = () => { $("msgText").value = ""; editMessage(); };
$("nightOn").addEventListener("change", () => { state.settings.night.enabled = $("nightOn").checked; renderNightSettings(); markDirty(); });
for (const [id, key] of [["nightStart", "start"], ["nightEnd", "end"]])
  $(id).addEventListener("change", () => { if (clockMin($(id).value) >= 0) { state.settings.night[key] = $(id).value; markDirty(); } else renderNightSettings(); });
$("nightPreview").onclick = () => { tv.previewNight = !tv.previewNight; $("nightPreview").setAttribute("aria-pressed", String(tv.previewNight)); renderTv(); };
for (const [id, key] of [["locName", "name"], ["locLat", "latitude"], ["locLon", "longitude"]]) {
  $(id).addEventListener("input", () => { state.location[key] = $(id).value; markDirty(); });
  if (key !== "name") $(id).addEventListener("change", loadTvData);
}
$("signinBtn").onclick = async () => {
  const token = $("tokenInput").value.trim();
  if (!token) return;
  store.set(TOKEN_KEY, token); $("tokenInput").value = "";
  await load();
};
$("tokenInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("signinBtn").click(); });
$("signout").onclick = () => { if (dirty && !confirm("Discard unsaved changes and sign out?")) return; store.del(TOKEN_KEY); setDirty(false); showSignin("Signed out. The token was removed from this browser."); };
document.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); if (dirty) save(); } });
window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });
buildTvLayers();
requestAnimationFrame(tickCrawl);
// Spotlight rotates like the TV (Seconds per module)
let spotTimer = null;
function restartSpot() {
  clearInterval(spotTimer);
  spotTimer = setInterval(() => { tv.spotIdx++; if (spotModules()[tv.spotIdx % Math.max(1, spotModules().length)] === "onthisday") tv.otdOffset++; renderTv(); },
                          (state.settings.spotlight.seconds || 45) * 1000);
}
restartSpot();
setInterval(() => { if (new Date().getSeconds() === 0) { renderTv(); if (!$("app").hidden) renderMessage(); } }, 1000);
setInterval(() => { const v = notesRows(); if (v.pages > 1 && v.page !== lastNotesPage && !nightActive()) renderTv(); }, 1000);
setInterval(() => { if (!$("app").hidden) loadAlerts(); }, 5 * 60 * 1000);
load();

// ---------- Installable app: the browser's own Install / Add to Home Screen ----------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
