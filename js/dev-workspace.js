/**
 * STEP2: 개발검토 Workspace.
 *
 * UI 개편 목표: "대상지를 찾고 선택하는 지도 도구"(STEP1)와 "대상지를 선택한 뒤
 * 개발 가능성·사업성을 분석하는 업무 도구"(STEP2)를 화면 단위로 분리합니다.
 * 이 파일은 그 화면 전환과 탭 전환만 담당하는 얇은 오케스트레이션 레이어입니다.
 *
 * ⚠️ 지도를 새로 만들지 않습니다 — app.js가 이미 만든 Leaflet 지도 인스턴스와
 * 그 컨테이너(#map-container)를 그대로 이 화면의 작은 지도 슬롯으로
 * 옮겨(reparent)서 재사용합니다. selectedParcels/mergedParcelResult 같은 대상지
 * 상태도 전부 app.js의 기존 전역 상태를 그대로 참조합니다 — 이 파일에서 새로
 * 선언하지 않습니다. 이 스크립트는 app.js 뒤에 로드되는 일반 <script>라 같은
 * 전역 스코프를 공유하므로, app.js의 함수·변수(el, map, selectedParcels,
 * mergedParcelResult, realParcelLayer, feasibilityPanelOpen, fsFarBaseUserEdited,
 * fsZoneLookupKey, renderFeasibilityPanel, updateMultiParcelUI)를 그대로 씁니다.
 *
 * 실제 분석 계산(대상지 개요/토지가치/용적률·공공기여 계산)은 전혀 새로 만들지
 * 않았습니다 — app.js의 renderFeasibilityPanel()이 채우던 것과 동일한 DOM
 * 요소(id 동일)가 이제 이 화면의 탭 패널 안에 있을 뿐입니다.
 */

const devWorkspaceEl = {
  root: document.getElementById("dev-workspace"),
  backBtn: document.getElementById("btn-dev-workspace-back"),
  printBtn: document.getElementById("btn-dw-print"),
  mapSlot: document.getElementById("dev-workspace-map-slot"),
  summaryArea: document.getElementById("dw-total-area"),
  summaryCount: document.getElementById("dw-parcel-count"),
  summaryLocation: document.getElementById("dw-location"),
  main: null, // 아래에서 채웁니다(스크롤 컨테이너)
  navLinks: Array.from(document.querySelectorAll(".dw-nav a")),
  sections: Array.from(document.querySelectorAll(".dw-section")),
};
devWorkspaceEl.main = document.querySelector(".dw-main");

let devWorkspaceOpen = false;
let devWorkspaceMapOriginalParent = null;
let devWorkspaceMapOriginalNextSibling = null;

// 비동기 조회가 끝나기 전에 성공 체크가 먼저 보이지 않도록 항목별 진행 상태를
// 관리합니다. 인위적인 지연 없이 실제 요청이 끝나는 즉시 결과 상태로 바뀝니다.
const _reviewSummaryLoading = {
  analysis: false,
  plan: false,
  station: false,
  buildingAge: false,
  exclusionScreening: false,
};

/**
 * STEP1 전용 떠 있는 카드/버튼들 — 워크스페이스가 열려 있는 동안만 숨깁니다.
 * hidden만 토글하고 그 안의 로직(검색·필지 선택 등)은 전혀 건드리지 않습니다.
 */
function _step1OnlyElements() {
  return [
    el.leftPanel,
    el.rightPanel,
    el.multiParcelPanel,
    el.btnToggleLeftPanel,
    el.serverStatus,
    el.btnToggleRightPanelHeader,
    document.getElementById("map-display-toolbar"),
    document.getElementById("area-select-hint"),
  ].filter(Boolean);
}

/** "개발검토 →" 버튼: STEP1 → STEP2로 화면을 전환합니다. */
function openDevelopmentWorkspace() {
  if (selectedParcels.size === 0 || !mergedParcelResult) return;
  if (!devWorkspaceEl.root) return;

  devWorkspaceOpen = true;
  feasibilityPanelOpen = true; // app.js의 계산 함수들이 이 플래그로 "내용을 채워도 되는지" 판단

  _step1OnlyElements().forEach((elm) => {
    elm.hidden = true;
  });

  // #map-container를 통째로 워크스페이스의 작은 지도 슬롯으로 옮깁니다(재생성이
  // 아니라 DOM 이동입니다 — 같은 Leaflet 인스턴스, 같은 레이어들이 그대로 유지됨).
  if (el.mapContainer && el.mapContainer.parentElement !== devWorkspaceEl.mapSlot) {
    devWorkspaceMapOriginalParent = el.mapContainer.parentElement;
    devWorkspaceMapOriginalNextSibling = el.mapContainer.nextElementSibling;
    devWorkspaceEl.mapSlot.appendChild(el.mapContainer);
  }

  devWorkspaceEl.root.hidden = false;
  document.body.classList.add("dev-workspace-active");

  // 컨테이너 크기가 바뀌었으니 지도에 알려주고, 선택된 대상지가 새 크기에 맞춰
  // 다시 한번 화면 중앙에 오도록 맞춥니다(기존 realParcelLayer 재사용, 새로 안 그림).
  setTimeout(() => {
    map.invalidateSize();
    if (typeof realParcelLayer !== "undefined" && realParcelLayer) {
      try {
        map.fitBounds(realParcelLayer.getBounds(), { maxZoom: 19, padding: [16, 16] });
      } catch (err) {
        console.warn("개발검토 지도 fitBounds 실패:", err);
      }
    }
  }, 60);

  renderDevWorkspaceSummary();
  renderFeasibilityPanel(); // app.js 기존 함수 재사용 — 대상지개요/토지가치/용적률계산을 그대로 채움

  // 문서 맨 위(01 대상지 현황)에서 시작합니다.
  if (devWorkspaceEl.main) devWorkspaceEl.main.scrollTop = 0;
  _setDevNavActive("site-overview");

  // 검토 내용(OP·우선검토·의견)을 현재 대상지에 연결합니다. 같은 대상지면 그대로
  // 유지되고, 다른 대상지면 지우지 않고 "재검토 대상"으로 표시합니다.
  if (typeof bindDevelopmentReviewToSite === "function") bindDevelopmentReviewToSite();

  _reviewSummaryLoading.analysis = true;
  _reviewSummaryLoading.plan = true;
  _reviewSummaryLoading.station = true;
  _reviewSummaryLoading.buildingAge = true;
  _reviewSummaryLoading.exclusionScreening = true;
  renderReviewSummary(); // 비동기 항목은 회전 표시, 대상지·면적은 즉시 표시
  const existingPlanPromise = renderExistingPlan(); // 기존 계획 결과도 사업유형 판정 context에 포함

  // 01의 지도는 용도지역이 보이는 지적편집도로 띄웁니다 — 사용자가 매번 켜지 않아도 되게.
  // 기존 토글 함수를 그대로 쓰고, 이미 켜져 있으면 건드리지 않습니다.
  if (typeof isZoningActive !== "undefined" && !isZoningActive && typeof toggleZoning === "function") {
    setTimeout(() => toggleZoning(), 200);
  }

  // 역세권 거리를 먼저 재고 나서 사업유형을 분석합니다 — 순서가 바뀌면
  // 실측값이 요건 판정에 반영되지 않습니다.
  const coreLookupPromise = Promise.all([existingPlanPromise, lookupStationArea(), lookupRoadRequirement(), lookupExclusionScreening()]);
  const agingLookupPromise = lookupBuildingAge();
  // 공간조회 하나가 지연돼도 면적·현재 확보값으로 카드를 즉시 먼저 그립니다.
  // 각 조회가 끝난 뒤 아래 두 경로에서 다시 그려 최신 값으로 교체합니다.
  if (typeof runDevelopmentAnalysis === "function") {
    runDevelopmentAnalysis().finally(() => {
      _reviewSummaryLoading.analysis = false;
      renderReviewSummary();
    });
  }
  coreLookupPromise.then(async () => {
    if (typeof runDevelopmentAnalysis === "function") await runDevelopmentAnalysis();
    _reviewSummaryLoading.analysis = false;
    renderReviewSummary();
  });
  Promise.all([coreLookupPromise, agingLookupPromise]).then(async () => {
    if (typeof runDevelopmentAnalysis === "function") await runDevelopmentAnalysis();
    renderReviewSummary();
  });
}

/**
 * "← 대상지 선택" 버튼: STEP2 → STEP1로 되돌아갑니다. 대상지 선택 상태는 그대로 둡니다.
 * ⚠️ 아래에서 updateMultiParcelUI()를 다시 호출하는데, 그 함수는 선택이 0개면
 * 이 함수를 다시 호출합니다 — 이미 닫혀 있으면 아무 것도 안 하고 바로 리턴해서
 * 서로 무한히 호출하는 것을 막습니다(워크스페이스가 열린 적 없는 상태에서 선택만
 * 지워지는 평범한 경우에도 이 함수가 호출될 수 있어 꼭 필요합니다).
 */
function closeDevelopmentWorkspace() {
  if (!devWorkspaceOpen) return;

  devWorkspaceOpen = false;
  feasibilityPanelOpen = false;
  fsFarBaseUserEdited = false;
  fsZoneLookupKey = null;

  if (devWorkspaceEl.root) devWorkspaceEl.root.hidden = true;
  document.body.classList.remove("dev-workspace-active");

  // ⚠️ 여기서 검토 내용(OP·우선검토·의견)을 지우지 않습니다.
  // Chapter 1로 돌아가는 것은 "대상지를 다시 보겠다"는 뜻이지 "검토를 버리겠다"는
  // 뜻이 아닙니다. 같은 대상지로 다시 들어오면 그대로 이어서 작업합니다.
  // 대상지가 바뀐 경우의 처리는 bindDevelopmentReviewToSite()가 담당합니다.
  const btDetails = document.getElementById("dw-bt-details");
  if (btDetails) {
    btDetails.open = false;
    delete btDetails.dataset.rendered;
  }

  _step1OnlyElements().forEach((elm) => {
    elm.hidden = false;
  });
  // multiParcelPanel/rightPanel 등은 선택 상태에 따라 실제로는 계속 숨겨져 있어야 할
  // 수도 있으므로(예: 선택이 비어 있는 경우), 기존 갱신 함수를 다시 실행해 정확한
  // 표시 상태로 복구합니다 — 여기서 새로 만든 로직이 아니라 이미 있던 함수입니다.
  if (typeof updateMultiParcelUI === "function") updateMultiParcelUI();

  // 지도를 원래 있던 자리(STEP1 지도 컨테이너)로 되돌립니다.
  if (el.mapContainer && devWorkspaceMapOriginalParent) {
    if (devWorkspaceMapOriginalNextSibling) {
      devWorkspaceMapOriginalParent.insertBefore(el.mapContainer, devWorkspaceMapOriginalNextSibling);
    } else {
      devWorkspaceMapOriginalParent.appendChild(el.mapContainer);
    }
  }

  setTimeout(() => map.invalidateSize(), 60);
}

/** 왼쪽 목차 머리말 — 기존에 이미 계산돼 있는 값만 그대로 표시합니다. */
function renderDevWorkspaceSummary() {
  if (!mergedParcelResult) return;

  if (devWorkspaceEl.summaryArea) {
    devWorkspaceEl.summaryArea.textContent =
      mergedParcelResult.total_area_sqm != null
        ? `${mergedParcelResult.total_area_sqm.toLocaleString("ko-KR")} m²`
        : "-";
  }
  if (devWorkspaceEl.summaryCount) {
    devWorkspaceEl.summaryCount.textContent = `${selectedParcels.size}개`;
  }
  if (devWorkspaceEl.summaryLocation) {
    const addresses = Array.from(selectedParcels.values())
      .map((p) => p.address)
      .filter(Boolean);
    const regionSet = new Set(addresses.map((a) => a.split(" ").slice(0, 3).join(" ")).filter(Boolean));
    devWorkspaceEl.summaryLocation.textContent = regionSet.size ? Array.from(regionSet).join(", ") : "-";
  }
}

/* ------------------------------------------------------------------ */
/* 기존 계획(지구단위계획구역) 조회                                          */
/* ------------------------------------------------------------------ */

// 같은 대상지를 반복 조회하지 않도록 결과를 대상지 키로 기억합니다.
let _planLookupKey = null;
let _planLookupResult = null;

/**
 * 선택한 대상지 도형을 백엔드로 보내 지구단위계획구역과 겹치는지 확인합니다.
 * 결과는 세 가지로만 표시합니다 — 포함됨 / 겹치는 구역 없음 / 확인 못 함.
 * **"확인 못 함"을 "해당 없음"으로 바꿔 쓰지 않습니다.**
 */
async function renderExistingPlan() {
  const host = document.getElementById("dw-plan-result");
  if (!host) return;

  const key = typeof _devReviewSiteKey === "function" ? _devReviewSiteKey() : null;
  const geom = mergedParcelResult && mergedParcelResult.geometry;
  if (!geom) {
    _reviewSummaryLoading.plan = false;
    host.innerHTML = '<p class="panel-hint">대상지를 선택하면 확인합니다.</p>';
    renderReviewSummary();
    return;
  }
  if (key && key === _planLookupKey && _planLookupResult) {
    _reviewSummaryLoading.plan = false;
    _paintExistingPlan(_planLookupResult);
    renderReviewSummary();
    return;
  }

  _reviewSummaryLoading.plan = true;
  renderReviewSummary();
  host.innerHTML = '<p class="panel-hint">지구단위계획구역 확인 중…</p>';
  try {
    const res = await fetch("/api/district-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ geometry: geom }),
    });
    const data = await res.json();
    _planLookupKey = key;
    _planLookupResult = data;
    _paintExistingPlan(data);
  } catch (err) {
    _paintExistingPlan({ status: "unavailable", reason: "조회에 실패했습니다.", plans: [] });
  } finally {
    _reviewSummaryLoading.plan = false;
  }
  if (typeof renderReviewSummary === "function") renderReviewSummary();
}

function _paintExistingPlan(data) {
  const host = document.getElementById("dw-plan-result");
  if (!host) return;
  const esc = typeof _escapeHtml === "function" ? _escapeHtml : (x) => x;

  if (data.status === "included") {
    const rows = data.plans
      .map(
        (p) => `
        <dt>${esc(p.name)}</dt>
        <dd>${esc(p.extent)} 포함 (${Math.round(p.overlap_ratio * 100)}%)${
          p.record_date ? ` · 자료상 기준일 ${esc(p.record_date)}` : ""
        }</dd>`
      )
      .join("");
    host.innerHTML = `
      <p class="dw-status-line dw-status-ok"><b>확인됨</b> 이 대상지는 지구단위계획구역에 들어 있습니다.</p>
      <dl class="feasibility-dl">${rows}</dl>
      <p class="panel-hint">이 자료에는 구역 경계와 이름만 있습니다 — <strong>용도·용적률·높이·공공기여 조건은 결정도서를 확인하세요.</strong>
      현행 계획 기준과 다른 제도로 바꾸는 안은 03 개발대안에서 따로 만들어 비교하면 됩니다.</p>`;
  } else if (data.status === "not_included") {
    host.innerHTML = `
      <p class="dw-status-line dw-status-ok"><b>확인됨</b> 겹치는 지구단위계획구역이 없습니다.</p>
      <p class="panel-hint">서울시 지구단위계획구역 자료(982건) 기준입니다. 최근 결정·변경분은 토지이음에서 한 번 더 확인하세요.</p>`;
  } else {
    host.innerHTML = `
      <p class="dw-status-line dw-status-todo"><b>추가 확인 필요</b> 자동으로 확인하지 못했습니다.</p>
      <p class="panel-hint">${esc(data.reason || "자료를 읽을 수 없습니다.")} — 토지이음에서 대상지 지번으로 직접 확인하세요.
      <strong>확인 못 함은 "해당 없음"이 아닙니다.</strong></p>`;
  }
}

/* ------------------------------------------------------------------ */
/* 역세권 범위 — 승강장 경계까지 실제 거리                                    */
/* ------------------------------------------------------------------ */

let _stationLookupKey = null;
let _stationLookupResult = null;

/**
 * 운영기준 2-1-2는 "역 승강장 경계로부터 직각 거리"로 정합니다.
 * 역 위치점이 아니라 승강장 폴리곤과의 최단거리를 재서 요건 판정에 넣습니다.
 */
async function lookupStationArea() {
  const key = typeof _devReviewSiteKey === "function" ? _devReviewSiteKey() : null;
  const geom = mergedParcelResult && mergedParcelResult.geometry;
  if (!geom) {
    _reviewSummaryLoading.station = false;
    renderReviewSummary();
    return;
  }
  if (key && key === _stationLookupKey && _stationLookupResult) {
    _reviewSummaryLoading.station = false;
    if (typeof setStationAreaResult === "function") setStationAreaResult(_stationLookupResult);
    renderReviewSummary();
    return;
  }
  _reviewSummaryLoading.station = true;
  renderReviewSummary();
  try {
    const res = await fetch("/api/station-area", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ geometry: geom }),
    });
    const data = await res.json();
    _stationLookupKey = key;
    _stationLookupResult = data;
    if (typeof setStationAreaResult === "function") setStationAreaResult(data);
  } catch (err) {
    // 조회 실패는 "해당 없음"이 아닙니다 — 판정을 원래대로(확인 필요) 둡니다.
    _stationLookupResult = null;
    if (typeof setStationAreaResult === "function") setStationAreaResult(null);
  } finally {
    _reviewSummaryLoading.station = false;
    renderReviewSummary();
  }
}

/* ------------------------------------------------------------------ */
/* 도로요건 — 실폭도로 접촉 + 도로중심선(RVWD) 폭 실측                          */
/* ------------------------------------------------------------------ */

let _roadRequirementLookupKey = null;
let _roadRequirementLookupResult = null;

/**
 * 역세권 활성화사업 운영기준의 "2면 이상 4m + 최소 1면 8m" 접도 요건을
 * 실측값으로 판정합니다. business_types.json에 "도로요건"이라는 이름의
 * site_requirements 항목을 가진 사업유형이면 이 결과를 그대로 씁니다
 * (특정 사업유형에 종속된 호출이 아닙니다).
 */
async function lookupRoadRequirement() {
  const key = typeof _devReviewSiteKey === "function" ? _devReviewSiteKey() : null;
  const geom = mergedParcelResult && mergedParcelResult.geometry;
  if (!geom) return;
  if (key && key === _roadRequirementLookupKey && _roadRequirementLookupResult) {
    if (typeof setRoadRequirementResult === "function") setRoadRequirementResult(_roadRequirementLookupResult);
    return;
  }
  try {
    const res = await fetch("/api/road-requirement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ geometry: geom }),
    });
    const data = await res.json();
    _roadRequirementLookupKey = key;
    _roadRequirementLookupResult = data;
    if (typeof setRoadRequirementResult === "function") setRoadRequirementResult(data);
  } catch (err) {
    // 조회 실패는 "해당 없음"이 아닙니다 — 판정을 원래대로(확인 필요) 둡니다.
    _roadRequirementLookupResult = null;
    if (typeof setRoadRequirementResult === "function") setRoadRequirementResult(null);
  }
}

/* ------------------------------------------------------------------ */
/* 건물 사용승인일·노후현황 — 선택 필지(PNU) 기준 측정                          */
/* ------------------------------------------------------------------ */

let _buildingAgeLookupKey = null;
let _buildingAgeLookupResult = null;
// 추진 경로별(도시정비형 재개발사업/지구단위계획) 노후도 법적 판정 — 측정과는
// 별개의 백엔드 서비스(aging_requirement_service, 순수 함수)가 만든 결과입니다.
// 여기서는 그 결과를 그대로 저장만 하고 판정하지 않습니다.
let _agingRequirementRoutes = null;

/**
 * 선택된 필지들의 PNU로 건물 사용승인일·경과연수를 측정하고(건축HUB 표제부 기반,
 * backend/services/building_age_service.py), 이어서 추진 경로별 노후도 법적 판정
 * (backend/services/aging_requirement_service.py)까지 함께 받아옵니다.
 * ⚠️ /api/aging-requirement는 측정값(response.measurement)과 판정값
 * (response.routes)을 분리해서 반환합니다 — 이 함수는 둘을 각각 저장할 뿐,
 * 섞어서 하나의 "충족" 문구로 만들지 않습니다.
 */
async function lookupBuildingAge() {
  const key = typeof _devReviewSiteKey === "function" ? _devReviewSiteKey() : null;
  if (typeof selectedParcels === "undefined" || !selectedParcels.size) {
    _reviewSummaryLoading.buildingAge = false;
    renderReviewSummary();
    return;
  }
  const pnus = Array.from(selectedParcels.values())
    .map((p) => p.pnu)
    .filter(Boolean);
  if (!pnus.length) {
    _reviewSummaryLoading.buildingAge = false;
    renderReviewSummary();
    return;
  }
  if (key && key === _buildingAgeLookupKey && _buildingAgeLookupResult) {
    _reviewSummaryLoading.buildingAge = false;
    renderReviewSummary();
    return;
  }
  // 대상지가 바뀌면 직전 대상지의 노후도(예: 1/1동)를 새 카드에 잠시라도
  // 표시하지 않습니다. 새 선택 필지 전체의 응답이 올 때까지 비워 둡니다.
  if (key !== _buildingAgeLookupKey) {
    _buildingAgeLookupResult = null;
    _agingRequirementRoutes = null;
  }
  _reviewSummaryLoading.buildingAge = true;
  renderReviewSummary();
  try {
    const res = await fetch("/api/aging-requirement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pnus }),
    });
    const data = await res.json();
    _buildingAgeLookupKey = key;
    _buildingAgeLookupResult = data.measurement || null;
    _agingRequirementRoutes = data.routes || null;
  } catch (err) {
    // 조회 실패는 "건물 없음"이 아닙니다 — 결과를 비워 "확인 필요" 상태로 남깁니다.
    _buildingAgeLookupResult = null;
    _agingRequirementRoutes = null;
  } finally {
    _reviewSummaryLoading.buildingAge = false;
    renderReviewSummary();
  }
}

/* ------------------------------------------------------------------ */
/* 제외대상 GIS 1차 스크리닝(정비구역 관련 지정 / 도시·군계획시설)                */
/* ------------------------------------------------------------------ */

let _exclusionScreeningKey = null;
// business-type-review.js가 이 전역을 읽어 exclusions 항목에 한 줄 주의 문구를
// 붙입니다. 이 결과는 법적 최종판정이 아닙니다 — screening_status는
// no_overlap/possible_overlap/unavailable 3가지뿐이고, 이 값으로 "적용 불가"를
// 만들지 않습니다.
let _exclusionScreeningResult = null;

/**
 * 대상지 도형과 (1) 정비구역 관련 지정, (2) 도시·군계획시설(UQ151~155)의
 * 공간 중첩만 확인합니다. backend/services/exclusion_screening_service.py가
 * 공간 중첩 사실만 재고, 이 함수는 그 결과를 그대로 저장할 뿐입니다.
 */
async function lookupExclusionScreening() {
  const key = typeof _devReviewSiteKey === "function" ? _devReviewSiteKey() : null;
  const geom = mergedParcelResult && mergedParcelResult.geometry;
  if (!geom) {
    _reviewSummaryLoading.exclusionScreening = false;
    renderReviewSummary();
    return;
  }
  if (key && key === _exclusionScreeningKey && _exclusionScreeningResult) {
    _reviewSummaryLoading.exclusionScreening = false;
    renderReviewSummary();
    return;
  }
  _reviewSummaryLoading.exclusionScreening = true;
  renderReviewSummary();
  try {
    const res = await fetch("/api/exclusion-screening", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ geometry: geom }),
    });
    const data = await res.json();
    _exclusionScreeningKey = key;
    _exclusionScreeningResult = data;
  } catch (err) {
    // 조회 실패는 "중첩 없음"이 아닙니다 — 결과를 비워 "확인 필요" 상태로 남깁니다.
    _exclusionScreeningResult = null;
  } finally {
    _reviewSummaryLoading.exclusionScreening = false;
    renderReviewSummary();
  }
}

/* ------------------------------------------------------------------ */
/* 이번 검토 요약 + 단계별 진행 상태                                        */
/* ------------------------------------------------------------------ */

/**
 * 화면에 보일 상태를 실제 값에서만 모읍니다. 없는 정보는 만들지 않고
 * "아직 확인 안 함"으로 남깁니다.
 */
function collectReviewState() {
  const st = {
    address: null,
    areaText: null,
    parcelCount: null,
    zoneName: null,
    jigaOk: false,
    jigaMissing: 0,
    btTotal: 0,
    btAutoDone: 0,
    btTodo: 0,
    btClassified: 0,
    btUnclassified: 0,
    btBlocked: 0,
    opTotal: 0,
    opCalculable: 0,
    opNeedInput: 0,
    opOtherSite: 0,
    preferredIndex: null,
  };

  if (typeof selectedParcels !== "undefined" && selectedParcels.size) {
    st.parcelCount = selectedParcels.size;
    const addrs = Array.from(selectedParcels.values())
      .map((p) => p.address)
      .filter(Boolean);
    st.address = addrs.length ? addrs[0] : null;
  }
  if (typeof mergedParcelResult !== "undefined" && mergedParcelResult && mergedParcelResult.total_area_sqm != null) {
    st.areaText = `${mergedParcelResult.total_area_sqm.toLocaleString("ko-KR")} m²`;
  }
  if (typeof fsJigaCompleteness === "function") {
    const jiga = fsJigaCompleteness();
    st.jigaOk = jiga.jigaAvg != null;
    st.jigaMissing = jiga.jigaMissingCount || 0;
  }
  // 사업제도 분석 결과는 dev-dashboard.js가 이미 계산해 둔 것을 그대로 읽습니다.
  // ⚠️ 2026-09-17 재수정: 미분류 사업유형의 전체 세부항목을 "확인 필요" 숫자에
  // 더하지 않습니다(이전에는 합산해서 "확인 필요 39/31"처럼 실패한 것처럼
  // 보였습니다). 미분류 사업유형은 숫자를 세지 않고 "추가 분류 N"으로만 셉니다 —
  // 그 사업유형의 상세 항목 수·상태는 상세검토 화면에 그대로 남아 있습니다.
  if (typeof _ddLastAnalyses !== "undefined" && _ddLastAnalyses) {
    st.btTotal = _ddLastAnalyses.length;
    _ddLastAnalyses.forEach((a) => {
      st.btAutoDone += a.autoResolvedCount || 0;
      if (typeof _dgIsClassified === "function" && _dgIsClassified(a)) {
        st.btClassified += 1;
        const counts = _dgCounts(a);
        st.btTodo += counts.primaryTodo + counts.exceptionCount;
      }
      if (a.overallStatus === "적용 불가") st.btBlocked += 1;
    });
  }
  st.btUnclassified = st.btTotal - st.btClassified;
  if (typeof _ddLastContext !== "undefined" && _ddLastContext) st.zoneName = _ddLastContext.zoneName;

  if (typeof _opRows !== "undefined") {
    st.opTotal = _opRows.length;
    _opRows.forEach((r) => {
      if (typeof _opIsStale === "function" && _opIsStale(r)) st.opOtherSite += 1;
      else if (r._calc && r._calc.computedCap != null) st.opCalculable += 1;
      else st.opNeedInput += 1;
    });
    if (typeof _opPreferredId !== "undefined" && _opPreferredId != null) {
      const i = _opRows.findIndex((r) => r.id === _opPreferredId);
      if (i >= 0) st.preferredIndex = i + 1;
    }
  }
  return st;
}

/** 목차 옆의 한 줄 상태. 실제로 셀 수 있는 것만 적습니다. */
function renderReviewProgress(st) {
  const texts = {
    site: (() => {
      if (_reviewSummaryLoading.analysis || _reviewSummaryLoading.plan) return "대상지 분석 중…";
      if (!st.zoneName) return "용도지역 확인 필요";
      if (_planLookupResult && _planLookupResult.status === "included") return `${st.zoneName} · 지구단위계획 포함`;
      if (_planLookupResult && _planLookupResult.status === "not_included") return `${st.zoneName} · 지구단위계획 없음`;
      return `${st.zoneName} · 기존 계획 확인 필요`;
    })(),
    // 좌측 목차는 진행 방향만 보여줍니다. 대표요건 분류 수처럼 구현에 가까운
    // 숫자는 사업방식 본문에 남기고, 여기서는 후보와 추가 확인 건수만 표시합니다.
    program: _reviewSummaryLoading.analysis
      ? "사업방식 분석 중…"
      : st.btTotal
      ? `후보 ${st.btTotal}개${st.btTodo ? ` · 추가 확인 ${st.btTodo}건` : ""}`
      : "",
    op: st.opTotal
      ? `${st.opTotal}개 · 계산됨 ${st.opCalculable}${st.opNeedInput ? ` · 보완 ${st.opNeedInput}` : ""}`
      : "아직 없음",
    conclusion: st.preferredIndex ? `OP${st.preferredIndex} 선택됨` : "우선 대안 선택 전",
  };
  document.querySelectorAll(".dw-nav-state").forEach((em) => {
    em.textContent = texts[em.dataset.progress] || "";
  });
}

function _sumItem(ok, label) {
  return `<li class="${ok ? "is-ok" : "is-todo"}">${label}</li>`;
}

function _sumLoading(label) {
  return '<li class="is-loading" aria-busy="true">' + label + "</li>";
}

/**
 * 들어오자마자 보는 요약. 내부 용어 대신 사용자가 쓰는 말로 적고,
 * "다음에 누를 버튼" 하나를 분명히 보여줍니다.
 */
function renderReviewSummary() {
  const host = document.getElementById("dw-summary");
  if (!host) return;
  const st = collectReviewState();
  renderReviewProgress(st);

  const esc = typeof _escapeHtml === "function" ? _escapeHtml : (x) => x;

  const confirmed = [];
  if (_reviewSummaryLoading.analysis) {
    confirmed.push(_sumLoading("용도지역 확인 중…"));
  } else {
    confirmed.push(_sumItem(!!st.zoneName, st.zoneName ? `용도지역 ${esc(st.zoneName)}` : "용도지역 확인 필요"));
  }
  if (_reviewSummaryLoading.station) {
    confirmed.push(_sumLoading("역세권 거리 확인 중…"));
  } else if (_stationLookupResult && _stationLookupResult.status === "ok") {
    const near = (_stationLookupResult.nearest || [])[0] || {};
    const d = Math.round(_stationLookupResult.distance_m);
    const ok = _stationLookupResult.verdict !== "depends";
    confirmed.push(
      _sumItem(ok, `${near.station_name ? esc(near.station_name) + " " : ""}승강장 경계에서 ${d}m`)
    );
  } else {
    confirmed.push(_sumItem(false, "역세권 거리 확인 필요"));
  }
  confirmed.push(
    _sumItem(
      st.jigaOk && st.jigaMissing === 0,
      st.jigaOk
        ? st.jigaMissing
          ? `공시지가 조회됨 (${st.jigaMissing}필지 누락)`
          : "공시지가 조회 완료"
        : "공시지가 확인 필요"
    )
  );
  // 지구단위계획은 이제 실제로 조회합니다 — 결과가 있으면 그대로 씁니다.
  if (_reviewSummaryLoading.plan) {
    confirmed.push(_sumLoading("지구단위계획 확인 중…"));
  } else if (_planLookupResult && _planLookupResult.status === "included") {
    const first = _planLookupResult.plans[0];
    confirmed.push(_sumItem(true, `지구단위계획구역 포함 (${esc(first ? first.name : "")})`));
  } else if (_planLookupResult && _planLookupResult.status === "not_included") {
    confirmed.push(_sumItem(true, "지구단위계획구역에 포함되지 않음"));
  } else {
    confirmed.push(_sumItem(false, "지구단위계획 포함 여부 확인 필요"));
  }

  // 건축물 현황 — 측정(대상 건물 수·확보율)만 보여줍니다. 법정 노후도 판정은 별도이며,
  // 그 기준 원문을 확인하지 못한 사업유형(예: 역세권 활성화사업)은 "기준 확인 필요"로
  // 남습니다 — 건물 수를 셀 수 있다는 것과 노후도 요건을 판정할 수 있다는 것은 다릅니다.
  if (_reviewSummaryLoading.buildingAge) {
    confirmed.push(_sumLoading("건축물 현황 확인 중…"));
  } else if (_buildingAgeLookupResult && _buildingAgeLookupResult.status === "ok") {
    const r = _buildingAgeLookupResult;
    const missing = r.missing_approval_date_count || 0;
    confirmed.push(
      _sumItem(
        true,
        `건축물 ${r.matched_building_count}동 · 사용승인일 ${r.valid_approval_date_count}동 확인${missing ? ` · ${missing}동 추가 확인 필요` : ""}`
      )
    );
  } else if (_buildingAgeLookupResult && _buildingAgeLookupResult.status === "no_building") {
    confirmed.push(_sumItem(true, "건축물 현황 · 대상 필지에 등록된 건물 없음"));
  } else {
    confirmed.push(_sumItem(false, "건축물 현황 확인 필요"));
  }

  // 다음 행동 — 지금 상태에서 실제로 할 수 있는 것 하나만 권합니다.
  let nextLabel;
  let nextTarget;
  let nextWhy;
  let nextDisabled = false;
  if (_reviewSummaryLoading.analysis) {
    nextLabel = "분석 중";
    nextTarget = "";
    nextWhy = "대상지 현황과 적용 가능한 사업방식을 확인하고 있습니다.";
    nextDisabled = true;
  } else if (!st.opTotal) {
    nextLabel = "사업방식 보러 가기";
    nextTarget = "business-type";
    nextWhy = `검토할 수 있는 사업방식 ${st.btTotal || 0}개를 확인하고, 그중 하나로 개발대안을 만듭니다.`;
  } else if (st.opNeedInput) {
    nextLabel = "개발대안 보완하기";
    nextTarget = "capacity";
    nextWhy = `개발대안 ${st.opTotal}개 중 ${st.opNeedInput}개는 입력이 더 필요해 규모가 계산되지 않았습니다.`;
  } else if (st.preferredIndex == null) {
    nextLabel = "우선 검토 대안 고르기";
    nextTarget = "capacity";
    nextWhy = `개발대안 ${st.opTotal}개가 모두 계산됐습니다. 우선 검토할 대안을 하나 고르세요.`;
  } else {
    nextLabel = "종합의견 마무리하기";
    nextTarget = "conclusion";
    nextWhy = `OP${st.preferredIndex}을 우선 검토 대안으로 골랐습니다. 남은 확인사항을 정리하면 초안이 완성됩니다.`;
  }

  const progressItems = _reviewSummaryLoading.analysis
    ? `
          <li class="is-loading" aria-busy="true">사업방식 분석 중…</li>
          <li>개발대안 ${st.opTotal}개</li>
          <li>${st.preferredIndex ? `우선 검토 대안 OP${st.preferredIndex}` : "우선 검토 대안 미선택"}</li>`
    : `
          <li>사업방식 후보 ${st.btTotal}개${st.btBlocked ? ` · 현재 조건 미충족 ${st.btBlocked}개` : ""}</li>
          <li>개발대안 ${st.opTotal}개${st.opTotal ? ` · 규모 계산됨 ${st.opCalculable}개` : ""}</li>
          <li>${st.preferredIndex ? `우선 검토 대안 OP${st.preferredIndex}` : "우선 검토 대안 미선택"}</li>`;

  host.innerHTML = `
    <div class="dw-summary-grid">
      <div class="dw-summary-cell">
        <p class="dw-summary-label">대상지</p>
        <p class="dw-summary-site">${esc(st.address || "선택된 필지 없음")}</p>
        <p class="dw-summary-sub">${esc(st.areaText || "면적 확인 필요")}${st.parcelCount ? ` · ${st.parcelCount}필지` : ""}</p>
      </div>
      <div class="dw-summary-cell">
        <p class="dw-summary-label">지금까지 확인된 것</p>
        <ul class="dw-summary-list">${confirmed.join("")}</ul>
      </div>
      <div class="dw-summary-cell">
        <p class="dw-summary-label">검토 진행 상태</p>
        <ul class="dw-summary-list">
          ${progressItems}
        </ul>
      </div>
    </div>
    <div class="dw-summary-next">
      <p>${esc(nextWhy)}</p>
      <button type="button" class="dw-next-btn"${nextTarget ? ` data-goto="${nextTarget}"` : ""}${nextDisabled ? " disabled" : ""}>${esc(nextLabel)}${nextDisabled ? "" : " →"}</button>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* 목차 이동 — 탭 전환이 아니라 한 문서 안에서의 스크롤입니다                    */
/* ------------------------------------------------------------------ */

/**
 * 이름은 그대로 두었습니다 — dev-dashboard.js와 business-type-review.js가 이미
 * 이 이름으로 호출하고 있고, 하는 일("그 항목을 화면에 보여준다")도 같습니다.
 * 달라진 것은 방식뿐입니다: 탭을 바꿔 끼우는 대신 해당 섹션으로 스크롤합니다.
 * 섹션은 전부 항상 DOM에 있으므로 인쇄하면 검토서 한 벌이 그대로 나옵니다.
 */
function selectDevWorkspaceTab(sectionName) {
  const section = devWorkspaceEl.sections.find((s) => s.dataset.tabPanel === sectionName);
  if (!section) return;
  _setDevNavActive(sectionName);
  section.scrollIntoView({ block: "start", behavior: "smooth" });
}

function _setDevNavActive(sectionName) {
  devWorkspaceEl.navLinks.forEach((a) => {
    a.classList.toggle("active", a.dataset.section === sectionName);
  });
}

devWorkspaceEl.navLinks.forEach((link) => {
  link.addEventListener("click", (ev) => {
    ev.preventDefault();
    selectDevWorkspaceTab(link.dataset.section);
  });
});

// 각 단계 끝의 "다음으로" 버튼과 요약 카드의 버튼은 같은 동작입니다.
document.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-goto]");
  if (btn) selectDevWorkspaceTab(btn.dataset.goto);
  if (ev.target.closest("#btn-dw-print-bottom")) window.print();
});

// 스크롤 위치에 따라 목차의 현재 단계를 표시합니다.
// IntersectionObserver는 섹션 높이가 크게 바뀔 때(요약 카드·OP 생성) 마지막으로
// 교차한 섹션이 남아 엉뚱한 단계가 켜져 있는 일이 있어, 실제 위치로 직접 고릅니다.
function _updateDevNavByScroll() {
  const main = devWorkspaceEl.main;
  if (!main || !devWorkspaceEl.sections.length) return;
  const line = main.getBoundingClientRect().top + 120; // 화면 위쪽 기준선
  let current = devWorkspaceEl.sections[0];
  devWorkspaceEl.sections.forEach((sec) => {
    if (sec.getBoundingClientRect().top <= line) current = sec;
  });
  _setDevNavActive(current.dataset.tabPanel);
}

if (devWorkspaceEl.main) {
  let ticking = false;
  devWorkspaceEl.main.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      _updateDevNavByScroll();
      ticking = false;
    });
  });
}

if (devWorkspaceEl.backBtn) {
  devWorkspaceEl.backBtn.addEventListener("click", closeDevelopmentWorkspace);
}

if (devWorkspaceEl.printBtn) {
  devWorkspaceEl.printBtn.addEventListener("click", () => window.print());
}

if (el.btnShowFeasibility) {
  el.btnShowFeasibility.addEventListener("click", openDevelopmentWorkspace);
}
