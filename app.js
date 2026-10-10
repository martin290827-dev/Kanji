/* Pflanzen-App (PWA). Alle Daten bleiben auf dem Gerät (localStorage + IndexedDB). */
'use strict';

const KEY = 'pflanzen.v1';
const PLANTNET = 'https://my-api.plantnet.org';
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
const defaults = () => ({ plants: [], wishlist: [], settings: { plantnetKey: '', proxy: '', winter: true } });
let state = defaults();
function load() {
  try { const raw = localStorage.getItem(KEY); if (raw) state = { ...defaults(), ...JSON.parse(raw) }; }
  catch (e) { console.warn('Laden fehlgeschlagen', e); }
  state.settings = { ...defaults().settings, ...state.settings };
}
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

/* ---------- Router ---------- */
const routes = {};
function route() {
  const parts = (location.hash.slice(1) || 'heute').split('/');
  const name = parts[0];
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === (['pflanze', 'neu', 'bearbeiten'].includes(name) ? 'sammlung' : name)));
  (routes[name] || routes.heute)(parts.slice(1));
  window.scrollTo(0, 0);
}
const go = h => { location.hash = h; };
const render = (title, html) => { titleEl.textContent = title; view.innerHTML = html; fillPhotos(); };
const thumb = p => p.photo ? `<img class="thumb" data-photo="${esc(p.photo)}" alt="">` : `<div class="thumb">🌿</div>`;

/* ---------- Heute ---------- */
routes.heute = () => {
  const water = state.plants.filter(p => diffDays(today(), nextWater(p)) <= 0)
    .sort((a, b) => nextWater(a).localeCompare(nextWater(b)));
  const fert = state.plants.filter(p => { const n = nextFert(p); return n && diffDays(today(), n) <= 0; });
  if (navigator.setAppBadge) { try { water.length ? navigator.setAppBadge(water.length) : navigator.clearAppBadge(); } catch {} }
  let h = '';
  if (!state.plants.length) h = `<div class="empty">Noch keine Pflanzen.<br><br><a class="btn" href="#neu">Erste Pflanze hinzufügen</a></div>`;
  else {
    h += `<h2>Gießen (${water.length})</h2>`;
    h += water.length ? water.map(p => `<div class="card row">${thumb(p)}<div class="grow"><a class="name" href="#pflanze/${p.id}" style="color:inherit;text-decoration:none">${esc(p.name)}</a>
      <div>${statusBadge(nextWater(p), 'Gießen')}</div></div><button class="water small" data-water="${p.id}">Gegossen</button></div>`).join('')
      : `<p class="muted">Heute ist nichts fällig.</p>`;
    if (fert.length) {
      h += `<h2>Düngen (${fert.length})</h2>` + fert.map(p => `<div class="card row">${thumb(p)}<div class="grow"><a class="name" href="#pflanze/${p.id}" style="color:inherit;text-decoration:none">${esc(p.name)}</a>
        <div>${statusBadge(nextFert(p), 'Düngen')}</div></div><button class="small" data-fert="${p.id}">Gedüngt</button></div>`).join('');
    }
    if (state.settings.winter && isWinter()) h += `<p class="hint">Winter-Modus aktiv: Gießabstände bei Zimmerpflanzen ×1,5, kein Düngen.</p>`;
    h += `<p class="hint">Hinweis: Diese App sendet keine Push-Nachrichten. Das rote Symbol am App-Icon zeigt die Zahl der fälligen Pflanzen, sobald du die App öffnest.</p>`;
  }
  render('Heute', h);
};

/* ---------- Sammlung ---------- */
routes.sammlung = () => {
  const list = [...state.plants].sort((a, b) => a.name.localeCompare(b.name, 'de'));
  let h = `<div class="actions"><a class="btn" href="#neu">+ Neue Pflanze</a></div>`;
  h += list.length ? list.map(p => `<a class="card row" href="#pflanze/${p.id}" style="color:inherit;text-decoration:none">${thumb(p)}
    <div class="grow"><div class="name">${esc(p.name)}</div>
    <div class="muted">${esc(p.latin || '')} · ${p.location === 'aussen' ? 'draußen' : 'drinnen'}</div>
    <div>${statusBadge(nextWater(p), 'Gießen')}</div></div></a>`).join('') : `<div class="empty">Deine Sammlung ist leer.</div>`;
  render(`Sammlung (${list.length})`, h);
};

/* ---------- Detail ---------- */
routes.pflanze = ([id]) => {
  const p = state.plants.find(x => x.id === id); if (!p) return go('sammlung');
  const e = dbById(p.dbId);
  const nf = nextFert(p);
  let h = p.photo ? `<img class="big" data-photo="${esc(p.photo)}" alt="">` : '';
  h += `<div class="card"><div class="name">${esc(p.name)}</div><div class="muted">${esc(p.latin || '')}</div>
    <p>${statusBadge(nextWater(p), 'Gießen')} ${nf ? statusBadge(nf, 'Düngen') : ''}</p>
    <div class="actions"><button class="water" data-water="${p.id}">Gegossen</button>
    ${p.fertDays ? `<button class="sec" data-fert="${p.id}">Gedüngt</button>` : ''}</div>
    <p class="muted">Zuletzt gegossen: ${fmtDE(p.lastWatered)} · Intervall: alle ${waterInterval(p)} Tage${waterInterval(p) !== Number(p.waterDays) ? ` (Winter, sonst ${p.waterDays})` : ''}</p>
    ${p.fertDays ? `<p class="muted">Zuletzt gedüngt: ${fmtDE(p.lastFert)} · alle ${p.fertDays} Tage (März bis September)</p>` : ''}
    ${p.notes ? `<p>${esc(p.notes).replace(/\n/g, '<br>')}</p>` : ''}</div>`;
  if (e) h += `<div class="card"><div class="name">Pflege</div><p>Licht: ${esc(e.licht)}</p><p>${esc(e.tipp)}</p>
    <p class="hint">Richtwerte. Töpfe, Standort und Raumklima beeinflussen den Bedarf stark: erst Finger-Probe, dann gießen.</p></div>`;
  h += toxBlock(e);
  const log = (p.log || []).slice(-8).reverse();
  if (log.length) h += `<div class="card"><div class="name">Verlauf</div>${log.map(l => `<div class="muted">${fmtDE(l.d)} · ${l.t === 'water' ? 'gegossen' : 'gedüngt'}</div>`).join('')}</div>`;
  h += `<div class="actions"><a class="btn sec" href="#bearbeiten/${p.id}">Bearbeiten</a><button class="danger" data-del="${p.id}">Löschen</button></div>`;
  render(p.name, h);
};

/* ---------- Formular ---------- */
function formView(p, fromScan) {
  const isNew = !p.id;
  const opts = DB.map(d => `<option value="${d.id}" ${d.id === p.dbId ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
  render(isNew ? 'Neue Pflanze' : 'Bearbeiten', `<form id="f">
    <label>Aus Pflanzenliste übernehmen (füllt Pflegewerte vor)</label>
    <select name="dbId"><option value="">– eigene Pflanze –</option>${opts}</select>
    <label>Name</label><input name="name" required value="${esc(p.name || '')}" autocomplete="off">
    <label>Art (botanisch, optional)</label><input name="latin" value="${esc(p.latin || '')}">
    <label>Standort</label><select name="location"><option value="innen" ${p.location !== 'aussen' ? 'selected' : ''}>Drinnen</option><option value="aussen" ${p.location === 'aussen' ? 'selected' : ''}>Draußen</option></select>
    <div class="two"><div><label>Gießen alle (Tage)</label><input name="waterDays" type="number" min="1" max="90" value="${esc(p.waterDays ?? 7)}"></div>
    <div><label>Zuletzt gegossen</label><input name="lastWatered" type="date" value="${esc(p.lastWatered || '')}"></div></div>
    <div class="two"><div><label>Düngen alle (Tage, leer = nie)</label><input name="fertDays" type="number" min="0" max="180" value="${esc(p.fertDays ?? '')}"></div>
    <div><label>Zuletzt gedüngt</label><input name="lastFert" type="date" value="${esc(p.lastFert || '')}"></div></div>
    <label>Notizen</label><textarea name="notes">${esc(p.notes || '')}</textarea>
    <label>Foto</label>${p.photo ? `<img class="thumb" data-photo="${esc(p.photo)}" alt="" style="margin-bottom:6px">` : ''}
    <input name="photo" type="file" accept="image/*">
    <div class="actions"><button type="submit">Speichern</button><a class="btn sec" href="#${isNew ? 'sammlung' : 'pflanze/' + p.id}">Abbrechen</a></div>
  </form>`);
  const f = $('#f');
  f.dbId.addEventListener('change', () => {
    const el = f.elements, e = dbById(el.dbId.value); if (!e) return;
    if (!el.name.value) el.name.value = e.name; el.latin.value = e.latin;
    el.waterDays.value = e.wasser_tage; el.fertDays.value = e.duenger_tage;
  });
  f.addEventListener('submit', async ev => {
    ev.preventDefault();
    const fd = new FormData(f);
    const rec = isNew ? { id: uid(), created: today(), log: [] } : p;
    Object.assign(rec, {
      name: fd.get('name').trim(), latin: fd.get('latin').trim(), dbId: fd.get('dbId') || '',
      location: fd.get('location'), waterDays: Number(fd.get('waterDays')) || 7,
      lastWatered: fd.get('lastWatered') || '', fertDays: fd.get('fertDays') ? Number(fd.get('fertDays')) : '',
      lastFert: fd.get('lastFert') || '', notes: fd.get('notes').trim()
    });
    if (!rec.dbId) { const m = dbMatch(rec.latin); if (m && m.exact) rec.dbId = m.entry.id; }
    const file = fd.get('photo');
    if (file && file.size) {
      try { const b = await shrink(file, 640, 0.8); if (rec.photo) await delPhoto(rec.photo); rec.photo = await putPhoto(b); }
      catch (e) { toast('Foto konnte nicht gespeichert werden'); }
    } else if (fromScan && fromScan.photo) rec.photo = fromScan.photo;
    if (isNew) state.plants.push(rec);
    save(); toast('Gespeichert'); go('pflanze/' + rec.id);
  });
}
routes.neu = () => { const pre = window.__prefill || {}; window.__prefill = null; formView(pre, pre); };
routes.bearbeiten = ([id]) => { const p = state.plants.find(x => x.id === id); if (!p) return go('sammlung'); formView(p); };

/* ---------- Scan / Nachschlagen ---------- */
let scanFile = null;
routes.scan = () => {
  const hasKey = !!state.settings.plantnetKey;
  render('Scan', `<div class="card"><div class="name">Pflanze erkennen</div>
    <p class="muted">Foto von Blatt, Blüte oder der ganzen Pflanze. Das Bild wird an Pl@ntNet gesendet.</p>
    ${hasKey ? '' : '<div class="warnbox">Kein Pl@ntNet-Schlüssel hinterlegt. Unter „Mehr“ eintragen (kostenlos, 500 Erkennungen pro Tag).</div>'}
    <input id="scanfile" type="file" accept="image/*">
    <img id="scanprev" class="big" style="display:none;margin-top:10px" alt="">
    <div class="actions"><button id="scango" ${hasKey ? '' : 'disabled'}>Erkennen</button></div>
    <div id="scanres"></div></div>
  <div class="card"><div class="name">Giftig oder nicht? Nachschlagen</div>
    <input id="q" placeholder="z. B. Monstera, Lilie, Basilikum" autocomplete="off">
    <div id="qres"></div></div>`);
  $('#scanfile').addEventListener('change', e => {
    scanFile = e.target.files[0] || null;
    const prev = $('#scanprev');
    if (scanFile) { prev.src = URL.createObjectURL(scanFile); prev.style.display = 'block'; }
  });
  $('#scango').addEventListener('click', identify);
  $('#q').addEventListener('input', e => {
    const r = dbSearch(e.target.value);
    $('#qres').innerHTML = !e.target.value.trim() ? '' : (r.length ? r.slice(0, 8).map(p => `<div class="card"><div class="name">${esc(p.name)}</div><div class="muted">${esc(p.latin)}</div>
      <span class="badge ${toxClass(p.katze)}">Katze: ${esc(p.katze)}</span><span class="badge ${toxClass(p.hund)}">Hund: ${esc(p.hund)}</span>
      ${p.mensch ? `<p class="muted">Menschen: ${esc(p.mensch)}</p>` : ''}</div>`).join('') + '<p class="hint">Richtwerte nach ASPCA-Liste, nicht einzeln geprüft.</p>'
      : '<p class="muted">Nicht in der Liste. Das heißt nicht, dass die Pflanze sicher ist.</p>');
  });
};

async function identify() {
  const out = $('#scanres');
  if (!scanFile) return toast('Bitte zuerst ein Foto wählen');
  out.innerHTML = '<p><span class="spin"></span> Erkenne …</p>';
  try {
    const blob = await shrink(scanFile, 1024, 0.85);
    const fd = new FormData(); fd.append('images', blob, 'foto.jpg'); fd.append('organs', 'auto');
    const base = (state.settings.proxy || PLANTNET).replace(/\/$/, '');
    const url = `${base}/v2/identify/all?api-key=${encodeURIComponent(state.settings.plantnetKey)}&lang=de&nb-results=3&include-related-images=false`;
    const res = await fetch(url, { method: 'POST', body: fd });
    if (res.status === 404) { out.innerHTML = '<p class="muted">Keine Pflanze erkannt. Anderes Foto versuchen (Blatt oder Blüte, gutes Licht).</p>'; return; }
    if (res.status === 401 || res.status === 403) throw new Error('Der Schlüssel wird abgelehnt. Bitte unter „Mehr“ prüfen.');
    if (res.status === 429) throw new Error('Tageslimit erreicht. Morgen wieder versuchen.');
    if (!res.ok) throw new Error('Fehler vom Dienst (' + res.status + ').');
    const data = await res.json();
    const results = (data.results || []).slice(0, 3);
    if (!results.length) { out.innerHTML = '<p class="muted">Keine Treffer.</p>'; return; }
    window.__scanResults = results;
    out.innerHTML = results.map((r, i) => {
      const sci = r.species.scientificNameWithoutAuthor, common = (r.species.commonNames || [])[0] || '';
      const m = dbMatch(sci);
      return `<div class="card"><div class="name">${esc(common || sci)}</div><div class="muted">${esc(sci)} · ${esc(r.species.family?.scientificNameWithoutAuthor || '')}</div>
      <span class="badge ${r.score > .6 ? 'ok' : 'due'}">Sicherheit ${Math.round(r.score * 100)} %</span>
      ${m ? `<span class="badge ${toxClass(m.entry.katze)}">Katze: ${esc(m.entry.katze)}</span><span class="badge ${toxClass(m.entry.hund)}">Hund: ${esc(m.entry.hund)}</span>${m.exact ? '' : '<p class="hint">Giftangabe gilt für verwandte Art derselben Gattung, nur Anhaltspunkt.</p>'}`
        : '<p class="hint">Keine Giftigkeits-Daten in der App.</p>'}
      <div class="actions"><button class="small" data-add="${i}">Zur Sammlung</button><button class="small sec" data-wish="${i}">Wunschliste</button></div></div>`;
    }).join('') + '<p class="hint">Erkennung per Pl@ntNet (https://my.plantnet.org). Bei geringer Sicherheit nicht verlassen, besonders bei Giftigkeit.</p>';
  } catch (e) {
    const net = e instanceof TypeError;
    out.innerHTML = `<div class="warnbox">${net ? 'Verbindung fehlgeschlagen. Kein Netz, oder der Browser blockiert die Anfrage. Falls es dauerhaft passiert, unter „Mehr“ einen Proxy eintragen.' : esc(e.message)}</div>`;
  }
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

/* ---------- Einstellungen ---------- */
routes.einstellungen = () => {
  const s = state.settings;
  render('Mehr', `<div class="card"><div class="name">Pl@ntNet-Schlüssel</div>
    <p class="muted">Kostenlos auf my.plantnet.org (Konto anlegen, API-Schlüssel kopieren). Der Schlüssel bleibt nur auf diesem Gerät.</p>
    <input id="key" value="${esc(s.plantnetKey)}" placeholder="API-Schlüssel" autocomplete="off" autocapitalize="off">
    <label>Proxy-Adresse (optional, nur falls die direkte Anfrage blockiert wird)</label>
    <input id="proxy" value="${esc(s.proxy)}" placeholder="https://…" autocapitalize="off">
    <label><input id="winter" type="checkbox" style="width:auto" ${s.winter ? 'checked' : ''}> Winter-Modus (Nov–Feb: drinnen seltener gießen)</label>
    <div class="actions"><button id="saveset">Speichern</button></div></div>
  <div class="card"><div class="name">Backup</div>
    <p class="muted">Daten liegen nur auf diesem Gerät. iOS kann Browserdaten löschen, wenn die App lange nicht genutzt wird. Exportiere regelmäßig.</p>
    <div class="actions"><button id="exp" class="sec">Exportieren</button><label class="btn sec" style="margin:0">Importieren<input id="imp" type="file" accept="application/json" hidden></label></div></div>
  <div class="card"><div class="name">Auf den Home-Bildschirm</div>
    <p class="muted">In Safari öffnen, Teilen-Symbol tippen, „Zum Home-Bildschirm“ wählen. Nur so gelten Kamera-Zugriff und Zahl am Icon zuverlässig.</p></div>
  <p class="hint">Pflanzenerkennung: Pl@ntNet. Pflegewerte und Giftangaben sind Richtwerte und kein Ersatz für Fachrat.</p>`);
  $('#saveset').onclick = () => {
    s.plantnetKey = $('#key').value.trim(); s.proxy = $('#proxy').value.trim(); s.winter = $('#winter').checked; save(); toast('Gespeichert');
  };
  $('#exp').onclick = async () => {
    const photos = {};
    for (const p of state.plants) if (p.photo) { const b = await getPhoto(p.photo); if (b) photos[p.photo] = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); }); }
    const copy = { ...state, settings: { ...state.settings, plantnetKey: '' } };
    const blob = new Blob([JSON.stringify({ version: 1, state: copy, photos })], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `pflanzen-backup-${today()}.json`; a.click();
  };
  $('#imp').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const j = JSON.parse(await f.text()); if (!j.state || !Array.isArray(j.state.plants)) throw new Error();
      if (!confirm('Vorhandene Daten auf diesem Gerät werden ersetzt. Fortfahren?')) return;
      const key = state.settings.plantnetKey;
      for (const [id, data] of Object.entries(j.photos || {})) await idbOp('readwrite', st => st.put(await0(data), id));
      state = { ...defaults(), ...j.state }; state.settings = { ...defaults().settings, ...j.state.settings, plantnetKey: key };
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
document.addEventListener('click', async e => {
  const t = e.target.closest('button'); if (!t) return;
  const D = t.dataset;
  if (D.water) { const p = state.plants.find(x => x.id === D.water); p.lastWatered = today(); (p.log = p.log || []).push({ t: 'water', d: today() }); p.log = p.log.slice(-40); save(); toast('Gegossen'); route(); }
  else if (D.fert) { const p = state.plants.find(x => x.id === D.fert); p.lastFert = today(); (p.log = p.log || []).push({ t: 'fert', d: today() }); p.log = p.log.slice(-40); save(); toast('Gedüngt'); route(); }
  else if (D.del) {
    const p = state.plants.find(x => x.id === D.del);
    if (confirm(`„${p.name}“ wirklich löschen?`)) { if (p.photo) await delPhoto(p.photo); state.plants = state.plants.filter(x => x !== p); save(); go('sammlung'); }
  }
  else if (D.wdel) { state.wishlist = state.wishlist.filter(w => w.id !== D.wdel); save(); route(); }
  else if (D.own) { const w = state.wishlist.find(x => x.id === D.own); state.wishlist = state.wishlist.filter(x => x !== w); save(); window.__prefill = { name: w.name }; go('neu'); }
  else if (D.add != null || D.wish != null) {
    const r = window.__scanResults[Number(D.add ?? D.wish)]; const sci = r.species.scientificNameWithoutAuthor;
    const common = (r.species.commonNames || [])[0] || sci;
    if (D.wish != null) { state.wishlist.push({ id: uid(), name: common, note: sci }); save(); toast('Auf Wunschliste'); return; }
    const m = dbMatch(sci); const e2 = m && m.exact ? m.entry : null;
    const pre = { name: common, latin: sci, dbId: e2 ? e2.id : '', waterDays: e2 ? e2.wasser_tage : 7, fertDays: e2 ? e2.duenger_tage : '' };
    if (scanFile) { try { pre.photo = await putPhoto(await shrink(scanFile, 640, 0.8)); } catch {} }
    window.__prefill = pre; go('neu');
  }
});

/* ---------- Start ---------- */
window.addEventListener('hashchange', route);
(async () => {
  load(); await loadDB();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  route();
})();
