/* ===========================================================
   Fungarium — config
   Point MANUAL_DATA_URL at a Google Sheet published as CSV to
   update notes live without committing a file. See README.md.
=========================================================== */
const CONFIG = {
  INAT_DATA_URL: "data/inat_data.json",
  MANUAL_DATA_URL: "https://docs.google.com/spreadsheets/d/e/2PACX-1vRkAO8yDUWx4zAi5VSRcks6eIF5Ue0nArbeFASacMzrlH9MouYuctWKCyYboIWjhbXAfyXoyomE1U3U/pub?gid=0&single=true&output=csv",
};

// Manual fields, in the order they'll render in the detail panel.
// csvHeader must match the Google Sheet / CSV column header exactly
// (case-insensitive, whitespace-insensitive).
// Fields flagged `grid: true` render as short facts in the detail panel's
// data grid (alongside DNA barcode / range); everything else renders as a
// full note in the prose "notes" section below it.
const MANUAL_FIELDS = [
  { csvHeader: "Edibility", key: "edibility", label: "Edibility", grid: true },
  { csvHeader: "Spore Colour", key: "sporeColour", label: "Spore colour", grid: true },
  { csvHeader: "Informal Group Names", key: "informalNames", label: "Informal group names", grid: true },
  { csvHeader: "Identification Tips", key: "idTips", label: "Identification tips" },
  { csvHeader: "Look-Alikes", key: "lookAlikes", label: "Look-alikes" },
  { csvHeader: "Ecology", key: "ecology", label: "Ecology" },
  { csvHeader: "Fun Facts", key: "funFacts", label: "Fun facts" },
  { csvHeader: "Etymology", key: "etymology", label: "Etymology" },
  { csvHeader: "Other Notes", key: "otherNotes", label: "Other notes" },
];

const MERGE_KEY_HEADER = "Scientific Name";

const TAXONOMY_ORDER = ["kingdom", "phylum", "class", "order", "family", "genus", "species"];

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------
let allSpecies = [];
let filtered = [];
let sortKey = "family";
let sortDir = 1;
let openKey = null; // scientific name of currently expanded row
let lookalikeRegex = null; // matches known species names inside free text
let lookalikeLookup = new Map(); // lowercase matched text -> species object
const INCERTAE_SEDIS = "Incertae sedis";

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
function normalizeKey(str) {
  return (str || "").trim().toLowerCase();
}

function esc(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

function edibilityCategory(text) {
  const t = normalizeKey(text);
  if (!t) return "none";
  if (/deadly|poisonous|toxic/.test(t)) return "toxic";
  if (/inedible|not edible|unknown|unpalatable/.test(t)) return "unknown";
  if (/edible/.test(t)) return "edible";
  return "unknown";
}

/**
 * Splits a semicolon-separated "Informal Group Names" cell like
 * "Crust; merulioid" into ["Crust", "merulioid"], so each term can be
 * filtered on independently.
 */
function splitInformalNames(text) {
  if (!text) return [];
  return text
    .split(";")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Rough colour swatch for a free-text spore colour description, for the
 * small dot shown next to it. Purely decorative — first matching keyword
 * wins, order chosen to prefer the more distinctive term in mixed
 * descriptions like "white to pale lilac".
 */
function sporeColourSwatch(text) {
  const t = normalizeKey(text);
  if (!t) return null;
  const map = [
    [/chocolate|dark brown|blackish brown/, "#4A2E1D"],
    [/black/, "#1A1712"],
    [/white/, "#ECE4D3"],
    [/rust|rusty|ochre|cinnamon/, "#B5652F"],
    [/brown|tan/, "#7A5230"],
    [/cream|buff/, "#E4D9A8"],
    [/yellow/, "#D8C24A"],
    [/pink|salmon/, "#D98FA0"],
    [/lilac|purple|violet/, "#9B7EBD"],
    [/olive|green/, "#7C8A4A"],
    [/gr[ae]y/, "#9B9284"],
  ];
  for (const [re, color] of map) {
    if (re.test(t)) return color;
  }
  return "#B6AA95";
}

/**
 * A scientific name normalized for alphabetizing. Ordinary binomials sort
 * as-is (genus, then specific epithet, so "Amanita brunnescens" naturally
 * comes before "Amanita virosa"). Provisional names like
 * "Amanita sp. 'multisquamosa'" would otherwise all cluster together under
 * "sp." — this rewrites them to "Amanita multisquamosa" so they interleave
 * alphabetically with properly-named species in the same genus instead.
 */
function sortableScientificName(name) {
  if (!name) return "";
  const match = name.match(/^(.+?)\s+sp\.?\s*['"‘’“”]([^'"‘’“”]+)['"‘’“”]\s*$/i);
  const normalized = match ? `${match[1]} ${match[2]}` : name;
  return normalized.trim().toLowerCase();
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds a regex + lookup so free-text fields (currently just Look-Alikes)
 * can auto-link mentions of other species you've logged — matching either
 * the full scientific name ("Hydnoporia olivacea") or, where unambiguous,
 * the abbreviated form ("H. olivacea"). Provisional "sp. 'x'" names are
 * skipped, since they're too free-form to match reliably in prose.
 */
function buildLookalikeIndex(speciesList) {
  const lookup = new Map();
  const patterns = [];
  const abbrevCounts = new Map();
  const abbrevCandidates = [];

  speciesList.forEach((sp) => {
    const name = (sp.scientific_name || "").trim();
    if (!name || /\bsp\.?\s*['"‘’“”]/i.test(name)) return;
    const parts = name.split(/\s+/);
    if (parts.length < 2) return;

    const fullKey = name.toLowerCase();
    if (!lookup.has(fullKey)) {
      lookup.set(fullKey, sp);
      patterns.push(name);
    }

    const abbrev = `${parts[0][0]}. ${parts.slice(1).join(" ")}`;
    const abbrevKey = abbrev.toLowerCase();
    abbrevCounts.set(abbrevKey, (abbrevCounts.get(abbrevKey) || 0) + 1);
    abbrevCandidates.push({ abbrevKey, abbrev, sp });
  });

  abbrevCandidates.forEach(({ abbrevKey, abbrev, sp }) => {
    if (abbrevCounts.get(abbrevKey) === 1 && !lookup.has(abbrevKey)) {
      lookup.set(abbrevKey, sp);
      patterns.push(abbrev);
    }
  });

  if (!patterns.length) return { regex: null, lookup };

  // Longest patterns first so full names win over any overlapping abbreviation.
  patterns.sort((a, b) => b.length - a.length);
  const alternation = patterns.map(escapeRegex).join("|");
  const regex = new RegExp(`\\b(?:${alternation})\\b`, "gi");
  return { regex, lookup };
}

/**
 * Escapes text for HTML, then wraps any recognized species mention in a
 * clickable span that jumps to that species' row.
 */
function linkifyLookAlikes(text) {
  const escaped = esc(text);
  if (!text || !lookalikeRegex) return escaped;
  lookalikeRegex.lastIndex = 0;
  return escaped.replace(lookalikeRegex, (match) => {
    const target = lookalikeLookup.get(match.toLowerCase());
    if (!target) return match;
    return `<button type="button" class="lookalike-link" data-jump-key="${esc(target.scientific_name)}">${match}</button>`;
  });
}

/** Clears search/filters (so the target isn't hidden), opens it, and scrolls to it. */
function jumpToSpecies(key) {
  if (!key) return;
  document.getElementById("search").value = "";
  FILTER_IDS.forEach((id) => (document.getElementById(id).value = ""));
  openKey = key;
  applyFiltersAndSearch();
  requestAnimationFrame(() => {
    document.querySelector(`[data-detail-key="${cssEscape(key)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}

// ---------------------------------------------------------------
// Loading + merging
// ---------------------------------------------------------------
async function loadData() {
  const loadingEl = document.getElementById("loadingState");
  const errorEl = document.getElementById("errorState");

  let inatData, manualRows;

  try {
    const inatRes = await fetch(CONFIG.INAT_DATA_URL);
    if (!inatRes.ok) throw new Error(`Could not load ${CONFIG.INAT_DATA_URL} (HTTP ${inatRes.status})`);
    inatData = await inatRes.json();
  } catch (err) {
    loadingEl.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = `Couldn't load species data: ${err.message}. Check that data/inat_data.json exists (see README).`;
    return;
  }

  try {
    const csvRes = await fetch(CONFIG.MANUAL_DATA_URL);
    if (!csvRes.ok) throw new Error(`HTTP ${csvRes.status}`);
    const csvText = await csvRes.text();
    const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
    manualRows = parsed.data;
  } catch (err) {
    // Manual notes are optional — proceed with iNat data only, but say so.
    console.warn(`Couldn't load manual notes CSV: ${err.message}`);
    manualRows = [];
  }

  const manualByKey = {};
  manualRows.forEach((row) => {
    const rawKey = row[MERGE_KEY_HEADER] ?? row[MERGE_KEY_HEADER.toLowerCase()];
    if (!rawKey) return;
    manualByKey[normalizeKey(rawKey)] = row;
  });

  function getCsvValue(row, header) {
    if (!row) return "";
    if (row[header] != null) return String(row[header]).trim();
    // case-insensitive fallback
    const foundKey = Object.keys(row).find((k) => normalizeKey(k) === normalizeKey(header));
    return foundKey ? String(row[foundKey] || "").trim() : "";
  }

  allSpecies = Object.entries(inatData).map(([scientificName, data]) => {
    const manualRow = manualByKey[normalizeKey(scientificName)];
    const manual = {};
    MANUAL_FIELDS.forEach((f) => {
      manual[f.key] = getCsvValue(manualRow, f.csvHeader);
    });

    const family = data.taxonomy?.family?.name || INCERTAE_SEDIS;

    const searchParts = [
      scientificName,
      data.common_name,
      ...TAXONOMY_ORDER.map((r) => data.taxonomy?.[r]?.name),
      ...TAXONOMY_ORDER.map((r) => data.taxonomy?.[r]?.common_name),
      ...(data.range?.countries || []).map((c) => c.name),
      ...(data.range?.states_provinces || []).map((s2) => s2.name),
      ...Object.values(data.observation_fields || {}),
      ...Object.values(manual),
    ];

    return {
      scientific_name: scientificName,
      sortName: sortableScientificName(scientificName),
      common_name: data.common_name || "",
      taxon_id: data.taxon_id || null,
      taxonomy: data.taxonomy || {},
      family,
      observation_fields: data.observation_fields || {},
      range: data.range || { countries: [], states_provinces: [] },
      your_observations: data.your_observations || [],
      manual,
      edibility: manual.edibility,
      sporeColour: manual.sporeColour,
      informalNames: manual.informalNames,
      informalNamesList: splitInformalNames(manual.informalNames),
      dnaConfirmed: data.observation_fields?.["DNA Barcode ITS"] === "Yes" ? "yes" : "no",
      _search: searchParts.filter(Boolean).join(" ").toLowerCase(),
    };
  });

  loadingEl.hidden = true;
  buildFilterOptions();
  renderStats();
  const idx = buildLookalikeIndex(allSpecies);
  lookalikeRegex = idx.regex;
  lookalikeLookup = idx.lookup;
  applyFiltersAndSearch();
}

// ---------------------------------------------------------------
// Filters
// ---------------------------------------------------------------
function fillSelect(selectEl, values) {
  values.forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    selectEl.appendChild(opt);
  });
}

function buildFilterOptions() {
  fillSelect(document.getElementById("filterOrder"), [...new Set(allSpecies.map((s) => s.taxonomy?.order?.name).filter(Boolean))].sort());
  fillSelect(document.getElementById("filterFamily"), [...new Set(allSpecies.map((s) => s.family).filter(Boolean))].sort());
  fillSelect(document.getElementById("filterGenus"), [...new Set(allSpecies.map((s) => s.taxonomy?.genus?.name).filter(Boolean))].sort());
  fillSelect(document.getElementById("filterInformal"), [...new Set(allSpecies.flatMap((s) => s.informalNamesList))].sort());
  fillSelect(document.getElementById("filterSporeColour"), [...new Set(allSpecies.map((s) => s.sporeColour).filter(Boolean))].sort());
}

function renderStats() {
  const statsEl = document.getElementById("stats");
  const total = allSpecies.length;
  const families = new Set(allSpecies.map((s) => s.family).filter(Boolean)).size;
  const orders = new Set(allSpecies.map((s) => s.taxonomy?.order?.name).filter(Boolean)).size;
  const genera = new Set(allSpecies.map((s) => s.taxonomy?.genus?.name).filter(Boolean)).size;

  statsEl.innerHTML = `
    <div><dt>Total species found</dt><dd>${total}</dd></div>
    <div><dt>Orders</dt><dd>${orders}</dd></div>
    <div><dt>Families</dt><dd>${families}</dd></div>
    <div><dt>Genera</dt><dd>${genera}</dd></div>
  `;
}

/**
 * Sort comparator: sorts by the clicked column, but always falls back to
 * (alphabetization-aware) scientific name as a tiebreaker — so "sort by
 * family" reads as "family, then species name" rather than leaving
 * same-family rows in whatever order they happened to load in.
 */
function sortValue(s, key) {
  if (key === "scientific_name") return s.sortName;
  return (s[key] || "").toString().toLowerCase();
}

function compareSpecies(a, b, key, dir) {
  if (key === "family") {
    const aInc = a.family === INCERTAE_SEDIS;
    const bInc = b.family === INCERTAE_SEDIS;
    // Incertae sedis always sorts to the very bottom, regardless of
    // ascending/descending — it isn't a real alphabetical family.
    if (aInc !== bInc) return aInc ? 1 : -1;
  }
  const av = sortValue(a, key);
  const bv = sortValue(b, key);
  if (av < bv) return -dir;
  if (av > bv) return dir;
  if (a.sortName < b.sortName) return -1;
  if (a.sortName > b.sortName) return 1;
  return 0;
}

function applyFiltersAndSearch() {
  const query = document.getElementById("search").value.trim().toLowerCase();
  const terms = query.split(/\s+/).filter(Boolean);
  const familyFilter = document.getElementById("filterFamily").value;
  const orderFilter = document.getElementById("filterOrder").value;
  const genusFilter = document.getElementById("filterGenus").value;
  const informalFilter = document.getElementById("filterInformal").value;
  const sporeColourFilter = document.getElementById("filterSporeColour").value;
  const dnaFilter = document.getElementById("filterDNA").value;

  filtered = allSpecies.filter((s) => {
    if (terms.length && !terms.every((t) => s._search.includes(t))) return false;
    if (familyFilter && s.family !== familyFilter) return false;
    if (orderFilter && s.taxonomy?.order?.name !== orderFilter) return false;
    if (genusFilter && s.taxonomy?.genus?.name !== genusFilter) return false;
    if (informalFilter && !s.informalNamesList.includes(informalFilter)) return false;
    if (sporeColourFilter && s.sporeColour !== sporeColourFilter) return false;
    if (dnaFilter && s.dnaConfirmed !== dnaFilter) return false;
    return true;
  });

  filtered.sort((a, b) => compareSpecies(a, b, sortKey, sortDir));

  renderRows();
}

// ---------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------
function renderRows() {
  const rowsEl = document.getElementById("rows");
  const emptyEl = document.getElementById("emptyState");
  const countEl = document.getElementById("resultCount");

  countEl.textContent = `${filtered.length} of ${allSpecies.length} species`;

  if (filtered.length === 0) {
    rowsEl.innerHTML = "";
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  rowsEl.innerHTML = filtered.map((s) => renderEntry(s)).join("");

  rowsEl.querySelectorAll(".row-summary").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.key;
      openKey = openKey === key ? null : key;
      renderRows();
      if (openKey) {
        document.querySelector(`[data-detail-key="${cssEscape(key)}"]`)?.scrollIntoView({ block: "nearest" });
      }
    });
  });
}

function cssEscape(str) {
  return str.replace(/["\\]/g, "\\$&");
}

function renderEntry(s) {
  const isOpen = openKey === s.scientific_name;
  const swatch = sporeColourSwatch(s.sporeColour);
  const sporeCell = s.sporeColour
    ? `<span class="spore-cell">${swatch ? `<span class="spore-dot" style="background:${swatch}"></span>` : ""}${esc(s.sporeColour)}</span>`
    : "&mdash;";

  return `
    <div class="entry">
      <button class="row-summary" data-key="${esc(s.scientific_name)}" aria-expanded="${isOpen}">
        <div class="row">
          <span class="cell cell-common" data-label="Common name">${esc(s.common_name) || "&mdash;"}</span>
          <span class="cell cell-sci" data-label="Scientific name">${esc(s.scientific_name)}</span>
          <span class="cell cell-family" data-label="Family">${esc(s.family) || "&mdash;"}</span>
          <span class="cell" data-label="Spore colour">${sporeCell}</span>
        </div>
      </button>
      ${isOpen ? renderDetail(s) : ""}
    </div>
  `;
}

function renderLocationList(entries) {
  if (!entries || !entries.length) return "&mdash;";
  return entries
    .map((e) => {
      let cls = null;
      if (e.dna && e.microscopy) cls = "location-both";
      else if (e.dna) cls = "location-dna";
      else if (e.microscopy) cls = "location-microscopy";
      return cls ? `<span class="${cls}">${esc(e.name)}</span>` : esc(e.name);
    })
    .join(", ");
}

function renderDetail(s) {
  const breadcrumb = TAXONOMY_ORDER
    .map((rank) => {
      const t = s.taxonomy[rank];
      if (!t || !t.name) return null;
      const common = t.common_name ? ` <span class="common">(${esc(t.common_name)})</span>` : "";
      return `${esc(t.name)}${common}`;
    })
    .filter(Boolean)
    .join('<span class="rank-sep">&rsaquo;</span>');

  const dnaBarcode = s.observation_fields["DNA Barcode ITS"] || "No";
  const microscopy = s.observation_fields["Microscopy Performed"] || "No";
  const dnaClass = dnaBarcode === "Yes" ? "dna-yes" : "";
  const microscopyClass = microscopy === "Yes" ? "microscopy-yes" : "";
  const countriesHtml = renderLocationList(s.range.countries);
  const statesHtml = renderLocationList(s.range.states_provinces);

  const mapLinksHtml = s.taxon_id
    ? `<div class="map-links">
         <a class="map-link" target="_blank" rel="noopener"
            href="https://www.inaturalist.org/observations?subview=map&taxon_id=${s.taxon_id}&verifiable=any&field:DNA%20Barcode%20ITS=">
           View range map — DNA confirmed
         </a>
         <a class="map-link" target="_blank" rel="noopener"
            href="https://www.inaturalist.org/observations?subview=map&taxon_id=${s.taxon_id}&verifiable=any">
           View range map — all observations
         </a>
       </div>`
    : "";

  const gridFields = MANUAL_FIELDS.filter((f) => f.grid);
  const gridFieldsHtml = gridFields
    .map((f) => `<div class="data-item"><dt>${esc(f.label)}</dt><dd>${esc(s.manual[f.key]) || "&mdash;"}</dd></div>`)
    .join("");

  const noteFields = MANUAL_FIELDS.filter((f) => !f.grid && s.manual[f.key]);
  const notesHtml = noteFields.length
    ? `<div class="notes">${noteFields
        .map((f) => {
          const value = f.key === "lookAlikes" ? linkifyLookAlikes(s.manual[f.key]) : esc(s.manual[f.key]);
          return `<div class="note-item"><h3>${esc(f.label)}</h3><p>${value}</p></div>`;
        })
        .join("")}</div>`
    : `<p class="notes-empty">No field notes yet for this species — add a row for it in your sheet.</p>`;

  const obsHtml = s.your_observations.length
    ? `<div class="obs-list">
         <h3>Your observations (${s.your_observations.length})</h3>
         <ul>${s.your_observations
           .map((o) => {
             const label = `${esc(o.observed_on || "undated")}${o.place_guess ? ` — ${esc(o.place_guess)}` : ""}`;
             return o.url
               ? `<li><a class="obs-link" href="${esc(o.url)}" target="_blank" rel="noopener">${label}</a></li>`
               : `<li>${label}</li>`;
           })
           .join("")}</ul>
       </div>`
    : "";

  return `
    <div class="detail" data-detail-key="${esc(s.scientific_name)}">
      <div class="breadcrumb">${breadcrumb || "No taxonomy on file"}</div>
      ${mapLinksHtml}
      <dl class="data-grid">
        ${gridFieldsHtml}
        <div class="data-item"><dt>DNA Barcode ITS</dt><dd class="mono ${dnaClass}">${esc(dnaBarcode)}</dd></div>
        <div class="data-item"><dt>Microscopy performed</dt><dd class="mono ${microscopyClass}">${esc(microscopy)}</dd></div>
        <div class="data-item"><dt>Countries observed</dt><dd>${countriesHtml}</dd></div>
        <div class="data-item"><dt>States / provinces observed</dt><dd>${statesHtml}</dd></div>
      </dl>
      ${notesHtml}
      ${obsHtml}
    </div>
  `;
}

// ---------------------------------------------------------------
// Wire up controls
// ---------------------------------------------------------------
const FILTER_IDS = ["filterOrder", "filterFamily", "filterGenus", "filterInformal", "filterSporeColour", "filterDNA"];

function setSortIndicator(key, dir) {
  document.querySelectorAll(".sort-btn").forEach((b) => {
    const isActive = b.dataset.sort === key;
    b.classList.toggle("active", isActive);
    b.querySelector(".arrow")?.remove();
    if (isActive) {
      const arrow = document.createElement("span");
      arrow.className = "arrow";
      arrow.textContent = dir === 1 ? "↑" : "↓";
      b.appendChild(arrow);
    }
  });
}

function setupControls() {
  document.getElementById("search").addEventListener("input", applyFiltersAndSearch);
  FILTER_IDS.forEach((id) => document.getElementById(id).addEventListener("change", applyFiltersAndSearch));

  document.getElementById("clearFilters").addEventListener("click", () => {
    document.getElementById("search").value = "";
    FILTER_IDS.forEach((id) => (document.getElementById(id).value = ""));
    applyFiltersAndSearch();
  });

  document.querySelectorAll(".sort-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.sort;
      if (sortKey === key) {
        sortDir *= -1;
      } else {
        sortKey = key;
        sortDir = 1;
      }
      setSortIndicator(sortKey, sortDir);
      applyFiltersAndSearch();
    });
  });

  document.getElementById("rows").addEventListener("click", (e) => {
    const link = e.target.closest(".lookalike-link");
    if (link) {
      e.preventDefault();
      jumpToSpecies(link.dataset.jumpKey);
    }
  });

  setSortIndicator(sortKey, sortDir);
}

setupControls();
loadData();

// Offline support: registering this is harmless if sw.js is absent (it'll
// just 404 silently) but enables offline use once it's in place.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => {
      console.warn("Service worker registration failed:", err);
    });
  });
}
