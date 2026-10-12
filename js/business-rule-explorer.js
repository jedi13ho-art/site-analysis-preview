/** 새 business_rule_catalog.json 기반의 두 사업유형 탐색 카드. */
const BRX_CATEGORY_LABELS = { LOC: "위치", AREA: "면적", ZONE: "용도지역", ROAD: "접도", COND: "노후도", ETC: "기타" };

function _brxEscape(value) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : String(value);
  return div.innerHTML;
}
function _brxContext(context) {
  return {
    total_area_sqm: context.totalArea,
    perimeter_m: mergedParcelResult ? mergedParcelResult.perimeter_m : null,
    zone_name: context.zoneName,
    station_area: typeof _stationAreaResult !== "undefined" ? _stationAreaResult : null,
    road_requirement: typeof _roadRequirementResult !== "undefined" ? _roadRequirementResult : null,
    aging_requirement_routes: typeof _agingRequirementRoutes !== "undefined" ? _agingRequirementRoutes : null,
  };
}
function _brxMethodLabel(entry) {
  const applies = entry.applies_when;
  return applies && applies.field === "business_method" ? ` · ${applies.value}` : "";
}
function _brxRenderEntry(entry) {
  const labels = { MATCH: "부합", MISMATCH: "부적합", UNKNOWN: "정보 없음", NOT_APPLICABLE: "해당 없음" };
  return `<li class="brx-requirement brx-${entry.status.toLowerCase()}">
    <div class="brx-req-head"><strong>${_brxEscape(BRX_CATEGORY_LABELS[entry.category] || entry.category)}${_brxEscape(_brxMethodLabel(entry))}</strong><span>${_brxEscape(labels[entry.status] || entry.status)}</span></div>
    <dl><div><dt>대상지</dt><dd>${_brxEscape(entry.site_value)}</dd></div><div><dt>기준</dt><dd>${_brxEscape(entry.summary)}</dd></div></dl>
  </li>`;
}
function _brxFarRows(item) {
  const relaxations = item.relaxations || {};
  const rows = [...(relaxations.UPZONE || []), ...(relaxations.FAR || [])];
  return rows.filter((row) => row && (
    (row.current_zone && row.target_zone) ||
    (Number.isFinite(row.base_far) && Number.isFinite(row.upper_far)) ||
    Number.isFinite(row.upper_far)
  ));
}
function _brxRenderFar(item) {
  const rows = _brxFarRows(item);
  if (!rows.length) return "";
  return `<div class="brx-far-info">${rows.map((row) => {
    const zone = row.current_zone && row.target_zone
      ? `<div><strong>용도지역 상향</strong><span>${_brxEscape(row.current_zone)} → ${_brxEscape(row.target_zone)}</span></div>` : "";
    let far = "";
    if (Number.isFinite(row.base_far) && Number.isFinite(row.upper_far)) {
      const increase = Number.isFinite(row.far_increase_pp) ? row.far_increase_pp : row.upper_far - row.base_far;
      far = `<div><strong>용적률</strong><span>${row.base_far}% → ${row.upper_far}% (+${increase}%p)</span></div>`;
    } else if (Number.isFinite(row.upper_far)) {
      far = `<div><strong>최대 적용 용적률</strong><span>${row.upper_far}%</span></div>`;
    }
    return zone + far;
  }).join("")}</div>`;
}
function _brxRenderCard(item) {
  const unsuitable = item.overall_result === "부적합";
  return `<details class="brx-card${unsuitable ? " is-collapsed-result" : ""}"${unsuitable ? "" : " open"}>
    <summary><div><h3>${_brxEscape(item.name)}</h3>${_brxRenderFar(item)}</div><span class="brx-overall ${unsuitable ? "is-mismatch" : "is-match"}">${_brxEscape(item.overall_result)}</span></summary>
    <div class="brx-card-body"><p class="brx-expand-note">대상지 값과 기준을 비교한 결과입니다.</p><ul class="brx-requirements">${item.entries.map(_brxRenderEntry).join("")}</ul></div>
  </details>`;
}
async function renderBusinessRuleExplorer(context) {
  const host = document.getElementById("business-rule-explorer");
  if (!host) return;
  host.innerHTML = '<p class="panel-hint">대상지와 두 사업유형의 주요 요건을 비교하고 있습니다.</p>';
  try {
    const response = await fetch("/api/business-rule-evaluations", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({context:_brxContext(context)})});
    const body = await response.json();
    if (!response.ok || body.status !== "success") throw new Error(body.reason || `HTTP ${response.status}`);
    host.innerHTML = body.evaluations.map(_brxRenderCard).join("");
  } catch (error) {
    console.warn("새 사업유형 탐색 화면을 불러오지 못했습니다:", error);
    host.innerHTML = '<p class="panel-hint">사업유형 비교 결과를 불러오지 못했습니다.</p>';
  }
}
