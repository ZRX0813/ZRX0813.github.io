/** Italy: approximate view */
const ITALY_CENTER = [42.5, 12.5];
const ITALY_ZOOM = 6;

const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
});

const map = L.map("map", {
  center: ITALY_CENTER,
  zoom: ITALY_ZOOM,
  layers: [osm],
  zoomControl: true,
});

L.control.scale({ imperial: false, metric: true }).addTo(map);

const overlayRoot = L.layerGroup().addTo(map);

const palette = ["#3d8bfd", "#6ee7c5", "#c084fc", "#fbbf24", "#f472b6", "#34d399"];

function styleForIndex(i) {
  const c = palette[i % palette.length];
  return {
    color: c,
    weight: 2,
    opacity: 0.95,
    fillColor: c,
    fillOpacity: 0.18,
  };
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

/** @type {Map<string, { layer: L.GeoJSON | null, spec: { id: string, label: string, geojson: string }, style: object }>} */
const registry = new Map();

async function ensureLayerLoaded(id) {
  const rec = registry.get(id);
  if (!rec || rec.layer) return rec?.layer ?? null;
  const url = new URL(rec.spec.geojson, window.location.href).href;
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const gj = L.geoJSON(data, {
    style: rec.style,
    onEachFeature(feature, lyr) {
      const props =
        feature.properties && Object.keys(feature.properties).length
          ? `<pre class="popup-props">${escapeHtml(JSON.stringify(feature.properties, null, 2))}</pre>`
          : "";
      lyr.bindPopup(`<strong>${escapeHtml(rec.spec.label)}</strong>${props}`);
      lyr.on("mouseover", () => lyr.setStyle({ ...rec.style, weight: rec.style.weight + 1, fillOpacity: Math.min(0.45, rec.style.fillOpacity + 0.2) }));
      lyr.on("mouseout", () => lyr.setStyle(rec.style));
    },
  });
  gj.eachLayer((lyr) => {
    if (!lyr.feature && lyr.getLatLng) {
      lyr.bindPopup(`<strong>${escapeHtml(rec.spec.label)}</strong>`);
    }
  });
  rec.layer = gj;
  return gj;
}

function setOverlayVisible(id, on) {
  const rec = registry.get(id);
  if (!rec) return;
  const row = document.querySelector(`[data-layer-id="${CSS.escape(id)}"]`);
  if (!on) {
    if (rec.layer) overlayRoot.removeLayer(rec.layer);
    if (row) row.querySelector(".err")?.remove();
    return;
  }
  ensureLayerLoaded(id)
    .then((gj) => {
      if (!gj) return;
      if (!overlayRoot.hasLayer(gj)) gj.addTo(overlayRoot);
    })
    .catch((e) => {
      const msg = e?.message || String(e);
      if (row) {
        let err = row.querySelector(".err");
        if (!err) {
          err = document.createElement("div");
          err.className = "err";
          row.appendChild(err);
        }
        err.textContent = msg;
      }
      const cb = row?.querySelector('input[type="checkbox"]');
      if (cb) cb.checked = false;
    });
}

function renderToggles(layers) {
  registry.clear();
  overlayRoot.clearLayers();
  const host = document.getElementById("overlay-toggles");
  const panel = document.getElementById("layer-panel");
  host.innerHTML = "";
  if (!layers.length) {
    panel.classList.add("hidden");
    document.body.classList.remove("map-offset");
    return;
  }
  panel.classList.remove("hidden");
  document.body.classList.add("map-offset");

  layers.forEach((spec, idx) => {
    registry.set(spec.id, { layer: null, spec, style: styleForIndex(idx) });

    const row = document.createElement("div");
    row.className = "toggle-row";
    row.dataset.layerId = spec.id;

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = `layer-${spec.id}`;
    cb.addEventListener("change", () => setOverlayVisible(spec.id, cb.checked));

    const lab = document.createElement("label");
    lab.htmlFor = cb.id;
    lab.textContent = spec.label || spec.id;

    row.append(cb, lab);
    host.appendChild(row);
  });
}

async function loadLayerManifest() {
  let list = [];
  try {
    const url = new URL("data/layers.json", window.location.href).href;
    const res = await fetch(url, { credentials: "same-origin" });
    if (res.ok) {
      const data = await res.json();
      const raw = Array.isArray(data.layers) ? data.layers : [];
      list = raw.filter((x) => x && x.id && x.geojson);
    }
  } catch {
    /* optional manifest */
  }
  renderToggles(list);
}

/** Nominatim — 轻量使用；若遇网络限制可改用其他地理编码服务 */
async function searchPlaces(query) {
  const q = query.trim();
  if (!q) return [];
  const u = new URL("https://nominatim.openstreetmap.org/search");
  u.searchParams.set("format", "jsonv2");
  u.searchParams.set("q", q);
  u.searchParams.set("limit", "10");
  const res = await fetch(u.toString(), {
    headers: { "Accept-Language": "zh-CN,en;q=0.9" },
  });
  if (!res.ok) throw new Error(`检索失败 (${res.status})`);
  return res.json();
}

function goToNominatimResult(item) {
  const lat = parseFloat(item.lat);
  const lon = parseFloat(item.lon);
  if (Number.isNaN(lat) || Number.isNaN(lon)) return;

  const bb = item.boundingbox;
  if (bb && bb.length === 4) {
    const south = parseFloat(bb[0]);
    const north = parseFloat(bb[1]);
    const west = parseFloat(bb[2]);
    const east = parseFloat(bb[3]);
    if (![south, north, west, east].some(Number.isNaN)) {
      const b = L.latLngBounds([south, west], [north, east]);
      map.fitBounds(b, { padding: [36, 36], maxZoom: 14, animate: true });
      return;
    }
  }
  map.flyTo([lat, lon], Math.max(map.getZoom(), 12), { duration: 0.6 });
}

function updateToolbarHeight() {
  const bar = document.querySelector(".toolbar");
  if (!bar) return;
  const h = Math.ceil(bar.getBoundingClientRect().height);
  document.documentElement.style.setProperty("--toolbar-h", `${h}px`);
}

updateToolbarHeight();
window.addEventListener("resize", updateToolbarHeight);
if (typeof ResizeObserver !== "undefined") {
  const bar = document.querySelector(".toolbar");
  if (bar) new ResizeObserver(updateToolbarHeight).observe(bar);
}

const searchInput = document.getElementById("search-input");
const searchBtn = document.getElementById("search-btn");
const searchResults = document.getElementById("search-results");

function hideResults() {
  searchResults.classList.add("hidden");
  searchResults.innerHTML = "";
}

function showResults(items) {
  searchResults.innerHTML = "";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "search-item";
    empty.textContent = "未找到结果";
    searchResults.appendChild(empty);
  } else {
    for (const item of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "search-item";
      btn.setAttribute("role", "option");
      const title = item.display_name || item.name || "";
      btn.innerHTML = `${escapeHtml(title)}${item.type ? `<small>${escapeHtml(item.type)}</small>` : ""}`;
      btn.addEventListener("click", () => {
        goToNominatimResult(item);
        hideResults();
        searchInput.blur();
      });
      searchResults.appendChild(btn);
    }
  }
  searchResults.classList.remove("hidden");
}

async function runSearch() {
  const q = searchInput.value.trim();
  if (!q) return;
  searchBtn.disabled = true;
  try {
    const rows = await searchPlaces(q);
    showResults(rows);
  } catch (e) {
    const msg = e?.message || String(e);
    searchResults.innerHTML = "";
    const div = document.createElement("div");
    div.className = "search-item";
    div.textContent = msg;
    searchResults.appendChild(div);
    searchResults.classList.remove("hidden");
  } finally {
    searchBtn.disabled = false;
  }
}

searchBtn.addEventListener("click", runSearch);
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runSearch();
});
document.addEventListener("click", (e) => {
  if (!document.getElementById("search")?.contains(e.target)) hideResults();
});

loadLayerManifest();
