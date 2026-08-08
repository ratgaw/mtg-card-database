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
    const err = new Error(`Request failed (${res.status}): ${detail || url}`);
    err.status = res.status;
    throw err;
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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Retries a fetch on transient network errors (a dropped connection, a
// momentary rate-limit, a proxy hiccup) instead of letting one blip
// permanently kill whatever it was fetching for. Observed in practice: even
// with no concurrency at all, a lone request to Scryfall can fail 2-3 times
// in a row before succeeding — so this needs enough attempts and backoff to
// ride out a real streak, not just a single retry. Matters more as a
// comparison spans more sets/requests, since the odds of hitting at least
// one streak like that rise with the total request count.
//
// Only retries genuinely transient failures: a true network-level error (the
// request never got an HTTP response at all) or a server-side 429/5xx. A 4xx
// like 404 "no card found" or 400 "bad query" is a deterministic answer —
// retrying can't change it, so those fail immediately instead of wasting
// several seconds and spamming retries for no benefit.
async function fetchJsonWithRetry(url, opts, retries) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchJson(url, opts);
    } catch (e) {
      lastErr = e;
      const isRetryable = e.status === undefined || e.status === 429 || e.status >= 500;
      if (!isRetryable || attempt >= retries) throw e;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr;
}

// Modest concurrency caps (not a hard 1-at-a-time queue — normal concurrent
// fetch/POST traffic is routine and well-supported by both browsers and
// Scryfall) just to be a reasonable API citizen when a comparison fans out
// across several sets at once, each pulling several booster kinds.
const scryfallLimiter = new Semaphore(4);
const mtgjsonLimiter = new Semaphore(4);

function fetchScryfallJson(url, opts) {
  return scryfallLimiter.run(() => fetchJsonWithRetry(url, opts, 5));
}

// ---------- set list ----------
// "Fluff" set types that clutter the picker without being real card pools to
// browse: promo/token sets (they just mirror another set's cards), and
// digital-only sets (Alchemy, etc. — set_type is 'alchemy' but `digital` is
// the general flag that also catches other online-only categories).
const EXCLUDED_SET_TYPES = new Set(['promo', 'token']);

function isFluffSet(s) {
  return EXCLUDED_SET_TYPES.has(s.set_type) || s.digital === true;
}

// Sets whose release is still genuinely far off are teaser/spoiler-only
// listings with no real price data (e.g. a set released_at 3+ months out had
// only ~13% of cards priced). But retail preorder pricing routinely populates
// on TCGPlayer/Cardmarket a week or two *before* the official street date
// (observed: a set 6 days from release already had 93% price coverage) — a
// same-day cutoff would hide a set that's already perfectly usable. Allowing
// a forward-looking window catches that normal preorder window without
// pulling in sets that are still purely spoilers.
const UPCOMING_RELEASE_WINDOW_DAYS = 21;

function searchableUntilDate() {
  const d = new Date();
  d.setDate(d.getDate() + UPCOMING_RELEASE_WINDOW_DAYS);
  return d.toISOString().slice(0, 10);
}

async function loadSets() {
  const cutoff = cutoffDate();
  const until = searchableUntilDate();
  try {
    const data = await fetchScryfallJson(`${SCRYFALL_API}/sets`);
    allSets = data.data
      .filter(s => s.released_at && s.released_at >= cutoff && s.released_at <= until)
      .filter(s => !isFluffSet(s))
      .sort((a, b) => (b.released_at || '').localeCompare(a.released_at || ''));
    renderSetCheckboxList('setList', '', 'set-checkbox', 'set');
    renderSetCheckboxList('compareSetList', '', 'compare-set-checkbox', 'cmp');
    renderPackSetList('');
  } catch (e) {
    document.getElementById('setList').textContent = 'Failed to load set list: ' + e.message;
    document.getElementById('compareSetList').textContent = 'Failed to load set list: ' + e.message;
    document.getElementById('packSetList').textContent = 'Failed to load set list: ' + e.message;
  }
}

// A monochrome mask so the set symbol SVG (Scryfall's icons use whatever
// fill was baked into the file) always renders in the current theme's ink
// color instead of potentially being invisible (e.g. black-on-black in dark mode).
function setIconHtml(iconUri, altText) {
  if (!iconUri) return '';
  const url = iconUri.replace(/'/g, '%27');
  return `<span class="set-icon" style="-webkit-mask-image:url('${url}');mask-image:url('${url}');" title="${escapeHtml(altText || '')}"></span>`;
}

function getSetMeta(code) {
  return allSets.find(s => s.code === code);
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
      <label for="${idPrefix}-${s.code}">${setIconHtml(s.icon_svg_uri, s.name)}${escapeHtml(s.name)} <span class="hint">(${s.code.toUpperCase()}, ${s.released_at})</span></label>
    </div>
  `).join('');
}

function selectedSetCodes() {
  return Array.from(document.querySelectorAll('.set-checkbox:checked')).map(cb => cb.value);
}

function selectedCompareSetCodes() {
  return Array.from(document.querySelectorAll('.compare-set-checkbox:checked')).map(cb => cb.value);
}

// Click-drag multi-select across a set list: mousedown on an item flips it
// and starts "painting" that same state onto every other item the mouse
// passes over until mouseup, like a normal checkbox-list drag-select.
let dragSelectState = null;

function wireSetListDragSelect(containerId) {
  const container = document.getElementById(containerId);
  container.addEventListener('mousedown', e => {
    const item = e.target.closest('.set-item');
    if (!item) return;
    e.preventDefault();
    const cb = item.querySelector('input[type="checkbox"]');
    if (!cb) return;
    dragSelectState = !cb.checked;
    cb.checked = dragSelectState;
    document.body.classList.add('dragging-select');
  });
  container.addEventListener('mouseover', e => {
    if (dragSelectState === null) return;
    const item = e.target.closest('.set-item');
    if (!item) return;
    const cb = item.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = dragSelectState;
  });
}

document.addEventListener('mouseup', () => {
  dragSelectState = null;
  document.body.classList.remove('dragging-select');
});

function wireSelectAllClear(selectAllBtnId, clearBtnId, containerId, checkboxClass) {
  document.getElementById(selectAllBtnId).addEventListener('click', () => {
    document.querySelectorAll(`#${containerId} .${checkboxClass}`).forEach(cb => { cb.checked = true; });
  });
  document.getElementById(clearBtnId).addEventListener('click', () => {
    document.querySelectorAll(`#${containerId} .${checkboxClass}`).forEach(cb => { cb.checked = false; });
  });
}

// ---------- row expansion + classification ----------
const ALT_ART_FRAME_EFFECTS = new Set(['showcase', 'extendedart', 'inverted']);

// Specific, human-readable treatment labels (shown as badges) rather than one
// generic "alt art" flag — printings that look identical in a truncated name
// (e.g. several showcase/borderless/surge-foil variants of the same card)
// need to be tellable apart at a glance. `frame_effects` covers most border
// treatments; foil-specific treatments (surge foil, galaxy foil, etc.) live
// in `promo_types` instead.
const FRAME_EFFECT_LABELS = {
  showcase: 'Showcase',
  extendedart: 'Extended Art',
  inverted: 'Inverted',
};
const PROMO_TYPE_LABELS = {
  surgefoil: 'Surge Foil',
  galaxyfoil: 'Galaxy Foil',
  rainbowfoil: 'Rainbow Foil',
  halofoil: 'Halo Foil',
  confettifoil: 'Confetti Foil',
  doubleexposure: 'Double Exposure',
  gilded: 'Gilded',
  serialized: 'Serialized',
  neonink: 'Neon Ink',
  texturedfoil: 'Textured Foil',
  textured: 'Textured Foil',
  oilslick: 'Oil Slick Foil',
  stepandcompleat: 'Step-and-Compleat Foil',
};

function classifyPrint(card) {
  const frameEffects = card.frame_effects || [];
  const promoTypes = card.promo_types || [];

  // Border/frame treatments apply to the printing as a whole, regardless of
  // which finish a given row is. Foil treatments (surge foil, galaxy foil,
  // etc.) only make sense on the foil/etched row of a card — a nonfoil row
  // of the same printing shouldn't be badged "Surge Foil".
  const baseTreatments = [];
  frameEffects.forEach(fe => { if (FRAME_EFFECT_LABELS[fe]) baseTreatments.push(FRAME_EFFECT_LABELS[fe]); });
  if (card.full_art) baseTreatments.push('Full Art');
  if (card.border_color === 'borderless' && !frameEffects.includes('showcase')) baseTreatments.push('Borderless');

  const foilTreatments = [];
  promoTypes.forEach(pt => { if (PROMO_TYPE_LABELS[pt] && !foilTreatments.includes(PROMO_TYPE_LABELS[pt])) foilTreatments.push(PROMO_TYPE_LABELS[pt]); });

  const isAltArt = frameEffects.some(fe => ALT_ART_FRAME_EFFECTS.has(fe))
    || card.full_art === true
    || card.border_color === 'borderless';
  return { isAltArt, baseTreatments, foilTreatments };
}

function expandPrintToRows(card) {
  const { isAltArt, baseTreatments, foilTreatments } = classifyPrint(card);
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
    const treatments = finish === 'nonfoil' ? baseTreatments : baseTreatments.concat(foilTreatments);
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
      treatments,
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
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// A set-restriction clause with too many `e:code or e:code or ...` terms
// makes the query long enough that Scryfall truncates it server-side before
// parsing — the truncation lands mid-expression and comes back as "unclosed
// parentheses" rather than a clean length error. 20 codes per clause keeps
// every query comfortably short regardless of how many sets are selected
// (e.g. via "Select all"); large selections just become several chunked
// queries run back-to-back instead of one oversized one.
const SET_QUERY_CHUNK_SIZE = 20;

function buildQueryForSetChunk(name, setCodesChunk) {
  // Keep results consistent with the (already-filtered) set picker: no
  // promo/token reprints, no digital-only (Alchemy etc.), nothing further out
  // than the same near-term window the set picker itself allows.
  const parts = [`date>=${cutoffDate()}`, `date<=${searchableUntilDate()}`, '-st:promo', '-st:token', '-is:digital'];
  if (name) parts.push(name);
  if (setCodesChunk && setCodesChunk.length) parts.push('(' + setCodesChunk.map(c => `e:${c}`).join(' or ') + ')');
  return parts.join(' ');
}

// Remaining chunk base-URLs still to search, once the currently active
// chunk's own pages run out. fetchSearchPage pulls from this so "Load more"
// and the auto-fetch loop continue seamlessly across chunk boundaries
// without either of them needing to know chunking is happening at all.
let pendingChunkUrls = [];

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

  const setChunks = setCodes.length > 0 ? chunkArray(setCodes, SET_QUERY_CHUNK_SIZE) : [null];
  const chunkUrls = setChunks.map(chunk => {
    const query = buildQueryForSetChunk(name, chunk);
    return `${SCRYFALL_API}/cards/search?q=${encodeURIComponent(query)}&unique=prints&order=set&dir=desc`;
  });
  pendingChunkUrls = chunkUrls.slice(1);

  try {
    await fetchSearchPage(chunkUrls[0]);
    await autoFetchPages(2); // fetch first page + 2 more automatically
    renderResults();
  } catch (e) {
    document.getElementById('resultsSummary').innerHTML = `<span class="error-text">${e.message}</span>`;
  }
}

async function fetchSearchPage(url) {
  const data = await fetchScryfallJson(url);
  rawPrints = rawPrints.concat(data.data);
  if (data.has_more) {
    nextPageUrl = data.next_page;
  } else if (pendingChunkUrls.length > 0) {
    nextPageUrl = pendingChunkUrls.shift();
  } else {
    nextPageUrl = null;
  }
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
    const setMeta = getSetMeta(code);
    const avg = rows.reduce((s, r) => s + (r.price || 0), 0) / (rows.filter(r => r.price !== null).length || 1);
    return `
      <div class="set-group">
        <div class="set-group-header">
          <span class="set-title">${setIconHtml(setMeta && setMeta.icon_svg_uri, setName)}${escapeHtml(setName)} (${code.toUpperCase()})</span>
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
            <td>${r.treatments.map(t => `<span class="treatment-badge">${escapeHtml(t)}</span>`).join(' ')}${r.isBase ? '<span class="treatment-badge base">Base</span>' : ''}</td>
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
            ${r.treatments.length > 0 ? `<div class="card-tile-treatments">${r.treatments.map(t => `<span class="treatment-badge">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
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
  const promise = mtgjsonLimiter.run(() => fetchJsonWithRetry(`${MTGJSON_API}/${code}.json`, undefined, 5))
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
  const setMeta = getSetMeta(setCode);
  const heading = `${setIconHtml(setMeta && setMeta.icon_svg_uri, setName)}${escapeHtml(setName)} (${setCode.toUpperCase()})`;
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

// Returns { ev: {set, collector, draft} -> dollar EV, names: {...} -> real
// product name, coverage: {total, priced, fraction} for this set's printings }
async function computeBoosterEV(setCode) {
  const setData = await getMtgjsonSetData(setCode);
  const booster = setData.booster;
  if (!booster) return { ev: {}, names: {}, coverage: null };

  const kindForSlot = {};
  if (booster.set) kindForSlot.set = 'set';
  else if (booster.play) kindForSlot.set = 'play';
  if (booster.collector) kindForSlot.collector = 'collector';
  if (booster.draft) kindForSlot.draft = 'draft';
  const slots = Object.keys(kindForSlot);
  if (slots.length === 0) return { ev: {}, names: {}, coverage: null };

  const uuidToScryfallId = buildUuidToScryfallId(setData);
  const { priceMap, coverage } = await getSetCardData(setCode);

  const ev = {};
  const names = {};
  for (const slot of slots) {
    ev[slot] = evForBoosterKind(booster[kindForSlot[slot]], uuidToScryfallId, priceMap);
    names[slot] = booster[kindForSlot[slot]].name || labelForKind(kindForSlot[slot]);
  }
  return { ev, names, coverage };
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
        <p class="hint">${setIconHtml(getSetMeta(row.setCode) && getSetMeta(row.setCode).icon_svg_uri, row.setName)}${escapeHtml(row.setName)} (${row.setCode.toUpperCase()}) &middot; #${escapeHtml(String(row.collectorNumber))} &middot; ${escapeHtml(row.rarity)}</p>
        ${row.treatments.length > 0 ? `<p>${row.treatments.map(t => `<span class="treatment-badge">${escapeHtml(t)}</span>`).join(' ')}</p>` : ''}
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

function evForBoosterKind(bd, uuidToScryfallId, priceMap) {
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

// Fetches every printing in a set with one paginated GET sweep (unique:prints)
// and returns both a scryfallId -> prices map (for booster EV lookups) and
// price-coverage stats (for the >=50%-priced comparison gate) from that same
// sweep. This intentionally avoids Scryfall's POST /cards/collection batch
// endpoint: that endpoint requires a CORS preflight (a non-simple request),
// and in testing a preflighted POST failed intermittently — including when
// completely isolated with no concurrency at all — while plain GETs to the
// same API were consistently reliable. Search results already carry full
// price data per card, so a GET sweep gets the same data without ever
// tripping that failure mode.
async function getSetCardData(setCode) {
  let url = `${SCRYFALL_API}/cards/search?q=${encodeURIComponent('e:' + setCode)}&unique=prints`;
  const priceMap = new Map();
  let total = 0;
  let priced = 0;
  let pages = 0;
  while (url && pages < 8) {
    const data = await fetchScryfallJson(url);
    for (const card of data.data) {
      total++;
      priceMap.set(card.id, card.prices);
      const hasPrice = !!(card.prices && (card.prices.usd || card.prices.usd_foil || card.prices.usd_etched));
      if (hasPrice) priced++;
    }
    url = data.has_more ? data.next_page : null;
    pages++;
  }
  return { priceMap, coverage: { total, priced, fraction: total > 0 ? priced / total : 0 } };
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

  const allResults = await mapWithConcurrency(codes, 4, async (code) => {
    const setMeta = allSets.find(s => s.code === code);
    const name = setMeta ? setMeta.name : code.toUpperCase();
    try {
      const result = await computeBoosterEV(code);
      const ev = (result && result.ev) || {};
      if (Object.keys(ev).length === 0) {
        return { code, name, ev: {}, reason: 'no booster data' };
      }
      const coverage = result.coverage;
      if (!coverage || coverage.total === 0 || coverage.fraction < 0.5) {
        const pct = coverage ? Math.round(coverage.fraction * 100) : 0;
        return { code, name, ev: {}, reason: (!coverage || coverage.total === 0) ? 'no priced cards found' : `only ${pct}% of cards have price data` };
      }
      return { code, name, ev, reason: null };
    } catch (e) {
      return { code, name, ev: {}, reason: e.message };
    }
  });

  // Sets dropped for either reason are removed from the comparison entirely, not
  // just hidden from the chart — also uncheck them so a later re-compare doesn't
  // drag them along again.
  const removed = allResults.filter(r => Object.keys(r.ev).length === 0);
  compareResultsData = allResults.filter(r => Object.keys(r.ev).length > 0);
  removed.forEach(r => {
    const cb = document.querySelector(`.compare-set-checkbox[value="${r.code}"]`);
    if (cb) cb.checked = false;
  });

  summaryEl.innerHTML = `${compareResultsData.length} of ${allResults.length} set(s) shown below.` +
    (removed.length ? ` <span class="hint">Removed: ${removed.map(s => `${escapeHtml(s.name)} (${escapeHtml(s.reason)})`).join(', ')}.</span>` : '');

  compareSortKey = 'name';
  compareSortDir = 1;
  renderCompareResults();
}

function renderCompareResults() {
  const sorted = [...compareResultsData].sort((a, b) => {
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

  const groups = sorted.map(r => {
    const logged = getLoggedPackAverages(r.code);
    const loggedKeys = Object.keys(logged);
    const loggedHtml = loggedKeys.length > 0
      ? `<div class="logged-avg-note">${loggedKeys.map(k => {
          const seriesLabel = (BOOSTER_SERIES.find(s => s.key === k) || {}).label || k;
          const l = logged[k];
          return `Your logged avg (${seriesLabel}): ${fmtMoney(l.avg)} — ${l.count} pack${l.count === 1 ? '' : 's'}`;
        }).join(' &middot; ')}</div>`
      : '';
    return `
      <div class="chart-group">
        <div class="chart-group-title">${setIconHtml(getSetMeta(r.code) && getSetMeta(r.code).icon_svg_uri, r.name)}${escapeHtml(r.name)} (${r.code.toUpperCase()})</div>
        ${loggedHtml}
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
    `;
  }).join('');

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
            <td>${setIconHtml(getSetMeta(r.code) && getSetMeta(r.code).icon_svg_uri, r.name)}${escapeHtml(r.name)} (${r.code.toUpperCase()})</td>
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

// ---------- my collection ----------
// Everything here lives only in this browser's localStorage — there is no
// backend, no account, and no cross-device sync. Export/import (JSON) is the
// safety net against clearing site data or wanting to move to another device.
const COLLECTION_STORAGE_KEY = 'mtgCollectionData.v1';

function loadCollectionData() {
  try {
    const raw = localStorage.getItem(COLLECTION_STORAGE_KEY);
    if (!raw) return { cards: [], packSessions: [] };
    const parsed = JSON.parse(raw);
    return {
      cards: Array.isArray(parsed.cards) ? parsed.cards : [],
      packSessions: Array.isArray(parsed.packSessions) ? parsed.packSessions : [],
    };
  } catch (e) {
    return { cards: [], packSessions: [] };
  }
}

let collectionData = loadCollectionData();

function saveCollectionData() {
  localStorage.setItem(COLLECTION_STORAGE_KEY, JSON.stringify(collectionData));
}

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getActiveSession() {
  return collectionData.packSessions.find(s => s.finishedAt === null) || null;
}

function addCardToCollection(row, quantity) {
  const activeSession = getActiveSession();
  const sessionId = activeSession ? activeSession.sessionId : null;
  const existing = collectionData.cards.find(c =>
    c.scryfallId === row.id && c.finish === row.finish && c.packSessionId === sessionId);
  if (existing) {
    existing.quantity += quantity;
  } else {
    collectionData.cards.push({
      entryId: genId('card'),
      scryfallId: row.id,
      name: row.name,
      setCode: row.setCode,
      setName: row.setName,
      collectorNumber: row.collectorNumber,
      finish: row.finish,
      rarity: row.rarity,
      quantity,
      addedAt: new Date().toISOString(),
      packSessionId: sessionId,
    });
  }
  saveCollectionData();
  renderPackSessionPanel();
  renderCollectionTab();
}

function removeCollectionEntry(entryId) {
  collectionData.cards = collectionData.cards.filter(c => c.entryId !== entryId);
  saveCollectionData();
  renderPackSessionPanel();
  renderCollectionTab();
}

function setCollectionEntryQuantity(entryId, quantity) {
  if (quantity <= 0) { removeCollectionEntry(entryId); return; }
  const entry = collectionData.cards.find(c => c.entryId === entryId);
  if (!entry) return;
  entry.quantity = quantity;
  saveCollectionData();
  renderPackSessionPanel();
  renderCollectionTab();
}

// Per-set price data reused across collection re-renders within the same
// page load (quantity tweaks etc. shouldn't each re-sweep every set fresh).
const collectionPriceCache = new Map();
function getSetCardDataCached(setCode) {
  if (collectionPriceCache.has(setCode)) return collectionPriceCache.get(setCode);
  const promise = getSetCardData(setCode).catch(e => { collectionPriceCache.delete(setCode); throw e; });
  collectionPriceCache.set(setCode, promise);
  return promise;
}

async function priceForCollectionCards(cards) {
  const setCodes = [...new Set(cards.map(c => c.setCode))];
  const priceMapsBySet = new Map();
  await mapWithConcurrency(setCodes, 4, async (code) => {
    try {
      const { priceMap } = await getSetCardDataCached(code);
      priceMapsBySet.set(code, priceMap);
    } catch (e) {
      priceMapsBySet.set(code, new Map());
    }
  });

  let total = 0;
  const priced = cards.map(c => {
    const priceMap = priceMapsBySet.get(c.setCode);
    const prices = priceMap ? priceMap.get(c.scryfallId) : null;
    let unitPrice = null;
    if (prices) {
      if (c.finish === 'nonfoil' && prices.usd) unitPrice = parseFloat(prices.usd);
      else if (c.finish === 'foil' && prices.usd_foil) unitPrice = parseFloat(prices.usd_foil);
      else if (c.finish === 'etched' && prices.usd_etched) unitPrice = parseFloat(prices.usd_etched);
    }
    const lineTotal = unitPrice !== null ? unitPrice * c.quantity : null;
    if (lineTotal !== null) total += lineTotal;
    return Object.assign({}, c, { unitPrice, lineTotal });
  });
  return { total, priced };
}

// ---- search & add ----
let collectionSearchRows = [];

async function runCollectionSearch(nameQuery) {
  const resultsEl = document.getElementById('collectionSearchResults');
  if (!nameQuery || !nameQuery.trim()) { resultsEl.innerHTML = ''; return; }
  resultsEl.innerHTML = '<p class="hint">Searching…</p>';
  try {
    const query = `${nameQuery.trim()} date<=${searchableUntilDate()}`;
    // Sort by name (not release date): with noisy OCR-guessed text, the
    // actually-correct card needs to be easy to spot in the confirmation
    // list rather than buried among newer, unrelated broad-text matches.
    const url = `${SCRYFALL_API}/cards/search?q=${encodeURIComponent(query)}&unique=prints&order=name&dir=asc`;
    const data = await fetchScryfallJson(url);
    collectionSearchRows = data.data.flatMap(expandPrintToRows).slice(0, 60);
    renderCollectionSearchResults();
  } catch (e) {
    resultsEl.innerHTML = `<p class="error-text">${escapeHtml(e.message)}</p>`;
  }
}

function renderCollectionSearchResults() {
  const resultsEl = document.getElementById('collectionSearchResults');
  if (collectionSearchRows.length === 0) {
    resultsEl.innerHTML = '<p class="hint">No matches.</p>';
    return;
  }
  resultsEl.innerHTML = collectionSearchRows.map((r, i) => `
    <div class="search-result-row">
      <div class="sr-main">
        <div class="sr-name">${escapeHtml(r.name)}</div>
        <div class="sr-meta">
          ${setIconHtml(getSetMeta(r.setCode) && getSetMeta(r.setCode).icon_svg_uri, r.setName)}${r.setCode.toUpperCase()} &middot; #${escapeHtml(String(r.collectorNumber))} &middot; ${escapeHtml(r.rarity)}
          <span class="finish-badge ${r.finish}">${r.finish}</span>
          ${r.treatments.map(t => `<span class="treatment-badge">${escapeHtml(t)}</span>`).join('')}
        </div>
      </div>
      <div class="sr-side">
        <span class="sr-price">${fmtMoney(r.price)}</span>
        <button class="add-btn" data-idx="${i}">+ Add</button>
      </div>
    </div>
  `).join('');
  resultsEl.querySelectorAll('.add-btn').forEach(btn => {
    btn.addEventListener('click', () => addCardToCollection(collectionSearchRows[Number(btn.dataset.idx)], 1));
  });
}

// ---- camera / photo OCR scan ----
let tesseractLoadPromise = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  if (tesseractLoadPromise) return tesseractLoadPromise;
  tesseractLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.0.4/dist/tesseract.min.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Could not load the OCR library (offline, or blocked by an extension/network policy).'));
    document.head.appendChild(script);
  });
  return tesseractLoadPromise;
}

// MTG card names sit in a title bar near the top of the card, so among
// recognized text lines, the topmost reasonably-alphabetic one is the best
// guess at the name — full-card OCR also reads rules text, flavor text, set
// codes, etc., which this simple heuristic mostly filters out by position.
function bestGuessCardName(ocrData) {
  let candidates = [];
  if (ocrData.lines && ocrData.lines.length) {
    candidates = ocrData.lines.map(l => ({ text: l.text || '', y: (l.bbox && l.bbox.y0) || 0 }));
  } else if (ocrData.text) {
    candidates = ocrData.text.split('\n').map((t, i) => ({ text: t, y: i }));
  }
  candidates = candidates
    .map(c => ({ text: c.text.trim(), y: c.y }))
    .filter(c => c.text.length >= 3 && /[a-zA-Z]{3,}/.test(c.text));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.y - b.y);
  const cleaned = candidates[0].text.replace(/[^\w\s',\-]/g, '').trim();
  // Real card names are rarely more than a few words; a longer OCR line
  // likely ran on into adjacent text (mana cost, type line), so cap it —
  // better to search a shorter, cleaner guess than a noisy long one.
  return cleaned.split(/\s+/).slice(0, 5).join(' ');
}

async function handleScanFile(file) {
  const statusEl = document.getElementById('scanStatus');
  if (!file) return;
  statusEl.textContent = 'Loading OCR engine…';
  try {
    await loadTesseract();
    statusEl.textContent = 'Reading card text… (a few seconds)';
    const { data } = await Tesseract.recognize(file, 'eng');
    const guess = bestGuessCardName(data);
    if (!guess) {
      statusEl.innerHTML = '<span class="error-text">Could not read the card name confidently — try searching manually below.</span>';
      return;
    }
    // OCR text is noisy enough that a plain search (which AND-matches every
    // word) often returns nothing. Scryfall's fuzzy-name lookup is built for
    // exactly this — closest real card to an imperfect string — so resolve
    // through that first, then search for every printing of the real name.
    statusEl.textContent = `Detected "${guess}" — looking up the closest match…`;
    let resolvedName = guess;
    try {
      const card = await fetchScryfallJson(`${SCRYFALL_API}/cards/named?fuzzy=${encodeURIComponent(guess)}`);
      resolvedName = card.name;
    } catch (e) {
      // no confident fuzzy match — fall back to searching the raw OCR guess
    }
    statusEl.innerHTML = `Detected: <strong>${escapeHtml(resolvedName)}</strong> &mdash; pick the exact printing below to confirm.`;
    document.getElementById('collectionSearchBox').value = resolvedName;
    await runCollectionSearch(resolvedName);
  } catch (e) {
    statusEl.innerHTML = `<span class="error-text">${escapeHtml(e.message)}</span>`;
  }
}

// ---- log a pack ----
function renderPackSetList(filterText) {
  const listEl = document.getElementById('packSetList');
  const ft = (filterText || '').trim().toLowerCase();
  const filtered = allSets.filter(s => !ft || s.name.toLowerCase().includes(ft) || s.code.toLowerCase().includes(ft));
  if (filtered.length === 0) { listEl.textContent = 'No sets match.'; return; }
  listEl.innerHTML = filtered.map(s => `
    <div class="set-item">
      <input type="radio" name="packSetRadio" class="pack-set-radio" value="${s.code}" id="packset-${s.code}">
      <label for="packset-${s.code}">${setIconHtml(s.icon_svg_uri, s.name)}${escapeHtml(s.name)} <span class="hint">(${s.code.toUpperCase()})</span></label>
    </div>
  `).join('');
}

function startPackSession() {
  const checked = document.querySelector('.pack-set-radio:checked');
  if (!checked) { alert('Pick a set first.'); return; }
  const setCode = checked.value;
  const boosterKind = document.getElementById('packBoosterKindSelect').value;
  const setMeta = getSetMeta(setCode);
  const label = (BOOSTER_SERIES.find(s => s.key === boosterKind) || {}).label || boosterKind;
  collectionData.packSessions.push({
    sessionId: genId('pack'),
    setCode,
    setName: setMeta ? setMeta.name : setCode.toUpperCase(),
    boosterKind,
    boosterLabel: label,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    totalValue: null,
  });
  saveCollectionData();
  renderPackSessionPanel();
}

async function finishActiveSession() {
  const session = getActiveSession();
  if (!session) return;
  const cardsInSession = collectionData.cards.filter(c => c.packSessionId === session.sessionId);
  if (cardsInSession.length === 0 && !confirm('No cards added to this pack yet — finish anyway with a $0 total?')) return;
  const btn = document.getElementById('finishPackBtn');
  btn.disabled = true;
  try {
    const { total } = await priceForCollectionCards(cardsInSession);
    session.totalValue = total;
    session.finishedAt = new Date().toISOString();
    saveCollectionData();
    renderPackSessionPanel();
    renderCollectionTab();
  } finally {
    btn.disabled = false;
  }
}

function cancelActiveSession() {
  const session = getActiveSession();
  if (!session) return;
  if (!confirm('Cancel this pack? Cards already added stay in your collection, just untagged from any pack.')) return;
  collectionData.cards.forEach(c => { if (c.packSessionId === session.sessionId) c.packSessionId = null; });
  collectionData.packSessions = collectionData.packSessions.filter(s => s.sessionId !== session.sessionId);
  saveCollectionData();
  renderPackSessionPanel();
  renderCollectionTab();
}

function renderPackSessionPanel() {
  const session = getActiveSession();
  const inactiveEl = document.getElementById('packSessionInactive');
  const activeEl = document.getElementById('packSessionActive');
  if (!session) {
    inactiveEl.classList.remove('hidden');
    activeEl.classList.add('hidden');
    return;
  }
  inactiveEl.classList.add('hidden');
  activeEl.classList.remove('hidden');
  const cardsInSession = collectionData.cards.filter(c => c.packSessionId === session.sessionId);
  const cardCount = cardsInSession.reduce((sum, c) => sum + c.quantity, 0);
  document.getElementById('activePackLabel').textContent = `${session.setName} — ${session.boosterLabel}`;
  document.getElementById('activePackCardCount').textContent = cardCount;
  document.getElementById('activePackTotal').textContent = 'calculating…';
  priceForCollectionCards(cardsInSession).then(({ total }) => {
    const stillActive = getActiveSession();
    if (stillActive && stillActive.sessionId === session.sessionId) {
      document.getElementById('activePackTotal').textContent = fmtMoney(total);
    }
  });
}

// Finished-pack averages by (setCode, boosterKind) — surfaced in the Compare
// tab next to the theoretical EV for whichever sets/kinds have logged data.
function getLoggedPackAverages(setCode) {
  const finished = collectionData.packSessions.filter(s =>
    s.setCode === setCode && s.finishedAt !== null && s.totalValue !== null);
  const byKind = {};
  finished.forEach(s => {
    if (!byKind[s.boosterKind]) byKind[s.boosterKind] = [];
    byKind[s.boosterKind].push(s.totalValue);
  });
  const result = {};
  Object.keys(byKind).forEach(k => {
    const vals = byKind[k];
    result[k] = { avg: vals.reduce((a, b) => a + b, 0) / vals.length, count: vals.length };
  });
  return result;
}

// ---- collection view rendering ----
async function renderCollectionTab() {
  const statsEl = document.getElementById('collectionStats');
  const tableEl = document.getElementById('collectionTableWrap');

  const totalCards = collectionData.cards.reduce((sum, c) => sum + c.quantity, 0);
  statsEl.innerHTML = `
    <div class="stat-tile"><div class="stat-label">Total cards</div><div class="stat-value">${totalCards}</div></div>
    <div class="stat-tile"><div class="stat-label">Unique entries</div><div class="stat-value">${collectionData.cards.length}</div></div>
    <div class="stat-tile"><div class="stat-label">Collection value</div><div class="stat-value" id="collectionTotalValue">${collectionData.cards.length ? 'calculating…' : fmtMoney(0)}</div></div>
  `;

  renderPackSessionsList();

  if (collectionData.cards.length === 0) {
    tableEl.innerHTML = '<p class="hint">No cards yet — search and add one, or scan a photo.</p>';
    return;
  }
  tableEl.innerHTML = '<p class="hint">Calculating current prices…</p>';

  const { total, priced } = await priceForCollectionCards(collectionData.cards);
  const totalValueEl = document.getElementById('collectionTotalValue');
  if (totalValueEl) totalValueEl.textContent = fmtMoney(total);

  tableEl.innerHTML = `
    <table>
      <thead>
        <tr><th>Name</th><th>Set</th><th>Finish</th><th>Qty</th><th class="price-cell">Unit</th><th class="price-cell">Total</th><th></th></tr>
      </thead>
      <tbody>
        ${priced.map(c => `
          <tr>
            <td>${escapeHtml(c.name)}</td>
            <td>${setIconHtml(getSetMeta(c.setCode) && getSetMeta(c.setCode).icon_svg_uri, c.setName)}${c.setCode.toUpperCase()}</td>
            <td><span class="finish-badge ${c.finish}">${c.finish}</span></td>
            <td>
              <div class="qty-controls">
                <button class="qty-btn" data-entry="${c.entryId}" data-delta="-1">-</button>
                ${c.quantity}
                <button class="qty-btn" data-entry="${c.entryId}" data-delta="1">+</button>
              </div>
            </td>
            <td class="price-cell">${fmtMoney(c.unitPrice)}</td>
            <td class="price-cell">${fmtMoney(c.lineTotal)}</td>
            <td><button class="remove-btn" data-entry="${c.entryId}">Remove</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  tableEl.querySelectorAll('.qty-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const entry = collectionData.cards.find(c => c.entryId === btn.dataset.entry);
      if (entry) setCollectionEntryQuantity(entry.entryId, entry.quantity + Number(btn.dataset.delta));
    });
  });
  tableEl.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', () => removeCollectionEntry(btn.dataset.entry));
  });
}

function renderPackSessionsList() {
  const sessionsEl = document.getElementById('packSessionsWrap');
  const finished = collectionData.packSessions
    .filter(s => s.finishedAt !== null)
    .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
  if (finished.length === 0) {
    sessionsEl.innerHTML = '<p class="hint">No finished packs logged yet.</p>';
    return;
  }
  sessionsEl.innerHTML = finished.map(s => `
    <div class="pack-session-row">
      <span>${setIconHtml(getSetMeta(s.setCode) && getSetMeta(s.setCode).icon_svg_uri, s.setName)}${escapeHtml(s.setName)} &mdash; ${escapeHtml(s.boosterLabel)}</span>
      <span class="price-cell">${fmtMoney(s.totalValue)}</span>
    </div>
  `).join('');
}

// ---- export / import ----
function exportCollection() {
  const blob = new Blob([JSON.stringify(collectionData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mtg-collection-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function importCollectionFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!Array.isArray(parsed.cards) || !Array.isArray(parsed.packSessions)) {
        throw new Error("That file doesn't look like a collection backup.");
      }
      const count = parsed.cards.length;
      if (!confirm(`Import this backup? It has ${count} card entr${count === 1 ? 'y' : 'ies'} and will REPLACE your current collection in this browser.`)) return;
      collectionData = { cards: parsed.cards, packSessions: parsed.packSessions };
      saveCollectionData();
      renderPackSessionPanel();
      renderCollectionTab();
      alert('Collection restored.');
    } catch (e) {
      alert('Could not import that file: ' + e.message);
    }
  };
  reader.readAsText(file);
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

  const TAB_PANELS = ['browseView', 'compareView', 'collectionView'];
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
      TAB_PANELS.forEach(id => document.getElementById(id).classList.toggle('hidden', id !== btn.dataset.tab));
    });
  });

  document.getElementById('compareBtn').addEventListener('click', runCompare);
  document.getElementById('compareSetFilterBox').addEventListener('input', e =>
    renderSetCheckboxList('compareSetList', e.target.value, 'compare-set-checkbox', 'cmp'));

  wireSetListDragSelect('setList');
  wireSetListDragSelect('compareSetList');
  wireSelectAllClear('setListSelectAll', 'setListClear', 'setList', 'set-checkbox');
  wireSelectAllClear('compareSetListSelectAll', 'compareSetListClear', 'compareSetList', 'compare-set-checkbox');

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

  // ---- my collection wiring ----
  document.getElementById('collectionSearchBtn').addEventListener('click', () =>
    runCollectionSearch(document.getElementById('collectionSearchBox').value));
  document.getElementById('collectionSearchBox').addEventListener('keydown', e => {
    if (e.key === 'Enter') runCollectionSearch(e.target.value);
  });
  document.getElementById('scanCameraInput').addEventListener('change', e => {
    handleScanFile(e.target.files[0]);
    e.target.value = '';
  });
  document.getElementById('scanUploadInput').addEventListener('change', e => {
    handleScanFile(e.target.files[0]);
    e.target.value = '';
  });

  document.getElementById('packSetFilterBox').addEventListener('input', e => renderPackSetList(e.target.value));
  document.getElementById('startPackBtn').addEventListener('click', startPackSession);
  document.getElementById('finishPackBtn').addEventListener('click', finishActiveSession);
  document.getElementById('cancelPackBtn').addEventListener('click', cancelActiveSession);

  document.getElementById('exportCollectionBtn').addEventListener('click', exportCollection);
  document.getElementById('importCollectionInput').addEventListener('change', e => {
    importCollectionFile(e.target.files[0]);
    e.target.value = '';
  });

  renderPackSessionPanel();
  renderCollectionTab();
});
