/**
 * 서울 필지 분석 프로그램 - 프런트엔드 로직 (1~3단계)
 *
 * 1단계에서 구현한 것:
 * - 서울 중심 지도 초기화 (Leaflet)
 * - 백엔드(/api/parcels)에서 테스트용 필지 GeoJSON을 불러와 지도에 표시
 * - 필지 클릭 시 오른쪽 패널에 정보 표시 + 선택 필지 강조
 * - 반경 500m / 1km 원 표시 토글 버튼
 *
 * 2단계에서 추가한 것:
 * - 주소·지번 검색 UI (지도 위 오버레이 패널)
 * - 백엔드(/api/search)를 통한 VWorld 주소 검색 (프런트엔드는 VWorld를 직접 호출하지 않음)
 * - 검색 결과 선택 시: 지도 이동 + 임시 마커 표시 + 오른쪽 패널에 "검색된 위치" 정보 표시
 * - "분석 중심(analysisCenter)" 개념 도입: 필지를 클릭하든 검색 결과를 선택하든,
 *   가장 최근에 선택한 위치를 기준으로 반경 500m/1km 원이 그려집니다.
 *
 * 3단계에서 추가한 것:
 * - 검색 결과 선택 또는 지도 직접 클릭 시, 백엔드(/api/parcel-boundary)로 실제 VWorld
 *   필지 경계(PNU 우선, 없으면 좌표)를 조회해서 노란 테두리 폴리곤으로 표시
 * - 오른쪽 패널에 실제 필지 정보(PNU/주소/지번/본번/부번/면적/중심좌표/데이터셋) 표시
 * - 분석 중심의 최우선순위가 "실제 필지 중심"으로 바뀜(검색 마커 < 테스트 필지 < 실제 필지)
 * - 필지 레이어 클릭 시 지도 클릭 이벤트가 중복 실행되지 않도록 이벤트 전파 차단
 * - 연속 클릭 시 이전 요청 취소(AbortController) + 좌표/PNU 캐시로 중복 VWorld 호출 방지
 *
 * 4단계에서 추가한 것:
 * - 실제 필지 선택 시에만 활성화되는 "주변 500m 건축물 분석" 버튼
 * - 백엔드(/api/buildings/analysis)로 노후도(연령 구간)·용도 데이터를 받아 건물 폴리곤 표시
 * - 노후도/용도 레이어 전환, 범례, 통계(연령 확보율/평균·중앙연령/30·40년 이상 비율 등)
 * - 건물 클릭 시 백엔드(/api/buildings/detail)로 건축물대장 표제부 지연 조회 + 후보 목록 처리
 * - 새 필지 선택 시 이전 건물 분석 결과 자동 제거, AbortController로 오래된 응답 무시
 *
 * 아직 구현하지 않는 것 (다음 단계 예정):
 * - 용도지역·용도지구, 법정 건폐율/용적률 계산, 교통 접근성 등
 */

const SEOUL_CENTER = [37.5665, 126.978];
const DEFAULT_ZOOM = 15;
const SEARCH_RESULT_ZOOM = 17;

// 2026-09-10: 전체 UI 개편 — 왼쪽 위에 검색 카드가 떠 있으므로, Leaflet 기본 확대/축소
// 버튼(기본 위치가 topleft)이 카드에 가려지지 않도록 오른쪽 아래로 옮깁니다.
const map = L.map("map", { zoomControl: false }).setView(SEOUL_CENTER, DEFAULT_ZOOM);
L.control.zoom({ position: "bottomright" }).addTo(map);

/** 검색 결과로 이동할 때, 왼쪽 위에 떠 있는 카드(검색+정보)에 가려지지 않도록
 * 목표 지점이 카드 오른쪽의 빈 공간에 오게 지도를 이동합니다. 카드가 접혀있거나
 * 좁은 화면이면 굳이 필요 없지만, 매번 계산하기보다 고정 오프셋으로 충분합니다
 * (두 카드 폭 합쳐 약 620px이므로 그 절반 정도만 밀어도 가려지지 않습니다). */
function setMapViewClearOfCards(latlng, zoom) {
  map.setView(latlng, zoom, { animate: false });
  if (window.innerWidth > 700) {
    map.panBy([-220, 0], { animate: false });
  }
}

// 8.3단계(UI): 배경지도 여러 종류 중 선택 가능하게 구성합니다. 전부 API 키가 필요 없는
// 공개 타일 서비스입니다. OSM 표준 타일은 도로명·건물명·POI가 이미지 안에 합쳐져 있어
// 그중 하나만 개별로 숨기는 건 불가능합니다 — 그래서 "무라벨 지도"를 별도 옵션으로
// 제공합니다(라벨을 프로그램이 지우는 게 아니라, 처음부터 라벨이 없는 타일을 씁니다).
// ⚠️ 회귀 수정: 처음에는 회색조/위성지도에 Esri의 legacy 타일 서비스
// (server.arcgisonline.com)를 썼는데, 이 서비스가 2022년에 이미 폐기되어 타일이 정상
// 로드되지 않는 것을 실제로 확인했습니다. 후속 서비스는 API 키가 필요해서(요청사항:
// API 키 필요하면 임의로 연결하지 않음), 전부 확실히 동작하는 CARTO 타일로 교체했습니다.
const BASEMAP_OPTIONS = [
  {
    key: "osm", label: "일반 지도",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
  {
    key: "carto_light", label: "밝은 지도",
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=cb1_2zpz_1_ffa1ccdb34ee4c1274ff5d8e",
    attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; OpenStreetMap contributors',
  },
  {
    key: "carto_dark", label: "어두운(회색조 계열) 지도",
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=cb1_2zpz_1_ffa1ccdb34ee4c1274ff5d8e",
    attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; OpenStreetMap contributors',
  },
  {
    key: "carto_nolabel", label: "무라벨 지도",
    url: "https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png?key=cb1_2zpz_1_ffa1ccdb34ee4c1274ff5d8e",
    attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; OpenStreetMap contributors',
  },
];

let currentBasemapLayer = null;
let currentBasemapKey = null;

function switchBasemap(key) {
  const opt = BASEMAP_OPTIONS.find((b) => b.key === key) || BASEMAP_OPTIONS[0];
  if (currentBasemapLayer) map.removeLayer(currentBasemapLayer);
  currentBasemapLayer = L.tileLayer(opt.url, {
    maxZoom: 19,
    attribution: opt.attribution,
    crossOrigin: true, // 이미지 내보내기(html2canvas)가 캔버스에서 픽셀을 읽으려면 필요
  });
  // ⚠️ 이 함수는 페이지 로드 초반(el 객체가 아직 정의되기 전)에도 한 번 호출되므로,
  // el.xxx 대신 document.getElementById를 직접 씁니다(el을 여기서 참조하면 "Cannot
  // access 'el' before initialization" 오류로 스크립트 전체가 멈추는 버그가 있었습니다).
  let tileErrorCount = 0;
  currentBasemapLayer.on("tileerror", () => {
    tileErrorCount += 1;
    const hintEl = document.getElementById("map-display-hint");
    if (tileErrorCount === 3 && hintEl) {
      hintEl.textContent = `⚠ "${opt.label}" 타일을 불러오지 못하고 있습니다. 다른 배경지도를 선택해주세요.`;
    }
  });
  currentBasemapLayer.on("load", () => {
    const hintEl = document.getElementById("map-display-hint");
    if (hintEl && hintEl.textContent.includes(opt.label)) {
      hintEl.textContent = "";
    }
  });
  currentBasemapLayer.addTo(map);
  currentBasemapKey = key;
  const hintElNow = document.getElementById("map-display-hint");
  if (hintElNow) hintElNow.textContent = "";
  try {
    localStorage.setItem("siteAnalysis.basemap.v2", key);
  } catch (e) {
    /* localStorage 사용 불가 환경이면 조용히 무시(표현 설정 저장만 안 될 뿐 기능엔 영향 없음) */
  }
}

// ⚠️ 사용자 피드백: "일반 지도"(OSM 표준 타일)는 병원·나무 같은 POI 아이콘이 이미지에
// 그대로 박혀 있어 지저분해 보인다는 지적을 받아, 기본값을 아이콘이 없는 "밝은 지도"
// (CARTO Positron)로 바꿨습니다. 저장 키를 ".v2"로 새로 만든 이유: 예전 버전을 쓰던
// 브라우저에 이미 "osm"이 저장돼 있으면 기본값 변경이 적용되지 않기 때문입니다
// (기존 저장값이 있으면 항상 그게 우선하므로) — 키를 바꿔서 다들 새 기본값을 받게 합니다.
switchBasemap((function () {
  try {
    return localStorage.getItem("siteAnalysis.basemap.v2") || "carto_light";
  } catch (e) {
    return "carto_light";
  }
})());

// 필지 레이어 스타일
const DEFAULT_STYLE = {
  color: "#2980b9",
  weight: 2,
  fillColor: "#3498db",
  fillOpacity: 0.2,
};

const SELECTED_STYLE = {
  color: "#e74c3c",
  weight: 4,
  fillColor: "#e74c3c",
  fillOpacity: 0.3,
};

// 3단계: 실제 VWorld 필지 폴리곤 스타일. 기존 테스트 필지(파란/빨강)와 구분되도록
// 노란 테두리 + 노란 반투명 채움을 사용합니다.
const REAL_PARCEL_STYLE = {
  color: "#f1c40f",
  weight: 4,
  fillColor: "#f1c40f",
  fillOpacity: 0.35,
};

// 다중 필지 선택: 개별 필지 경계는 병합 외곽선(REAL_PARCEL_STYLE, 굵게)보다 얇게
// 표시해 "각 필지의 개별 경계는 확인 가능하게 유지"합니다(요청사항 2).
const INDIVIDUAL_PARCEL_STYLE = {
  color: "#f1c40f",
  weight: 1.5,
  fillColor: "#f1c40f",
  fillOpacity: 0.12,
  dashArray: "3,2",
};

let parcelLayerGroup = null; // 필지 폴리곤들을 담는 레이어
let selectedParcelId = null;

let searchMarker = null; // 검색 결과 선택 시 표시되는 임시 마커
let realParcelLayer = null; // 3단계: 실제 VWorld 필지 폴리곤 레이어 (한 번에 하나만 표시)

// ⚠️ 사용자 피드백으로 개선: 기존엔 조회 중 새 클릭을 그냥 무시하는 락(boolean)만 있어서,
// 빠르게 다른 곳을 클릭하면 "먼저 누른 위치"가 이기는 문제가 있었습니다. 이제
// AbortController로 진행 중이던 이전 요청을 취소하고 "마지막 클릭"만 반영합니다.
// 같은 좌표/PNU는 parcelBoundaryCache에 캐시해 VWorld 재호출을 막습니다.
//
// 다중 필지 선택(Shift+클릭) 추가: 일반 클릭은 여전히 "진행 중이던 모든 요청을 취소하고
// 새로 시작"하지만, Shift+클릭(추가 선택)은 서로 취소하지 않아야 빠르게 여러 필지를
// 연달아 클릭해도 전부 반영됩니다 — 그래서 AbortController를 Set으로 여러 개 관리합니다.
let parcelLookupAbortControllers = new Set();
let parcelLookupRequestId = 0;
const parcelBoundaryCache = new Map(); // key -> { status:"success", parcel:{...} }
const PARCEL_CACHE_COORD_PRECISION = 6; // 소수 6자리 ≈ 11cm — 같은 클릭으로 볼 수 있는 정밀도

function _parcelCacheKey({ pnu, longitude, latitude }) {
  if (pnu) return `pnu:${pnu}`;
  return `coord:${longitude.toFixed(PARCEL_CACHE_COORD_PRECISION)},${latitude.toFixed(PARCEL_CACHE_COORD_PRECISION)}`;
}

// 4단계: 현재 "주변 건축물 분석"의 대상이 되는 실제 필지 (필지 클릭/검색과 별개로 관리)
let activeRealParcel = null; // { geometry, pnu, centroid, ... } | null — 다중 선택 시 "병합된 가상 필지"가 담김

// 다중 필지 선택 (Shift+클릭으로 추가): 개별 필지들을 관리하고, 변경될 때마다
// /api/parcel-boundary/merge로 병합해 activeRealParcel을 갱신합니다. 기존 단일 필지
// 분석 파이프라인(activateRealParcel 이하)은 전혀 건드리지 않습니다 — activeRealParcel이
// 항상 "지금 분석해야 할 대상"이라는 기존 계약을 그대로 유지합니다.
const selectedParcels = new Map(); // key -> 개별 parcel 객체(geometry 포함, 중복 방지용 Map)
let mergedParcelResult = null; // 마지막 /api/parcel-boundary/merge 응답 (area/perimeter/is_disjoint 등)
let individualParcelsLayer = null; // 개별 필지 경계(얇게) 표시 레이어 — 병합 외곽선과 별도

function _parcelSelectionKey(parcel) {
  if (parcel.pnu) return `pnu:${parcel.pnu}`;
  if (parcel.centroid) {
    return `coord:${parcel.centroid.longitude.toFixed(6)},${parcel.centroid.latitude.toFixed(6)}`;
  }
  return `idx:${Date.now()}:${Math.random()}`;
}

let buildingLayer = null; // 건물 GeoJSON 레이어 (지도 위, 한 번에 하나만 표시)
let buildingLayerMode = "age"; // "age" | "use"
let buildingAnalysisResult = null; // 마지막으로 성공한 /api/buildings/analysis 응답
let isBuildingAnalysisInFlight = false;
let buildingAnalysisAbortController = null;
let buildingAnalysisRequestId = 0; // 새 요청보다 늦게 도착한 오래된 응답을 무시하기 위한 카운터
let buildingDetailAbortController = null;

// 5단계: 저층·노후·저밀 조건 검색 필터 상태
let activeBuildingFilter = null; // { conditions: [...], mode: 'and'|'or' } | null

// 6.1단계: 대중교통(지하철) 접근성 분석 상태 (건축물 분석과 독립적으로 관리)
let transitAnalysisResult = null;
let transitLayer = null; // 지도 위 지하철역 마커 레이어
let isTransitAnalysisInFlight = false;
let transitAnalysisAbortController = null;
let transitAnalysisRequestId = 0;

// 6.2단계: 대상지 접도·진입·경계 분석 상태 (건축물/대중교통 분석과 독립적으로 관리)
let boundaryAnalysisResult = null;
let boundaryLayer = null; // 지도 위 경계 세그먼트 + 진입구 후보 마커 레이어
let isBoundaryAnalysisInFlight = false;
let boundaryAnalysisAbortController = null;
let boundaryAnalysisRequestId = 0;

// 7.1단계: 방위·일조·주변 건물 그림자 분석 상태 (다른 분석과 독립적으로 관리)
let shadowAnalysisResult = null;
let shadowLayer = null; // 지도 위 그림자/히트맵/태양방향/진북 레이어
let isShadowAnalysisInFlight = false;
let shadowAnalysisAbortController = null;
let shadowAnalysisRequestId = 0;
let shadowDisplayMode = "instant"; // "instant" | "heatmap"
let shadowSelectedSeason = "winter_solstice";
let shadowSelectedTime = "12:00";

// 7.2단계: 대상지 지형·표고·경사 분석 상태 (다른 분석과 독립적으로 관리)
let terrainAnalysisResult = null;
let terrainFillLayer = null;
let terrainContourLayer = null;
let isTerrainAnalysisInFlight = false;
let terrainAnalysisAbortController = null;
let terrainAnalysisRequestId = 0;
let terrainDisplayMode = "elevation"; // "elevation" | "slope" (등고선은 독립 레이어로 분리됨)

// 7.3단계: 대상지 조망·시야 개방성 분석 상태 (다른 분석과 독립적으로 관리)
let visibilityAnalysisResult = null;
let visibilityLayer = null;
let isVisibilityAnalysisInFlight = false;
let visibilityAnalysisAbortController = null;
let visibilityAnalysisRequestId = 0;
let visibilitySelectedViewpointId = null;
let visibilitySelectedHeight = 1.5;

// 7.4단계: 대상지 주변 환경 분석(소음·통풍) 상태 (다른 분석과 독립적으로 관리)
let environmentAnalysisResult = null;
let environmentLayer = null;
let isEnvironmentAnalysisInFlight = false;
let environmentAnalysisAbortController = null;
let environmentAnalysisRequestId = 0;
let environmentDisplayMode = "noise"; // "noise" | "ventilation"

let isSelectingUserViewpoint = false;
let userViewpointCoords = null;

// ------------------------------------------------------------------
// 사용성 개선: 지도 레이어 ON/OFF 패널 — 이미 계산된 분석 결과의 지도 표시 여부만
// 관리합니다(재계산·API 재호출 없음). 각 레이어는 이미 존재하는 render*Layer() 함수가
// 만든 Leaflet 레이어 객체를 그대로 재사용합니다.
// ------------------------------------------------------------------

const LAYER_DEFS = [
  { key: "buildings_base", label: "주변 건물" },
  { key: "buildings_age", label: "건축물 노후도" },
  { key: "buildings_use", label: "건축물 용도" },
  { key: "buildings_floors", label: "층수" },
  { key: "buildings_height", label: "높이" },
  { key: "transit", label: "지하철역" },
  { key: "boundary", label: "도로·접도·진입후보" },
  { key: "shadow_instant", label: "일조·그림자" },
  { key: "shadow_heatmap", label: "일조 히트맵" },
  { key: "terrain_elevation", label: "지형 표고" },
  { key: "terrain_slope", label: "경사도" },
  { key: "terrain_contour", label: "등고선" },
  { key: "visibility", label: "조망·개방성" },
  { key: "noise", label: "소음 영향" },
  { key: "ventilation", label: "통풍 가능성" },
];

// 사용성 개선: 레이어 패널을 카테고리로 묶어서 보여줍니다(요청사항: 실제 존재하는
// 레이어만 그룹화 — "회피·주의 영역"처럼 아직 별도 지도 레이어로 그려지지 않는 항목은
// 넣지 않았습니다. "진입 후보"는 접도 분석과 같은 레이어에서 함께 그려지므로 별도
// 항목을 새로 만들지 않고 "도로·접도·진입후보" 하나로 묶었습니다).
const LAYER_GROUPS = [
  { label: "주변 건축물", keys: ["buildings_base", "buildings_age", "buildings_use", "buildings_floors", "buildings_height"] },
  { label: "교통·접근성", keys: ["transit", "boundary"] },
  { label: "일조·환경", keys: ["shadow_instant", "shadow_heatmap", "noise", "ventilation"] },
  { label: "지형·경사", keys: ["terrain_elevation", "terrain_slope", "terrain_contour"] },
  { label: "조망·개방성", keys: ["visibility"] },
];

const layerCheckedState = {};
LAYER_DEFS.forEach((d) => (layerCheckedState[d.key] = false));

// 같은 Leaflet 레이어 객체·모드 변수를 공유해서 항상 셋 중 하나만 켤 수 있는 그룹들
// (레이어 자체가 하나뿐이라 동시에 여러 모드를 보여줄 수 없음).
const SHARED_STORAGE_GROUPS = [
  ["buildings_base", "buildings_age", "buildings_use", "buildings_floors", "buildings_height"],
  ["shadow_instant", "shadow_heatmap"],
  ["terrain_elevation", "terrain_slope"],
  ["noise", "ventilation"],
];

// "지도 전체를 덮는 주 분석 레이어는 한 번에 하나만" — 요청사항. 이 목록 중 하나를 켜면
// 나머지는 자동으로 꺼집니다. 건물/지하철/접도/등고선/일조그림자(순간)처럼 특정 지점·선만
// 표시하는 보조 벡터 레이어는 이 규칙에서 제외되어 자유롭게 중첩할 수 있습니다.
const GLOBAL_FILL_KEYS = [
  "buildings_age", "buildings_use", "buildings_floors", "buildings_height",
  "shadow_heatmap", "terrain_elevation", "terrain_slope", "visibility",
];

function _getLayerObjectForKey(key) {
  switch (key) {
    case "buildings_base":
    case "buildings_age":
    case "buildings_use":
    case "buildings_floors":
    case "buildings_height":
      return buildingLayer;
    case "transit":
      return transitLayer;
    case "boundary":
      return boundaryLayer;
    case "shadow_instant":
    case "shadow_heatmap":
      return shadowLayer;
    case "terrain_elevation":
    case "terrain_slope":
      return terrainFillLayer;
    case "terrain_contour":
      return terrainContourLayer;
    case "visibility":
      return visibilityLayer;
    case "noise":
    case "ventilation":
      return environmentLayer;
    default:
      return null;
  }
}

/** 이 key가 지금 실제로 지도에 보여야 하는지(체크 상태 + 현재 모드가 일치하는지) 판정합니다. */
function _shouldShowKey(key) {
  if (!layerCheckedState[key]) return false;
  switch (key) {
    case "shadow_instant":
      return shadowDisplayMode === "instant";
    case "shadow_heatmap":
      return shadowDisplayMode === "heatmap";
    case "terrain_elevation":
      return terrainDisplayMode === "elevation";
    case "terrain_slope":
      return terrainDisplayMode === "slope";
    case "noise":
      return environmentDisplayMode === "noise";
    case "ventilation":
      return environmentDisplayMode === "ventilation";
    default:
      return true;
  }
}

/** buildings_base/age/use 세 개는 레이어 하나(buildingLayer)를 공유하므로 한꺼번에 판정합니다. */
function applyBuildingLayerVisibility() {
  if (!buildingLayer) return;
  const shouldShow = layerCheckedState.buildings_base || layerCheckedState.buildings_age ||
    layerCheckedState.buildings_use || layerCheckedState.buildings_floors || layerCheckedState.buildings_height;
  if (shouldShow && !map.hasLayer(buildingLayer)) {
    buildingLayer.addTo(map);
  } else if (!shouldShow && map.hasLayer(buildingLayer)) {
    map.removeLayer(buildingLayer);
  }
}

/** key 하나의 지도 표시 상태를 현재 layerCheckedState/모드 값에 맞춰 동기화합니다. */
function applyLayerVisibility(key) {
  if (["buildings_base", "buildings_age", "buildings_use", "buildings_floors", "buildings_height"].includes(key)) {
    applyBuildingLayerVisibility();
    return;
  }
  const layerObj = _getLayerObjectForKey(key);
  if (!layerObj) return;

  const shouldShow = _shouldShowKey(key);
  if (shouldShow && !map.hasLayer(layerObj)) {
    layerObj.addTo(map);
    if (realParcelLayer) {
      realParcelLayer.eachLayer((layer) => layer.bringToFront && layer.bringToFront());
    }
  } else if (!shouldShow && map.hasLayer(layerObj)) {
    map.removeLayer(layerObj);
  }
}

function updateLayerCheckboxUI(key) {
  const checkbox = document.getElementById(`layer-check-${key}`);
  if (checkbox) checkbox.checked = layerCheckedState[key];
}

/**
 * 체크박스 하나의 상태를 바꾸고, 관련된 상호배타 규칙(같은 레이어 공유 그룹, 전역 주
 * 레이어 하나만)을 적용한 뒤, 지도 표시를 동기화합니다.
 */
function setLayerChecked(key, checked, options = {}) {
  if (!(key in layerCheckedState)) return;
  layerCheckedState[key] = checked;

  if (checked && !options.skipExclusivity) {
    const sharedGroup = SHARED_STORAGE_GROUPS.find((g) => g.includes(key));
    if (sharedGroup) {
      sharedGroup.forEach((sibling) => {
        if (sibling !== key && layerCheckedState[sibling]) {
          layerCheckedState[sibling] = false;
          updateLayerCheckboxUI(sibling);
          applyLayerVisibility(sibling);
        }
      });
    }
    if (GLOBAL_FILL_KEYS.includes(key)) {
      GLOBAL_FILL_KEYS.forEach((otherKey) => {
        if (otherKey !== key && layerCheckedState[otherKey]) {
          layerCheckedState[otherKey] = false;
          updateLayerCheckboxUI(otherKey);
          applyLayerVisibility(otherKey);
        }
      });
    }
  }

  updateLayerCheckboxUI(key);
  applyLayerVisibility(key);
  if (typeof refreshMapLegendOverlay === "function") refreshMapLegendOverlay();
}

function turnOffAllLayers() {
  LAYER_DEFS.forEach((def) => {
    if (layerCheckedState[def.key]) {
      layerCheckedState[def.key] = false;
      updateLayerCheckboxUI(def.key);
      applyLayerVisibility(def.key);
    }
  });
}

/** 분석 결과가 초기화될 때(새 필지 선택 등), 관련 레이어의 체크 표시만 해제합니다
 * (레이어 객체 자체는 각 clear*Analysis() 함수가 이미 null로 정리합니다). */
function _uncheckLayers(...keys) {
  keys.forEach((key) => {
    if (key in layerCheckedState) {
      layerCheckedState[key] = false;
      updateLayerCheckboxUI(key);
    }
  });
}

function renderLayerCheckboxList() {
  if (!el.layerCheckboxList) return;
  el.layerCheckboxList.innerHTML = "";
  const defByKey = Object.fromEntries(LAYER_DEFS.map((d) => [d.key, d]));

  LAYER_GROUPS.forEach((group) => {
    const heading = document.createElement("div");
    heading.className = "layer-group-heading";
    heading.textContent = group.label;
    el.layerCheckboxList.appendChild(heading);

    group.keys.forEach((key) => {
      const def = defByKey[key];
      if (!def) return; // 존재하지 않는 레이어는 표시하지 않음(요청사항)

      const item = document.createElement("div");
      item.className = "layer-checkbox-item";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.id = `layer-check-${def.key}`;
      checkbox.checked = layerCheckedState[def.key];
      checkbox.addEventListener("change", () => setLayerChecked(def.key, checkbox.checked));

      const label = document.createElement("label");
      label.setAttribute("for", checkbox.id);
      label.textContent = def.label;

      item.appendChild(checkbox);
      item.appendChild(label);
      el.layerCheckboxList.appendChild(item);
    });
  });
}

// 5.5단계: QGIS용 GeoPackage 내보내기 상태
let isExportInFlight = false;
let exportAbortController = null;

// 4단계: 연령 구간 <-> 라벨/색상 설정. 백엔드 models/building.py의 AGE_BAND_CONFIG와
// 같은 값을 사용합니다 (하나의 "출처"를 코드로 공유할 수 없어 값만 동일하게 맞춰둠).
const AGE_BAND_CONFIG = {
  under_10: { label: "10년 미만", color: "#2F80ED" },
  age_10_19: { label: "10~20년", color: "#27AE60" },
  age_20_29: { label: "20~30년", color: "#F2C94C" },
  age_30_39: { label: "30~40년", color: "#F2994A" },
  age_40_plus: { label: "40년 이상", color: "#EB5757" },
  unknown: { label: "정보 없음", color: "#9E9E9E" },
};
const USE_CATEGORY_COLORS = {
  공동주택: "#2F80ED",
  단독주택: "#56CCF2",
  근린생활시설: "#27AE60",
  판매_업무시설: "#F2C94C",
  숙박시설: "#9B51E0",
  문화_집회시설: "#BB6BD9",
  교육_연구시설: "#219653",
  의료시설: "#EB5757",
  공장_창고시설: "#F2994A",
  기타: "#828282",
  미상: "#9E9E9E",
};

// 5단계: 층수/높이 구간(고정, 백엔드 models/building.py의 FLOOR_BAND_CONFIG/HEIGHT_BAND_CONFIG와
// 같은 값). 건폐율/용적률/연면적은 지역마다 분포가 달라 고정 색상표 대신, 매 응답의
// summary.*_distribution 순서에 QUANTILE_PALETTE를 그대로 입혀서 씁니다.
const FLOOR_BAND_CONFIG = {
  floor_1_2: { label: "1~2층", color: "#2F80ED" },
  floor_3_5: { label: "3~5층", color: "#27AE60" },
  floor_6_10: { label: "6~10층", color: "#F2C94C" },
  floor_11_20: { label: "11~20층", color: "#F2994A" },
  floor_21_plus: { label: "21층 이상", color: "#EB5757" },
  unknown: { label: "정보 없음", color: "#9E9E9E" },
};
const HEIGHT_BAND_CONFIG = {
  height_under_10: { label: "10m 미만", color: "#2F80ED" },
  height_10_20: { label: "10~20m", color: "#27AE60" },
  height_20_40: { label: "20~40m", color: "#F2C94C" },
  height_40_80: { label: "40~80m", color: "#F2994A" },
  height_80_plus: { label: "80m 이상", color: "#EB5757" },
  unknown: { label: "정보 없음", color: "#9E9E9E" },
};
const QUANTILE_PALETTE = ["#2F80ED", "#27AE60", "#F2994A", "#EB5757"];
const QUANTILE_UNKNOWN_COLOR = "#9E9E9E";

// 6.2단계: 경계 방향별 색상 (필지 경계별 색상 구분 요구사항)
const BOUNDARY_DIRECTION_COLORS = {
  N: "#e74c3c",
  NE: "#e67e22",
  E: "#f1c40f",
  SE: "#2ecc71",
  S: "#1abc9c",
  SW: "#3498db",
  W: "#9b59b6",
  NW: "#e91e63",
};
const ENTRANCE_CANDIDATE_ICONS = {
  pedestrian_main: { color: "#27ae60", label: "보행 주출입구 후보" },
  vehicle: { color: "#2980b9", label: "차량 진입구 후보" },
  service: { color: "#8e44ad", label: "서비스 진입구 후보" },
};

// 지도 위 주제도 버튼 <-> summary 필드 매핑을 한 곳에서 관리합니다 (여기저기 흩어지지 않도록).
const THEME_META = {
  age: { button: "btnLayerAge", coverageField: "coverage_rate_percent", withField: "buildings_with_age" },
  use: { button: "btnLayerUse" }, // use_data 상태로 별도 판단
  floors: { button: "btnLayerFloors", coverageField: "floors_coverage_rate_percent", withField: "buildings_with_floors" },
  height: { button: "btnLayerHeight", coverageField: "height_coverage_rate_percent", withField: "buildings_with_height" },
  gfa: { button: "btnLayerGfa", coverageField: null, withField: "buildings_with_gross_floor_area" },
  bcr: { button: "btnLayerBcr", coverageField: "bcr_coverage_rate_percent", withField: "buildings_with_bcr" },
  far: { button: "btnLayerFar", coverageField: "far_coverage_rate_percent", withField: "buildings_with_far" },
};

// "분석 중심": 아래 중 가장 최근에 확정된 위치를 기준으로 반경 500m/1km 원을 그립니다.
// 우선순위(문서 기준): 실제 필지 중심 > 테스트 필지 중심 > 검색 위치 마커
// (구현상으로는 "가장 최근에 성공적으로 확정된 선택"을 그대로 사용하며, 실제 필지 조회가
//  비동기로 나중에 성공하면 자연스럽게 그 시점에 최우선으로 갱신됩니다.)
let analysisCenter = null; // { lat, lng } | null
let analysisCenterSource = null; // 'parcel' | 'search' | 'real_parcel' | null

let radiusCircle500 = null;
let radiusCircle1000 = null;
let isRadius500Visible = false;
let isRadius1000Visible = false;

const el = {
  serverStatus: document.getElementById("server-status"),

  // UI 간소화: 왼쪽/오른쪽 패널, 분석 메뉴
  leftPanel: document.getElementById("left-panel"),
  rightPanel: document.getElementById("right-panel"),
  btnToggleLeftPanel: document.getElementById("btn-toggle-left-panel"),
  btnToggleRightPanelHeader: document.getElementById("btn-toggle-right-panel-header"),
  analysisMenu: document.getElementById("analysis-menu"),
  rightPanelScroll: document.querySelector(".right-panel-scroll"),
  leftFlowHint: document.getElementById("left-flow-hint"),

  // 8.8단계: 사업성 및 사업내용 (이제 STEP2 개발검토 Workspace 탭 안에 위치 —
  // js/dev-workspace.js가 화면 전환을 담당)
  fsParcelCount: document.getElementById("fs-parcel-count"),
  fsTotalArea: document.getElementById("fs-total-area"),
  fsLocation: document.getElementById("fs-location"),
  fsJibunList: document.getElementById("fs-jibun-list"),
  fsLandValueTotal: document.getElementById("fs-land-value-total"),
  fsLandValueAvg: document.getElementById("fs-land-value-avg"),
  fsJigaDate: document.getElementById("fs-jiga-date"),
  fsJigaMissingNote: document.getElementById("fs-jiga-missing-note"),
  fsFarBase: document.getElementById("fs-far-base"),
  fsFarAllowed: document.getElementById("fs-far-allowed"),
  fsZoneNote: document.getElementById("fs-zone-note"),

  // 8.10단계: 공공기여 계산 엔진 단일화(실제 사전협상/특별계획구역 검토 사례의
  // "환산부지" 공식을 반영) — 기부채납 수단별 입력과 완화 배율.
  fsGiveLandArea: document.getElementById("fs-give-land-area"),
  fsGiveCash: document.getElementById("fs-give-cash"),
  fsSiteValueMethod: document.getElementById("fs-site-value-method"),
  fsSiteValue: document.getElementById("fs-site-value"),
  fsWeightLand: document.getElementById("fs-weight-land"),
  fsFarFormula: document.getElementById("fs-far-formula"),
  fsCalcProfile: document.getElementById("fs-calc-profile"),
  fsProfileSource: document.getElementById("fs-profile-source"),
  fsCalcLinkWarning: document.getElementById("fs-calc-link-warning"),
  fsBldgFacilities: document.getElementById("fs-bldg-facilities"),
  btnFsAddFacility: document.getElementById("btn-fs-add-facility"),
  fsContribLandPct: document.getElementById("fs-contrib-land-pct"),
  fsContribBldgPct: document.getElementById("fs-contrib-bldg-pct"),
  fsContribCashPct: document.getElementById("fs-contrib-cash-pct"),
  fsContribTotalPct: document.getElementById("fs-contrib-total-pct"),
  fsFarRelief: document.getElementById("fs-far-relief"),
  fsFarCap: document.getElementById("fs-far-cap"),
  fsFloorBase: document.getElementById("fs-floor-base"),
  fsFloorCap: document.getElementById("fs-floor-cap"),
  fsFloorIncrease: document.getElementById("fs-floor-increase"),
  // 미산정 사유 목록 — "왜 값이 안 나왔는지"를 사용자에게 그대로 보여줍니다.
  fsUnmetReasons: document.getElementById("fs-unmet-reasons"),
  fsSummaryText: document.getElementById("fs-summary-text"),
  btnFsCopySummary: document.getElementById("btn-fs-copy-summary"),
  btnShowFeasibility: document.getElementById("btn-show-feasibility"),

  layerCheckboxList: document.getElementById("layer-checkbox-list"),
  btnLayersAllOff: document.getElementById("btn-layers-all-off"),

  mapContainer: document.getElementById("map-container"),
  btnPresentationToggle: document.getElementById("btn-presentation-toggle"),
  btnExportImage: document.getElementById("btn-export-image"),
  btnZoningToggle: document.getElementById("btn-zoning-toggle"),
  zoningLegend: document.getElementById("zoning-legend"),
  btnAreaSelectStart: document.getElementById("btn-area-select-start"),
  btnAreaSelectFinish: document.getElementById("btn-area-select-finish"),
  btnAreaSelectCancel: document.getElementById("btn-area-select-cancel"),
  btnAreaReviewDone: document.getElementById("btn-area-review-done"),
  areaSelectHint: document.getElementById("area-select-hint"),
  presentationTitle: document.getElementById("presentation-title"),
  mapLegendOverlay: document.getElementById("map-legend-overlay"),
  mapLegendOverlayTitle: document.getElementById("map-legend-overlay-title"),
  mapLegendOverlayBody: document.getElementById("map-legend-overlay-body"),
  mapNorthArrow: document.getElementById("map-north-arrow"),
  mapSourceNote: document.getElementById("map-source-note"),
  basemapOptions: document.getElementById("basemap-options"),
  legendPositionSelect: document.getElementById("legend-position-select"),
  chkShowLegend: document.getElementById("chk-show-legend"),
  chkShowScale: document.getElementById("chk-show-scale"),
  chkShowNorth: document.getElementById("chk-show-north"),
  chkShowTitle: document.getElementById("chk-show-title"),
  chkShowSource: document.getElementById("chk-show-source"),
  presentationTitleInput: document.getElementById("presentation-title-input"),
  exportRatioSelect: document.getElementById("export-ratio-select"),
  mapDisplayHint: document.getElementById("map-display-hint"),

  infoEmptyMessage: document.getElementById("info-empty-message"),
  infoPanelParcel: document.getElementById("info-panel-parcel"),
  infoPanelSearch: document.getElementById("info-panel-search"),
  searchPanelNote: document.getElementById("search-panel-note"),
  infoPanelRealParcel: document.getElementById("info-panel-real-parcel"),
  realParcelNote: document.getElementById("real-parcel-note"),

  // 다중 필지 선택 UI (신규)
  multiParcelPanel: document.getElementById("multi-parcel-panel"),
  multiParcelCount: document.getElementById("multi-parcel-count"),
  multiParcelTotalArea: document.getElementById("multi-parcel-total-area"),
  multiParcelDisjointWarning: document.getElementById("multi-parcel-disjoint-warning"),
  multiParcelList: document.getElementById("multi-parcel-list"),
  btnClearAllParcels: document.getElementById("btn-clear-all-parcels"),
  parcelStatus: document.getElementById("parcel-status"),

  // 요청사항: "대상지 기본정보"는 주소/면적만 남기고 나머지 필드는 삭제
  realParcelAddress: document.getElementById("real-parcel-address"),
  realParcelArea: document.getElementById("real-parcel-area"),

  panelAddress: document.getElementById("panel-address"),
  panelArea: document.getElementById("panel-area"),

  searchPanelTitle: document.getElementById("search-panel-title"),

  btnRadius500: document.getElementById("btn-radius-500"),
  btnRadius1000: document.getElementById("btn-radius-1000"),

  searchInput: document.getElementById("search-input"),
  searchButton: document.getElementById("search-button"),
  searchStatus: document.getElementById("search-status"),
  searchResultsList: document.getElementById("search-results"),
  searchResetButton: document.getElementById("search-reset-button"),

  btnBuildingAnalysis: document.getElementById("btn-building-analysis"),
  buildingAnalysisHint: document.getElementById("building-analysis-hint"),
  buildingStatus: document.getElementById("building-status"),
  buildingLayerSwitch: document.getElementById("building-layer-switch"),
  btnLayerAge: document.getElementById("btn-layer-age"),
  btnLayerUse: document.getElementById("btn-layer-use"),
  btnLayerFloors: document.getElementById("btn-layer-floors"),
  btnLayerHeight: document.getElementById("btn-layer-height"),
  btnLayerGfa: document.getElementById("btn-layer-gfa"),
  btnLayerBcr: document.getElementById("btn-layer-bcr"),
  btnLayerFar: document.getElementById("btn-layer-far"),
  buildingThemeDisabledReason: document.getElementById("building-theme-disabled-reason"),
  buildingLegend: document.getElementById("building-legend"),
  buildingSummary: document.getElementById("building-summary"),
  summaryCore: document.getElementById("summary-core"),
  summaryTheme: document.getElementById("summary-theme"),
  summaryHousing: document.getElementById("summary-housing"),
  buildingWarnings: document.getElementById("building-warnings"),

  buildingFilterCard: document.getElementById("building-filter-card"),
  filterAgeEnable: document.getElementById("filter-age-enable"),
  filterAgeValue: document.getElementById("filter-age-value"),
  filterFloorsEnable: document.getElementById("filter-floors-enable"),
  filterFloorsValue: document.getElementById("filter-floors-value"),
  filterFarEnable: document.getElementById("filter-far-enable"),
  filterFarValue: document.getElementById("filter-far-value"),
  filterGfaEnable: document.getElementById("filter-gfa-enable"),
  filterGfaValue: document.getElementById("filter-gfa-value"),
  btnFilterApply: document.getElementById("btn-filter-apply"),
  btnFilterReset: document.getElementById("btn-filter-reset"),
  filterResult: document.getElementById("filter-result"),

  btnExportQgis: document.getElementById("btn-export-qgis"),
  exportStatus: document.getElementById("export-status"),

  buildingDetailCard: document.getElementById("building-detail-card"),
  buildingDetailStatus: document.getElementById("building-detail-status"),
  detailName: document.getElementById("detail-name"),
  detailAge: document.getElementById("detail-age"),
  detailUse: document.getElementById("detail-use"),
  detailAddress: document.getElementById("detail-address"),
  detailStructure: document.getElementById("detail-structure"),
  detailFloors: document.getElementById("detail-floors"),
  detailHeight: document.getElementById("detail-height"),
  detailSiteArea: document.getElementById("detail-site-area"),
  detailBuildingArea: document.getElementById("detail-building-area"),
  detailFloorArea: document.getElementById("detail-floor-area"),
  detailBcr: document.getElementById("detail-bcr"),
  detailFar: document.getElementById("detail-far"),
  detailHouseholds: document.getElementById("detail-households"),
  detailParking: document.getElementById("detail-parking"),
  detailMatchStatus: document.getElementById("detail-match-status"),
  detailSource: document.getElementById("detail-source"),
  buildingDetailCandidates: document.getElementById("building-detail-candidates"),

  btnTransitAnalysis: document.getElementById("btn-transit-analysis"),
  transitAnalysisHint: document.getElementById("transit-analysis-hint"),
  transitStatus: document.getElementById("transit-status"),
  transitSummary: document.getElementById("transit-summary"),
  transitNearestStation: document.getElementById("transit-nearest-station"),
  transitNearestDist: document.getElementById("transit-nearest-dist"),
  transitNearestLines: document.getElementById("transit-nearest-lines"),
  transitCount500: document.getElementById("transit-count-500"),
  transitCount1km: document.getElementById("transit-count-1km"),
  transitLineCount500: document.getElementById("transit-line-count-500"),
  transitLineCount1km: document.getElementById("transit-line-count-1km"),
  transitWarnings: document.getElementById("transit-warnings"),

  btnBoundaryAnalysis: document.getElementById("btn-boundary-analysis"),
  boundaryAnalysisHint: document.getElementById("boundary-analysis-hint"),
  boundaryStatus: document.getElementById("boundary-status"),
  boundarySummary: document.getElementById("boundary-summary"),
  boundaryEntranceList: document.getElementById("boundary-entrance-list"),
  boundaryList: document.getElementById("boundary-list"),
  boundaryWarnings: document.getElementById("boundary-warnings"),

  btnShadowAnalysis: document.getElementById("btn-shadow-analysis"),
  shadowAnalysisHint: document.getElementById("shadow-analysis-hint"),
  shadowStatus: document.getElementById("shadow-status"),
  shadowSummary: document.getElementById("shadow-summary"),
  shadowSeasonSelect: document.getElementById("shadow-season-select"),
  shadowTimeSelect: document.getElementById("shadow-time-select"),
  btnShadowModeInstant: document.getElementById("btn-shadow-mode-instant"),
  btnShadowModeHeatmap: document.getElementById("btn-shadow-mode-heatmap"),
  shadowLegend: document.getElementById("shadow-legend"),
  shadowSunInfo: document.getElementById("shadow-sun-info"),
  shadowGridInfo: document.getElementById("shadow-grid-info"),
  shadowHeightInfo: document.getElementById("shadow-height-info"),
  shadowRegionSentences: document.getElementById("shadow-region-sentences"),
  shadowWarnings: document.getElementById("shadow-warnings"),

  terrainRangeSelect: document.getElementById("terrain-range-select"),
  terrainSpacingInput: document.getElementById("terrain-spacing-input"),
  btnTerrainAnalysis: document.getElementById("btn-terrain-analysis"),
  terrainAnalysisHint: document.getElementById("terrain-analysis-hint"),
  terrainStatus: document.getElementById("terrain-status"),
  terrainSummary: document.getElementById("terrain-summary"),
  btnTerrainModeElevation: document.getElementById("btn-terrain-mode-elevation"),
  btnTerrainModeSlope: document.getElementById("btn-terrain-mode-slope"),
  terrainLegend: document.getElementById("terrain-legend"),
  terrainElevationRange: document.getElementById("terrain-elevation-range"),
  terrainElevationDiff: document.getElementById("terrain-elevation-diff"),
  terrainSlopeInfo: document.getElementById("terrain-slope-info"),
  terrainSlopeDirection: document.getElementById("terrain-slope-direction"),
  terrainConfidence: document.getElementById("terrain-confidence"),
  terrainDesignSentence: document.getElementById("terrain-design-sentence"),
  terrainBoundarySentences: document.getElementById("terrain-boundary-sentences"),
  terrainWarnings: document.getElementById("terrain-warnings"),

  visibilityAngleSelect: document.getElementById("visibility-angle-select"),
  btnVisibilityUserPoint: document.getElementById("btn-visibility-user-point"),
  btnVisibilityAnalysis: document.getElementById("btn-visibility-analysis"),
  visibilityAnalysisHint: document.getElementById("visibility-analysis-hint"),
  visibilityStatus: document.getElementById("visibility-status"),
  visibilitySummary: document.getElementById("visibility-summary"),
  visibilityViewpointSelect: document.getElementById("visibility-viewpoint-select"),
  visibilityHeightSelect: document.getElementById("visibility-height-select"),
  visibilityLegend: document.getElementById("visibility-legend"),
  visibilityRadarChart: document.getElementById("visibility-radar-chart"),
  visibilityOpenRatio: document.getElementById("visibility-open-ratio"),
  visibilityBestDirection: document.getElementById("visibility-best-direction"),
  visibilitySentences: document.getElementById("visibility-sentences"),
  visibilityInsights: document.getElementById("visibility-insights"),
  visibilityWarnings: document.getElementById("visibility-warnings"),

  btnEnvironmentAnalysis: document.getElementById("btn-environment-analysis"),
  environmentAnalysisHint: document.getElementById("environment-analysis-hint"),
  environmentStatus: document.getElementById("environment-status"),
  environmentSummary: document.getElementById("environment-summary"),
  btnEnvironmentModeNoise: document.getElementById("btn-environment-mode-noise"),
  btnEnvironmentModeVentilation: document.getElementById("btn-environment-mode-ventilation"),
  environmentLegend: document.getElementById("environment-legend"),
  environmentSentences: document.getElementById("environment-sentences"),
  environmentInsights: document.getElementById("environment-insights"),
  environmentWarnings: document.getElementById("environment-warnings"),
};

/* ------------------------------------------------------------------ */
/* 서버 상태 확인                                                       */
/* ------------------------------------------------------------------ */

async function checkServerHealth() {
  try {
    const res = await fetch("/api/health");
    if (!res.ok) throw new Error("health check failed");
    el.serverStatus.textContent = "서버 연결됨";
    el.serverStatus.classList.add("ok");
  } catch (err) {
    el.serverStatus.textContent = "서버 연결 실패";
    el.serverStatus.classList.add("error");
    console.error("서버 상태 확인 실패:", err);
  }
}

/* ------------------------------------------------------------------ */
/* 1단계: 필지 목록 로드 및 클릭 처리                                     */
/* ------------------------------------------------------------------ */

async function loadParcels() {
  try {
    const res = await fetch("/api/parcels");
    if (!res.ok) {
      throw new Error(`필지 목록을 불러오지 못했습니다. (status: ${res.status})`);
    }
    const geojson = await res.json();

    parcelLayerGroup = L.geoJSON(geojson, {
      style: () => DEFAULT_STYLE,
      onEachFeature: (feature, layer) => {
        layer.on("click", (e) => {
          // 3단계: 지도 자체의 click 핸들러(실제 필지 조회)가 중복 실행되지 않도록 전파를 막습니다.
          L.DomEvent.stopPropagation(e);
          selectParcel(feature.properties.id);
        });
      },
    }).addTo(map);
  } catch (err) {
    console.error(err);
    alert("필지 데이터를 불러오는 중 오류가 발생했습니다. 서버가 실행 중인지 확인해주세요.");
  }
}

async function selectParcel(parcelId) {
  selectedParcelId = parcelId;
  restyleParcelLayers();

  // 3단계: 다른 종류의 선택(실제 필지)이 남아있다면 정리합니다 (현재 선택은 테스트 필지이므로).
  clearRealParcelSelection();

  try {
    const res = await fetch(`/api/parcels/${encodeURIComponent(parcelId)}`);
    if (!res.ok) {
      throw new Error(`필지 상세 정보를 불러오지 못했습니다. (status: ${res.status})`);
    }
    const feature = await res.json();

    showParcelInfo(feature);

    analysisCenter = latLngFromGeometry(feature.geometry);
    analysisCenterSource = "parcel";
    updateRadiusCircles();
  } catch (err) {
    console.error(err);
    alert("선택한 필지의 상세 정보를 불러오는 중 오류가 발생했습니다.");
  }
}

function restyleParcelLayers() {
  if (!parcelLayerGroup) return;

  parcelLayerGroup.eachLayer((layer) => {
    const isSelected = layer.feature.properties.id === selectedParcelId;
    layer.setStyle(isSelected ? SELECTED_STYLE : DEFAULT_STYLE);
    if (isSelected) {
      layer.bringToFront();
    }
  });
}

/** GeoJSON Polygon의 대략적인 중심점(centroid)을 단순 평균 방식으로 계산 */
function calculateCentroid(geometry) {
  const ring = geometry.coordinates[0]; // 첫 번째 외곽 링
  const pointCount = ring.length - 1; // 마지막 점은 첫 점과 동일(닫힌 링)하므로 제외

  let lngSum = 0;
  let latSum = 0;

  for (let i = 0; i < pointCount; i++) {
    lngSum += ring[i][0];
    latSum += ring[i][1];
  }

  return { lat: latSum / pointCount, lng: lngSum / pointCount };
}

function latLngFromGeometry(geometry) {
  return calculateCentroid(geometry);
}

/* ------------------------------------------------------------------ */
/* 오른쪽 정보 패널 (1~2단계 공용)                                        */
/* ------------------------------------------------------------------ */

function hideAllInfoPanelStates() {
  el.infoEmptyMessage.hidden = true;
  el.infoPanelParcel.hidden = true;
  el.infoPanelSearch.hidden = true;
  el.searchPanelNote.hidden = true;
  el.infoPanelRealParcel.hidden = true;
  el.realParcelNote.hidden = true;
}

function showParcelInfo(feature) {
  const props = feature.properties;

  el.panelAddress.textContent = props.address;
  el.panelArea.textContent = `${props.area_sqm.toLocaleString("ko-KR")} m²`;

  hideAllInfoPanelStates();
  el.infoPanelParcel.hidden = false;
}

function showSearchLocationInfo(result) {
  el.searchPanelTitle.textContent = result.title;

  hideAllInfoPanelStates();
  el.infoPanelSearch.hidden = false;
  el.searchPanelNote.hidden = false;
}

function showEmptyInfoPanel() {
  hideAllInfoPanelStates();
  el.infoEmptyMessage.hidden = false;
}

/* 3단계: 실제 VWorld 필지 정보 패널 */
function showRealParcelInfo(parcel) {
  el.realParcelAddress.textContent = parcel.address || "확인 안 됨";

  el.realParcelArea.textContent =
    parcel.area_sqm != null
      ? `${parcel.area_sqm.toLocaleString("ko-KR")} m² (도형 기준 계산)`
      : "계산 불가";

  hideAllInfoPanelStates();
  el.infoPanelRealParcel.hidden = false;
  el.realParcelNote.hidden = false;
}

/* ------------------------------------------------------------------ */
/* 반경 500m / 1km 원 (1~2단계 공용, analysisCenter 기준)                  */
/* ------------------------------------------------------------------ */

function updateRadiusCircles() {
  if (radiusCircle500) {
    map.removeLayer(radiusCircle500);
    radiusCircle500 = null;
  }
  if (radiusCircle1000) {
    map.removeLayer(radiusCircle1000);
    radiusCircle1000 = null;
  }

  if (!analysisCenter) return;

  const center = [analysisCenter.lat, analysisCenter.lng];

  radiusCircle500 = L.circle(center, {
    radius: 500,
    color: "#e74c3c",
    weight: 4,
    dashArray: "6, 6",
    fill: false,
  });

  radiusCircle1000 = L.circle(center, {
    radius: 1000,
    color: "#e67e22",
    weight: 4,
    dashArray: "2, 8",
    fill: false,
  });

  if (isRadius500Visible) radiusCircle500.addTo(map);
  if (isRadius1000Visible) radiusCircle1000.addTo(map);
}

function toggleRadiusButton({ button, isVisibleRef, setVisible }) {
  if (!analysisCenter) {
    alert("먼저 지도에서 필지를 선택하거나 주소를 검색해주세요.");
    return;
  }

  const nextVisible = !isVisibleRef();
  setVisible(nextVisible);
  button.classList.toggle("active", nextVisible);
  updateRadiusCircles();
}

el.btnRadius500.addEventListener("click", () => {
  toggleRadiusButton({
    button: el.btnRadius500,
    isVisibleRef: () => isRadius500Visible,
    setVisible: (value) => {
      isRadius500Visible = value;
    },
  });
});

el.btnRadius1000.addEventListener("click", () => {
  toggleRadiusButton({
    button: el.btnRadius1000,
    isVisibleRef: () => isRadius1000Visible,
    setVisible: (value) => {
      isRadius1000Visible = value;
    },
  });
});

/* ------------------------------------------------------------------ */
/* 2단계: 주소 검색                                                      */
/* ------------------------------------------------------------------ */

async function performSearch() {
  const query = el.searchInput.value.trim();

  el.searchResultsList.hidden = true;
  el.searchResultsList.innerHTML = "";

  if (query.length < 2) {
    showSearchStatus("검색어를 2글자 이상 입력해주세요.", "error");
    return;
  }

  showSearchStatus("검색 중...", "loading");
  el.searchButton.disabled = true;

  try {
    const res = await fetch(`/api/search?query=${encodeURIComponent(query)}`);
    const body = await res.json();

    if (!res.ok) {
      const message = (body && body.detail) || "검색 중 오류가 발생했습니다.";
      showSearchStatus(message, "error");
      return;
    }

    if (!body.results || body.results.length === 0) {
      showSearchStatus("검색 결과가 없습니다.", "empty");
      return;
    }

    hideSearchStatus();
    renderSearchResults(body.results);
  } catch (err) {
    console.error(err);
    showSearchStatus(
      "네트워크 오류로 검색에 실패했습니다. 인터넷 연결과 서버 상태를 확인해주세요.",
      "error"
    );
  } finally {
    el.searchButton.disabled = false;
  }
}

function showSearchStatus(message, kind) {
  el.searchStatus.textContent = message;
  el.searchStatus.hidden = false;
  el.searchStatus.className = `search-status ${kind}`;

  // 오류/결과없음 메시지가 떠 있는 동안에도 초기화 버튼으로 지울 수 있게 표시
  if (kind === "error" || kind === "empty") {
    el.searchResetButton.hidden = false;
  }
}

function hideSearchStatus() {
  el.searchStatus.hidden = true;
  el.searchStatus.textContent = "";
}

function renderSearchResults(results) {
  el.searchResultsList.innerHTML = "";

  results.forEach((result) => {
    const li = document.createElement("li");
    li.className = "search-result-item";

    const titleEl = document.createElement("div");
    titleEl.className = "search-result-title";
    titleEl.textContent = result.title;

    const typeEl = document.createElement("span");
    typeEl.className = "search-result-type";
    typeEl.textContent = result.address_type === "road" ? "도로명" : "지번";
    titleEl.appendChild(typeEl);

    li.appendChild(titleEl);

    if (result.road_address) {
      const roadEl = document.createElement("div");
      roadEl.className = "search-result-sub";
      roadEl.textContent = `도로명: ${result.road_address}`;
      li.appendChild(roadEl);
    }

    if (result.parcel_address) {
      const parcelEl = document.createElement("div");
      parcelEl.className = "search-result-sub";
      parcelEl.textContent = `지번: ${result.parcel_address}`;
      li.appendChild(parcelEl);
    }

    li.addEventListener("click", () => selectSearchResult(result));
    el.searchResultsList.appendChild(li);
  });

  el.searchResultsList.hidden = false;
  el.searchResetButton.hidden = false;
}

function selectSearchResult(result) {
  // 1) 지도를 검색 위치로 이동 + 확대 (왼쪽 위 카드에 가려지지 않게 오프셋)
  setMapViewClearOfCards([result.latitude, result.longitude], SEARCH_RESULT_ZOOM);

  // 2) 이전 검색 마커가 있으면 제거 후, 새 임시 마커 추가
  if (searchMarker) {
    map.removeLayer(searchMarker);
  }
  searchMarker = L.marker([result.latitude, result.longitude]).addTo(map);
  searchMarker.on("click", (e) => L.DomEvent.stopPropagation(e));

  // 3) 필지 선택 강조는 해제 (현재 분석 대상은 검색 위치이므로)
  selectedParcelId = null;
  restyleParcelLayers();

  // 3단계: 이전 검색에 대한 실제 필지 레이어가 남아있다면 정리 (새로 조회할 것이므로)
  clearRealParcelSelection();

  // 4) 오른쪽 패널에 "검색된 위치" 정보 표시
  showSearchLocationInfo(result);

  // 5) 분석 중심을 검색 위치로 변경
  analysisCenter = { lat: result.latitude, lng: result.longitude };
  analysisCenterSource = "search";
  updateRadiusCircles();

  // 결과 목록은 접어두고, "검색 결과 지우기" 버튼을 표시
  el.searchResultsList.hidden = true;
  el.searchResetButton.hidden = false;

  // 3단계: 실제 필지 경계 조회 시도 (PNU가 검증되어 있으면 우선 사용, 없으면 좌표로 폴백)
  lookupAndShowRealParcel({
    pnu: result.pnu || null,
    longitude: result.longitude,
    latitude: result.latitude,
  });
}

function resetSearch() {
  el.searchInput.value = "";
  hideSearchStatus();
  el.searchResultsList.hidden = true;
  el.searchResultsList.innerHTML = "";
  el.searchResetButton.hidden = true;

  if (searchMarker) {
    map.removeLayer(searchMarker);
    searchMarker = null;
  }

  // 현재 분석 중심이 검색 위치 또는 그로부터 조회된 실제 필지였을 때만,
  // 관련 상태(패널/원/실제 필지 레이어)를 함께 초기화합니다.
  // (테스트 필지를 선택한 상태에서 검색만 지운 경우에는 필지 선택을 건드리지 않습니다.)
  if (analysisCenterSource === "search" || analysisCenterSource === "real_parcel") {
    analysisCenter = null;
    analysisCenterSource = null;

    isRadius500Visible = false;
    isRadius1000Visible = false;
    el.btnRadius500.classList.remove("active");
    el.btnRadius1000.classList.remove("active");
    updateRadiusCircles();

    clearRealParcelSelection();
    showEmptyInfoPanel();
  }
}

el.searchButton.addEventListener("click", performSearch);

el.searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    performSearch();
  }
});

el.searchResetButton.addEventListener("click", resetSearch);

/* ------------------------------------------------------------------ */
/* 3단계: 실제 VWorld 필지 경계 조회                                      */
/* ------------------------------------------------------------------ */

/** 현재 표시 중인 실제 필지 레이어/상태 메시지를 정리합니다 (지도에서 제거만 하고,
 * 다른 선택 상태(검색/테스트 필지)는 건드리지 않습니다). */
function clearRealParcelSelection() {
  if (realParcelLayer) {
    map.removeLayer(realParcelLayer);
    realParcelLayer = null;
  }
  hideParcelStatus();

  // 다중 필지 선택 상태도 함께 정리합니다(요청사항: 동일 PNU 중복 방지 등을 위해
  // "현재 선택"이 항상 하나의 상태로 일관되게 유지되어야 함) — clearRealParcelSelection이
  // 호출되는 모든 기존 지점(검색 초기화 등)에서 자동으로 함께 정리되도록 여기서 처리합니다.
  selectedParcels.clear();
  mergedParcelResult = null;
  if (individualParcelsLayer) {
    map.removeLayer(individualParcelsLayer);
    individualParcelsLayer = null;
  }
  if (typeof updateMultiParcelUI === "function") updateMultiParcelUI();

  // 4단계: 실제 필지 선택이 해제되면, 그에 딸린 건축물 분석도 함께 정리하고 버튼을 비활성화합니다.
  activeRealParcel = null;
  clearBuildingAnalysis();
  disableBuildingAnalysisButton();

  // 6.1단계: 대중교통 접근성 분석도 함께 정리합니다 (건축물 분석과 독립적으로 관리).
  clearTransitAnalysis();
  disableTransitAnalysisButton();

  // 6.2단계: 경계·접도 분석도 함께 정리합니다 (건축물/대중교통 분석과 독립적으로 관리).
  clearBoundaryAnalysis();
  disableBoundaryAnalysisButton();

  // 7.1단계: 일조·그림자 분석도 함께 정리합니다.
  clearShadowAnalysis();
  disableShadowAnalysisButton();

  // 7.2단계: 지형·표고 분석도 함께 정리합니다.
  clearTerrainAnalysis();
  disableTerrainAnalysisButton();

  // 7.3단계: 조망·시야 개방성 분석도 함께 정리합니다.
  clearVisibilityAnalysis();
  disableVisibilityAnalysisButton();

  // 7.4단계: 주변 환경 분석도 함께 정리합니다.
  clearEnvironmentAnalysis();
  disableEnvironmentAnalysisButton();

  // UI 간소화: 왼쪽 분석 메뉴도 비활성화하고, 선택 요약을 지우고, 기본정보 메뉴로 되돌립니다.
  setAllMenuItemsEnabled(false);
  resetAllMenuBadges();
  selectMenuItem("parcel-info");
  hideLeftSelectedSummary();
}

function showParcelStatus(message, kind) {
  el.parcelStatus.textContent = message;
  el.parcelStatus.hidden = false;
  el.parcelStatus.className = `search-status ${kind}`;
}

function hideParcelStatus() {
  el.parcelStatus.hidden = true;
  el.parcelStatus.textContent = "";
}

/**
 * HTTP 상태코드를 5가지 실패 원인으로 분류합니다(요청사항 8).
 * - 504: VWorld 응답 지연 (재시도를 다 쓴 뒤에도 실패)
 * - 401: 인증키 오류
 * - 429: 호출량 제한
 * - 404: 필지 데이터 없음
 * - 502(그 외 502/서비스 오류): 외부 서비스 장애
 */
const PARCEL_ERROR_CATEGORY_BY_STATUS = {
  504: { label: "VWorld 응답 지연", kind: "error" },
  401: { label: "인증키 오류", kind: "error" },
  429: { label: "호출량 제한", kind: "error" },
  404: { label: "필지 데이터 없음", kind: "empty" },
  502: { label: "외부 서비스 장애", kind: "error" },
};

function classifyParcelError(status, detail) {
  const category = PARCEL_ERROR_CATEGORY_BY_STATUS[status];
  if (category) {
    return { kind: category.kind, message: `[${category.label}] ${detail || category.label}` };
  }
  return { kind: "error", message: detail || "필지 조회 중 오류가 발생했습니다." };
}

/** /api/parcel-boundary를 호출합니다. pnu가 있으면 pnu 우선, 없으면 좌표를 사용합니다. */
async function fetchParcelBoundary({ pnu, longitude, latitude }, signal) {
  const params = new URLSearchParams();
  if (pnu) {
    params.set("pnu", pnu);
  } else {
    params.set("longitude", longitude);
    params.set("latitude", latitude);
  }

  const res = await fetch(`/api/parcel-boundary?${params.toString()}`, { signal });
  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const error = new Error(body.detail || "필지 조회 중 오류가 발생했습니다.");
    error.status = res.status;
    error.detail = body.detail;
    throw error;
  }

  return body; // { status: "success", parcel: {...} }
}

/**
 * 실제 필지를 조회해서 지도/패널에 반영하는 진입점.
 * - 검색 결과 선택, 지도 직접 클릭 두 경우 모두 이 함수를 통해 처리합니다.
 * - loadingMarkerLatLng가 주어지면(지도 클릭의 경우) 조회 중 임시 로딩 마커를 표시합니다.
 * - 연속 클릭 시 이전 요청은 AbortController로 취소하고 마지막 클릭만 반영합니다.
 * - 같은 좌표/PNU는 캐시에서 바로 반환해 VWorld를 다시 호출하지 않습니다.
 */
/**
 * @param {object} opts
 * @param {L.LatLng} [opts.loadingMarkerLatLng]
 * @param {boolean} [opts.additive] - true면 Shift+클릭(다중 선택에 추가/토글),
 *   false/생략이면 기존처럼 새 대상지로 완전히 교체합니다(요청사항 1).
 */
async function lookupAndShowRealParcel({ pnu, longitude, latitude }, { loadingMarkerLatLng, additive } = {}) {
  if (!additive) {
    // 일반 클릭: 진행 중이던 모든 요청(다중 선택용 추가 요청 포함)을 취소하고 완전히 새로 시작합니다.
    parcelLookupAbortControllers.forEach((c) => c.abort());
    parcelLookupAbortControllers.clear();
  }
  const controller = new AbortController();
  parcelLookupAbortControllers.add(controller);
  const requestId = ++parcelLookupRequestId;
  const signal = controller.signal;

  const cacheKey = _parcelCacheKey({ pnu, longitude, latitude });
  const cached = parcelBoundaryCache.get(cacheKey);
  if (cached) {
    hideParcelStatus();
    parcelLookupAbortControllers.delete(controller);
    if (additive) {
      await toggleParcelSelection(cached.parcel);
    } else {
      selectedParcels.clear();
      selectedParcels.set(_parcelSelectionKey(cached.parcel), cached.parcel);
      await refreshMergedSelection();
    }
    return;
  }

  let loadingMarker = null;
  if (loadingMarkerLatLng) {
    loadingMarker = L.circleMarker(loadingMarkerLatLng, {
      radius: 8,
      color: "#7f8c8d",
      weight: 2,
      fillColor: "#bdc3c7",
      fillOpacity: 0.6,
    }).addTo(map);
  }

  showParcelStatus(additive ? "필지 조회 중... (추가 선택)" : "필지 조회 중...", "loading");

  try {
    const body = await fetchParcelBoundary({ pnu, longitude, latitude }, signal);
    // 일반 클릭만 "최신 클릭인지" 검사합니다 — 추가 선택(Shift+클릭)은 서로를 대체하는
    // 관계가 아니라 누적되는 관계라, 늦게 끝나도 그대로 반영해야 합니다.
    if (!additive && requestId !== parcelLookupRequestId) return;
    parcelBoundaryCache.set(cacheKey, body);
    hideParcelStatus();
    if (additive) {
      await toggleParcelSelection(body.parcel);
    } else {
      selectedParcels.clear();
      selectedParcels.set(_parcelSelectionKey(body.parcel), body.parcel);
      await refreshMergedSelection();
    }
  } catch (err) {
    if (err.name === "AbortError") return; // 취소된 요청은 오류로 표시하지 않음
    if (!additive && requestId !== parcelLookupRequestId) return;
    console.error(err);
    const { kind, message } = classifyParcelError(err && err.status, err && err.detail);
    showParcelStatus(message, kind);
    // 오류가 발생해도 검색 마커/기존 선택 상태는 그대로 유지합니다 (지도 전체가 멈추지 않도록).
  } finally {
    parcelLookupAbortControllers.delete(controller);
    if (loadingMarker) {
      map.removeLayer(loadingMarker);
    }
  }
}

/** Shift+클릭: 이미 선택된 필지면 해당 필지만 선택 해제, 아니면 기존 선택을 유지한 채 추가합니다. */
async function toggleParcelSelection(parcel) {
  const key = _parcelSelectionKey(parcel);
  if (selectedParcels.has(key)) {
    selectedParcels.delete(key);
  } else {
    selectedParcels.set(key, parcel);
  }
  await refreshMergedSelection();
}

/** 개별 필지 목록의 삭제 버튼: 해당 필지 하나만 선택에서 제거합니다. */
async function removeParcelFromSelection(key) {
  selectedParcels.delete(key);
  await refreshMergedSelection();
}

/** '전체 해제' 버튼: 다중 선택을 전부 지웁니다. */
async function clearAllParcelSelections() {
  clearRealParcelSelection(); // selectedParcels/mergedParcelResult/individualParcelsLayer 전부 여기서 정리됨
}

/**
 * selectedParcels가 바뀔 때마다 호출: 백엔드 /api/parcel-boundary/merge로 병합하고,
 * 기존 activateRealParcel()이 그대로 쓸 수 있는 "가상 병합 필지" 객체를 만들어 넘깁니다.
 * (요청사항: 최소 범위 수정 — 다운스트림 분석 함수는 전혀 안 건드리고 그대로 재사용)
 */
async function refreshMergedSelection() {
  if (selectedParcels.size === 0) {
    clearRealParcelSelection(); // 다중 선택 상태 정리까지 여기서 전부 처리됨
    return;
  }

  const geometries = Array.from(selectedParcels.values()).map((p) => p.geometry);

  showParcelStatus("필지 병합 중...", "loading");
  try {
    const res = await fetch("/api/parcel-boundary/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ geometries }),
    });
    const body = await res.json().catch(() => ({}));

    if (!res.ok || body.status !== "success") {
      showParcelStatus(body.detail || "필지 병합에 실패했습니다.", "error");
      return;
    }

    hideParcelStatus();
    mergedParcelResult = body;

    // 요청사항: 구멍(선택에서 빠진 아주 작은 필지)을 백엔드가 자동으로 채워줬으면,
    // 프런트엔드의 selectedParcels도 그대로 반영합니다 — 안 그러면 다음 병합
    // 요청을 보낼 때 이 필지들이 빠진 채로 나가서 매번 같은 구멍이 또 생깁니다.
    if (body.auto_filled_parcels && body.auto_filled_parcels.length) {
      body.auto_filled_parcels.forEach((parcel) => {
        selectedParcels.set(_parcelSelectionKey(parcel), parcel);
      });
      console.info(`구멍 자동 채우기: ${body.auto_filled_parcels.length}개 필지 추가됨`);
    }

    const firstParcel = selectedParcels.values().next().value;
    const isSingle = selectedParcels.size === 1;
    const virtualParcel = {
      pnu: isSingle ? firstParcel.pnu : null,
      address: isSingle ? firstParcel.address : `${selectedParcels.size}개 필지 병합`,
      jibun: isSingle ? firstParcel.jibun : null,
      bonbun: isSingle ? firstParcel.bonbun : null,
      bubun: isSingle ? firstParcel.bubun : null,
      area_sqm: body.total_area_sqm,
      centroid: body.centroid,
      geometry: body.geometry,
      dataset: isSingle ? firstParcel.dataset : "다중 필지 병합",
    };

    activateRealParcel(virtualParcel); // 기존 단일 필지 파이프라인 그대로 재사용
    renderMultiParcelOverlay();
    updateMultiParcelUI();
  } catch (err) {
    console.error(err);
    showParcelStatus("필지 병합 중 네트워크 오류가 발생했습니다.", "error");
  }
}

/** 개별 필지 경계(얇게)를 병합 외곽선과 별도로 표시합니다(요청사항: 개별 경계도 확인 가능). */
function renderMultiParcelOverlay() {
  if (individualParcelsLayer) {
    map.removeLayer(individualParcelsLayer);
    individualParcelsLayer = null;
  }
  if (selectedParcels.size <= 1) return; // 1개면 병합 외곽선과 완전히 겹치므로 따로 안 그림

  const group = L.layerGroup();
  selectedParcels.forEach((parcel, key) => {
    const feature = { type: "Feature", properties: {}, geometry: parcel.geometry };
    L.geoJSON(feature, { style: () => INDIVIDUAL_PARCEL_STYLE }).eachLayer((layer) => {
      layer.on("click", (e) => {
        // ⚠️ 버그 수정(8.6단계에서 발견): 항상 stopPropagation만 하면 지도의 click
        // 핸들러(Shift+클릭 제외 로직)까지 이벤트가 전달되지 않아, 여러 필지가
        // 빽빽하게 선택된 상태에서는 Shift+클릭으로 개별 필지를 뺄 방법이 아예
        // 없었습니다.
        // (구역 선택 "검토 화면"에서는 이 레이어 대신 별도의 areaGridLayer가
        // 쓰이므로, 여기는 평소의 Shift+클릭 토글만 처리합니다.)
        L.DomEvent.stopPropagation(e);
        if (e.originalEvent && e.originalEvent.shiftKey) {
          toggleParcelSelection(parcel);
        }
      });
      group.addLayer(layer);
    });
  });
  individualParcelsLayer = group.addTo(map);
}

/** 다중 선택 UI(선택 수, PNU/지번 목록, 총면적, 떨어진 필지 경고)를 갱신합니다. */
function updateMultiParcelUI() {
  const count = selectedParcels.size;

  if (!el.multiParcelPanel) return; // HTML에 아직 안 붙어있으면 조용히 무시(방어적)

  el.multiParcelPanel.hidden = count === 0;
  if (count === 0) {
    // 선택이 비면 개발검토 Workspace도 같이 닫음(js/dev-workspace.js)
    if (typeof closeDevelopmentWorkspace === "function") closeDevelopmentWorkspace();
    return;
  }

  el.multiParcelCount.textContent = `선택 필지: ${count}개`;
  el.multiParcelTotalArea.textContent =
    mergedParcelResult && mergedParcelResult.total_area_sqm != null
      ? `${mergedParcelResult.total_area_sqm.toLocaleString("ko-KR")} m²`
      : "-";
  el.multiParcelDisjointWarning.hidden = !(mergedParcelResult && mergedParcelResult.is_disjoint);

  // 요청사항: 필지를 누를 때마다 바로 사업성 패널이 뜨지 않게 — 총 대지면적/지번
  // 목록(위에서 이미 갱신)만 즉시 보여주고, "사업성 및 사업내용 보기" 버튼을
  // 한 번 더 눌러야 아래 무거운 패널이 열립니다. 이미 열려 있는 상태에서 선택이
  // 바뀌면(필지 추가/제거) 내용만 최신화합니다.
  if (el.btnShowFeasibility) el.btnShowFeasibility.hidden = false;
  if (feasibilityPanelOpen) renderFeasibilityPanel();

  el.multiParcelList.innerHTML = "";
  selectedParcels.forEach((parcel, key) => {
    const li = document.createElement("li");
    li.className = "multi-parcel-item";

    const label = document.createElement("span");
    label.className = "multi-parcel-item-label";
    label.textContent = parcel.jibun || parcel.pnu || parcel.address || "필지";
    li.appendChild(label);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "multi-parcel-item-delete";
    delBtn.textContent = "✕";
    delBtn.title = "이 필지 선택 해제";
    delBtn.addEventListener("click", () => removeParcelFromSelection(key));
    li.appendChild(delBtn);

    el.multiParcelList.appendChild(li);
  });

  _positionMultiParcelPanel(); // "대상지 기본정보" 카드 아래에 겹치지 않게 위치 재계산
}

/* ------------------------------------------------------------------ */
/* 8.8단계: 사업성 및 사업내용 패널                                         */
/* ------------------------------------------------------------------ */

/** 현재 라디오 선택(공시지가 ×1/×2)을 읽습니다. */
function getFsJigaMultiplier() {
  const checked = document.querySelector('input[name="fs-jiga-mult"]:checked');
  return checked ? Number(checked.value) : 1;
}

/**
 * 선택된 필지들의 개별공시지가(jiga_per_sqm, 8.7단계에서 노출)를 합산합니다.
 * 값이 없는 필지는 0원으로 취급하지 않고 합계에서 제외합니다(요청사항: 추정치
 * 날조 금지 — missing으로 별도 집계해 UI에서 안내).
 */
function computeLandValueTotals(multiplier) {
  let sum = 0;
  let sumArea = 0;
  let missing = 0;
  let latestDate = null;
  selectedParcels.forEach((p) => {
    if (p.jiga_per_sqm != null && p.area_sqm != null) {
      sum += p.jiga_per_sqm * multiplier * p.area_sqm;
      sumArea += p.area_sqm;
      if (p.jiga_gosi_date && (!latestDate || p.jiga_gosi_date > latestDate)) {
        latestDate = p.jiga_gosi_date;
      }
    } else {
      missing += 1;
    }
  });
  return { sum, sumArea, missing, latestDate };
}

/**
 * 큰 원화 금액을 "133억 7,329만" 같은 한국식 축약 표기로 바꿉니다(요청사항: 자릿수가
 * 많은 원 단위만으로는 한눈에 감이 안 와서, 괄호로 억/만 단위를 같이 보여달라고 함).
 * 억/만 단위가 전혀 없는 작은 금액(1만원 미만)은 null을 반환해 괄호를 아예 안 붙입니다.
 */
function formatKoreanShort(n) {
  if (n == null || !isFinite(n)) return null;
  const sign = n < 0 ? "-" : "";
  const abs = Math.round(Math.abs(n));
  const eok = Math.floor(abs / 1e8);
  const man = Math.floor((abs % 1e8) / 1e4);
  if (eok === 0 && man === 0) return null;
  const parts = [];
  if (eok > 0) parts.push(`${eok.toLocaleString("ko-KR")}억`);
  if (man > 0) parts.push(`${man.toLocaleString("ko-KR")}만`);
  return `${sign}${parts.join(" ")}`;
}

function formatWon(n) {
  if (n == null || !isFinite(n)) return "-";
  const full = `${Math.round(n).toLocaleString("ko-KR")}원`;
  const short = formatKoreanShort(n);
  return short ? `${full} (${short}원)` : full;
}

function formatWonPerSqm(n) {
  if (n == null || !isFinite(n)) return "-";
  const full = `${Math.round(n).toLocaleString("ko-KR")}원/m²`;
  const short = formatKoreanShort(n);
  return short ? `${full} (${short}원/m²)` : full;
}

/**
 * "선택 필지" 카드(.multi-parcel-panel)는 "대상지 기본정보"(.right-panel)와 완전히
 * 분리된 카드지만, 겹치지 않게 그 바로 아래에 붙입니다. 오른쪽 카드는 내용에 따라
 * 키가 조금씩 바뀌고(안내문 표시 여부 등), 사업성 패널이 열리면 왼쪽으로 밀리기도
 * 하므로, 매번 오른쪽 카드의 실제 위치를 읽어서 맞춥니다. 태블릿/모바일에서는
 * CSS 미디어 쿼리가 화면 아래 쌓기로 처리하므로 인라인 스타일을 지워 비활성화합니다.
 */
function _positionMultiParcelPanel() {
  if (!el.multiParcelPanel || !el.rightPanel) return;
  const isDesktopWidth = window.innerWidth > 900;
  if (!isDesktopWidth) {
    el.multiParcelPanel.style.top = "";
    el.multiParcelPanel.style.left = "";
    el.multiParcelPanel.style.maxHeight = "";
    return;
  }
  const rightRect = el.rightPanel.getBoundingClientRect();
  const top = Math.round(rightRect.bottom + 12);
  el.multiParcelPanel.style.top = `${top}px`;
  el.multiParcelPanel.style.left = getComputedStyle(el.rightPanel).left;
  el.multiParcelPanel.style.maxHeight = `calc(100vh - ${top + 12}px)`;
}

// 요청사항: 필지를 클릭할 때마다 곧바로 사업성 패널이 뜨면 번거로우므로, "선택됨"
// 상태와 "패널을 열어보기로 함" 상태를 분리합니다. 총 대지면적/지번 목록(가벼운
// 요약, multi-parcel-panel)은 선택 즉시 보여주고, 이 무거운 패널은
// "사업성 및 사업내용 보기" 버튼을 눌러야만 열립니다.
let feasibilityPanelOpen = false;

// 8.9단계: 기준 용적률 자동 입력(용도지역 조회) 관련 상태.
let fsFarBaseUserEdited = false; // 사용자가 직접 입력창을 고치면 true — 이후엔 자동 입력이 덮어쓰지 않음
let fsZoneLookupKey = null; // 마지막으로 조회한 선택 필지 조합(PNU 목록) — 바뀔 때만 재조회

function _selectedParcelsLookupKey() {
  return Array.from(selectedParcels.keys()).sort().join(",");
}

/**
 * 선택된 필지들의 중심 좌표로 용도지역을 조회하고, 모두 같은 용도지역이면
 * 참고표(backend/data/seoul_far_by_zone.json, 조례 개정 시 그 파일만 갱신하면 됨)에서
 * 기준 용적률을 찾아 입력창에 채웁니다. 용도지역이 섞여 있으면 자동 입력하지 않고
 * 안내만 하고(추측 금지), 사용자가 이미 직접 값을 입력했다면 덮어쓰지 않습니다.
 * 조회 실패는 조용히 무시합니다 — 수동 입력은 항상 가능하므로 패널 사용을 막지 않음.
 */
async function fetchAndApplyZoneFar() {
  if (!el.fsZoneNote) return;
  const parcels = Array.from(selectedParcels.values()).filter((p) => p.centroid);
  if (parcels.length === 0) {
    el.fsZoneNote.hidden = true;
    return;
  }

  const MAX_LOOKUPS = 20; // 남용 방지 — 필지가 아주 많으면 앞쪽 일부만 확인
  const sample = parcels.slice(0, MAX_LOOKUPS);

  let results;
  try {
    results = await Promise.all(
      sample.map((p) =>
        fetch(`/api/zoning/point-zone?lon=${p.centroid.longitude}&lat=${p.centroid.latitude}`)
          .then((res) => (res.ok ? res.json() : null))
          .catch(() => null)
      )
    );
  } catch {
    return; // 네트워크 오류는 조용히 무시(수동 입력은 그대로 가능)
  }

  const zoneNames = new Set(results.filter((r) => r && r.zone_name).map((r) => r.zone_name));
  if (zoneNames.size === 0) {
    el.fsZoneNote.hidden = true;
    return;
  }

  if (zoneNames.size > 1) {
    el.fsZoneNote.hidden = false;
    el.fsZoneNote.textContent =
      `※ 선택 범위에 여러 용도지역(${Array.from(zoneNames).join(", ")})이 섞여 있어 기준 ` +
      `용적률을 자동 입력하지 않았습니다. 직접 확인해 입력하세요.`;
    return;
  }

  const zoneName = Array.from(zoneNames)[0];
  const matched = results.find((r) => r && r.zone_name === zoneName);
  const baseFar = matched ? matched.base_far_percent : null;
  const source = matched ? matched.far_reference_source : null;
  const lastVerified = matched ? matched.far_reference_last_verified : null;

  el.fsZoneNote.hidden = false;
  if (baseFar != null) {
    if (!fsFarBaseUserEdited && !el.fsFarBase.value) {
      el.fsFarBase.value = baseFar;
      recomputeFeasibilityFar();
    }
    el.fsZoneNote.textContent =
      `※ ${zoneName} 기준 용적률 ${baseFar}% 자동 참고 입력됨(${source || "참고표"}, ` +
      `${lastVerified || "확인일 미기재"} 기준) — 최신 조례와 다를 수 있으니 반드시 재확인하세요.`;
  } else {
    el.fsZoneNote.textContent = `※ 이 필지는 '${zoneName}'입니다 — 참고표에 없어 기준 용적률을 자동 입력하지 못했습니다. 직접 입력하세요.`;
  }
}

// ⚠️ UI 개편(STEP1/STEP2 분리)으로 openFeasibilityPanel()/closeFeasibilityPanel()은
// js/dev-workspace.js의 openDevelopmentWorkspace()/closeDevelopmentWorkspace()로
// 대체되었습니다. feasibilityPanelOpen 플래그와 아래 renderFeasibilityPanel()의
// 계산·채우기 로직은 그대로 재사용합니다(dev-workspace.js가 이 함수를 호출).

/** 워크스페이스가 열려 있는 동안 선택이 바뀔 때마다 내용을 다시 계산해 채웁니다. */
function renderFeasibilityPanel() {
  if (!feasibilityPanelOpen || selectedParcels.size === 0 || !mergedParcelResult) {
    if (typeof closeDevelopmentWorkspace === "function") closeDevelopmentWorkspace();
    return;
  }

  // 8.9단계: 선택한 필지 조합이 지난번과 다르면 용도지역을 다시 조회해 기준
  // 용적률 자동 입력을 갱신합니다(공시지가 ×1/×2 토글 등 다른 재계산에서는
  // 매번 다시 조회하지 않도록 조합이 실제로 바뀌었을 때만 실행).
  const zoneLookupKey = _selectedParcelsLookupKey();
  if (zoneLookupKey !== fsZoneLookupKey) {
    fsZoneLookupKey = zoneLookupKey;
    fetchAndApplyZoneFar();
  }

  // A. 대상지 개요
  el.fsParcelCount.textContent = `${selectedParcels.size}개`;
  el.fsTotalArea.textContent =
    mergedParcelResult.total_area_sqm != null
      ? `${mergedParcelResult.total_area_sqm.toLocaleString("ko-KR")} m²`
      : "-";

  const addresses = Array.from(selectedParcels.values())
    .map((p) => p.address)
    .filter(Boolean);
  // "서울특별시 강남구 역삼동 646-13" 형태에서 앞 3토큰(시/구/동)만 뽑아 중복 제거
  const regionSet = new Set(addresses.map((a) => a.split(" ").slice(0, 3).join(" ")).filter(Boolean));
  el.fsLocation.textContent = regionSet.size ? Array.from(regionSet).join(", ") : "-";

  el.fsJibunList.innerHTML = "";
  Array.from(selectedParcels.values()).forEach((p) => {
    const li = document.createElement("li");
    li.textContent = p.jibun || p.address || p.pnu || "-";
    el.fsJibunList.appendChild(li);
  });

  // B. 토지가치
  const mult = getFsJigaMultiplier();
  const { sum, sumArea, missing, latestDate } = computeLandValueTotals(mult);
  el.fsLandValueTotal.textContent = sum > 0 ? formatWon(sum) : "-";
  el.fsLandValueAvg.textContent = sum > 0 && sumArea > 0 ? formatWonPerSqm(sum / sumArea) : "-";
  el.fsJigaDate.textContent = latestDate || "-";
  el.fsJigaMissingNote.hidden = missing === 0;

  // C/D. 용적률·공공기여 계산 + E. 요약문
  recomputeFeasibilityFar();
}

/**
 * 숫자 입력칸 하나를 읽습니다 — "비어 있음"과 "0을 입력함"을 구분하는 것이 핵심입니다.
 * parseFloat(...) || 0으로 뭉뚱그리면 "현금 기여를 안 했다"와 "현금 기여액을 아직
 * 안 적었다"가 같은 0이 되어, 빠진 입력이 있는데도 정상 결과처럼 보입니다.
 */
function _fsReadNumber(input) {
  const raw = input && typeof input === "object" && "value" in input ? input.value : input;
  return _fsParseNumber(raw);
}

/** 문자열 하나를 읽습니다 — "비어 있음"과 "0을 입력함"을 구분하는 것이 핵심입니다. */
function _fsParseNumber(raw) {
  const t = String(raw == null ? "" : raw).trim();
  if (t === "") return { entered: false, value: null, invalid: false };
  const v = Number(t);
  if (!isFinite(v)) return { entered: true, value: null, invalid: true };
  if (v < 0) return { entered: true, value: v, invalid: true };
  return { entered: true, value: v, invalid: false };
}

// 수단을 "쓰지 않음"(합계에 0으로 반영 가능)을 나타내는 표식. null(미산정)과 다릅니다.
const FS_UNUSED = "unused";

const FS_INPUT_LABELS = {
  farBase: "기준 용적률",
  farAllowed: "계획한 허용 용적률",
  farFormula: "산식 적용 허용(기준)용적률",
  landArea: "토지 기부채납 면적",
  cash: "현금 기부채납액",
  siteValue: "부지가액",
  wLand: "토지 가중치",
};

/**
 * 건축물 기부채납 시설 하나(별표1처럼 시설마다 계수가 다를 수 있는 항목)를
 * 계산합니다 — DOM에 의존하지 않는 순수 함수. `profile`이 없거나 이 시설이
 * 고른 계수가 프로필의 허용 목록에 없으면 미산정으로 반환합니다.
 */
function _fsComputeFacility(facility, siteValue, profile) {
  const above = _fsParseNumber(facility ? facility.aboveArea : "");
  const below = _fsParseNumber(facility ? facility.belowArea : "");
  const landShare = _fsParseNumber(facility ? facility.landShareArea : "");
  const costAbove = _fsParseNumber(facility ? facility.costAbove : "");
  const costBelow = _fsParseNumber(facility ? facility.costBelow : "");
  const coeffRaw = facility ? facility.coefficient : "";
  const label = (facility && facility.facilityType) || "이름 없는 시설";

  const invalidFields = [above, below, landShare, costAbove, costBelow].filter((p) => p.invalid);
  if (invalidFields.length) {
    return { empty: false, unresolved: true, landShareArea: null, convertedSite: null, coefficient: null, weightedConvertedSite: null, reason: `건축물 시설 "${label}"의 입력값이 올바르지 않습니다(음수 또는 숫자 아님).` };
  }

  const aboveUsed = above.entered && above.value > 0;
  const belowUsed = below.entered && below.value > 0;
  const landShareEntered = landShare.entered && landShare.value != null;
  if (!aboveUsed && !belowUsed && !landShareEntered) {
    return { empty: true, unresolved: false, landShareArea: FS_UNUSED, convertedSite: FS_UNUSED, coefficient: null, weightedConvertedSite: FS_UNUSED, reason: null };
  }

  // 대지지분은 이 시설이 직접 기여하는 몫이 없으면(예: 토지가 별도 토지 기부채납
  // 항목으로 이미 계상됨) 정당하게 0일 수 있습니다 — 비워두면 0으로 둡니다.
  const need = [];
  if (!profile) need.push("계산 프로필");
  if (!coeffRaw) need.push("건축물계수");
  if (profile && coeffRaw && !profile.building_coefficient_options.some((o) => String(o.value) === String(coeffRaw))) {
    need.push("건축물계수(선택한 값이 이 프로필에서 허용되지 않음)");
  }
  if (aboveUsed && (!costAbove.entered || costAbove.invalid)) need.push("지상단가");
  if (belowUsed && (!costBelow.entered || costBelow.invalid)) need.push("지하단가");
  if ((aboveUsed || belowUsed) && !siteValue) need.push("부지가액");

  if (need.length) {
    return {
      empty: false,
      unresolved: true,
      landShareArea: null,
      convertedSite: null,
      coefficient: null,
      weightedConvertedSite: null,
      reason: `건축물 시설 "${label}"에 다음 값이 없어 산정할 수 없습니다 — ${need.join(", ")}`,
    };
  }

  const coefficient = Number(coeffRaw);
  const convertedSite = siteValue ? ((aboveUsed ? above.value : 0) * costAbove.value + (belowUsed ? below.value : 0) * costBelow.value) / siteValue : 0;
  return {
    empty: false,
    unresolved: false,
    landShareArea: landShareEntered ? landShare.value : 0,
    convertedSite,
    coefficient,
    weightedConvertedSite: coefficient * convertedSite,
    reason: null,
  };
}

/**
 * 공공기여 계산 엔진 — **DOM에 의존하지 않는 순수 함수**입니다.
 * 같은 함수를 OP마다 서로 다른 입력으로 호출할 수 있어야 하므로, 전역 입력칸을
 * 읽던 부분을 인자로 분리했습니다.
 *
 * 「공공시설등 기부채납 용적률 인센티브 운영기준」(서울특별시, 2025-03-18 일부개정,
 * 행정2부시장방침 제71호) 3-1-1./3-1-3./3-1-4./1-3-3.~1-3-6.을 그대로 옮긴 식입니다
 * (docs/기부채납_공식기준_대조보고_20260918.md, docs/기부채납_계산프로필_적용_20260918.md 참고):
 *   공공시설 등 부지제공 후 대지면적 R = 구역면적 − 토지 기부채납 − 건축물 기부채납 대지지분 합
 *   시설별 건축물 환산부지 = (지상연면적×지상단가 + 지하연면적×지하단가) ÷ 부지가액
 *   현금 환산부지   = 현금 ÷ 부지가액
 *   α토지   = (토지 기부채납 + Σ시설별 대지지분) ÷ R
 *   α현금   = 현금 환산부지 ÷ R
 *   상한용적률 = 계획한 허용용적률 + 산식 적용 허용(기준)용적률 ×
 *                (1.3 × 토지 가중치 × α토지 + Σ(시설별 건축물계수 × 시설별 환산부지 ÷ R) + 현금계수 × α현금)
 *
 * 건축물 항목은 `raw.buildingFacilities`(배열)로 받습니다 — 별표1 예시처럼 시설마다
 * 계수가 다를 수 있어, 한 OP 전체에 평균계수 하나를 곱하지 않고 시설별로 각자의
 * 계수를 곱한 뒤 합산합니다. 1.3(토지계수)·현금계수는 `profile`
 * (frontend/js/contribution-calc-profiles.js)에서 가져오고, 넘기지 않으면 상한용적률을
 * 미산정으로 둡니다. 부지가액도 `ctx.siteValueMethodSelected`가 false면(부지가액
 * 산정방식을 고르지 않음) 건축물·현금 환산을 하지 않습니다. 부지가액·시설별 단가·
 * 대지지분·토지 가중치는 고정 기본값이 없습니다 — 전부 사용자가 직접 입력해야
 * 계산됩니다(운영기준 3-4-1., 3-2-3., 1-3-3., 1-3-6. — 사례마다 다른 값이라 자동으로
 * 정할 수 없음).
 *
 * 세 가지 상태를 구분합니다:
 *   FS_UNUSED — 그 수단을 쓰지 않음(입력칸 비어 있음). 합계에 0으로 더해도 됨
 *   null      — 그 수단을 쓰는데 필요한 값이 없음. 합계·상한까지 미산정으로 전파
 *   숫자      — 계산됨
 */
function computeContributionFar(ctx, raw) {
  const reasons = [];
  const totalArea = ctx && ctx.totalArea != null ? ctx.totalArea : null;
  const areaOk = totalArea != null && totalArea > 0;
  if (!areaOk) reasons.push("구역면적(선택 필지 합계)이 확인되지 않았습니다 — 대상지를 선택하세요.");

  const f = {};
  Object.keys(FS_INPUT_LABELS).forEach((k) => {
    f[k] = _fsParseNumber(raw ? raw[k] : "");
    if (f[k].invalid) reasons.push(FS_INPUT_LABELS[k] + " 입력값이 올바르지 않습니다(음수 또는 숫자 아님).");
  });
  const numeric = (p) => (p === FS_UNUSED ? 0 : p);

  const siteValueMethod = raw && raw.siteValueMethod ? raw.siteValueMethod : "";
  const siteValue = siteValueMethod && f.siteValue.entered && !f.siteValue.invalid && f.siteValue.value > 0 ? f.siteValue.value : null;
  if (!siteValueMethod && areaOk) {
    reasons.push("부지가액 산정방식을 선택하지 않았습니다 — 건축물·현금 환산부지를 산정하려면 방식을 먼저 고르세요(운영기준 3-4-1.~3-4-3.).");
  } else if (siteValueMethod && !siteValue && areaOk) {
    reasons.push("부지가액을 입력하지 않았습니다 — 선택한 방식으로 산정한 값을 직접 입력하세요.");
  }

  // 토지 기부채납 — 면적 그대로가 α토지의 분자 일부입니다.
  let landShare; // ㎡
  if (!f.landArea.entered) {
    landShare = FS_UNUSED;
  } else if (f.landArea.invalid || !areaOk) {
    landShare = null;
  } else {
    landShare = f.landArea.value;
  }

  const profile = ctx && ctx.profile ? ctx.profile : null;

  // 건축물 기부채납 — 시설별로 계산해 합산합니다(별표1: 시설마다 계수가 다름).
  const facilities = (raw && Array.isArray(raw.buildingFacilities) ? raw.buildingFacilities : [])
    .map((facility) => _fsComputeFacility(facility, siteValue, profile))
    .filter((r) => !r.empty);
  const facilityUnresolved = facilities.some((r) => r.unresolved);
  facilities.forEach((r) => {
    if (r.reason) reasons.push(r.reason);
  });
  let bldgLandShareTotal = null;
  let bldgConvertedSiteTotal = null; // 표시용(가중치 적용 전)
  let bldgWeightedTotal = null; // Σ(계수×환산부지), 산식에 바로 씀
  if (facilities.length === 0) {
    bldgLandShareTotal = FS_UNUSED;
    bldgConvertedSiteTotal = FS_UNUSED;
    bldgWeightedTotal = FS_UNUSED;
  } else if (facilityUnresolved) {
    bldgLandShareTotal = null;
    bldgConvertedSiteTotal = null;
    bldgWeightedTotal = null;
  } else {
    bldgLandShareTotal = facilities.reduce((s, r) => s + numeric(r.landShareArea), 0);
    bldgConvertedSiteTotal = facilities.reduce((s, r) => s + numeric(r.convertedSite), 0);
    bldgWeightedTotal = facilities.reduce((s, r) => s + numeric(r.weightedConvertedSite), 0);
  }

  // 현금 기부채납 — 환산부지(운영기준 1-3-4.).
  let cashSite; // ㎡
  const cashUsed = f.cash.entered && !f.cash.invalid && f.cash.value > 0;
  if (!f.cash.entered) {
    cashSite = FS_UNUSED;
  } else if (f.cash.invalid || !areaOk) {
    cashSite = null;
  } else if (!cashUsed) {
    cashSite = 0;
  } else if (!siteValue) {
    cashSite = null;
    reasons.push("현금 기부채납액을 입력했지만 부지가액이 없어 현금 환산부지를 산정할 수 없습니다.");
  } else {
    cashSite = f.cash.value / siteValue;
  }

  const allParts = [landShare, bldgLandShareTotal, bldgConvertedSiteTotal, cashSite];
  const anyUnresolved = allParts.some((p) => p === null);
  const allUnused = allParts.every((p) => p === FS_UNUSED);

  // 표시용 3분류(참고, 분모는 총 구역면적) — "총 공공기여율" 지표에만 씁니다.
  const landPct = landShare === FS_UNUSED ? FS_UNUSED : landShare != null && areaOk ? landShare / totalArea : landShare;
  let bldgPct;
  if (bldgLandShareTotal === FS_UNUSED && bldgConvertedSiteTotal === FS_UNUSED) bldgPct = FS_UNUSED;
  else if (bldgLandShareTotal == null || bldgConvertedSiteTotal == null) bldgPct = null;
  else bldgPct = areaOk ? (numeric(bldgLandShareTotal) + numeric(bldgConvertedSiteTotal)) / totalArea : null;
  const cashPct = cashSite === FS_UNUSED ? FS_UNUSED : cashSite != null && areaOk ? cashSite / totalArea : cashSite;

  let totalPct = null;
  if (!anyUnresolved && areaOk && !allUnused) {
    totalPct = (numeric(landShare) + numeric(bldgLandShareTotal) + numeric(bldgConvertedSiteTotal) + numeric(cashSite)) / totalArea;
  } else if (allUnused && areaOk) {
    reasons.push("공공기여 수단이 아직 입력되지 않았습니다 — 토지·건축물·현금 중 하나 이상을 입력하세요.");
  }

  // 상한용적률 — 계산 프로필(사업유형별 토지·현금 계수)을 선택하지 않으면
  // 운영기준이 요구하는 계수를 알 수 없어 미산정으로 남깁니다.
  let relief = null;
  let computedCap = null;
  if (!profile) {
    reasons.push("계산 프로필을 선택하지 않아 상한용적률을 계산하지 않습니다 — 공공기여 계산 프로필에서 사업유형을 고르세요.");
  }
  if (!f.wLand.entered && areaOk) reasons.push(FS_INPUT_LABELS.wLand + "가 비어 있어 상한용적률을 산정할 수 없습니다(제공부지 허용용적률 ÷ 사업부지 허용용적률).");
  if (!f.farAllowed.entered && areaOk) reasons.push(FS_INPUT_LABELS.farAllowed + "이 비어 있어 상한용적률을 산정할 수 없습니다.");
  if (!f.farFormula.entered && areaOk) reasons.push(FS_INPUT_LABELS.farFormula + "이 비어 있어 상한용적률을 산정할 수 없습니다.");

  if (!anyUnresolved && areaOk && !allUnused && profile) {
    const landShareTotal = numeric(landShare) + numeric(bldgLandShareTotal);
    const residualArea = totalArea - landShareTotal;
    if (residualArea <= 0) {
      reasons.push("기여로 제공하는 토지 면적(건축물 기부채납의 대지지분 합 포함)이 구역면적 이상입니다 — 잔여 사업부지가 없어 산정할 수 없습니다.");
    } else if (
      f.wLand.entered && !f.wLand.invalid &&
      f.farAllowed.entered && !f.farAllowed.invalid &&
      f.farFormula.entered && !f.farFormula.invalid
    ) {
      const alphaLand = landShareTotal / residualArea;
      const bldgWeightedTerm = numeric(bldgWeightedTotal) / residualArea;
      const alphaCash = numeric(cashSite) / residualArea;
      relief =
        f.farFormula.value *
        (profile.land_coefficient * f.wLand.value * alphaLand + bldgWeightedTerm + profile.cash_coefficient * alphaCash);
      computedCap = f.farAllowed.value + relief;
    }
  }

  let floorBase = null;
  let floorCap = null;
  let floorIncrease = null;
  if (areaOk && f.farBase.entered && !f.farBase.invalid && f.farBase.value != null) {
    floorBase = totalArea * (f.farBase.value / 100);
  }
  if (areaOk && computedCap != null) floorCap = totalArea * (computedCap / 100);
  if (floorBase != null && floorCap != null) floorIncrease = floorCap - floorBase;

  return {
    landPct,
    bldgPct,
    cashPct,
    totalPct,
    relief,
    computedCap,
    floorBase,
    floorCap,
    floorIncrease,
    reasons: Array.from(new Set(reasons)),
  };
}

/** 표시용 포맷터 — OP 비교표와 상세 패널이 같은 표기를 쓰도록 공유합니다. */
function fsFormatPct(v) {
  if (v === FS_UNUSED) return "선택 안 함";
  if (v == null) return "미산정";
  return (v * 100).toLocaleString("ko-KR", { maximumFractionDigits: 2 }) + "%";
}
function fsFormatFar(v) {
  return v != null ? v.toLocaleString("ko-KR", { maximumFractionDigits: 1 }) + "%" : "미산정";
}
function fsFormatArea(v) {
  return v != null ? v.toLocaleString("ko-KR", { maximumFractionDigits: 1 }) + " m²" : "미산정";
}

/**
 * 선택 필지의 개별공시지가 완성도(평균값·누락 필지 수)만 알려줍니다 — 공공기여
 * 계산(부지가액)과는 분리된, "이 대상지에 공시지가 데이터가 얼마나 있는지"를
 * 보여주는 일반 완성도 지표입니다(dev-workspace.js/dev-dashboard.js가 사용).
 */
function fsJigaCompleteness() {
  const totals = computeLandValueTotals(1);
  const jigaAvg = totals.sum > 0 && totals.sumArea > 0 ? totals.sum / totals.sumArea : null;
  return { jigaAvg, jigaMissingCount: totals.missing };
}

/** 현재 선택 필지에서 계산 컨텍스트(구역면적·계산 프로필)를 만듭니다. */
function fsBuildContext() {
  const totalArea = mergedParcelResult ? mergedParcelResult.total_area_sqm : null;
  const profileId = el.fsCalcProfile ? el.fsCalcProfile.value : "";
  const profile = profileId && typeof getContributionCalcProfile === "function" ? getContributionCalcProfile(profileId) : null;
  return { totalArea, profile };
}

/** 선택된 프로필에 맞춰 출처 문구를 갱신하고, 이미 있는 시설 행들의 계수 선택지를 새로고칩니다. */
function fsRenderProfileControls() {
  if (!el.fsCalcProfile || typeof CONTRIBUTION_CALC_PROFILES === "undefined") return;
  if (!el.fsCalcProfile.dataset.filled) {
    CONTRIBUTION_CALC_PROFILES.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.profile_id;
      opt.textContent = p.label;
      el.fsCalcProfile.appendChild(opt);
    });
    el.fsCalcProfile.dataset.filled = "1";
  }

  const profile = getContributionCalcProfile(el.fsCalcProfile.value);
  if (el.fsProfileSource) {
    if (!profile) {
      el.fsProfileSource.textContent =
        "※ 사업유형에 맞는 프로필을 고르면 토지·현금 계수와 적용 조문이 여기 표시됩니다. 프로필을 고르지 않으면 상한용적률은 계산되지 않습니다.";
    } else {
      el.fsProfileSource.textContent =
        `※ 출처: ${profile.source} / 적용 범위: ${profile.applicability_conditions} / ` +
        `토지계수 ${profile.land_coefficient}·현금계수 ${profile.cash_coefficient} 고정 적용 / 확인 상태: ${profile.verification_status}`;
    }
  }
  fsRefreshAllFacilityCoeffOptions(profile);
}

/* ------------------------------------------------------------------ */
/* 건축물 기부채납 시설 목록 — 시설마다 계수가 다를 수 있어(별표1), OP당 하나의            */
/* 값이 아니라 행을 여러 개 두는 목록으로 관리합니다.                                     */
/* ------------------------------------------------------------------ */

/** 시설 하나의 입력 행을 만듭니다. 계수 <select>는 현재 선택된 프로필로 채웁니다. */
function fsCreateFacilityRow(facility) {
  facility = facility || {};
  const wrap = document.createElement("div");
  wrap.className = "fs-facility-row";
  wrap.innerHTML = `
    <label>시설유형<input type="text" class="fs-fac-type" placeholder="예: 공공청사" /></label>
    <label>지상연면적(㎡)<input type="number" class="fs-fac-above" min="0" step="1" /></label>
    <label>지하연면적(㎡)<input type="number" class="fs-fac-below" min="0" step="1" placeholder="없으면 0" /></label>
    <label>대지지분(㎡)<input type="number" class="fs-fac-land" min="0" step="1" placeholder="계획 단계 예측값 직접 입력" /></label>
    <label>지상단가(원/㎡)<input type="number" class="fs-fac-cost-above" min="0" step="1" placeholder="3-2-3 확인 후 입력" /></label>
    <label>지하단가(원/㎡)<input type="number" class="fs-fac-cost-below" min="0" step="1" placeholder="3-2-3 확인 후 입력" /></label>
    <label>건축물계수<select class="fs-fac-coeff"><option value="">계산 프로필을 먼저 선택하세요</option></select></label>
    <button type="button" class="fs-fac-remove dw-ghost-btn">시설 삭제</button>
  `;
  wrap.querySelector(".fs-fac-type").value = facility.facilityType || "";
  wrap.querySelector(".fs-fac-above").value = facility.aboveArea || "";
  wrap.querySelector(".fs-fac-below").value = facility.belowArea || "";
  wrap.querySelector(".fs-fac-land").value = facility.landShareArea || "";
  wrap.querySelector(".fs-fac-cost-above").value = facility.costAbove || "";
  wrap.querySelector(".fs-fac-cost-below").value = facility.costBelow || "";
  wrap.dataset.pendingCoeff = facility.coefficient != null ? String(facility.coefficient) : "";
  return wrap;
}

/** 시설 행 하나의 계수 <select>를 지금 프로필의 선택지로 다시 채웁니다(이전 선택값 유지 시도). */
function fsRefreshFacilityCoeffOptions(row, profile) {
  const select = row.querySelector(".fs-fac-coeff");
  if (!select) return;
  const prevValue = select.dataset.filled ? select.value : row.dataset.pendingCoeff || "";
  select.innerHTML = "";
  if (!profile) {
    select.disabled = true;
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "계산 프로필을 먼저 선택하세요";
    select.appendChild(opt);
    return;
  }
  select.disabled = false;
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "선택하세요";
  select.appendChild(placeholder);
  profile.building_coefficient_options.forEach((o) => {
    const opt = document.createElement("option");
    opt.value = String(o.value);
    opt.textContent = o.label;
    select.appendChild(opt);
  });
  if (profile.building_coefficient_options.some((o) => String(o.value) === prevValue)) {
    select.value = prevValue;
  }
  select.dataset.filled = "1";
}

/** 지금 열린 패널의 모든 시설 행에 대해 계수 선택지를 새로고칩니다(프로필이 바뀔 때). */
function fsRefreshAllFacilityCoeffOptions(profile) {
  if (!el.fsBldgFacilities) return;
  el.fsBldgFacilities.querySelectorAll(".fs-facility-row").forEach((row) => fsRefreshFacilityCoeffOptions(row, profile));
}

/** 시설 행 하나를 추가하고 계수 선택지를 채웁니다. */
function fsAddFacilityRow(facility) {
  if (!el.fsBldgFacilities) return;
  const row = fsCreateFacilityRow(facility);
  el.fsBldgFacilities.appendChild(row);
  const profile = el.fsCalcProfile ? getContributionCalcProfile(el.fsCalcProfile.value) : null;
  fsRefreshFacilityCoeffOptions(row, profile);
}

/** 지금 화면에 있는 시설 행들을 raw 배열 형태로 읽습니다. */
function fsReadFacilities() {
  if (!el.fsBldgFacilities) return [];
  return Array.from(el.fsBldgFacilities.querySelectorAll(".fs-facility-row")).map((row) => ({
    facilityType: row.querySelector(".fs-fac-type").value,
    aboveArea: row.querySelector(".fs-fac-above").value,
    belowArea: row.querySelector(".fs-fac-below").value,
    landShareArea: row.querySelector(".fs-fac-land").value,
    costAbove: row.querySelector(".fs-fac-cost-above").value,
    costBelow: row.querySelector(".fs-fac-cost-below").value,
    coefficient: row.querySelector(".fs-fac-coeff").value,
  }));
}

/** 시설 행 목록을 통째로 지우고 raw 배열로부터 다시 그립니다(OP를 열 때). */
function fsWriteFacilities(facilities) {
  if (!el.fsBldgFacilities) return;
  el.fsBldgFacilities.innerHTML = "";
  (Array.isArray(facilities) ? facilities : []).forEach((facility) => fsAddFacilityRow(facility));
}

/** 상세 패널의 입력칸에서 원시 값을 그대로 읽습니다. */
function fsReadPanelRaw() {
  return {
    farBase: el.fsFarBase ? el.fsFarBase.value : "",
    farAllowed: el.fsFarAllowed ? el.fsFarAllowed.value : "",
    farFormula: el.fsFarFormula ? el.fsFarFormula.value : "",
    landArea: el.fsGiveLandArea ? el.fsGiveLandArea.value : "",
    cash: el.fsGiveCash ? el.fsGiveCash.value : "",
    siteValueMethod: el.fsSiteValueMethod ? el.fsSiteValueMethod.value : "",
    siteValue: el.fsSiteValue ? el.fsSiteValue.value : "",
    wLand: el.fsWeightLand ? el.fsWeightLand.value : "",
    profileId: el.fsCalcProfile ? el.fsCalcProfile.value : "",
    buildingFacilities: fsReadFacilities(),
  };
}

/** 원시 값 묶음을 상세 패널 입력칸에 씁니다(OP를 열 때). */
function fsWritePanelRaw(raw) {
  const map = {
    farBase: el.fsFarBase,
    farAllowed: el.fsFarAllowed,
    farFormula: el.fsFarFormula,
    landArea: el.fsGiveLandArea,
    cash: el.fsGiveCash,
    siteValueMethod: el.fsSiteValueMethod,
    siteValue: el.fsSiteValue,
    wLand: el.fsWeightLand,
  };
  Object.keys(map).forEach((k) => {
    if (map[k]) map[k].value = raw && raw[k] != null ? raw[k] : "";
  });
  if (el.fsCalcProfile) el.fsCalcProfile.value = raw && raw.profileId != null ? raw.profileId : "";
  fsRenderProfileControls();
  fsWriteFacilities(raw && raw.buildingFacilities);
}

/**
 * 상세 패널(= OP 하나의 '조건·계산 근거')의 값을 읽어 계산하고 화면에 씁니다.
 * 계산 자체는 위의 순수 함수가 하고, 이 함수는 DOM 읽기·쓰기만 담당합니다.
 */
function recomputeFeasibilityFar() {
  if (!feasibilityPanelOpen) return null;

  // 지금 열려 있는 OP가 다른 대상지 기준이면 현재 대상지로 다시 계산하지 않습니다.
  // 저장된 결과를 그대로 보여줘, 대상지가 바뀌었다고 값이 조용히 달라지는 일을 막습니다.
  if (typeof opPanelIsReadOnly === "function" && opPanelIsReadOnly()) {
    if (typeof opRenderActiveStoredResult === "function") opRenderActiveStoredResult();
    return null;
  }

  const result = computeContributionFar(fsBuildContext(), fsReadPanelRaw());

  el.fsContribLandPct.textContent = fsFormatPct(result.landPct);
  el.fsContribBldgPct.textContent = fsFormatPct(result.bldgPct);
  el.fsContribCashPct.textContent = fsFormatPct(result.cashPct);
  el.fsContribTotalPct.textContent = fsFormatPct(result.totalPct);
  el.fsFarRelief.textContent = fsFormatFar(result.relief);
  el.fsFarCap.textContent = fsFormatFar(result.computedCap);
  el.fsFloorBase.textContent = fsFormatArea(result.floorBase);
  el.fsFloorCap.textContent = fsFormatArea(result.floorCap);
  el.fsFloorIncrease.textContent = fsFormatArea(result.floorIncrease);

  if (el.fsUnmetReasons) {
    el.fsUnmetReasons.innerHTML = "";
    result.reasons.forEach((r) => {
      const li = document.createElement("li");
      li.textContent = r; // textContent라 별도 이스케이프가 필요 없습니다
      el.fsUnmetReasons.appendChild(li);
    });
    el.fsUnmetReasons.hidden = result.reasons.length === 0;
  }

  // 지금 편집 중인 OP에 이 입력과 결과를 그대로 적어 둡니다(OP별 분리 저장).
  if (typeof opSyncFromPanel === "function") opSyncFromPanel(result);

  updateFeasibilitySummaryText();
  return result;
}

/** 위 계산 결과를 사람이 읽기 좋은 사업내용 요약문으로 합칩니다(복사용 텍스트). */
function updateFeasibilitySummaryText() {
  if (!el.fsSummaryText) return;
  if (selectedParcels.size === 0 || !mergedParcelResult) {
    el.fsSummaryText.value = "";
    return;
  }

  const lines = [];
  lines.push(
    `대상지: ${el.fsLocation.textContent} 일원, 필지 ${selectedParcels.size}개, 총 대지면적 ${el.fsTotalArea.textContent}`
  );
  if (el.fsLandValueTotal.textContent !== "-") {
    lines.push(
      `토지가치(개별공시지가 ×${getFsJigaMultiplier()} 기준): ${el.fsLandValueTotal.textContent} ` +
        `(평균 ${el.fsLandValueAvg.textContent}, 고시 ${el.fsJigaDate.textContent})`
    );
  }
  // "미산정"은 값이 아니라 상태입니다 — 요약문에 숫자인 것처럼 넣지 않습니다.
  const hasValue = (node) => node && node.textContent !== "-" && node.textContent !== "미산정";

  if (hasValue(el.fsFarCap)) {
    lines.push(
      `계획한 허용 용적률 ${el.fsFarAllowed.value || "-"}% + 공공기여(총 기여율 ${el.fsContribTotalPct.textContent}) 반영 시 ` +
        `완화 용적률 ${el.fsFarRelief.textContent}, 상한 용적률 ${el.fsFarCap.textContent}`
    );
  }
  if (hasValue(el.fsFloorIncrease)) {
    lines.push(
      `기준 용적률 ${el.fsFarBase.value || "-"}% 대비 상한 용적률 적용 시 연면적 ${el.fsFloorBase.textContent} → ` +
        `${el.fsFloorCap.textContent}(증가 약 ${el.fsFloorIncrease.textContent}) — 계산 프로필·부지가액·건축비는 ` +
        `공식 기준 확인 후 최종 결정 필요`
    );
  }

  // 미산정 사유가 있으면 요약문에도 남깁니다 — 이 요약을 복사해 가는 사람이
  // "계산이 안 된 항목이 있다"는 사실을 같이 가져가야 합니다.
  if (el.fsUnmetReasons && !el.fsUnmetReasons.hidden) {
    const items = Array.from(el.fsUnmetReasons.querySelectorAll("li")).map((li) => li.textContent);
    if (items.length) {
      lines.push(`※ 미산정·확인 필요 ${items.length}건: ${items.join(" / ")}`);
    }
  }

  el.fsSummaryText.value = lines.join("\n");
}

if (el.fsFarBase) {
  document
    .querySelectorAll('input[name="fs-jiga-mult"]')
    .forEach((radio) => radio.addEventListener("change", renderFeasibilityPanel));
  [
    el.fsFarBase,
    el.fsFarAllowed,
    el.fsFarFormula,
    el.fsGiveLandArea,
    el.fsGiveCash,
    el.fsSiteValueMethod,
    el.fsSiteValue,
    el.fsWeightLand,
  ].forEach((input) => {
    if (input) input.addEventListener("input", recomputeFeasibilityFar);
    if (input) input.addEventListener("change", recomputeFeasibilityFar);
  });
  if (el.fsCalcProfile) {
    fsRenderProfileControls();
    el.fsCalcProfile.addEventListener("change", () => {
      fsRenderProfileControls();
      recomputeFeasibilityFar();
    });
  }
  // "개별공시지가 2배" 방식을 명시적으로 고르고 부지가액을 비워두면, 선택 필지의
  // 평균 개별공시지가×2를 참고값으로 자동 채웁니다 — 사용자가 그 방식을 직접
  // 선택한 경우에만 동작하는 것이라 고정 기본값이 아닙니다(운영기준 3-4-1.다.).
  if (el.fsSiteValueMethod) {
    el.fsSiteValueMethod.addEventListener("change", () => {
      if (el.fsSiteValueMethod.value === "double_jiga" && el.fsSiteValue && !el.fsSiteValue.value) {
        const jiga = typeof fsJigaCompleteness === "function" ? fsJigaCompleteness() : { jigaAvg: null };
        if (jiga.jigaAvg != null) el.fsSiteValue.value = Math.round(jiga.jigaAvg * 2);
      }
      recomputeFeasibilityFar();
    });
  }
  if (el.fsBldgFacilities) {
    el.fsBldgFacilities.addEventListener("input", recomputeFeasibilityFar);
    el.fsBldgFacilities.addEventListener("change", recomputeFeasibilityFar);
    el.fsBldgFacilities.addEventListener("click", (e) => {
      const target = e.target;
      if (target && target.classList && target.classList.contains("fs-fac-remove")) {
        const row = target.closest(".fs-facility-row");
        if (row) row.remove();
        recomputeFeasibilityFar();
      }
    });
  }
  if (el.btnFsAddFacility) {
    el.btnFsAddFacility.addEventListener("click", () => {
      fsAddFacilityRow({});
      recomputeFeasibilityFar();
    });
  }
  // 사용자가 기준 용적률을 직접 고치면, 자동 조회 결과가 그 값을 다시 덮어쓰지 않게 함
  if (el.fsFarBase) el.fsFarBase.addEventListener("input", () => (fsFarBaseUserEdited = true));
  if (el.btnFsCopySummary) {
    el.btnFsCopySummary.addEventListener("click", () => {
      navigator.clipboard?.writeText(el.fsSummaryText.value).catch(() => {});
    });
  }
}
// btn-show-feasibility("개발검토 →")의 클릭 이벤트는 js/dev-workspace.js가 붙입니다
// (openDevelopmentWorkspace) — 화면 전환 로직이라 이 파일 책임 밖입니다.

/** 조회에 성공한 실제 필지를 지도/오른쪽 패널/분석 중심에 반영합니다. */
function activateRealParcel(parcel) {
  // 1) 테스트 필지 강조 해제 (현재 선택은 실제 필지이므로)
  selectedParcelId = null;
  restyleParcelLayers();

  // 2) 기존에 표시된 실제 필지가 있으면 제거
  if (realParcelLayer) {
    map.removeLayer(realParcelLayer);
    realParcelLayer = null;
  }

  // 4단계: 새 대상지가 선택되었으므로 이전 건물 분석 결과는 초기화합니다.
  const hadPreviousBuildingAnalysis = buildingAnalysisResult !== null;
  clearBuildingAnalysis();
  if (hadPreviousBuildingAnalysis) {
    showBuildingStatus("새 대상지가 선택되어 기존 분석이 초기화되었습니다.", "empty");
  }

  // 6.1단계: 대중교통 분석도 새 대상지에 맞춰 초기화합니다 (건축물 분석과 완전히 독립적).
  clearTransitAnalysis();

  // 6.2단계: 경계·접도 분석도 새 대상지에 맞춰 초기화합니다.
  clearBoundaryAnalysis();

  // 7.1단계: 일조·그림자 분석도 새 대상지에 맞춰 초기화합니다.
  clearShadowAnalysis();

  // 7.2단계: 지형·표고 분석도 새 대상지에 맞춰 초기화합니다.
  clearTerrainAnalysis();

  // 7.3단계: 조망·시야 개방성 분석도 새 대상지에 맞춰 초기화합니다.
  clearVisibilityAnalysis();

  // 7.4단계: 주변 환경 분석도 새 대상지에 맞춰 초기화합니다.
  clearEnvironmentAnalysis();

  // 3) 새 실제 필지 폴리곤을 그리고, 클릭 시 지도 클릭 이벤트로 전파되지 않게 처리
  const feature = { type: "Feature", properties: {}, geometry: parcel.geometry };
  realParcelLayer = L.geoJSON(feature, { style: () => REAL_PARCEL_STYLE }).addTo(map);
  realParcelLayer.eachLayer((layer) => {
    layer.on("click", (e) => L.DomEvent.stopPropagation(e));
  });

  // 4) 필지 전체가 보이도록 지도 범위 조정 — 왼쪽 위에 떠 있는 카드(검색+정보)에
  // 가려지지 않도록 그쪽만 여백을 더 둡니다(Leaflet의 비대칭 padding 옵션).
  try {
    const coversWithCards = window.innerWidth > 700;
    map.fitBounds(realParcelLayer.getBounds(), {
      maxZoom: 19,
      paddingTopLeft: coversWithCards ? [340, 24] : [24, 24],
      paddingBottomRight: [24, 24],
    });
  } catch (err) {
    console.warn("fitBounds 실패:", err);
  }

  // 5) 오른쪽 패널을 실제 필지 정보로 갱신
  showRealParcelInfo(parcel);

  // 6) 분석 중심을 실제 필지 중심으로 갱신 (최우선순위)
  if (parcel.centroid) {
    analysisCenter = { lat: parcel.centroid.latitude, lng: parcel.centroid.longitude };
    analysisCenterSource = "real_parcel";
    updateRadiusCircles();
  }

  // 4단계: 이 실제 필지를 "주변 건축물 분석"의 대상으로 등록하고 버튼을 활성화합니다.
  activeRealParcel = parcel;
  enableBuildingAnalysisButton();

  // 6.1단계: 대중교통 접근성 분석 버튼도 함께 활성화합니다.
  enableTransitAnalysisButton();

  // 6.2단계: 경계·접도 분석 버튼도 함께 활성화합니다.
  enableBoundaryAnalysisButton();

  // 7.1단계: 일조·그림자 분석 버튼도 함께 활성화합니다.
  enableShadowAnalysisButton();

  // 7.2단계: 지형·표고 분석 버튼도 함께 활성화합니다.
  enableTerrainAnalysisButton();

  // 7.3단계: 조망·시야 개방성 분석 버튼도 함께 활성화합니다.
  enableVisibilityAnalysisButton();

  // 7.4단계: 주변 환경 분석 버튼도 함께 활성화합니다.
  enableEnvironmentAnalysisButton();

  // UI 간소화: 왼쪽 분석 메뉴도 함께 활성화하고, 선택 요약을 표시합니다.
  setAllMenuItemsEnabled(true);
  showLeftSelectedSummary(parcel);
  updateAllMenuBadges();
}

// 지도의 빈 공간을 클릭하면 해당 좌표의 실제 필지를 조회합니다.
// (테스트 필지·검색 마커·실제 필지 레이어 자체를 클릭한 경우는 각 레이어의
//  stopPropagation 처리 덕분에 여기까지 전파되지 않습니다.)
map.on("click", (e) => {
  // 8.6단계: "구역 지정" 그리기 모드가 켜져 있으면, 일반 필지 조회 대신 이 좌표를
  // 구역 다각형의 꼭짓점으로만 씁니다.
  if (isDrawingAreaSelect) {
    addAreaSelectPoint(e.latlng);
    return;
  }
  // 구역 선택 검토 중에는 areaGridLayer(필지 격자)가 유일한 클릭 대상입니다 —
  // 격자 밖 빈 곳을 클릭해도(Shift 여부 상관없이) 기존 선택을 건드리지 않습니다.
  if (isReviewingAreaSelect) {
    return;
  }
  // 7.3단계: "지도에서 관찰점 직접 선택" 모드가 켜져 있으면, 일반 필지 조회 대신
  // 이 좌표를 조망 분석의 사용자 임의 관찰점으로만 사용합니다.
  if (isSelectingUserViewpoint) {
    handleUserViewpointClick(e.latlng);
    return;
  }
  // 다중 필지 선택(요청사항 1): Shift+클릭이면 기존 선택 유지한 채 추가/토글, 아니면
  // 기존처럼 새 대상지로 완전히 교체합니다.
  const isShiftClick = Boolean(e.originalEvent && e.originalEvent.shiftKey);
  lookupAndShowRealParcel(
    { longitude: e.latlng.lng, latitude: e.latlng.lat },
    { loadingMarkerLatLng: e.latlng, additive: isShiftClick }
  );
});

/* ------------------------------------------------------------------ */
/* 4단계: 주변 500m 건축물 노후도·용도 분석                                  */
/* ------------------------------------------------------------------ */

function enableBuildingAnalysisButton() {
  el.btnBuildingAnalysis.disabled = false;
  el.buildingAnalysisHint.textContent = "버튼을 눌러 주변 500m 건축물을 분석해보세요.";
}

function disableBuildingAnalysisButton() {
  el.btnBuildingAnalysis.disabled = true;
  el.buildingAnalysisHint.textContent = "실제 필지를 선택하면 분석할 수 있습니다.";
}

function showBuildingStatus(message, kind) {
  el.buildingStatus.textContent = message;
  el.buildingStatus.hidden = false;
  el.buildingStatus.className = `search-status ${kind}`;
}

function hideBuildingStatus() {
  el.buildingStatus.hidden = true;
  el.buildingStatus.textContent = "";
}

/** 건물 분석 관련 지도 레이어/범례/통계/필터/상세패널을 모두 정리합니다 (버튼 상태는 건드리지 않음). */
function clearBuildingAnalysis() {
  if (buildingAnalysisAbortController) {
    buildingAnalysisAbortController.abort();
    buildingAnalysisAbortController = null;
  }
  if (buildingLayer) {
    map.removeLayer(buildingLayer);
    buildingLayer = null;
  }
  buildingAnalysisResult = null;
  buildingLayerMode = "age";
  _uncheckLayers("buildings_base", "buildings_age", "buildings_use");
  Object.values(THEME_META).forEach(({ button }) => el[button].classList.remove("active"));
  el.btnLayerAge.classList.add("active");
  el.buildingLayerSwitch.hidden = true;
  el.buildingThemeDisabledReason.hidden = true;
  el.buildingLegend.hidden = true;
  el.buildingLegend.innerHTML = "";
  el.buildingSummary.hidden = true;
  el.buildingWarnings.hidden = true;
  hideBuildingStatus();
  hideBuildingDetail();
  resetBuildingFilter();
  el.buildingFilterCard.hidden = true;

  // 5.5단계: 내보내기 버튼/상태 초기화 (새 필지 선택 시 이전 분석의 내보내기는 무효화)
  if (exportAbortController) {
    exportAbortController.abort();
    exportAbortController = null;
  }
  isExportInFlight = false;
  el.btnExportQgis.hidden = true;
  el.btnExportQgis.disabled = true;
  el.btnExportQgis.textContent = "QGIS용 파일 다운로드";
  el.exportStatus.hidden = true;
  el.exportStatus.textContent = "";

  // 최상단 유지: 실제 필지 경계는 건물 분석 레이어보다 항상 위에 보이도록 다시 올립니다.
  if (realParcelLayer) {
    realParcelLayer.eachLayer((layer) => layer.bringToFront && layer.bringToFront());
  }
}

/** "주변 500m 건축물 분석" 버튼 클릭 핸들러. */
async function performBuildingAnalysis() {
  if (!activeRealParcel || !activeRealParcel.centroid) {
    alert("먼저 실제 필지를 선택해 주세요.");
    return;
  }
  if (isBuildingAnalysisInFlight) {
    return; // 중복 요청 방지
  }

  isBuildingAnalysisInFlight = true;
  el.btnBuildingAnalysis.disabled = true;

  // 이전 요청이 아직 응답 중이었다면 취소 (오래된 응답이 새 화면을 덮어쓰지 않도록)
  if (buildingAnalysisAbortController) {
    buildingAnalysisAbortController.abort();
  }
  buildingAnalysisAbortController = new AbortController();
  const requestId = ++buildingAnalysisRequestId;

  const { longitude, latitude } = activeRealParcel.centroid;

  showBuildingStatus("건축물 분석 중...", "loading");
  el.buildingLayerSwitch.hidden = true;
  el.buildingLegend.hidden = true;
  el.buildingSummary.hidden = true;
  el.buildingFilterCard.hidden = true;

  const params = new URLSearchParams({
    longitude: String(longitude),
    latitude: String(latitude),
    radius_m: "500",
  });
  if (activeRealParcel.pnu) {
    params.set("pnu", activeRealParcel.pnu);
  }

  try {
    const res = await fetch(`/api/buildings/analysis?${params.toString()}`, {
      signal: buildingAnalysisAbortController.signal,
    });
    const body = await res.json().catch(() => ({}));

    // 이 응답이 처리되는 사이 사용자가 다른 필지를 선택해 더 최신 요청이 나갔다면 무시합니다.
    if (requestId !== buildingAnalysisRequestId) {
      return;
    }

    if (!res.ok) {
      showBuildingStatus(body.detail || "건축물 분석 중 오류가 발생했습니다.", "error");
      return;
    }

    hideBuildingStatus();
    buildingAnalysisResult = body;
    buildingLayerMode = "age";
    updateThemeButtonAvailability();
    renderBuildingLayer();
    renderLegend();
    renderSummary();
    setLayerChecked("buildings_age", true);
    el.buildingLayerSwitch.hidden = false;
    el.buildingLegend.hidden = false;
    el.buildingSummary.hidden = false;
    el.buildingFilterCard.hidden = false;

    // 5.5단계: 분석이 성공했으니 내보내기 버튼을 활성화합니다.
    el.btnExportQgis.hidden = false;
    el.btnExportQgis.disabled = false;
  } catch (err) {
    if (err.name === "AbortError") return; // 취소된 요청은 오류로 표시하지 않음
    console.error(err);
    if (requestId === buildingAnalysisRequestId) {
      showBuildingStatus(
        "네트워크 오류로 건축물 분석에 실패했습니다. 인터넷 연결을 확인해주세요.",
        "error"
      );
    }
  } finally {
    isBuildingAnalysisInFlight = false;
    el.btnBuildingAnalysis.disabled = false;
  }
}

/** 현재 응답에서, 분위수 테마(far/bcr/gfa)의 "unknown"을 제외한 구간 목록을 가져옵니다. */
function quantileDistributionFor(themeKey) {
  if (!buildingAnalysisResult) return [];
  const fieldMap = { far: "far_distribution", bcr: "bcr_distribution", gfa: "gross_floor_area_distribution" };
  const dist = buildingAnalysisResult.summary[fieldMap[themeKey]] || [];
  return dist.filter((d) => d.key !== "unknown");
}

function quantileColorForBand(bandKey, themeKey) {
  if (!bandKey) return QUANTILE_UNKNOWN_COLOR;
  const bands = quantileDistributionFor(themeKey);
  const idx = bands.findIndex((b) => b.key === bandKey);
  return idx === -1 ? QUANTILE_UNKNOWN_COLOR : QUANTILE_PALETTE[idx % QUANTILE_PALETTE.length];
}

function styleForBuilding(feature) {
  const props = feature.properties;
  let color;

  switch (buildingLayerMode) {
    case "age":
      color = AGE_BAND_CONFIG[props.age_band]?.color;
      break;
    case "use":
      color = props.use_category ? USE_CATEGORY_COLORS[props.use_category] || USE_CATEGORY_COLORS["미상"] : USE_CATEGORY_COLORS["미상"];
      break;
    case "floors":
      color = FLOOR_BAND_CONFIG[props.floor_band]?.color;
      break;
    case "height":
      color = HEIGHT_BAND_CONFIG[props.height_band]?.color;
      break;
    case "gfa":
      color = quantileColorForBand(props.gfa_band, "gfa");
      break;
    case "bcr":
      color = quantileColorForBand(props.bcr_band, "bcr");
      break;
    case "far":
      color = quantileColorForBand(props.far_band, "far");
      break;
    default:
      color = "#9E9E9E";
  }

  const isFilteredOut = activeBuildingFilter && !buildingMatchesFilter(props, activeBuildingFilter);

  return {
    color: isFilteredOut ? "#555555" : "#c0392b",
    weight: isFilteredOut ? 0.5 : 2.5,
    fillColor: color || "#9E9E9E",
    fillOpacity: isFilteredOut ? 0.25 : 0.8,
  };
}

function themeValueLabel(props) {
  switch (buildingLayerMode) {
    case "age":
      return `연령: ${props.age_years != null ? props.age_years + "년" : "정보 없음"} (${props.approval_year != null ? props.approval_year + "년 승인" : "정보 없음"})`;
    case "use":
      return `용도: ${props.main_use_name || "정보 없음"}`;
    case "floors":
      return `층수: ${props.floors_above != null ? props.floors_above + "층" : "정보 없음"}`;
    case "height":
      return `높이: ${props.height_m != null ? props.height_m + "m" : "정보 없음"}`;
    case "gfa":
      return `연면적: ${props.gross_floor_area_sqm != null ? props.gross_floor_area_sqm.toLocaleString("ko-KR") + "㎡" : "정보 없음"}`;
    case "bcr":
      return `건폐율: ${props.building_coverage_ratio != null ? props.building_coverage_ratio + "%" : "정보 없음"}`;
    case "far":
      return `용적률: ${props.floor_area_ratio != null ? props.floor_area_ratio + "%" : "정보 없음"}`;
    default:
      return "";
  }
}

function buildingTooltipHtml(props) {
  const name = props.building_name || props.dong_name || "정보 없음";
  return `<strong>${name}</strong><br/>${themeValueLabel(props)}`;
}

/** buildingAnalysisResult를 바탕으로 지도 위에 건물 레이어를 (다시) 그립니다. */
function renderBuildingLayer() {
  if (buildingLayer) {
    map.removeLayer(buildingLayer);
    buildingLayer = null;
  }
  if (!buildingAnalysisResult) return;

  buildingLayer = L.geoJSON(buildingAnalysisResult.buildings, {
    style: styleForBuilding,
    onEachFeature: (feature, layer) => {
      layer.bindTooltip(buildingTooltipHtml(feature.properties), {
        className: "building-tooltip",
        sticky: true,
      });
      layer.on("mouseover", () => layer.setStyle({ weight: 2.5 }));
      layer.on("mouseout", () => layer.setStyle(styleForBuilding(feature)));
      layer.on("click", (e) => {
        // 건물 레이어 클릭이 지도 click(필지 재조회)으로 전파되지 않게 막습니다.
        L.DomEvent.stopPropagation(e);
        showBuildingDetail(feature);
      });
    },
  });

  applyBuildingLayerVisibility();

  // 실제 필지 경계는 항상 건물 레이어보다 위에 보이도록 유지
  if (realParcelLayer) {
    realParcelLayer.eachLayer((layer) => layer.bringToFront && layer.bringToFront());
  }
}

function renderLegend() {
  el.buildingLegend.innerHTML = "";

  let entries;
  if (buildingLayerMode === "age") {
    entries = Object.values(AGE_BAND_CONFIG).map((cfg) => [cfg.label, cfg.color]);
  } else if (buildingLayerMode === "use") {
    if (!buildingAnalysisResult || buildingAnalysisResult.data_status.use_data !== "available") {
      const notice = document.createElement("p");
      notice.className = "panel-hint";
      notice.textContent = "용도 데이터 없음";
      el.buildingLegend.appendChild(notice);
      return;
    }
    entries = Object.entries(USE_CATEGORY_COLORS);
  } else if (buildingLayerMode === "floors") {
    entries = Object.values(FLOOR_BAND_CONFIG).map((cfg) => [cfg.label, cfg.color]);
  } else if (buildingLayerMode === "height") {
    entries = Object.values(HEIGHT_BAND_CONFIG).map((cfg) => [cfg.label, cfg.color]);
  } else {
    // far / bcr / gfa: 분위수 구간 (실제 사용된 숫자 범위를 그대로 라벨로 표시)
    const bands = quantileDistributionFor(buildingLayerMode);
    entries = bands.map((b, i) => [b.label, QUANTILE_PALETTE[i % QUANTILE_PALETTE.length]]);
    entries.push(["정보 없음", QUANTILE_UNKNOWN_COLOR]);
  }

  entries.forEach(([label, color]) => {
    const item = document.createElement("div");
    item.className = "legend-item";

    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.backgroundColor = color;

    const text = document.createElement("span");
    text.textContent = label;

    item.appendChild(swatch);
    item.appendChild(text);
    el.buildingLegend.appendChild(item);
  });
}

/** 정보가 하나도 없는 주제도 버튼은 비활성화하고 이유를 표시합니다. */
function updateThemeButtonAvailability() {
  if (!buildingAnalysisResult) return;
  const s = buildingAnalysisResult.summary;
  const reasons = [];

  const checks = {
    use: buildingAnalysisResult.data_status.use_data === "available",
    floors: s.buildings_with_floors > 0,
    height: s.buildings_with_height > 0,
    gfa: s.buildings_with_gross_floor_area > 0,
    bcr: s.buildings_with_bcr > 0,
    far: s.buildings_with_far > 0,
  };

  const labels = { use: "용도", floors: "층수", height: "높이", gfa: "연면적", bcr: "건폐율", far: "용적률" };

  Object.entries(checks).forEach(([theme, available]) => {
    const button = el[THEME_META[theme].button];
    button.disabled = !available;
    if (!available) {
      reasons.push(`${labels[theme]}: 확보된 정보 없음`);
    }
  });

  if (reasons.length > 0) {
    el.buildingThemeDisabledReason.textContent = `⚠ 다음 주제는 정보가 없어 비활성화되었습니다 — ${reasons.join(", ")}`;
    el.buildingThemeDisabledReason.hidden = false;
  } else {
    el.buildingThemeDisabledReason.hidden = true;
  }
}

function switchLayerMode(mode) {
  if (mode === buildingLayerMode) return;
  if (el[THEME_META[mode].button].disabled) return; // 정보가 없는 주제는 전환 안 함

  buildingLayerMode = mode;
  Object.entries(THEME_META).forEach(([key, { button }]) => {
    el[button].classList.toggle("active", key === mode);
  });
  renderBuildingLayer();
  renderLegend();
  renderSummary();
  // 사용성 개선: 건물 노후도/용도/층수/높이는 지도 레이어 패널의 항목과도 연결되어 있으므로,
  // 건물 레이어가 켜져 있었다면 체크 상태를 새 모드에 맞게 옮겨줍니다.
  const buildingLayerKeys = ["buildings_base", "buildings_age", "buildings_use", "buildings_floors", "buildings_height"];
  if (buildingLayerKeys.some((k) => layerCheckedState[k])) {
    const modeToKey = { age: "buildings_age", use: "buildings_use", floors: "buildings_floors", height: "buildings_height" };
    setLayerChecked(modeToKey[mode] || "buildings_base", true);
  }
}

el.btnLayerAge.addEventListener("click", () => switchLayerMode("age"));
el.btnLayerUse.addEventListener("click", () => switchLayerMode("use"));
el.btnLayerFloors.addEventListener("click", () => switchLayerMode("floors"));
el.btnLayerHeight.addEventListener("click", () => switchLayerMode("height"));
el.btnLayerGfa.addEventListener("click", () => switchLayerMode("gfa"));
el.btnLayerBcr.addEventListener("click", () => switchLayerMode("bcr"));
el.btnLayerFar.addEventListener("click", () => switchLayerMode("far"));
el.btnBuildingAnalysis.addEventListener("click", performBuildingAnalysis);

/* --- 통계 패널: 선택된 주제에 맞춰 동적으로 dl 내용을 다시 그립니다 --- */

function dlRow(label, value) {
  return `<dt>${label}</dt><dd>${value}</dd>`;
}

function renderSummary() {
  if (!buildingAnalysisResult) return;
  const s = buildingAnalysisResult.summary;
  const total = s.total_buildings;

  // 항상 보이는 핵심 정보
  el.summaryCore.innerHTML =
    dlRow("분석 건물 수", `${total}동`) +
    dlRow("데이터 출처", `${buildingAnalysisResult.metadata.age_source} / ${buildingAnalysisResult.metadata.use_source}`) +
    dlRow("분석 실행 시각", new Date(buildingAnalysisResult.metadata.analyzed_at).toLocaleString("ko-KR")) +
    dlRow(
      "규모·밀도 상세정보 확보",
      `${s2(buildingAnalysisResult.data_status.detail_coverage.buildings_with_detail)}동 / ` +
        `${s2(total)}동 (${s2(buildingAnalysisResult.data_status.detail_coverage.coverage_rate)}%)`
    );

  // 선택 주제별 통계
  let themeHtml = "";
  if (buildingLayerMode === "age") {
    themeHtml =
      dlRow("연령정보 확보", `${s.buildings_with_age}동 (${s.coverage_rate_percent}%, 전체 ${total}동 기준)`) +
      dlRow(
        "평균/중앙 연령",
        s.average_age_years != null ? `평균 ${s.average_age_years}년 / 중앙값 ${s.median_age_years}년` : "계산 불가"
      ) +
      dlRow("20년 이상", `${s.over_20_years_count}동`) +
      dlRow("30년 이상", `${s.over_30_years_count}동 (전체 기준 ${s.over_30_years_percent}%)`) +
      dlRow("40년 이상", `${s.over_40_years_count}동`) +
      dlRow("가장 오래된 승인연도", s.oldest_approval_year != null ? `${s.oldest_approval_year}년` : "정보 없음");
  } else if (buildingLayerMode === "use") {
    themeHtml = (s.use_distribution || [])
      .map((u) => dlRow(u.label, `${u.count}동 (${u.percent}%)`))
      .join("");
    if (!themeHtml) themeHtml = dlRow("용도 분포", "정보 없음");
  } else if (buildingLayerMode === "floors") {
    themeHtml =
      dlRow("층수정보 확보", `${s.buildings_with_floors}동 (${s.floors_coverage_rate_percent}%, 전체 ${total}동 기준)`) +
      dlRow(
        "평균/중앙 지상층수",
        s.average_floors_above != null ? `평균 ${s.average_floors_above}층 / 중앙값 ${s.median_floors_above}층` : "계산 불가"
      ) +
      dlRow("5층 이하", `${s.floors_5_or_under_count}동 (${s.floors_5_or_under_percent}%)`) +
      dlRow("10층 이상", `${s.floors_10_or_over_count}동 (${s.floors_10_or_over_percent}%)`);
  } else if (buildingLayerMode === "height") {
    themeHtml =
      dlRow("높이정보 확보", `${s.buildings_with_height}동 (${s.height_coverage_rate_percent}%, 전체 ${total}동 기준)`) +
      dlRow(
        "평균/중앙 높이",
        s.average_height_m != null ? `평균 ${s.average_height_m}m / 중앙값 ${s.median_height_m}m` : "계산 불가"
      ) +
      dlRow("최고 높이", s.tallest_height_m != null ? `${s.tallest_height_m}m` : "정보 없음");
  } else if (buildingLayerMode === "gfa") {
    themeHtml =
      dlRow("연면적정보 확보", `${s.buildings_with_gross_floor_area}동 (전체 ${total}동 기준)`) +
      dlRow("총 건축면적", s.total_building_area_sqm != null ? `${s.total_building_area_sqm.toLocaleString("ko-KR")}㎡` : "정보 없음") +
      dlRow("총 연면적", s.total_gross_floor_area_sqm != null ? `${s.total_gross_floor_area_sqm.toLocaleString("ko-KR")}㎡` : "정보 없음") +
      dlRow(
        "평균/중앙 연면적",
        s.average_gross_floor_area_sqm != null
          ? `평균 ${s.average_gross_floor_area_sqm.toLocaleString("ko-KR")}㎡ / 중앙값 ${s.median_gross_floor_area_sqm.toLocaleString("ko-KR")}㎡`
          : "계산 불가"
      );
  } else if (buildingLayerMode === "bcr") {
    themeHtml =
      dlRow("건폐율정보 확보", `${s.buildings_with_bcr}동 (${s.bcr_coverage_rate_percent}%, 전체 ${total}동 기준)`) +
      dlRow(
        "평균/중앙 건폐율",
        s.average_bcr_percent != null ? `평균 ${s.average_bcr_percent}% / 중앙값 ${s.median_bcr_percent}%` : "계산 불가"
      );
  } else if (buildingLayerMode === "far") {
    themeHtml =
      dlRow("용적률정보 확보", `${s.buildings_with_far}동 (${s.far_coverage_rate_percent}%, 전체 ${total}동 기준)`) +
      dlRow(
        "평균/중앙 용적률",
        s.average_far_percent != null ? `평균 ${s.average_far_percent}% / 중앙값 ${s.median_far_percent}%` : "계산 불가"
      ) +
      dlRow("주변 용적률 분포", (s.far_distribution || []).map((d) => `${d.label}: ${d.count}동`).join(", "));
  }
  el.summaryTheme.innerHTML = themeHtml;

  // 주거·주차 (특정 주제에 종속되지 않고 항상 표시)
  el.summaryHousing.innerHTML =
    dlRow("세대수정보 확보", `${s.buildings_with_households}동`) +
    dlRow("확인된 총 세대수", s.total_households != null ? `${s.total_households.toLocaleString("ko-KR")}세대` : "정보 없음") +
    dlRow("확인된 총 가구수", s.total_families != null ? `${s.total_families.toLocaleString("ko-KR")}가구` : "정보 없음") +
    dlRow("주차정보 확보", `${s.buildings_with_parking}동`) +
    dlRow("확인된 총 주차대수", s.total_parking_count != null ? `${s.total_parking_count.toLocaleString("ko-KR")}대` : "정보 없음") +
    dlRow("세대당 주차대수", s.parking_per_household != null ? `${s.parking_per_household}대/세대` : "계산 불가 (신뢰 가능한 데이터 부족)");

  const warnings = buildingAnalysisResult.data_status.warnings || [];
  if (warnings.length > 0) {
    el.buildingWarnings.textContent = `⚠ ${warnings.join(" / ")}`;
    el.buildingWarnings.hidden = false;
  } else {
    el.buildingWarnings.hidden = true;
  }
}

function s2(value) {
  return value == null ? "0" : value;
}

/* --- 5단계: 저층·노후·저밀 조건 검색 필터 --- */

function buildingMatchesFilter(props, filter) {
  const results = filter.conditions.map((cond) => {
    if (cond.type === "age") {
      return props.age_years != null && props.age_years >= cond.value;
    }
    if (cond.type === "floors") {
      return props.floors_above != null && props.floors_above <= cond.value;
    }
    if (cond.type === "far") {
      return props.floor_area_ratio != null && props.floor_area_ratio <= cond.value;
    }
    if (cond.type === "gfa") {
      return props.gross_floor_area_sqm != null && props.gross_floor_area_sqm <= cond.value;
    }
    return false;
  });

  if (results.length === 0) return false;
  return filter.mode === "and" ? results.every(Boolean) : results.some(Boolean);
}

function applyBuildingFilter() {
  if (!buildingAnalysisResult) return;

  const conditions = [];
  if (el.filterAgeEnable.checked) {
    conditions.push({ type: "age", value: Number(el.filterAgeValue.value) });
  }
  if (el.filterFloorsEnable.checked) {
    conditions.push({ type: "floors", value: Number(el.filterFloorsValue.value) });
  }
  if (el.filterFarEnable.checked && el.filterFarValue.value !== "") {
    conditions.push({ type: "far", value: Number(el.filterFarValue.value) });
  }
  if (el.filterGfaEnable.checked && el.filterGfaValue.value !== "") {
    conditions.push({ type: "gfa", value: Number(el.filterGfaValue.value) });
  }

  if (conditions.length === 0) {
    el.filterResult.textContent = "조건을 하나 이상 선택해주세요.";
    el.filterResult.hidden = false;
    el.filterResult.className = "search-status error";
    return;
  }

  const mode = document.querySelector('input[name="filter-mode"]:checked').value;
  activeBuildingFilter = { conditions, mode };

  const features = buildingAnalysisResult.buildings.features;
  const total = features.length;
  let matched = 0;
  const missingByCondition = conditions.map(() => 0);

  features.forEach((f) => {
    const props = f.properties;
    conditions.forEach((cond, i) => {
      const fieldValue =
        cond.type === "age"
          ? props.age_years
          : cond.type === "floors"
          ? props.floors_above
          : cond.type === "far"
          ? props.floor_area_ratio
          : props.gross_floor_area_sqm;
      if (fieldValue == null) missingByCondition[i] += 1;
    });
    if (buildingMatchesFilter(props, activeBuildingFilter)) matched += 1;
  });

  if (buildingLayer) {
    buildingLayer.eachLayer((layer) => layer.setStyle(styleForBuilding(layer.feature)));
  }

  const missingText = conditions.map((c, i) => `${filterConditionLabel(c)}: 누락 ${missingByCondition[i]}건`).join(", ");
  el.filterResult.innerHTML =
    `저층·노후·저밀 조건 부합 건축물: <strong>${matched}동</strong> / 전체 ${total}동 (${(total ? Math.round((matched / total) * 1000) / 10 : 0)}%)<br/>` +
    `조건별 데이터 누락: ${missingText}`;
  el.filterResult.hidden = false;
  el.filterResult.className = "search-status loading";
}

function filterConditionLabel(cond) {
  if (cond.type === "age") return `노후도(${cond.value}년 이상)`;
  if (cond.type === "floors") return `층수(${cond.value}층 이하)`;
  if (cond.type === "far") return `용적률(${cond.value}% 이하)`;
  return `연면적(${cond.value}㎡ 이하)`;
}

function resetBuildingFilter() {
  activeBuildingFilter = null;
  el.filterAgeEnable.checked = false;
  el.filterFloorsEnable.checked = false;
  el.filterFarEnable.checked = false;
  el.filterGfaEnable.checked = false;
  el.filterFarValue.value = "";
  el.filterGfaValue.value = "";
  el.filterResult.hidden = true;
  el.filterResult.innerHTML = "";
  if (buildingLayer) {
    buildingLayer.eachLayer((layer) => layer.setStyle(styleForBuilding(layer.feature)));
  }
}

el.btnFilterApply.addEventListener("click", applyBuildingFilter);
el.btnFilterReset.addEventListener("click", resetBuildingFilter);

/* --- 5.5단계: QGIS용 GeoPackage 내보내기 --- */

function showExportStatus(message, kind) {
  el.exportStatus.textContent = message;
  el.exportStatus.hidden = false;
  el.exportStatus.className = `search-status ${kind}`;
}

function hideExportStatus() {
  el.exportStatus.hidden = true;
  el.exportStatus.textContent = "";
}

/** 현재 필터 상태를 내보내기 API가 기대하는 형태로 변환합니다 (없으면 applied:false). */
function buildExportFilterPayload() {
  if (!activeBuildingFilter) {
    return { applied: false, mode: "and", conditions: {} };
  }

  const conditions = {};
  activeBuildingFilter.conditions.forEach((cond) => {
    if (cond.type === "age") conditions.age_years_min = cond.value;
    if (cond.type === "floors") conditions.floors_max = cond.value;
    if (cond.type === "far") conditions.far_max = cond.value;
    if (cond.type === "gfa") conditions.gfa_max = cond.value;
  });

  return { applied: true, mode: activeBuildingFilter.mode, conditions };
}

async function performQgisExport() {
  if (!buildingAnalysisResult || !buildingAnalysisResult.analysis_id) {
    alert("먼저 주변 건축물 분석을 실행해 주세요.");
    return;
  }
  if (!activeRealParcel || !activeRealParcel.geometry) {
    alert("먼저 실제 필지를 선택해 주세요.");
    return;
  }
  if (isExportInFlight) {
    return; // 중복 클릭 방지
  }

  isExportInFlight = true;
  el.btnExportQgis.disabled = true;
  el.btnExportQgis.textContent = "QGIS 파일 생성 중...";
  showExportStatus("QGIS용 파일을 만들고 있습니다...", "loading");

  if (exportAbortController) {
    exportAbortController.abort();
  }
  exportAbortController = new AbortController();

  const requestBody = {
    analysis_id: buildingAnalysisResult.analysis_id,
    parcel: {
      pnu: activeRealParcel.pnu || null,
      address: activeRealParcel.address || null,
      area_sqm: activeRealParcel.area_sqm != null ? activeRealParcel.area_sqm : null,
      centroid: {
        longitude: activeRealParcel.centroid.longitude,
        latitude: activeRealParcel.centroid.latitude,
      },
      geometry: activeRealParcel.geometry,
      source_name: activeRealParcel.dataset || null,
      source_date: null,
      selected_at: new Date().toISOString(),
    },
    filter: buildExportFilterPayload(),
  };

  try {
    const res = await fetch("/api/export/qgis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: exportAbortController.signal,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showExportStatus(body.detail || "QGIS 파일 생성 중 오류가 발생했습니다.", "error");
      return;
    }

    // 성공: 응답 본문(zip)을 파일로 내려받습니다.
    const blob = await res.blob();
    const disposition = res.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="?([^"]+)"?/);
    const filename = match ? match[1] : "site_analysis_export.zip";

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    hideExportStatus();
  } catch (err) {
    if (err.name === "AbortError") return;
    console.error(err);
    showExportStatus("네트워크 오류로 QGIS 파일을 내려받지 못했습니다. 다시 시도해주세요.", "error");
  } finally {
    isExportInFlight = false;
    el.btnExportQgis.disabled = false;
    el.btnExportQgis.textContent = "QGIS용 파일 다운로드";
  }
}

el.btnExportQgis.addEventListener("click", performQgisExport);

/* --- 건물 클릭 -> 건축물대장 표제부 지연 조회 --- */

function hideBuildingDetail() {
  el.buildingDetailCard.hidden = true;
  el.buildingDetailStatus.hidden = true;
  el.buildingDetailCandidates.hidden = true;
  el.buildingDetailCandidates.innerHTML = "";
}

function fmtNum(value, unit) {
  return value != null ? `${value.toLocaleString("ko-KR")}${unit}` : "정보 없음";
}

async function showBuildingDetail(feature) {
  const props = feature.properties;
  el.buildingDetailCard.hidden = false;
  el.buildingDetailCandidates.hidden = true;
  el.buildingDetailCandidates.innerHTML = "";

  // 기본 WFS/분석 결과 정보를 즉시 표시 (건축물대장 조회 전에도 바로 보이도록)
  el.detailName.textContent = props.building_name || props.dong_name || "정보 없음";
  el.detailAge.textContent =
    props.approval_date || props.age_years != null
      ? `${props.approval_date || "정보 없음"} (${props.age_years != null ? props.age_years + "년" : "정보 없음"})`
      : "정보 없음";
  el.detailUse.textContent = props.main_use_name || "정보 없음";
  el.detailFloors.textContent =
    props.floors_above != null || props.floors_below != null
      ? `지상 ${props.floors_above != null ? props.floors_above + "층" : "정보 없음"} / 지하 ${
          props.floors_below != null ? props.floors_below + "층" : "정보 없음"
        }`
      : "정보 없음";
  el.detailHeight.textContent = fmtNum(props.height_m, "m");
  el.detailSiteArea.textContent = fmtNum(props.site_area_sqm, "㎡");
  el.detailBuildingArea.textContent = fmtNum(props.building_area_sqm, "㎡");
  el.detailFloorArea.textContent = fmtNum(props.gross_floor_area_sqm, "㎡");
  el.detailBcr.textContent = fmtNum(props.building_coverage_ratio, "%");
  el.detailFar.textContent = fmtNum(props.floor_area_ratio, "%");
  el.detailHouseholds.textContent =
    props.households != null || props.families != null
      ? `${props.households != null ? props.households + "세대" : "정보 없음"} / ${
          props.families != null ? props.families + "가구" : "정보 없음"
        }`
      : "정보 없음";
  el.detailParking.textContent = fmtNum(props.parking_count, "대");
  el.detailAddress.textContent = "조회 중...";
  el.detailStructure.textContent = "조회 중...";
  el.detailMatchStatus.textContent = "조회 중...";
  el.detailSource.textContent = "-";

  if (!props.pnu) {
    el.detailAddress.textContent = "확인 안 됨";
    el.detailStructure.textContent = "확인 안 됨";
    el.detailMatchStatus.textContent = "PNU를 확인할 수 없어 상세정보를 조회할 수 없습니다.";
    return;
  }

  if (buildingDetailAbortController) {
    buildingDetailAbortController.abort();
  }
  buildingDetailAbortController = new AbortController();

  showBuildingDetailStatus("건축물대장 상세정보 조회 중...", "loading");

  const params = new URLSearchParams({ pnu: props.pnu });
  if (props.register_id) {
    params.set("register_id", props.register_id);
  }

  try {
    const res = await fetch(`/api/buildings/detail?${params.toString()}`, {
      signal: buildingDetailAbortController.signal,
    });
    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      showBuildingDetailStatus(body.detail || "건축물대장 조회 중 오류가 발생했습니다.", "error");
      return;
    }

    hideBuildingDetailStatus();
    renderBuildingDetailResult(body);
  } catch (err) {
    if (err.name === "AbortError") return;
    console.error(err);
    showBuildingDetailStatus("네트워크 오류로 상세정보를 불러오지 못했습니다.", "error");
  }
}

function showBuildingDetailStatus(message, kind) {
  el.buildingDetailStatus.textContent = message;
  el.buildingDetailStatus.hidden = false;
  el.buildingDetailStatus.className = `search-status ${kind}`;
}

function hideBuildingDetailStatus() {
  el.buildingDetailStatus.hidden = true;
}

function renderBuildingDetailResult(body) {
  if (body.match_status === "not_found") {
    el.detailAddress.textContent = "확인 안 됨";
    el.detailStructure.textContent = "확인 안 됨";
    el.detailMatchStatus.textContent = "건축물대장 상세정보 없음";
    el.detailSource.textContent = "-";
    return;
  }

  if (body.match_status === "multiple_candidates") {
    el.detailAddress.textContent = "-";
    el.detailStructure.textContent = "-";
    el.detailMatchStatus.textContent = "동 단위 상세정보를 정확히 특정할 수 없음 (후보 목록 참고)";
    el.detailSource.textContent = "-";

    el.buildingDetailCandidates.innerHTML = "";
    body.candidates.forEach((cand) => {
      const li = document.createElement("li");
      li.className = "search-result-item";
      li.textContent = `${cand.dong_name || cand.building_name || "동 미상"} · 사용승인일 ${cand.approval_date || "정보 없음"}`;
      el.buildingDetailCandidates.appendChild(li);
    });
    el.buildingDetailCandidates.hidden = false;
    return;
  }

  const b = body.building;
  el.detailAddress.textContent = b.road_address || b.address || "정보 없음";
  el.detailStructure.textContent = b.structure || "정보 없음";
  el.detailSiteArea.textContent = fmtNum(b.site_area_sqm, "㎡");
  el.detailBuildingArea.textContent = fmtNum(b.building_area_sqm, "㎡");
  el.detailFloorArea.textContent = fmtNum(b.gross_floor_area_sqm, "㎡");
  el.detailBcr.textContent = fmtNum(b.building_coverage_ratio, "%");
  el.detailFar.textContent = fmtNum(b.floor_area_ratio, "%");
  el.detailHeight.textContent = fmtNum(b.height_m, "m");
  el.detailHouseholds.textContent =
    b.households != null || b.families != null
      ? `${b.households != null ? b.households + "세대" : "정보 없음"} / ${b.families != null ? b.families + "가구" : "정보 없음"}`
      : "정보 없음";
  el.detailParking.textContent = fmtNum(b.parking_count, "대");
  el.detailMatchStatus.textContent = "동 특정됨 (exact)";
  el.detailSource.textContent = `건축HUB 건축물대장(표제부)${b.source_date ? " · 생성일자 " + b.source_date : ""}`;
}

/* ------------------------------------------------------------------ */
/* 6.1단계: 대중교통(지하철) 기본 접근성 분석                                  */
/* ------------------------------------------------------------------ */

// ⚠️ 사용자 요청으로 개선: 지하철역 마커를 단순 점이 아니라 실제 노선색·환승 노선 수가
// 드러나는 원형(분할) 마커로 표시합니다. 색상값은 마커 생성 코드에 직접 쓰지 않고
// 이 설정 객체 하나로 분리했습니다 — 노선 추가/색상 조정은 여기만 고치면 됩니다.
//
// 색상 출처: 서울교통공사·각 운영사가 공개한 노선색에 최대한 맞춘 통용 웹 색상값입니다
// (Pantone/CMYK 원본 대조까지는 하지 않았습니다 — 필요하면 공식 디자인 가이드라인의
// 정확한 수치로 교체해주세요).
const LINE_STYLE = {
  "1호선": { color: "#0052A4", label: "1" },
  "2호선": { color: "#00A84D", label: "2" },
  "3호선": { color: "#EF7C1C", label: "3" },
  "4호선": { color: "#00A5DE", label: "4" },
  "5호선": { color: "#996CAC", label: "5" },
  "6호선": { color: "#CD7C2F", label: "6" },
  "7호선": { color: "#747F00", label: "7" },
  "8호선": { color: "#E6186C", label: "8" },
  "9호선": { color: "#BDB092", label: "9" },
  "인천1호선": { color: "#7CA8D5", label: "인천1" },
  "인천2호선": { color: "#ED8B00", label: "인천2" },
  "경의중앙선": { color: "#77C4A3", label: "경의" },
  "수인분당선": { color: "#FABE00", label: "수분" },
  "신분당선": { color: "#D4003B", label: "신분" },
  "공항철도": { color: "#0090D2", label: "공항" },
  "경춘선": { color: "#178C72", label: "경춘" },
  "우이신설선": { color: "#B0CE18", label: "우이" },
  "신림선": { color: "#6789CA", label: "신림" },
  "서해선": { color: "#8FC31F", label: "서해" },
};
const FALLBACK_LINE_STYLE = { color: "#9E9E9E", label: "" }; // 노선 정보 없거나 못 알아본 경우

// 요청사항: 1~9호선, 도시철도, 광역철도 순으로 일관되게 정렬
const LINE_ORDER = [
  "1호선", "2호선", "3호선", "4호선", "5호선", "6호선", "7호선", "8호선", "9호선",
  "인천1호선", "인천2호선",
  "경의중앙선", "수인분당선", "신분당선", "공항철도", "경춘선", "우이신설선", "신림선", "서해선",
];

// 실제 백엔드 캐시(backend/data/subway_stations.csv, 전국도시철도역사정보표준데이터)에서
// 확인된 line_name 원본 표기 → 표준 노선명 매핑입니다. 같은 노선이 구간별로 다른
// 이름으로 기록된 경우(예: 분당선/수인선, 1호선의 경인선/경부선/경원선 구간)와 표기
// 편차(공백 2칸 등)를 흡수합니다. 여기 없는 값은 정규화 실패로 처리해 회색 기본
// 마커로 표시합니다(요청사항: 오류를 내지 않고 회색으로).
const RAW_LINE_NAME_TO_STANDARD = {
  "1호선": "1호선", "경인선": "1호선", "경부선": "1호선", "경원선": "1호선",
  "2호선": "2호선",
  "3호선": "3호선", "일산선": "3호선",
  "4호선": "4호선", "안산과천선": "4호선", "진접선": "4호선",
  "5호선": "5호선",
  "6호선": "6호선",
  "7호선": "7호선", "도시철도 7호선": "7호선",
  "8호선": "8호선", "수도권 광역철도 8호선": "8호선",
  "9호선": "9호선", "서울 도시철도 9호선": "9호선", "수도권 도시철도 9호선": "9호선",
  "인천지하철 1호선": "인천1호선",
  "인천지하철 2호선": "인천2호선",
  "경의중앙선": "경의중앙선",
  "분당선": "수인분당선", "수인선": "수인분당선", "수인분당선": "수인분당선",
  "신분당선": "신분당선",
  "공항철도": "공항철도", "인천국제공항선": "공항철도",
  "경춘선": "경춘선",
  "우이신설선": "우이신설선",
  "신림선": "신림선", "수도권 경량도시철도 신림선": "신림선",
  "서해선": "서해선",
};

/** 원본 line_name(공백 편차 등 포함)을 표준 노선명으로 정규화합니다. 못 알아보면 null. */
function normalizeLineName(rawName) {
  if (!rawName) return null;
  const cleaned = String(rawName).replace(/\s+/g, " ").trim();
  return RAW_LINE_NAME_TO_STANDARD[cleaned] || null;
}

/** 노선 배열(원본 표기, 중복 가능)을 정규화·중복제거·표준 순서로 정렬합니다. */
function normalizeAndSortLines(rawLines) {
  const normalized = (rawLines || []).map(normalizeLineName);
  const unique = Array.from(new Set(normalized)); // null 포함 가능(못 알아본 노선 1개로 취급)
  unique.sort((a, b) => {
    const ia = a ? LINE_ORDER.indexOf(a) : 999;
    const ib = b ? LINE_ORDER.indexOf(b) : 999;
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
  return unique;
}

function _polarToCartesian(cx, cy, r, angleDeg) {
  // 0도 = 12시 방향, 각도가 커질수록 시계방향으로 이동
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
}

function _describeSectorPath(cx, cy, r, startAngleDeg, endAngleDeg) {
  const start = _polarToCartesian(cx, cy, r, startAngleDeg);
  const end = _polarToCartesian(cx, cy, r, endAngleDeg);
  const largeArcFlag = endAngleDeg - startAngleDeg <= 180 ? "0" : "1";
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 1 ${end.x} ${end.y} Z`;
}

/**
 * 노선 수만큼 원을 균등 분할한 SVG 마커 문자열을 만듭니다(요청사항의 핵심 로직).
 * 단일 노선도 이 함수를 그대로 씁니다(분할 수가 1일 뿐, 같은 코드 경로).
 */
function buildSubwaySvgMarkup(normalizedLines, sizePx) {
  const lines = normalizedLines.length > 0 ? normalizedLines : [null];
  const n = lines.length;
  const r = sizePx / 2;
  const cx = r;
  const cy = r;
  const circleR = r - 1.5; // 흰 외곽선(2px)이 잘리지 않도록 살짝 안쪽

  const parts = [];

  if (n === 1) {
    const style = LINE_STYLE[lines[0]] || FALLBACK_LINE_STYLE;
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${circleR}" fill="${style.color}" stroke="#fff" stroke-width="2"/>`);
    if (style.label) {
      parts.push(
        `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" ` +
          `font-size="${Math.round(r * 0.85)}" font-weight="700" fill="#fff" font-family="sans-serif">${style.label}</text>`
      );
    }
  } else {
    const anglePerSlice = 360 / n;
    lines.forEach((line, i) => {
      const style = LINE_STYLE[line] || FALLBACK_LINE_STYLE;
      const startAngle = i * anglePerSlice;
      const endAngle = startAngle + anglePerSlice;
      parts.push(`<path d="${_describeSectorPath(cx, cy, circleR, startAngle, endAngle)}" fill="${style.color}"/>`);
    });
    // 가독성 우선: 부채꼴이 3개 이하일 때만 글자를 넣고, 많으면 색 분할만 보여줍니다
    // (요청사항: "억지로 넣지 않아도 된다", 전체 노선명은 툴팁에서 확인).
    if (n <= 3) {
      lines.forEach((line, i) => {
        const style = LINE_STYLE[line] || FALLBACK_LINE_STYLE;
        if (!style.label) return;
        const anglePerSlice2 = 360 / n;
        const midAngle = i * anglePerSlice2 + anglePerSlice2 / 2;
        const pos = _polarToCartesian(cx, cy, circleR * 0.55, midAngle);
        parts.push(
          `<text x="${pos.x}" y="${pos.y}" text-anchor="middle" dominant-baseline="central" ` +
            `font-size="${Math.round(r * 0.45)}" font-weight="700" fill="#fff" font-family="sans-serif">${style.label}</text>`
        );
      });
    }
    // 흰색 외곽선(전체 원 둘레) — 부채꼴 사이 경계도 살짝 정리되어 보이는 효과
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${circleR}" fill="none" stroke="#fff" stroke-width="2"/>`);
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}" ` +
    `viewBox="0 0 ${sizePx} ${sizePx}">` +
    `<g style="filter: drop-shadow(0 1px 1.5px rgba(0,0,0,0.4));">${parts.join("")}</g></svg>`
  );
}

const SUBWAY_ICON_SIZE_PX = 26;
const subwayIconCache = new Map(); // 요청사항: 같은 노선 조합 아이콘은 캐시해서 재사용

/** 정규화된 노선 배열에 대응하는 L.divIcon을 반환합니다(캐시 우선). */
function getSubwayIcon(normalizedLines) {
  const key = normalizedLines.join(",") || "__unknown__";
  if (subwayIconCache.has(key)) return subwayIconCache.get(key);

  const svg = buildSubwaySvgMarkup(normalizedLines, SUBWAY_ICON_SIZE_PX);
  const icon = L.divIcon({
    html: svg,
    className: "subway-svg-icon",
    iconSize: [SUBWAY_ICON_SIZE_PX, SUBWAY_ICON_SIZE_PX],
    iconAnchor: [SUBWAY_ICON_SIZE_PX / 2, SUBWAY_ICON_SIZE_PX / 2],
  });
  subwayIconCache.set(key, icon);
  return icon;
}

function enableTransitAnalysisButton() {
  el.btnTransitAnalysis.disabled = false;
  el.transitAnalysisHint.textContent = "버튼을 눌러 지하철 접근성을 분석해보세요.";
}

function disableTransitAnalysisButton() {
  el.btnTransitAnalysis.disabled = true;
  el.transitAnalysisHint.textContent = "실제 필지를 선택하면 분석할 수 있습니다.";
}

function showTransitStatus(message, kind) {
  el.transitStatus.textContent = message;
  el.transitStatus.hidden = false;
  el.transitStatus.className = `search-status ${kind}`;
}

function hideTransitStatus() {
  el.transitStatus.hidden = true;
  el.transitStatus.textContent = "";
}

/** 대중교통 분석 관련 지도 레이어/통계를 정리합니다 (버튼 상태는 건드리지 않음). */
function clearTransitAnalysis() {
  if (transitAnalysisAbortController) {
    transitAnalysisAbortController.abort();
    transitAnalysisAbortController = null;
  }
  if (transitLayer) {
    map.removeLayer(transitLayer);
    transitLayer = null;
  }
  transitAnalysisResult = null;
  _uncheckLayers("transit");
  el.transitSummary.hidden = true;
  el.transitWarnings.hidden = true;
  hideTransitStatus();
}

/** "지하철 접근성 분석" 버튼 클릭 핸들러. */
async function performTransitAnalysis() {
  if (!activeRealParcel || !activeRealParcel.centroid) {
    alert("먼저 실제 필지를 선택해 주세요.");
    return;
  }
  if (isTransitAnalysisInFlight) {
    return;
  }

  isTransitAnalysisInFlight = true;
  el.btnTransitAnalysis.disabled = true;

  if (transitAnalysisAbortController) {
    transitAnalysisAbortController.abort();
  }
  transitAnalysisAbortController = new AbortController();
  const requestId = ++transitAnalysisRequestId;

  const { longitude, latitude } = activeRealParcel.centroid;

  showTransitStatus("대중교통 접근성 분석 중...", "loading");
  el.transitSummary.hidden = true;

  const params = new URLSearchParams({ longitude: String(longitude), latitude: String(latitude) });

  try {
    const res = await fetch(`/api/transit/analysis?${params.toString()}`, {
      signal: transitAnalysisAbortController.signal,
    });
    const body = await res.json().catch(() => ({}));

    // 오래된 응답이 새 필지 위에 그려지지 않도록 request id로 확인합니다.
    if (requestId !== transitAnalysisRequestId) {
      return;
    }

    if (!res.ok) {
      showTransitStatus(body.detail || "대중교통 접근성 분석 중 오류가 발생했습니다.", "error");
      return;
    }

    hideTransitStatus();
    transitAnalysisResult = body;
    renderTransitLayer();
    renderTransitSummary();
    setLayerChecked("transit", true);
    el.transitSummary.hidden = false;
  } catch (err) {
    if (err.name === "AbortError") return;
    console.error(err);
    if (requestId === transitAnalysisRequestId) {
      showTransitStatus("네트워크 오류로 대중교통 분석에 실패했습니다. 인터넷 연결을 확인해주세요.", "error");
    }
  } finally {
    isTransitAnalysisInFlight = false;
    el.btnTransitAnalysis.disabled = false;
  }
}

/** 대중교통 분석 결과의 역들을 지도 위에 마커로 표시합니다 (최근접 역은 강조 표시).
 * 노선색·환승 분할 원형 마커로 표시합니다(요청사항) — 역 하나당 마커 하나만 생성하며
 * (station.lines는 백엔드에서 이미 같은 물리적 역으로 통합된 노선 배열입니다),
 * 노선별로 중복 마커를 그리지 않습니다. */
function renderTransitLayer() {
  if (transitLayer) {
    map.removeLayer(transitLayer);
    transitLayer = null;
  }
  if (!transitAnalysisResult) return;

  const nearestName = transitAnalysisResult.nearest_subway_station;
  const group = L.layerGroup();

  transitAnalysisResult.nearby_stations.forEach((station) => {
    const isNearest = station.name === nearestName && station.distance_m === transitAnalysisResult.nearest_subway_dist_m;
    const normalizedLines = normalizeAndSortLines(station.lines);
    const icon = getSubwayIcon(normalizedLines);
    const latlng = [station.latitude, station.longitude];

    if (isNearest) {
      // 최근접 역은 살짝 더 도드라지게 얇은 강조 테두리 원을 밑에 깔아줍니다(마커 자체 색은 그대로 유지).
      L.circleMarker(latlng, {
        radius: SUBWAY_ICON_SIZE_PX / 2 + 4,
        color: "#c0392b",
        weight: 2,
        fill: false,
        dashArray: "3,2",
      }).addTo(group);
    }

    const marker = L.marker(latlng, { icon, zIndexOffset: isNearest ? 1000 : 0 });

    const lineNamesForDisplay = normalizedLines.map((l) => l || "노선 정보 없음").join(", ");
    const distanceText = station.distance_m != null ? ` · ${station.distance_m}m` : "";
    const fullInfoHtml = `<strong>${station.name}</strong><br/>${lineNamesForDisplay}${isNearest ? " · 최근접 역" : ""}${distanceText}`;

    // 요청사항: 마커 클릭 또는 마우스 오버 시 역명+전체 노선명 표시
    marker.bindTooltip(fullInfoHtml, { direction: "top", offset: [0, -SUBWAY_ICON_SIZE_PX / 2 - 2] });
    marker.bindPopup(fullInfoHtml);
    marker.addTo(group);

    // 요청사항: 역 이름은 마커와 겹치지 않도록 옆(오른쪽)에 항상 별도로 표시.
    // 위 hover/click 툴팁과는 별개로, 항상 켜져 있는 작은 라벨입니다(인터랙션 없음).
    const labelIcon = L.divIcon({
      html: `<span class="subway-name-label-text">${station.name}</span>`,
      className: "subway-name-label-icon",
      iconSize: [1, 1],
      iconAnchor: [-(SUBWAY_ICON_SIZE_PX / 2 + 3), 5],
    });
    L.marker(latlng, { icon: labelIcon, interactive: false, zIndexOffset: -100 }).addTo(group);
  });

  transitLayer = group;
  applyLayerVisibility("transit");

  // 필지 경계는 항상 다른 분석 레이어들보다 위에 보이도록 유지
  if (realParcelLayer) {
    realParcelLayer.eachLayer((layer) => layer.bringToFront && layer.bringToFront());
  }
}

function renderTransitSummary() {
  if (!transitAnalysisResult) return;
  const r = transitAnalysisResult;

  el.transitNearestStation.textContent = r.nearest_subway_station || "1km 이내 역 없음";
  el.transitNearestDist.textContent = r.nearest_subway_dist_m != null ? `${r.nearest_subway_dist_m}m (직선거리)` : "정보 없음";
  el.transitNearestLines.textContent = r.nearest_subway_lines && r.nearest_subway_lines.length ? r.nearest_subway_lines.join(", ") : "정보 없음";
  el.transitCount500.textContent = `${r.subway_station_count_500m}개`;
  el.transitCount1km.textContent = `${r.subway_station_count_1km}개`;
  el.transitLineCount500.textContent = `${r.subway_line_count_500m}개`;
  el.transitLineCount1km.textContent = `${r.subway_line_count_1km}개`;

  const warnings = (r.data_status && r.data_status.warnings) || [];
  if (warnings.length > 0) {
    el.transitWarnings.textContent = `⚠ ${warnings.join(" / ")}`;
    el.transitWarnings.hidden = false;
  } else {
    el.transitWarnings.hidden = true;
  }
}

el.btnTransitAnalysis.addEventListener("click", performTransitAnalysis);

/* ------------------------------------------------------------------ */
/* 6.2단계: 대상지 접도·진입·경계 분석                                     */
/* ------------------------------------------------------------------ */

function enableBoundaryAnalysisButton() {
  el.btnBoundaryAnalysis.disabled = false;
  el.boundaryAnalysisHint.textContent = "버튼을 눌러 대상지 경계·접도를 분석해보세요.";
}

function disableBoundaryAnalysisButton() {
  el.btnBoundaryAnalysis.disabled = true;
  el.boundaryAnalysisHint.textContent = "실제 필지를 선택하면 분석할 수 있습니다.";
}

function showBoundaryStatus(message, kind) {
  el.boundaryStatus.textContent = message;
  el.boundaryStatus.hidden = false;
  el.boundaryStatus.className = `search-status ${kind}`;
}

function hideBoundaryStatus() {
  el.boundaryStatus.hidden = true;
  el.boundaryStatus.textContent = "";
}

/** 경계 분석 관련 지도 레이어/통계를 정리합니다 (버튼 상태는 건드리지 않음). */
function clearBoundaryAnalysis() {
  if (boundaryAnalysisAbortController) {
    boundaryAnalysisAbortController.abort();
    boundaryAnalysisAbortController = null;
  }
  if (boundaryLayer) {
    map.removeLayer(boundaryLayer);
    boundaryLayer = null;
  }
  boundaryAnalysisResult = null;
  _uncheckLayers("boundary");
  el.boundarySummary.hidden = true;
  el.boundaryWarnings.hidden = true;
  el.boundaryEntranceList.innerHTML = "";
  el.boundaryList.innerHTML = "";
  hideBoundaryStatus();
}

/** "경계·접도 분석" 버튼 클릭 핸들러. */
async function performBoundaryAnalysis() {
  if (!activeRealParcel || !activeRealParcel.geometry) {
    alert("먼저 실제 필지를 선택해 주세요.");
    return;
  }
  if (isBoundaryAnalysisInFlight) {
    return;
  }

  isBoundaryAnalysisInFlight = true;
  el.btnBoundaryAnalysis.disabled = true;

  if (boundaryAnalysisAbortController) {
    boundaryAnalysisAbortController.abort();
  }
  boundaryAnalysisAbortController = new AbortController();
  const requestId = ++boundaryAnalysisRequestId;

  showBoundaryStatus("대상지 경계·접도 분석 중...", "loading");
  el.boundarySummary.hidden = true;

  try {
    const res = await fetch("/api/boundary/analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pnu: activeRealParcel.pnu, geometry: activeRealParcel.geometry }),
      signal: boundaryAnalysisAbortController.signal,
    });
    const body = await res.json().catch(() => ({}));

    if (requestId !== boundaryAnalysisRequestId) {
      return; // 오래된 응답은 무시 (새 필지가 이미 선택된 상태)
    }

    if (!res.ok) {
      showBoundaryStatus(body.detail || "경계·접도 분석 중 오류가 발생했습니다.", "error");
      return;
    }

    hideBoundaryStatus();
    boundaryAnalysisResult = body;
    renderBoundaryLayer();
    renderBoundarySummary();
    setLayerChecked("boundary", true);
    el.boundarySummary.hidden = false;
  } catch (err) {
    if (err.name === "AbortError") return;
    console.error(err);
    if (requestId === boundaryAnalysisRequestId) {
      showBoundaryStatus("네트워크 오류로 경계·접도 분석에 실패했습니다. 인터넷 연결을 확인해주세요.", "error");
    }
  } finally {
    isBoundaryAnalysisInFlight = false;
    el.btnBoundaryAnalysis.disabled = false;
  }
}

/** 경계 구간·진입구 후보·지하철 접근 화살표를 지도에 그립니다. */
function renderBoundaryLayer() {
  if (boundaryLayer) {
    map.removeLayer(boundaryLayer);
    boundaryLayer = null;
  }
  if (!boundaryAnalysisResult) return;

  const group = L.layerGroup();

  boundaryAnalysisResult.boundaries.forEach((b) => {
    const isOpen = b.boundary_openness.final_value === "open";
    const color = BOUNDARY_DIRECTION_COLORS[b.boundary_direction] || "#7f8c8d";

    // ✅ 실제 경계 좌표(coordinates)로 진짜 선을 그립니다 (이전에는 방향을 나타내는
    // 점만 찍어서 어느 경계가 열려있는지 지도에서 확인하기 어려웠습니다 — 사용자 피드백 반영).
    if (b.coordinates && b.coordinates.length >= 2) {
      const latlngs = b.coordinates.map((c) => [c[1], c[0]]); // [lon,lat] -> Leaflet [lat,lon]
      const line = L.polyline(latlngs, {
        color: color,
        weight: isOpen ? 7 : 3,
        opacity: isOpen ? 0.95 : 0.5,
        dashArray: isOpen ? null : "4,6",
      });
      const widthText = b.road_width_m != null ? ` · 폭 ${b.road_width_m}m (${b.road_hierarchy || "위계 미상"})` : "";
      const frontageText = isOpen ? ` · 접도 길이 ${b.frontage_length_m}m` : "";
      line.bindTooltip(
        `<strong>${b.boundary_direction_label} (${isOpen ? "열린 경계" : "막힌 경계"})</strong>` +
          `${widthText}${frontageText}<br/>${b.design_recommendation}`,
        { className: "building-tooltip", sticky: true }
      );
      line.addTo(group);

      // 열린 경계는 중점에 방향 라벨도 함께 표시해 한눈에 보이게 합니다.
      if (isOpen) {
        const midIdx = Math.floor(latlngs.length / 2);
        const labelMarker = L.circleMarker(latlngs[midIdx], {
          radius: 5,
          color: color,
          weight: 2,
          fillColor: "#ffffff",
          fillOpacity: 1,
        });
        labelMarker.bindTooltip(b.boundary_direction_label, { permanent: false, className: "building-tooltip" });
        labelMarker.addTo(group);
      }
    }
  });

  // 지하철 접근 방향 화살표 (transitAnalysisResult가 있으면 그 최근접 역 방향으로 화살표 표시)
  if (activeRealParcel && activeRealParcel.centroid && transitAnalysisResult && transitAnalysisResult.nearest_subway_station) {
    const nearest = transitAnalysisResult.nearby_stations.find(
      (s) => s.name === transitAnalysisResult.nearest_subway_station && s.distance_m === transitAnalysisResult.nearest_subway_dist_m
    );
    if (nearest) {
      const arrow = L.polyline(
        [
          [activeRealParcel.centroid.latitude, activeRealParcel.centroid.longitude],
          [nearest.latitude, nearest.longitude],
        ],
        { color: "#c0392b", weight: 2, dashArray: "4,6", opacity: 0.8 }
      );
      arrow.bindTooltip(`지하철 접근 방향: ${nearest.name}역`, { className: "building-tooltip" });
      arrow.addTo(group);
    }
  }

  // 진입구 후보 마커 (해당 경계의 실제 좌표 중점에 표시 — 오프셋 추정 위치가 아니라 실제 위치)
  (boundaryAnalysisResult.entrance_candidates || []).forEach((candidate) => {
    const boundary = boundaryAnalysisResult.boundaries.find((b) => b.boundary_id === candidate.boundary_id);
    if (!boundary || !boundary.coordinates || boundary.coordinates.length < 2) return;

    const style = ENTRANCE_CANDIDATE_ICONS[candidate.candidate_type] || { color: "#333", label: candidate.candidate_type };
    const coords = boundary.coordinates;
    const midIdx = Math.floor(coords.length / 2);
    const midPoint = coords[midIdx];

    const marker = L.circleMarker([midPoint[1], midPoint[0]], {
      radius: 9,
      color: style.color,
      weight: 3,
      fillColor: "#ffffff",
      fillOpacity: 1,
    });
    marker.bindTooltip(
      `<strong>${style.label}</strong> (제안, 검토 필요)<br/>${candidate.rationale}`,
      { className: "building-tooltip", sticky: true }
    );
    marker.addTo(group);
  });

  boundaryLayer = group;
  applyLayerVisibility("boundary");

  if (realParcelLayer) {
    realParcelLayer.eachLayer((layer) => layer.bringToFront && layer.bringToFront());
  }
}

function renderBoundarySummary() {
  if (!boundaryAnalysisResult) return;

  // 진입구 후보 목록
  el.boundaryEntranceList.innerHTML = "";
  const candidates = boundaryAnalysisResult.entrance_candidates || [];
  if (candidates.length === 0) {
    const p = document.createElement("p");
    p.className = "panel-hint";
    p.textContent = "열린 경계(도로에 접한 경계)가 없어 진입구 후보를 제안할 수 없습니다.";
    el.boundaryEntranceList.appendChild(p);
  } else {
    candidates.forEach((c) => {
      const style = ENTRANCE_CANDIDATE_ICONS[c.candidate_type] || { color: "#333", label: c.candidate_type };
      const item = document.createElement("div");
      item.className = "boundary-entrance-item";
      const swatch = document.createElement("span");
      swatch.className = "boundary-entrance-swatch";
      swatch.style.backgroundColor = style.color;
      const text = document.createElement("span");
      text.textContent = `${style.label}: ${c.rationale}`;
      item.appendChild(swatch);
      item.appendChild(text);
      el.boundaryEntranceList.appendChild(item);
    });
  }

  // 경계 구간별 상세
  el.boundaryList.innerHTML = "";
  boundaryAnalysisResult.boundaries.forEach((b) => {
    const isOpen = b.boundary_openness.final_value === "open";
    const color = BOUNDARY_DIRECTION_COLORS[b.boundary_direction] || "#7f8c8d";

    const item = document.createElement("div");
    item.className = "boundary-item";

    const header = document.createElement("div");
    header.className = "boundary-item-header";
    const swatch = document.createElement("span");
    swatch.className = "boundary-item-swatch";
    swatch.style.backgroundColor = color;
    const title = document.createElement("span");
    title.textContent = `${b.boundary_direction_label} (${b.boundary_length_m}m)`;
    const badge = document.createElement("span");
    badge.className = `boundary-item-badge ${isOpen ? "open" : "closed"}`;
    badge.textContent = isOpen ? "열린 경계" : "막힌 경계";
    header.appendChild(swatch);
    header.appendChild(title);
    header.appendChild(badge);

    const detail = document.createElement("div");
    detail.className = "boundary-item-detail";
    if (isOpen) {
      const widthText = b.road_width_m != null ? `${b.road_width_m}m (GIS 추정)` : "정보 없음";
      const hierarchyText = b.road_hierarchy || "정보 없음";
      detail.textContent =
        `접도 길이: ${b.frontage_length_m}m · 도로 폭: ${widthText} · 도로 위계: ${hierarchyText} · ` +
        `신뢰도: ${b.confidence_level}`;
    } else {
      detail.textContent = `신뢰도: ${b.confidence_level} (인접 건물·필지로 추정, 별도 확인 안 함)`;
    }

    const sentence = document.createElement("div");
    sentence.className = "boundary-item-sentence";
    sentence.textContent = b.design_recommendation;

    item.appendChild(header);
    item.appendChild(detail);
    item.appendChild(sentence);
    el.boundaryList.appendChild(item);
  });

  const warnings = (boundaryAnalysisResult.data_status && boundaryAnalysisResult.data_status.warnings) || [];
  if (warnings.length > 0) {
    el.boundaryWarnings.textContent = `⚠ ${warnings.join(" / ")}`;
    el.boundaryWarnings.hidden = false;
  } else {
    el.boundaryWarnings.hidden = true;
  }
}

el.btnBoundaryAnalysis.addEventListener("click", performBoundaryAnalysis);

/* ------------------------------------------------------------------ */
/* 7.1단계: 방위·일조·주변 건물 그림자 분석                                 */
/* ------------------------------------------------------------------ */

let shadowNorthIndicatorEl = null;

function enableShadowAnalysisButton() {
  el.btnShadowAnalysis.disabled = false;
  el.shadowAnalysisHint.textContent = "버튼을 눌러 일조·그림자를 분석해보세요.";
}

function disableShadowAnalysisButton() {
  el.btnShadowAnalysis.disabled = true;
  el.shadowAnalysisHint.textContent = "실제 필지를 선택하면 분석할 수 있습니다.";
}

function showShadowStatus(message, kind) {
  el.shadowStatus.textContent = message;
  el.shadowStatus.hidden = false;
  el.shadowStatus.className = `search-status ${kind}`;
}

function hideShadowStatus() {
  el.shadowStatus.hidden = true;
  el.shadowStatus.textContent = "";
}

function removeNorthIndicator() {
  if (shadowNorthIndicatorEl && shadowNorthIndicatorEl.parentNode) {
    shadowNorthIndicatorEl.parentNode.removeChild(shadowNorthIndicatorEl);
  }
  shadowNorthIndicatorEl = null;
}

/** 일조·그림자 분석 관련 지도 레이어/통계를 정리합니다 (버튼 상태는 건드리지 않음). */
function clearShadowAnalysis() {
  if (shadowAnalysisAbortController) {
    shadowAnalysisAbortController.abort();
    shadowAnalysisAbortController = null;
  }
  if (shadowLayer) {
    map.removeLayer(shadowLayer);
    shadowLayer = null;
  }
  removeNorthIndicator();
  shadowAnalysisResult = null;
  _uncheckLayers("shadow_instant", "shadow_heatmap");
  el.shadowSummary.hidden = true;
  el.shadowWarnings.hidden = true;
  el.shadowLegend.innerHTML = "";
  el.shadowRegionSentences.innerHTML = "";
  hideShadowStatus();
}

/** "일조·그림자 분석" 버튼 클릭 핸들러. */
async function performShadowAnalysis() {
  if (!activeRealParcel || !activeRealParcel.geometry) {
    alert("먼저 실제 필지를 선택해 주세요.");
    return;
  }
  if (isShadowAnalysisInFlight) {
    return;
  }

  isShadowAnalysisInFlight = true;
  el.btnShadowAnalysis.disabled = true;

  if (shadowAnalysisAbortController) {
    shadowAnalysisAbortController.abort();
  }
  shadowAnalysisAbortController = new AbortController();
  const requestId = ++shadowAnalysisRequestId;

  showShadowStatus("일조·그림자 분석 중... (계산량이 많아 몇 초 걸릴 수 있습니다)", "loading");
  el.shadowSummary.hidden = true;

  try {
    const res = await fetch("/api/shadow/analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pnu: activeRealParcel.pnu, geometry: activeRealParcel.geometry }),
      signal: shadowAnalysisAbortController.signal,
    });
    const body = await res.json().catch(() => ({}));

    if (requestId !== shadowAnalysisRequestId) {
      return;
    }

    if (!res.ok) {
      showShadowStatus(body.detail || "일조·그림자 분석 중 오류가 발생했습니다.", "error");
      return;
    }

    hideShadowStatus();
    shadowAnalysisResult = body;
    shadowDisplayMode = "instant";
    el.btnShadowModeInstant.classList.add("active");
    el.btnShadowModeHeatmap.classList.remove("active");
    renderShadowLayer();
    renderShadowSummary();
    setLayerChecked("shadow_instant", true);
    el.shadowSummary.hidden = false;
  } catch (err) {
    if (err.name === "AbortError") return;
    console.error(err);
    if (requestId === shadowAnalysisRequestId) {
      showShadowStatus("네트워크 오류로 일조·그림자 분석에 실패했습니다. 인터넷 연결을 확인해주세요.", "error");
    }
  } finally {
    isShadowAnalysisInFlight = false;
    el.btnShadowAnalysis.disabled = false;
  }
}

function findInstantShadow() {
  if (!shadowAnalysisResult) return null;
  return shadowAnalysisResult.instant_shadows.find(
    (s) => s.season === shadowSelectedSeason && s.time_label === shadowSelectedTime
  );
}

const SHADOW_RISK_COLORS = { low: "#27ae60", medium: "#f39c12", high: "#c0392b", unknown: "#9E9E9E" };
const SHADOW_RISK_LABELS = { low: "일조 우수", medium: "일조 보통", high: "상시 음영 가능성" };

/** 진북 표시(화면 고정, 지도가 회전하지 않는 현재 구조에서는 항상 "위쪽=진북"). */
function renderNorthIndicator() {
  removeNorthIndicator();
  if (!shadowAnalysisResult) return;
  shadowNorthIndicatorEl = document.createElement("div");
  shadowNorthIndicatorEl.className = "shadow-north-indicator";
  shadowNorthIndicatorEl.textContent = "N ↑";
  shadowNorthIndicatorEl.title = "진북 (지도 회전 기능이 없어 화면 위쪽 = 진북)";
  document.querySelector(".map-container").appendChild(shadowNorthIndicatorEl);
}

/** 순간 그림자 또는 일조시간 히트맵을 지도에 그립니다. */
function renderShadowLayer() {
  if (shadowLayer) {
    map.removeLayer(shadowLayer);
    shadowLayer = null;
  }
  renderNorthIndicator();
  if (!shadowAnalysisResult) return;

  const group = L.layerGroup();

  if (shadowDisplayMode === "instant") {
    const snapshot = findInstantShadow();
    if (snapshot) {
      snapshot.shadow_geometries.forEach((geom) => {
        const layer = L.geoJSON(geom, {
          style: { color: "#2c3e50", weight: 1, fillColor: "#2c3e50", fillOpacity: 0.35 },
        });
        layer.addTo(group);
      });

      // 태양 방향 화살표 (필지 중심 -> 태양이 있는 방위 쪽으로)
      if (activeRealParcel && activeRealParcel.centroid) {
        const centerLatLng = [activeRealParcel.centroid.latitude, activeRealParcel.centroid.longitude];
        const bearingRad = (snapshot.sun_azimuth_deg * Math.PI) / 180;
        const offsetDeg = 0.0008;
        const dLat = Math.cos(bearingRad) * offsetDeg;
        const dLon = (Math.sin(bearingRad) * offsetDeg) / Math.cos((centerLatLng[0] * Math.PI) / 180);
        const sunLatLng = [centerLatLng[0] + dLat, centerLatLng[1] + dLon];

        const arrow = L.polyline([centerLatLng, sunLatLng], {
          color: "#f1c40f",
          weight: 3,
          opacity: 0.9,
        });
        arrow.bindTooltip(
          `태양 방향 (고도각 ${snapshot.sun_altitude_deg}°, 방위각 ${snapshot.sun_azimuth_deg}°)`,
          { className: "building-tooltip" }
        );
        arrow.addTo(group);

        const sunDot = L.circleMarker(sunLatLng, { radius: 6, color: "#f39c12", fillColor: "#f1c40f", fillOpacity: 1 });
        sunDot.addTo(group);
      }
    }
  } else {
    // 히트맵: 그리드 셀을 shadow_risk 색상으로 표시
    shadowAnalysisResult.grid_cells.forEach((cell) => {
      const color = SHADOW_RISK_COLORS[cell.shadow_risk] || SHADOW_RISK_COLORS.unknown;
      const marker = L.circleMarker([cell.latitude, cell.longitude], {
        radius: 4,
        color: color,
        weight: 1,
        fillColor: color,
        fillOpacity: 0.85,
      });
      marker.bindTooltip(
        `<strong>${SHADOW_RISK_LABELS[cell.shadow_risk] || cell.shadow_risk}</strong><br/>` +
          `봄 ${cell.sun_hours_spring ?? "-"}h · 여름 ${cell.sun_hours_summer ?? "-"}h · ` +
          `가을 ${cell.sun_hours_autumn ?? "-"}h · 겨울 ${cell.sun_hours_winter ?? "-"}h`,
        { className: "building-tooltip", sticky: true }
      );
      marker.addTo(group);
    });
  }

  shadowLayer = group;
  applyLayerVisibility(shadowDisplayMode === "heatmap" ? "shadow_heatmap" : "shadow_instant");

  if (realParcelLayer) {
    realParcelLayer.eachLayer((layer) => layer.bringToFront && layer.bringToFront());
  }
}

function renderShadowLegend() {
  el.shadowLegend.innerHTML = "";
  if (shadowDisplayMode !== "heatmap") return;

  Object.entries(SHADOW_RISK_LABELS).forEach(([key, label]) => {
    const item = document.createElement("div");
    item.className = "legend-item";
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.backgroundColor = SHADOW_RISK_COLORS[key];
    const text = document.createElement("span");
    text.textContent = label;
    item.appendChild(swatch);
    item.appendChild(text);
    el.shadowLegend.appendChild(item);
  });
}

function renderShadowSummary() {
  if (!shadowAnalysisResult) return;
  const r = shadowAnalysisResult;

  if (shadowDisplayMode === "instant") {
    const snapshot = findInstantShadow();
    el.shadowSunInfo.textContent = snapshot
      ? `${snapshot.season_label} ${snapshot.time_label} · 고도각 ${snapshot.sun_altitude_deg}° · 방위각 ${snapshot.sun_azimuth_deg}°`
      : "이 시각의 태양 정보 없음 (야간이거나 데이터 없음)";
  } else {
    el.shadowSunInfo.textContent = "히트맵 모드 (그리드별 계절 평균 일조시간 기준)";
  }

  const ds = r.data_status;
  el.shadowGridInfo.textContent = `${ds.grid_cell_count}개 셀 (${ds.grid_spacing_m}m 간격)`;
  el.shadowHeightInfo.textContent =
    `전체 ${ds.buildings_considered}동 중 실측 ${ds.buildings_with_measured_height}동, ` +
    `추정 ${ds.buildings_with_estimated_height}동, 제외 ${ds.buildings_excluded_no_height_data}동`;

  // 구역별 설계 문장 (중복 제거해서 한 번씩만 표시)
  el.shadowRegionSentences.innerHTML = "";
  const uniqueSentences = [...new Set(r.grid_cells.map((c) => c.design_recommendation).filter(Boolean))];
  uniqueSentences.forEach((sentence) => {
    const item = document.createElement("div");
    item.className = "boundary-item";
    item.textContent = sentence;
    el.shadowRegionSentences.appendChild(item);
  });

  renderShadowLegend();

  const warnings = ds.warnings || [];
  if (warnings.length > 0) {
    el.shadowWarnings.textContent = `⚠ ${warnings.join(" / ")}`;
    el.shadowWarnings.hidden = false;
  } else {
    el.shadowWarnings.hidden = true;
  }
}

function switchShadowMode(mode) {
  if (mode === shadowDisplayMode) return;
  shadowDisplayMode = mode;
  el.btnShadowModeInstant.classList.toggle("active", mode === "instant");
  el.btnShadowModeHeatmap.classList.toggle("active", mode === "heatmap");
  renderShadowLayer();
  renderShadowSummary();
  if (layerCheckedState.shadow_instant || layerCheckedState.shadow_heatmap) {
    setLayerChecked(mode === "heatmap" ? "shadow_heatmap" : "shadow_instant", true);
  }
}

el.btnShadowAnalysis.addEventListener("click", performShadowAnalysis);
el.btnShadowModeInstant.addEventListener("click", () => switchShadowMode("instant"));
el.btnShadowModeHeatmap.addEventListener("click", () => switchShadowMode("heatmap"));
el.shadowSeasonSelect.addEventListener("change", (e) => {
  shadowSelectedSeason = e.target.value;
  if (shadowAnalysisResult) {
    renderShadowLayer();
    renderShadowSummary();
  }
});
el.shadowTimeSelect.addEventListener("change", (e) => {
  shadowSelectedTime = e.target.value;
  if (shadowAnalysisResult) {
    renderShadowLayer();
    renderShadowSummary();
  }
});

/* ------------------------------------------------------------------ */
/* 7.2단계: 대상지 지형·표고·경사 분석                                     */
/* ------------------------------------------------------------------ */

const TERRAIN_CLASS_COLORS = { flat: "#27ae60", gentle: "#a9d15c", moderate: "#f39c12", steep: "#c0392b" };
const TERRAIN_CLASS_LABELS = { flat: "평탄(0~5%)", gentle: "완경사(5~15%)", moderate: "중경사(15~30%)", steep: "급경사(30%+)" };

function enableTerrainAnalysisButton() {
  el.btnTerrainAnalysis.disabled = false;
  el.terrainAnalysisHint.textContent = "버튼을 눌러 지형·표고를 분석해보세요.";
}

function disableTerrainAnalysisButton() {
  el.btnTerrainAnalysis.disabled = true;
  el.terrainAnalysisHint.textContent = "실제 필지를 선택하면 분석할 수 있습니다.";
}

function showTerrainStatus(message, kind) {
  el.terrainStatus.textContent = message;
  el.terrainStatus.hidden = false;
  el.terrainStatus.className = `search-status ${kind}`;
}

function hideTerrainStatus() {
  el.terrainStatus.hidden = true;
  el.terrainStatus.textContent = "";
}

function clearTerrainAnalysis() {
  if (terrainAnalysisAbortController) {
    terrainAnalysisAbortController.abort();
    terrainAnalysisAbortController = null;
  }
  if (terrainFillLayer) {
    map.removeLayer(terrainFillLayer);
    terrainFillLayer = null;
  }
  if (terrainContourLayer) {
    map.removeLayer(terrainContourLayer);
    terrainContourLayer = null;
  }
  terrainAnalysisResult = null;
  _uncheckLayers("terrain_elevation", "terrain_slope", "terrain_contour");
  el.terrainSummary.hidden = true;
  el.terrainWarnings.hidden = true;
  el.terrainLegend.innerHTML = "";
  el.terrainBoundarySentences.innerHTML = "";
  hideTerrainStatus();
}

async function performTerrainAnalysis() {
  if (!activeRealParcel || !activeRealParcel.geometry) {
    alert("먼저 실제 필지를 선택해 주세요.");
    return;
  }
  if (isTerrainAnalysisInFlight) return;

  isTerrainAnalysisInFlight = true;
  el.btnTerrainAnalysis.disabled = true;

  if (terrainAnalysisAbortController) terrainAnalysisAbortController.abort();
  terrainAnalysisAbortController = new AbortController();
  const requestId = ++terrainAnalysisRequestId;

  showTerrainStatus("지형·표고 분석 중... (계산량이 많아 몇 초 걸릴 수 있습니다)", "loading");
  el.terrainSummary.hidden = true;

  const rangeM = parseFloat(el.terrainRangeSelect.value) || 250;
  const spacingM = parseFloat(el.terrainSpacingInput.value) || 5;

  // 6.2단계 결과가 이미 있으면 함께 보내 경계별 레벨차까지 계산 (없어도 지형 분석 자체는 동작)
  const requestBody = {
    pnu: activeRealParcel.pnu,
    geometry: activeRealParcel.geometry,
    range_m: rangeM,
    grid_spacing_m: spacingM,
  };
  if (boundaryAnalysisResult) {
    requestBody.boundary_result = boundaryAnalysisResult;
  }

  try {
    const res = await fetch("/api/terrain/analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: terrainAnalysisAbortController.signal,
    });
    const body = await res.json().catch(() => ({}));

    if (requestId !== terrainAnalysisRequestId) return;

    if (!res.ok) {
      showTerrainStatus(body.detail || "지형·표고 분석 중 오류가 발생했습니다.", "error");
      return;
    }

    hideTerrainStatus();
    terrainAnalysisResult = body;

    if (body.status !== "success") {
      showTerrainStatus("이 지역에는 지형 데이터가 없습니다 (데이터 커버리지 밖일 수 있습니다).", "empty");
      return;
    }

    renderTerrainFillLayer();
    renderTerrainContourLayer();
    renderTerrainSummary();
    setLayerChecked("terrain_elevation", true);
    setLayerChecked("terrain_contour", true);
    el.terrainSummary.hidden = false;
  } catch (err) {
    if (err.name === "AbortError") return;
    console.error(err);
    if (requestId === terrainAnalysisRequestId) {
      showTerrainStatus("네트워크 오류로 지형·표고 분석에 실패했습니다. 인터넷 연결을 확인해주세요.", "error");
    }
  } finally {
    isTerrainAnalysisInFlight = false;
    el.btnTerrainAnalysis.disabled = false;
  }
}

function _elevationColor(value, min, max) {
  if (min === max) return "#3498db";
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
  // 파랑(낮음) -> 초록 -> 노랑 -> 빨강(높음)
  const stops = [
    [0.0, [52, 152, 219]],
    [0.33, [39, 174, 96]],
    [0.66, [241, 196, 15]],
    [1.0, [192, 57, 43]],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (t >= t0 && t <= t1) {
      const localT = (t - t0) / (t1 - t0 || 1);
      const r = Math.round(c0[0] + (c1[0] - c0[0]) * localT);
      const g = Math.round(c0[1] + (c1[1] - c0[1]) * localT);
      const b = Math.round(c0[2] + (c1[2] - c0[2]) * localT);
      return `rgb(${r},${g},${b})`;
    }
  }
  return "#3498db";
}

/** 사용성 개선: "지형 표고"/"경사도"는 서로 배타적인 하나의 채움(fill) 레이어로,
 * "등고선"은 독립적으로 켜고 끌 수 있는 별도 레이어로 분리했습니다(레이어 패널 요구사항:
 * 등고선 같은 보조 벡터 레이어는 다른 주 레이어와 중첩 가능해야 함). */
function renderTerrainFillLayer() {
  if (terrainFillLayer) {
    map.removeLayer(terrainFillLayer);
    terrainFillLayer = null;
  }
  if (!terrainAnalysisResult || terrainAnalysisResult.status !== "success") return;

  const group = L.layerGroup();
  const r = terrainAnalysisResult;

  if (terrainDisplayMode === "elevation") {
    const minEl = r.summary.min_elevation_m;
    const maxEl = r.summary.max_elevation_m;
    r.grid_cells.forEach((cell) => {
      if (cell.elevation_m == null) return;
      const color = _elevationColor(cell.elevation_m, minEl, maxEl);
      const isSurrounding = cell.zone === "surrounding";
      const marker = L.circleMarker([cell.latitude, cell.longitude], {
        radius: isSurrounding ? 3 : 4,
        color: color,
        weight: 1,
        fillColor: color,
        fillOpacity: isSurrounding ? 0.55 : 0.85,
      });
      marker.bindTooltip(
        `표고 ${cell.elevation_m}m${isSurrounding ? " (주변)" : " (내부)"}`,
        { className: "building-tooltip", sticky: true }
      );
      marker.addTo(group);
    });
  } else if (terrainDisplayMode === "slope") {
    r.grid_cells.forEach((cell) => {
      if (!cell.terrain_class) return;
      const color = TERRAIN_CLASS_COLORS[cell.terrain_class] || "#9E9E9E";
      const isSurrounding = cell.zone === "surrounding";
      const marker = L.circleMarker([cell.latitude, cell.longitude], {
        radius: isSurrounding ? 3 : 4,
        color: color,
        weight: 1,
        fillColor: color,
        fillOpacity: isSurrounding ? 0.55 : 0.85,
      });
      marker.bindTooltip(
        `${TERRAIN_CLASS_LABELS[cell.terrain_class] || cell.terrain_class}<br/>경사 ${cell.slope_percent}% · 향 ${cell.aspect_direction || "-"}${isSurrounding ? " (주변)" : " (내부)"}`,
        { className: "building-tooltip", sticky: true }
      );
      marker.addTo(group);
    });
  }

  // 최고점/최저점 (필지 내부 기준, fill 모드에서 항상 표시)
  if (r.highest_point) {
    const hp = L.circleMarker([r.highest_point.latitude, r.highest_point.longitude], {
      radius: 8, color: "#c0392b", weight: 3, fillColor: "#ffffff", fillOpacity: 1,
    });
    hp.bindTooltip(`최고점: ${r.highest_point.elevation_m}m`, { className: "building-tooltip", permanent: false });
    hp.addTo(group);
  }
  if (r.lowest_point) {
    const lp = L.circleMarker([r.lowest_point.latitude, r.lowest_point.longitude], {
      radius: 8, color: "#2980b9", weight: 3, fillColor: "#ffffff", fillOpacity: 1,
    });
    lp.bindTooltip(`최저점: ${r.lowest_point.elevation_m}m`, { className: "building-tooltip", permanent: false });
    lp.addTo(group);
  }

  // 주 경사 방향 화살표 (최고점 -> 최저점)
  if (r.highest_point && r.lowest_point) {
    const arrow = L.polyline(
      [
        [r.highest_point.latitude, r.highest_point.longitude],
        [r.lowest_point.latitude, r.lowest_point.longitude],
      ],
      { color: "#34495e", weight: 2, dashArray: "6,4", opacity: 0.7 }
    );
    arrow.bindTooltip(`주 경사 방향: ${r.summary.dominant_slope_direction || "-"}`, { className: "building-tooltip" });
    arrow.addTo(group);
  }

  terrainFillLayer = group;
  applyLayerVisibility("terrain_elevation");
  applyLayerVisibility("terrain_slope");
  if (realParcelLayer) {
    realParcelLayer.eachLayer((layer) => layer.bringToFront && layer.bringToFront());
  }
}

function renderTerrainContourLayer() {
  if (terrainContourLayer) {
    map.removeLayer(terrainContourLayer);
    terrainContourLayer = null;
  }
  if (!terrainAnalysisResult || terrainAnalysisResult.status !== "success") return;

  const group = L.layerGroup();
  terrainAnalysisResult.contour_lines.forEach((feature) => {
    const layer = L.geoJSON(feature, { style: { color: "#8d6e63", weight: 1.5, opacity: 0.8 } });
    layer.bindTooltip(`${feature.properties.elevation_m}m`, { className: "building-tooltip", sticky: true });
    layer.addTo(group);
  });

  terrainContourLayer = group;
  applyLayerVisibility("terrain_contour");
}

function renderTerrainLegend() {
  el.terrainLegend.innerHTML = "";
  if (terrainDisplayMode === "slope") {
    Object.entries(TERRAIN_CLASS_LABELS).forEach(([key, label]) => {
      const item = document.createElement("div");
      item.className = "legend-item";
      const swatch = document.createElement("span");
      swatch.className = "legend-swatch";
      swatch.style.backgroundColor = TERRAIN_CLASS_COLORS[key];
      const text = document.createElement("span");
      text.textContent = label;
      item.appendChild(swatch);
      item.appendChild(text);
      el.terrainLegend.appendChild(item);
    });
  } else if (terrainDisplayMode === "elevation") {
    const item = document.createElement("div");
    item.className = "legend-item";
    item.textContent = "파랑(낮음) → 초록 → 노랑 → 빨강(높음)";
    el.terrainLegend.appendChild(item);
  }
}

function renderTerrainSummary() {
  if (!terrainAnalysisResult || terrainAnalysisResult.status !== "success") return;
  const s = terrainAnalysisResult.summary;

  el.terrainElevationRange.textContent =
    s.min_elevation_m != null ? `${s.min_elevation_m}m ~ ${s.max_elevation_m}m (평균 ${s.mean_elevation_m}m)` : "정보 없음";
  el.terrainElevationDiff.textContent = s.elevation_difference_m != null ? `${s.elevation_difference_m}m` : "정보 없음";
  el.terrainSlopeInfo.textContent =
    s.mean_slope_percent != null ? `평균 ${s.mean_slope_percent}% / 최대 ${s.max_slope_percent}%` : "정보 없음";
  el.terrainSlopeDirection.textContent = s.dominant_slope_direction || "뚜렷하지 않음(평탄)";
  el.terrainConfidence.textContent = s.terrain_confidence;

  el.terrainDesignSentence.textContent = s.design_recommendation;

  el.terrainBoundarySentences.innerHTML = "";
  (terrainAnalysisResult.boundary_terrain || []).forEach((bt) => {
    if (!bt.slope_note) return;
    const item = document.createElement("div");
    item.className = "boundary-item";
    item.textContent = bt.slope_note;
    el.terrainBoundarySentences.appendChild(item);
  });

  renderTerrainLegend();

  const warnings = (terrainAnalysisResult.data_status && terrainAnalysisResult.data_status.warnings) || [];
  if (warnings.length > 0) {
    el.terrainWarnings.textContent = `⚠ ${warnings.join(" / ")}`;
    el.terrainWarnings.hidden = false;
  } else {
    el.terrainWarnings.hidden = true;
  }
}

function switchTerrainMode(mode) {
  if (mode === terrainDisplayMode) return;
  terrainDisplayMode = mode;
  el.btnTerrainModeElevation.classList.toggle("active", mode === "elevation");
  el.btnTerrainModeSlope.classList.toggle("active", mode === "slope");
  renderTerrainFillLayer();
  renderTerrainLegend();
  // 사용성 개선: 지형 표고/경사도는 지도 레이어 패널에서 서로 배타적인 하나의 항목이므로,
  // 모드를 바꾸면 현재 켜진 쪽의 체크 상태도 함께 맞춰줍니다.
  if (layerCheckedState.terrain_elevation || layerCheckedState.terrain_slope) {
    setLayerChecked(mode === "elevation" ? "terrain_elevation" : "terrain_slope", true);
  }
}

el.btnTerrainAnalysis.addEventListener("click", performTerrainAnalysis);
el.btnTerrainModeElevation.addEventListener("click", () => switchTerrainMode("elevation"));
el.btnTerrainModeSlope.addEventListener("click", () => switchTerrainMode("slope"));

/* ------------------------------------------------------------------ */
/* 7.3단계: 대상지 조망·시야 개방성 분석                                   */
/* ------------------------------------------------------------------ */

const VIEW_TYPE_COLORS = { "매우 개방": "#1e8449", "개방": "#27ae60", "부분 개방": "#f39c12", "차폐": "#c0392b" };

function enableVisibilityAnalysisButton() {
  el.btnVisibilityAnalysis.disabled = false;
  el.btnVisibilityUserPoint.disabled = false;
  el.visibilityAnalysisHint.textContent = "버튼을 눌러 조망·시야 개방성을 분석해보세요.";
}

function disableVisibilityAnalysisButton() {
  el.btnVisibilityAnalysis.disabled = true;
  el.btnVisibilityUserPoint.disabled = true;
  el.visibilityAnalysisHint.textContent = "실제 필지를 선택하면 분석할 수 있습니다.";
}

function showVisibilityStatus(message, kind) {
  el.visibilityStatus.textContent = message;
  el.visibilityStatus.hidden = false;
  el.visibilityStatus.className = `search-status ${kind}`;
}

function hideVisibilityStatus() {
  el.visibilityStatus.hidden = true;
  el.visibilityStatus.textContent = "";
}

function clearVisibilityAnalysis() {
  if (visibilityAnalysisAbortController) {
    visibilityAnalysisAbortController.abort();
    visibilityAnalysisAbortController = null;
  }
  if (visibilityLayer) {
    map.removeLayer(visibilityLayer);
    visibilityLayer = null;
  }
  visibilityAnalysisResult = null;
  _uncheckLayers("visibility");
  visibilitySelectedViewpointId = null;
  isSelectingUserViewpoint = false;
  userViewpointCoords = null;
  el.btnVisibilityUserPoint.textContent = "지도에서 관찰점 직접 선택";
  el.visibilitySummary.hidden = true;
  el.visibilityWarnings.hidden = true;
  el.visibilityLegend.innerHTML = "";
  el.visibilitySentences.innerHTML = "";
  el.visibilityInsights.innerHTML = "";
  hideVisibilityStatus();
}

el.btnVisibilityUserPoint.addEventListener("click", () => {
  isSelectingUserViewpoint = !isSelectingUserViewpoint;
  if (isSelectingUserViewpoint) {
    el.btnVisibilityUserPoint.textContent = "지도를 클릭해 관찰점 선택 (취소하려면 다시 클릭)";
  } else {
    el.btnVisibilityUserPoint.textContent = "지도에서 관찰점 직접 선택";
  }
});

function handleUserViewpointClick(latlng) {
  userViewpointCoords = { longitude: latlng.lng, latitude: latlng.lat };
  isSelectingUserViewpoint = false;
  el.btnVisibilityUserPoint.textContent = "관찰점 선택됨 (다시 누르면 재선택)";
  showVisibilityStatus("관찰점을 선택했습니다. '조망·시야 분석' 버튼을 눌러주세요.", "empty");
}

async function performVisibilityAnalysis() {
  if (!activeRealParcel || !activeRealParcel.geometry) {
    alert("먼저 실제 필지를 선택해 주세요.");
    return;
  }
  if (isVisibilityAnalysisInFlight) return;

  isVisibilityAnalysisInFlight = true;
  el.btnVisibilityAnalysis.disabled = true;

  if (visibilityAnalysisAbortController) visibilityAnalysisAbortController.abort();
  visibilityAnalysisAbortController = new AbortController();
  const requestId = ++visibilityAnalysisRequestId;

  showVisibilityStatus("조망·시야 개방성 분석 중... (계산량이 많아 몇 초 걸릴 수 있습니다)", "loading");
  el.visibilitySummary.hidden = true;

  const angleStep = parseFloat(el.visibilityAngleSelect.value) || 5;

  const requestBody = {
    pnu: activeRealParcel.pnu,
    geometry: activeRealParcel.geometry,
    angle_step_deg: angleStep,
  };
  // 6.2/7.2단계 결과가 이미 있으면 함께 보내 관찰점·문장을 풍부하게 만듭니다 (없어도 동작).
  if (boundaryAnalysisResult) requestBody.boundary_result = boundaryAnalysisResult;
  if (terrainAnalysisResult && terrainAnalysisResult.status === "success") requestBody.terrain_result = terrainAnalysisResult;
  if (userViewpointCoords) requestBody.user_viewpoint = userViewpointCoords;

  try {
    const res = await fetch("/api/visibility/analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: visibilityAnalysisAbortController.signal,
    });
    const body = await res.json().catch(() => ({}));

    if (requestId !== visibilityAnalysisRequestId) return;

    if (!res.ok) {
      showVisibilityStatus(body.detail || "조망·시야 분석 중 오류가 발생했습니다.", "error");
      return;
    }

    hideVisibilityStatus();
    visibilityAnalysisResult = body;

    if (body.status !== "success" || !body.viewpoints.length) {
      showVisibilityStatus("분석 가능한 관찰점을 찾지 못했습니다.", "empty");
      return;
    }

    visibilitySelectedViewpointId = body.viewpoints[0].viewpoint_id;
    visibilitySelectedHeight = 1.5;
    el.visibilityHeightSelect.value = "1.5";

    populateVisibilityViewpointSelect();
    renderVisibilityLayer();
    renderVisibilitySummary();
    setLayerChecked("visibility", true);
    el.visibilitySummary.hidden = false;
  } catch (err) {
    if (err.name === "AbortError") return;
    console.error(err);
    if (requestId === visibilityAnalysisRequestId) {
      showVisibilityStatus("네트워크 오류로 조망·시야 분석에 실패했습니다. 인터넷 연결을 확인해주세요.", "error");
    }
  } finally {
    isVisibilityAnalysisInFlight = false;
    el.btnVisibilityAnalysis.disabled = false;
  }
}

const VIEWPOINT_SOURCE_LABELS = {
  centroid: "필지 중심점",
  boundary_vertex: "경계 변곡점",
  boundary_midpoint: "도로 접한 경계 중점",
  highest_point: "최고점",
  lowest_point: "최저점",
  user: "직접 선택한 지점",
};

function populateVisibilityViewpointSelect() {
  el.visibilityViewpointSelect.innerHTML = "";
  (visibilityAnalysisResult.viewpoints || []).forEach((vp) => {
    const opt = document.createElement("option");
    opt.value = vp.viewpoint_id;
    opt.textContent = `${VIEWPOINT_SOURCE_LABELS[vp.source] || vp.source} (${vp.viewpoint_id})`;
    el.visibilityViewpointSelect.appendChild(opt);
  });
  el.visibilityViewpointSelect.value = visibilitySelectedViewpointId;
}

function currentVisibilityDirections() {
  if (!visibilityAnalysisResult) return [];
  return visibilityAnalysisResult.directions.filter(
    (d) => d.viewpoint_id === visibilitySelectedViewpointId && d.observer_height_m === visibilitySelectedHeight
  );
}

function renderVisibilityLayer() {
  if (visibilityLayer) {
    map.removeLayer(visibilityLayer);
    visibilityLayer = null;
  }
  if (!visibilityAnalysisResult) return;

  const group = L.layerGroup();

  // 전체 관찰점 표시 (작은 회색 점, 선택된 것은 강조)
  visibilityAnalysisResult.viewpoints.forEach((vp) => {
    const isSelected = vp.viewpoint_id === visibilitySelectedViewpointId;
    const marker = L.circleMarker([vp.latitude, vp.longitude], {
      radius: isSelected ? 8 : 5,
      color: isSelected ? "#8e44ad" : "#7f8c8d",
      weight: isSelected ? 3 : 1,
      fillColor: isSelected ? "#9b59b6" : "#bdc3c7",
      fillOpacity: 0.9,
    });
    marker.bindTooltip(`${VIEWPOINT_SOURCE_LABELS[vp.source] || vp.source}`, { className: "building-tooltip" });
    marker.addTo(group);
  });

  // 선택된 관찰점·높이의 방사형 시야선
  const directions = currentVisibilityDirections();
  const selectedVp = visibilityAnalysisResult.viewpoints.find((v) => v.viewpoint_id === visibilitySelectedViewpointId);
  const highlightedBuildingIds = new Set();

  if (selectedVp) {
    directions.forEach((d) => {
      const color = VIEW_TYPE_COLORS[d.view_type] || "#7f8c8d";
      const rayDistance = d.nearest_obstacle_distance_m || 200; // 열린 방향은 대표로 200m까지만 표시
      const bearingRad = (d.direction_deg * Math.PI) / 180;
      const offsetDeg = (rayDistance / 111320) * 1.05;
      const dLat = Math.cos(bearingRad) * offsetDeg;
      const dLon = (Math.sin(bearingRad) * offsetDeg) / Math.cos((selectedVp.latitude * Math.PI) / 180);
      const endLatLng = [selectedVp.latitude + dLat, selectedVp.longitude + dLon];

      const line = L.polyline([[selectedVp.latitude, selectedVp.longitude], endLatLng], {
        color: color,
        weight: 2,
        opacity: 0.65,
      });
      line.bindTooltip(
        `<strong>${d.direction_name} (${d.view_type})</strong><br/>${d.design_recommendation}`,
        { className: "building-tooltip", sticky: true }
      );
      line.addTo(group);

      if (d.obstacle_building_id) highlightedBuildingIds.add(d.obstacle_building_id);
    });
  }

  visibilityLayer = group;
  applyLayerVisibility("visibility");
  if (realParcelLayer) {
    realParcelLayer.eachLayer((layer) => layer.bringToFront && layer.bringToFront());
  }
}

function renderVisibilityLegend() {
  el.visibilityLegend.innerHTML = "";
  Object.entries(VIEW_TYPE_COLORS).forEach(([label, color]) => {
    const item = document.createElement("div");
    item.className = "legend-item";
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.backgroundColor = color;
    const text = document.createElement("span");
    text.textContent = label;
    item.appendChild(swatch);
    item.appendChild(text);
    el.visibilityLegend.appendChild(item);
  });
}

function renderVisibilitySummary() {
  if (!visibilityAnalysisResult) return;

  const summary = (visibilityAnalysisResult.viewpoint_summaries || []).find(
    (s) => s.viewpoint_id === visibilitySelectedViewpointId
  );
  el.visibilityOpenRatio.textContent = summary && summary.open_direction_ratio != null ? `${Math.round(summary.open_direction_ratio * 100)}%` : "정보 없음";
  el.visibilityBestDirection.textContent =
    summary && summary.best_direction_name ? `${summary.best_direction_name} (${summary.best_view_type})` : "정보 없음";

  renderVisibilityLegend();
  renderVisibilityRadarChart();

  // 설계 문장 (선택된 관찰점·높이 기준, 중복 제거)
  el.visibilitySentences.innerHTML = "";
  const directions = currentVisibilityDirections();
  const uniqueSentences = [...new Set(directions.map((d) => d.design_recommendation).filter(Boolean))];
  uniqueSentences.slice(0, 12).forEach((sentence) => {
    const item = document.createElement("div");
    item.className = "boundary-item";
    item.textContent = sentence;
    el.visibilitySentences.appendChild(item);
  });

  // 종합 인사이트
  el.visibilityInsights.innerHTML = "";
  (visibilityAnalysisResult.combined_insights || []).forEach((insight) => {
    const item = document.createElement("div");
    item.className = "boundary-item";
    item.textContent = insight.description;
    el.visibilityInsights.appendChild(item);
  });

  const warnings = (visibilityAnalysisResult.data_status && visibilityAnalysisResult.data_status.warnings) || [];
  if (warnings.length > 0) {
    el.visibilityWarnings.textContent = `⚠ ${warnings.join(" / ")}`;
    el.visibilityWarnings.hidden = false;
  } else {
    el.visibilityWarnings.hidden = true;
  }
}

const VISIBILITY_RADAR_DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/** 방향별 개방성 점수를 8방위 레이더 차트(SVG)로 그립니다 (요청사항: 새 차트 라이브러리 없이). */
function renderVisibilityRadarChart() {
  el.visibilityRadarChart.innerHTML = "";
  const directions = currentVisibilityDirections();
  if (!directions.length) return;

  // 방향별(8방위) 평균 openness_score 집계
  const scoresByDir = {};
  VISIBILITY_RADAR_DIRECTIONS.forEach((d) => (scoresByDir[d] = []));
  directions.forEach((d) => {
    if (scoresByDir[d.direction_name]) scoresByDir[d.direction_name].push(d.openness_score);
  });
  const avgScores = VISIBILITY_RADAR_DIRECTIONS.map((d) => {
    const arr = scoresByDir[d];
    return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  });

  const size = 180;
  const center = size / 2;
  const maxRadius = size / 2 - 24;
  const angleStep = (2 * Math.PI) / VISIBILITY_RADAR_DIRECTIONS.length;

  const toXY = (value, index) => {
    const angle = index * angleStep - Math.PI / 2; // 북쪽(N)이 위로 오도록
    const r = value * maxRadius;
    return [center + r * Math.cos(angle), center + r * Math.sin(angle)];
  };

  let svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`;

  // 배경 그리드(0.25/0.5/0.75/1.0 동심원)
  [0.25, 0.5, 0.75, 1.0].forEach((frac) => {
    svg += `<circle cx="${center}" cy="${center}" r="${frac * maxRadius}" fill="none" stroke="#ddd" stroke-width="1" />`;
  });

  // 축 선 + 라벨
  VISIBILITY_RADAR_DIRECTIONS.forEach((d, i) => {
    const [x, y] = toXY(1, i);
    svg += `<line x1="${center}" y1="${center}" x2="${x}" y2="${y}" stroke="#ddd" stroke-width="1" />`;
    const [lx, ly] = toXY(1.18, i);
    svg += `<text x="${lx}" y="${ly}" font-size="10" text-anchor="middle" dominant-baseline="middle" fill="#555">${d}</text>`;
  });

  // 데이터 폴리곤
  const points = avgScores.map((v, i) => toXY(v, i).join(",")).join(" ");
  svg += `<polygon points="${points}" fill="rgba(52,152,219,0.35)" stroke="#2980b9" stroke-width="2" />`;

  // 데이터 점
  avgScores.forEach((v, i) => {
    const [x, y] = toXY(v, i);
    svg += `<circle cx="${x}" cy="${y}" r="3" fill="#2980b9" />`;
  });

  svg += "</svg>";
  el.visibilityRadarChart.innerHTML = svg;
}

el.btnVisibilityAnalysis.addEventListener("click", performVisibilityAnalysis);

el.visibilityViewpointSelect.addEventListener("change", (e) => {
  visibilitySelectedViewpointId = e.target.value;
  renderVisibilityLayer();
  renderVisibilitySummary();
});
el.visibilityHeightSelect.addEventListener("change", (e) => {
  visibilitySelectedHeight = parseFloat(e.target.value);
  renderVisibilityLayer();
  renderVisibilitySummary();
});

/* ------------------------------------------------------------------ */
/* 7.4단계: 대상지 주변 환경 분석 (소음·통풍)                                */
/* ------------------------------------------------------------------ */

const NOISE_LEVEL_COLORS = { "낮음": "#27ae60", "보통": "#f39c12", "높음": "#c0392b" };
const VENTILATION_LEVEL_COLORS = {
  "통풍 가능성 높음": "#2980b9", "보통": "#f39c12", "건물 차폐 강함": "#7f8c8d",
};

function enableEnvironmentAnalysisButton() {
  el.btnEnvironmentAnalysis.disabled = false;
  el.environmentAnalysisHint.textContent = "버튼을 눌러 소음·통풍 가능성을 분석해보세요.";
}

function disableEnvironmentAnalysisButton() {
  el.btnEnvironmentAnalysis.disabled = true;
  el.environmentAnalysisHint.textContent = "실제 필지를 선택하면 분석할 수 있습니다.";
}

function showEnvironmentStatus(message, kind) {
  el.environmentStatus.textContent = message;
  el.environmentStatus.hidden = false;
  el.environmentStatus.className = `search-status ${kind}`;
}

function hideEnvironmentStatus() {
  el.environmentStatus.hidden = true;
  el.environmentStatus.textContent = "";
}

function clearEnvironmentAnalysis() {
  if (environmentAnalysisAbortController) {
    environmentAnalysisAbortController.abort();
    environmentAnalysisAbortController = null;
  }
  if (environmentLayer) {
    map.removeLayer(environmentLayer);
    environmentLayer = null;
  }
  environmentAnalysisResult = null;
  _uncheckLayers("noise", "ventilation");
  el.environmentSummary.hidden = true;
  el.environmentWarnings.hidden = true;
  el.environmentLegend.innerHTML = "";
  el.environmentSentences.innerHTML = "";
  el.environmentInsights.innerHTML = "";
  hideEnvironmentStatus();
}

async function performEnvironmentAnalysis() {
  if (!activeRealParcel || !activeRealParcel.geometry) {
    alert("먼저 실제 필지를 선택해 주세요.");
    return;
  }
  if (isEnvironmentAnalysisInFlight) return;

  isEnvironmentAnalysisInFlight = true;
  el.btnEnvironmentAnalysis.disabled = true;

  if (environmentAnalysisAbortController) environmentAnalysisAbortController.abort();
  environmentAnalysisAbortController = new AbortController();
  const requestId = ++environmentAnalysisRequestId;

  showEnvironmentStatus("소음·통풍 가능성 분석 중...", "loading");
  el.environmentSummary.hidden = true;

  // 이미 계산된 다른 분석 결과가 있으면 함께 보내 재사용합니다(재계산 없음).
  const requestBody = { pnu: activeRealParcel.pnu, geometry: activeRealParcel.geometry };
  if (boundaryAnalysisResult) requestBody.boundary_result = boundaryAnalysisResult;
  if (visibilityAnalysisResult) requestBody.visibility_result = visibilityAnalysisResult;
  if (shadowAnalysisResult) requestBody.shadow_result = shadowAnalysisResult;
  if (terrainAnalysisResult) requestBody.terrain_result = terrainAnalysisResult;

  try {
    const res = await fetch("/api/environment/analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: environmentAnalysisAbortController.signal,
    });
    const body = await res.json().catch(() => ({}));

    if (requestId !== environmentAnalysisRequestId) return;

    if (!res.ok) {
      showEnvironmentStatus(body.detail || "소음·통풍 분석 중 오류가 발생했습니다.", "error");
      return;
    }

    hideEnvironmentStatus();
    environmentAnalysisResult = body;
    environmentDisplayMode = "noise";
    el.btnEnvironmentModeNoise.classList.add("active");
    el.btnEnvironmentModeVentilation.classList.remove("active");
    renderEnvironmentLayer();
    renderEnvironmentSummary();
    setLayerChecked("noise", true);
    el.environmentSummary.hidden = false;
  } catch (err) {
    if (err.name === "AbortError") return;
    console.error(err);
    if (requestId === environmentAnalysisRequestId) {
      showEnvironmentStatus("네트워크 오류로 소음·통풍 분석에 실패했습니다. 인터넷 연결을 확인해주세요.", "error");
    }
  } finally {
    isEnvironmentAnalysisInFlight = false;
    el.btnEnvironmentAnalysis.disabled = false;
  }
}

/** 8방위 중심 방향 지시자(소음/통풍 공용)를 지도에 그립니다. */
function renderEnvironmentLayer() {
  if (environmentLayer) {
    map.removeLayer(environmentLayer);
    environmentLayer = null;
  }
  if (!environmentAnalysisResult || !activeRealParcel || !activeRealParcel.centroid) return;

  const group = L.layerGroup();
  const center = [activeRealParcel.centroid.latitude, activeRealParcel.centroid.longitude];
  const centerLon = activeRealParcel.centroid.longitude;
  const centerLat = activeRealParcel.centroid.latitude;

  const DIRECTION_BEARINGS = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };

  if (environmentDisplayMode === "noise") {
    (environmentAnalysisResult.noise_directions || []).forEach((n) => {
      const bearing = DIRECTION_BEARINGS[n.direction];
      if (bearing == null) return;
      const color = NOISE_LEVEL_COLORS[n.noise_level] || "#9E9E9E";
      const offsetDeg = 0.0009; // 대략 80~100m 바깥쪽
      const bearingRad = (bearing * Math.PI) / 180;
      const dLat = Math.cos(bearingRad) * offsetDeg;
      const dLon = (Math.sin(bearingRad) * offsetDeg) / Math.cos((centerLat * Math.PI) / 180);
      const pointLatLng = [centerLat + dLat, centerLon + dLon];

      const line = L.polyline([center, pointLatLng], { color: color, weight: 3, opacity: 0.8 });
      const detail = n.nearest_road_distance_m != null
        ? `약 ${n.nearest_road_distance_m}m 거리 · 추정 폭 ${n.road_width_m != null ? n.road_width_m.toFixed(0) + "m" : "미상"} (${n.road_hierarchy || "정보 없음"})`
        : "확인된 주요 소음원 없음";
      line.bindTooltip(
        `<strong>${n.direction_label} - 소음 영향 ${n.noise_level}</strong><br/>${detail}${n.nearby_subway_station ? `<br/>인근 지하철: ${n.nearby_subway_station} (지상/지하 불확실)` : ""}`,
        { className: "building-tooltip", sticky: true }
      );
      line.addTo(group);

      const dot = L.circleMarker(pointLatLng, { radius: 6, color: color, fillColor: color, fillOpacity: 0.9 });
      dot.addTo(group);
    });
  } else {
    (environmentAnalysisResult.ventilation_directions || []).forEach((v) => {
      const bearing = v.direction_deg;
      const color = VENTILATION_LEVEL_COLORS[v.ventilation_level] || "#9E9E9E";
      const offsetDeg = 0.0009;
      const bearingRad = (bearing * Math.PI) / 180;
      const dLat = Math.cos(bearingRad) * offsetDeg;
      const dLon = (Math.sin(bearingRad) * offsetDeg) / Math.cos((centerLat * Math.PI) / 180);
      const pointLatLng = [centerLat + dLat, centerLon + dLon];

      const line = L.polyline([center, pointLatLng], {
        color: color, weight: 3, opacity: 0.8, dashArray: v.improves_at_higher_floors ? "6,4" : null,
      });
      line.bindTooltip(
        `<strong>${v.direction_label} - ${v.ventilation_level}</strong><br/>개방성 점수 ${v.openness_score_used}` +
          (v.improves_at_higher_floors ? "<br/>상층에서 개선 가능성 있음" : ""),
        { className: "building-tooltip", sticky: true }
      );
      line.addTo(group);

      const dot = L.circleMarker(pointLatLng, { radius: 6, color: color, fillColor: color, fillOpacity: 0.9 });
      dot.addTo(group);
    });
  }

  environmentLayer = group;
  applyLayerVisibility(environmentDisplayMode === "noise" ? "noise" : "ventilation");
}

function renderEnvironmentLegend() {
  el.environmentLegend.innerHTML = "";
  const colors = environmentDisplayMode === "noise" ? NOISE_LEVEL_COLORS : VENTILATION_LEVEL_COLORS;
  Object.entries(colors).forEach(([label, color]) => {
    const item = document.createElement("div");
    item.className = "legend-item";
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.backgroundColor = color;
    const text = document.createElement("span");
    text.textContent = label;
    item.appendChild(swatch);
    item.appendChild(text);
    el.environmentLegend.appendChild(item);
  });
}

function renderEnvironmentSummary() {
  if (!environmentAnalysisResult) return;
  const r = environmentAnalysisResult;

  renderEnvironmentLegend();

  el.environmentSentences.innerHTML = "";
  const records = environmentDisplayMode === "noise" ? r.noise_directions : r.ventilation_directions;
  (records || []).forEach((rec) => {
    const item = document.createElement("div");
    item.className = "boundary-item";
    item.textContent = rec.design_recommendation;
    el.environmentSentences.appendChild(item);
  });

  el.environmentInsights.innerHTML = "";
  (r.combined_insights || []).forEach((insight) => {
    const item = document.createElement("div");
    item.className = "boundary-item";
    item.textContent = insight.description;
    el.environmentInsights.appendChild(item);
  });

  const warnings = (r.data_status && r.data_status.warnings) || [];
  if (warnings.length > 0) {
    el.environmentWarnings.textContent = `⚠ ${warnings.join(" / ")}`;
    el.environmentWarnings.hidden = false;
  } else {
    el.environmentWarnings.hidden = true;
  }
}

function switchEnvironmentMode(mode) {
  if (mode === environmentDisplayMode) return;
  environmentDisplayMode = mode;
  el.btnEnvironmentModeNoise.classList.toggle("active", mode === "noise");
  el.btnEnvironmentModeVentilation.classList.toggle("active", mode === "ventilation");
  renderEnvironmentLayer();
  renderEnvironmentSummary();
  if (layerCheckedState.noise || layerCheckedState.ventilation) {
    setLayerChecked(mode === "noise" ? "noise" : "ventilation", true);
  }
}

el.btnEnvironmentAnalysis.addEventListener("click", performEnvironmentAnalysis);
el.btnEnvironmentModeNoise.addEventListener("click", () => switchEnvironmentMode("noise"));
el.btnEnvironmentModeVentilation.addEventListener("click", () => switchEnvironmentMode("ventilation"));

/* ------------------------------------------------------------------ */
/* 8.3단계(UI): 지도 표현 설정 · 발표 모드 · 이미지 내보내기                    */
/* ------------------------------------------------------------------ */

let isPresentationMode = false;
let legendPosition = "bottom-right";

function _lsGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}
function _lsSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    /* 저장 불가 환경이면 조용히 무시 — 표현 설정만 다음에 다시 골라야 할 뿐 기능엔 지장 없음 */
  }
}

function renderBasemapOptions() {
  el.basemapOptions.innerHTML = "";
  BASEMAP_OPTIONS.forEach((opt) => {
    const label = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "basemap-choice";
    radio.value = opt.key;
    radio.checked = opt.key === currentBasemapKey;
    radio.addEventListener("change", () => switchBasemap(opt.key));
    label.appendChild(radio);
    label.appendChild(document.createTextNode(opt.label));
    el.basemapOptions.appendChild(label);
  });
}

/** key(레이어 패널 항목)에 대응하는 범례 HTML을 만듭니다. 범례가 없는(또는 아직 계산 전인)
 * 레이어는 null을 반환합니다 — 없는 범례를 억지로 만들지 않습니다. */
function buildLegendHtmlForKey(key) {
  const swatch = (color, label) =>
    `<div class="legend-item"><span class="legend-swatch" style="background:${color}"></span><span>${label}</span></div>`;

  switch (key) {
    case "buildings_age":
      if (!buildingAnalysisResult) return null;
      return Object.values(AGE_BAND_CONFIG).map((c) => swatch(c.color, c.label)).join("");
    case "buildings_use":
      if (!buildingAnalysisResult) return null;
      return Object.entries(USE_CATEGORY_COLORS).map(([k, c]) => swatch(c, k)).join("");
    case "shadow_heatmap":
      if (!shadowAnalysisResult) return null;
      return Object.keys(SHADOW_RISK_COLORS).map((k) => swatch(SHADOW_RISK_COLORS[k], SHADOW_RISK_LABELS[k] || k)).join("");
    case "terrain_elevation":
      if (!terrainAnalysisResult) return null;
      return `<div class="legend-item">파랑(낮음) → 초록 → 노랑 → 빨강(높음)</div>`;
    case "terrain_slope":
      if (!terrainAnalysisResult) return null;
      return Object.entries(TERRAIN_CLASS_LABELS).map(([k, l]) => swatch(TERRAIN_CLASS_COLORS[k], l)).join("");
    case "visibility":
      if (!visibilityAnalysisResult) return null;
      return Object.entries(VIEW_TYPE_COLORS || {}).map(([k, c]) => swatch(c, k)).join("");
    case "noise":
      if (!environmentAnalysisResult) return null;
      return Object.entries(NOISE_LEVEL_COLORS).map(([k, c]) => swatch(c, k)).join("");
    case "ventilation":
      if (!environmentAnalysisResult) return null;
      return Object.entries(VENTILATION_LEVEL_COLORS).map(([k, c]) => swatch(c, k)).join("");
    default:
      return null;
  }
}

/** 현재 켜져 있는 레이어들의 범례를 모아 지도 위 범례 오버레이를 갱신합니다. */
function refreshMapLegendOverlay() {
  el.mapLegendOverlay.setAttribute("data-position", legendPosition);

  if (legendPosition === "hidden" || !el.chkShowLegend.checked) {
    el.mapLegendOverlay.hidden = true;
    return;
  }

  const activeKeys = LAYER_DEFS.map((d) => d.key).filter((k) => layerCheckedState[k]);
  const sections = [];
  activeKeys.forEach((key) => {
    const html = buildLegendHtmlForKey(key);
    if (html) {
      const def = LAYER_DEFS.find((d) => d.key === key);
      sections.push(`<div class="map-legend-section"><strong>${def.label}</strong>${html}</div>`);
    }
  });

  if (sections.length === 0) {
    el.mapLegendOverlay.hidden = true;
    return;
  }

  el.mapLegendOverlayTitle.textContent = "범례";
  el.mapLegendOverlayBody.innerHTML = sections.join("");
  el.mapLegendOverlay.hidden = false;
}

function applyPresentationDisplayElements() {
  el.mapNorthArrow.hidden = !el.chkShowNorth.checked;
  el.mapSourceNote.hidden = !el.chkShowSource.checked;
  if (el.chkShowTitle.checked && el.presentationTitleInput.value.trim()) {
    el.presentationTitle.textContent = el.presentationTitleInput.value.trim();
    el.presentationTitle.hidden = false;
  } else {
    el.presentationTitle.hidden = true;
  }
  if (leafletScaleControl) {
    const scaleEl = leafletScaleControl.getContainer();
    if (scaleEl) scaleEl.style.display = el.chkShowScale.checked ? "" : "none";
  }
  refreshMapLegendOverlay();
}

let leafletScaleControl = null;

function togglePresentationMode() {
  isPresentationMode = !isPresentationMode;
  document.body.classList.toggle("presentation-mode", isPresentationMode);
  el.btnPresentationToggle.classList.toggle("active", isPresentationMode);
  el.btnPresentationToggle.textContent = isPresentationMode ? "분석 모드로 돌아가기" : "발표 모드";
  setTimeout(() => map.invalidateSize(), 200); // 레이아웃이 바뀌므로 지도 크기 재계산
  applyPresentationDisplayElements();
}

/** 이미지 비율 프리셋을 픽셀 크기로 변환합니다(발표용 인쇄 규격 기준 근사치). */
function _exportSizeForRatio(ratioKey) {
  const sizes = {
    "16:9": [1600, 900],
    "4:3": [1600, 1200],
    "a4-landscape": [1754, 1240], // A4, 150dpi 근사
    "a4-portrait": [1240, 1754],
    "1:1": [1400, 1400],
  };
  return sizes[ratioKey] || null;
}

async function exportMapAsImage() {
  if (typeof html2canvas === "undefined") {
    alert("이미지 내보내기 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인해주세요.");
    return;
  }

  const ratioKey = el.exportRatioSelect.value;
  const targetSize = ratioKey === "current" ? null : _exportSizeForRatio(ratioKey);

  const wasPresentation = isPresentationMode;
  if (!wasPresentation) togglePresentationMode();

  let resized = false;
  const originalStyle = el.mapContainer.getAttribute("style") || "";

  try {
    if (targetSize) {
      el.mapContainer.classList.add("export-sizing");
      el.mapContainer.style.width = `${targetSize[0]}px`;
      el.mapContainer.style.height = `${targetSize[1]}px`;
      resized = true;
      map.invalidateSize();
      // 타일이 새 크기에 맞춰 로딩될 시간을 줍니다(요청사항: 로딩 전 저장 방지)
      await new Promise((resolve) => setTimeout(resolve, 900));
    } else {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    const canvas = await html2canvas(el.mapContainer, {
      useCORS: true,
      allowTaint: false,
      logging: false,
    });

    const link = document.createElement("a");
    link.download = `site-analysis-map-${Date.now()}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  } catch (err) {
    console.error(err);
    alert(
      "이미지 내보내기에 실패했습니다. 현재 배경지도가 이미지 캡처를 지원하지 않을 수 있습니다" +
        "(브라우저 보안 정책상 일부 타일 서버는 캔버스로 읽을 수 없습니다). " +
        "다른 배경지도(예: 밝은 지도, 무라벨 지도)로 바꿔서 다시 시도해주세요."
    );
  } finally {
    if (resized) {
      el.mapContainer.setAttribute("style", originalStyle);
      el.mapContainer.classList.remove("export-sizing");
      map.invalidateSize();
    }
    if (!wasPresentation) togglePresentationMode();
  }
}

/* ------------------------------------------------------------------ */
/* 8.4단계: "지적편집도" 토글 — 용도지역(LT_C_UQ111) 지도 오버레이               */
/* ------------------------------------------------------------------ */
/* ⚠️ 처음엔 bbox로 GeoJSON을 받아와 프런트엔드가 직접 색을 칠해 다시 그렸는데,
 * 지도를 옮길 때마다 "지우고 다시 그리기"가 보여서 매끄럽지 않다는 피드백을
 * 받았습니다. VWorld가 이 레이어를 표준 WMS(GetMap)로도 제공하는 걸 실제 호출로
 * 확인했고(EPSG:3857도 그대로 지원), 응답이 이미 VWorld/국토교통부 공식 스타일이
 * 입혀진 완성된 타일 이미지라 색상표를 우리가 추측해서 관리할 필요도 없어졌습니다.
 * 그래서 L.tileLayer.wms()로 배경지도와 똑같은 방식(타일 캐싱·점진적 로딩)으로
 * 겹치도록 바꿨습니다 — API 키는 그대로 /api/zoning/wms-tile 프록시가 가립니다. */

let zoningWmsLayer = null;
let isZoningActive = false;

function toggleZoning() {
  isZoningActive = !isZoningActive;
  el.btnZoningToggle.classList.toggle("active", isZoningActive);

  if (isZoningActive) {
    if (!zoningWmsLayer) {
      zoningWmsLayer = L.tileLayer.wms("/api/zoning/wms-tile", {
        layers: "lt_c_uq111",
        version: "1.3.0",
        format: "image/png",
        transparent: true,
        opacity: 0.55,
        maxZoom: 19,
      });
    }
    zoningWmsLayer.addTo(map);
    el.zoningLegend.innerHTML =
      `<div class="zoning-legend-title">지적편집도 · 용도지역</div>` +
      `<div class="zoning-legend-note">VWorld/국토교통부 공식 스타일 그대로입니다` +
      `(색상을 저희가 임의로 만들지 않았습니다).</div>`;
    el.zoningLegend.hidden = false;
  } else if (zoningWmsLayer) {
    map.removeLayer(zoningWmsLayer);
    el.zoningLegend.hidden = true;
  }
}

el.btnPresentationToggle.addEventListener("click", togglePresentationMode);
el.btnExportImage.addEventListener("click", exportMapAsImage);
el.btnZoningToggle.addEventListener("click", toggleZoning);

/* ------------------------------------------------------------------ */
/* 8.5단계: 줌 레벨별 지하철 노선/역 + 행정구역(구/동) 이름 항상 표시             */
/* ------------------------------------------------------------------ */
/* 요청사항: 1km권엔 구 이름+노선, 500m권엔 동 이름+역+노선, 300m~20m권엔 역+노선.
 * 지하철 노선/역은 사용자가 제공한 GIS 원본(서울, 정적 데이터)이라 한 번만 받아
 * 두고 줌에 따라 표시만 켜고 끕니다. 행정구역(구/동)은 화면 범위가 바뀔 때마다
 * 다시 조회합니다(전국 범위라 한 번에 다 받아둘 수 없음, 지적편집도 8.4단계와
 * 같은 VWorld API 재사용 — zoning_service.py 참고). */

const ADMIN_SIGG_MAX_ZOOM = 13; // 이 줌 이하: 구 이름
const ADMIN_EMD_MIN_ZOOM = 14; // 이 줌 이상: 동 이름
const STATION_MIN_ZOOM = 14; // 이 줌 이상에서만 역 마커 표시(1km권엔 노선만)
const ADMIN_MAX_BBOX_DEG = 0.5; // 백엔드 상한(main.py)과 동일

let subwayLinesLayer = null;
let subwayStationsLayer = null;
let adminBoundaryLayer = null;
let adminBoundaryMoveTimer = null;
let adminBoundaryAbortController = null;
let lastAdminBoundaryLevel = null;

/** 요청사항: 1km권에서 선이 너무 두꺼워 지도를 덮어버리는 문제 — 줌이 낮을(멀리 볼)
 * 수록 선을 가늘게, 가까이 볼수록 두껍게 해서 위계를 줍니다. */
function subwayLineWeightForZoom(zoom) {
  if (zoom <= 12) return 1;
  if (zoom <= 13) return 1.5;
  if (zoom <= 14) return 2;
  if (zoom <= 16) return 3;
  return 4;
}

async function initSubwayNetworkLayer() {
  try {
    const res = await fetch("/api/transit/network");
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn("지하철 노선/역 네트워크 로드 실패:", body.detail);
      return;
    }

    subwayLinesLayer = L.geoJSON(body.lines, {
      style: (feature) => {
        const std = normalizeLineName(feature.properties.line_name);
        const style = (std && LINE_STYLE[std]) || FALLBACK_LINE_STYLE;
        return { color: style.color, weight: subwayLineWeightForZoom(map.getZoom()), opacity: 0.85 };
      },
    }).addTo(map);

    subwayStationsLayer = L.geoJSON(body.stations, {
      pointToLayer: (feature, latlng) => {
        const std = normalizeLineName(feature.properties.line_name);
        const style = (std && LINE_STYLE[std]) || FALLBACK_LINE_STYLE;
        return L.circleMarker(latlng, {
          radius: 4,
          color: "#fff",
          weight: 1,
          fillColor: style.color,
          fillOpacity: 1,
        });
      },
      onEachFeature: (feature, layer) => {
        // 요청사항: 역이 보이는 스케일이면 이름도 항상 보여야 함 — 마우스를 올려야
        // 나오는 hover 툴팁이 아니라, 항상 떠 있는(permanent) 라벨로 표시합니다.
        layer.bindTooltip(feature.properties.station_name || "", {
          permanent: true,
          direction: "right",
          offset: [6, 0],
          className: "subway-station-label",
        });
      },
    });
    // 줌 조건이 맞으면 바로 표시(초기 로드 시점의 줌 기준)
    if (map.getZoom() >= STATION_MIN_ZOOM) {
      subwayStationsLayer.addTo(map);
    }
  } catch (err) {
    console.error("지하철 노선/역 네트워크 로드 오류:", err);
  }
}

function updateSubwayStationVisibility() {
  if (subwayLinesLayer) {
    const weight = subwayLineWeightForZoom(map.getZoom());
    subwayLinesLayer.setStyle({ weight });
  }

  if (!subwayStationsLayer) return;
  const shouldShow = map.getZoom() >= STATION_MIN_ZOOM;
  const isShown = map.hasLayer(subwayStationsLayer);
  if (shouldShow && !isShown) {
    subwayStationsLayer.addTo(map);
  } else if (!shouldShow && isShown) {
    map.removeLayer(subwayStationsLayer);
  }
}

async function updateAdminBoundaryLayer() {
  const zoom = map.getZoom();
  const level = zoom <= ADMIN_SIGG_MAX_ZOOM ? "sigg" : zoom >= ADMIN_EMD_MIN_ZOOM ? "emd" : null;

  if (!level) {
    // 구/동 전환 사이 애매한 줌 구간 — 이전 표시를 유지하지 않고 정리합니다(요청한
    // 두 구간 어디에도 안 맞는 어중간한 줌이라, 잘못된 레벨을 계속 보여주는 것보다
    // 깨끗한 게 낫습니다).
    if (adminBoundaryLayer) {
      map.removeLayer(adminBoundaryLayer);
      adminBoundaryLayer = null;
    }
    lastAdminBoundaryLevel = null;
    return;
  }

  // 레벨이 바뀌었으면(구<->동) 새 데이터가 오기 전이라도 예전 레벨 라벨을 먼저
  // 지웁니다 — 안 그러면 줌을 바꿔도 이전 레벨 라벨이 잠깐(또는 계속) 남아있습니다.
  if (level !== lastAdminBoundaryLevel && adminBoundaryLayer) {
    map.removeLayer(adminBoundaryLayer);
    adminBoundaryLayer = null;
  }

  const bounds = map.getBounds();
  const minLon = bounds.getWest();
  const minLat = bounds.getSouth();
  const maxLon = bounds.getEast();
  const maxLat = bounds.getNorth();
  // 지도 컨테이너가 아직 완전히 렌더링되기 전(크기가 0)이면 bounds가 폭·높이 0인
  // 점으로 나올 수 있습니다 — 이때는 백엔드가 400으로 거부하니 미리 걸러냅니다.
  const isDegenerateBounds = maxLon <= minLon || maxLat <= minLat;
  if (isDegenerateBounds || maxLon - minLon > ADMIN_MAX_BBOX_DEG || maxLat - minLat > ADMIN_MAX_BBOX_DEG) {
    // 화면이 너무 넓어서(또는 아직 렌더링 전이라) 조회하지 않는 경우도, 안 맞는
    // 레벨의 라벨을 남겨두지 않습니다.
    if (adminBoundaryLayer) {
      map.removeLayer(adminBoundaryLayer);
      adminBoundaryLayer = null;
    }
    lastAdminBoundaryLevel = null;
    return;
  }

  if (adminBoundaryAbortController) adminBoundaryAbortController.abort();
  adminBoundaryAbortController = new AbortController();

  const params = new URLSearchParams({
    level,
    min_lon: String(minLon),
    min_lat: String(minLat),
    max_lon: String(maxLon),
    max_lat: String(maxLat),
  });

  try {
    const res = await fetch(`/api/admin-boundary?${params.toString()}`, {
      signal: adminBoundaryAbortController.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== "success") return;

    if (adminBoundaryLayer) {
      map.removeLayer(adminBoundaryLayer);
    }
    lastAdminBoundaryLevel = level;
    adminBoundaryLayer = L.geoJSON(
      body.areas.map((a) => ({ type: "Feature", properties: a, geometry: a.geometry })),
      {
        style: { color: "#555", weight: 1, dashArray: "3,3", fill: false },
        onEachFeature: (feature, layer) => {
          layer.bindTooltip(feature.properties.name, {
            permanent: true,
            direction: "center",
            className: `admin-boundary-label admin-boundary-label-${level}`,
          });
        },
      }
    ).addTo(map);
    subwayLinesLayer && subwayLinesLayer.bringToFront();
    subwayStationsLayer && subwayStationsLayer.bringToFront();
  } catch (err) {
    if (err.name === "AbortError") return;
    console.error("행정구역 조회 오류:", err);
  }
}

map.on("zoomend", () => {
  updateSubwayStationVisibility();
  updateAdminBoundaryLayer();
});
map.on("moveend", () => {
  if (adminBoundaryMoveTimer) clearTimeout(adminBoundaryMoveTimer);
  adminBoundaryMoveTimer = setTimeout(updateAdminBoundaryLayer, 400);
});

initSubwayNetworkLayer();
updateAdminBoundaryLayer();

/* ------------------------------------------------------------------ */
/* 8.6단계: 구역(다각형) 안 필지 한 번에 선택                                  */
/* ------------------------------------------------------------------ */
/* 흐름: 1) 다각형 그리기(꼭짓점은 드래그로 위치 조정 가능) -> 2) "검토 모드"로
 * 자동 전환: 구역 안 모든 필지 경계가 지도에 오버랩되어 나타나고, Shift 없이
 * 그냥 클릭만으로 제외할 수 있음 -> 3) "선택 완료"를 누르면 그때 한 번만 병합·
 * 분석 파이프라인을 갱신합니다.
 *
 * ⚠️ 성능 관련(사용자 피드백): 처음 버전은 검토 중 필지를 하나씩 뺄 때마다
 * refreshMergedSelection()(병합 API 호출 + 모든 개별 필지 폴리곤을 통째로
 * 다시 그리기)을 매번 실행해서, 필지가 수백 개일 때 클릭할 때마다 눈에 보이게
 * 느렸습니다. 검토 중에는 클릭한 필지 하나만 지도에서 지우고 Map에서 빼는
 * "가벼운" 처리만 하고, 무거운 병합·재계산은 "선택 완료"를 눌렀을 때 딱 한 번만
 * 실행합니다. */

let isDrawingAreaSelect = false;
let isReviewingAreaSelect = false;
let areaSelectPoints = []; // L.LatLng[]
let areaSelectVertexMarkers = []; // L.Marker[] (draggable, areaSelectPoints와 같은 순서)
let areaSelectPolygonLayer = null; // 그리는 중 미리보기 다각형(선)
let areaSelectAbortController = null;

function updateAreaSelectPolygonShape() {
  if (areaSelectPoints.length < 2) {
    if (areaSelectPolygonLayer) {
      map.removeLayer(areaSelectPolygonLayer);
      areaSelectPolygonLayer = null;
    }
    return;
  }
  if (areaSelectPolygonLayer) {
    areaSelectPolygonLayer.setLatLngs(areaSelectPoints);
  } else {
    areaSelectPolygonLayer = L.polygon(areaSelectPoints, {
      color: "#e67e22",
      weight: 2,
      fillOpacity: 0.12,
      dashArray: "6,4",
    }).addTo(map);
  }
}

function startAreaSelect() {
  isDrawingAreaSelect = true;
  areaSelectPoints = [];
  areaSelectVertexMarkers = [];
  el.btnAreaSelectStart.hidden = true;
  el.btnAreaSelectFinish.hidden = false;
  el.btnAreaSelectCancel.hidden = false;
  el.btnAreaSelectFinish.disabled = true;
  el.areaSelectHint.hidden = false;
  el.areaSelectHint.textContent =
    "지도를 클릭해서 구역의 각 꼭짓점을 찍어주세요(찍은 점은 드래그로 위치를 옮길 수 있습니다). " +
    "점을 3개 이상 찍은 뒤 \"구역 완료\"를 누르면 그 안의 모든 필지가 선택됩니다.";
}

/** 새 꼭짓점을 추가합니다 — 드래그로 나중에 위치를 옮길 수 있는 마커로 둡니다. */
function addAreaSelectPoint(latlng) {
  const index = areaSelectPoints.length;
  areaSelectPoints.push(latlng);

  const marker = L.marker(latlng, {
    draggable: true,
    icon: L.divIcon({ className: "area-select-vertex", iconSize: [12, 12] }),
  }).addTo(map);
  marker.on("drag", (e) => {
    areaSelectPoints[index] = e.target.getLatLng();
    updateAreaSelectPolygonShape();
  });
  // 마커를 클릭(드래그 시작 등)해도 지도 click으로 전파돼 새 꼭짓점이 또 찍히지 않게 막습니다.
  marker.on("click", (e) => L.DomEvent.stopPropagation(e));
  areaSelectVertexMarkers.push(marker);

  updateAreaSelectPolygonShape();
  el.btnAreaSelectFinish.disabled = areaSelectPoints.length < 3;
}

function endAreaSelectMode() {
  isDrawingAreaSelect = false;
  areaSelectPoints = [];
  areaSelectVertexMarkers.forEach((m) => map.removeLayer(m));
  areaSelectVertexMarkers = [];
  if (areaSelectPolygonLayer) {
    map.removeLayer(areaSelectPolygonLayer);
    areaSelectPolygonLayer = null;
  }
  el.btnAreaSelectStart.hidden = false;
  el.btnAreaSelectFinish.hidden = true;
  el.btnAreaSelectCancel.hidden = true;
}

async function finishAreaSelect() {
  if (areaSelectPoints.length < 3) return;

  // 드래그로 옮긴 최종 위치(areaSelectPoints)를 그대로 씁니다.
  const ring = areaSelectPoints.map((p) => [p.lng, p.lat]);
  ring.push(ring[0]); // GeoJSON Polygon은 첫 점과 끝 점이 같아야 함
  const polygonGeoJson = { type: "Polygon", coordinates: [ring] };

  el.btnAreaSelectFinish.disabled = true;
  el.areaSelectHint.textContent = "구역 안의 필지를 조회하는 중...";

  if (areaSelectAbortController) areaSelectAbortController.abort();
  areaSelectAbortController = new AbortController();

  try {
    const res = await fetch("/api/parcel-boundary/by-area", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ geometry: polygonGeoJson }),
      signal: areaSelectAbortController.signal,
    });
    const body = await res.json().catch(() => ({}));

    if (!res.ok || body.status !== "success") {
      alert(body.detail || (body.warnings && body.warnings[0]) || "구역 안 필지 조회에 실패했습니다.");
      endAreaSelectMode();
      el.areaSelectHint.hidden = true;
      return;
    }

    // 요청사항: "구역 범위 안의 모든 필지가 잡히는" 동작 — 기존 선택을 지우지 않고
    // 그대로 더합니다(이미 선택돼 있던 필지와 합쳐짐).
    body.parcels.forEach((parcel) => {
      selectedParcels.set(_parcelSelectionKey(parcel), parcel);
    });
    const drawnPoints = areaSelectPoints.slice(); // endAreaSelectMode가 비우기 전에 복사
    endAreaSelectMode();
    enterAreaReviewMode(drawnPoints);

    if (body.warnings && body.warnings.length) {
      console.warn("구역 필지 조회 경고:", body.warnings);
    }
  } catch (err) {
    if (err.name === "AbortError") return;
    console.error(err);
    alert("네트워크 오류로 구역 안 필지 조회에 실패했습니다.");
    endAreaSelectMode();
    el.areaSelectHint.hidden = true;
  }
}

function cancelAreaSelect() {
  if (areaSelectAbortController) areaSelectAbortController.abort();
  endAreaSelectMode();
  el.areaSelectHint.hidden = true;
}

/** 구역보다 조금 더 넓게 필지가 깔려 있어야, 구역 밖 이웃 필지도 클릭으로 바로
 * 추가할 수 있습니다(요청사항). 필지가 없는 unselected 스타일(옅은 회색 테두리만).*/
const AREA_GRID_UNSELECTED_STYLE = {
  color: "#95a5a6",
  weight: 1,
  fillColor: "#ffffff",
  fillOpacity: 0.03,
};

let areaGridLayer = null; // "검토 화면"에 깔리는 전체 필지 격자(선택/미선택 전부)
let areaGridLayerByKey = new Map(); // key -> leaflet layer

function areaGridStyleFor(key) {
  return selectedParcels.has(key) ? INDIVIDUAL_PARCEL_STYLE : AREA_GRID_UNSELECTED_STYLE;
}

/** 요청사항: 구역을 정하고 나면 "선택 화면"으로 넘어가서, 그 구역뿐 아니라 주변
 * 필지 경계까지 전부 지도에 깔려 있어야 합니다 — Shift 없이 그냥 클릭만으로
 * 선택/해제를 토글(다시 클릭하면 다시 추가)할 수 있게 합니다. */
async function enterAreaReviewMode(polygonPoints) {
  isReviewingAreaSelect = true;
  el.btnAreaReviewDone.hidden = false;
  el.areaSelectHint.hidden = false;
  el.areaSelectHint.textContent = "주변 필지를 불러오는 중...";

  // 요청사항: 마우스로 드래그하면 연속으로 여러 필지를 선택/해제할 수 있어야 함.
  // 지도 자체의 드래그(이동)를 잠시 꺼서, 필지 위에서 드래그하면 지도가 움직이는
  // 대신 페인트 선택이 되게 합니다(줌 버튼으로는 계속 확대/축소 가능).
  map.dragging.disable();

  // 그린 구역의 bbox보다 여유 있게(약 40%, 최소 0.001도) 넓혀서 조회합니다 —
  // 그래야 구역 바로 밖의 이웃 필지도 화면에 깔려서 클릭으로 추가할 수 있습니다.
  const lats = polygonPoints.map((p) => p.lat);
  const lons = polygonPoints.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const padLat = Math.max((maxLat - minLat) * 0.4, 0.001);
  const padLon = Math.max((maxLon - minLon) * 0.4, 0.001);

  const params = new URLSearchParams({
    min_lon: String(minLon - padLon),
    min_lat: String(minLat - padLat),
    max_lon: String(maxLon + padLon),
    max_lat: String(maxLat + padLat),
  });

  try {
    const res = await fetch(`/api/parcel-boundary/by-bbox?${params.toString()}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== "success") {
      console.warn("주변 필지 격자 조회 실패:", body.detail || (body.warnings && body.warnings[0]));
      renderAreaGrid([]);
    } else {
      renderAreaGrid(body.parcels);
    }
  } catch (err) {
    console.error(err);
    renderAreaGrid([]);
  }

  updateAreaReviewHint();
}

// 요청사항: 마우스로 드래그하면 연속 선택(페인트 선택). 처음 누른 필지가 선택
// 상태였으면 드래그 내내 "해제"로, 아니었으면 드래그 내내 "선택"으로 동작합니다
// (한 번의 드래그 동안 방향이 왔다갔다 뒤집히지 않도록 시작 시점에 고정).
let isAreaPaintDragging = false;
let areaPaintDragAdding = true;

/** 검토 화면의 필지 격자 전체(선택된 것 + 안 된 것)를 그립니다. */
function renderAreaGrid(parcels) {
  if (areaGridLayer) {
    map.removeLayer(areaGridLayer);
    areaGridLayer = null;
  }
  areaGridLayerByKey = new Map();

  const group = L.layerGroup();
  parcels.forEach((parcel) => {
    const key = _parcelSelectionKey(parcel);
    const feature = { type: "Feature", properties: {}, geometry: parcel.geometry };
    L.geoJSON(feature, { style: () => areaGridStyleFor(key) }).eachLayer((layer) => {
      areaGridLayerByKey.set(key, layer);
      // mousedown: 클릭 한 번(드래그 없이)도 이걸로 처리되고, 동시에 드래그 선택의
      // 시작점 역할도 합니다 — 이 필지가 "선택"이었으면 이번 드래그는 전부 해제,
      // 아니었으면 전부 선택으로 방향을 고정합니다.
      layer.on("mousedown", (e) => {
        if (!isReviewingAreaSelect) return;
        L.DomEvent.stopPropagation(e);
        isAreaPaintDragging = true;
        areaPaintDragAdding = !selectedParcels.has(key);
        setAreaGridParcelState(key, parcel, layer, areaPaintDragAdding);
      });
      // mouseover: 버튼을 누른 채 이 필지 위로 드래그해 들어오면, 시작할 때 정한
      // 방향(선택/해제)을 그대로 적용합니다.
      layer.on("mouseover", () => {
        if (!isReviewingAreaSelect || !isAreaPaintDragging) return;
        setAreaGridParcelState(key, parcel, layer, areaPaintDragAdding);
      });
      // 일반 click도 막아둬서(마우스를 안 움직인 클릭=mousedown+mouseup) 지도
      // 클릭 핸들러로 전파되지 않게 합니다. 실제 토글은 이미 mousedown에서 처리됨.
      layer.on("click", (e) => L.DomEvent.stopPropagation(e));
      group.addLayer(layer);
    });
  });
  areaGridLayer = group.addTo(map);
}

/** 드래그 도중 하나 끝날 때(버튼을 뗄 때) 호출 — 문서 전체에서 mouseup을 잡아야
 * 필지 밖에서 손을 떼도 드래그 상태가 확실히 끝납니다. */
document.addEventListener("mouseup", () => {
  if (isAreaPaintDragging) {
    isAreaPaintDragging = false;
    updateAreaReviewHint();
  }
});

/** 필지 하나를 선택/해제 상태로 강제 지정합니다(토글이 아니라 지정 — 드래그 중
 * 같은 필지를 두 번 지나가도 상태가 다시 뒤집히지 않게). */
function setAreaGridParcelState(key, parcel, layer, shouldSelect) {
  const isSelected = selectedParcels.has(key);
  if (shouldSelect === isSelected) return; // 이미 원하는 상태면 아무 것도 안 함
  if (shouldSelect) {
    selectedParcels.set(key, parcel);
  } else {
    selectedParcels.delete(key);
  }
  layer.setStyle(areaGridStyleFor(key));
  updateAreaReviewHint();
}

function updateAreaReviewHint() {
  el.areaSelectHint.hidden = false;
  el.areaSelectHint.textContent =
    `필지를 클릭하거나 드래그해서 선택/해제하세요(다시 클릭·드래그하면 다시 선택됩니다). ` +
    `현재 ${selectedParcels.size}개 선택됨. 다 되면 "선택 완료"를 누르세요.`;
}

/** "선택 완료" — 이 시점에 딱 한 번만 병합 계산 + 분석 파이프라인 갱신을 실행합니다. */
async function confirmAreaReview() {
  isReviewingAreaSelect = false;
  el.areaSelectHint.hidden = true;
  el.btnAreaReviewDone.hidden = true;
  if (areaGridLayer) {
    map.removeLayer(areaGridLayer);
    areaGridLayer = null;
  }
  areaGridLayerByKey = new Map();
  map.dragging.enable(); // 검토 시작할 때 꺼뒀던 지도 드래그(이동)를 되돌림
  await refreshMergedSelection(); // 여기서 딱 한 번 — renderMultiParcelOverlay가 정상적으로 그려짐
}

el.btnAreaSelectStart.addEventListener("click", startAreaSelect);
el.btnAreaSelectFinish.addEventListener("click", finishAreaSelect);
el.btnAreaSelectCancel.addEventListener("click", cancelAreaSelect);
el.btnAreaReviewDone.addEventListener("click", confirmAreaReview);

el.legendPositionSelect.addEventListener("change", () => {
  legendPosition = el.legendPositionSelect.value;
  _lsSet("siteAnalysis.legendPosition", legendPosition);
  refreshMapLegendOverlay();
});
[el.chkShowLegend, el.chkShowScale, el.chkShowNorth, el.chkShowTitle, el.chkShowSource].forEach((chk) => {
  chk.addEventListener("change", applyPresentationDisplayElements);
});
el.presentationTitleInput.addEventListener("input", applyPresentationDisplayElements);

// 초기화: 배경지도 옵션 렌더링, 저장된 범례 위치 복원, 축척 컨트롤 추가
renderBasemapOptions();
legendPosition = _lsGet("siteAnalysis.legendPosition", "bottom-right");
el.legendPositionSelect.value = legendPosition;
leafletScaleControl = L.control.scale({ position: "bottomleft", imperial: false }).addTo(map);
applyPresentationDisplayElements();



el.btnLayersAllOff.addEventListener("click", turnOffAllLayers);
renderLayerCheckboxList();

/* ------------------------------------------------------------------ */
/* UI 간소화: 왼쪽(대상지선택+분석메뉴) / 중앙(지도) / 오른쪽(결과) 3분할        */
/* ------------------------------------------------------------------ */

const MENU_SECTIONS = [
  "parcel-info", "building", "boundary", "transit", "terrain", "shadow", "visibility", "environment",
];

// 각 메뉴 항목의 결과·진행중 상태를 어디서 읽어올지 매핑합니다(요청사항: 분석 완료/
// 미실행/데이터없음/오류 상태를 배지로 구분). 기존 분석 로직은 전혀 바꾸지 않고,
// 이미 있는 결과 변수·상태 표시 요소를 그대로 다시 읽기만 합니다.
const MENU_SECTION_STATE = {
  building: { result: () => buildingAnalysisResult, inFlight: () => isBuildingAnalysisInFlight, statusEl: () => el.buildingStatus },
  boundary: { result: () => boundaryAnalysisResult, inFlight: () => isBoundaryAnalysisInFlight, statusEl: () => el.boundaryStatus },
  transit: { result: () => transitAnalysisResult, inFlight: () => isTransitAnalysisInFlight, statusEl: () => el.transitStatus },
  terrain: { result: () => terrainAnalysisResult, inFlight: () => isTerrainAnalysisInFlight, statusEl: () => el.terrainStatus },
  shadow: { result: () => shadowAnalysisResult, inFlight: () => isShadowAnalysisInFlight, statusEl: () => el.shadowStatus },
  visibility: { result: () => visibilityAnalysisResult, inFlight: () => isVisibilityAnalysisInFlight, statusEl: () => el.visibilityStatus },
  environment: { result: () => environmentAnalysisResult, inFlight: () => isEnvironmentAnalysisInFlight, statusEl: () => el.environmentStatus },
};

let currentMenuSection = "parcel-info";

/** 왼쪽 분석 메뉴를 눌렀을 때: 오른쪽 결과 패널에서 그 섹션만 보여줍니다(요청사항:
 * 메뉴 전환은 화면 표시만 바꾸고 이미 받은 분석 데이터는 그대로 유지 — 재요청 없음). */
function selectMenuItem(section) {
  if (!MENU_SECTIONS.includes(section)) return;
  currentMenuSection = section;

  document.querySelectorAll(".menu-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.section === section);
  });

  document.querySelectorAll(".result-section").forEach((el2) => {
    el2.hidden = el2.dataset.section !== section;
  });

  if (el.rightPanelScroll) {
    el.rightPanelScroll.classList.add("has-selection");
    el.rightPanelScroll.scrollTop = 0;
  }
}

function setAllMenuItemsEnabled(enabled) {
  document.querySelectorAll(".menu-item").forEach((btn) => {
    if (btn.dataset.section === "parcel-info") return; // 기본정보는 항상 눌러볼 수 있음
    btn.disabled = !enabled;
  });
}

/** 분석 완료/진행중/오류/데이터없음 상태를 각 메뉴 항목 옆 작은 점으로 표시합니다.
 * 기존 상태 표시 요소(el.xStatus)의 클래스를 다시 읽기만 하고, 새로 계산하지 않습니다. */
function computeMenuBadgeStatus(section) {
  const cfg = MENU_SECTION_STATE[section];
  if (!cfg) return "";
  if (cfg.inFlight()) return "loading";
  if (cfg.result()) return "done";
  const statusEl = cfg.statusEl();
  if (statusEl && !statusEl.hidden) {
    if (statusEl.className.includes("error")) return "error";
    if (statusEl.className.includes("empty")) return "empty";
  }
  return "";
}

function updateAllMenuBadges() {
  Object.keys(MENU_SECTION_STATE).forEach((section) => {
    const badgeEl = document.querySelector(`.menu-item-badge[data-badge="${section}"]`);
    if (!badgeEl) return;
    const status = computeMenuBadgeStatus(section);
    if (status) {
      badgeEl.setAttribute("data-status", status);
    } else {
      badgeEl.removeAttribute("data-status");
    }
  });
}

function resetAllMenuBadges() {
  document.querySelectorAll(".menu-item-badge").forEach((b) => b.removeAttribute("data-status"));
}

// 요청사항: 검색창 아래 "선택됨 (주소)" 줄은 삭제 — 대신 이 함수들은 그와 함께
// 묶여 있던 나머지 UX 정리(검색 힌트 숨김/복원, 검색 결과 자동 접기)만 계속합니다.
function showLeftSelectedSummary() {
  if (el.leftFlowHint) el.leftFlowHint.hidden = true;

  // 요청사항: 필지 선택 후 검색 결과 목록이 계속 크게 남아있지 않도록 자동으로 접음
  if (el.searchResults) el.searchResults.hidden = true;
}

function hideLeftSelectedSummary() {
  if (el.leftFlowHint) el.leftFlowHint.hidden = false;
  if (el.rightPanelScroll) el.rightPanelScroll.classList.remove("has-selection");
}

function toggleLeftPanel() {
  el.leftPanel.classList.toggle("collapsed");
  setTimeout(() => map.invalidateSize(), 180);
}

function toggleRightPanel() {
  el.rightPanel.classList.toggle("collapsed");
  setTimeout(() => map.invalidateSize(), 180);
}

// 분석 메뉴 클릭 바인딩
document.querySelectorAll(".menu-item").forEach((btn) => {
  btn.addEventListener("click", () => selectMenuItem(btn.dataset.section));
});

el.btnToggleLeftPanel.addEventListener("click", toggleLeftPanel);
el.btnToggleRightPanelHeader.addEventListener("click", toggleRightPanel);

// 다중 필지 선택: '전체 해제' 버튼(요청사항 1)
if (el.btnClearAllParcels) {
  el.btnClearAllParcels.addEventListener("click", () => {
    clearAllParcelSelections();
    if (searchMarker) {
      map.removeLayer(searchMarker);
      searchMarker = null;
    }
  });
}

// 초기 상태: 결과 패널은 "대상지 기본정보"만 표시, 메뉴는 전부 비활성화
selectMenuItem("parcel-info");
setAllMenuItemsEnabled(false);

/* ------------------------------------------------------------------ */
/* 초기 실행                                                             */
/* ------------------------------------------------------------------ */

checkServerHealth();
// ⚠️ 사용자 피드백으로 제거: loadParcels()는 1단계 테스트용 가상 필지 3개를 지도에
// 항상 파란 사각형으로 표시하던 기능이었습니다. 지금은 실제 주소 검색·클릭으로 진짜
// 필지를 다루는 게 기본 사용 흐름이 되어서, 이 테스트 표시가 오히려 "내가 선택하지
// 않은 구역이 왜 파랗게 표시되지"라는 혼란만 줬습니다. 함수 자체(및 백엔드 API)는
// 그대로 남겨뒀으니 필요하면 다시 켤 수 있습니다.
// loadParcels();
