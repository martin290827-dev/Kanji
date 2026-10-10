/* Pflanzen-App (PWA). Alle Daten bleiben auf dem Gerät (localStorage + IndexedDB). */
'use strict';

const KEY = 'pflanzen.v1';
const PLANTNET = 'https://my-api.plantnet.org';
const VERSION = 'Version 9 (10.10.2026)';
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
const defaults = () => ({ plants: [], wishlist: [], settings: { plantnetKey: '', proxy: '', winter: true, anthropicKey: '', aiModel: 'claude-sonnet-5-5', erkennung: 'beide', aiUsage: { calls: 0, inTok: 0, outTok: 0, usd: 0 } } });
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
  if (e && p.dbApprox) h += `<div class="warnbox">Pflege- und Giftangaben stammen von einer verwandten Art (${esc(e.name)}). Nur ein Anhaltspunkt, bitte prüfen.</div>`;
  if (e) h += `<div class="card"><div class="name">Pflege</div><p>Licht: ${esc(e.licht)}</p><p>${esc(e.tipp)}</p>
    <p class="hint">Richtwerte. Töpfe, Standort und Raumklima beeinflussen den Bedarf stark: erst Finger-Probe, dann gießen.</p></div>`;
  h += toxBlock(e);
  h += aiInfoCard(p);
  const log = (p.log || []).slice(-8).reverse();
  if (log.length) h += `<div class="card"><div class="name">Verlauf</div>${log.map(l => `<div class="muted">${fmtDE(l.d)} · ${l.t === 'water' ? 'gegossen' : 'gedüngt'}</div>`).join('')}</div>`;
  h += `<div class="actions"><a class="btn sec" href="#bearbeiten/${p.id}">Bearbeiten</a><button class="danger" data-del="${p.id}">Löschen</button></div>`;
  render(p.name, h);
};

/* ---------- Formular ---------- */
function formView(p, fromScan) {
  const isNew = !p.id;
  const opts = DB.map(d => `<option value="${d.id}" ${d.id === p.dbId ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
  let formScanFile = null, formBusy = false, formResults = [];
  const scanCard = isNew ? `<div class="card"><div class="name">Per Foto erkennen</div>
    <p class="muted">Foto aufnehmen oder wählen, dann den passenden Vorschlag antippen. Das Formular füllt sich automatisch.</p>
    <div class="actions">
      <div class="pick"><span class="btn small">📷 Foto aufnehmen</span><input id="fcam" type="file" accept="image/*" capture="environment" aria-label="Foto aufnehmen"></div>
      <div class="pick"><span class="btn sec small">🖼 Aus Galerie</span><input id="fgal" type="file" accept="image/*" aria-label="Foto aus Galerie wählen"></div>
    </div><div id="fres"></div></div>` : '';
  render(isNew ? 'Neue Pflanze' : 'Bearbeiten', `${scanCard}<form id="f">
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
  if (isNew) {
    const pickForm = async e => {
      const file = e.target.files && e.target.files[0]; e.target.value = ''; if (!file || formBusy) return;
      formScanFile = file; formBusy = true; const out = $('#fres');
      out.innerHTML = '<p><span class="spin"></span> Erkenne …</p>';
      try {
        const L = await lookupAll(file); formResults = L.items;
        out.innerHTML = formResults.length
          ? '<p class="muted">Passenden Vorschlag antippen:</p>' + L.note.map(n => `<p class="hint">${esc(n)}</p>`).join('') + formResults.map((r, i) => `<button type="button" class="sec" style="display:block;width:100%;text-align:left;margin:6px 0" data-fpick="${i}">${esc((r.species.commonNames || [])[0] || r.species.scientificNameWithoutAuthor)}<br><span class="hint">${esc(r.species.scientificNameWithoutAuthor)} · ${esc(r.label)}</span></button>`).join('')
            + '<p class="hint">Bei geringer Sicherheit nicht verlassen. Foto wird beim Speichern der Pflanze zugeordnet.</p>'
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
      location: fd.get('location'), waterDays: Number(fd.get('waterDays')) || 7,
      lastWatered: fd.get('lastWatered') || '', fertDays: fd.get('fertDays') ? Number(fd.get('fertDays')) : '',
      lastFert: fd.get('lastFert') || '', notes: fd.get('notes').trim()
    });
    if (!rec.dbId) { const m = dbMatch(rec.latin); if (m && m.exact) rec.dbId = m.entry.id; }
    rec.dbApprox = origApprox && rec.dbId === origDbId;
    const file = fd.get('photo');
    if (file && file.size) {
      try { const b = await shrink(file, 640, 0.8); if (rec.photo) await delPhoto(rec.photo); rec.photo = await putPhoto(b); }
      catch (e) { toast('Foto konnte nicht gespeichert werden'); }
    } else if (formScanFile) {
      try { rec.photo = await putPhoto(await shrink(formScanFile, 640, 0.8)); } catch (e) { toast('Foto konnte nicht gespeichert werden'); }
    } else if (fromScan && fromScan.photo) rec.photo = fromScan.photo;
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
  const hasKey = !!state.settings.plantnetKey;
  render('Scan', `${modeTabs('pflanze')}<div class="card"><div class="name">Pflanze erkennen</div>
    <p class="muted">Foto von Blatt, Blüte oder der ganzen Pflanze. Das Bild geht zur Erkennung an Pl@ntNet und/oder Claude (siehe „Mehr“).</p>
    ${hasKey || state.settings.anthropicKey ? '' : '<div class="warnbox">Noch kein Schlüssel hinterlegt. <a href="#einstellungen">Jetzt unter „Mehr“ eintragen</a> (kostenlos, 500 Erkennungen pro Tag).</div>'}
    <div class="actions">
      <div class="pick"><span class="btn">📷 Foto aufnehmen</span><input id="scancam" type="file" accept="image/*" capture="environment" aria-label="Foto aufnehmen"></div>
      <div class="pick"><span class="btn sec">🖼 Aus Galerie</span><input id="scangal" type="file" accept="image/*" aria-label="Foto aus Galerie wählen"></div>
    </div>
    <img id="scanprev" class="big" style="display:none;margin-top:6px" alt="">
    <div class="actions"><button id="scango" type="button" class="sec">Erkennen</button></div>
    <div id="scanres"></div><p class="hint">${VERSION}</p></div>
  <div class="card"><div class="name">Giftig oder nicht? Nachschlagen</div>
    <input id="q" placeholder="z. B. Monstera, Lilie, Basilikum" autocomplete="off">
    <div id="qres"></div></div>`);
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
  $('#scango').addEventListener('click', identify);
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
async function claudeLookup(file) {
  if (!state.settings.anthropicKey) { const e = new Error('Schlüssel fehlt'); e.code = 'nokey'; throw e; }
  const blob = await shrink(file, 1024, 0.85);
  if (!blob) throw new Error('Das Foto konnte nicht gelesen werden.');
  const r = await AI.run('art', 'Bestimme die Pflanze auf dem Foto. Beachte: Zimmerpflanze, Gartenpflanze oder Wildpflanze in Mitteleuropa möglich.', [blob], 700);
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
  const ok = res.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
  const bad = res.filter(r => r.status === 'rejected').map(r => r.reason);
  if (!ok.length && bad.length) throw bad[0];
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
  if (e.code === 'nokey') return 'Für die Erkennung fehlt der Pl@ntNet-Schlüssel. <a href="#einstellungen">Unter „Mehr“ eintragen</a>, danach das Foto erneut wählen.';
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
    if (!results.length) { out.innerHTML = '<p class="muted">Keine Pflanze erkannt. Anderes Foto versuchen (Blatt oder Blüte, gutes Licht).</p>'; return; }
    window.__scanResults = results;
    out.innerHTML = L.note.map(n => `<div class="warnbox">${esc(n)}</div>`).join('') + results.map((r, i) => {
      const sci = r.species.scientificNameWithoutAuthor, common = (r.species.commonNames || [])[0] || '';
      const m = dbMatch(sci);
      return `<div class="card"><div class="name">${esc(common || sci)}</div><div class="muted">${esc(sci)} · ${esc(r.species.family?.scientificNameWithoutAuthor || '')}</div>
      ${srcBadge(r)}${r.why ? `<p class="hint">${esc(r.why)}${r.check ? ' Prüfen: ' + esc(r.check) : ''}</p>` : ''}
      ${m ? `<span class="badge ${toxClass(m.entry.katze)}">Katze: ${esc(m.entry.katze)}</span><span class="badge ${toxClass(m.entry.hund)}">Hund: ${esc(m.entry.hund)}</span>${m.exact ? '' : '<p class="hint">Giftangabe gilt für verwandte Art derselben Gattung, nur Anhaltspunkt.</p>'}`
        : '<p class="hint">Keine Giftigkeits-Daten in der App.</p>'}
      <div class="actions"><button class="small" data-add="${i}">Zur Sammlung</button><button class="small sec" data-wish="${i}">Wunschliste</button></div></div>`;
    }).join('') + '<p class="hint">Erkennung per Pl@ntNet (https://my.plantnet.org) und/oder Claude. Bei geringer Sicherheit nicht verlassen, besonders bei Giftigkeit.</p>';
  } catch (e) {
    out.innerHTML = `<div class="warnbox">${lookupErrorHTML(e)}</div>`;
  } finally { scanBusy = false; }
}


/* ---------- KI: Krankheit und Unkraut per Foto, Pflanzen-Infos ---------- */
const modeTabs = mode => `<div class="seg">
  <a href="#scan" class="${mode === 'pflanze' ? 'on' : ''}">Pflanze</a>
  <a href="#scan/krank" class="${mode === 'krank' ? 'on' : ''}">Krankheit</a>
  <a href="#scan/unkraut" class="${mode === 'unkraut' ? 'on' : ''}">Unkraut</a></div>`;
const spinner = '<p><span class="spin"></span> Claude wertet aus … (bis zu 30 Sekunden)</p>';
function aiErrorHTML(e) {
  if (e.code === 'nokey') return 'Für diese Funktion fehlt der Claude-Schlüssel. <a href="#einstellungen">Unter „Mehr“ eintragen</a>.';
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
    <p class="muted">${health ? 'Foto von kranken Blättern, Stielen oder der ganzen Pflanze. Bis zu 3 Fotos (zum Beispiel nah und weit) verbessern die Einschätzung.' : 'Foto vom Unkraut im Beet oder Rasen. Ein Foto von Blatt und Blüte hilft. Bis zu 3 Fotos.'} Die Fotos gehen zur Auswertung an Claude (Anthropic).</p>
    ${hasKey ? '' : '<div class="warnbox">Noch kein Claude-Schlüssel hinterlegt. <a href="#einstellungen">Unter „Mehr“ eintragen</a>.</div>'}
    ${plant ? `<p>Pflanze: <b>${esc(plant.name)}</b></p>` : (health ? '<label>Welche Pflanze? (optional)</label><input id="aiplant" autocomplete="off">' : '<label>Wo wächst es? (optional)</label><input id="aiplace" placeholder="z. B. Beet, Rasen, Gehweg" autocomplete="off">')}
    <label>${health ? 'Was fällt dir auf? (optional)' : 'Weitere Hinweise (optional)'}</label><textarea id="ainote"></textarea>
    <div class="actions">
      <div class="pick"><span class="btn small">📷 Foto aufnehmen</span><input id="aicam" type="file" accept="image/*" capture="environment" aria-label="Foto aufnehmen"></div>
      <div class="pick"><span class="btn sec small">🖼 Aus Galerie</span><input id="aigal" type="file" accept="image/*" aria-label="Foto aus Galerie wählen"></div>
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
      const r = await AI.run(mode, text, blobs, 2500);
      aiLast = { mode, data: r.data, model: r.model, plantId: plant ? plant.id : null };
      out.innerHTML = (health ? AI.renderHealth(r.data) : AI.renderWeed(r.data)) + usageLine(r.use)
        + (plant && health ? `<div class="actions"><button type="button" data-aisave="1">Ergebnis bei „${esc(plant.name)}“ speichern</button></div>` : '');
    } catch (e) { out.innerHTML = `<div class="warnbox">${aiErrorHTML(e)}</div>`; }
    finally { aiBusy = false; }
  });
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
    const r = await AI.run('info', text, blobs, 2500);
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
  <div class="card"><div class="name">Claude-Schlüssel (für Infos, Krankheit, Unkraut)</div>
    <p class="muted">Eigener API-Schlüssel von platform.claude.com. Bleibt nur auf diesem Gerät. Jede Auswertung kostet Geld. Setze in der Console unter Billing ein niedriges Ausgabenlimit.</p>
    <input id="akey" value="${esc(s.anthropicKey || '')}" placeholder="sk-ant-…" autocomplete="off" autocapitalize="off">
    <label>Pflanzenerkennung per Foto</label><select id="aerk">${[['beide','Beide (Pl@ntNet und Claude, ca. 1 Cent)'],['plantnet','Nur Pl@ntNet (gratis)'],['claude','Nur Claude']].map(([k, v]) => `<option value="${k}" ${(s.erkennung || 'beide') === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <label>Modell</label><select id="amodel">${Object.entries(AI.MODELS).map(([k, v]) => `<option value="${k}" ${(s.aiModel || AI.DEFAULT_MODEL) === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
    <div class="actions"><button id="saveai">Speichern</button><button id="testai" class="sec">Verbindung testen</button></div>
    <div id="aitest"></div>
    <p class="hint">Bisher: ${(s.aiUsage || {}).calls || 0} Auswertungen, ${((s.aiUsage || {}).inTok || 0) + ((s.aiUsage || {}).outTok || 0)} Tokens, geschätzt ${(((s.aiUsage || {}).usd || 0) * 100).toFixed(1)} Cent (Schätzung nach Listenpreis, maßgeblich ist die Console).
    <a href="#einstellungen" id="resetuse">Zähler zurücksetzen</a></p></div>
  <div class="card"><div class="name">Backup</div>
    <p class="muted">Daten liegen nur auf diesem Gerät. iOS kann Browserdaten löschen, wenn die App lange nicht genutzt wird. Exportiere regelmäßig.</p>
    <div class="actions"><button id="exp" class="sec">Exportieren</button><label class="btn sec" style="margin:0">Importieren<input id="imp" type="file" accept="application/json" hidden></label></div></div>
  <div class="card"><div class="name">Auf den Home-Bildschirm</div>
    <p class="muted">In Safari öffnen, Teilen-Symbol tippen, „Zum Home-Bildschirm“ wählen. Nur so gelten Kamera-Zugriff und Zahl am Icon zuverlässig.</p></div>
  <p class="hint">${VERSION}</p>
  <p class="hint">Pflanzenerkennung: Pl@ntNet. Pflegewerte und Giftangaben sind Richtwerte und kein Ersatz für Fachrat.</p>`);
  $('#saveset').onclick = () => {
    s.plantnetKey = $('#key').value.trim(); s.proxy = $('#proxy').value.trim(); s.winter = $('#winter').checked; save(); toast('Gespeichert');
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
    for (const p of state.plants) if (p.photo) { const b = await getPhoto(p.photo); if (b) photos[p.photo] = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); }); }
    const copy = { ...state, settings: { ...state.settings, plantnetKey: '', anthropicKey: '' } };
    const blob = new Blob([JSON.stringify({ version: 1, state: copy, photos })], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `pflanzen-backup-${today()}.json`; a.click();
  };
  $('#imp').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const j = JSON.parse(await f.text()); if (!j.state || !Array.isArray(j.state.plants)) throw new Error();
      if (!confirm('Vorhandene Daten auf diesem Gerät werden ersetzt. Fortfahren?')) return;
      const keep = { erkennung: state.settings.erkennung, plantnetKey: state.settings.plantnetKey, anthropicKey: state.settings.anthropicKey, aiModel: state.settings.aiModel, aiUsage: state.settings.aiUsage };
      for (const [id, data] of Object.entries(j.photos || {})) await idbOp('readwrite', st => st.put(await0(data), id));
      state = { ...defaults(), ...j.state }; state.settings = { ...defaults().settings, ...j.state.settings, ...keep };
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
  else if (D.aiinfo) await runAiInfo(D.aiinfo);
  else if (D.aisave) {
    const p = aiLast && state.plants.find(x => x.id === aiLast.plantId); if (!p) return;
    p.health = [...(p.health || []), { d: today(), model: aiLast.model, data: aiLast.data }].slice(-5); save(); toast('Gespeichert'); go('pflanze/' + p.id);
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
  load(); await loadDB();
  if ('serviceWorker' in navigator) {
    const had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) location.reload(); });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  route();
})();
