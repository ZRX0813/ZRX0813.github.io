const defaultCenter = [35.0, 105.0];
const defaultZoom = 4;

const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
});

const cartoPositron = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  maxZoom: 20,
  attribution: '&copy; OpenStreetMap &copy; <a href="https://carto.com/attributions">CARTO</a>',
});

const map = L.map("map", {
  center: defaultCenter,
  zoom: defaultZoom,
  layers: [osm],
  zoomControl: true,
});

L.control.scale({ imperial: false, metric: true }).addTo(map);

const baseMaps = {
  "OpenStreetMap": osm,
  "浅色底图 (CARTO)": cartoPositron,
};

L.control.layers(baseMaps, {}, { collapsed: true }).addTo(map);

const vectorGroup = L.layerGroup().addTo(map);
let layerCounter = 0;

function defaultVectorStyle() {
  return {
    color: "#3d8bfd",
    weight: 2,
    opacity: 0.95,
    fillColor: "#3d8bfd",
    fillOpacity: 0.2,
  };
}

function addGeoJSON(data, displayName) {
  const id = `ly-${++layerCounter}`;
  const gj = L.geoJSON(data, {
    style: defaultVectorStyle,
    onEachFeature(feature, lyr) {
      const props =
        feature.properties && Object.keys(feature.properties).length
          ? `<pre class="popup-props">${escapeHtml(JSON.stringify(feature.properties, null, 2))}</pre>`
          : "";
      lyr.bindPopup(`<strong>${escapeHtml(displayName)}</strong>${props}`);
      lyr.on("mouseover", () => lyr.setStyle({ weight: 3, fillOpacity: 0.35 }));
      lyr.on("mouseout", () => lyr.setStyle(defaultVectorStyle()));
    },
  }).addTo(vectorGroup);

  gj.eachLayer((lyr) => {
    if (lyr.feature == null && lyr.getLatLng) {
      lyr.bindPopup(`<strong>${escapeHtml(displayName)}</strong>`);
    }
  });

  const entry = { id, name: displayName, layer: gj };
  registerLayer(entry);
  fitToVectors();
  return entry;
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

const registered = [];

function registerLayer(entry) {
  registered.push(entry);
  refreshLayerList();
}

function refreshLayerList() {
  const ul = document.getElementById("layer-list");
  const hint = document.getElementById("layer-hint");
  ul.innerHTML = "";
  if (registered.length === 0) {
    hint.style.display = "";
    return;
  }
  hint.style.display = "none";

  for (const { id, name, layer } of registered) {
    const li = document.createElement("li");
    li.dataset.id = id;

    const nameSpan = document.createElement("span");
    nameSpan.className = "name";
    nameSpan.textContent = name;
    nameSpan.title = name;

    const actions = document.createElement("span");
    const fitBtn = document.createElement("button");
    fitBtn.type = "button";
    fitBtn.className = "link";
    fitBtn.textContent = "定位";
    fitBtn.addEventListener("click", () => {
      const b = layer.getBounds();
      if (b.isValid()) map.fitBounds(b.pad(0.08));
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "link danger";
    removeBtn.textContent = "移除";
    removeBtn.addEventListener("click", () => removeLayerById(id));

    actions.append(fitBtn, removeBtn);
    li.append(nameSpan, actions);
    ul.appendChild(li);
  }
}

function removeLayerById(id) {
  const idx = registered.findIndex((e) => e.id === id);
  if (idx === -1) return;
  const { name, layer } = registered[idx];
  vectorGroup.removeLayer(layer);
  registered.splice(idx, 1);
  refreshLayerList();
  map.closePopup();
}

function fitToVectors() {
  const bounds = L.latLngBounds([]);
  vectorGroup.eachLayer((lyr) => {
    if (lyr.getBounds) {
      const b = lyr.getBounds();
      if (b.isValid()) bounds.extend(b);
    }
  });
  if (bounds.isValid()) {
    map.fitBounds(bounds.pad(0.08));
  }
}

function clearAllVectors() {
  while (registered.length) {
    const { layer } = registered.pop();
    vectorGroup.removeLayer(layer);
  }
  refreshLayerList();
  map.setView(defaultCenter, defaultZoom);
}

async function loadGeoJSONFromUrl(path) {
  const url = new URL(path, window.location.href).href;
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const name = path.split("/").pop() || path;
  addGeoJSON(data, name);
}

document.getElementById("geojson-file").addEventListener("change", (e) => {
  const files = Array.from(e.target.files || []);
  for (const file of files) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        addGeoJSON(data, file.name);
      } catch (err) {
        alert(`无法解析 ${file.name}: ${err.message}`);
      }
    };
    reader.readAsText(file, "UTF-8");
  }
  e.target.value = "";
});

document.getElementById("btn-clear").addEventListener("click", () => clearAllVectors());

document.getElementById("btn-fit").addEventListener("click", () => {
  if (registered.length === 0) {
    map.setView(defaultCenter, defaultZoom);
    return;
  }
  fitToVectors();
});

const urlModal = document.getElementById("url-modal");
const urlInput = document.getElementById("url-input");

function openUrlModal() {
  urlModal.classList.remove("hidden");
  urlInput.focus();
}

function closeUrlModal() {
  urlModal.classList.add("hidden");
}

document.getElementById("btn-load-url").addEventListener("click", openUrlModal);

urlModal.querySelectorAll("[data-close-modal]").forEach((el) => {
  el.addEventListener("click", closeUrlModal);
});

document.getElementById("url-confirm").addEventListener("click", async () => {
  const path = urlInput.value.trim().replace(/^\//, "");
  if (!path) {
    alert("请输入路径");
    return;
  }
  try {
    await loadGeoJSONFromUrl(path);
    closeUrlModal();
    urlInput.value = "";
  } catch (err) {
    alert(`加载失败: ${err.message}`);
  }
});

urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("url-confirm").click();
});
