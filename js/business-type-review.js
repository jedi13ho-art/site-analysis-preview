/**
 * 8.11단계: 사업유형 검토 시스템.
 *
 * 목적: 실제 개발사업 검토서 6건에서 확인한 반복 업무 패턴(사업제도별 대상지 요건
 * 검토 → 용도지역 변경·용적률·높이·도입용도·공공기여 규칙 확인 → 개발대안(OP) 작성)을
 * "그릇" 수준으로 표현합니다. 이번 단계에서는 법규 숫자를 완성하지 않습니다 — 대신
 * 사업제도를 backend/data/business_types.json이라는 하나의 데이터 파일로 관리하고,
 * 이 파일이 앞으로 계속 채워질 수 있는 구조만 만듭니다.
 *
 * ⚠️ 판정 원칙: 시스템이 이미 가진 대상지 데이터(총 대지면적, 용도지역)로 비교 가능한
 * 항목만 자동으로 "적용 가능/적용 불가"를 계산합니다. 나머지(역세권 경계, 노후도,
 * 도로 폭, 위원회 인정 여부 등)는 절대 추측하지 않고 항상 "확인 필요"로 표시합니다.
 *
 * 이 파일은 dev-workspace.js 뒤에 로드되는 일반 스크립트라 같은 전역 스코프를
 * 공유합니다 — selectedParcels/mergedParcelResult 등 app.js의 기존 상태를 그대로
 * 참조하며, 이 파일에서 새로 선언하지 않습니다.
 */

/* ------------------------------------------------------------------ */
/* 사업유형(사업제도) 카드                                                  */
/* ------------------------------------------------------------------ */

let _businessTypesCache = null;
let _businessTypesFetchPromise = null;
// 백엔드 단일 판정 엔진의 최신 결과. API 연결에 실패하면 null로 두고 기존 JS
// 판정을 그대로 사용합니다 — 분석 실패를 잘못된 확정판정으로 바꾸지 않습니다.
let _backendBusinessTypeEvaluations = null;
// 지구단위계획 등 기존계획 포함 여부(백엔드 existing_plan_review) — OP 초안 생성 시
// "기존 결정조서 확인 우선" 배너에 씁니다. 사업유형 자동 배제에는 쓰지 않습니다.
let _backendExistingPlanReview = null;

async function fetchBusinessTypes() {
  if (_businessTypesCache) return _businessTypesCache;
  if (!_businessTypesFetchPromise) {
    _businessTypesFetchPromise = fetch("/api/business-types")
      .then((res) => res.json())
      .then((body) => {
        _businessTypesCache = body.business_types || [];
        return _businessTypesCache;
      })
      .catch((err) => {
        console.error("사업유형 목록 조회 실패:", err);
        _businessTypesCache = [];
        return _businessTypesCache;
      });
  }
  return _businessTypesFetchPromise;
}

function _buildBusinessTypeEvaluationContext(context) {
  return {
    total_area_sqm: context.totalArea,
    parcel_count: typeof selectedParcels !== "undefined" ? selectedParcels.size : null,
    zone_name: context.zoneName,
    district_plan: typeof _planLookupResult !== "undefined" ? _planLookupResult : null,
    station_area: typeof _stationAreaResult !== "undefined" ? _stationAreaResult : null,
    road_requirement: typeof _roadRequirementResult !== "undefined" ? _roadRequirementResult : null,
    aging_requirement_routes: typeof _agingRequirementRoutes !== "undefined" ? _agingRequirementRoutes : null,
    exclusion_screening: typeof _exclusionScreeningResult !== "undefined" ? _exclusionScreeningResult : null,
  };
}

async function refreshBackendBusinessTypeEvaluations(context) {
  try {
    const res = await fetch("/api/business-type-evaluations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: _buildBusinessTypeEvaluationContext(context) }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body.status !== "success") throw new Error(body.reason || "판정 엔진 응답 오류");
    _backendBusinessTypeEvaluations = new Map((body.evaluations || []).map((item) => [item.business_type_id, item]));
    _backendExistingPlanReview = body.existing_plan_review || null;
    return body;
  } catch (err) {
    console.warn("백엔드 사업유형 판정 연결 실패 — 기존 안전 판정을 유지합니다:", err);
    _backendBusinessTypeEvaluations = null;
    _backendExistingPlanReview = null;
    return null;
  }
}

function _entryFromBackend(entry) {
  return {
    status: entry.status,
    shortSummary: entry.short_summary,
    kind: entry.kind,
    resolved: !!entry.resolved,
    label: entry.label,
    detail: entry.detail,
    notes: entry.notes,
    source: entry.source,
    requirementLevel: entry.requirement_level,
    judgementEffect: entry.judgement_effect,
    displayGroup: entry.display_group,
    userActionRequired: entry.user_action_required,
    screeningWarning: entry.screening_warning || null,
  };
}

/**
 * 선택된 필지들의 용도지역·참고 기준용적률을 조회합니다 — 8.9단계 사업성 패널이 이미
 * 쓰던 /api/zoning/point-zone을 그대로 재사용합니다(새 API 없음). 필지들이 서로 다른
 * 용도지역에 걸쳐 있으면 자동판정을 보류하기 위해 zoneName을 null로 둡니다.
 * 선택 조합(PNU 목록)이 바뀌지 않는 한 재조회하지 않고 캐시된 값을 돌려줍니다 —
 * "사업유형" 탭과 Dashboard가 각자 조회하며 같은 요청을 중복으로 보내지 않기 위함.
 */
let _zoningContextCache = null; // { key, zoneName, baseFarPercent, farSource, farLastVerified }
let _zoningContextInFlight = null; // { key, promise }

function _emptyZoningContext(key) {
  return { key, zoneName: null, baseFarPercent: null, farSource: null, farLastVerified: null };
}

async function getZoningContextForSelection() {
  if (typeof selectedParcels === "undefined" || selectedParcels.size === 0) return _emptyZoningContext(null);
  const key = typeof _selectedParcelsLookupKey === "function" ? _selectedParcelsLookupKey() : Array.from(selectedParcels.keys()).sort().join(",");

  if (_zoningContextCache && _zoningContextCache.key === key) return _zoningContextCache;
  if (_zoningContextInFlight && _zoningContextInFlight.key === key) return _zoningContextInFlight.promise;

  const parcels = Array.from(selectedParcels.values())
    .filter((p) => p.centroid)
    .slice(0, 20);
  if (parcels.length === 0) {
    _zoningContextCache = _emptyZoningContext(key);
    return _zoningContextCache;
  }

  const promise = Promise.all(
    parcels.map((p) =>
      fetch(`/api/zoning/point-zone?lon=${p.centroid.longitude}&lat=${p.centroid.latitude}`)
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null)
    )
  )
    .then((results) => {
      const zoneNames = new Set(results.filter((r) => r && r.zone_name).map((r) => r.zone_name));
      if (zoneNames.size !== 1) {
        _zoningContextCache = _emptyZoningContext(key);
        return _zoningContextCache;
      }
      const zoneName = Array.from(zoneNames)[0];
      const matched = results.find((r) => r && r.zone_name === zoneName);
      _zoningContextCache = {
        key,
        zoneName,
        baseFarPercent: matched ? matched.base_far_percent : null,
        farSource: matched ? matched.far_reference_source : null,
        farLastVerified: matched ? matched.far_reference_last_verified : null,
      };
      return _zoningContextCache;
    })
    .catch(() => {
      _zoningContextCache = _emptyZoningContext(key);
      return _zoningContextCache;
    });

  _zoningContextInFlight = { key, promise };
  const result = await promise;
  _zoningContextInFlight = null;
  return result;
}

/** auto_check 구조를 실제 대상지 값과 비교합니다. 판정 불가 조건이면 null을 반환합니다. */
function _evaluateAutoCheck(check, context) {
  if (!check) return null;
  if (check.type === "area_range") {
    if (context.totalArea == null) return null;
    return context.totalArea >= check.min && context.totalArea <= check.max ? "적용 가능" : "적용 불가";
  }
  if (check.type === "area_min") {
    if (context.totalArea == null) return null;
    return context.totalArea >= check.min ? "적용 가능" : "적용 불가";
  }
  if (check.type === "zone_in_list") {
    if (!context.zoneName) return null;
    return check.zones.includes(context.zoneName) ? "적용 가능" : "적용 불가";
  }
  return null;
}

const BT_STATUS_CLASS = {
  "적용 가능": "bt-status-ok",
  "조건부 적용 가능": "bt-status-conditional",
  "적용 불가": "bt-status-no",
  "확인 필요": "bt-status-unknown",
};

// 카드 상단 종합판정 집계용 우선순위 — 값이 클수록 우선(하나라도 있으면 그 상태가 이김).
// "적용 불가"가 최우선입니다 — 이미 확정된 법적 결격 사유(예: 부지면적 미달)는 다른
// 항목이 "확인 필요"라는 이유로 뒤로 숨으면 안 됩니다("법적으로 적용 가능한지"와
// "확인이 더 필요한지"는 다른 축이며, 확정된 불가 사유가 있으면 그것을 우선 보여줘야
// 함). 그 다음이 "확인 필요"입니다 — 적용 불가가 없다면, 남은 확인 필요 항목 때문에
// "적용 가능"으로 단정하지 않습니다.
const BT_STATUS_RANK = {
  "적용 불가": 4,
  "확인 필요": 3,
  "조건부 적용 가능": 2,
  "적용 가능": 1,
};

function _btStatusBadge(status) {
  const safe = status || "확인 필요";
  const cls = BT_STATUS_CLASS[safe] || "bt-status-unknown";
  return `<span class="bt-status-badge ${cls}">${_escapeHtml(safe)}</span>`;
}

function _escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** source 인용 객체를 짧은 한 줄 태그로 렌더링합니다. */
function _renderSourceTag(source) {
  if (!source || !source.document_title) return "";
  const bits = [source.document_title];
  if (source.section) bits.push(source.section);
  if (source.revision_date) bits.push(`개정 ${source.revision_date}`);
  return `<span class="bt-source-tag">근거: ${_escapeHtml(bits.join(" · "))}</span>`;
}

/** 기존 3개 사업제도가 쓰는 단일 평면 규칙블록({description/system/status/...}) 렌더러. */
function _renderRuleBlock(block) {
  if (!block) return `<p class="panel-hint">확인 필요</p>`;
  const parts = [];
  if (block.description) parts.push(_escapeHtml(block.description));
  if (block.system) parts.push(`<strong>체계:</strong> ${_escapeHtml(block.system)}`);
  if (block.table_note) parts.push(_escapeHtml(block.table_note));
  if (block.formula) parts.push(`<strong>공식:</strong> ${_escapeHtml(block.formula)}`);
  if (block.contribution_methods && block.contribution_methods.length) {
    parts.push(`<strong>기여 방식:</strong> ${block.contribution_methods.map(_escapeHtml).join(" / ")}`);
  }
  if (block.notes) parts.push(`<span class="bt-rule-notes">${_escapeHtml(block.notes)}</span>`);
  const body = parts.map((p) => `<p>${p}</p>`).join("");
  return `<div class="bt-rule-block">${body}${_btStatusBadge(block.status)}${_renderSourceTag(block.source)}</div>`;
}

// 새 station_area_revitalization 구조처럼 zoning_change_rule이 하위 규칙 여러 개를 담는
// 딕셔너리({base_mixed_use_rule: {...}, non_center_special_rule: {...}})인지 판별합니다.
// 기존 3개 사업제도는 zoning_change_rule 자체가 status를 직접 갖는 평면 블록입니다.
const BT_SUBBLOCK_LABELS = {
  base_mixed_use_rule: "기본 복합용도 기준",
  non_center_special_rule: "비중심지 특례조건",
};

function _renderZoningChangeRule(block) {
  if (!block) return `<p class="panel-hint">확인 필요</p>`;
  if (block.status !== undefined || block.description !== undefined) {
    return _renderRuleBlock(block);
  }
  return Object.keys(block)
    .map((key) => {
      const sub = block[key];
      const label = BT_SUBBLOCK_LABELS[key] || key;
      return `<div class="bt-subblock"><h5 class="bt-subblock-title">${_escapeHtml(label)}</h5>${_renderRuleBlock(sub)}</div>`;
    })
    .join("");
}

/** eligible_zones — auto_check로 계산 가능하면 실시간 판정, 아니면 목록만 표시. */
function _renderEligibleZones(block, context) {
  if (!block) return "";
  let status = null;
  if (block.auto_check) status = _evaluateAutoCheck(block.auto_check, context);
  const siteValue = context.zoneName || "확인 필요(용도지역 조회 불가 또는 대상지 미선택)";
  const zones = (block.zones || []).map(_escapeHtml).join(", ");
  return `
    <div class="bt-rule-block">
      <p>적용 가능 용도지역: ${zones}</p>
      <p>대상지 용도지역: ${_escapeHtml(siteValue)}</p>
      ${_btStatusBadge(status || "확인 필요")}
      ${block.notes ? `<p class="bt-rule-notes">${_escapeHtml(block.notes)}</p>` : ""}
      ${_renderSourceTag(block.source)}
    </div>`;
}

/**
 * 제외대상 GIS 1차 스크리닝(dev-workspace.js의 lookupExclusionScreening()이 채우는
 * 전역 _exclusionScreeningResult) 중 "중첩 가능성 있음"인 레이어만 한 줄로
 * 요약합니다. 중첩이 없으면 null을 돌려줘서 첫 화면에 성공 배지를 반복하지
 * 않습니다(요청사항) — "확인됨, 중첩 없음"은 상세보기에서만 보입니다.
 * ⚠️ 이 문구는 법적 제외 판정이 아닙니다 — screening_status가
 * possible_overlap이어도 "적용 불가"라고 말하지 않습니다.
 */
function _exclusionScreeningNote() {
  if (typeof _exclusionScreeningResult === "undefined" || !_exclusionScreeningResult) return null;
  const labels = {
    urban_renewal: "정비 관련 지정",
    planning_facility: "도시·군계획시설",
  };
  const overlapping = Object.entries(labels)
    .filter(([key]) => _exclusionScreeningResult[key] && _exclusionScreeningResult[key].screening_status === "possible_overlap")
    .map(([, label]) => label);
  if (!overlapping.length) return null;
  return `${overlapping.join(", ")} 경계와 중첩 가능성 있음 — 현행 구역·시설 유형 확인 필요`;
}

const _EXCLUSION_SCREENING_ITEM_KEYS = {
  "정비구역·정비예정구역": "urban_renewal",
  "도시·군계획시설": "planning_facility",
};

/** 상세보기에서만 보이는 GIS 1차 스크리닝 결과 — 중첩률·명칭·기준일·한계를 그대로 밝힌다. */
function _renderExclusionScreeningDetail(itemName) {
  const key = _EXCLUSION_SCREENING_ITEM_KEYS[itemName];
  if (!key) return "";
  if (typeof _exclusionScreeningResult === "undefined" || !_exclusionScreeningResult) return "";
  const layer = _exclusionScreeningResult[key];
  if (!layer) return "";

  if (layer.screening_status === "unavailable") {
    return `<div class="bt-screening-detail"><p class="bt-rule-notes">GIS 스크리닝: 확인 못함 — ${_escapeHtml(layer.reason || "자료를 읽을 수 없습니다.")}</p></div>`;
  }
  if (layer.screening_status === "no_overlap") {
    return `<div class="bt-screening-detail"><p class="bt-rule-notes">GIS 스크리닝: 보유 데이터 기준 중첩 없음${layer.source && layer.source.source_date ? ` (자료 기준일 ${_escapeHtml(layer.source.source_date)})` : ""}</p></div>`;
  }
  const featureLines = (layer.matched_features || [])
    .slice(0, 5)
    .map((f) => `<li>${_escapeHtml(f.name)} — 중첩률 ${Math.round((f.overlap_ratio || 0) * 100)}%${f.notice_date ? ` · 고시일(자료상) ${_escapeHtml(f.notice_date)}` : ""}</li>`)
    .join("");
  const touchNote = layer.boundary_touch && !featureLines ? "<li>경계 접촉만 확인됨(면적 중첩 없음)</li>" : "";
  const limitations = (layer.limitations || []).map((l) => `<p class="bt-rule-notes">${_escapeHtml(l)}</p>`).join("");
  return `
    <div class="bt-screening-detail">
      <p class="bt-rule-notes">GIS 스크리닝: 중첩 가능성 있음${layer.overlap_ratio != null ? ` (대상지 대비 ${Math.round(layer.overlap_ratio * 100)}%)` : ""}</p>
      <ul class="bt-list">${featureLines}${touchNote}</ul>
      ${limitations}
    </div>`;
}

function _renderExclusions(block) {
  if (!block) return "";
  const items = (block.items || [])
    .map(
      (it) =>
        `<li><strong>${_escapeHtml(it.name)}</strong> ${_btStatusBadge(it.status)} <span class="bt-rule-notes">${_escapeHtml(it.notes || "")}</span>${_renderExclusionScreeningDetail(it.name)}</li>`
    )
    .join("");
  return `
    <div class="bt-rule-block">
      ${block.description ? `<p>${_escapeHtml(block.description)}</p>` : ""}
      <ul class="bt-list">${items}</ul>
      ${_btStatusBadge(block.status)}
      ${block.notes ? `<p class="bt-rule-notes">${_escapeHtml(block.notes)}</p>` : ""}
      ${_renderSourceTag(block.source)}
    </div>`;
}

function _renderStationAreaRange(block) {
  if (!block) return "";
  const conditions = (block.conditions || [])
    .map((c) => `<li>${_escapeHtml(c.center_type)}: 반경 ${c.radius_m}m 이내</li>`)
    .join("");
  return `
    <div class="bt-rule-block">
      ${block.description ? `<p>${_escapeHtml(block.description)}</p>` : ""}
      <ul class="bt-list">${conditions}</ul>
      ${_btStatusBadge(block.status)}
      ${block.notes ? `<p class="bt-rule-notes">${_escapeHtml(block.notes)}</p>` : ""}
      ${_renderSourceTag(block.source)}
    </div>`;
}

function _renderFarTable(farTable) {
  if (!farTable) return "";
  const rows = (farTable.rows || [])
    .map(
      (r) =>
        `<tr><td>${_escapeHtml(r.from_zone)}</td><td>${_escapeHtml(r.to_zone)}</td><td>${r.base_far_percent}%</td><td>${r.cap_far_percent}%</td></tr>`
    )
    .join("");
  return `
    <div class="bt-table-wrap">
      <table class="bt-req-table">
        <thead><tr><th>변경 전 용도지역</th><th>변경 후 용도지역</th><th>기준(허용)용적률</th><th>상한용적률</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${farTable.notes ? `<p class="bt-rule-notes">${_escapeHtml(farTable.notes)}</p>` : ""}
    ${_btStatusBadge(farTable.status)}
    ${_renderSourceTag(farTable.source)}`;
}

function _renderPublicContributionTable(pcTable, relief) {
  if (!pcTable) return "";
  const rows = (pcTable.rows || [])
    .map((r) => `<tr><td>${_escapeHtml(r.from_zone)}</td><td>${_escapeHtml(r.to_zone)}</td><td>${r.contribution_rate_percent}%</td></tr>`)
    .join("");
  const methods = pcTable.contribution_methods && pcTable.contribution_methods.length
    ? `<p><strong>기여 방식:</strong> ${pcTable.contribution_methods.map(_escapeHtml).join(" / ")}</p>`
    : "";
  let reliefHtml = "";
  if (relief) {
    const tiers = (relief.tiers || [])
      .map((t) => `<li>${_escapeHtml(t.condition)} → ${_escapeHtml(t.relief)}</li>`)
      .join("");
    reliefHtml = `
      <div class="bt-subblock">
        <h5 class="bt-subblock-title">완화 규칙(관광숙박시설·노인복지주택 등)</h5>
        ${relief.description ? `<p>${_escapeHtml(relief.description)}</p>` : ""}
        <ul class="bt-list">${tiers}</ul>
        ${relief.cap_note ? `<p class="bt-rule-notes">${_escapeHtml(relief.cap_note)}</p>` : ""}
        ${_btStatusBadge(relief.status)}
        ${_renderSourceTag(relief.source)}
      </div>`;
  }
  return `
    ${pcTable.principle ? `<p><strong>원칙:</strong> ${_escapeHtml(pcTable.principle)}</p>` : ""}
    <div class="bt-table-wrap">
      <table class="bt-req-table">
        <thead><tr><th>변경 전 용도지역</th><th>변경 후 용도지역</th><th>기본 공공기여율</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${methods}
    ${pcTable.notes ? `<p class="bt-rule-notes">${_escapeHtml(pcTable.notes)}</p>` : ""}
    ${_btStatusBadge(pcTable.status)}
    ${_renderSourceTag(pcTable.source)}
    ${reliefHtml}`;
}

/** 하위 규칙블록 하나(평면형 또는 {status} 보유 객체)에서 status만 뽑아냅니다. */
function _statusOf(block) {
  return block && block.status ? block.status : null;
}

/**
 * 대상지 요건(site_requirements) 각 항목을 실제 대상지 값과 비교해 계산한 결과 배열을
 * 만듭니다. 카드 상세표(reqRows)와 Dashboard(dev-dashboard.js)가 이 함수 하나를
 * 공유해서 쓰므로, 판정 로직은 한 곳에서만 바뀝니다.
 */
function _computeSiteRequirementResults(bt, context) {
  return (bt.site_requirements || []).map((req) => {
    let status = req.status;
    let siteValueText = "직접 확인 필요";
    // 대표요건 첫 화면에 쓰는 짧은 한 줄(1~2줄 이내) — criteria 원문·notes 전체를
    // 노출하지 않기 위한 별도 필드입니다. 없으면 호출부가 detail로 대신 씁니다.
    let shortSummary = null;

    // autoResolved: 자동 판정이 "실제로 끝났는가". _evaluateAutoCheck가 null을
    // 돌려주면(대상지 값이 없어서 비교 자체를 못 한 경우) 자동 확인 완료가 아닙니다.
    let autoResolved = false;

    if (req.value_source === "auto" && req.auto_check) {
      const computed = _evaluateAutoCheck(req.auto_check, context);
      if (req.auto_check.type === "zone_in_list") {
        siteValueText = context.zoneName || "확인 필요(용도지역 조회 불가)";
      } else {
        siteValueText = context.totalArea != null ? `${context.totalArea.toLocaleString("ko-KR")} m²` : "확인 필요(대상지 미선택)";
      }
      autoResolved = computed != null;
      status = computed || "확인 필요";
    } else if (req.value_source === "unavailable") {
      siteValueText = "데이터 없음(시스템 미확보)";
      status = req.status || "확인 필요";
    } else {
      status = req.status || "확인 필요";
      // reference_check: 참고용 계산값만 보여주고 최종 판정(status)은 그대로 "확인 필요" 유지 —
      // 예외조건이 있는 항목(예: 면적요건)을 자동으로 "적용 불가"로 단정하지 않기 위함.
      if (req.reference_check) {
        const refComputed = _evaluateAutoCheck(req.reference_check, context);
        const areaText = context.totalArea != null ? `${context.totalArea.toLocaleString("ko-KR")} m²` : "확인 필요(대상지 미선택)";
        siteValueText = refComputed
          ? `${areaText} (기본기준 참고판정: ${refComputed} — 예외 조건 있어 직접 확인 필요)`
          : areaText;
        if (req.reference_check.type === "area_range" || req.reference_check.type === "area_min") {
          shortSummary =
            refComputed === "적용 가능"
              ? `${areaText} · 기본범위 충족`
              : refComputed === "적용 불가"
                ? `${areaText} · 기본범위 미달, 예외 인정 검토 필요`
                : areaText;
        }
      }
    }

    return {
      item: req.item,
      criteria: req.criteria,
      status,
      siteValueText,
      shortSummary,
      notes: req.notes || "",
      source: req.source || null,
      valueSource: req.value_source,
      autoResolved,
      // 이 사업유형 고유의 접도 기준(있으면). 다른 사업유형의 값을 대신 쓰지 않기 위해
      // "도로요건"이라는 이름이 아니라 이 사업유형 자신의 Rule Set에서만 읽습니다.
      roadRequirementRule: req.road_requirement_rule || null,
      // 요건 위계 분류 (2026-09-17). 값이 없으면(미분류 사업유형) null — 호출부가
      // "이 사업유형은 아직 분류 안 됨"으로 구분해 기존 렌더링을 그대로 씁니다.
      requirementLevel: req.requirement_level || null,
      judgementEffect: req.judgement_effect || null,
      displayGroup: req.display_group || null,
      userActionRequired: req.user_action_required != null ? req.user_action_required : null,
    };
  });
}

/**
 * 사업제도 하나의 "확인 항목" 전체를 한 줄씩(대상지 요건 + eligible_zones/exclusions/
 * station_area_range/zoning_change_rule/far/height/use_conditions/공공기여) 모읍니다.
 * Dashboard의 "핵심 확인사항"과 카드 상단 종합판정이 이 목록을 함께 씁니다.
 * kind: "auto"(시스템이 이미 가진 데이터로 즉시 계산) | "manual"(사람이 직접 확인해야 함)
 */
/**
 * 승강장 경계까지 실제로 잰 거리. js/dev-workspace.js가 /api/station-area로 받아
 * 여기에 넣어 두면, 아래 요건 판정이 "확인 필요" 대신 실측값으로 답합니다.
 * 값이 없으면(자료 미적재·조회 실패) 예전처럼 "확인 필요"로 남습니다 —
 * **조회 실패를 '해당 없음'으로 바꾸지 않습니다.**
 */
let _stationAreaResult = null;

function setStationAreaResult(result) {
  _stationAreaResult = result && result.status === "ok" ? result : null;
}

/**
 * 운영기준 2-1-2(역 승강장 경계로부터 직각 거리)를 실측값으로 판정합니다.
 * 250m/350m 중 어느 기준을 쓸지는 중심지 체계가 있어야 정해지므로,
 * 그것 없이도 결론이 나는 두 경우만 확정하고 나머지는 확인 필요로 둡니다.
 */
function _stationAreaEntry(bt) {
  const base = {
    kind: "auto",
    resolved: false,
    label: "역세권 범위",
    detail: bt.station_area_range ? bt.station_area_range.description : "",
    notes: bt.station_area_range ? bt.station_area_range.notes : "",
    source: bt.station_area_range ? bt.station_area_range.source : null,
  };
  if (!_stationAreaResult) {
    return Object.assign(base, {
      status: _statusOf(bt.station_area_range) || "확인 필요",
      kind: "manual",
      detail: base.detail,
    });
  }
  const d = _stationAreaResult.distance_m;
  const near = (_stationAreaResult.nearest && _stationAreaResult.nearest[0]) || {};
  // 역명이 신뢰 가능한 매칭이 없으면(원본 이름 깨짐 등) 임의로 채우지 않고 거리만 표시합니다.
  const where = near.station_name ? `${near.station_name} 승강장 경계에서 ${Math.round(d)}m` : `승강장 경계에서 ${Math.round(d)}m`;
  const shortWhere = near.station_name ? `${near.station_name} 승강장 경계에서 ${Math.round(d)}m` : `승강장 경계에서 ${Math.round(d)}m`;

  // 250m/350m 중 어느 쪽이 적용되는지 참고 정보(2026-09-17 추가) — 환승역이 확정된
  // 경우만 신뢰 가능하고, 중심지 체계 후보는 항상 참고용입니다(자료 정의 미확인).
  const radiusInfo = _stationAreaResult.applied_radius_candidate || null;
  const transferInfo = _stationAreaResult.transfer || null;
  let radiusNote = "";
  if (radiusInfo && radiusInfo.confidence === "confirmed_by_transfer") {
    radiusNote = `환승역 확정(${transferInfo && transferInfo.line_count ? transferInfo.line_count + "개 노선" : "2개 이상 노선"}) — 350m 기준 적용`;
  } else if (transferInfo && transferInfo.is_transfer === false) {
    radiusNote = "환승역 아님(확인됨) · 중심지체계는 자료 정의 확인 필요";
  } else {
    radiusNote = "중심지체계·환승역은 자료 정의 확인 필요";
  }

  if (_stationAreaResult.verdict === "included") {
    const includedByAnyRadius = d <= 250;
    return Object.assign(base, {
      status: "적용 가능",
      resolved: true,
      detail: `${where} — 250m·350m 어느 기준이든 포함 (${radiusNote})`,
      shortSummary: includedByAnyRadius
        ? `${shortWhere} · 거리요건 충족`
        : `${shortWhere} · 환승역 350m 기준 포함`,
    });
  }
  if (_stationAreaResult.verdict === "excluded") {
    return Object.assign(base, {
      status: "적용 불가",
      resolved: true,
      detail: `${where} — 250m·350m 어느 기준이든 벗어남`,
      shortSummary: `${shortWhere} · 거리기준 벗어남`,
    });
  }
  return Object.assign(base, {
    status: "확인 필요",
    resolved: false,
    detail: `${where} — 350m 기준이면 포함, 250m 기준이면 제외. ${radiusNote}`,
    shortSummary: `${shortWhere} · 250m/350m 적용기준 확인 필요`,
  });
}

/**
 * 대상지 경계가 접한 도로들의 실측(접촉 길이·폭 — 실폭도로+도로중심선 RVWD).
 * js/dev-workspace.js가 /api/road-requirement(measure, 사업유형 무관)로 받아
 * 여기에 넣어 둡니다. 이 값 자체에는 "몇 m 이상 몇 면"이라는 기준이 없습니다
 * — 그 기준은 사업유형별 site_requirements[].road_requirement_rule에서만
 * 읽습니다(하드코딩 금지 — 과거에 "도로요건"이라는 이름만 보고 역세권
 * 활성화사업의 4m/8m 기준을 다른 사업유형에도 잘못 적용한 적이 있습니다).
 */
let _roadRequirementResult = null;

function setRoadRequirementResult(result) {
  _roadRequirementResult = result && result.status === "ok" ? result : null;
}

/**
 * measure()가 반환한 faces에 rule(narrow/wide 폭·면수)을 적용해 충족 여부만 계산합니다.
 * 순수 함수입니다 — backend road_requirement_service.evaluate_faces와 같은 로직입니다.
 *
 * ⚠️ 이 로직을 바꿀 때는 반드시 backend/services/road_requirement_service.py의
 * evaluate_faces()도 같이 바꾸고, tests/test_road_requirement_contract.py를
 * 재실행하세요. 이 프로젝트에는 JS 테스트 러너가 없어 두 구현이 같은지 자동으로
 * 비교하지 못합니다 — tests/fixtures/road_requirement_contract_cases.json의
 * 케이스들을 이 함수에 손으로 넣어 narrow_ok/wide_ok/미확인 여부가 Python 쪽과
 * 같은 숫자가 나오는지 직접 확인하세요(verdict 문자열 자체는 두 언어가 다릅니다).
 */
function _evaluateRoadFaces(faces, rule) {
  const narrowM = rule.required_narrow_width_m;
  const wideM = rule.required_wide_width_m;
  const minNarrowFaces = rule.required_narrow_face_count;
  const minWideFaces = rule.required_wide_face_count;

  const resolved = faces.filter((f) => f.width_m != null);
  const unresolved = faces.filter((f) => f.width_m == null);
  const narrowOk = resolved.filter((f) => f.width_m >= narrowM);
  const wideOk = resolved.filter((f) => f.width_m >= wideM);
  const meets = narrowOk.length >= minNarrowFaces && wideOk.length >= minWideFaces;

  const faceSummary = faces
    .map((f) => (f.width_m != null ? `${f.width_m}m(접촉 ${f.contact_m}m)` : `폭 미확인(접촉 ${f.contact_m}m)`))
    .join(", ");

  if (unresolved.length > 0) {
    return {
      verdict: "unresolved_faces",
      detail: `접한 도로 ${faces.length}면 중 폭 확인 ${resolved.length}면(${narrowM}m 이상 ${narrowOk.length}면, ${wideM}m 이상 ${wideOk.length}면), 나머지 ${unresolved.length}면 폭 미확인 [${faceSummary}]`,
    };
  }
  if (meets) {
    return {
      verdict: "met",
      detail: `접한 도로 ${faces.length}면 모두 폭 확인 — ${narrowM}m 이상 ${narrowOk.length}면, ${wideM}m 이상 ${wideOk.length}면으로 기준(${minNarrowFaces}면 이상 ${narrowM}m + 최소 ${minWideFaces}면 ${wideM}m)을 충족 [${faceSummary}]`,
    };
  }
  return {
    verdict: "not_met",
    detail: `접한 도로 ${faces.length}면 모두 폭 확인 — ${narrowM}m 이상 ${narrowOk.length}면, ${wideM}m 이상 ${wideOk.length}면으로 기준(${minNarrowFaces}면 이상 ${narrowM}m + 최소 ${minWideFaces}면 ${wideM}m)을 충족하지 못함 [${faceSummary}]`,
  };
}

/**
 * site_requirements[]의 "도로요건" 항목을 실측값으로 판정합니다.
 * reqItem.road_requirement_rule이 없거나 auto_check_capable이 아니면 null을
 * 돌려줍니다 — 이 경우 호출부는 원래대로(정적 criteria, "확인 필요")를 씁니다.
 * 어떤 사업유형이든 자기 rule이 있어야만 실측값을 쓰고, 다른 사업유형의
 * 기준값을 대신 빌려 쓰지 않습니다.
 */
// Rule Set의 status_mapping 값은 "조건부 적용 가능 — 현황도로 실측 기준(법적 확정 아님)"처럼
// 설명이 붙은 문장입니다. 내부 상태값은 반드시 4종(적용 가능/조건부 적용 가능/적용 불가/
// 확인 필요) 중 하나여야 하므로(CLAUDE.md 판정 안전 원칙), 앞의 canonical 값만 status로
// 쓰고 나머지 설명은 detail에 붙입니다 — status 필드에 긴 문장을 그대로 넣으면
// _dgOverallForClassified 같은 status 비교(===)가 조용히 틀어집니다.
const BT_CANONICAL_STATUSES = ["조건부 적용 가능", "적용 가능", "적용 불가", "확인 필요"];
function _splitCanonicalStatus(text) {
  if (!text) return { status: "확인 필요", note: "" };
  for (const s of BT_CANONICAL_STATUSES) {
    if (text.startsWith(s)) {
      const rest = text.slice(s.length).replace(/^\s*[—-]\s*/, "").trim();
      return { status: s, note: rest };
    }
  }
  return { status: "확인 필요", note: text };
}

function _roadRequirementEntry(reqItem) {
  const rule = reqItem && reqItem.roadRequirementRule;
  if (!rule || !rule.auto_check_capable) return null;
  if (!_roadRequirementResult || !_roadRequirementResult.faces) return null;

  const faces = _roadRequirementResult.faces;
  if (!faces.length) {
    const parsed = _splitCanonicalStatus(rule.status_mapping && rule.status_mapping.no_contact_found);
    const detail = ["대상지 경계에 접한 실폭도로 자료를 찾지 못했습니다.", parsed.note].filter(Boolean).join(" — ");
    return { status: parsed.status, resolved: false, detail, shortSummary: "접한 도로 확인 필요" };
  }

  const { verdict, detail } = _evaluateRoadFaces(faces, rule);
  const mapping = rule.status_mapping || {};
  const basisNote = rule.measurement_basis_used_by_system ? ` (${rule.measurement_basis_used_by_system})` : "";

  const mappingKey = verdict === "met" ? "met" : verdict === "not_met" ? "not_met" : "unresolved_faces";
  const parsed = _splitCanonicalStatus(mapping[mappingKey]);
  const fullDetail = [`${detail}${basisNote}`, parsed.note].filter(Boolean).join(" — ");
  // 첫 화면 대표요건 줄은 "N면 접함 · 짧은 결과"만 — 면별 폭·근거 문장은 detail(상세)에만 남김.
  const shortResult =
    verdict === "met" ? "요건 충족(현황도로 기준)" : verdict === "not_met" ? "요건 미충족(예외조항 확인 필요)" : "도로폭 확인 필요";
  const shortSummary = `${faces.length}면 접함 · ${shortResult}`;
  return { status: parsed.status, resolved: verdict === "met" || verdict === "not_met", detail: fullDetail, shortSummary };
}

/** 도심복합개발사업의 '역세권 위치'(500m)는 면적 과반 조건이라 한 방향만 확정합니다. */
function _urbanComplexStationEntry(reqResult) {
  if (!_stationAreaResult) return null;
  const d = _stationAreaResult.distance_m;
  if (d > 500) {
    // 가장 가까운 지점조차 500m 밖이면 '면적 과반이 500m 이내'가 성립할 수 없습니다.
    return { status: "적용 불가", resolved: true, detail: `승강장 경계에서 ${Math.round(d)}m — 대상지 전체가 500m 밖` };
  }
  // 500m 안에 걸치더라도 '과반'인지는 면적을 따져야 하므로 확정하지 않습니다.
  return { status: "확인 필요", resolved: false, detail: `승강장 경계에서 ${Math.round(d)}m — 500m 이내이나 '면적 과반' 여부는 별도 확인` };
}

function _collectStatusEntries(bt, context, reqResults) {
  const entries = reqResults.map((r) => {
    // 도심복합개발사업의 '역세권 위치'(500m)는 실측 거리로 한 방향만 확정합니다.
    if (r.item === "역세권 위치") {
      const m = _urbanComplexStationEntry(r);
      if (m) {
        return {
          status: m.status,
          kind: "auto",
          resolved: m.resolved,
          label: r.item,
          detail: m.detail,
          notes: r.notes,
          source: r.source,
          requirementLevel: r.requirementLevel,
          judgementEffect: r.judgementEffect,
          displayGroup: r.displayGroup,
          userActionRequired: r.userActionRequired,
        };
      }
    }
    // item 이름이 "도로요건"인 사업유형이면 어느 것이든 실측값을 씁니다(사업유형 종속 없음).
    if (r.item === "도로요건") {
      const m = _roadRequirementEntry(r);
      if (m) {
        return {
          status: m.status,
          kind: "auto",
          resolved: m.resolved,
          label: r.item,
          detail: m.detail,
          shortSummary: m.shortSummary,
          notes: r.notes,
          source: r.source,
          requirementLevel: r.requirementLevel,
          judgementEffect: r.judgementEffect,
          displayGroup: r.displayGroup,
          userActionRequired: r.userActionRequired,
        };
      }
    }
    return {
    status: r.status,
    shortSummary: r.shortSummary,
    kind: r.valueSource === "auto" ? "auto" : "manual",
    // resolved: 자동 처리 "대상"인 것과 자동으로 "확인이 끝난" 것은 다릅니다.
    // 데이터가 없어 판정하지 못한 항목을 확인 완료로 세면 안 됩니다.
    resolved: r.valueSource === "auto" ? !!r.autoResolved : false,
    label: r.item,
    detail: r.criteria,
    notes: r.notes,
    source: r.source,
    requirementLevel: r.requirementLevel,
    judgementEffect: r.judgementEffect,
    displayGroup: r.displayGroup,
    userActionRequired: r.userActionRequired,
    };
  });

  if (bt.eligible_zones) {
    const computed = bt.eligible_zones.auto_check ? _evaluateAutoCheck(bt.eligible_zones.auto_check, context) : null;
    entries.push({
      status: computed || "확인 필요",
      kind: "auto",
      resolved: computed != null,
      label: "적용 대상 용도지역",
      detail: context.zoneName ? `현재 용도지역 ${context.zoneName}` : "대상지 용도지역이 적용 가능 목록에 포함되는지",
      shortSummary: context.zoneName
        ? `${context.zoneName} · ${computed === "적용 불가" ? "대상 용도지역 아님" : "대상 용도지역에 해당"}`
        : "용도지역 확인 필요",
      notes: bt.eligible_zones.notes,
      source: bt.eligible_zones.source,
      requirementLevel: bt.eligible_zones.requirement_level || null,
      judgementEffect: bt.eligible_zones.judgement_effect || null,
      displayGroup: bt.eligible_zones.display_group || null,
      userActionRequired: bt.eligible_zones.user_action_required != null ? bt.eligible_zones.user_action_required : null,
    });
  }
  if (bt.exclusions) {
    const screeningNote = bt.id === "station_area_revitalization" ? _exclusionScreeningNote() : null;
    entries.push({
      status: _statusOf(bt.exclusions) || "확인 필요",
      kind: "manual",
      label: "제외대상·예외조건",
      detail: bt.exclusions.description,
      notes: bt.exclusions.notes,
      source: bt.exclusions.source,
      requirementLevel: bt.exclusions.requirement_level || null,
      judgementEffect: bt.exclusions.judgement_effect || null,
      displayGroup: bt.exclusions.display_group || null,
      userActionRequired: bt.exclusions.user_action_required != null ? bt.exclusions.user_action_required : null,
      screeningWarning: screeningNote,
    });
  }
  if (bt.station_area_range) {
    const stationEntry = _stationAreaEntry(bt);
    entries.push({
      ...stationEntry,
      requirementLevel: bt.station_area_range.requirement_level || null,
      judgementEffect: bt.station_area_range.judgement_effect || null,
      displayGroup: bt.station_area_range.display_group || null,
      userActionRequired: bt.station_area_range.user_action_required != null ? bt.station_area_range.user_action_required : null,
    });
  }
  if (bt.zoning_change_rule) {
    if (bt.zoning_change_rule.status !== undefined || bt.zoning_change_rule.description !== undefined) {
      entries.push({
        status: _statusOf(bt.zoning_change_rule) || "확인 필요",
        kind: "manual",
        label: "용도지역 변경 규칙",
        detail: bt.zoning_change_rule.description,
        notes: bt.zoning_change_rule.notes,
        source: bt.zoning_change_rule.source,
      });
    } else {
      Object.keys(bt.zoning_change_rule).forEach((key) => {
        const sub = bt.zoning_change_rule[key];
        entries.push({
          status: _statusOf(sub) || "확인 필요",
          kind: "manual",
          label: BT_SUBBLOCK_LABELS[key] || key,
          detail: sub.description,
          notes: sub.notes,
          source: sub.source,
        });
      });
    }
  }
  if (bt.far_table) {
    entries.push({ status: _statusOf(bt.far_table) || "확인 필요", kind: "manual", label: "용적률 규칙", detail: bt.far_table.notes, notes: null, source: bt.far_table.source });
  } else if (bt.far_rule) {
    entries.push({ status: _statusOf(bt.far_rule) || "확인 필요", kind: "manual", label: "용적률 규칙", detail: bt.far_rule.description, notes: bt.far_rule.notes, source: bt.far_rule.source });
  }
  if (bt.height_rule) {
    entries.push({ status: _statusOf(bt.height_rule) || "확인 필요", kind: "manual", label: "높이 규칙", detail: bt.height_rule.description, notes: bt.height_rule.notes, source: bt.height_rule.source });
  }
  if (bt.use_conditions) {
    entries.push({ status: _statusOf(bt.use_conditions) || "확인 필요", kind: "manual", label: "도입용도 조건", detail: bt.use_conditions.description, notes: bt.use_conditions.notes, source: bt.use_conditions.source });
  }
  if (bt.public_contribution_table) {
    entries.push({
      status: _statusOf(bt.public_contribution_table) || "확인 필요",
      kind: "manual",
      label: "공공기여 규칙",
      detail: bt.public_contribution_table.principle,
      notes: bt.public_contribution_table.notes,
      source: bt.public_contribution_table.source,
    });
  } else if (bt.public_contribution_rule) {
    entries.push({
      status: _statusOf(bt.public_contribution_rule) || "확인 필요",
      kind: "manual",
      label: "공공기여 규칙",
      detail: bt.public_contribution_rule.description,
      notes: bt.public_contribution_rule.notes,
      source: bt.public_contribution_rule.source,
    });
  }
  if (bt.public_contribution_relief) {
    entries.push({
      status: _statusOf(bt.public_contribution_relief) || "확인 필요",
      kind: "manual",
      label: "공공기여 완화 규칙",
      detail: bt.public_contribution_relief.description,
      notes: bt.public_contribution_relief.notes,
      source: bt.public_contribution_relief.source,
    });
  }

  // 개발조건류 규칙(용도지역 변경/용적률/높이/도입용도/공공기여 등)은 항목 성격상 항상
  // "개발조건 검토 단계"입니다 — Rule Set에 사업유형별로 다시 표시하지 않아도 되는
  // 구조적 분류라, 아직 requirementLevel이 없는 항목만 여기서 한 번에 채웁니다.
  // (미분류 사업유형은 이 값을 쓰는 새 화면으로 아직 넘어가지 않으므로 기존 표시에는
  // 영향이 없습니다 — _dgIsClassified가 primary_gate 존재 여부로만 분기합니다.)
  const DETAIL_TIER_LABELS = new Set([
    "용도지역 변경 규칙",
    "용적률 규칙",
    "높이 규칙",
    "도입용도 조건",
    "공공기여 규칙",
    "공공기여 완화 규칙",
    ...Object.values(BT_SUBBLOCK_LABELS || {}),
  ]);
  entries.forEach((e) => {
    if (e.requirementLevel == null && DETAIL_TIER_LABELS.has(e.label)) {
      e.requirementLevel = "detail";
      e.judgementEffect = e.judgementEffect || "informational";
      e.displayGroup = e.displayGroup || "개발조건";
      e.userActionRequired = e.userActionRequired != null ? e.userActionRequired : true;
    }
  });

  return entries;
}

/**
 * 사업제도 하나를 종합 분석합니다 — 카드 상단 배지(요청사항 10번: 확인 필요가
 * 남아있으면 적용 가능으로 단정하지 않음)와 Dashboard 추천 목록이 이 결과 하나를
 * 함께 씁니다. autoCount/manualCount는 "자동 확인 N건 / 추가 확인 M건" 표시에 씁니다.
 */
function _analyzeBusinessType(bt, context) {
  const reqResults = _computeSiteRequirementResults(bt, context);
  const entries = _collectStatusEntries(bt, context, reqResults);
  const statuses = entries.map((e) => e.status);
  const overallStatus = statuses.length
    ? statuses.reduce((worst, s) => ((BT_STATUS_RANK[s] || 3) > (BT_STATUS_RANK[worst] || 0) ? s : worst), statuses[0])
    : "확인 필요";
  // 세 숫자를 구분합니다. 예전에는 "kind가 auto인 항목 수"를 그대로 "자동 확인 N건"
  // 이라고 보여줬는데, 용도지역 조회에 실패해 판정하지 못한 항목까지 확인 완료처럼
  // 세는 문제가 있었습니다.
  //   autoTargetCount   자동 처리 대상 (시스템이 판정을 시도하는 항목 수)
  //   autoResolvedCount 자동 확인 완료 (실제로 판정이 끝난 항목 수)
  //   manualCount       사람이 직접 확인해야 하는 항목 수
  //   unresolvedCount   아직 확인되지 않은 항목 수 (자동 실패 + 수동)
  const autoTargetCount = entries.filter((e) => e.kind === "auto").length;
  const autoResolvedCount = entries.filter((e) => e.kind === "auto" && e.resolved).length;
  const autoFailedCount = autoTargetCount - autoResolvedCount;
  const manualCount = entries.length - autoTargetCount;
  const unresolvedCount = manualCount + autoFailedCount;
  // autoCount는 기존 호출부 호환용입니다 — 의미를 "확인 완료"로 좁혔습니다.
  const autoCount = autoResolvedCount;
  const issues = entries.filter((e) => e.status === "확인 필요" || e.status === "적용 불가");
  // Dashboard 추천 순위의 재료 — 이미 계산된 항목 중 실제로 맞았는지/틀렸는지
  // (예: eligible_zones가 대상지 용도지역과 실제로 맞는지)를 세어, 항목 수가 많다는
  // 이유만으로 더 자세히 모델링된 사업제도가 불리해지지 않게 합니다.
  const blockedCount = entries.filter((e) => e.status === "적용 불가").length;
  const positiveCount = entries.filter((e) => e.status === "적용 가능" || e.status === "조건부 적용 가능").length;

  const localAnalysis = {
    bt,
    context,
    reqResults,
    entries,
    overallStatus,
    autoCount,
    autoTargetCount,
    autoResolvedCount,
    autoFailedCount,
    manualCount,
    unresolvedCount,
    issues,
    blockedCount,
    positiveCount,
  };

  const backend = _backendBusinessTypeEvaluations && _backendBusinessTypeEvaluations.get(bt.id);
  if (!backend) return localAnalysis;

  const backendEntries = (backend.entries || []).map(_entryFromBackend);
  const counts = backend.counts || {};
  return {
    ...localAnalysis,
    entries: backendEntries,
    overallStatus: backend.overall_status || "확인 필요",
    autoCount: counts.auto_resolved || 0,
    autoTargetCount: counts.auto_target || 0,
    autoResolvedCount: counts.auto_resolved || 0,
    autoFailedCount: counts.auto_failed || 0,
    manualCount: counts.manual || 0,
    unresolvedCount: counts.unresolved || 0,
    issues: backendEntries.filter((e) => e.status === "확인 필요" || e.status === "적용 불가"),
    blockedCount: counts.blocked || 0,
    positiveCount: counts.positive || 0,
  };
}

function _renderBusinessTypeCard(bt, context) {
  const analysis = _analyzeBusinessType(bt, context);
  const reqRows = analysis.reqResults
    .map(
      (r) => `
        <tr>
          <td>${_escapeHtml(r.item)}</td>
          <td>${_escapeHtml(r.criteria)}</td>
          <td>${_escapeHtml(r.siteValueText)}</td>
          <td>${_btStatusBadge(r.status)}</td>
          <td class="bt-req-notes">${_escapeHtml(r.notes || "")}${_renderSourceTag(r.source)}</td>
        </tr>`
    )
    .join("");

  const incentives = (bt.additional_incentives || [])
    .map(
      (inc) =>
        `<li><strong>${_escapeHtml(inc.name)}</strong> — ${_escapeHtml(inc.description || "")} ${_btStatusBadge(inc.status)}${_renderSourceTag(inc.source)}</li>`
    )
    .join("");

  const procedure = (bt.procedure || []).map((p) => `<li>${_escapeHtml(p)}</li>`).join("");

  const legal = (bt.legal_basis || [])
    .map((l) => `${_escapeHtml(l.title)}${l.date ? ` (${_escapeHtml(l.date)})` : ""}`)
    .join(", ");

  const eligibleZonesHtml = bt.eligible_zones
    ? `<h4 class="bt-section-title">적용 대상 용도지역</h4>${_renderEligibleZones(bt.eligible_zones, context)}`
    : "";
  const exclusionsHtml = bt.exclusions
    ? `<h4 class="bt-section-title">제외대상·예외조건</h4>${_renderExclusions(bt.exclusions)}`
    : "";
  const stationAreaRangeHtml = bt.station_area_range
    ? `<h4 class="bt-section-title">역세권 범위</h4>${_renderStationAreaRange(bt.station_area_range)}`
    : "";

  const farHtml = bt.far_table
    ? `<h4 class="bt-section-title">용적률 규칙</h4>${_renderFarTable(bt.far_table)}`
    : bt.far_rule
    ? `<h4 class="bt-section-title">용적률 규칙</h4>${_renderRuleBlock(bt.far_rule)}`
    : "";

  const pcHtml = bt.public_contribution_table
    ? `<h4 class="bt-section-title">공공기여 규칙</h4>${_renderPublicContributionTable(bt.public_contribution_table, bt.public_contribution_relief)}`
    : bt.public_contribution_rule
    ? `<h4 class="bt-section-title">공공기여 규칙</h4>${_renderRuleBlock(bt.public_contribution_rule)}`
    : "";

  const card = document.createElement("div");
  card.className = "bt-card";
  card.dataset.businessTypeId = bt.id;
  card.innerHTML = `
    <details class="bt-card-details">
      <summary class="bt-card-summary">
        <span class="bt-card-name">${_escapeHtml(bt.name)}</span>
        <span class="bt-card-category">${_escapeHtml(bt.category || "")}</span>
        ${_btStatusBadge(analysis.overallStatus)}
      </summary>
      <div class="bt-card-body">
        <p class="bt-legal-basis">근거: ${legal || "확인 필요"}</p>

        ${eligibleZonesHtml}
        ${exclusionsHtml}
        ${stationAreaRangeHtml}

        <h4 class="bt-section-title">대상지 요건</h4>
        <div class="bt-table-wrap">
          <table class="bt-req-table">
            <thead><tr><th>검토항목</th><th>검토기준</th><th>대상지 값</th><th>판정</th><th>근거 및 비고</th></tr></thead>
            <tbody>${reqRows}</tbody>
          </table>
        </div>

        <h4 class="bt-section-title">용도지역 변경 규칙</h4>
        ${_renderZoningChangeRule(bt.zoning_change_rule)}

        ${farHtml}

        <h4 class="bt-section-title">높이 규칙</h4>
        ${_renderRuleBlock(bt.height_rule)}

        <h4 class="bt-section-title">도입용도 조건</h4>
        ${_renderRuleBlock(bt.use_conditions)}

        ${pcHtml}

        ${incentives ? `<h4 class="bt-section-title">추가 인센티브</h4><ul class="bt-list">${incentives}</ul>` : ""}
        ${procedure ? `<h4 class="bt-section-title">절차</h4><ol class="bt-list">${procedure}</ol>` : ""}
      </div>
    </details>
  `;
  return card;
}

/** "사업유형" 탭이 열릴 때마다 호출 — 목록은 캐시하고, 대상지 판정만 매번 새로 계산합니다. */
async function renderBusinessTypeTab() {
  const container = document.getElementById("business-type-list");
  const hint = document.getElementById("business-type-hint");
  if (!container) return;

  const businessTypes = await fetchBusinessTypes();

  const hasSelection = typeof selectedParcels !== "undefined" && selectedParcels.size > 0;
  if (hint) {
    hint.hidden = businessTypes.length > 0 && hasSelection;
    if (businessTypes.length === 0) hint.textContent = "사업제도 목록을 불러오지 못했습니다.";
    else if (!hasSelection) hint.textContent = "대상지를 선택하면 대상지 값이 채워집니다. (현재는 검토기준만 표시)";
  }

  const totalArea = typeof mergedParcelResult !== "undefined" && mergedParcelResult ? mergedParcelResult.total_area_sqm : null;
  const zoningContext = await getZoningContextForSelection();
  const context = { totalArea, zoneName: zoningContext.zoneName };
  await refreshBackendBusinessTypeEvaluations(context);

  container.innerHTML = "";
  businessTypes.forEach((bt) => {
    container.appendChild(_renderBusinessTypeCard(bt, context));
  });
}

// 상세 검토표는 평소 접혀 있습니다 — 처음 펼칠 때만 그립니다(매번 다시 그리면
// 사용자가 펼쳐 둔 카드가 닫혀 버립니다).
const _btDetails = document.getElementById("dw-bt-details");
if (_btDetails) {
  _btDetails.addEventListener("toggle", () => {
    if (_btDetails.open && !_btDetails.dataset.rendered) {
      _btDetails.dataset.rendered = "1";
      renderBusinessTypeTab();
    }
  });
}

/**
 * Dashboard의 "왜 그렇게 판단했지?" 같은 진입점에서 씁니다 — 상세 검토표를 펼치고,
 * 해당 사업제도 카드만 열어서 화면에 보이도록 스크롤합니다.
 */
async function openBusinessTypeDetailCard(businessTypeId) {
  if (_btDetails) {
    _btDetails.open = true;
    _btDetails.dataset.rendered = "1";
  }
  await renderBusinessTypeTab();
  const card = document.querySelector(`.bt-card[data-business-type-id="${businessTypeId}"]`);
  if (!card) {
    if (typeof selectDevWorkspaceTab === "function") selectDevWorkspaceTab("business-type");
    return;
  }
  const details = card.querySelector(".bt-card-details");
  if (details) details.open = true;
  card.scrollIntoView({ block: "start", behavior: "smooth" });
}

/* ------------------------------------------------------------------ */
/* OP(개발대안) 관리 — "개발규모" 탭. 계산 로직 없이 입력 구조만 제공합니다.        */
/* ------------------------------------------------------------------ */

let _opCounter = 0;
let _opRows = []; // [{ id, business_type, ..., _origin }] — 화면이 아니라 여기가 원본입니다
let _opPreferredId = null;

/* ------------------------------------------------------------------ */
/* 검토 상태의 소유자 — "이 검토 내용이 어느 대상지의 것인가"                   */
/* ------------------------------------------------------------------ */

// 검토 내용(OP·우선검토·의견)이 속한 대상지. Chapter 1↔2를 오가도 같은 대상지면
// 그대로 유지하고, 대상지가 바뀌면 지우지 않고 "다른 대상지의 검토"로 표시합니다.
// 화면을 닫았다는 이유만으로 사용자가 입력한 내용을 삭제하지 않습니다.
let _reviewSiteKey = null;
let _reviewSiteLabel = null;
let _reviewStale = false; // 현재 대상지와 다른 대상지의 검토인가
let _reviewNote = "";

/** 선택 필지 집합을 식별하는 키. 순서가 달라도 같은 집합이면 같은 키가 나옵니다. */
function _devReviewSiteKey() {
  if (typeof selectedParcels === "undefined" || !selectedParcels) return null;
  const keys = Array.from(selectedParcels.keys()).sort();
  return keys.length ? keys.join(",") : null;
}

function _devReviewSiteLabel() {
  if (typeof selectedParcels === "undefined" || !selectedParcels || selectedParcels.size === 0) return null;
  const addresses = Array.from(selectedParcels.values())
    .map((p) => p.address)
    .filter(Boolean);
  const regions = new Set(addresses.map((a) => a.split(" ").slice(0, 4).join(" ")));
  const label = Array.from(regions).slice(0, 2).join(", ");
  return selectedParcels.size > 1 ? `${label} 외 ${selectedParcels.size - 1}필지` : label || null;
}

function _devReviewHasContent() {
  return _opRows.length > 0 || (_reviewNote || "").trim() !== "";
}

/**
 * 워크스페이스를 열 때마다 호출합니다(js/dev-workspace.js).
 * - 같은 대상지     → 아무것도 하지 않음. OP·우선검토·의견이 그대로 남습니다.
 * - 대상지가 바뀜   → 지우지 않고 stale로 표시. 파생 결과(연면적 등)는 재검토 대상입니다.
 * - 검토 내용 없음  → 그냥 현재 대상지에 귀속시킵니다.
 */
function bindDevelopmentReviewToSite() {
  const key = _devReviewSiteKey();
  const label = _devReviewSiteLabel();

  if (!_devReviewHasContent()) {
    _reviewSiteKey = key;
    _reviewSiteLabel = label;
    _reviewStale = false;
  } else if (_reviewSiteKey && key && _reviewSiteKey !== key) {
    _reviewStale = true;
  } else if (_reviewSiteKey === key) {
    _reviewStale = false;
  }

  const noteEl = document.getElementById("dw-review-note");
  if (noteEl) noteEl.value = _reviewNote;
  renderOpTable();
  _renderReviewStaleBanner(label);
}

/** 다른 대상지의 검토가 남아 있을 때 띄우는 안내. 지우기는 사용자가 직접 누릅니다. */
function _renderReviewStaleBanner(currentLabel) {
  const host = document.getElementById("dw-review-banner");
  if (!host) return;
  if (!_reviewStale) {
    host.hidden = true;
    host.innerHTML = "";
    return;
  }
  host.hidden = false;
  host.innerHTML = `
    <strong>다른 대상지의 검토 내용이 남아 있습니다.</strong>
    <p>아래 OP·우선 검토·검토 의견은 <b>${_escapeHtml(_reviewSiteLabel || "이전 대상지")}</b> 기준으로 작성된 것입니다.
    현재 대상지는 <b>${_escapeHtml(currentLabel || "확인 필요")}</b> 입니다 —
    용적률·연면적·공공기여 등 대상지에서 파생된 값은 <b>모두 재검토 대상</b>입니다.</p>
    <div class="dw-review-banner-actions">
      <button type="button" class="dw-ghost-btn" id="btn-review-keep">그대로 두고 직접 수정</button>
      <button type="button" class="dw-ghost-btn" id="btn-review-restart">이 대상지로 새로 시작 (검토 내용 삭제)</button>
    </div>`;

  const keepBtn = document.getElementById("btn-review-keep");
  if (keepBtn) {
    keepBtn.addEventListener("click", () => {
      // 사용자가 "내가 알고 쓴다"고 밝힌 경우 — 내용을 현재 대상지로 옮기되
      // 표의 값들은 여전히 미검증 상태 그대로 둡니다.
      _reviewSiteKey = _devReviewSiteKey();
      _reviewSiteLabel = _devReviewSiteLabel();
      _reviewStale = false;
      renderOpTable();
      _renderReviewStaleBanner(_reviewSiteLabel);
    });
  }
  const restartBtn = document.getElementById("btn-review-restart");
  if (restartBtn) {
    restartBtn.addEventListener("click", () => {
      resetDevelopmentOptions();
      _reviewSiteKey = _devReviewSiteKey();
      _reviewSiteLabel = _devReviewSiteLabel();
      _reviewStale = false;
      _renderReviewStaleBanner(_reviewSiteLabel);
    });
  }
}

/**
 * 비교표의 행 정의.
 *
 * 용적률을 네 가지로 나눠 둡니다 — 한 칸에 몰아넣으면 서로 다른 의미가 덮어써집니다.
 *   기준 용적률        제도·조례가 정한 출발점
 *   허용 용적률        인센티브 산정 결과(계획안마다 달라짐)
 *   규칙상 상한 용적률  제도가 정한 한도(far_table의 cap)
 *   계산상 상한 용적률  허용 + 공공기여 완화 = 이 프로그램이 계산한 값
 *   계획 용적률        사용자가 검토용으로 가정한 값
 *
 * raw가 있는 항목은 값이 row.raw에 들어 있습니다(= 계산기 입력과 같은 저장소).
 * 표에서 고치든 상세 패널에서 고치든 결국 같은 곳에 쓰이므로 두 화면이 어긋나지 않습니다.
 */
const OP_FIELDS = [
  // tier "core"   — 기본 화면. 대안끼리 실제로 다른 것.
  // tier "detail" — 용적률 네 종류. "용적률 상세 보기"를 켜야 나옵니다.
  //                 의미가 다른 값이므로 합치거나 덮어쓰지 않고 칸을 따로 둡니다.
  { field: "business_type", label: "사업방식", type: "text", tier: "core", placeholder: "예: 역세권 활성화사업" },
  { field: "use_type", label: "도입용도", type: "text", tier: "core", placeholder: "확인 후 입력" },
  { field: "zone_after", label: "바꾸려는 용도지역", type: "text", tier: "core", placeholder: "확인 후 입력" },
  { field: "_far_summary", label: "적용 용적률", type: "derived", tier: "core" },
  { field: "_floor", label: "예상 연면적", type: "derived", tier: "core", hint: "대지면적 × 용적률" },
  { field: "height", label: "높이(m)", type: "number", tier: "core" },
  { field: "_contrib", label: "계획안 계산 공공기여율", type: "derived", tier: "core", hint: "입력한 계획안(토지·건축물·현금)을 계산 엔진에 넣은 결과 — Rule Set 최소값이 아님" },
  { field: "notes", label: "주요 조건", type: "textarea", tier: "core", placeholder: "확인된 조건만 적으세요" },
  { field: "far_base", raw: "farBase", label: "기준 용적률(%)", type: "number", tier: "detail", hint: "조례가 정한 출발점" },
  { field: "far_allowed", raw: "farAllowed", label: "계획한 허용 용적률(%)", type: "number", tier: "detail", hint: "인센티브를 더해 계획안이 채택하는 값 — 상한용적률 산식에 그대로 더해집니다" },
  { field: "far_rule_cap", label: "규칙상 상한 용적률(%)", type: "number", tier: "detail", hint: "제도에서 정한 최대 한도" },
  { field: "_computed_cap", label: "계산상 상한 용적률(%)", type: "derived", tier: "detail", hint: "공공기여를 반영해 계산한 값" },
  { field: "far_planned", label: "계획 용적률(%)", type: "number", tier: "detail", hint: "계획안에서 실제로 적용할 값" },
  {
    field: "rule_min_contribution_pct",
    label: "제도상 최소 공공기여율(%)",
    type: "number",
    tier: "detail",
    hint: "Rule Set 표의 최소값 — 계획안 계산 공공기여율과 다른 칸(섞지 않음)",
  },
];

/** 지금 화면에 보일 행. "세부 항목 보기"가 꺼져 있으면 core만 보여줍니다. */
function _opVisibleFields() {
  const more = document.getElementById("dw-op-show-detail");
  return more && more.checked ? OP_FIELDS : OP_FIELDS.filter((d) => d.tier === "core");
}

const OP_RAW_KEYS = [
  "farBase", "farAllowed", "farFormula", "landArea", "cash",
  "siteValueMethod", "siteValue", "wLand", "profileId", "buildingFacilities",
];

/**
 * 계산기 입력의 기본값 — 전부 빈칸(시설 목록은 빈 배열)입니다. 계수·단가·부지가액에
 * 고정 기본값을 두지 않습니다(운영기준이 사업유형·사례별로 다른 값을 요구하므로,
 * 값을 안 채우면 미산정으로 남고 사용자가 직접 선택/입력해야만 계산됩니다).
 */
function _opDefaultRaw() {
  return {
    farBase: "", farAllowed: "", farFormula: "", landArea: "", cash: "",
    siteValueMethod: "", siteValue: "", wLand: "",
    profileId: "", buildingFacilities: [],
  };
}

/** OP가 만들어진 시점의 대상지를 고정해 둡니다 — 나중에 대상지가 바뀌어도 조용히 바뀌지 않게. */
function _opCurrentSiteSnapshot() {
  const ctx = typeof fsBuildContext === "function" ? fsBuildContext() : { totalArea: null };
  return {
    key: _devReviewSiteKey(),
    label: _devReviewSiteLabel(),
    totalArea: ctx.totalArea,
  };
}

/** 이 OP가 지금 선택된 대상지의 것인가. 아니면 결과를 재검토 상태로 둡니다. */
function _opIsStale(row) {
  const now = _devReviewSiteKey();
  return !!(row.site && row.site.key && now && row.site.key !== now);
}

function _opGetValue(row, def) {
  if (def.raw) return row.raw && row.raw[def.raw] != null ? row.raw[def.raw] : "";
  const v = row[def.field];
  return v == null ? "" : String(v);
}

function _opSetValue(row, def, v) {
  if (def.raw) {
    if (!row.raw) row.raw = _opDefaultRaw();
    row.raw[def.raw] = v;
  } else {
    row[def.field] = v;
  }
}

/**
 * OP 하나를 그 OP 자신의 대상지 스냅샷으로 계산합니다.
 * 현재 선택 대상지가 아니라 row.site를 쓰는 것이 핵심입니다 — 대상지가 바뀌었다고
 * 이전 OP의 결과가 새 면적으로 조용히 바뀌면 안 됩니다.
 */
function opRecalcRow(row) {
  if (typeof computeContributionFar !== "function") return;
  const site = row.site || { totalArea: null };
  const raw = row.raw || _opDefaultRaw();
  const profile = raw.profileId && typeof getContributionCalcProfile === "function" ? getContributionCalcProfile(raw.profileId) : null;
  row._calc = computeContributionFar({ totalArea: site.totalArea, profile }, raw);
}

/* ------------------------------------------------------------------ */
/* 파생 표시값                                                            */
/* ------------------------------------------------------------------ */

/** 검토 연면적 — 계획 용적률이 있으면 그것을, 없으면 계산상 상한을 씁니다. */
function _opFloorInfo(row) {
  const area = row.site ? row.site.totalArea : null;
  if (area == null) return { text: "", basis: null };
  const planned = _fsParseNumber(row.far_planned);
  if (planned.entered && !planned.invalid && planned.value != null) {
    return { text: `${Math.round((area * planned.value) / 100).toLocaleString("ko-KR")} m²`, basis: "planned" };
  }
  const cap = row._calc ? row._calc.computedCap : null;
  if (cap == null) return { text: "", basis: null };
  return { text: `${Math.round((area * cap) / 100).toLocaleString("ko-KR")} m²`, basis: "computed" };
}

/**
 * 파생 셀. 열마다 같은 주석("참고 계산 — Excel 검증 전")을 반복하지 않습니다 —
 * 모든 OP에 똑같이 해당하는 설명은 표 아래 한 줄로 한 번만 적습니다.
 * 여기 note는 **그 OP에서만 다른 것**(기준이 다름, 미산정 사유 있음)만 남깁니다.
 */
function _opDerivedCell(row, def) {
  if (def.field === "_far_summary") {
    // 한 숫자로 합치지 않습니다 — 계획값과 계산값은 뜻이 다르므로 각각 이름을 답니다.
    const planned = _fsParseNumber(row.far_planned);
    const computed = row._calc ? row._calc.computedCap : null;
    const lines = [];
    if (planned.entered && !planned.invalid && planned.value != null) {
      lines.push(`계획 ${planned.value}%`);
    }
    if (computed != null) lines.push(`계산상 상한 ${fsFormatFar(computed)}`);
    if (!lines.length) {
      return { text: "아직 정해지지 않음", note: "개발조건에서 허용 용적률과 공공기여를 입력하세요", muted: true };
    }
    return { text: lines[0], note: lines[1] || "", muted: false };
  }
  if (def.field === "_computed_cap") {
    const v = row._calc ? row._calc.computedCap : null;
    return {
      text: v != null ? fsFormatFar(v) : "미산정",
      note: v != null ? "" : "허용 용적률·공공기여 입력 시 산정",
      muted: v == null,
    };
  }
  if (def.field === "_contrib") {
    const v = row._calc ? row._calc.totalPct : undefined;
    return {
      text: row._calc ? fsFormatPct(v) : "미산정",
      note: row._calc && row._calc.reasons.length ? `사유 ${row._calc.reasons.length}건` : "",
      muted: v == null || v === FS_UNUSED,
    };
  }
  if (def.field === "_floor") {
    const info = _opFloorInfo(row);
    if (!info.text) return { text: "용적률 입력 시 산정", note: "", muted: true };
    // 기본은 계산상 상한 기준이므로 주석을 생략하고, 다른 기준일 때만 표시합니다.
    return { text: info.text, note: info.basis === "planned" ? "계획 용적률 기준" : "", muted: false };
  }
  return { text: "", note: "", muted: true };
}

/* ------------------------------------------------------------------ */
/* 값의 출처                                                             */
/* ------------------------------------------------------------------ */

/**
 * 셀 하나의 출처. Rule Set 표에서 자동으로 채운 값은 "아직 검증되지 않은 초안"이고,
 * 사용자가 직접 입력·수정한 값은 "사용자 가정"입니다. 둘 다 "법적으로 확인된 값"이
 * 아니지만 성격이 다르므로 화면에서 구분합니다.
 */
function _opOrigin(row, field) {
  return (row._origin && row._origin[field]) || null;
}

/**
 * OP 하나의 상태를 "지금 무엇을 해야 하는지"로 바꿉니다.
 * "초안 3 · 미산정 2" 같은 내부 표현 대신 사용자가 할 일을 적습니다.
 */
function _opStatusInfo(row) {
  if (_opIsStale(row)) {
    return { kind: "other-site", label: "다른 대상지 기준", detail: (row.site && row.site.label) || "" };
  }
  const reasons = row._calc ? row._calc.reasons.length : 0;
  if (row._calc && row._calc.computedCap != null) {
    return { kind: "ok", label: "규모 계산됨", detail: reasons ? `확인할 점 ${reasons}건` : "" };
  }
  if (reasons) {
    return { kind: "need-input", label: `입력 ${reasons}건 필요`, detail: "개발조건에서 채우세요" };
  }
  return { kind: "need-input", label: "입력 필요", detail: "개발조건에서 채우세요" };
}

/* ------------------------------------------------------------------ */
/* 비교표                                                               */
/* ------------------------------------------------------------------ */

function _opCellValue(row, def) {
  if (def.type === "derived") return _opDerivedCell(row, def).text;
  return _opGetValue(row, def);
}

/**
 * OP 비교표를 다시 그립니다. 세로 카드 대신 가로 비교표인 이유는, 실무에서 확인하는
 * 것이 "OP 하나의 내용"이 아니라 "OP들 사이의 차이"이기 때문입니다.
 */
function renderOpTable() {
  const host = document.getElementById("op-list");
  if (!host) return;

  const countEl = document.getElementById("dw-op-count");
  const emptyEl = document.getElementById("dw-op-empty");
  const diffOnlyEl = document.getElementById("dw-op-diff-only");
  const diffOnly = !!(diffOnlyEl && diffOnlyEl.checked);

  if (countEl) countEl.textContent = `OP ${_opRows.length}개`;
  if (emptyEl) emptyEl.hidden = _opRows.length > 0;
  host.hidden = _opRows.length === 0;
  if (_opRows.length === 0) {
    host.innerHTML = "";
    _renderOpPreferred();
    return;
  }

  const base = _opVisibleFields();
  const visible = diffOnly
    ? base.filter((def) => new Set(_opRows.map((r) => _opCellValue(r, def))).size > 1)
    : base;

  const head = _opRows
    .map((row, i) => {
      const chosen = _opPreferredId === row.id;
      const active = _opActiveId === row.id;
      const st = _opStatusInfo(row);
      return `
        <th scope="col" class="${active ? "op-col-active" : ""}">
          <span class="op-label">OP${i + 1}</span>
          <span class="op-col-state is-${st.kind}">${_escapeHtml(st.label)}</span>
          ${st.detail ? `<span class="op-col-summary">${_escapeHtml(st.detail)}</span>` : ""}
          <div class="op-actions">
            <button type="button" class="dw-ghost-btn ${active ? "chosen" : ""}" data-op-detail="${row.id}">개발조건 확인·수정</button>
            <button type="button" class="dw-ghost-btn ${chosen ? "chosen" : ""}" data-op-prefer="${row.id}" aria-pressed="${chosen}">${chosen ? "우선 검토 선택됨" : "우선 검토로 선택"}</button>
            <button type="button" class="dw-ghost-btn" data-op-remove="${row.id}">삭제</button>
          </div>
        </th>`;
    })
    .join("");

  const body = visible
    .map((def) => {
      const cells = _opRows
        .map((row) => {
          if (def.type === "derived") {
            const d = _opDerivedCell(row, def);
            return `<td class="${d.muted ? "unknown" : ""}">${_escapeHtml(d.text)}${
              d.note ? `<br /><span class="dd-muted-inline">${_escapeHtml(d.note)}</span>` : ""
            }</td>`;
          }
          const val = _opGetValue(row, def);
          const o = _opOrigin(row, def.field);
          const draftCls = o && o.kind === "table" ? " op-cell-draft" : "";
          const title = o && o.kind === "table" ? [o.source, o.condition].filter(Boolean).join(" · ") : "";
          if (def.type === "textarea") {
            return `<td><textarea class="op-field" data-op-id="${row.id}" data-field="${def.field}" placeholder="${_escapeHtml(def.placeholder || "")}">${_escapeHtml(val)}</textarea></td>`;
          }
          return `<td class="${draftCls.trim()}"><input type="${def.type}" class="op-field" data-op-id="${row.id}" data-field="${def.field}" title="${_escapeHtml(title)}" placeholder="${_escapeHtml(def.placeholder || "확인 필요")}" value="${_escapeHtml(val)}" /></td>`;
        })
        .join("");
      const hint = def.hint ? `<br /><span class="dd-muted-inline">${_escapeHtml(def.hint)}</span>` : "";
      return `<tr><th scope="row">${_escapeHtml(def.label)}${hint}</th>${cells}</tr>`;
    })
    .join("");

  const emptyDiffRow =
    diffOnly && visible.length === 0
      ? `<tr><td colspan="${_opRows.length + 1}" class="unknown">항목 값이 모두 같습니다 — 차이가 없습니다.</td></tr>`
      : "";

  host.innerHTML = `<table class="op-table"><thead><tr><th scope="col">비교항목</th>${head}</tr></thead><tbody>${body}${emptyDiffRow}</tbody></table>`;
  const footEl = document.getElementById("dw-op-table-note");
  if (footEl) footEl.hidden = _opRows.length === 0;
  if (typeof renderReviewSummary === "function") renderReviewSummary();
  _renderOpPreferred();
  if (typeof renderConclusionFollowups === "function") renderConclusionFollowups();
}

/** 04 종합의견 1·2부 — 고른 대안이 무엇이고, 무엇이 확인됐는지. */
function _renderOpPreferred() {
  const el2 = document.getElementById("dw-preferred");
  const detailEl = document.getElementById("dw-preferred-detail");
  const autoEl = document.getElementById("dw-preferred-auto");
  if (!el2) return;

  const idx = _opRows.findIndex((r) => r.id === _opPreferredId);
  if (idx < 0) {
    el2.textContent = "아직 고르지 않았습니다. 03 개발대안 비교에서 '우선 검토로 선택'을 누르세요.";
    el2.classList.add("dd-muted");
    if (detailEl) detailEl.innerHTML = "";
    if (autoEl) autoEl.innerHTML = "";
    return;
  }

  const row = _opRows[idx];
  const st = _opStatusInfo(row);
  el2.classList.remove("dd-muted");
  el2.textContent = `OP${idx + 1} · ${[row.business_type, row.use_type].filter(Boolean).join(" / ") || "사업방식 미입력"}`;

  if (detailEl) {
    const planned = _fsParseNumber(row.far_planned);
    const rows = [
      ["바꾸려는 용도지역", row.zone_after || "아직 정하지 않음"],
      [
        "적용 용적률",
        planned.entered && !planned.invalid
          ? `계획 ${planned.value}%`
          : row._calc && row._calc.computedCap != null
            ? `계산상 상한 ${fsFormatFar(row._calc.computedCap)}`
            : "아직 정해지지 않음",
      ],
      ["예상 연면적", _opFloorInfo(row).text || "아직 계산되지 않음"],
      ["공공기여", row._calc ? fsFormatPct(row._calc.totalPct) : "아직 계산되지 않음"],
    ];
    detailEl.innerHTML = `<dl class="feasibility-dl">${rows
      .map(([k, v]) => `<dt>${_escapeHtml(k)}</dt><dd>${_escapeHtml(v)}</dd>`)
      .join("")}</dl>
      <p class="dw-status-line ${st.kind === "ok" ? "dw-status-ok" : "dw-status-todo"}"><b>${_escapeHtml(st.label)}</b>
      이 숫자는 검토용 계산이며, 법적으로 적용 가능한지는 따로 확인해야 합니다.</p>`;
  }

  if (autoEl) {
    const good = [];
    const limits = [];
    if (row.zone_after) good.push(`용도지역 변경 전제: ${row.zone_after}`);
    if (row._calc && row._calc.computedCap != null) {
      good.push(`공공기여를 반영한 규모가 계산됩니다 (${fsFormatFar(row._calc.computedCap)})`);
    }
    if (row._calc && row._calc.reasons.length) {
      row._calc.reasons.slice(0, 2).forEach((r) => limits.push(r));
    }
    if (!row.far_planned) limits.push("계획 용적률(실제 적용할 값)을 아직 정하지 않았습니다");
    autoEl.innerHTML = `
      <p class="dw-auto-label">프로그램이 확인한 내용</p>
      <ul class="dw-auto-list">
        ${good.map((g) => `<li class="is-ok">${_escapeHtml(g)}</li>`).join("")}
        ${limits.map((g) => `<li class="is-todo">${_escapeHtml(g)}</li>`).join("")}
        ${!good.length && !limits.length ? '<li class="is-todo">아직 확인된 내용이 없습니다.</li>' : ""}
      </ul>`;
  }
}

/* ------------------------------------------------------------------ */
/* OP 상세(조건·계산 근거) 패널                                            */
/* ------------------------------------------------------------------ */

let _opActiveId = null;
let _opPanelLoading = false;

function _opDetailEls() {
  return {
    root: document.getElementById("dw-op-detail"),
    title: document.getElementById("dw-op-detail-title"),
    sub: document.getElementById("dw-op-detail-sub"),
    profile: document.getElementById("dw-op-detail-profile"),
    stale: document.getElementById("dw-op-detail-stale"),
    body: document.querySelector(".dw-op-detail-body"),
  };
}

function _opPanelInputs() {
  const facilityInputs = el.fsBldgFacilities
    ? Array.from(el.fsBldgFacilities.querySelectorAll("input, select, button"))
    : [];
  return [
    el.fsFarBase, el.fsFarAllowed, el.fsFarFormula, el.fsGiveLandArea, el.fsGiveCash,
    el.fsSiteValueMethod, el.fsSiteValue, el.fsWeightLand, el.fsCalcProfile, el.btnFsAddFacility,
  ]
    .filter(Boolean)
    .concat(facilityInputs);
}

/** OP 하나의 조건·계산 근거를 엽니다. 한 번에 하나만 편집합니다. */
function openOpDetail(id) {
  const row = _opRows.find((r) => r.id === Number(id));
  const d = _opDetailEls();
  if (!row || !d.root) return;

  _opActiveId = row.id;
  const idx = _opRows.indexOf(row);
  const stale = _opIsStale(row);

  d.root.hidden = false;
  if (d.title) d.title.textContent = `OP${idx + 1}`;
  if (d.sub) {
    const bits = [row.business_type, row.use_type, row.zone_after].filter(Boolean);
    d.sub.textContent = bits.length ? bits.join(" · ") : "사업제도·도입용도가 아직 입력되지 않았습니다";
  }
  if (d.profile) {
    // 이 OP가 지금 계산되는지, 안 되면 무엇이 부족한지를 먼저 알려줍니다.
    const st = _opStatusInfo(row);
    const reasons = row._calc ? row._calc.reasons : [];
    if (st.kind === "ok") {
      d.profile.className = "dw-op-profile is-ok";
      d.profile.textContent = `규모가 계산됐습니다. 계산상 상한 용적률 ${fsFormatFar(row._calc.computedCap)}.`;
    } else if (st.kind === "other-site") {
      d.profile.className = "dw-op-profile";
      d.profile.textContent = "다른 대상지 기준으로 계산된 결과입니다.";
    } else {
      d.profile.className = "dw-op-profile is-todo";
      d.profile.textContent = reasons.length
        ? `아직 규모가 계산되지 않습니다. ${reasons[0]}`
        : "아직 규모가 계산되지 않습니다. 아래에서 허용 용적률과 공공기여를 입력하세요.";
    }
  }
  if (d.stale) {
    d.stale.hidden = !stale;
    if (stale) {
      d.stale.textContent =
        `이 OP는 ${(row.site && row.site.label) || "다른 대상지"} 기준으로 계산됐습니다. ` +
        `지금 선택된 대상지와 달라 편집과 재계산을 막아 두었습니다 — 아래 값은 원래 대상지 기준 결과입니다.`;
    }
  }

  // 이 OP의 사업유형이 계산 프로필과 실제로 연결해도 되는 근거가 있는지 경고합니다
  // (business_types.json의 contribution_calc_profile_link, 8.12단계) — 일반 기부채납
  // 산식과 사업유형 고유 산식을 한 결과처럼 섞어 보여주지 않기 위함입니다.
  if (el.fsCalcLinkWarning) {
    const bt = row.business_type_id && _businessTypesCache ? _businessTypesCache.find((b) => b.id === row.business_type_id) : null;
    const link = bt ? bt.contribution_calc_profile_link : null;
    if (!link || link.status.indexOf("연결 가능") !== 0) {
      el.fsCalcLinkWarning.hidden = false;
      el.fsCalcLinkWarning.textContent = link
        ? `⚠️ 계산 기준 확인 필요 — "${row.business_type || bt.name}"의 계산 프로필 연결 상태: ${link.status}. ${link.note}`
        : `⚠️ 계산 기준 확인 필요 — "${row.business_type || "이 사업유형"}"이 계산 프로필과 연결해도 되는지 아직 확인되지 않았습니다.`;
    } else {
      el.fsCalcLinkWarning.hidden = true;
      el.fsCalcLinkWarning.textContent = "";
    }
  }

  // 입력칸에 이 OP의 값을 싣습니다. 로딩 중에는 되쓰기를 막습니다.
  _opPanelLoading = true;
  if (typeof fsWritePanelRaw === "function") fsWritePanelRaw(row.raw || _opDefaultRaw());
  _opPanelInputs().forEach((inp) => {
    inp.disabled = stale;
  });
  _opPanelLoading = false;

  if (stale) {
    _opRenderStoredResult(row);
  } else if (typeof recomputeFeasibilityFar === "function") {
    recomputeFeasibilityFar();
  }

  renderOpTable();
  d.root.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function closeOpDetail() {
  _opActiveId = null;
  const d = _opDetailEls();
  if (d.root) d.root.hidden = true;
  renderOpTable();
}

/** 다른 대상지 OP는 다시 계산하지 않고, 저장된 결과를 그대로 보여줍니다. */
function _opRenderStoredResult(row) {
  const c = row._calc;
  if (!c) return;
  el.fsContribLandPct.textContent = fsFormatPct(c.landPct);
  el.fsContribBldgPct.textContent = fsFormatPct(c.bldgPct);
  el.fsContribCashPct.textContent = fsFormatPct(c.cashPct);
  el.fsContribTotalPct.textContent = fsFormatPct(c.totalPct);
  el.fsFarRelief.textContent = fsFormatFar(c.relief);
  el.fsFarCap.textContent = fsFormatFar(c.computedCap);
  el.fsFloorBase.textContent = fsFormatArea(c.floorBase);
  el.fsFloorCap.textContent = fsFormatArea(c.floorCap);
  el.fsFloorIncrease.textContent = fsFormatArea(c.floorIncrease);
  if (el.fsUnmetReasons) {
    el.fsUnmetReasons.innerHTML = "";
    c.reasons.forEach((r) => {
      const li = document.createElement("li");
      li.textContent = r;
      el.fsUnmetReasons.appendChild(li);
    });
    el.fsUnmetReasons.hidden = c.reasons.length === 0;
  }
}

/**
 * 지금 열려 있는 OP가 "다른 대상지 기준"이라 편집·재계산을 막아야 하는 상태인가.
 * app.js의 recomputeFeasibilityFar()가 이 값을 보고 재계산 대신 저장된 결과를 보여줍니다.
 * (공시지가 토글·대상지 변경 등 다른 경로로 재계산이 트리거돼도 표시가 현재 대상지
 *  기준으로 덮어써지지 않게 하기 위함입니다.)
 */
function opPanelIsReadOnly() {
  if (_opActiveId == null) return false;
  const row = _opRows.find((r) => r.id === _opActiveId);
  return !!(row && _opIsStale(row));
}

/** 읽기 전용 상태에서 패널에 저장된 결과를 다시 그립니다. */
function opRenderActiveStoredResult() {
  const row = _opRows.find((r) => r.id === _opActiveId);
  if (row) _opRenderStoredResult(row);
}

/**
 * app.js의 recomputeFeasibilityFar()가 계산을 마칠 때마다 부릅니다.
 * 패널의 입력과 결과를 **지금 열려 있는 OP에만** 적어 둡니다 — 다른 OP는 건드리지 않습니다.
 */
function opSyncFromPanel(result) {
  if (_opPanelLoading || _opActiveId == null) return;
  const row = _opRows.find((r) => r.id === _opActiveId);
  if (!row || _opIsStale(row)) return;

  const raw = typeof fsReadPanelRaw === "function" ? fsReadPanelRaw() : null;
  if (raw) {
    if (!row.raw) row.raw = _opDefaultRaw();
    OP_RAW_KEYS.forEach((k) => {
      if (row.raw[k] !== raw[k]) {
        row.raw[k] = raw[k];
        // 사용자가 상세 패널에서 고친 값도 "사용자 가정"입니다.
        const def = OP_FIELDS.find((f) => f.raw === k);
        if (def) {
          if (!row._origin) row._origin = {};
          if (raw[k] === "") delete row._origin[def.field];
          else row._origin[def.field] = { kind: "user" };
        }
      }
    });
  }
  row._calc = result;
  renderOpTable();
}

/* ------------------------------------------------------------------ */
/* OP 추가·삭제                                                          */
/* ------------------------------------------------------------------ */

/**
 * prefill은 선택 사항입니다 — Dashboard의 "이 사업제도로 개발대안 만들기"에서 확인된
 * 값(사업제도명·변경 후 용도지역 등)만 채우고, Rule Set에서 확인되지 않은 용적률·높이·
 * 공공기여율은 절대 채우지 않습니다(빈칸 그대로 → 사용자가 직접 확인해서 입력).
 */
function addDevelopmentOption(prefill) {
  const p = prefill && typeof prefill === "object" && !prefill.type ? prefill : {};
  const origins = p._origin || {};
  _opCounter += 1;
  const row = {
    id: _opCounter,
    business_type_id: p.business_type_id || null,
    raw: _opDefaultRaw(),
    site: _opCurrentSiteSnapshot(),
    _origin: {},
    _calc: null,
  };
  OP_FIELDS.forEach((def) => {
    if (def.type === "derived") return;
    const v = p[def.field];
    const val = v != null ? String(v) : "";
    _opSetValue(row, def, val);
    // 값이 실제로 들어왔을 때만 출처를 기록합니다. 빈칸에는 출처가 없습니다.
    if (val !== "" && origins[def.field]) row._origin[def.field] = origins[def.field];
  });
  _opRows.push(row);
  opRecalcRow(row);
  if (!_reviewSiteKey) {
    _reviewSiteKey = _devReviewSiteKey();
    _reviewSiteLabel = _devReviewSiteLabel();
  }
  renderOpTable();
  return row;
}

/**
 * 검토 내용을 비웁니다. **사용자가 명시적으로 요청했을 때만** 호출합니다
 * (배너의 "이 대상지로 새로 시작"). 워크스페이스를 닫는 것만으로는 부르지 않습니다 —
 * Chapter 1↔2를 오가는 것은 "검토를 버리겠다"는 뜻이 아니기 때문입니다.
 */
function resetDevelopmentOptions() {
  _opRows = [];
  _opCounter = 0;
  _opPreferredId = null;
  _reviewNote = "";
  closeOpDetail();
  const noteEl = document.getElementById("dw-review-note");
  if (noteEl) noteEl.value = "";
  renderOpTable();
}

const _btnOpAdd = document.getElementById("btn-op-add");
if (_btnOpAdd) {
  _btnOpAdd.addEventListener("click", () => {
    const row = addDevelopmentOption();
    openOpDetail(row.id);
  });
}

const _btnOpDetailClose = document.getElementById("btn-op-detail-close");
if (_btnOpDetailClose) _btnOpDetailClose.addEventListener("click", closeOpDetail);

const _opDiffOnly = document.getElementById("dw-op-diff-only");
if (_opDiffOnly) {
  _opDiffOnly.addEventListener("change", renderOpTable);
}

const _opShowDetail = document.getElementById("dw-op-show-detail");
if (_opShowDetail) {
  _opShowDetail.addEventListener("change", renderOpTable);
}

// 표는 매번 새로 그려지므로 셀마다 핸들러를 붙이지 않고 컨테이너 하나에 위임합니다.
const _opHost = document.getElementById("op-list");
if (_opHost) {
  _opHost.addEventListener("input", (ev) => {
    const f = ev.target.closest(".op-field");
    if (!f) return;
    const row = _opRows.find((r) => r.id === Number(f.dataset.opId));
    if (!row) return;
    const def = OP_FIELDS.find((d) => d.field === f.dataset.field);
    if (!def) return;

    _opSetValue(row, def, f.value);
    // 사용자가 손대는 순간 그 칸의 출처는 "표에서 온 초안"이 아니라 "사용자 가정"이
    // 됩니다. 어느 쪽이든 법적으로 검증된 값은 아니지만 성격이 다릅니다.
    if (!row._origin) row._origin = {};
    if (f.value === "") delete row._origin[def.field];
    else row._origin[def.field] = { kind: "user" };

    // 계산기 입력에 해당하는 칸이면 그 OP만 다시 계산합니다(다른 OP는 그대로).
    if (def.raw) {
      opRecalcRow(row);
      // 지금 상세 패널에 열려 있는 OP라면 패널 입력칸도 같은 값으로 맞춥니다.
      if (_opActiveId === row.id && typeof fsWritePanelRaw === "function" && !_opIsStale(row)) {
        _opPanelLoading = true;
        fsWritePanelRaw(row.raw);
        _opPanelLoading = false;
        if (typeof recomputeFeasibilityFar === "function") recomputeFeasibilityFar();
      }
    }
    // 입력 중에는 표를 통째로 다시 그리지 않습니다(포커스가 날아감).
    _refreshOpDerivedCells();
  });
  _opHost.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-op-remove], [data-op-prefer], [data-op-detail]");
    if (!btn) return;
    if (btn.dataset.opRemove) {
      const id = Number(btn.dataset.opRemove);
      _opRows = _opRows.filter((r) => r.id !== id);
      if (_opPreferredId === id) _opPreferredId = null;
      if (_opActiveId === id) closeOpDetail();
      renderOpTable();
    } else if (btn.dataset.opPrefer) {
      _opPreferredId = Number(btn.dataset.opPrefer);
      renderOpTable();
    } else if (btn.dataset.opDetail) {
      openOpDetail(btn.dataset.opDetail);
    }
  });
}

/** 파생 행만 다시 계산해 넣습니다 — 입력 중 포커스를 잃지 않기 위해 표 전체를 다시 그리지 않습니다. */
function _refreshOpDerivedCells() {
  const host = document.getElementById("op-list");
  const table = host && host.querySelector(".op-table");
  if (!table) return;
  const diffOnlyEl = document.getElementById("dw-op-diff-only");
  const diffOnly = !!(diffOnlyEl && diffOnlyEl.checked);
  const base = _opVisibleFields();
  const visible = diffOnly
    ? base.filter((d) => new Set(_opRows.map((r) => _opCellValue(r, d))).size > 1)
    : base;
  const rows = table.querySelectorAll("tbody tr");
  visible.forEach((def, rowIdx) => {
    if (def.type !== "derived") return;
    const tr = rows[rowIdx];
    if (!tr) return;
    _opRows.forEach((row, i) => {
      const td = tr.children[i + 1];
      if (!td) return;
      const d = _opDerivedCell(row, def);
      td.className = d.muted ? "unknown" : "";
      td.innerHTML = _escapeHtml(d.text) + (d.note ? `<br /><span class="dd-muted-inline">${_escapeHtml(d.note)}</span>` : "");
    });
  });
  _renderOpPreferred();
}

// 검토 의견은 화면이 아니라 상태에 보관합니다 — Chapter 1↔2를 오가도 남습니다.
const _reviewNoteEl = document.getElementById("dw-review-note");
if (_reviewNoteEl) {
  _reviewNoteEl.addEventListener("input", (ev) => {
    _reviewNote = ev.target.value;
  });
}
