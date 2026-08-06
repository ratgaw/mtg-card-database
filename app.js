'use strict';

const SCRYFALL_API = 'https://api.scryfall.com';
const MTGJSON_API = 'https://mtgjson.com/api/v5';
const YEARS_BACK = 10;

// ---------- state ----------
let allSets = [];          // sets released in the last N years, from Scryfall
let currentRows = [];      // expanded, filtered result rows for the active search
let nextPageUrl = null;    // Scryfall pagination cursor
let rawPrints = [];        // raw Scryfall print objects accumulated across pages

// ---------- helpers ----------
function cutoffDate() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - YEARS_BACK);
  return d.toISOString().slice(0, 10);
}

function fmtMoney(v) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return '$' + Number(v).toFixed(2);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).details || ''; } catch (e) {}
    throw new Error(`Request failed (${res.status}): ${detail || url}`);
  }
  return res.json();
}

// Caps real concurrent HTTP requests app-wide (regardless of how many logical
// tasks want to fetch at once) so bursts — e.g. comparing several sets, each
// pulling several booster kinds — don't trip Scryfall's rate limiting.
class Semaphore {
  constructor(max) { this.max = max; this.count = 0; this.queue = []; }
  async acquire() {
    if (this.count < this.max) { this.count++; return; }
    await new Promise(res => this.queue.push(res));
    this.count++;
  }
  release() {
    this.count--;
    const next = this.queue.shift();
    if (next) next();
  }
  async run(fn) {
    await this.acquire();
    try { return await fn(); } finally { this.release(); }
  }
}
const scryfallGetLimiter = new Semaphore(5);
// POST /cards/collection needs a CORS preflight; concurrent preflighted requests
// are unreliable in some sandboxed/proxied browser environments (observed: two
// simultaneous POSTs both fail with a network-level error even though a lone
// POST or multiple concurrent GETs succeed) — serialize POSTs to be safe.
const scryfallPostLimiter = new Semaphore(1);

function fetchScryfallJson(url, opts) {
  const limiter = (opts && opts.method === 'POST') ? scryfallPostLimiter : scryfallGetLimiter;
  return limiter.run(() => fetchJson(url, opts));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------- set list ----------
async function loadSets() {
  const cutoff = cutoffDate();
  try {
    const data = await fetchScryfallJson(`${SCRYFALL_API}/sets`);
    allSets = data.data
      .filter(s => s.released_at && s.released_at >= cutoff)
      .sort((a, b) => (b.released_at || '').localeCompare(a.released_at || ''));
    renderSetCheckboxList('setList', '', 'set-checkbox', 'set');
    renderSetCheckboxList('compareSetList', '', 'compare-set-checkbox', 'cmp');
  } catch (e) {
    document.getElementById('setList').textContent = 'Failed to load set list: ' + e.message;
    document.getElementById('compareSetList').textContent = 'Failed to load set list: ' + e.message;
  }
}

function renderSetCheckboxList(containerId, filterText, checkboxClass, idPrefix) {
  const listEl = document.getElementById(containerId);
  const ft = filterText.trim().toLowerCase();
  const filtered = allSets.filter(s =>
    !ft || s.name.toLowerCase().includes(ft) || s.code.toLowerCase().includes(ft)
  );
  if (filtered.length === 0) {
    listEl.textContent = 'No sets match.';
    return;
  }
  listEl.innerHTML = filtered.map(s => `
    <div class="set-item">
      <input type="checkbox" class="${checkboxClass}" value="${s.code}" id="${idPrefix}-${s.code}">
      <label for="${idPrefix}-${s.code}">${escapeHtml(s.name)} <span class="hint">(${s.code.toUpperCase()}, ${s.released_at})</span></label>
    </div>
  `).join('');
}

function selectedSetCodes() {
  return Array.from(document.querySelectorAll('.set-checkbox:checked')).map(cb => cb.value);
}

function selectedCompareSetCodes() {
  return Array.from(document.querySelectorAll('.compare-set-checkbox:checked')).map(cb => cb.value);
}

// ---------- row expansion + classification ----------
const ALT_ART_FRAME_EFFECTS = new Set(['showcase', 'extendedart', 'inverted']);

function classifyPrint(card) {
  const frameEffects = card.frame_effects || [];
  const isAltArt = frameEffects.some(fe => ALT_ART_FRAME_EFFECTS.has(fe))
    || card.full_art === true
    || card.border_color === 'borderless';
  return { isAltArt };
}

function expandPrintToRows(card) {
  const { isAltArt } = classifyPrint(card);
  const finishes = card.finishes || [];

  const allPrices = {};
  for (const f of finishes) {
    let p = null;
    if (f === 'nonfoil') p = card.prices.usd;
    else if (f === 'foil') p = card.prices.usd_foil;
    else if (f === 'etched') p = card.prices.usd_etched;
    if (p !== null && p !== undefined) allPrices[f] = parseFloat(p);
  }

  const imageUri = (card.image_uris && card.image_uris.small) ||
    (card.card_faces && card.card_faces[0] && card.card_faces[0].image_uris && card.card_faces[0].image_uris.small) || null;
  const imageUriLarge = (card.image_uris && (card.image_uris.normal || card.image_uris.large)) ||
    (card.card_faces && card.card_faces[0] && card.card_faces[0].image_uris &&
      (card.card_faces[0].image_uris.normal || card.card_faces[0].image_uris.large)) || null;
  const tcgplayerUri = (card.purchase_uris && card.purchase_uris.tcgplayer) || null;
  const cardmarketUri = (card.purchase_uris && card.purchase_uris.cardmarket) || null;

  const rows = [];
  for (const finish of finishes) {
    const isBase = finish === 'nonfoil' && !isAltArt && !card.promo && !card.variation;
    rows.push({
      id: card.id,
      name: card.name,
      setCode: card.set,
      setName: card.set_name,
      collectorNumber: card.collector_number,
      rarity: card.rarity,
      finish,
      isAltArt,
      isBase,
      price: allPrices[finish] !== undefined ? allPrices[finish] : null,
      allPrices,
      imageUri,
      imageUriLarge,
      tcgplayerUri,
      cardmarketUri,
    });
  }
  return rows;
}

function applyClientFilters(rows) {
  const excludeFoil = document.getElementById('excludeFoil').checked;
  const excludeEtched = document.getElementById('excludeEtched').checked;
  const excludeAltArt = document.getElementById('excludeAltArt').checked;
  const excludeBase = document.getElementById('excludeBase').checked;
  const excludeNoPrice = document.getElementById('excludeNoPrice').checked;
  const minPrice = parseFloat(document.getElementById('minPrice').value);
  const maxPrice = parseFloat(document.getElementById('maxPrice').value);

  return rows.filter(r => {
    if (excludeFoil && r.finish === 'foil') return false;
    if (excludeEtched && r.finish === 'etched') return false;
    if (excludeAltArt && r.isAltArt) return false;
    if (excludeBase && r.isBase) return false;
    if (excludeNoPrice && r.price === null) return false;
    if (!isNaN(minPrice) && (r.price === null || r.price < minPrice)) return false;
    if (!isNaN(maxPrice) && (r.price === null || r.price > maxPrice)) return false;
    return true;
  });
}

function applySort(rows) {
  const sortOrder = document.getElementById('sortOrder').value;
  if (sortOrder === 'none') return rows;
  const dir = sortOrder === 'price-desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    if (a.price === null && b.price === null) return 0;
    if (a.price === null) return 1;  // nulls always sort last, either direction
    if (b.price === null) return -1;
    return (a.price - b.price) * dir;
  });
}

// ---------- search ----------
function buildQuery() {
  const name = document.getElementById('nameQuery').value.trim();
  const setCodes = selectedSetCodes();
  const parts = [`date>=${cutoffDate()}`];
  if (name) parts.push(name);
  if (setCodes.length) parts.push('(' + setCodes.map(c => `e:${c}`).join(' or ') + ')');
  return parts.join(' ');
}

async function runSearch() {
  const name = document.getElementById('nameQuery').value.trim();
  const setCodes = selectedSetCodes();
  if (!name && setCodes.length === 0) {
    document.getElementById('resultsSummary').innerHTML =
      '<span class="error-text">Enter a card name or select at least one set first.</span>';
    document.getElementById('results').innerHTML = '';
    document.getElementById('loadMoreBtn').classList.add('hidden');
    return;
  }

  rawPrints = [];
  nextPageUrl = null;
  document.getElementById('results').innerHTML = '';
  document.getElementById('resultsSummary').textContent = 'Searching…';

  const query = buildQuery();
  const url = `${SCRYFALL_API}/cards/search?q=${encodeURIComponent(query)}&unique=prints&order=set&dir=desc`;

  try {
    await fetchSearchPage(url);
    await autoFetchPages(2); // fetch first page + 2 more automatically
    renderResults();
  } catch (e) {
    document.getElementById('resultsSummary').innerHTML = `<span class="error-text">${e.message}</span>`;
  }
}

async function fetchSearchPage(url) {
  const data = await fetchScryfallJson(url);
  rawPrints = rawPrints.concat(data.data);
  nextPageUrl = data.has_more ? data.next_page : null;
}

async function autoFetchPages(maxAdditionalPages) {
  let fetched = 0;
  while (nextPageUrl && fetched < maxAdditionalPages) {
    await sleep(100);
    await fetchSearchPage(nextPageUrl);
    fetched++;
  }
  document.getElementById('loadMoreBtn').classList.toggle('hidden', !nextPageUrl);
}

async function loadMore() {
  if (!nextPageUrl) return;
  document.getElementById('loadMoreBtn').textContent = 'Loading…';
  await sleep(100);
  await fetchSearchPage(nextPageUrl);
  document.getElementById('loadMoreBtn').textContent = 'Load more';
  document.getElementById('loadMoreBtn').classList.toggle('hidden', !nextPageUrl);
  renderResults();
}

// ---------- rendering ----------
let resultView = 'table';
let rowLookup = new Map();

function buildRowLookup(rows) {
  rowLookup = new Map();
  for (const r of rows) rowLookup.set(`${r.id}:${r.finish}`, r);
}

function renderResults() {
  const allRows = rawPrints.flatMap(expandPrintToRows);
  currentRows = applySort(applyClientFilters(allRows));
  buildRowLookup(currentRows);

  document.getElementById('resultsSummary').textContent =
    `${currentRows.length} row(s) across ${rawPrints.length} printing(s) loaded` +
    (nextPageUrl ? ' (more available)' : '');

  const groupBySet = document.getElementById('groupBySet').checked;
  const container = document.getElementById('results');

  if (!groupBySet) {
    container.innerHTML = renderCards(currentRows);
    return;
  }

  const groups = new Map();
  for (const row of currentRows) {
    if (!groups.has(row.setCode)) groups.set(row.setCode, []);
    groups.get(row.setCode).push(row);
  }

  const sortedSetCodes = Array.from(groups.keys()).sort();
  container.innerHTML = sortedSetCodes.map(code => {
    const rows = groups.get(code);
    const setName = rows[0].setName;
    const avg = rows.reduce((s, r) => s + (r.price || 0), 0) / (rows.filter(r => r.price !== null).length || 1);
    return `
      <div class="set-group">
        <div class="set-group-header">
          <span class="set-title">${escapeHtml(setName)} (${code.toUpperCase()})</span>
          <span class="set-meta">${rows.length} rows &middot; avg ${fmtMoney(avg)}</span>
          <button class="booster-ev-btn" data-set="${code}" data-setname="${escapeHtml(setName)}">Booster EV</button>
        </div>
        ${renderCards(rows)}
      </div>
    `;
  }).join('');

  container.querySelectorAll('.booster-ev-btn').forEach(btn => {
    btn.addEventListener('click', () => openBoosterModal(btn.dataset.set, btn.dataset.setname));
  });
}

function renderCards(rows) {
  return resultView === 'grid' ? renderGrid(rows) : renderTable(rows);
}

function renderTable(rows) {
  if (rows.length === 0) return '<p class="hint">No rows match the current filters.</p>';
  return `
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Set</th>
          <th>#</th>
          <th>Rarity</th>
          <th>Finish</th>
          <th>Flags</th>
          <th class="price-cell">Price</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr data-rowkey="${r.id}:${r.finish}">
            <td>${escapeHtml(r.name)}</td>
            <td>${r.setCode.toUpperCase()}</td>
            <td>${r.collectorNumber}</td>
            <td>${r.rarity}</td>
            <td><span class="finish-badge ${r.finish}">${r.finish}</span></td>
            <td>${r.isAltArt ? 'alt-art ' : ''}${r.isBase ? 'base' : ''}</td>
            <td class="price-cell">${fmtMoney(r.price)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderGrid(rows) {
  if (rows.length === 0) return '<p class="hint">No rows match the current filters.</p>';
  return `
    <div class="card-grid">
      ${rows.map(r => `
        <div class="card-tile" data-rowkey="${r.id}:${r.finish}">
          ${r.imageUri
            ? `<img src="${r.imageUri}" alt="${escapeHtml(r.name)}" loading="lazy">`
            : `<div class="card-tile-noart">${escapeHtml(r.name)}</div>`}
          <div class="card-tile-info">
            <div class="card-tile-name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</div>
            <div class="card-tile-meta">
              <span class="finish-badge ${r.finish}">${r.finish}</span>
              <span class="card-tile-price">${fmtMoney(r.price)}</span>
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

// ---------- booster EV ----------

// MTGJSON per-set data is used by both the booster-EV modal and the per-card
// "found in boosters" lookup — cache it (as a promise, so concurrent callers
// share one in-flight fetch instead of duplicating it).
const mtgjsonSetCache = new Map();
function getMtgjsonSetData(setCode) {
  const code = setCode.toUpperCase();
  if (mtgjsonSetCache.has(code)) return mtgjsonSetCache.get(code);
  const promise = fetchJson(`${MTGJSON_API}/${code}.json`)
    .then(d => d.data)
    .catch(e => { mtgjsonSetCache.delete(code); throw e; });
  mtgjsonSetCache.set(code, promise);
  return promise;
}

function buildUuidToScryfallId(setData) {
  const map = new Map();
  for (const c of setData.cards || []) {
    if (c.identifiers && c.identifiers.scryfallId) map.set(c.uuid, c.identifiers.scryfallId);
  }
  for (const t of setData.tokens || []) {
    if (t.identifiers && t.identifiers.scryfallId) map.set(t.uuid, t.identifiers.scryfallId);
  }
  return map;
}

// WotC renamed "Set Booster" (+ "Draft Booster") to "Play Booster" starting
// with sets released in late 2024; MTGJSON reflects this as a `play` key
// instead of `set`. Both share the same sheets/boosters/boostersTotalWeight
// schema, so `play` is normalized to the `set` slot everywhere in this app
// (comparison chart series, colors, sort order) — only the per-set modal and
// the per-card "found in" list show the real product name from MTGJSON.
const BOOSTER_KIND_ORDER = ['set', 'play', 'collector', 'draft', 'collector-sample', 'arena', 'prerelease'];

function labelForKind(kind) {
  const labels = {
    set: 'Set Booster',
    play: 'Play Booster',
    collector: 'Collector Booster',
    draft: 'Draft Booster',
    arena: 'Arena Booster',
    'collector-sample': 'Collector Sample Pack',
    prerelease: 'Prerelease Pack',
  };
  return labels[kind] || kind;
}

async function openBoosterModal(setCode, setName) {
  const modal = document.getElementById('boosterModal');
  const body = document.getElementById('boosterModalBody');
  const heading = `${escapeHtml(setName)} (${setCode.toUpperCase()})`;
  modal.classList.remove('hidden');
  body.innerHTML = `<h3>${heading}</h3><p>Loading booster data…</p>`;

  try {
    const result = await computeBoosterEV(setCode);
    if (!result || Object.keys(result.ev).length === 0) {
      body.innerHTML = `<h3>${heading}</h3><p>No booster data available for this set in MTGJSON.</p>`;
      return;
    }
    const order = ['set', 'collector', 'draft'];
    const kinds = Object.keys(result.ev).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    body.innerHTML = `
      <h3>${heading}</h3>
      <p class="hint">Expected value = sum over each booster's weighted card sheets × current Scryfall price.</p>
      ${kinds.map(k => `
        <div class="ev-row">
          <span>${escapeHtml(result.names[k] || labelForKind(k))}</span>
          <span class="ev-value">${fmtMoney(result.ev[k])}</span>
        </div>
      `).join('')}
    `;
  } catch (e) {
    body.innerHTML = `<h3>${heading}</h3><p class="error-text">${escapeHtml(e.message)}</p>`;
  }
}

// Returns { ev: {set, collector, draft} -> dollar EV, names: {set, collector, draft} -> real product name }
async function computeBoosterEV(setCode) {
  const setData = await getMtgjsonSetData(setCode);
  const booster = setData.booster;
  if (!booster) return null;

  const uuidToScryfallId = buildUuidToScryfallId(setData);

  const kindForSlot = {};
  if (booster.set) kindForSlot.set = 'set';
  else if (booster.play) kindForSlot.set = 'play';
  if (booster.collector) kindForSlot.collector = 'collector';
  if (booster.draft) kindForSlot.draft = 'draft';

  const slots = Object.keys(kindForSlot);
  const evs = await Promise.all(slots.map(slot => evForBoosterKind(booster[kindForSlot[slot]], uuidToScryfallId)));
  const ev = {};
  const names = {};
  slots.forEach((slot, i) => {
    ev[slot] = evs[i];
    names[slot] = booster[kindForSlot[slot]].name || labelForKind(kindForSlot[slot]);
  });
  return { ev, names };
}

// Which booster products (by their real MTGJSON product name) contain this specific print.
async function getCardBoosterAvailability(setCode, scryfallId) {
  const setData = await getMtgjsonSetData(setCode);
  const booster = setData.booster;
  if (!booster) return { found: false };

  let uuid = null;
  for (const c of setData.cards || []) {
    if (c.identifiers && c.identifiers.scryfallId === scryfallId) { uuid = c.uuid; break; }
  }
  if (!uuid) {
    for (const t of setData.tokens || []) {
      if (t.identifiers && t.identifiers.scryfallId === scryfallId) { uuid = t.uuid; break; }
    }
  }
  if (!uuid) return { found: false };

  const availability = [];
  const kinds = Object.keys(booster).sort((a, b) => BOOSTER_KIND_ORDER.indexOf(a) - BOOSTER_KIND_ORDER.indexOf(b));
  for (const kind of kinds) {
    const bd = booster[kind];
    const sheetNames = [];
    for (const sheetName in bd.sheets) {
      if (uuid in bd.sheets[sheetName].cards) sheetNames.push(sheetName);
    }
    if (sheetNames.length > 0) {
      availability.push({ kind, label: bd.name || labelForKind(kind), sheetNames });
    }
  }
  return { found: true, availability };
}

// ---------- card detail modal ----------
async function openCardModal(row) {
  const modal = document.getElementById('cardModal');
  const body = document.getElementById('cardModalBody');
  modal.classList.remove('hidden');

  const finishOrder = ['nonfoil', 'foil', 'etched'];
  const finishKeys = Object.keys(row.allPrices).sort((a, b) => finishOrder.indexOf(a) - finishOrder.indexOf(b));
  const priceRowsHtml = finishKeys.length > 0 ? finishKeys.map(finish => `
    <div class="ev-row">
      <span><span class="finish-badge ${finish}">${finish}</span>${finish === row.finish ? ' (this printing)' : ''}</span>
      <span class="ev-value">${fmtMoney(row.allPrices[finish])}</span>
    </div>
  `).join('') : '<p class="hint">No price data available.</p>';

  const purchaseLinks = [];
  if (row.tcgplayerUri) purchaseLinks.push(`<a href="${row.tcgplayerUri}" target="_blank" rel="noopener noreferrer">View / sell on TCGPlayer &rarr;</a>`);
  if (row.cardmarketUri) purchaseLinks.push(`<a href="${row.cardmarketUri}" target="_blank" rel="noopener noreferrer">View / sell on Cardmarket &rarr;</a>`);

  body.innerHTML = `
    <div class="card-modal-layout">
      <div class="card-modal-image">
        ${row.imageUriLarge
          ? `<img src="${row.imageUriLarge}" alt="${escapeHtml(row.name)}">`
          : `<div class="card-tile-noart">${escapeHtml(row.name)}</div>`}
      </div>
      <div class="card-modal-info">
        <h3>${escapeHtml(row.name)}</h3>
        <p class="hint">${escapeHtml(row.setName)} (${row.setCode.toUpperCase()}) &middot; #${escapeHtml(String(row.collectorNumber))} &middot; ${escapeHtml(row.rarity)}</p>
        <h4>Pricing <span class="hint">(market / buy price)</span></h4>
        ${priceRowsHtml}
        ${purchaseLinks.length > 0 ? `<div class="purchase-links">${purchaseLinks.join('')}</div>` : ''}
        <p class="hint">Scryfall only has market (buy) prices &mdash; use the link${purchaseLinks.length === 1 ? '' : 's'} above to see the current sell/buylist price on the vendor's own site.</p>
        <h4>Found in boosters</h4>
        <div id="cardModalBoosters"><p class="hint">Loading booster availability…</p></div>
      </div>
    </div>
  `;

  const boostersEl = document.getElementById('cardModalBoosters');
  try {
    const avail = await getCardBoosterAvailability(row.setCode, row.id);
    if (!avail || !avail.found) {
      boostersEl.innerHTML = '<p class="hint">No booster data available for this set in MTGJSON.</p>';
      return;
    }
    if (avail.availability.length === 0) {
      boostersEl.innerHTML = '<p class="hint">Not found in any published booster product for this set (may be a promo, prerelease-only, or other non-booster printing).</p>';
      return;
    }
    boostersEl.innerHTML = avail.availability.map(a => `
      <div class="ev-row">
        <span>${escapeHtml(a.label)}</span>
        <span class="hint">${a.sheetNames.map(escapeHtml).join(', ')}</span>
      </div>
    `).join('');
  } catch (e) {
    boostersEl.innerHTML = `<p class="error-text">${escapeHtml(e.message)}</p>`;
  }
}

async function evForBoosterKind(bd, uuidToScryfallId) {
  // gather every scryfallId referenced by this booster kind's sheets
  const idSet = new Set();
  for (const sheetName in bd.sheets) {
    for (const uuid in bd.sheets[sheetName].cards) {
      const sid = uuidToScryfallId.get(uuid);
      if (sid) idSet.add(sid);
    }
  }
  const priceMap = await fetchPricesBatch(Array.from(idSet));

  const sheetEV = {};
  for (const sheetName in bd.sheets) {
    const sheet = bd.sheets[sheetName];
    let ev = 0;
    for (const uuid in sheet.cards) {
      const weight = sheet.cards[uuid];
      const sid = uuidToScryfallId.get(uuid);
      const prices = sid ? priceMap.get(sid) : null;
      if (!prices) continue;
      const priceStr = sheet.foil ? (prices.usd_foil ?? prices.usd) : (prices.usd ?? prices.usd_foil);
      const price = priceStr ? parseFloat(priceStr) : 0;
      ev += (weight / sheet.totalWeight) * price;
    }
    sheetEV[sheetName] = ev;
  }

  let totalWeighted = 0;
  for (const config of bd.boosters) {
    let configEV = 0;
    for (const sheetName in config.contents) {
      configEV += config.contents[sheetName] * (sheetEV[sheetName] || 0);
    }
    totalWeighted += config.weight * configEV;
  }
  return totalWeighted / bd.boostersTotalWeight;
}

async function fetchPricesBatch(scryfallIds) {
  const priceMap = new Map();
  const chunkSize = 75;
  for (let i = 0; i < scryfallIds.length; i += chunkSize) {
    const chunk = scryfallIds.slice(i, i + chunkSize);
    if (i > 0) await sleep(100);
    const data = await fetchScryfallJson(`${SCRYFALL_API}/cards/collection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifiers: chunk.map(id => ({ id })) }),
    });
    for (const card of data.data) {
      priceMap.set(card.id, card.prices);
    }
  }
  return priceMap;
}

// ---------- compare sets by booster EV ----------
const BOOSTER_SERIES = [
  { key: 'set', label: 'Set / Play Booster', varName: '--series-set' },
  { key: 'collector', label: 'Collector Booster', varName: '--series-collector' },
  { key: 'draft', label: 'Draft Booster', varName: '--series-draft' },
];

let compareResultsData = [];
let compareSortKey = 'name';
let compareSortDir = 1;

async function runCompare() {
  const codes = selectedCompareSetCodes();
  const summaryEl = document.getElementById('compareSummary');
  const chartEl = document.getElementById('compareChart');
  const tableEl = document.getElementById('compareTableWrap');

  if (codes.length === 0) {
    summaryEl.innerHTML = '<span class="error-text">Select at least one set to compare.</span>';
    return;
  }

  summaryEl.textContent = `Computing booster EV for ${codes.length} set(s)…`;
  chartEl.innerHTML = '';
  tableEl.innerHTML = '';

  compareResultsData = await mapWithConcurrency(codes, 4, async (code) => {
    const setMeta = allSets.find(s => s.code === code);
    const name = setMeta ? setMeta.name : code.toUpperCase();
    try {
      const result = await computeBoosterEV(code);
      const ev = (result && result.ev) || {};
      return { code, name, ev, error: Object.keys(ev).length === 0 ? 'No booster data' : null };
    } catch (e) {
      return { code, name, ev: {}, error: e.message };
    }
  });

  compareSortKey = 'name';
  compareSortDir = 1;
  renderCompareResults();
}

function renderCompareResults() {
  const valid = compareResultsData.filter(r => r.ev && Object.keys(r.ev).length > 0);
  const skipped = compareResultsData.filter(r => !r.ev || Object.keys(r.ev).length === 0);

  const summaryEl = document.getElementById('compareSummary');
  summaryEl.innerHTML = `${valid.length} of ${compareResultsData.length} set(s) have booster data.` +
    (skipped.length ? ` <span class="hint">Skipped: ${skipped.map(s => escapeHtml(s.name)).join(', ')}.</span>` : '');

  const sorted = [...valid].sort((a, b) => {
    let av, bv;
    if (compareSortKey === 'name') {
      return a.name.localeCompare(b.name) * compareSortDir;
    } else if (compareSortKey === 'ratio') {
      av = (a.ev.collector !== undefined && a.ev.set) ? a.ev.collector / a.ev.set : -Infinity;
      bv = (b.ev.collector !== undefined && b.ev.set) ? b.ev.collector / b.ev.set : -Infinity;
    } else {
      av = a.ev[compareSortKey] !== undefined ? a.ev[compareSortKey] : -Infinity;
      bv = b.ev[compareSortKey] !== undefined ? b.ev[compareSortKey] : -Infinity;
    }
    return (av - bv) * compareSortDir;
  });

  renderCompareChart(sorted);
  renderCompareTable(sorted);
}

function renderCompareChart(sorted) {
  const chartEl = document.getElementById('compareChart');
  if (sorted.length === 0) { chartEl.innerHTML = ''; return; }

  const presentSeries = BOOSTER_SERIES.filter(s => sorted.some(r => r.ev[s.key] !== undefined));
  const maxVal = Math.max(0.01, ...sorted.flatMap(r => presentSeries.map(s => r.ev[s.key] || 0)));

  const legend = presentSeries.map(s => `
    <div class="legend-item"><span class="legend-swatch" style="background:var(${s.varName})"></span>${s.label}</div>
  `).join('');

  const groups = sorted.map(r => `
    <div class="chart-group">
      <div class="chart-group-title">${escapeHtml(r.name)} (${r.code.toUpperCase()})</div>
      ${presentSeries.map(s => {
        const val = r.ev[s.key];
        if (val === undefined) return '';
        const pct = Math.max((val / maxVal) * 100, 1);
        return `
          <div class="chart-bar-row">
            <div class="chart-bar-label">${s.label}</div>
            <div class="chart-bar-track"><div class="chart-bar-fill" style="width:${pct}%; background:var(${s.varName})"></div></div>
            <div class="chart-bar-value">${fmtMoney(val)}</div>
          </div>
        `;
      }).join('')}
    </div>
  `).join('');

  chartEl.innerHTML = `<div class="chart-legend">${legend}</div>${groups}`;
}

function renderCompareTable(sorted) {
  const wrap = document.getElementById('compareTableWrap');
  if (sorted.length === 0) {
    wrap.innerHTML = '<p class="hint">No comparable sets — try selecting sets with published Set/Collector booster products.</p>';
    return;
  }
  const presentSeries = BOOSTER_SERIES.filter(s => sorted.some(r => r.ev[s.key] !== undefined));
  const hasRatio = presentSeries.some(s => s.key === 'set') && presentSeries.some(s => s.key === 'collector');

  const sortArrow = key => compareSortKey === key ? (compareSortDir === 1 ? ' ↑' : ' ↓') : '';

  wrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th data-sort="name">Set${sortArrow('name')}</th>
          ${presentSeries.map(s => `<th data-sort="${s.key}">${s.label}${sortArrow(s.key)}</th>`).join('')}
          ${hasRatio ? `<th data-sort="ratio">Collector &divide; Set${sortArrow('ratio')}</th>` : ''}
        </tr>
      </thead>
      <tbody>
        ${sorted.map(r => `
          <tr>
            <td>${escapeHtml(r.name)} (${r.code.toUpperCase()})</td>
            ${presentSeries.map(s => `<td class="price-cell">${r.ev[s.key] !== undefined ? fmtMoney(r.ev[s.key]) : '—'}</td>`).join('')}
            ${hasRatio ? `<td class="price-cell">${(r.ev.collector !== undefined && r.ev.set) ? (r.ev.collector / r.ev.set).toFixed(2) + '×' : '—'}</td>` : ''}
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  wrap.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (compareSortKey === key) compareSortDir *= -1;
      else { compareSortKey = key; compareSortDir = 1; }
      renderCompareResults();
    });
  });
}

// ---------- wiring ----------
document.addEventListener('DOMContentLoaded', () => {
  loadSets();

  document.getElementById('searchBtn').addEventListener('click', runSearch);
  document.getElementById('loadMoreBtn').addEventListener('click', loadMore);
  document.getElementById('setFilterBox').addEventListener('input', e => renderSetCheckboxList('setList', e.target.value, 'set-checkbox', 'set'));
  document.getElementById('groupBySet').addEventListener('change', () => { if (rawPrints.length) renderResults(); });
  ['excludeFoil', 'excludeEtched', 'excludeAltArt', 'excludeBase', 'excludeNoPrice', 'minPrice', 'maxPrice'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => { if (rawPrints.length) renderResults(); });
  });
  document.getElementById('sortOrder').addEventListener('change', () => { if (rawPrints.length) renderResults(); });
  document.getElementById('nameQuery').addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });

  document.getElementById('results').addEventListener('click', e => {
    const el = e.target.closest('[data-rowkey]');
    if (!el) return;
    const row = rowLookup.get(el.dataset.rowkey);
    if (row) openCardModal(row);
  });

  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      resultView = btn.dataset.view;
      document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b === btn));
      if (rawPrints.length) renderResults();
    });
  });

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
      document.getElementById('browseView').classList.toggle('hidden', btn.dataset.tab !== 'browseView');
      document.getElementById('compareView').classList.toggle('hidden', btn.dataset.tab !== 'compareView');
    });
  });

  document.getElementById('compareBtn').addEventListener('click', runCompare);
  document.getElementById('compareSetFilterBox').addEventListener('input', e =>
    renderSetCheckboxList('compareSetList', e.target.value, 'compare-set-checkbox', 'cmp'));

  document.getElementById('closeModal').addEventListener('click', () => {
    document.getElementById('boosterModal').classList.add('hidden');
  });
  document.getElementById('boosterModal').addEventListener('click', e => {
    if (e.target.id === 'boosterModal') document.getElementById('boosterModal').classList.add('hidden');
  });

  document.getElementById('closeCardModal').addEventListener('click', () => {
    document.getElementById('cardModal').classList.add('hidden');
  });
  document.getElementById('cardModal').addEventListener('click', e => {
    if (e.target.id === 'cardModal') document.getElementById('cardModal').classList.add('hidden');
  });
});
