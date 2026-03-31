/** Initial view: Italy (approx.) */
const ITALY_CENTER = [42.5, 12.5];
const ITALY_ZOOM = 6;

const TILE_DEBOUNCE_MS = 280;
const MAX_TILES_IN_VIEW = 36;
const TILE_FETCH_CONCURRENCY = 5;

const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
});

const map = L.map("map", {
  center: ITALY_CENTER,
  zoom: ITALY_ZOOM,
  layers: [osm],
  zoomControl: false,
  preferCanvas: true,
});

L.control.scale({ imperial: false, metric: true, position: "bottomright" }).addTo(map);

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

function stylesForSpec(spec, idx) {
  if (spec.pointRadius != null || spec.id.includes("piff")) {
    return {
      pathStyle: styleForIndex(idx),
      pointStyle: {
        radius: spec.pointRadius ?? 4,
        color: "#9a3412",
        weight: 1,
        fillColor: "#fb923c",
        fillOpacity: 0.82,
        opacity: 0.95,
      },
    };
  }
  if (spec.id.includes("iffi_poly")) {
    return {
      pathStyle: {
        color: "#b45309",
        weight: 1.2,
        opacity: 0.92,
        fillColor: "#fbbf24",
        fillOpacity: 0.22,
      },
      pointStyle: null,
    };
  }
  return { pathStyle: styleForIndex(idx), pointStyle: null };
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

/**
 * @typedef {object} LayerSpec
 * @property {string} id
 * @property {string} label
 * @property {string} [geojson]
 * @property {boolean} [defaultEnabled]
 * @property {boolean} [fitOnLoad]
 * @property {boolean} [noPopup]
 * @property {boolean} [detailPanel]
 * @property {number} [pointRadius]
 * @property {{ indexUrl: string, urlTemplate: string }} [tiled]
 * @property {boolean} [noHover]
 * @property {boolean} [folder]
 * @property {LayerSpec[]} [children]
 * @property {boolean} [defaultOpen]
 */

/**
 * @typedef {object} LayerRec
 * @property {LayerSpec} spec
 * @property {object} pathStyle
 * @property {object | null} pointStyle
 * @property {boolean} [didFit]
 * @property {L.LayerGroup | null} [tileGroup]
 * @property {Map<string, L.GeoJSON>} [loadedTiles]
 * @property {{ z: number, available: Set<string>, urlTemplate: string } | null} [indexMeta]
 * @property {(() => void) | null} [refreshHandler]
 * @property {ReturnType<typeof setTimeout> | null} [debTimer]
 * @property {L.GeoJSON | null} [layer]
 */

/** @type {Map<string, LayerRec>} */
const registry = new Map();

/** @type {{ lyr: L.CircleMarker, baseStyle: object } | null} */
let exclusivePointSelection = null;

function clearExclusivePointSelection() {
  if (exclusivePointSelection) {
    exclusivePointSelection.lyr.setStyle(exclusivePointSelection.baseStyle);
    exclusivePointSelection = null;
  }
}

map.on("click", () => {
  clearExclusivePointSelection();
});

function lon2tileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

function lat2tileY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

function tileKeysForBounds(bounds, z) {
  const x0 = lon2tileX(bounds.getWest(), z);
  const x1 = lon2tileX(bounds.getEast(), z);
  const y0 = lat2tileY(bounds.getNorth(), z);
  const y1 = lat2tileY(bounds.getSouth(), z);
  const xa = Math.min(x0, x1);
  const xb = Math.max(x0, x1);
  const ya = Math.min(y0, y1);
  const yb = Math.max(y0, y1);
  const keys = [];
  for (let x = xa; x <= xb; x++) {
    for (let y = ya; y <= yb; y++) {
      keys.push(`${x}_${y}`);
    }
  }
  return keys;
}

function prioritizeTiles(keys, center, z, maxN) {
  if (keys.length <= maxN) return keys;
  const cx = lon2tileX(center.lng, z);
  const cy = lat2tileY(center.lat, z);
  keys.sort((a, b) => {
    const [ax, ay] = a.split("_").map(Number);
    const [bx, by] = b.split("_").map(Number);
    const da = (ax - cx) ** 2 + (ay - cy) ** 2;
    const db = (bx - cx) ** 2 + (by - cy) ** 2;
    return da - db;
  });
  return keys.slice(0, maxN);
}

function bindVectorHover(lyr, baseStyle, isPoint) {
  if (!baseStyle) return;
  if (isPoint) {
    lyr.on("mouseover", () => lyr.setStyle({ ...baseStyle, weight: 2, fillOpacity: 1 }));
    lyr.on("mouseout", () => lyr.setStyle(baseStyle));
  } else if (lyr.setStyle) {
    lyr.on("mouseover", () =>
      lyr.setStyle({
        ...baseStyle,
        weight: (baseStyle.weight || 2) + 1,
        fillOpacity: Math.min(0.45, (baseStyle.fillOpacity || 0.18) + 0.2),
      })
    );
    lyr.on("mouseout", () => lyr.setStyle(baseStyle));
  }
}

function attachFeatureHandlers(feature, lyr, rec) {
  const spec = rec.spec;
  const isPoint = feature.geometry?.type === "Point";

  if (spec.detailPanel && feature.properties) {
    if (isPoint && rec.pointStyle) {
      const baseStyle = { ...rec.pointStyle };
      const hoverStyle = { ...baseStyle, weight: 2, fillOpacity: 1 };
      const selectedStyle = {
        ...baseStyle,
        weight: 3,
        fillColor: "#ea580c",
        color: "#431407",
        fillOpacity: 1,
        opacity: 1,
      };
      lyr.on("mouseover", () => {
        if (!exclusivePointSelection || exclusivePointSelection.lyr !== lyr) {
          lyr.setStyle(hoverStyle);
        }
      });
      lyr.on("mouseout", () => {
        if (!exclusivePointSelection || exclusivePointSelection.lyr !== lyr) {
          lyr.setStyle(baseStyle);
        } else {
          lyr.setStyle(selectedStyle);
        }
      });
      lyr.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        clearExclusivePointSelection();
        exclusivePointSelection = { lyr, baseStyle };
        lyr.setStyle(selectedStyle);
        openDetailPanel(spec.label, feature.properties);
        if (e.latlng) map.panTo(e.latlng, { animate: true });
      });
    } else {
      lyr.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        openDetailPanel(spec.label, feature.properties);
        if (e.latlng) map.panTo(e.latlng, { animate: true });
      });
    }
  } else if (!spec.noPopup) {
    const props =
      feature.properties && Object.keys(feature.properties).length
        ? `<pre class="popup-props">${escapeHtml(JSON.stringify(feature.properties, null, 2))}</pre>`
        : "";
    lyr.bindPopup(`<strong>${escapeHtml(spec.label)}</strong>${props}`);
  }

  if (spec.noHover) {
    return;
  }
  if (spec.detailPanel && isPoint && rec.pointStyle) {
    return;
  }
  if (isPoint && rec.pointStyle) {
    bindVectorHover(lyr, rec.pointStyle, true);
  } else {
    bindVectorHover(lyr, rec.pathStyle, false);
  }
}

function createLeafletGeoJsonOptions(rec) {
  const options = {
    style: rec.pathStyle,
    onEachFeature(feature, lyr) {
      attachFeatureHandlers(feature, lyr, rec);
    },
  };
  if (rec.pointStyle) {
    options.pointToLayer = (feature, latlng) => L.circleMarker(latlng, { ...rec.pointStyle });
  }
  return options;
}

async function ensureLayerLoaded(id) {
  const rec = registry.get(id);
  if (!rec || rec.layer || rec.spec.tiled) return rec?.layer ?? null;
  const url = new URL(rec.spec.geojson, window.location.href).href;
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const gj = L.geoJSON(data, createLeafletGeoJsonOptions(rec));

  if (!rec.spec.noPopup && !rec.spec.detailPanel) {
    gj.eachLayer((lyr) => {
      if (!lyr.feature && lyr.getLatLng) {
        lyr.bindPopup(`<strong>${escapeHtml(rec.spec.label)}</strong>`);
      }
    });
  }

  rec.layer = gj;
  if (rec.spec.fitOnLoad && !rec.didFit) {
    const b = gj.getBounds();
    if (b.isValid()) {
      map.fitBounds(b.pad(0.08));
      rec.didFit = true;
    }
  }
  return gj;
}

function disableTiledLayer(id) {
  const rec = registry.get(id);
  if (!rec) return;
  if (rec.refreshHandler) {
    map.off("moveend", rec.refreshHandler);
    map.off("zoomend", rec.refreshHandler);
    rec.refreshHandler = null;
  }
  if (rec.debTimer) {
    clearTimeout(rec.debTimer);
    rec.debTimer = null;
  }
  if (rec.tileGroup) {
    overlayRoot.removeLayer(rec.tileGroup);
    rec.tileGroup.clearLayers();
    rec.tileGroup = null;
  }
  if (rec.loadedTiles) {
    rec.loadedTiles.clear();
  }
  rec.indexMeta = null;
}

function scheduleTiledRefresh(id) {
  const rec = registry.get(id);
  if (!rec) return;
  if (rec.debTimer) clearTimeout(rec.debTimer);
  rec.debTimer = setTimeout(() => {
    refreshTiledLayer(id).catch(() => {});
  }, TILE_DEBOUNCE_MS);
}

async function loadOneTile(rec, tileKey) {
  if (!rec.tileGroup || !rec.indexMeta || rec.loadedTiles.has(tileKey)) return;
  const tpl = rec.indexMeta.urlTemplate.replace("{z}", String(rec.indexMeta.z)).replace("{tile}", tileKey);
  const url = new URL(tpl, window.location.href).href;
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) return;
  const data = await res.json();
  if (!rec.tileGroup || rec.loadedTiles.has(tileKey)) return;
  const sub = L.geoJSON(data, createLeafletGeoJsonOptions(rec));
  rec.tileGroup.addLayer(sub);
  rec.loadedTiles.set(tileKey, sub);
}

async function runPool(taskFns, n) {
  let i = 0;
  async function worker() {
    while (i < taskFns.length) {
      const j = i;
      i += 1;
      await taskFns[j]();
    }
  }
  const k = Math.min(n, Math.max(1, taskFns.length));
  await Promise.all(Array.from({ length: k }, () => worker()));
}

async function refreshTiledLayer(id) {
  const rec = registry.get(id);
  if (!rec?.tileGroup || !rec.indexMeta) return;
  const { z, available } = rec.indexMeta;
  let keys = tileKeysForBounds(map.getBounds().pad(0.12), z).filter((k) => available.has(k));
  keys = prioritizeTiles(keys, map.getCenter(), z, MAX_TILES_IN_VIEW);
  const keep = new Set(keys);

  for (const k of [...rec.loadedTiles.keys()]) {
    if (!keep.has(k)) {
      rec.tileGroup.removeLayer(rec.loadedTiles.get(k));
      rec.loadedTiles.delete(k);
    }
  }

  const needed = keys.filter((k) => !rec.loadedTiles.has(k));
  const tasks = needed.map((k) => () => loadOneTile(rec, k));
  await runPool(tasks, TILE_FETCH_CONCURRENCY);
}

async function enableTiledLayer(id) {
  const rec = registry.get(id);
  const row = document.querySelector(`[data-layer-id="${CSS.escape(id)}"]`);
  if (!rec?.spec.tiled) return;

  disableTiledLayer(id);

  rec.tileGroup = L.layerGroup();
  rec.loadedTiles = new Map();

  try {
    const idxUrl = new URL(rec.spec.tiled.indexUrl, window.location.href).href;
    const res = await fetch(idxUrl, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`index HTTP ${res.status}`);
    const meta = await res.json();
    rec.indexMeta = {
      z: meta.z,
      available: new Set(meta.tiles),
      urlTemplate: rec.spec.tiled.urlTemplate,
    };
    rec.tileGroup.addTo(overlayRoot);
    rec.refreshHandler = () => scheduleTiledRefresh(id);
    map.on("moveend", rec.refreshHandler);
    map.on("zoomend", rec.refreshHandler);
    await refreshTiledLayer(id);
  } catch (e) {
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
    disableTiledLayer(id);
    const cb = row?.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = false;
  }
}

function setOverlayVisible(id, on) {
  const rec = registry.get(id);
  if (!rec) return;
  const row = document.querySelector(`[data-layer-id="${CSS.escape(id)}"]`);

  if (rec.spec.tiled) {
    if (!on) {
      if (id === "iffi_piff_cmba") clearExclusivePointSelection();
      disableTiledLayer(id);
      row?.querySelector(".err")?.remove();
      return;
    }
    row?.querySelector(".err")?.remove();
    enableTiledLayer(id);
    return;
  }

  if (!on) {
    if (id === "iffi_piff_cmba") clearExclusivePointSelection();
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
  clearExclusivePointSelection();
  for (const rec of registry.values()) {
    if (rec.refreshHandler) {
      map.off("moveend", rec.refreshHandler);
      map.off("zoomend", rec.refreshHandler);
      rec.refreshHandler = null;
    }
    if (rec.debTimer) {
      clearTimeout(rec.debTimer);
      rec.debTimer = null;
    }
    if (rec.tileGroup) {
      overlayRoot.removeLayer(rec.tileGroup);
      rec.tileGroup.clearLayers();
    }
  }
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

  let styleIdx = 0;

  function registerLeaf(spec) {
    if (!spec?.id || !(spec.geojson || spec.tiled)) return;
    const idx = styleIdx;
    styleIdx += 1;
    const { pathStyle, pointStyle } = stylesForSpec(spec, idx);
    registry.set(spec.id, {
      spec,
      pathStyle,
      pointStyle,
      didFit: false,
      layer: null,
      tileGroup: null,
      loadedTiles: new Map(),
      indexMeta: null,
      refreshHandler: null,
      debTimer: null,
    });

    const row = document.createElement("div");
    row.className = "toggle-row";
    row.dataset.layerId = spec.id;

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = `layer-${spec.id}`;
    cb.checked = Boolean(spec.defaultEnabled);
    cb.addEventListener("change", () => setOverlayVisible(spec.id, cb.checked));

    const lab = document.createElement("label");
    lab.htmlFor = cb.id;
    lab.textContent = spec.label || spec.id;

    row.append(cb, lab);
    return row;
  }

  for (const item of layers) {
    if (item.folder && Array.isArray(item.children)) {
      const details = document.createElement("details");
      details.className = "layer-folder";
      if (item.defaultOpen !== false) details.open = true;

      const summary = document.createElement("summary");
      summary.className = "layer-folder-sum";
      summary.textContent = item.label || item.id || "Layers";
      details.appendChild(summary);

      const body = document.createElement("div");
      body.className = "layer-folder-body";
      for (const child of item.children) {
        const row = registerLeaf(child);
        if (row) body.appendChild(row);
      }
      if (body.childElementCount > 0) {
        details.appendChild(body);
        host.appendChild(details);
      }
    } else {
      const row = registerLeaf(item);
      if (row) host.appendChild(row);
    }
  }

  for (const rec of registry.values()) {
    if (rec.spec.defaultEnabled) {
      setOverlayVisible(rec.spec.id, true);
    }
  }
}

function manifestEntryValid(x) {
  if (!x || !x.id) return false;
  if (x.folder && Array.isArray(x.children)) {
    return x.children.some((c) => c && c.id && (c.geojson || c.tiled));
  }
  return Boolean(x.geojson || x.tiled);
}

async function loadLayerManifest() {
  let list = [];
  try {
    const url = new URL("data/layers.json", window.location.href).href;
    const res = await fetch(url, { credentials: "same-origin" });
    if (res.ok) {
      const data = await res.json();
      const raw = Array.isArray(data.layers) ? data.layers : [];
      list = raw.filter(manifestEntryValid);
    }
  } catch {
    /* optional manifest */
  }
  renderToggles(list);
}

/** --- Detail panel --- */
const detailPanel = document.getElementById("detail-panel");
const detailDragHandle = document.getElementById("detail-drag-handle");
const detailTitleEl = document.getElementById("detail-panel-title");
const detailAttrsEl = document.getElementById("detail-attrs");
const detailCloseBtn = document.getElementById("detail-close");

function openDetailPanel(layerLabel, properties) {
  if (!detailPanel || !detailAttrsEl || !detailTitleEl) return;
  detailTitleEl.textContent = layerLabel;
  detailAttrsEl.innerHTML = "";
  const keys = Object.keys(properties || {}).sort();
  for (const k of keys) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    const v = properties[k];
    dd.textContent = v == null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v);
    detailAttrsEl.appendChild(dt);
    detailAttrsEl.appendChild(dd);
  }
  detailPanel.classList.remove("hidden");
  window.requestAnimationFrame(syncFooterHeight);
}

function closeDetailPanel() {
  clearExclusivePointSelection();
  detailPanel?.classList.add("hidden");
  window.requestAnimationFrame(syncFooterHeight);
}

detailCloseBtn?.addEventListener("click", () => closeDetailPanel());

function syncDetailPanelToLeftTop() {
  if (!detailPanel) return;
  const r = detailPanel.getBoundingClientRect();
  detailPanel.style.right = "auto";
  detailPanel.style.left = `${Math.round(r.left)}px`;
  detailPanel.style.top = `${Math.round(r.top)}px`;
}

function clampDetailPanel(left, top) {
  const pad = 8;
  const el = detailPanel;
  if (!el) return { left, top };
  const r = el.getBoundingClientRect();
  const maxL = window.innerWidth - r.width - pad;
  const maxT = window.innerHeight - r.height - pad;
  const tb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--toolbar-h")) || 72;
  const fb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--foot-h")) || 72;
  return {
    left: Math.min(Math.max(pad, left), Math.max(pad, maxL)),
    top: Math.min(Math.max(tb + pad, top), Math.max(tb + pad, maxT - fb * 0.25)),
  };
}

let detailDragPtr = null;
let detailDragStartX = 0;
let detailDragStartY = 0;
let detailOriginLeft = 0;
let detailOriginTop = 0;

function onDetailDragMove(e) {
  if (detailDragPtr == null || e.pointerId !== detailDragPtr) return;
  const dx = e.clientX - detailDragStartX;
  const dy = e.clientY - detailDragStartY;
  const next = clampDetailPanel(detailOriginLeft + dx, detailOriginTop + dy);
  detailPanel.style.left = `${next.left}px`;
  detailPanel.style.top = `${next.top}px`;
}

function onDetailDragEnd(e) {
  if (detailDragPtr == null || e.pointerId !== detailDragPtr) return;
  detailDragPtr = null;
  try {
    detailDragHandle.releasePointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  document.removeEventListener("pointermove", onDetailDragMove);
  document.removeEventListener("pointerup", onDetailDragEnd);
  document.removeEventListener("pointercancel", onDetailDragEnd);
}

detailDragHandle?.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  e.preventDefault();
  syncDetailPanelToLeftTop();
  detailOriginLeft = detailPanel.getBoundingClientRect().left;
  detailOriginTop = detailPanel.getBoundingClientRect().top;
  detailDragStartX = e.clientX;
  detailDragStartY = e.clientY;
  detailDragPtr = e.pointerId;
  try {
    detailDragHandle.setPointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  document.addEventListener("pointermove", onDetailDragMove);
  document.addEventListener("pointerup", onDetailDragEnd);
  document.addEventListener("pointercancel", onDetailDragEnd);
});

/** Nominatim */
async function searchPlaces(query) {
  const q = query.trim();
  if (!q) return [];
  const u = new URL("https://nominatim.openstreetmap.org/search");
  u.searchParams.set("format", "jsonv2");
  u.searchParams.set("q", q);
  u.searchParams.set("limit", "10");
  const res = await fetch(u.toString(), {
    headers: { "Accept-Language": "en" },
  });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
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

const mapWrap = document.getElementById("map-wrap");
const searchFloat = document.getElementById("search-float");
const searchDragHandle = document.getElementById("search-drag-handle");
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
    empty.textContent = "No results";
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
  if (!searchFloat?.contains(e.target)) hideResults();
});

function syncSearchFloatBox() {
  if (!searchFloat || !mapWrap) return;
  const r = searchFloat.getBoundingClientRect();
  const w = mapWrap.getBoundingClientRect();
  const left = r.left - w.left;
  const top = r.top - w.top;
  searchFloat.style.right = "auto";
  searchFloat.style.left = `${Math.round(left)}px`;
  searchFloat.style.top = `${Math.round(top)}px`;
}

function clampSearchPosition(left, top) {
  const pad = 8;
  const w = mapWrap.getBoundingClientRect();
  const r = searchFloat.getBoundingClientRect();
  const maxL = w.width - r.width - pad;
  const maxT = w.height - r.height - pad;
  return {
    left: Math.min(Math.max(pad, left), Math.max(pad, maxL)),
    top: Math.min(Math.max(pad, top), Math.max(pad, maxT)),
  };
}

let dragPtr = null;
let dragStartX = 0;
let dragStartY = 0;
let dragOriginLeft = 0;
let dragOriginTop = 0;

function onDragMove(e) {
  if (dragPtr == null || e.pointerId !== dragPtr) return;
  const dx = e.clientX - dragStartX;
  const dy = e.clientY - dragStartY;
  const next = clampSearchPosition(dragOriginLeft + dx, dragOriginTop + dy);
  searchFloat.style.left = `${next.left}px`;
  searchFloat.style.top = `${next.top}px`;
  searchFloat.style.right = "auto";
}

function onDragEnd(e) {
  if (dragPtr == null || e.pointerId !== dragPtr) return;
  dragPtr = null;
  try {
    searchDragHandle.releasePointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  document.removeEventListener("pointermove", onDragMove);
  document.removeEventListener("pointerup", onDragEnd);
  document.removeEventListener("pointercancel", onDragEnd);
}

searchDragHandle?.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  e.preventDefault();
  syncSearchFloatBox();
  const w = mapWrap.getBoundingClientRect();
  const r = searchFloat.getBoundingClientRect();
  dragOriginLeft = r.left - w.left;
  dragOriginTop = r.top - w.top;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  dragPtr = e.pointerId;
  try {
    searchDragHandle.setPointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  document.addEventListener("pointermove", onDragMove);
  document.addEventListener("pointerup", onDragEnd);
  document.addEventListener("pointercancel", onDragEnd);
});

window.addEventListener("resize", () => {
  if (!searchFloat || !mapWrap) return;
  const w = mapWrap.getBoundingClientRect();
  const r = searchFloat.getBoundingClientRect();
  const left = r.left - w.left;
  const top = r.top - w.top;
  const c = clampSearchPosition(left, top);
  if (c.left !== left || c.top !== top) {
    searchFloat.style.left = `${c.left}px`;
    searchFloat.style.top = `${c.top}px`;
    searchFloat.style.right = "auto";
  }
  if (detailPanel && !detailPanel.classList.contains("hidden")) {
    const dr = detailPanel.getBoundingClientRect();
    const dc = clampDetailPanel(dr.left, dr.top);
    detailPanel.style.left = `${dc.left}px`;
    detailPanel.style.top = `${dc.top}px`;
  }
});

function syncFooterHeight() {
  const foot = document.querySelector(".site-foot");
  if (!foot) return;
  const h = Math.ceil(foot.getBoundingClientRect().height);
  document.documentElement.style.setProperty("--foot-h", `${Math.max(h + 6, 72)}px`);
}

loadLayerManifest().finally(() => {
  requestAnimationFrame(() => {
    syncFooterHeight();
    const foot = document.querySelector(".site-foot");
    if (foot && typeof ResizeObserver !== "undefined") {
      new ResizeObserver(syncFooterHeight).observe(foot);
    }
  });
});
window.addEventListener("resize", syncFooterHeight);
