/* Pflanzen-App (PWA). Alle Daten bleiben auf dem Gerät (localStorage + IndexedDB). */
'use strict';

const KEY = 'pflanzen.v1';
const PLANTNET = 'https://my-api.plantnet.org';
const VERSION = 'Version 23 (11.10.2026)';
const $ = (s, r = document) => r.querySelector(s);
const view = $('#view');
const titleEl = $('#title');

/* ---------- Hilfsfunktionen ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const pad = n => String(n).padStart(2, '0');
const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => fmt(new Date());
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return fmt(d); };
const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
const fmtDE = s => s ? parse(s).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '–';

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

/* ---------- Speicher ---------- */
const defaults = () => ({ plants: [], wishlist: [], settings: { plantnetKey: '', proxy: '', winter: true, anthropicKey: '', aiModel: 'claude-sonnet-5-5', erkennung: 'beide', theme: 'auto', aiUsage: { calls: 0, inTok: 0, outTok: 0, usd: 0 } } });
let state = defaults();
function load() {
  try { const raw = localStorage.getItem(KEY); if (raw) state = { ...defaults(), ...JSON.parse(raw) }; }
  catch (e) { console.warn('Laden fehlgeschlagen', e); }
  state.settings = { ...defaults().settings, ...state.settings };
  normPhotos();
}
function normPhotos() { for (const p of state.plants || []) { if (!Array.isArray(p.photos)) p.photos = p.photo ? [p.photo] : []; if (p.photo && !p.photos.includes(p.photo)) p.photos.unshift(p.photo); if (!p.photo && p.photos.length) p.photo = p.photos[0]; } }
const coverOf = p => p.crop || p.photo || '';
async function dropCrop(p) { if (p.crop) { try { await delPhoto(p.crop); } catch {} p.crop = ''; } }
const photosOf = p => (p.photos && p.photos.length ? p.photos : (p.photo ? [p.photo] : []));
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch (e) { toast('Speichern fehlgeschlagen (Speicher voll?)'); }
}

/* Fotos in IndexedDB */
let dbp;
function idb() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('pflanzen-fotos', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('photos');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function idbOp(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('photos', mode); const out = fn(tx.objectStore('photos'));
    tx.oncomplete = () => res(out && 'result' in out ? out.result : undefined); tx.onerror = () => rej(tx.error);
  });
}
const putPhoto = async blob => { const id = uid(); await idbOp('readwrite', s => s.put(blob, id)); return id; };
const getPhoto = id => idbOp('readonly', s => s.get(id));
const delPhoto = id => idbOp('readwrite', s => s.delete(id));
const urlCache = new Map();
async function photoURL(id) {
  if (urlCache.has(id)) return urlCache.get(id);
  const b = await getPhoto(id); if (!b) return null;
  const u = URL.createObjectURL(b); urlCache.set(id, u); return u;
}
async function fillPhotos(root = view) {
  for (const img of root.querySelectorAll('img[data-photo]')) {
    const u = await photoURL(img.dataset.photo); if (u) img.src = u;
  }
}

async function shrink(file, maxSide, quality = 0.85) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { bmp = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); }); }
  const w = bmp.width, h = bmp.height, k = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(res, 'image/jpeg', quality));
}

/* ---------- Pflanzendatenbank ---------- */
let DB = [];
async function loadDB() {
  try { const r = await fetch('data/plants.json'); DB = (await r.json()).plants || []; }
  catch (e) { console.warn('Pflanzendaten nicht geladen', e); }
}
const dbById = id => DB.find(p => p.id === id);
function dbSearch(q) {
  q = q.trim().toLowerCase(); if (q.length < 2) return [];
  const rank = p => {
    const names = [p.name, p.latin, ...(p.aliases || [])].map(x => x.toLowerCase());
    if (names.some(x => x === q)) return 0;
    if (names.some(x => x.startsWith(q))) return 1;
    if (names.some(x => x.includes(q))) return 2;
    return 9;
  };
  return DB.map(p => [rank(p), p]).filter(r => r[0] < 9).sort((a, b) => a[0] - b[0]).map(r => r[1]);
}
function dbMatch(sci) {
  const s = (sci || '').toLowerCase(); if (!s) return null;
  const genus = s.split(' ')[0];
  let exact = DB.find(p => { const l = p.latin.toLowerCase(); return s.startsWith(l) || l.startsWith(s); });
  if (exact) return { entry: exact, exact: true };
  const byAlias = DB.find(p => (p.aliases || []).some(a => a.toLowerCase() === s || s.startsWith(a.toLowerCase())));
  if (byAlias) return { entry: byAlias, exact: true };
  const gen = DB.find(p => p.latin.toLowerCase().split(' ')[0] === genus);
  return gen ? { entry: gen, exact: false } : null;
}

/* ---------- Pflegelogik ---------- */
const isWinter = () => { const m = new Date().getMonth(); return m === 10 || m === 11 || m === 0 || m === 1; };
function waterInterval(p) {
  const base = Number(p.waterDays) || 7;
  return state.settings.winter && p.location !== 'aussen' && isWinter() ? Math.round(base * 1.5) : base;
}
function nextWater(p) { return p.lastWatered ? addDays(p.lastWatered, waterInterval(p)) : today(); }
function nextFert(p) {
  if (!p.fertDays) return null;
  const m = new Date().getMonth();
  if (m < 2 || m > 8) return null; // Winterpause: nicht düngen
  return p.lastFert ? addDays(p.lastFert, Number(p.fertDays)) : today();
}
function statusBadge(date, label) {
  const d = diffDays(today(), date);
  if (d < 0) return `<span class="badge late">${label}: ${-d} T. überfällig</span>`;
  if (d === 0) return `<span class="badge due">${label}: heute</span>`;
  return `<span class="badge ok">${label}: in ${d} T.</span>`;
}
function toxClass(v) { return v === 'ungiftig' ? 'ok' : (v === 'leicht giftig' ? 'mild' : 'tox'); }
function toxBlock(e) {
  if (!e) return `<div class="warnbox">Keine Giftigkeits-Daten zu dieser Pflanze. Im Zweifel nicht anknabbern lassen und bei Verdacht Tierarzt oder Vergiftungsinformationszentrale fragen.</div>`;
  const bad = [e.katze, e.hund].some(v => v !== 'ungiftig');
  return `<div class="card">
    <div class="name">Giftigkeit</div>
    <p><span class="badge ${toxClass(e.katze)}">Katze: ${esc(e.katze)}</span>
       <span class="badge ${toxClass(e.hund)}">Hund: ${esc(e.hund)}</span></p>
    <p class="muted">Menschen: ${e.mensch ? esc(e.mensch) : 'keine Daten in dieser App.'}</p>
    ${bad ? '<p class="muted">Für Haustiere und Kleinkinder unerreichbar aufstellen.</p>' : ''}
    <p class="hint">Richtwerte nach ASPCA-Liste, nicht einzeln geprüft. Kein Ersatz für Tierarzt oder Giftnotruf (Österreich: Vergiftungsinformationszentrale, 01 406 43 43).</p>
  </div>`;
}

function applyTheme() {
  const t = (state.settings && state.settings.theme) || 'auto', r = document.documentElement;
  if (t === 'light' || t === 'dark') r.setAttribute('data-theme', t); else r.removeAttribute('data-theme');
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = dark ? '#1b1b1d' : '#f4f4f1';
}
applyTheme();

/* ---------- Router ---------- */
const routes = {};
function route() {
  const parts = (location.hash.slice(1) || 'sammlung').split('/');
  const name = parts[0];
  const tabKey = ['pflanze', 'neu', 'bearbeiten'].includes(name) ? 'sammlung' : name === 'scan' ? (parts[1] === 'krank' ? 'diagnose' : 'scan') : ['einstellungen', 'giftig', 'mehr'].includes(name) ? 'mehr' : name;
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tabKey));
  (routes[name] || routes.sammlung)(parts.slice(1));
  window.scrollTo(0, 0);
}
const go = h => { location.hash = h; };
const render = (title, html, act = '') => { titleEl.textContent = title; $('#topact').innerHTML = act; view.innerHTML = html; fillPhotos(); };
const LEAF = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21v-8M12 13c0-4-3-6-7-6 0 4 3 6 7 6zM12 13c0-3.500 2.500-5.500 6-5.500 0 3.500-2.500 5.500-6 5.500z"/></svg>';
const thumb = p => coverOf(p) ? `<img class="thumb" data-photo="${esc(coverOf(p))}" alt="">` : `<div class="thumb" style="color:var(--muted)">${LEAF}</div>`;

routes.heute = () => go('sammlung');

const fertDone = p => { const n = nextFert(p); return !!n && diffDays(today(), n) > 0; };
const fertSwitch = p => nextFert(p) === null ? '' : `<label class="sw" aria-label="Gedüngt"><input type="checkbox" data-fertsw="${p.id}" ${fertDone(p) ? 'checked' : ''}><span></span></label>`;

/* ---------- Sammlung ---------- */
routes.sammlung = () => {
  const list = [...state.plants].sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const fert = list.filter(p => { const n = nextFert(p); return n && diffDays(today(), n) <= 0; });
  if (navigator.setAppBadge) { try { fert.length ? navigator.setAppBadge(fert.length) : navigator.clearAppBadge(); } catch {} }
  const fstat = p => { const n = nextFert(p); if (!n) return ''; const d = diffDays(today(), n); return d <= 0 ? '<span class="due-t">Düngen fällig</span>' : `Düngen in ${d} T.`; };
  const item = p => `<div class="lrow"><a class="lmain" href="#pflanze/${p.id}">${thumb(p)}
    <div class="grow"><div class="name">${esc(p.name)}</div>
    ${p.latin ? `<div class="sub">${esc(p.latin)}</div>` : ''}
    <div class="sub">Gießen alle ${waterInterval(p)} Tage${fstat(p) ? ' · ' + fstat(p) : ''}</div></div></a>${fertSwitch(p)}</div>`;
  let h = '';
  if (!list.length) h = `<div class="empty">Noch keine Pflanzen.<br><br><a class="btn" href="#neu">Pflanze hinzufügen</a></div>`;
  else {
    const rooms = [...new Set(list.map(p => p.room || ''))].sort((x, y) => (x === '') - (y === '') || x.localeCompare(y, 'de'));
    h = rooms.map(r => `${rooms.length > 1 || r ? `<h2 class="rh">${esc(r || 'Ohne Raum')}</h2>` : ''}<div class="group">${list.filter(p => (p.room || '') === r).map(item).join('')}</div>`).join('');
  }
  render('Pflanzen', h, '<a class="plus" href="#neu" aria-label="Neue Pflanze">+</a>');
};



/* ---------- Gesundheitsverlauf ---------- */
function healthCard(p) {
  const hs = p.health || [];
  let h = '<h2 class="rh">Gesundheit</h2><div class="group">';
  if (!hs.length) h += '<div class="lrow"><span class="l muted">Noch keine Prüfung gespeichert.</span></div>';
  else h += hs.map((x, i) => [x, i]).reverse().map(([x, i]) => {
    const dd = x.data || {}, gb = AI.S(dd.gesamtbild) || '?';
    const cls = /gesund/i.test(gb) && !/auff|prob/i.test(gb) ? 'ok' : (/deutlich/i.test(gb) ? 'late' : 'due');
    const top = (AI.A(dd.ursachen).filter(u => u && typeof u === 'object' && !/^niedrig/i.test(AI.S(u.wahrscheinlichkeit)))[0] || {}).name;
    return `<details class="hrow"><summary>${x.thumb ? `<img class="hth" data-photo="${esc(x.thumb)}" alt="">` : ''}<span class="hmain"><b>${fmtDE(x.d)}</b><span class="sub">${top ? esc(AI.S(top)) : 'keine eindeutige Ursache'}</span></span><span class="badge ${cls}">${esc(gb)}</span></summary>
      <div class="hbody">${x.note ? `<p class="sub">Notiz: ${esc(x.note)}</p>` : ''}${AI.renderHealth(dd)}<div class="actions"><button class="small danger" data-hdel="${p.id}:${i}">Eintrag löschen</button></div></div></details>`;
  }).join('');
  return h + `<div class="lrow"><a class="grow" style="color:var(--green);text-decoration:none;font-weight:500" href="#scan/krank/${p.id}">Neue Gesundheitsprüfung</a></div></div>`;
}

/* ---------- Fotos einer Pflanze ---------- */
let selPhoto = null;
function galleryCard(p) {
  const ph = photosOf(p);
  if (selPhoto && !ph.includes(selPhoto)) selPhoto = null;
  let h = '<h2 class="rh">Fotos</h2><div class="group pad">';
  if (ph.length) h += `<div class="thumbs">${ph.map(id => `<button type="button" class="ph ${id === selPhoto ? 'sel' : ''}" data-phsel="${id}" aria-label="Foto wählen"><img src="" data-photo="${esc(id)}" alt="">${id === p.photo ? '<span class="cov">Titelbild</span>' : ''}</button>`).join('')}</div>`;
  if (selPhoto) h += `<img class="big" data-photo="${esc(selPhoto)}" alt="" style="max-height:340px;margin-top:8px">
    <div class="actions">${selPhoto !== p.photo ? `<button class="small" data-phcover="${p.id}">Als Titelbild</button>` : `<button class="small" data-crop="${p.id}">Ausschnitt anpassen</button>`}
    <button class="small danger" data-phdel="${p.id}">Löschen</button><button class="small sec" data-phsel="">Schließen</button></div>`;
  h += `<div class="actions"><div class="pick"><span class="btn small sec">Foto aufnehmen</span><input data-phadd="${p.id}" type="file" accept="image/*" capture="environment" aria-label="Foto aufnehmen"></div>
    <div class="pick"><span class="btn small sec">Aus Galerie</span><input data-phadd="${p.id}" type="file" accept="image/*" multiple aria-label="Fotos aus Galerie wählen"></div></div></div>`;
  return h;
}


/* ---------- Titelbild: Ausschnitt verschieben und zoomen ---------- */
async function openCrop(id) {
  const p = state.plants.find(x => x.id === id); if (!p || !p.photo) return;
  const blob = await getPhoto(p.photo); if (!blob) return toast('Foto nicht gefunden');
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const iw = bmp.width, ih = bmp.height, url = URL.createObjectURL(blob);
  const ov = document.createElement('div'); ov.className = 'cropov';
  ov.innerHTML = `<div class="cropbox"><div class="name" style="text-align:center">Titelbild anpassen</div>
    <p class="hint" style="text-align:center">Mit dem Finger verschieben, mit dem Regler vergrößern.</p>
    <div class="cropview"><img src="${url}" alt="" draggable="false"></div>
    <input type="range" id="cz" min="1" max="4" step="0.01" value="1" aria-label="Zoom">
    <div class="actions" style="justify-content:center"><button class="sec" id="cc">Abbrechen</button>${p.crop ? '<button class="sec" id="cr">Zurücksetzen</button>' : ''}<button id="cs">Speichern</button></div></div>`;
  document.body.appendChild(ov);
  const view = ov.querySelector('.cropview'), img = view.querySelector('img'), W = view.clientWidth, H = view.clientHeight;
  let z = 1, ox = 0, oy = 0; const s0 = Math.max(W / iw, H / ih);
  const clamp = () => { const mx = Math.max(0, (iw * s0 * z - W) / 2), my = Math.max(0, (ih * s0 * z - H) / 2); ox = Math.min(mx, Math.max(-mx, ox)); oy = Math.min(my, Math.max(-my, oy)); };
  const draw = () => { clamp(); const s = s0 * z; img.style.width = iw * s + 'px'; img.style.height = ih * s + 'px'; img.style.left = (W / 2 + ox - iw * s / 2) + 'px'; img.style.top = (H / 2 + oy - ih * s / 2) + 'px'; };
  draw();
  let drag = null;
  view.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, ox, oy }; view.setPointerCapture(e.pointerId); });
  view.addEventListener('pointermove', e => { if (!drag) return; ox = drag.ox + e.clientX - drag.x; oy = drag.oy + e.clientY - drag.y; draw(); });
  view.addEventListener('pointerup', () => { drag = null; }); view.addEventListener('pointercancel', () => { drag = null; });
  ov.querySelector('#cz').addEventListener('input', e => { z = Number(e.target.value); draw(); });
  const close = () => { URL.revokeObjectURL(url); ov.remove(); };
  ov.querySelector('#cc').onclick = close;
  const rs = ov.querySelector('#cr'); if (rs) rs.onclick = async () => { await dropCrop(p); save(); close(); toast('Zurückgesetzt'); route(); };
  ov.querySelector('#cs').onclick = async () => {
    const s = s0 * z, sx = (iw * s / 2 - ox - W / 2) / s, sy = (ih * s / 2 - oy - H / 2) / s, sw = W / s, sh = H / s;
    const cv = document.createElement('canvas'); cv.width = 1000; cv.height = Math.round(1000 * H / W);
    cv.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
    const out = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.85));
    if (!out) return toast('Speichern fehlgeschlagen');
    await dropCrop(p); p.crop = await putPhoto(out); save(); close(); toast('Titelbild angepasst'); route();
  };
}

/* ---------- Detail ---------- */
routes.pflanze = ([id]) => {
  const p = state.plants.find(x => x.id === id); if (!p) return go('sammlung');
  const e = dbById(p.dbId);
  const nf = nextFert(p);
  let h = coverOf(p) ? `<img class="big cover" data-photo="${esc(coverOf(p))}" alt="">` : '';
  if (p.latin) h += `<p class="muted" style="margin:2px 4px 8px">${esc(p.latin)}</p>`;
  h += `<div class="group">
    <div class="lrow"><span class="l">Raum</span><select class="inl" data-roomsel="${p.id}"><option value="">Kein Raum</option>${roomList().map(r => `<option ${r === p.room ? 'selected' : ''}>${esc(r)}</option>`).join('')}<option value="__neu">Neuer Raum …</option></select></div>
    <div id="roomnewbox" class="lrow" style="display:none"><input id="roomnew" class="grow" placeholder="Name des neuen Raums" autocomplete="off"><button class="small" data-roomnew="${p.id}">OK</button></div>
    <div class="lrow"><span class="l">Gießen</span><span class="muted">alle ${waterInterval(p)} Tage${waterInterval(p) !== Number(p.waterDays) ? ' (Winter)' : ''}</span></div>
    <div class="lrow"><div class="l">Düngen<div class="sub">${p.fertDays ? `alle ${p.fertDays} Tage, März bis September` : 'keine Erinnerung'}</div></div>
      <label class="sw" aria-label="Düngen aktiv"><input type="checkbox" data-fertenable="${p.id}" ${p.fertDays ? 'checked' : ''}><span></span></label></div>
    ${p.fertDays ? `<div class="lrow"><div class="l">Gedüngt<div class="sub">${nf ? (fertDone(p) ? 'Zuletzt ' + fmtDE(p.lastFert) + ', nächstes Mal ' + fmtDE(nf) : 'Jetzt fällig') : 'Düngepause bis März'}</div></div>${fertSwitch(p)}</div>
    <div class="lrow"><span class="l">Abstand in Tagen</span><input class="inl num" type="number" min="1" max="180" value="${esc(p.fertDays)}" data-fertdays="${p.id}"></div>` : ''}
    ${p.notes ? `<div class="lrow"><span class="l" style="white-space:pre-wrap">${esc(p.notes)}</span></div>` : ''}</div>`;
  if (e && p.dbApprox) h += `<div class="warnbox">Werte stammen von einer verwandten Art (${esc(e.name)}). Nur ein Anhaltspunkt.</div>`;
  h += mergedCard(p, e);
  h += healthCard(p);
  h += galleryCard(p);
  h += `<div class="foot"><a href="#bearbeiten/${p.id}">Bearbeiten</a><button class="link danger" data-del="${p.id}">Löschen</button></div>`;
  render(p.name, h);
};

const BASE_ROOMS = ['Wohnzimmer', 'Schlafzimmer', 'Küche', 'Bad', 'Arbeitszimmer', 'Flur', 'Balkon', 'Garten'];
const roomList = () => [...new Set([...BASE_ROOMS, ...state.plants.map(p => p.room).filter(Boolean)])];

/* ---------- Formular ---------- */
function formView(p, fromScan) {
  const isNew = !p.id;
  const opts = DB.map(d => `<option value="${d.id}" ${d.id === p.dbId ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
  let formScanFile = null, formBusy = false, formResults = [];
  const scanCard = isNew ? `<div class="card"><div class="name">Per Foto erkennen</div>
    <div class="actions">
      <div class="pick"><span class="btn small">Foto aufnehmen</span><input id="fcam" type="file" accept="image/*" capture="environment" aria-label="Foto aufnehmen"></div>
      <div class="pick"><span class="btn sec small">Aus Galerie</span><input id="fgal" type="file" accept="image/*" aria-label="Foto aus Galerie wählen"></div>
    </div><div id="fres"></div></div>` : '';
  render(isNew ? 'Neue Pflanze' : 'Bearbeiten', `${scanCard}<form id="f">
    <label>Vorlage</label>
    <select name="dbId"><option value="">– eigene Pflanze –</option>${opts}</select>
    <label>Name</label><input name="name" required value="${esc(p.name || '')}" autocomplete="off">
    <label>Botanischer Name</label><input name="latin" value="${esc(p.latin || '')}">
    <label>Standort</label><select name="location"><option value="innen" ${p.location !== 'aussen' ? 'selected' : ''}>Drinnen</option><option value="aussen" ${p.location === 'aussen' ? 'selected' : ''}>Draußen</option></select>
    <label>Gießen alle (Tage)</label><input name="waterDays" type="number" min="1" max="90" value="${esc(p.waterDays ?? 7)}">
    <input name="fertDays" type="hidden" value="${esc(p.fertDays ?? '')}"><input name="lastFert" type="hidden" value="${esc(p.lastFert || '')}">
    <label>Notizen</label><textarea name="notes">${esc(p.notes || '')}</textarea>
    <label>${isNew ? 'Foto' : 'Neues Titelbild'}</label>${coverOf(p) ? `<img class="thumb" data-photo="${esc(coverOf(p))}" alt="" style="margin-bottom:6px">` : ''}
    <div class="pick"><span class="btn sec small" id="photolbl">Foto wählen</span><input name="photo" type="file" accept="image/*" aria-label="Foto wählen"></div>
    <div class="actions"><button type="submit">Speichern</button><a class="btn sec" href="#${isNew ? 'sammlung' : 'pflanze/' + p.id}">Abbrechen</a></div>
  </form>`);
  const f = $('#f');
  f.elements.photo.addEventListener('change', ev => { const n = ev.target.files[0]; $('#photolbl').textContent = n ? 'Foto gewählt' : 'Foto wählen'; });
  if (isNew) {
    const pickForm = async e => {
      const file = e.target.files && e.target.files[0]; e.target.value = ''; if (!file || formBusy) return;
      formScanFile = file; formBusy = true; const out = $('#fres');
      out.innerHTML = '<p><span class="spin"></span> Erkenne …</p>';
      try {
        const L = await lookupAll(file); formResults = L.items;
        out.innerHTML = formResults.length
          ? '<p class="muted">Passenden Vorschlag antippen:</p>' + L.note.map(n => `<p class="hint">${esc(n)}</p>`).join('') + formResults.map((r, i) => `<button type="button" class="sec" style="display:block;width:100%;text-align:left;margin:6px 0" data-fpick="${i}">${esc((r.species.commonNames || [])[0] || r.species.scientificNameWithoutAuthor)}<br><span class="hint">${esc(r.species.scientificNameWithoutAuthor)} · ${esc(r.label)}</span></button>`).join('')
          : '<p class="muted">Keine Pflanze erkannt. Anderes Foto versuchen oder die Felder selbst ausfüllen.</p>';
      } catch (err) { out.innerHTML = `<div class="warnbox">${lookupErrorHTML(err)}</div>`; }
      finally { formBusy = false; }
    };
    $('#fcam').addEventListener('change', pickForm);
    $('#fgal').addEventListener('change', pickForm);
    $('#fres').addEventListener('click', ev => {
      const btn = ev.target.closest('button[data-fpick]'); if (!btn) return;
      const r = formResults[Number(btn.dataset.fpick)]; const sci = r.species.scientificNameWithoutAuthor;
      const common = (r.species.commonNames || [])[0] || sci; const m = dbMatch(sci); const el = f.elements;
      el.name.value = common; el.latin.value = sci;
      p.dbId = m ? m.entry.id : ''; p.dbApprox = !!(m && !m.exact);
      el.dbId.value = p.dbId;
      if (m) { el.waterDays.value = m.entry.wasser_tage; el.fertDays.value = m.entry.duenger_tage; }
      el.notes.value = p.dbApprox ? `Pflegewerte geschätzt nach verwandter Art (${m.entry.name}).` : '';
      toast('Formular ausgefüllt'); el.name.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }
  f.dbId.addEventListener('change', () => {
    const el = f.elements, e = dbById(el.dbId.value); if (!e) return;
    if (!el.name.value) el.name.value = e.name; el.latin.value = e.latin;
    el.waterDays.value = e.wasser_tage; el.fertDays.value = e.duenger_tage;
  });
  f.addEventListener('submit', async ev => {
    ev.preventDefault();
    const fd = new FormData(f);
    const rec = isNew ? { id: uid(), created: today(), log: [] } : p;
    const origDbId = p.dbId, origApprox = !!p.dbApprox;
    Object.assign(rec, {
      name: fd.get('name').trim(), latin: fd.get('latin').trim(), dbId: fd.get('dbId') || '',
      location: fd.get('location'), room: p.room || '', waterDays: Number(fd.get('waterDays')) || 7,
      fertDays: fd.get('fertDays') ? Number(fd.get('fertDays')) : '',
      lastFert: fd.get('lastFert') || '', notes: fd.get('notes').trim()
    });
    if (!rec.dbId) { const m = dbMatch(rec.latin); if (m && m.exact) rec.dbId = m.entry.id; }
    rec.dbApprox = origApprox && rec.dbId === origDbId;
    const file = fd.get('photo');
    if (file && file.size) {
      try { const b = await shrink(file, 900, 0.8); const nid = await putPhoto(b); await dropCrop(rec); rec.photos = [...photosOf(rec), nid]; rec.photo = nid; }
      catch (e) { toast('Foto konnte nicht gespeichert werden'); }
    } else if (formScanFile) {
      try { rec.photo = await putPhoto(await shrink(formScanFile, 900, 0.8)); rec.photos = [rec.photo]; } catch (e) { toast('Foto konnte nicht gespeichert werden'); }
    } else if (fromScan && fromScan.photo) { rec.photo = fromScan.photo; rec.photos = [fromScan.photo]; }
    if (isNew) state.plants.push(rec);
    save(); toast('Gespeichert'); go('pflanze/' + rec.id);
  });
}
routes.neu = () => { const pre = window.__prefill || {}; window.__prefill = null; formView(pre, pre); };
routes.bearbeiten = ([id]) => { const p = state.plants.find(x => x.id === id); if (!p) return go('sammlung'); formView(p); };

/* ---------- Scan / Nachschlagen ---------- */
let scanFile = null, scanBusy = false;
routes.scanPlant = () => {
  scanFile = null;
  const noKey = !state.settings.plantnetKey && !state.settings.anthropicKey;
  render('Scan', `${modeTabs('pflanze')}<div class="group pad">
    ${noKey ? '<div class="warnbox">Kein Schlüssel hinterlegt. <a href="#einstellungen">In den Einstellungen eintragen</a>.</div>' : ''}
    <img id="scanprev" class="big" style="display:none;margin:0 0 10px" alt="">
    <div class="actions" style="margin-top:0">
      <div class="pick grow"><span class="btn block">Foto aufnehmen</span><input id="scancam" type="file" accept="image/*" capture="environment" aria-label="Foto aufnehmen"></div>
      <div class="pick grow"><span class="btn sec block">Aus Galerie</span><input id="scangal" type="file" accept="image/*" aria-label="Foto aus Galerie wählen"></div>
    </div>
    <div id="scanres"></div></div>`);
  const pick = e => {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (!f) return;
    scanFile = f;
    const prev = $('#scanprev'); prev.src = URL.createObjectURL(f); prev.style.display = 'block';
    $('#scanres').innerHTML = '';
    identify();
  };
  $('#scancam').addEventListener('change', pick);
  $('#scangal').addEventListener('change', pick);
};

routes.giftig = () => {
  render('Giftig-Check', `<div class="card"><div class="name">Giftig oder nicht?</div>
    <input id="q" placeholder="z. B. Monstera, Lilie, Basilikum" autocomplete="off">
    <div id="qres"></div></div>`);
  $('#q').addEventListener('input', e => {
    const r = dbSearch(e.target.value);
    $('#qres').innerHTML = !e.target.value.trim() ? '' : (r.length ? r.slice(0, 8).map(p => `<div class="card"><div class="name">${esc(p.name)}</div><div class="muted">${esc(p.latin)}</div>
      <span class="badge ${toxClass(p.katze)}">Katze: ${esc(p.katze)}</span><span class="badge ${toxClass(p.hund)}">Hund: ${esc(p.hund)}</span>
      ${p.mensch ? `<p class="muted">Menschen: ${esc(p.mensch)}</p>` : ''}</div>`).join('') + '<p class="hint">Richtwerte nach ASPCA-Liste, nicht einzeln geprüft.</p>'
      : '<p class="muted">Nicht in der Liste. Das heißt nicht, dass die Pflanze sicher ist.</p>');
  });
};

async function plantnetLookup(file) {
  if (!state.settings.plantnetKey) { const e = new Error('Schlüssel fehlt'); e.code = 'nokey'; throw e; }
  let blob;
  try { blob = await shrink(file, 1024, 0.85); if (!blob) throw new Error(); }
  catch { throw new Error('Das Foto konnte nicht gelesen werden. Bitte ein anderes Foto versuchen.'); }
  const fd = new FormData(); fd.append('images', blob, 'foto.jpg'); fd.append('organs', 'auto');
  const base = (state.settings.proxy || PLANTNET).replace(/\/$/, '');
  const url = `${base}/v2/identify/all?api-key=${encodeURIComponent(state.settings.plantnetKey)}&lang=de&nb-results=3&include-related-images=false`;
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 30000);
  let res; try { res = await fetch(url, { method: 'POST', body: fd, signal: ctl.signal }); } finally { clearTimeout(to); }
  if (res.status === 404) return [];
  if (!res.ok) {
    let body = ''; try { body = (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 200); } catch {}
    if (res.status === 429) throw new Error('Tageslimit erreicht. Morgen wieder versuchen.');
    const k = state.settings.plantnetKey;
    const keyInfo = `Gespeicherter Schlüssel: ${k.length} Zeichen, Anfang „${k.slice(0, 4)}“, Ende „${k.slice(-4)}“.`;
    if (res.status === 401 || res.status === 403)
      throw new Error(`Pl@ntNet lehnt die Anfrage ab (Code ${res.status}). Antwort des Dienstes: „${body || 'leer'}“. ${keyInfo} Prüfe auf my.plantnet.org/settings/api-key: Schlüssel freigegeben, Domain martin290827-dev.github.io gespeichert, und es ist der private Schlüssel.`);
    throw new Error(`Fehler vom Dienst (Code ${res.status}). Antwort: „${body || 'leer'}“.`);
  }
  const data = await res.json();
  return (data.results || []).slice(0, 3);
}

/* Erkennung: Pl@ntNet, Claude oder beide */
const MIN_SCORE = 0.2; // Pl@ntNet-Vorschläge unter 20 % werden nicht angezeigt
async function claudeLookup(file) {
  if (!state.settings.anthropicKey) { const e = new Error('Schlüssel fehlt'); e.code = 'nokey'; throw e; }
  const blob = await shrink(file, 1024, 0.85);
  if (!blob) throw new Error('Das Foto konnte nicht gelesen werden.');
  const r = await AI.run('art', 'Bestimme die Pflanze auf dem Foto. Beachte: Zimmerpflanze, Gartenpflanze oder Wildpflanze in Mitteleuropa möglich.', [blob], 1200);
  const sc = { hoch: .85, mittel: .55, niedrig: .25 };
  return ((r.data && r.data.kandidaten) || []).slice(0, 3).filter(k => k && k.latein).map(k => ({
    src: 'claude', score: sc[k.sicherheit] || .25, label: 'Claude: Sicherheit ' + (k.sicherheit || 'niedrig'), why: k.begruendung || '', check: k.pruefen || '',
    species: { scientificNameWithoutAuthor: String(k.latein), commonNames: k.name_de ? [String(k.name_de)] : [], family: { scientificNameWithoutAuthor: '' } }
  }));
}
async function lookupAll(file) {
  const s = state.settings;
  let mode = s.erkennung || 'beide';
  if (mode === 'beide' && !s.anthropicKey) mode = 'plantnet';
  if (mode === 'beide' && !s.plantnetKey) mode = 'claude';
  const jobs = [];
  if (mode !== 'claude') jobs.push(plantnetLookup(file).then(r => r.map(x => ({ ...x, src: 'plantnet', label: 'Pl@ntNet: Sicherheit ' + Math.round(x.score * 100) + ' %' }))));
  if (mode !== 'plantnet') jobs.push(claudeLookup(file));
  const res = await Promise.allSettled(jobs);
  const raw = res.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
  const bad = res.filter(r => r.status === 'rejected').map(r => r.reason);
  if (!raw.length && bad.length) throw bad[0];
  const ok = raw.filter(x => x.src === 'claude' ? x.score >= .5 : x.score >= MIN_SCORE);
  const note = [];
  if (bad.length) note.push('Eine Quelle ist ausgefallen: ' + (bad[0].code === 'nokey' ? 'Schlüssel fehlt.' : String(bad[0].message || bad[0]).slice(0, 160)));
  const pn = ok.find(x => x.src === 'plantnet'), cl = ok.find(x => x.src === 'claude');
  if (pn && cl) {
    const g = x => x.species.scientificNameWithoutAuthor.toLowerCase().split(' ');
    const [a, b] = [g(pn), g(cl)];
    note.push(a[0] === b[0] && a[1] === b[1] ? 'Beide Quellen nennen dieselbe Art. Das erhöht die Verlässlichkeit.'
      : a[0] === b[0] ? 'Beide Quellen nennen dieselbe Gattung, aber verschiedene Arten. Merkmale prüfen.'
      : 'Die Quellen widersprechen sich. Nicht verlassen, Merkmale prüfen.');
  }
  return { items: ok, note };
}
function srcBadge(x) { return `<span class="badge ${x.src === 'claude' ? '' : (x.score > .6 ? 'ok' : 'due')}">${esc(x.label || '')}</span>`; }
function lookupErrorHTML(e) {
  if (e.code === 'nokey') return 'Für die Erkennung fehlt der Pl@ntNet-Schlüssel. <a href="#einstellungen">Unter „Mehr → Einstellungen“ eintragen</a>, danach das Foto erneut wählen.';
  if (e.name === 'AbortError') return 'Zeitüberschreitung nach 30 Sekunden. Netz prüfen und noch einmal versuchen.';
  if (e.code === 'nokey2') return esc(e.message);
  if (e instanceof TypeError) return 'Verbindung zu Pl@ntNet fehlgeschlagen (' + esc(e.message) + '). Kein Netz, oder der Browser blockiert die Anfrage. Wenn es dauerhaft passiert, melde dich bei Claude mit dieser Meldung.';
  return esc(e.message);
}

async function identify() {
  const out = $('#scanres'); if (!out || scanBusy) return;
  if (!scanFile) { out.innerHTML = '<div class="warnbox">Bitte zuerst ein Foto aufnehmen oder aus der Galerie wählen.</div>'; return; }
  scanBusy = true;
  out.innerHTML = '<p><span class="spin"></span> Erkenne …</p>';
  try {
    const L = await lookupAll(scanFile); const results = L.items;
    if (!results.length) { out.innerHTML = '<p class="muted">Keine sichere Erkennung. Anderes Foto versuchen (Blatt oder Blüte, gutes Licht).</p>'; return; }
    window.__scanResults = results;
    out.innerHTML = L.note.map(n => `<div class="warnbox">${esc(n)}</div>`).join('') + results.map((r, i) => {
      const sci = r.species.scientificNameWithoutAuthor, common = (r.species.commonNames || [])[0] || '';
      const m = dbMatch(sci);
      return `<div class="card"><div class="name">${esc(common || sci)}</div><div class="muted">${esc(sci)} · ${esc(r.species.family?.scientificNameWithoutAuthor || '')}</div>
      ${srcBadge(r)}${r.why ? `<p class="hint">${esc(r.why)}${r.check ? ' Prüfen: ' + esc(r.check) : ''}</p>` : ''}
      ${m ? `<span class="badge ${toxClass(m.entry.katze)}">Katze: ${esc(m.entry.katze)}</span><span class="badge ${toxClass(m.entry.hund)}">Hund: ${esc(m.entry.hund)}</span>${m.exact ? '' : '<p class="hint">Giftangabe gilt für verwandte Art derselben Gattung, nur Anhaltspunkt.</p>'}`
        : '<p class="hint">Keine Giftigkeits-Daten in der App.</p>'}
      <div class="actions"><button class="small" data-add="${i}">Zur Sammlung</button><button class="small sec" data-wish="${i}">Wunschliste</button></div></div>`;
    }).join('') + '<p class="hint">Pl@ntNet und/oder Claude. Bei geringer Sicherheit nicht verlassen, besonders bei Giftigkeit.</p>';
  } catch (e) {
    out.innerHTML = `<div class="warnbox">${lookupErrorHTML(e)}</div>`;
  } finally { scanBusy = false; }
}


/* ---------- KI: Krankheit und Unkraut per Foto, Pflanzen-Infos ---------- */
const modeTabs = mode => `<div class="seg">
  <a href="#scan" class="${mode === 'pflanze' ? 'on' : ''}">Pflanze</a>
  <a href="#scan/krank" class="${mode === 'krank' ? 'on' : ''}">Diagnose</a>
  <a href="#scan/unkraut" class="${mode === 'unkraut' ? 'on' : ''}">Unkraut</a></div>`;
const spinner = '<p><span class="spin"></span> Claude wertet aus … (bis zu 30 Sekunden)</p>';
function aiErrorHTML(e) {
  if (e.code === 'nokey') return 'Für diese Funktion fehlt der Claude-Schlüssel. <a href="#einstellungen">Unter „Mehr → Einstellungen“ eintragen</a>.';
  if (e.name === 'AbortError') return 'Zeitüberschreitung nach 90 Sekunden. Netz prüfen und noch einmal versuchen.';
  if (e instanceof TypeError) return 'Verbindung zu Claude fehlgeschlagen (' + esc(e.message) + '). Kein Netz, oder der Browser blockiert die Anfrage.';
  return esc(e.message);
}
const usageLine = u => u ? `<p class="hint">Verbrauch dieser Auswertung: ${u.inTok + u.outTok} Tokens, geschätzt ${(u.usd * 100).toFixed(2)} Cent.</p>` : '';

let aiFiles = [], aiBusy = false, aiLast = null;
routes.scan = ([mode, pid]) => (mode === 'krank' || mode === 'unkraut') ? aiScanView(mode, pid) : routes.scanPlant();

function aiScanView(mode, pid) {
  aiFiles = []; aiLast = null;
  const plant = pid ? state.plants.find(p => p.id === pid) : null;
  const health = mode === 'krank';
  const hasKey = !!state.settings.anthropicKey;
  render('Scan', `${modeTabs(mode)}<div class="card"><div class="name">${health ? 'Pflanzenkrankheit beurteilen' : 'Unkraut bestimmen'}</div>
    
    ${hasKey ? '' : '<div class="warnbox">Noch kein Claude-Schlüssel hinterlegt. <a href="#einstellungen">Unter „Mehr → Einstellungen“ eintragen</a>.</div>'}
    ${plant ? `<p>Pflanze: <b>${esc(plant.name)}</b></p>` : (health ? '<label>Welche Pflanze? (optional)</label><input id="aiplant" autocomplete="off">' : '<label>Wo wächst es? (optional)</label><input id="aiplace" placeholder="z. B. Beet, Rasen, Gehweg" autocomplete="off">')}
    <label>${health ? 'Was fällt dir auf? (optional)' : 'Weitere Hinweise (optional)'}</label><textarea id="ainote"></textarea>
    <div class="actions">
      <div class="pick"><span class="btn small">Foto aufnehmen</span><input id="aicam" type="file" accept="image/*" capture="environment" aria-label="Foto aufnehmen"></div>
      <div class="pick"><span class="btn sec small">Aus Galerie</span><input id="aigal" type="file" accept="image/*" aria-label="Foto aus Galerie wählen"></div>
    </div>
    <div id="aithumbs" class="thumbs"></div>
    <div class="actions"><button id="aigo" type="button">Auswerten</button></div><div id="aires"></div></div>`);
  const drawThumbs = () => {
    $('#aithumbs').innerHTML = aiFiles.map((f, i) => `<div class="tb"><img src="${URL.createObjectURL(f)}" alt=""><button type="button" class="small danger" data-airm="${i}">✕</button></div>`).join('');
    $('#aigo').textContent = aiFiles.length ? `Auswerten (${aiFiles.length} Foto${aiFiles.length > 1 ? 's' : ''})` : 'Auswerten';
  };
  const pick = e => {
    const f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return;
    if (aiFiles.length >= 3) return toast('Maximal 3 Fotos');
    aiFiles.push(f); drawThumbs();
  };
  $('#aicam').addEventListener('change', pick); $('#aigal').addEventListener('change', pick);
  $('#aithumbs').addEventListener('click', e => { const b = e.target.closest('button[data-airm]'); if (b) { aiFiles.splice(Number(b.dataset.airm), 1); drawThumbs(); } });
  $('#aigo').addEventListener('click', async () => {
    const out = $('#aires'); if (aiBusy) return;
    if (!aiFiles.length) { out.innerHTML = '<div class="warnbox">Bitte zuerst mindestens ein Foto aufnehmen oder wählen.</div>'; return; }
    aiBusy = true; out.innerHTML = spinner;
    try {
      const blobs = []; for (const f of aiFiles) { const b = await shrink(f, 1280, 0.85); if (!b) throw new Error('Ein Foto konnte nicht gelesen werden.'); blobs.push(b); }
      const note = ($('#ainote').value || '').trim().slice(0, 500);
      const name = plant ? plant.name : (($('#aiplant') || {}).value || '').trim().slice(0, 100);
      const place = ($('#aiplace') || {}).value ? $('#aiplace').value.trim().slice(0, 100) : '';
      const loc = plant ? (plant.location === 'aussen' ? 'draußen' : 'drinnen') : 'unbekannt';
      const text = health
        ? `Aufgabe: Gesundheitscheck einer Pflanze anhand von ${blobs.length} Foto(s). Pflanze laut Nutzer: ${name || 'unbekannt'}. Standort: ${loc}. Beobachtung des Nutzers: "${note || 'keine'}". Aktuelles Datum: ${today()} (Jahreszeit berücksichtigen).`
        : `Aufgabe: Unkraut bestimmen anhand von ${blobs.length} Foto(s). Fundort laut Nutzer: ${place || 'unbekannt'}. Hinweise des Nutzers: "${note || 'keine'}". Aktuelles Datum: ${today()}. Region: Österreich.`;
      const r = await AI.run(mode, text, blobs, 6000);
      aiLast = { mode, data: r.data, model: r.model, plantId: plant ? plant.id : null, note };
      out.innerHTML = (health ? AI.renderHealth(r.data) : AI.renderWeed(r.data)) + usageLine(r.use)
        + (health ? (plant ? `<div class="actions"><button type="button" data-aisave="1">Im Verlauf von „${esc(plant.name)}“ speichern</button></div>` : (state.plants.length ? `<div class="actions"><select id="aisel" style="flex:1"><option value="">Pflanze wählen …</option>${state.plants.map(q => `<option value="${q.id}">${esc(q.name)}</option>`).join('')}</select><button type="button" data-aisave="1">Speichern</button></div>` : '')) : '');
    } catch (e) { out.innerHTML = `<div class="warnbox">${aiErrorHTML(e)}</div>`; }
    finally { aiBusy = false; }
  });
}


/* ---------- Zusammengeführte Pflege-Karte (Liste + Claude) ---------- */
const normSp = x => String(x || '').toLowerCase().replace(/[×x]\s/g, '').trim().split(/\s+/).slice(0, 2).join(' ');
function mergedCard(p, e) {
  const d = p.aiInfo && p.aiInfo.data, T = AI.t, S = AI.S;
  let h = '<h2 class="rh">Pflege</h2><div class="group pad">';
  const z = d && d.zweitmeinung_art;
  if (z && S(z.latein) && !/^niedrig/i.test(S(z.sicherheit))) {
    const same = normSp(z.latein) === normSp(p.latin);
    if (same) h += `<p><span class="badge ok">Claude bestätigt die Art</span></p>`;
    else if (p.aiKeep !== normSp(z.latein)) h += `<div class="warnbox"><b>Claude sieht eine andere Art</b><br>Gespeichert: ${esc(p.latin || 'keine Angabe')}<br>Claude: <b>${T(z.latein)}</b>${S(z.name_de) ? ' (' + T(z.name_de) + ')' : ''}, Sicherheit ${T(z.sicherheit)}<br>${T(z.einschaetzung)}${AI.ul(z.merkmale_zum_pruefen)}
      <div class="actions"><button class="small" data-artswitch="${p.id}">Als ${T(z.latein)} übernehmen</button><button class="small sec" data-artkeep="${p.id}">Bei meiner Art bleiben</button></div></div>`;
  }
  if (d && S(d.kurzbeschreibung)) h += `<p>${T(d.kurzbeschreibung)}</p>`;
  const row = (title, list, ai) => (list || ai) ? `<div class="kv"><div class="k">${title}</div><div class="v">${ai ? T(ai) : esc(list)}</div></div>` : '';
  h += row('Licht', e && e.licht, d && d.licht);
  h += row('Gießen', '', d && d.giessen);
  h += row('Düngen', '', d && d.duengen);
  if (!d && e && e.tipp) h += `<div class="kv"><div class="k">Tipp</div><div class="v">${esc(e.tipp)}</div></div>`;
  if (d) {
    h += [['Erde und Umtopfen', d.substrat_umtopfen], ['Temperatur und Luftfeuchte', d.temperatur_luftfeuchte], ['Im Winter', d.winter]].map(([k, v]) => S(v) ? `<div class="kv"><div class="k">${k}</div><div class="v">${T(v)}</div></div>` : '').join('');
    if (AI.A(d.haeufige_probleme).length) h += `<div class="kv"><div class="k">Häufige Probleme</div><div class="v">${AI.ul(d.haeufige_probleme)}</div></div>`;
  }
  // Giftigkeit
  const g = (d && d.giftigkeit) || {}, hasAi = S(g.katze) || S(g.hund);
  const kk = hasAi ? S(g.katze) || 'unbekannt' : e && e.katze, hh = hasAi ? S(g.hund) || 'unbekannt' : e && e.hund;
  h += '<div class="kv"><div class="k">Giftigkeit</div><div class="v">';
  if (kk || hh) h += `<span class="badge ${toxClass(kk)}">Katze: ${esc(kk || 'unbekannt')}</span><span class="badge ${toxClass(hh)}">Hund: ${esc(hh || 'unbekannt')}</span>`;
  else h += '<span class="muted">Keine Daten. Im Zweifel nicht anknabbern lassen.</span>';
  const mensch = [S(g.mensch) || (e && e.mensch) || '', S(g.hinweis)].filter(Boolean).join(' ');
  if (mensch) h += `<div class="sub" style="margin-top:4px">${esc(mensch)}</div>`;
  h += '</div></div>';
  if (e && hasAi) {
    const ng = v => /^ungiftig/i.test(S(v)), diff = (ng(g.katze) !== (e.katze === 'ungiftig') && S(g.katze) !== 'unbekannt') || (ng(g.hund) !== (e.hund === 'ungiftig') && S(g.hund) !== 'unbekannt');
    if (diff) h += `<div class="warnbox"><b>Die Quellen widersprechen sich.</b> Die Liste sagt Katze: ${esc(e.katze)}, Hund: ${esc(e.hund)}. Behandle die Pflanze im Zweifel als giftig (Vergiftungsinformationszentrale 01 406 43 43).</div>`;
  }
  if (d && AI.A(d.unsicherheiten).length) h += `<div class="kv"><div class="k">Unsicher bei</div><div class="v">${AI.ul(d.unsicherheiten)}</div></div>`;
  h += `<p class="hint">Richtwerte${d ? ' und KI-Auswertung vom ' + fmtDE(p.aiInfo.d) : ''}, nicht geprüft. Kein Ersatz für Tierarzt, Arzt oder Fachberatung.</p>`;
  h += `<div class="actions"><button class="small" data-aiinfo="${p.id}">${d ? 'Neu abfragen' : 'Mit Claude ergänzen'}</button></div><div id="aiinfo-out"></div>`;
  return h + '</div>';
}

function aiInfoCard(p) {
  const i = p.aiInfo;
  let h = '<div class="card"><div class="name">Mehr Infos (Claude)</div>';
  h += i ? `<p class="hint">Stand ${fmtDE(i.d)} · ${esc(i.model)}</p>${AI.renderInfo(i.data)}`
    : `<p class="muted">Pflege, Probleme und Giftigkeit ausführlicher, plus Zweitmeinung zur Art anhand deines Fotos${p.photo ? '' : ' (dafür ein Foto bei der Pflanze speichern)'}.</p>`;
  h += `<div class="actions"><button class="small" data-aiinfo="${p.id}">${i ? 'Neu abfragen' : 'Infos holen'}</button><a class="btn small sec" href="#scan/krank/${p.id}">Gesundheit prüfen</a></div><div id="aiinfo-out"></div>`;
  const hl = (p.health || []).slice(-1)[0];
  if (hl) h += `<details><summary>Letzte Gesundheitsprüfung (${fmtDE(hl.d)})</summary>${AI.renderHealth(hl.data)}</details>`;
  return h + '</div>';
}

async function runAiInfo(id) {
  const p = state.plants.find(x => x.id === id); const out = $('#aiinfo-out'); if (!p || !out || aiBusy) return;
  aiBusy = true; out.innerHTML = spinner;
  try {
    const blobs = []; if (p.photo) { const b = await getPhoto(p.photo); if (b) blobs.push(b); }
    const text = `Aufgabe: ausführliche Pflegeinfos und Giftigkeit zu einer Zimmer- oder Gartenpflanze. Name: ${p.name}. Botanische Art laut Nutzer oder Erkennung: ${p.latin || 'unbekannt'}. Standort: ${p.location === 'aussen' ? 'draußen' : 'drinnen'}. Aktuelles Datum: ${today()}. ${blobs.length ? 'Ein Foto der Pflanze ist beigefügt. Gib eine Zweitmeinung zur Art.' : 'Kein Foto vorhanden, lass zweitmeinung_art leer.'}`;
    const r = await AI.run('info', text, blobs, 6000);
    p.aiInfo = { d: today(), model: r.model, data: r.data }; save(); toast('Infos gespeichert'); route();
  } catch (e) { out.innerHTML = `<div class="warnbox">${aiErrorHTML(e)}</div>`; }
  finally { aiBusy = false; }
}

/* ---------- Wunschliste ---------- */
routes.wunsch = () => {
  render('Wunschliste', `<form id="wf" class="card"><label>Pflanze</label><input name="name" required autocomplete="off">
    <label>Notiz (optional, z. B. wo gesehen)</label><input name="note"><div class="actions"><button type="submit">Hinzufügen</button></div></form>
    ${state.wishlist.length ? state.wishlist.map(w => `<div class="card"><div class="name">${esc(w.name)}</div>${w.note ? `<div class="muted">${esc(w.note)}</div>` : ''}
    <div class="actions"><button class="small" data-own="${w.id}">Jetzt in Sammlung</button><button class="small danger" data-wdel="${w.id}">Entfernen</button></div></div>`).join('') : '<div class="empty">Noch nichts auf der Wunschliste.</div>'}`);
  $('#wf').addEventListener('submit', e => {
    e.preventDefault(); const fd = new FormData(e.target);
    state.wishlist.push({ id: uid(), name: fd.get('name').trim(), note: fd.get('note').trim() }); save(); routes.wunsch();
  });
};


/* ---------- Mehr: Werkzeuge ---------- */
const ICO = {
  erkennen: ['#2e9e6a', '<path d="M24 35V21M24 21c0-5 4-8 9-8 0 5-4 8-9 8zM24 27c0-4-3-6-8-6 0 4 3 6 8 6z"/>'],
  diagnose: ['#f0a030', '<path d="M24 16v16M16 24h16"/>'],
  unkraut: ['#5aae3c', '<path d="M24 35c0-6-1-12-6-17M24 35c0-8 1-14 8-19M24 35c-1-5-4-9-10-10"/>'],
  giftig: ['#e0573f', '<path d="M24 15v11M24 32v.5"/>'],
  wunsch: ['#e0648b', '<path d="M24 34s-9-5.500-9-12a5 5 0 0 1 9-3 5 5 0 0 1 9 3c0 6.500-9 12-9 12z"/>'],
  einst: ['#7c8591', '<circle cx="24" cy="24" r="4"/><path d="M24 14v4M24 30v4M14 24h4M30 24h4M17 17l3 3M28 28l3 3M31 17l-3 3M20 28l-3 3"/>']
};
const ico = k => `<svg viewBox="0 0 48 48" width="44" height="44" aria-hidden="true"><rect width="48" height="48" rx="12" fill="${ICO[k][0]}"/><g fill="none" stroke="#fff" stroke-width="2.600" stroke-linecap="round" stroke-linejoin="round">${ICO[k][1]}</g></svg>`;
routes.mehr = () => {
  const tile = (href, k, label) => `<a class="tile" href="${href}">${ico(k)}<span>${label}</span></a>`;
  const big = (href, k, label, sub) => `<a class="tile big" href="${href}">${ico(k)}<b>${label}</b><span class="muted">${sub}</span></a>`;
  render('Mehr', `<h2 class="sect">Werkzeuge zur Pflege</h2>
    <div class="tiles">${tile('#scan', 'erkennen', 'Pflanze erkennen')}${tile('#scan/krank', 'diagnose', 'Diagnose')}${tile('#scan/unkraut', 'unkraut', 'Unkraut-Hilfe')}</div>
    <h2 class="sect">Nachschlagen</h2>
    <div class="tiles two">${big('#giftig', 'giftig', 'Giftig-Check', 'Katze, Hund, Mensch')}${big('#wunsch', 'wunsch', 'Wunschliste', 'Pflanzen merken')}</div>
    <h2 class="sect">App</h2>
    <div class="tiles two">${big('#einstellungen', 'einst', 'Einstellungen', 'Schlüssel, Modus, Backup')}</div>
    <p class="hint" style="margin-top:18px">${VERSION}</p>`);
};

/* ---------- Einstellungen ---------- */
routes.einstellungen = () => {
  const s = state.settings;
  render('Einstellungen', `<div class="card"><div class="name">Pl@ntNet-Schlüssel</div>
    <p class="muted">Kostenlos auf my.plantnet.org. Der Schlüssel bleibt nur auf diesem Gerät.</p>
    <input id="key" value="${esc(s.plantnetKey)}" placeholder="API-Schlüssel" autocomplete="off" autocapitalize="off">
    <label>Proxy (optional)</label>
    <input id="proxy" value="${esc(s.proxy)}" placeholder="https://…" autocapitalize="off">
    <label>Darstellung</label><select id="theme">${[['auto','Automatisch (wie iPhone)'],['light','Hell (Tag)'],['dark','Dunkel (Nacht)']].map(([k, v]) => `<option value="${k}" ${(s.theme || 'auto') === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <div class="lrow" style="padding-left:0;padding-right:0"><div class="l">Winter-Modus<div class="sub">November bis Februar: drinnen seltener gießen</div></div><label class="sw"><input id="winter" type="checkbox" ${s.winter ? 'checked' : ''}><span></span></label></div>
    <div class="actions"><button id="saveset">Speichern</button></div></div>
  <div class="card"><div class="name">Claude-Schlüssel</div>
    <p class="muted">Schlüssel von platform.claude.com. Jede Auswertung kostet Geld, setze in der Console ein Ausgabenlimit.</p>
    <input id="akey" value="${esc(s.anthropicKey || '')}" placeholder="sk-ant-…" autocomplete="off" autocapitalize="off">
    <label>Pflanzenerkennung per Foto</label><select id="aerk">${[['beide','Beide (Pl@ntNet und Claude, ca. 1 Cent)'],['plantnet','Nur Pl@ntNet (gratis)'],['claude','Nur Claude']].map(([k, v]) => `<option value="${k}" ${(s.erkennung || 'beide') === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <label>Modell</label><select id="amodel">${Object.entries(AI.MODELS).map(([k, v]) => `<option value="${k}" ${(s.aiModel || AI.DEFAULT_MODEL) === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
    <div class="actions"><button id="saveai">Speichern</button><button id="testai" class="sec">Verbindung testen</button></div>
    <div id="aitest"></div>
    <p class="hint">Bisher: ${(s.aiUsage || {}).calls || 0} Auswertungen, ${((s.aiUsage || {}).inTok || 0) + ((s.aiUsage || {}).outTok || 0)} Tokens, geschätzt ${(((s.aiUsage || {}).usd || 0) * 100).toFixed(1)} Cent (Schätzung nach Listenpreis, maßgeblich ist die Console).
    <a href="#einstellungen" id="resetuse">Zähler zurücksetzen</a></p></div>
  <div class="card"><div class="name">Backup</div>
    <p class="muted">Daten liegen nur auf diesem Gerät. Exportiere regelmäßig.</p>
    <div class="actions"><button id="exp" class="sec">Exportieren</button><div class="pick"><span class="btn sec">Importieren</span><input id="imp" type="file" accept="application/json,.json" aria-label="Backup importieren"></div></div>
    <p class="hint">Tipp: Beim Exportieren öffnet sich das Teilen-Menü. Wähle „In Dateien sichern“ und speichere in iCloud Drive, am besten in einem Ordner „Kanji-Backup“. Beim Importieren wählst du diese Datei wieder aus.</p></div>
  <p class="hint">${VERSION}</p>
  <p class="hint">Pflanzenerkennung: Pl@ntNet (my.plantnet.org)</p>`);
  $('#theme').onchange = () => { s.theme = $('#theme').value; applyTheme(); save(); };
  $('#saveset').onclick = () => {
    s.plantnetKey = $('#key').value.trim(); s.proxy = $('#proxy').value.trim(); s.winter = $('#winter').checked; s.theme = $('#theme').value; applyTheme(); save(); toast('Gespeichert');
  };
  $('#saveai').onclick = () => { s.anthropicKey = $('#akey').value.trim(); s.aiModel = $('#amodel').value; s.erkennung = $('#aerk').value; save(); toast('Gespeichert'); };
  $('#resetuse').onclick = e => { e.preventDefault(); s.aiUsage = { calls: 0, inTok: 0, outTok: 0, usd: 0 }; save(); routes.einstellungen(); };
  $('#testai').onclick = async () => {
    s.anthropicKey = $('#akey').value.trim(); s.aiModel = $('#amodel').value; s.erkennung = $('#aerk').value; save();
    const out = $('#aitest'); out.innerHTML = '<p><span class="spin"></span> Teste …</p>';
    try { const r = await AI.ask({ text: 'Antworte nur mit dem Wort OK.', maxTokens: 10, system: 'Antworte nur mit dem Wort OK.' }); out.innerHTML = `<p class="badge ok">Verbindung steht (${esc(r.model)})</p>`; }
    catch (e) { out.innerHTML = `<div class="warnbox">${aiErrorHTML(e)}</div>`; }
  };
  $('#exp').onclick = async () => {
    const photos = {};
    for (const p of state.plants) for (const ph of [...photosOf(p), ...(p.crop ? [p.crop] : []), ...(p.health || []).map(x => x.thumb).filter(Boolean)]) { const b = await getPhoto(ph); if (b) photos[ph] = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); }); }
    const copy = { ...state, settings: { ...state.settings, plantnetKey: '', anthropicKey: '' } };
    const blob = new Blob([JSON.stringify({ version: 1, state: copy, photos })], { type: 'application/json' });
    const name = `kanji-backup-${today()}.json`;
    try {
      const file = new File([blob], name, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
    } catch (err) { if (err && err.name === 'AbortError') return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  };
  $('#imp').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const j = JSON.parse(await f.text()); if (!j.state || !Array.isArray(j.state.plants)) throw new Error();
      if (!confirm('Vorhandene Daten auf diesem Gerät werden ersetzt. Fortfahren?')) return;
      const keep = { theme: state.settings.theme, erkennung: state.settings.erkennung, plantnetKey: state.settings.plantnetKey, anthropicKey: state.settings.anthropicKey, aiModel: state.settings.aiModel, aiUsage: state.settings.aiUsage };
      for (const [id, data] of Object.entries(j.photos || {})) await idbOp('readwrite', st => st.put(await0(data), id));
      state = { ...defaults(), ...j.state }; state.settings = { ...defaults().settings, ...j.state.settings, ...keep }; normPhotos();
      save(); toast('Importiert'); go('sammlung');
    } catch { toast('Datei nicht lesbar'); }
  };
};
function await0(dataUrl) { // dataURL -> Blob (synchron)
  const [h, b] = dataUrl.split(','); const mime = h.match(/:(.*?);/)[1]; const bin = atob(b);
  const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type: mime });
}

/* ---------- Aktionen (Klick-Delegation) ---------- */
document.addEventListener('change', e => {
  const t = e.target; if (!t.dataset) return;
  const D = t.dataset, P = id => state.plants.find(x => x.id === id);
  if (D.phadd) {
    const p = P(D.phadd); const files = [...(t.files || [])]; t.value = ''; if (!p || !files.length) return;
    (async () => {
      let n = 0; p.photos = photosOf(p).slice();
      for (const f of files) { try { const id = await putPhoto(await shrink(f, 900, 0.8)); p.photos.push(id); if (!p.photo) p.photo = id; n++; } catch { toast('Ein Foto konnte nicht gespeichert werden'); } }
      if (n) { save(); toast(n === 1 ? 'Foto hinzugefügt' : n + ' Fotos hinzugefügt'); route(); }
    })(); return;
  }
  if (D.roomsel) {
    const p = P(D.roomsel); if (!p) return;
    if (t.value === '__neu') { $('#roomnewbox').style.display = 'flex'; $('#roomnew').focus(); return; }
    p.room = t.value; if (['Balkon', 'Garten'].includes(t.value)) p.location = 'aussen'; else if (t.value) p.location = 'innen';
    save(); toast('Raum gespeichert'); route(); return;
  }
  if (D.fertenable) {
    const p = P(D.fertenable); if (!p) return;
    p.fertDays = t.checked ? ((dbById(p.dbId) || {}).duenger_tage || 28) : ''; save(); route(); return;
  }
  if (D.fertdays) {
    const p = P(D.fertdays), n = Number(t.value); if (!p || !(n >= 1)) return; p.fertDays = Math.min(180, n); save(); toast('Gespeichert'); route(); return;
  }
  if (!D.fertsw) return;
  const p = state.plants.find(x => x.id === t.dataset.fertsw); if (!p) return;
  p.log = p.log || [];
  if (t.checked) { p.lastFert = today(); p.log.push({ t: 'fert', d: today() }); toast('Als gedüngt markiert'); }
  else {
    const k = p.log.map(l => l.t).lastIndexOf('fert'); if (k >= 0) p.log.splice(k, 1);
    const prev = p.log.filter(l => l.t === 'fert').pop(); p.lastFert = prev ? prev.d : ''; toast('Düngung zurückgenommen');
  }
  p.log = p.log.slice(-40); save(); route();
});
document.addEventListener('click', async e => {
  const t = e.target.closest('button'); if (!t) return;
  const D = t.dataset;
  if (D.water) { const p = state.plants.find(x => x.id === D.water); p.lastWatered = today(); (p.log = p.log || []).push({ t: 'water', d: today() }); p.log = p.log.slice(-40); save(); toast('Gegossen'); route(); }
  else if (D.fert) { const p = state.plants.find(x => x.id === D.fert); p.lastFert = today(); (p.log = p.log || []).push({ t: 'fert', d: today() }); p.log = p.log.slice(-40); save(); toast('Gedüngt'); route(); }
  else if (D.del) {
    const p = state.plants.find(x => x.id === D.del);
    if (confirm(`„${p.name}“ wirklich löschen?`)) { for (const ph of photosOf(p)) await delPhoto(ph); for (const x of p.health || []) if (x.thumb) await delPhoto(x.thumb); await dropCrop(p); state.plants = state.plants.filter(x => x !== p); save(); go('sammlung'); }
  }
  else if (D.crop) openCrop(D.crop);
  else if (D.phsel !== undefined) { selPhoto = D.phsel || null; route(); }
  else if (D.phcover) { const p = state.plants.find(x => x.id === D.phcover); if (p && selPhoto) { await dropCrop(p); p.photo = selPhoto; save(); toast('Titelbild geändert'); route(); } }
  else if (D.phdel) {
    const p = state.plants.find(x => x.id === D.phdel); if (!p || !selPhoto) return;
    if (!confirm('Dieses Foto löschen?')) return;
    await delPhoto(selPhoto); p.photos = photosOf(p).filter(x => x !== selPhoto); if (p.photo === selPhoto) { await dropCrop(p); p.photo = p.photos[0] || ''; } selPhoto = null; save(); toast('Foto gelöscht'); route();
  }
  else if (D.roomnew) {
    const p = state.plants.find(x => x.id === D.roomnew), v = ($('#roomnew').value || '').trim(); if (!p || !v) return;
    p.room = v; save(); toast('Raum gespeichert'); route();
  }
  else if (D.aiinfo) await runAiInfo(D.aiinfo);
  else if (D.artswitch) {
    const p = state.plants.find(x => x.id === D.artswitch), z = p && p.aiInfo && p.aiInfo.data && p.aiInfo.data.zweitmeinung_art; if (!z || !z.latein) return;
    const m = dbMatch(String(z.latein)), oldName = p.name, oldLat = p.latin, oldE = dbById(p.dbId);
    p.latin = String(z.latein); if (z.name_de && (!p.name || p.name === oldLat || (oldE && p.name === oldE.name))) p.name = String(z.name_de);
    p.dbId = m ? m.entry.id : ''; p.dbApprox = !!(m && !m.exact);
    if (m) { p.waterDays = m.entry.wasser_tage; p.fertDays = m.entry.duenger_tage; }
    p.notes = ((p.notes ? p.notes + '\n' : '') + `Art am ${fmtDE(today())} geändert (vorher: ${oldName}). Pflegewerte ${m ? 'aus der Liste' : 'unverändert'}.`).trim();
    delete p.aiKeep; delete p.aiInfo; save(); toast('Art geändert. Bitte Infos neu abfragen.'); route();
  }
  else if (D.artkeep) {
    const p = state.plants.find(x => x.id === D.artkeep), z = p && p.aiInfo && p.aiInfo.data && p.aiInfo.data.zweitmeinung_art; if (!z) return;
    p.aiKeep = normSp(z.latein); save(); route();
  }
  else if (D.aisave) {
    const sel = $('#aisel'); const pid = aiLast && (aiLast.plantId || (sel && sel.value));
    const p = pid && state.plants.find(x => x.id === pid); if (!p) return toast('Bitte zuerst eine Pflanze wählen');
    let thumb = '';
    if (aiFiles[0]) { try { thumb = await putPhoto(await shrink(aiFiles[0], 360, 0.75)); } catch {} }
    p.health = [...(p.health || []), { d: today(), model: aiLast.model, data: aiLast.data, note: aiLast.note || '', thumb }].slice(-50);
    save(); toast('Im Verlauf gespeichert'); go('pflanze/' + p.id);
  }
  else if (D.hdel) {
    const [pid, ix] = D.hdel.split(':'), p = state.plants.find(x => x.id === pid), k = Number(ix); if (!p || !p.health || !p.health[k]) return;
    if (!confirm('Diesen Eintrag löschen?')) return;
    if (p.health[k].thumb) { try { await delPhoto(p.health[k].thumb); } catch {} }
    p.health.splice(k, 1); save(); toast('Gelöscht'); route();
  }
  else if (D.wdel) { state.wishlist = state.wishlist.filter(w => w.id !== D.wdel); save(); route(); }
  else if (D.own) { const w = state.wishlist.find(x => x.id === D.own); state.wishlist = state.wishlist.filter(x => x !== w); save(); window.__prefill = { name: w.name }; go('neu'); }
  else if (D.add != null || D.wish != null) {
    const r = window.__scanResults[Number(D.add ?? D.wish)]; const sci = r.species.scientificNameWithoutAuthor;
    const common = (r.species.commonNames || [])[0] || sci;
    if (D.wish != null) { state.wishlist.push({ id: uid(), name: common, note: sci }); save(); toast('Auf Wunschliste'); return; }
    const m = dbMatch(sci); const e2 = m ? m.entry : null; const approx = !!(m && !m.exact);
    const pre = { name: common, latin: sci, dbId: e2 ? e2.id : '', dbApprox: approx, waterDays: e2 ? e2.wasser_tage : 7, fertDays: e2 ? e2.duenger_tage : '',
      notes: approx ? `Pflegewerte geschätzt nach verwandter Art (${e2.name}).` : '' };
    if (scanFile) { try { pre.photo = await putPhoto(await shrink(scanFile, 640, 0.8)); } catch {} }
    window.__prefill = pre; go('neu');
  }
});

/* ---------- Start ---------- */
window.addEventListener('hashchange', route);
(async () => {
  load(); applyTheme(); await loadDB();
  if ('serviceWorker' in navigator) {
    const had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) location.reload(); });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  route();
})();
