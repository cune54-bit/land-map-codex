const VWORLD_KEY = "4E0AD412-BC5D-3976-8220-FD7C550431CE";

const elements = {
  status: document.getElementById("status"),
  landAddress: document.getElementById("landAddress"),
  pnu: document.getElementById("pnu"),
  landArea: document.getElementById("landArea"),
  landCategory: document.getElementById("landCategory"),
  landUse: document.getElementById("landUse"),
  ownerType: document.getElementById("ownerType"),
  coords: document.getElementById("coords"),
};

const state = {
  map: null,
  vectorSource: null,
  vectorLayer: null,
};

function setStatus(text, type) {
  elements.status.textContent = text;
  elements.status.className = `status-card is-${type}`;
}

function formatNumber(value, suffix = "") {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    return `${value}${suffix}`;
  }

  return `${parsed.toLocaleString("ko-KR")}${suffix}`;
}

function toArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (value === undefined || value === null) {
    return [];
  }

  return [value];
}

function extractFeatures(payload) {
  const response = payload?.response;
  const result = response?.result;
  const featureCollection = result?.featureCollection;

  if (Array.isArray(featureCollection?.features)) {
    return featureCollection.features;
  }

  return [];
}

function extractRows(payload) {
  const visited = new Set();

  function walk(node) {
    if (!node || typeof node !== "object" || visited.has(node)) {
      return [];
    }

    visited.add(node);

    if (Array.isArray(node.field)) {
      return node.field;
    }

    if (Array.isArray(node.ladfrl)) {
      return node.ladfrl;
    }

    for (const value of Object.values(node)) {
      const found = walk(value);
      if (found.length) {
        return found;
      }
    }

    return [];
  }

  return walk(payload);
}

function formatCoords(coord4326) {
  const [lon, lat] = coord4326;
  return `${lon.toFixed(6)}, ${lat.toFixed(6)}`;
}

function updateInfoPanel({ address, pnu, area, category, landUse, ownerType, coords }) {
  elements.landAddress.textContent = address || "주소 정보 없음";
  elements.pnu.textContent = `PNU ${pnu || "-"}`;
  elements.landArea.textContent = area || "-";
  elements.landCategory.textContent = category || "-";
  elements.landUse.textContent = landUse || "-";
  elements.ownerType.textContent = ownerType || "-";
  elements.coords.textContent = coords || "-";
}

function clearSelection() {
  state.vectorSource.clear();
  updateInfoPanel({
    address: "조회 결과 없음",
    pnu: "-",
    area: "-",
    category: "-",
    landUse: "-",
    ownerType: "-",
    coords: "-",
  });
}

function buildDomainParam() {
  return location.hostname ? `&domain=${encodeURIComponent(location.hostname)}` : "";
}

async function requestJson(url) {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
  } catch (error) {
    return requestJsonp(url);
  }
}

function requestJsonp(url) {
  return new Promise((resolve, reject) => {
    const callbackName = `__vworldJsonp_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const script = document.createElement("script");
    const cleanup = () => {
      delete window[callbackName];
      script.remove();
    };

    window[callbackName] = (data) => {
      cleanup();
      resolve(data);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error("JSONP request failed"));
    };

    const separator = url.includes("?") ? "&" : "?";
    script.src = `${url}${separator}callback=${callbackName}`;
    document.body.appendChild(script);
  });
}

async function fetchParcelFeature(coord4326) {
  const geomFilter = `POINT(${coord4326[0]} ${coord4326[1]})`;
  const url =
    "https://api.vworld.kr/req/data" +
    `?service=data&request=GetFeature&version=2.0&format=json&size=1&page=1` +
    `&data=LP_PA_CBND_BUBUN&geometry=true&geomFilter=${encodeURIComponent(geomFilter)}` +
    `&key=${encodeURIComponent(VWORLD_KEY)}${buildDomainParam()}`;

  const payload = await requestJson(url);
  return extractFeatures(payload)[0] || null;
}

async function fetchLandCharacteristics(pnu) {
  const url =
    "https://api.vworld.kr/ned/data/getLandCharacteristics" +
    `?format=json&pnu=${encodeURIComponent(pnu)}` +
    `&key=${encodeURIComponent(VWORLD_KEY)}${buildDomainParam()}`;

  const payload = await requestJson(url);
  return extractRows(payload)[0] || null;
}

async function fetchOwnerInfo(pnu) {
  const url =
    "https://api.vworld.kr/ned/data/ladfrlList" +
    `?format=json&pnu=${encodeURIComponent(pnu)}` +
    `&key=${encodeURIComponent(VWORLD_KEY)}${buildDomainParam()}`;

  const payload = await requestJson(url);
  return extractRows(payload);
}

function summarizeOwnerType(rows) {
  if (!rows.length) {
    return "공개 정보 없음";
  }

  const labels = rows
    .map((row) => row.posesnSeCodeNm || row.ownshipGbNm || row.ownerType || "")
    .filter(Boolean);

  if (!labels.length) {
    return "조회됨";
  }

  return [...new Set(labels)].join(", ");
}

function getAddressFromProperties(properties) {
  return (
    properties?.jibun ||
    properties?.addr ||
    [properties?.ldCodeNm, properties?.mnnm, properties?.slno]
      .filter(Boolean)
      .join(" ") ||
    "주소 정보 없음"
  );
}

function buildPolygonFeature(parcelFeature) {
  const geoJsonReader = new ol.format.GeoJSON();
  const feature = geoJsonReader.readFeature(parcelFeature, {
    dataProjection: "EPSG:4326",
    featureProjection: "EPSG:3857",
  });

  feature.setStyle(
    new ol.style.Style({
      stroke: new ol.style.Stroke({
        color: "#ea580c",
        width: 3,
      }),
      fill: new ol.style.Fill({
        color: "rgba(234, 88, 12, 0.18)",
      }),
    })
  );

  return feature;
}

async function handleMapClick(event) {
  const coord4326 = ol.proj.transform(event.coordinate, "EPSG:3857", "EPSG:4326");
  setStatus("필지 정보를 조회하고 있습니다...", "loading");
  elements.coords.textContent = formatCoords(coord4326);

  try {
    const parcelFeature = await fetchParcelFeature(coord4326);

    if (!parcelFeature) {
      clearSelection();
      setStatus("선택 지점에서 필지를 찾지 못했습니다.", "error");
      return;
    }

    const properties = parcelFeature.properties || {};
    const pnu = properties.pnu || properties.PNU;
    const [landCharacteristics, ownerRows] = await Promise.all([
      pnu ? fetchLandCharacteristics(pnu).catch(() => null) : Promise.resolve(null),
      pnu ? fetchOwnerInfo(pnu).catch(() => []) : Promise.resolve([]),
    ]);

    state.vectorSource.clear();
    state.vectorSource.addFeature(buildPolygonFeature(parcelFeature));

    const landArea =
      formatNumber(
        landCharacteristics?.lndpclAr || properties.area || properties.lndpclAr,
        "㎡"
      );

    const landCategory =
      landCharacteristics?.lndcgrCodeNm ||
      properties.jimok ||
      properties.lndcgrCodeNm ||
      "-";

    const landUse =
      toArray([
        landCharacteristics?.prposArea1Nm,
        landCharacteristics?.prposArea2Nm,
        landCharacteristics?.prposArea3Nm,
      ].filter(Boolean)).join(" / ") || "-";

    updateInfoPanel({
      address: getAddressFromProperties(properties),
      pnu,
      area: landArea,
      category: landCategory,
      landUse,
      ownerType: summarizeOwnerType(ownerRows),
      coords: formatCoords(coord4326),
    });

    setStatus("필지 정보를 불러왔습니다.", "success");
  } catch (error) {
    console.error(error);
    clearSelection();
    setStatus(
      "조회 중 오류가 발생했습니다. 브이월드 인증 설정 또는 API 응답 형식을 확인해 주세요.",
      "error"
    );
  }
}

function initMap() {
  state.vectorSource = new ol.source.Vector();
  state.vectorLayer = new ol.layer.Vector({
    source: state.vectorSource,
  });

  vw.ol3.MapOptions = {
    mapMode: "2d-map",
    basemapType: vw.ol3.BasemapType.GRAPHIC,
    controlDensity: vw.ol3.DensityType.EMPTY,
    interactionDensity: vw.ol3.DensityType.BASIC,
    controlsAutoArrange: true,
    homePosition: vw.ol3.CameraPosition,
    initPosition: vw.ol3.CameraPosition,
  };

  state.map = new vw.ol3.Map("map", vw.ol3.MapOptions);
  state.map.addLayer(state.vectorLayer);
  state.map.on("click", handleMapClick);

  state.map.getView().setCenter(ol.proj.fromLonLat([127.0276, 37.4979]));
  state.map.getView().setZoom(16);
}

window.onload = initMap;
