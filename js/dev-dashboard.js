/**
 * UX 개편(2026-09-15): "개발가능성 요약 Dashboard".
 *
 * 목적: 대상지를 선택한 사용자가 "개발가능성 분석" 버튼 한 번만 누르면(기존
 * "개발검토 →" 버튼, id="btn-show-feasibility") 이 땅에서 어떤 개발사업을 검토할 수
 * 있고, 어느 정도 개발할 수 있을 가능성이 있으며, 무엇을 추가 확인해야 하는지를
 * "결론 → 핵심정보 → 상세근거" 순서로 5~10초 안에 파악할 수 있게 합니다.
 *
 * ⚠️ 새 법규 계산을 하지 않습니다 — business_types.json의 site_requirements/far_table/
 * public_contribution_table 등을 js/business-type-review.js가 이미 계산해 둔
 * _analyzeBusinessType()/_computeSiteRequirementResults() 결과를 그대로 요약해서
 * 보여줄 뿐입니다. 자동으로 확인할 수 없는 값은 이 파일에서도 절대 추측하지 않고
 * 그 함수들이 이미 정한 "확인 필요"를 그대로 따릅니다.
 *
 * 기존 4개 탭(대상지 현황/개발규모/사업유형/사업성 분석)과 그 안의 계산 로직은 전혀
 * 건드리지 않았습니다 — 이 파일은 그 탭들을 "상세 검토"로 이름 붙여 뒤로 옮기고,
 * 기본 화면 자리에 이 요약만 새로 채워 넣는 오케스트레이션 레이어입니다.
 *
 * dev-workspace.js/business-type-review.js 뒤에 로드되는 일반 스크립트라 같은 전역
 * 스코프를 공유합니다 — selectedParcels/mergedParcelResult/devWorkspaceEl/
 * selectDevWorkspaceTab/fetchBusinessTypes/_analyzeBusinessType/
 * getZoningContextForSelection/addDevelopmentOption/openBusinessTypeDetailCard/
 * _btStatusBadge/_escapeHtml 등 기존 함수·상태를 그대로 재사용합니다.
 */

const devDashboardEl = {
  root: document.getElementById("dev-dashboard"), // 02 사업유형 검토 섹션의 본문
  followups: document.getElementById("dw-followups"), // 04 종합의견 — 선택한 OP 기준
  followupsSite: document.getElementById("dw-followups-site"), // 04 종합의견 — 대상지 공통
  followupsOpTitle: document.getElementById("dw-followups-op-title"),
};

/* ------------------------------------------------------------------ */
/* 판정 상태 → 사용자 문구 매핑 (내부 4단계 상태 체계는 그대로 유지)              */
/* ------------------------------------------------------------------ */

const DD_RECOMMEND_RANK = { "적용 가능": 0, "조건부 적용 가능": 1, "확인 필요": 2, "적용 불가": 3 };

function _ddFriendlyLabel(status) {
  switch (status) {
    case "적용 가능":
      return "검토 가능성 높음";
    case "조건부 적용 가능":
      return "조건부로 검토 가능";
    case "적용 불가":
      return "현재 확인된 조건상 어려움";
    default:
      return "검토 가능 (추가 확인 필요)";
  }
}

function _ddReasonText(analysis) {
  const { overallStatus, entries, autoResolvedCount, unresolvedCount } = analysis;
  if (overallStatus === "적용 불가") {
    const blockers = entries.filter((e) => e.status === "적용 불가").map((e) => e.label);
    return blockers.length ? `${blockers.join(", ")} 미충족` : "현재 확인된 조건상 적용이 어렵습니다.";
  }
  if (overallStatus === "조건부 적용 가능") {
    const conds = entries.filter((e) => e.status === "조건부 적용 가능").map((e) => e.label);
    return conds.length ? `${conds.join(", ")} 조건부 충족` : "일부 조건을 충족하면 적용 가능합니다.";
  }
  if (overallStatus === "적용 가능") {
    return "현재 확인된 항목을 모두 충족합니다.";
  }
  // "확인 필요"일 때 건수만 보여주면 무엇을 해야 할지 알 수 없습니다.
  // 판정 로직은 그대로 두고, 이미 계산된 항목 이름을 앞쪽에 보여줍니다.
  const open = entries.filter((e) => e.status === "확인 필요").map((e) => e.label);
  if (open.length) {
    const head = open.slice(0, 3).join(", ");
    return open.length > 3 ? `${head} 등 ${open.length}건을 확인해야 합니다` : `${head} 확인 필요`;
  }
  return `자동 확인 완료 ${autoResolvedCount}건 · 확인 필요 ${unresolvedCount}건`;
}

/* ------------------------------------------------------------------ */
/* far_table 조회 — OP 생성 시 갈래를 찾는 데만 씁니다                        */
/* ------------------------------------------------------------------ */

/**
 * far_table에서 현재 용도지역(from_zone)과 일치하는 행을 "전부" 찾습니다 — 하나의
 * 변경전 용도지역이라도 도입용도(복합용도 충족 여부 등)에 따라 변경후 용도지역이
 * 여러 갈래로 나뉠 수 있어(예: 역세권 활성화사업의 일반상업지역행/준주거지역행),
 * 첫 번째 행만 쓰면 안 됩니다. 이 갈래 하나하나가 OP1/OP2/OP3의 실제 후보가 됩니다.
 */
function _ddFindFarRows(bt, zoneName) {
  const rows = bt && bt.far_table && bt.far_table.rows;
  if (!rows || !zoneName) return [];
  return rows.filter((r) => r.from_zone === zoneName);
}

/** far_table 행과 같은 from_zone/to_zone 조합의 공공기여율 행을 찾습니다(있으면). */
function _ddFindContributionRow(bt, fromZone, toZone) {
  const rows = bt && bt.public_contribution_table && bt.public_contribution_table.rows;
  if (!rows) return null;
  return rows.find((r) => r.from_zone === fromZone && r.to_zone === toZone) || null;
}

/* ------------------------------------------------------------------ */
/* 핵심 확인사항 — 상위 추천 사업제도의 "확인 필요" 항목만, 최대 4건               */
/* ------------------------------------------------------------------ */

function _renderDdIssuesSection(topAnalysis) {
  const openIssues = topAnalysis.issues.filter((e) => e.status === "확인 필요");
  if (openIssues.length === 0) {
    return `<p class="panel-hint">${_escapeHtml(topAnalysis.bt.name)} 기준으로 남은 확인 필요 항목이 없습니다. 세부 판정은 상세 검토표에서 근거와 함께 다시 확인하세요.</p>`;
  }

  const shown = openIssues.slice(0, 6);
  const items = shown
    .map(
      (e, i) => `
      <button type="button" class="dw-followup" data-action="detail" data-bt-id="${_escapeHtml(topAnalysis.bt.id)}">
        <span>${String(i + 1).padStart(2, "0")}</span>
        <div>
          <strong>${_escapeHtml(e.label)}</strong>
          <p>${_escapeHtml(e.detail || e.notes || "근거 자료가 아직 확보되지 않았습니다.")}</p>
        </div>
        <b>↗</b>
      </button>`
    )
    .join("");
  const more =
    openIssues.length > shown.length
      ? `<p class="dd-issue-more"><button class="dd-link-btn" data-action="detail" data-bt-id="${_escapeHtml(topAnalysis.bt.id)}">+ ${openIssues.length - shown.length}건 더 — 상세 검토표에서 확인</button></p>`
      : "";

  return `
    <p class="panel-hint">${_escapeHtml(topAnalysis.bt.name)} 기준 ${openIssues.length}건이 남아 있습니다.</p>
    ${items}${more}`;
}

/* ------------------------------------------------------------------ */
/* 대상지 공통 확인사항 — 어느 사업유형을 고르든 똑같이 걸리는 것                 */
/* ------------------------------------------------------------------ */

/**
 * 사업유형과 무관하게 대상지 자체에서 비어 있는 값만 모읍니다.
 * OP별 확인사항(사업제도 요건)과 섞지 않습니다 — 해결 주체가 다릅니다.
 */
/**
 * 지구단위계획은 이미 실제로 조회됩니다(district_plan_service, 01 대상지 상단에
 * 표시) — 여기서는 그 결과를 그대로 다시 보여줄 뿐, "기능이 없다"는 낡은 안내를
 * 쓰지 않습니다(2026-09-17 수정: 실제 연결 전 남아있던 placeholder 제거).
 */
function _renderDdDistrictPlanNote() {
  const r = typeof _planLookupResult !== "undefined" ? _planLookupResult : null;
  let text;
  if (!r || r.status === "unavailable") {
    text = "포함 여부 확인 필요 — 조회에 실패했거나 아직 대상지를 선택하지 않았습니다.";
  } else if (r.status === "included") {
    const first = (r.plans || [])[0];
    text = `포함 (${first ? first.name : "이름 미확인"}) — 결정도서에서 용도·용적률·높이·공공기여 조건을 확인하세요.`;
  } else {
    text = "비포함 — 현재 조회자료 기준입니다.";
  }
  return `
    <div class="dw-followup dw-followup-static">
      <div><strong>지구단위계획</strong><p>${_escapeHtml(text)}</p></div>
    </div>`;
}

function _renderDdSiteIssues(context) {
  // 이 대상지에서 값을 못 얻은 것(대상지마다 다름)만 unknown에 모읍니다.
  const unknown = [];
  if (!context || context.totalArea == null) {
    unknown.push(["대지면적", "선택 필지의 면적이 조회되지 않았습니다."]);
  }
  if (!context || !context.zoneName) {
    unknown.push([
      "용도지역",
      "조회하지 못했거나 선택 필지가 여러 용도지역에 걸쳐 있습니다 — 자동 판정을 보류했습니다.",
    ]);
  }
  const jiga = typeof fsJigaCompleteness === "function" ? fsJigaCompleteness() : null;
  if (jiga && jiga.jigaMissingCount > 0) {
    unknown.push([
      `개별공시지가 (${jiga.jigaMissingCount}필지 누락)`,
      "부지가액을 실거래사례·감정평가 대신 개별공시지가로 참고하려는 경우 일부 필지를 뺀 평균이 됩니다.",
    ]);
  }

  const block = (title, note, items, cls) => {
    if (!items.length) return "";
    return `
      <p class="dw-followup-subtitle ${cls}">${_escapeHtml(title)} <span>${_escapeHtml(note)}</span></p>
      ${items
        .map(
          ([t, d]) => `
        <div class="dw-followup dw-followup-static">
          <div><strong>${_escapeHtml(t)}</strong><p>${_escapeHtml(d)}</p></div>
        </div>`
        )
        .join("")}`;
  };

  return (
    `<p class="dw-followup-subtitle">지구단위계획 <span>실제 조회 결과</span></p>${_renderDdDistrictPlanNote()}` +
    (unknown.length
      ? block("이 대상지에서 확인되지 않은 값", "대상지마다 다름", unknown, "is-unknown")
      : `<p class="dw-followup-subtitle is-unknown">이 대상지에서 확인되지 않은 값 <span>대상지마다 다름</span></p>
         <p class="panel-hint">대지면적·용도지역·개별공시지가는 모두 조회됐습니다.</p>`)
  );
}

/**
 * 04 종합의견의 확인사항을 그립니다.
 * 대상지 공통은 항상, OP별은 **우선 검토로 선택한 OP의 사업유형** 기준으로만 보여줍니다.
 * 선택 전에는 특정 사업을 추천으로 확정하지 않습니다.
 */
function renderConclusionFollowups() {
  if (devDashboardEl.followupsSite) {
    devDashboardEl.followupsSite.innerHTML = _renderDdSiteIssues(_ddLastContext);
  }
  if (!devDashboardEl.followups) return;

  const rows = typeof _opRows !== "undefined" ? _opRows : [];
  const preferredId = typeof _opPreferredId !== "undefined" ? _opPreferredId : null;
  const row = rows.find((r) => r.id === preferredId) || null;
  const idx = row ? rows.indexOf(row) + 1 : null;

  if (devDashboardEl.followupsOpTitle) {
    devDashboardEl.followupsOpTitle.textContent = row ? `OP${idx} 기준` : "선택한 OP 기준";
  }

  if (!row) {
    devDashboardEl.followups.innerHTML =
      '<p class="panel-hint">03 OP 비교에서 우선 검토할 OP를 선택하면 그 사업유형의 확인사항이 여기에 표시됩니다.</p>';
    return;
  }

  const analysis = (_ddLastAnalyses || []).find((a) => a.bt.id === row.business_type_id);
  if (!analysis) {
    devDashboardEl.followups.innerHTML = `<p class="panel-hint">OP${idx}에 연결된 사업유형이 없어 요건 확인사항을 표시할 수 없습니다 — 사업제도를 직접 입력한 OP입니다.</p>`;
    return;
  }

  const calcReasons = row._calc && row._calc.reasons.length
    ? `<div class="dw-followup dw-followup-static"><span>계산</span><div><strong>미산정 ${row._calc.reasons.length}건</strong><p>${_escapeHtml(row._calc.reasons.join(" / "))}</p></div></div>`
    : "";
  devDashboardEl.followups.innerHTML = _renderDdIssuesSection(analysis) + calcReasons;
}

/* ------------------------------------------------------------------ */
/* 추천 검토방식 — 사업제도 우선순위 목록                                      */
/* ------------------------------------------------------------------ */

/**
 * 사업제도 하나의 "개발 여지"를 Rule Set에서만 뽑습니다.
 * 새 수치를 만들지 않습니다 — far_table에 실제로 적혀 있는 상한 용적률 중
 * 현재 용도지역에서 갈 수 있는 것의 최댓값과, 같은 조합의 최소 공공기여율입니다.
 * 값이 없으면 null로 두고 "제도상 용적률 미등록"으로 표시합니다.
 */
function _ddUpside(bt, context) {
  const rows = _ddFindFarRows(bt, context.zoneName);
  if (!rows.length) return { maxCap: null, baseFar: null, minContribution: null, rowCount: 0 };
  let maxCap = null;
  let baseFar = null;
  let bestRow = null;
  rows.forEach((r) => {
    if (r.cap_far_percent != null && (maxCap == null || r.cap_far_percent > maxCap)) {
      maxCap = r.cap_far_percent;
      bestRow = r;
    }
    if (r.base_far_percent != null && (baseFar == null || r.base_far_percent > baseFar)) {
      baseFar = r.base_far_percent;
    }
  });
  let minContribution = null;
  if (bestRow) {
    const c = _ddFindContributionRow(bt, bestRow.from_zone, bestRow.to_zone);
    if (c && c.contribution_rate_percent != null) minContribution = c.contribution_rate_percent;
  }
  return { maxCap, baseFar, minContribution, rowCount: rows.length, bestRow };
}

// 순차 확인 중인 사업제도. 한 번에 하나만 펼쳐 요건을 확인합니다.
let _ddOpenChecklistId = null;
// 사용자가 손으로 기록한 요건 확인 결과 — { "btId::항목명": "충족"|"미충족"|"보류" }
const _ddManualChecks = {};

function _ddCheckKey(btId, item) {
  return `${btId}::${item}`;
}

/* ------------------------------------------------------------------ */
/* 요건 위계(primary_gate/exception/detail) 기반 첫 화면 (2026-09-17)         */
/*                                                                      */
/* business_types.json에 requirement_level 등을 실제로 채운 사업유형(현재는  */
/* 역세권 활성화사업만)만 이 요약 화면을 씁니다. 채우지 않은 사업유형은        */
/* _dgIsClassified()가 false를 돌려줘 기존 카드(_renderDdChecklist 포함)를    */
/* 그대로 씁니다 — 근거 없이 다른 사업유형을 일괄 분류하지 않습니다.          */
/* ------------------------------------------------------------------ */

const DD_GROUP_ORDER = ["위치", "면적", "용도지역", "접도"];

/** entries 중 하나라도 primary_gate로 분류돼 있으면 이 사업유형은 "분류됨"입니다. */
function _dgIsClassified(a) {
  return a.entries.some((e) => e.requirementLevel === "primary_gate");
}

function _dgIcon(status) {
  if (status === "적용 가능") return "✓";
  if (status === "적용 불가") return "✗";
  return "△"; // 확인 필요 · 조건부 적용 가능(현황 실측이라 법적으로 확정 아님)
}

/**
 * primary_gate 항목을 display_group별로 묶습니다. 같은 그룹에 항목이 여럿이면
 * (지금은 사업유형 하나당 그룹마다 항목 1개뿐이라 실제로는 항상 1개지만, 나중에
 * 늘어날 경우를 대비해) 가장 나쁜 상태를 그룹 대표 상태로 삼고 detail을 이어붙입니다.
 */
function _dgGroupPrimaryGate(entries) {
  const primary = entries.filter((e) => e.requirementLevel === "primary_gate");
  const groups = new Map();
  primary.forEach((e) => {
    const g = e.displayGroup || e.label;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e);
  });
  const orderedKeys = [
    ...DD_GROUP_ORDER.filter((g) => groups.has(g)),
    ...Array.from(groups.keys()).filter((g) => !DD_GROUP_ORDER.includes(g)),
  ];
  return orderedKeys.map((g) => {
    const items = groups.get(g);
    const worst = items.reduce((w, e) => ((BT_STATUS_RANK[e.status] || 0) > (BT_STATUS_RANK[w.status] || 0) ? e : w), items[0]);
    return {
      group: g,
      status: worst.status,
      // 대표요건 첫 화면은 shortSummary(1줄, 대상지 값+짧은 결과)만 씁니다.
      // criteria 원문·notes(법령 정정 이력·데이터셋 설명 등)는 여기서 절대 쓰지
      // 않습니다 — "상세 검토 보기"에만 남깁니다(요청사항: 정보 삭제가 아니라
      // 정보계층 분리).
      detailLine: items.map((e) => e.shortSummary || e.detail).filter(Boolean).join(" · "),
    };
  });
}

function _renderDdPrimaryGateSummary(a) {
  const groups = _dgGroupPrimaryGate(a.entries);
  if (!groups.length) return "";
  const rows = groups
    .map(
      (g) => `
      <li class="dg-primary-item">
        <span class="dg-primary-icon" aria-hidden="true">${g.status ? _dgIcon(g.status) : "△"}</span>
        <span class="dg-primary-body">
          <b class="dg-primary-group">${_escapeHtml(g.group)}</b>
          <span class="dg-primary-detail">${_escapeHtml(g.detailLine || "확인 필요")}</span>
        </span>
      </li>`
    )
    .join("");
  return `
    <div class="dg-primary-gate">
      <p class="dg-section-title">주요 입지요건</p>
      <ul class="dg-primary-list">${rows}</ul>
    </div>`;
}

/**
 * exception 항목 중 화면에 남길 것만 고릅니다 — 자동으로 "해당 없음/적용 가능"이
 * 확인됐고(user_action_required=false) 사용자가 더 볼 필요가 없는 항목은 뺍니다.
 * 다만 법적으로 실제 제외대상(적용 불가)으로 확인된 항목은 절대 숨기지 않습니다.
 */
function _dgVisibleExceptions(entries) {
  return entries.filter((e) => e.requirementLevel === "exception").filter((e) => {
    if (e.status === "적용 불가") return true; // 명확한 제외대상 — 숨기지 않음
    if (e.userActionRequired === false && (e.status === "적용 가능" || e.status === "해당 없음")) return false;
    return true;
  });
}

function _dgExceptionStatusText(e) {
  if (e.status === "적용 불가") return "확인됨 — 제외대상에 해당(전체 판정에 반영됨)";
  if (e.status === "적용 가능") return "확인됨 — 해당 없음";
  if (e.status === "조건부 적용 가능") return "조건부로 확인됨";
  // GIS 1차 스크리닝에서 중첩 가능성이 확인된 경우 — 법적 제외 확정이 아니라
  // "사람이 유형·현행 여부를 확인해야 함"이라는 뜻입니다.
  if (e.screeningWarning) return e.screeningWarning;
  return "예외사항 확인 필요";
}

/** "예외사항 주의 N건 [펼쳐보기]" — 데이터가 없어 확인 못한 것을 "분석 실패"라고 안 씁니다. */
function _renderDdExceptionSection(a) {
  const list = _dgVisibleExceptions(a.entries);
  if (!list.length) {
    return `<p class="dg-exception-empty">예외사항 자동 확인 완료 — 확인된 제외대상 없음</p>`;
  }
  const rows = list
    .map((e) => {
      const key = _ddCheckKey(a.bt.id, e.label);
      const mine = _ddManualChecks[key] || "";
      return `
        <li class="dd-check-item ${mine ? "is-answered" : ""}">
          <div class="dd-check-main">
            <p class="dd-check-label">${_escapeHtml(e.label)}</p>
            <p class="dd-check-detail">${_escapeHtml(e.detail || e.notes || "")}</p>
            <p class="dd-check-auto">${_escapeHtml(_dgExceptionStatusText(e))}</p>
            ${e.source && e.source.document_title ? `<p class="dd-check-source">${_renderSourceTag(e.source)}</p>` : ""}
          </div>
          <div class="dd-check-actions" data-check-key="${_escapeHtml(key)}">
            <button type="button" class="dw-ghost-btn ${mine === "충족" ? "chosen" : ""}" data-check="충족">충족</button>
            <button type="button" class="dw-ghost-btn ${mine === "미충족" ? "chosen" : ""}" data-check="미충족">미충족</button>
            <button type="button" class="dw-ghost-btn ${mine === "보류" ? "chosen" : ""}" data-check="보류">보류</button>
          </div>
        </li>`;
    })
    .join("");
  return `
    <details class="dw-op-fold dg-exception-fold">
      <summary>예외사항 주의 ${list.length}건</summary>
      <ol class="dd-check-list">${rows}</ol>
      <p class="panel-hint">여기 기록은 검토 메모입니다 — 자동 판정을 바꾸지 않습니다.</p>
    </details>`;
}

/**
 * 노후도는 법정 충족 여부를 첫 화면에 표시하지 않고 현황값만 보여줍니다
 * (POST /api/building-age 결과 재사용 — 새 측정 서비스를 만들지 않습니다).
 * js/dev-workspace.js의 전역 _buildingAgeLookupResult를 그대로 읽습니다.
 */
function _dgBuildingAgeSummaryText() {
  if (typeof _buildingAgeLookupResult === "undefined" || !_buildingAgeLookupResult) {
    return "건축물 현황 확인 필요";
  }
  const r = _buildingAgeLookupResult;
  if (r.status === "ok") {
    const coverage = Math.round((r.coverage_rate || 0) * 100);
    return `대상 건물 ${r.matched_building_count}동 · 사용승인일 확인 ${r.valid_approval_date_count}동 · 확보율 ${coverage}% · 법정 노후도 판정은 기준 확인 필요`;
  }
  if (r.status === "no_building") return "대상 필지에 등록된 건물 없음";
  return "건축물 현황 확인 필요";
}

/**
 * 추진 경로별(도시정비형 재개발사업/지구단위계획) 노후도 판정 — 상세검토에서만
 * 보여줍니다(요청사항: 추진 경로를 고르지 않았으면 두 경로를 각각 표시하고 하나의
 * 최종 판정으로 합치지 않음). js/dev-workspace.js의 전역 _agingRequirementRoutes
 * (aging_requirement_service.evaluate_all_routes 결과)를 그대로 읽습니다.
 */
function _renderDdAgingRoutes() {
  if (typeof _agingRequirementRoutes === "undefined" || !_agingRequirementRoutes || !_agingRequirementRoutes.length) {
    return "";
  }
  const rows = _agingRequirementRoutes
    .map((r) => {
      const ratioText =
        r.measured_ratio != null && r.threshold != null
          ? `노후 ${r.measured_numerator}/${r.measured_denominator}동(${Math.round(r.measured_ratio * 100)}%) · 기준 ${Math.round(r.threshold * 100)}% 이상`
          : "비율 계산 불가";
      return `
      <li class="dd-check-item dg-aging-route">
        <div class="dd-check-main">
          <p class="dd-check-label">${_escapeHtml(r.route_name || r.route_id)}</p>
          <p class="dd-check-detail">${_escapeHtml(ratioText)}</p>
          <p class="dd-check-auto">${_escapeHtml(r.reason || "")}</p>
          ${r.source && r.source.document_title ? `<p class="dd-check-source">${_renderSourceTag(r.source)}</p>` : ""}
        </div>
        <p class="dg-primary-note">${_escapeHtml(r.status)}</p>
      </li>`;
    })
    .join("");
  return `<ol class="dd-check-list dg-aging-route-list">${rows}</ol>`;
}

/** "개발조건 상세보기" — detail 항목은 첫 화면 "추가 확인" 숫자에 넣지 않고 여기로 접어둡니다. */
function _renderDdDetailFold(a) {
  const list = a.entries.filter((e) => e.requirementLevel === "detail");
  if (!list.length) return "";
  const rows = list
    .map((e) => {
      const isAging = e.label === "노후도";
      const detailText = isAging ? _dgBuildingAgeSummaryText() : e.detail || e.notes || "";
      return `
      <li class="dd-check-item">
        <div class="dd-check-main">
          <p class="dd-check-label">${_escapeHtml(e.label)}</p>
          <p class="dd-check-detail">${_escapeHtml(detailText)}</p>
          <p class="dd-check-auto">${_escapeHtml(e.status || "확인 필요")}</p>
        </div>
      </li>
      ${isAging ? _renderDdAgingRoutes() : ""}`;
    })
    .join("");
  return `
    <details class="dw-op-fold dg-detail-fold">
      <summary>개발조건 상세보기 (${list.length}건)</summary>
      <ol class="dd-check-list">${rows}</ol>
    </details>`;
}

/**
 * 사업유형 전체 판정 — primary_gate/exception만 보고 우선순위대로 정합니다
 * (detail 미확인은 이 판정을 막지 않습니다). 개발조건까지 확인되지 않았으므로
 * 최종 "적용 가능"으로는 절대 단정하지 않습니다(내부 상태는 4종 그대로 유지).
 */
function _dgOverallForClassified(a) {
  const primary = a.entries.filter((e) => e.requirementLevel === "primary_gate");
  const exceptions = _dgVisibleExceptions(a.entries);

  if (primary.some((e) => e.status === "적용 불가")) {
    return { status: "적용 불가", headline: "현재 기준상 어려움" };
  }
  if (primary.some((e) => e.status === "확인 필요")) {
    return { status: "확인 필요", headline: "핵심요건 확인 필요" };
  }
  const exceptionsUnresolved = exceptions.some((e) => e.status === "확인 필요" || e.status === "조건부 적용 가능");
  const exceptionsBlocking = exceptions.some((e) => e.status === "적용 불가");
  if (exceptionsBlocking) {
    return { status: "적용 불가", headline: "현재 기준상 어려움" };
  }
  if (exceptionsUnresolved) {
    return { status: "조건부 적용 가능", headline: "검토 가능 · 예외사항 확인 필요" };
  }
  return { status: "조건부 적용 가능", headline: "주요 입지요건 충족" };
}

/**
 * "주요요건 자동 확인 N건 · 추가 확인 N건 · 예외사항 주의 N건 · 개발조건 상세검토"
 * detail 항목은 이 숫자 어디에도 합산하지 않습니다(요청사항 8장) — 그래서 detail은
 * 개수만 "상세검토"로 따로 안내하고, done/todo 계산에서 완전히 뺍니다.
 */
function _dgCounts(a) {
  const primary = a.entries.filter((e) => e.requirementLevel === "primary_gate");
  const primaryDone = primary.filter((e) => e.status !== "확인 필요").length;
  const primaryTodo = primary.length - primaryDone;
  const exceptionCount = _dgVisibleExceptions(a.entries).length;
  const detailCount = a.entries.filter((e) => e.requirementLevel === "detail").length;
  return { primaryDone, primaryTodo, exceptionCount, detailCount };
}

/** "다음 행동" 한 줄 — 지금 미확인 상태인 primary_gate/exception 항목 이름으로 만듭니다. */
function _dgNextAction(a) {
  const primaryTodo = a.entries.filter((e) => e.requirementLevel === "primary_gate" && e.status === "확인 필요");
  const exceptionTodo = _dgVisibleExceptions(a.entries).filter(
    (e) => e.status === "확인 필요" || e.status === "조건부 적용 가능"
  );
  const items = [...primaryTodo, ...exceptionTodo].map((e) => e.label);
  if (!items.length) return "개발조건(용적률·공공기여 등) 상세 검토에서 다음 단계를 확인하세요.";
  return `${items.slice(0, 3).join(", ")} 확인`;
}

/**
 * 요건 확인 체크리스트. 사업제도 하나의 요건을 항목별로 훑으며
 * 사용자가 충족/미충족/보류를 직접 기록합니다.
 * ⚠️ 여기 기록은 **사용자 메모**이며 자동 판정을 덮어쓰지 않습니다.
 */
function _renderDdChecklist(a) {
  const items = a.entries;
  const done = items.filter((e) => _ddManualChecks[_ddCheckKey(a.bt.id, e.label)]).length;

  const rows = items
    .map((e) => {
      const key = _ddCheckKey(a.bt.id, e.label);
      const mine = _ddManualChecks[key] || "";
      const autoText =
        e.kind === "auto" && e.resolved
          ? `자동 확인: ${e.status}`
          : e.status === "적용 불가"
            ? "자동 확인: 조건 미충족"
            : "자동 확인 불가 — 직접 확인";
      return `
        <li class="dd-check-item ${mine ? "is-answered" : ""}">
          <div class="dd-check-main">
            <p class="dd-check-label">${_escapeHtml(e.label)}</p>
            <p class="dd-check-detail">${_escapeHtml(e.detail || e.notes || "")}</p>
            <p class="dd-check-auto">${_escapeHtml(autoText)}</p>
          </div>
          <div class="dd-check-actions" data-check-key="${_escapeHtml(key)}">
            <button type="button" class="dw-ghost-btn ${mine === "충족" ? "chosen" : ""}" data-check="충족">충족</button>
            <button type="button" class="dw-ghost-btn ${mine === "미충족" ? "chosen" : ""}" data-check="미충족">미충족</button>
            <button type="button" class="dw-ghost-btn ${mine === "보류" ? "chosen" : ""}" data-check="보류">보류</button>
          </div>
        </li>`;
    })
    .join("");

  return `
    <div class="dd-checklist">
      <p class="dd-check-progress">요건 ${items.length}개 중 <b>${done}개</b> 확인함</p>
      <ol class="dd-check-list">${rows}</ol>
      <p class="panel-hint">여기 기록은 검토 메모입니다 — 자동 판정을 바꾸지 않습니다.</p>
    </div>`;
}

/**
 * 목록 상단에서 "지금 조건으로는 어려운 사업"으로 뺄지 판단할 상태입니다.
 * 분류된 사업유형(requirement_level이 있는)은 primary_gate/exception 기준
 * (_dgOverallForClassified)으로, 아직 분류 안 된 사업유형은 기존 overallStatus
 * (모든 항목 중 최악값)로 판단합니다 — 미분류 사업유형의 기존 판정 결과를
 * 이번 작업에서 바꾸지 않기 위함입니다.
 */
function _dgBlockedStatus(a) {
  return _dgIsClassified(a) ? _dgOverallForClassified(a).status : a.overallStatus;
}

function _renderDdRankSection(analyses, context) {
  // 확인된 결격 사유가 있는 사업은 목록에서 빼고 따로 접어 둡니다.
  const blocked = analyses.filter((a) => _dgBlockedStatus(a) === "적용 불가");
  const open = analyses.filter((a) => _dgBlockedStatus(a) !== "적용 불가");

  // 개발 여지(제도상 상한 용적률)가 큰 순. 값이 없는 제도는 뒤로 보냅니다.
  const ranked = open
    .map((a) => ({ a, up: _ddUpside(a.bt, context) }))
    .sort((x, y) => {
      if (x.up.maxCap == null && y.up.maxCap == null) return 0;
      if (x.up.maxCap == null) return 1;
      if (y.up.maxCap == null) return -1;
      return y.up.maxCap - x.up.maxCap;
    });

  const TOP = 4;
  const shown = ranked.slice(0, TOP);
  const rest = ranked.slice(TOP);

  const card = ({ a, up }, i) => {
    const upsideHtml =
      up.maxCap != null
        ? `<p class="dd-upside"><b>최대 ${up.maxCap}%</b>
             <span>제도상 상한 용적률${up.baseFar != null ? ` · 기준 ${up.baseFar}%` : ""}${
               up.minContribution != null ? ` · 공공기여 ${up.minContribution}% 이상` : ""
             }</span></p>`
        : `<p class="dd-upside is-none"><b>용적률 미등록</b><span>이 용도지역에 대한 표가 아직 없습니다</span></p>`;

    const head = `
        <div class="dd-rank-head">
          <span class="dd-rank-num">${i + 1}</span>
          <span class="dd-rank-name">${_escapeHtml(a.bt.name)}</span>
          ${upsideHtml}
        </div>`;

    if (_dgIsClassified(a)) {
      // requirement_level이 채워진 사업유형 — 대표요건 중심 첫 화면(요청사항 1~6장).
      const overall = _dgOverallForClassified(a);
      const counts = _dgCounts(a);
      return `
        <li class="dd-rank-item">
          ${head}
          <p class="dg-headline">${_escapeHtml(overall.headline)}</p>
          <p class="dg-counts">자동 확인 ${counts.primaryDone}건 · 추가 확인 ${counts.primaryTodo}건${counts.exceptionCount ? ` · 주의 ${counts.exceptionCount}건` : ""}</p>
          ${_renderDdPrimaryGateSummary(a)}
          ${_renderDdExceptionSection(a)}
          <p class="dg-next-action"><b>다음 행동</b> ${_escapeHtml(_dgNextAction(a))}</p>
          <div class="dd-rank-actions">
            <button class="dw-ghost-btn" data-action="detail" data-bt-id="${_escapeHtml(a.bt.id)}">상세 검토 보기</button>
            <button class="dw-ghost-btn dd-primary-action" data-action="op" data-bt-id="${_escapeHtml(a.bt.id)}">개발대안 만들기</button>
          </div>
          ${_renderDdDetailFold(a)}
        </li>`;
    }

    // 아직 requirement_level로 분류되지 않은 사업유형 — 기존 화면을 그대로 유지합니다.
    const isOpen = _ddOpenChecklistId === a.bt.id;
    const todo = a.entries.filter((e) => e.status === "확인 필요").length;
    const doneCount = a.entries.filter((e) => _ddManualChecks[_ddCheckKey(a.bt.id, e.label)]).length;

    return `
      <li class="dd-rank-item ${isOpen ? "is-open" : ""}">
        ${head}
        <p class="dd-rank-unclassified-note">대표요건 분류 준비 중 — 아래에서 전체 요건을 확인하세요.</p>
        <p class="dd-rank-reason">확인할 요건 ${a.entries.length}개${
          doneCount ? ` · ${doneCount}개 확인함` : ""
        }${todo ? ` · 자동 확인 불가 ${todo}개` : ""}</p>
        <div class="dd-rank-actions">
          <button class="dw-ghost-btn ${isOpen ? "chosen" : ""}" data-action="checklist" data-bt-id="${_escapeHtml(a.bt.id)}">${
            isOpen ? "요건 확인 닫기" : "요건 확인하기"
          }</button>
          <button class="dw-ghost-btn" data-action="detail" data-bt-id="${_escapeHtml(a.bt.id)}">근거 원문 보기</button>
          <button class="dw-ghost-btn dd-primary-action" data-action="op" data-bt-id="${_escapeHtml(a.bt.id)}">개발대안 만들기</button>
        </div>
        ${isOpen ? _renderDdChecklist(a) : ""}
      </li>`;
  };

  const restHtml = rest.length
    ? `<details class="dw-op-fold"><summary>나머지 ${rest.length}개 사업방식</summary>
         <ol class="dd-rank-list dd-rank-rest">${rest.map((r, i) => card(r, TOP + i)).join("")}</ol>
       </details>`
    : "";

  const blockedHtml = blocked.length
    ? `<details class="dw-op-fold"><summary>지금 조건으로는 어려운 사업 ${blocked.length}개</summary>
         <ul class="dd-blocked-list">${blocked
           .map((a) => {
             const why = a.entries.filter((e) => e.status === "적용 불가").map((e) => e.label);
             return `<li><b>${_escapeHtml(a.bt.name)}</b> — ${_escapeHtml(why.join(", ") || "조건 미충족")}
               <button class="dd-link-btn" data-action="detail" data-bt-id="${_escapeHtml(a.bt.id)}">예외 규정 확인</button></li>`;
           })
           .join("")}</ul>
         <p class="panel-hint">예외 규정이 있을 수 있어 완전히 배제하지는 않았습니다.</p>
       </details>`
    : "";

  return `
    <div class="dd-section">
      <ol class="dd-rank-list">${shown.map(card).join("")}</ol>
      ${restHtml}
      ${blockedHtml}
    </div>`;
}

/* ------------------------------------------------------------------ */
/* 진행 상태 표시 (가짜 delay 없음 — 실제 fetch가 끝나는 순서에 맞춰 갱신)         */
/* ------------------------------------------------------------------ */

function _renderDdProgress(text) {
  if (!devDashboardEl.root) return;
  devDashboardEl.root.innerHTML = `<p class="dd-progress">${_escapeHtml(text)}</p>`;
}

/* ------------------------------------------------------------------ */
/* 개발대안(OP) 초안 생성 — Rule Set에서 확인된 값만 채우고 나머지는 비워 둠       */
/* ------------------------------------------------------------------ */

/**
 * use_condition 문장(far_table 행에 이미 있는, Rule Set 원문에서 온 텍스트)에서 짧은
 * 도입용도 라벨만 뽑아냅니다 — 새로 지어내지 않고, 그 문장에 이미 등장하는 시설명을
 * 그대로 옮기는 것뿐입니다. 어느 쪽인지 알 수 없으면 빈칸으로 둡니다.
 */
function _ddGuessUseTypeLabel(useCondition) {
  if (!useCondition) return "";
  if (useCondition.includes("관광숙박시설")) return "관광숙박시설(관광진흥법상 관광숙박시설 등)";
  if (useCondition.includes("공동주택")) return "공동주택 등(주거 중심)";
  return "";
}

/**
 * 대상지가 기존 지구단위계획구역 등에 포함돼 있으면 그 사실을 한 줄로 요약합니다.
 * 포함 여부는 사업유형 자동 배제나 Rule Set 수치 덮어쓰기에 쓰지 않습니다 —
 * "결정조서를 먼저 확인하라"는 안내 문구로만 OP 초안 notes에 얹습니다.
 */
function _ddExistingPlanNote() {
  const review = typeof _backendExistingPlanReview !== "undefined" ? _backendExistingPlanReview : null;
  if (!review || !review.included) return "";
  const plans = (review.plans || []).map((p) => `${p.name}(${p.extent || ""} ${Math.round((p.overlap_ratio || 0) * 100)}%)`).join(", ");
  return `기존 결정조서 확인 우선 — ${plans || "기존 지구단위계획구역 포함"}. ${review.limitation || "현재 GIS에는 세부 지침이 없어 결정도서를 직접 확인해야 합니다."}`;
}

/**
 * 아직 확인되지 않은 대표요건·예외를 최대 3개까지 한 줄로 요약합니다(analysis.issues,
 * 백엔드 응답 기준). 새 법적 판단을 만들지 않고, 이미 계산된 status/label만 옮깁니다.
 */
function _ddUnresolvedRequirementsNote(analysis) {
  if (!analysis || !analysis.issues || !analysis.issues.length) return "";
  const labels = analysis.issues.slice(0, 3).map((e) => `${e.label}(${e.status})`).join(", ");
  return `미해결 대표요건 — ${labels}. 위 항목을 먼저 확인하세요.`;
}

/**
 * 사업제도 하나에서 far_table 행(=도입용도·조건에 따라 갈라지는 실제 개발조건 갈래)마다
 * OP를 하나씩 만듭니다. 갈래가 1개면 OP 1개, 2개면 OP1/OP2, 이렇게 실제 Rule Set에
 * 있는 갈래 수만큼만 만들고, 억지로 3개를 채우지 않습니다(요청사항: 임의로 3개를
 * 채우는 구조 금지). 각 OP의 용적률·공공기여는 far_table/public_contribution_table에
 * 실제로 있는 값만 채우고, 근거가 없는 높이·완화항목 등은 빈칸으로 남깁니다.
 *
 * analysis(선택)가 있으면 미해결 대표요건 요약과 기존계획 배너를 notes 맨 앞에
 * 붙입니다 — 사업유형이 "확인 필요" 상태여도 OP 초안 작성 자체는 막지 않습니다.
 */
function _ddCreateOpFromBusinessType(bt, context, analysis) {
  const rows = _ddFindFarRows(bt, context.zoneName);
  const leadNotes = [_ddExistingPlanNote(), _ddUnresolvedRequirementsNote(analysis)].filter(Boolean).join(" / ");

  if (rows.length === 0) {
    const prefill = { business_type: bt.name, business_type_id: bt.id, notes: leadNotes };
    if (typeof addDevelopmentOption === "function") addDevelopmentOption(prefill);
    if (typeof selectDevWorkspaceTab === "function") selectDevWorkspaceTab("capacity");
    return;
  }

  let firstCreated = null;
  rows.forEach((row) => {
    const contribRow = _ddFindContributionRow(bt, row.from_zone, row.to_zone);
    // 표에서 가져온 값은 "확인된 값"이 아니라 "아직 검증되지 않은 초안"입니다.
    // 어느 문서의 어떤 조건에서 온 값인지를 같이 넘겨 화면에서 구분해 표시합니다.
    const src = bt.far_table && bt.far_table.source ? bt.far_table.source : bt.source;
    const srcLabel = src && src.document_title ? [src.document_title, src.section].filter(Boolean).join(" · ") : `${bt.name} Rule Set 표`;
    const draft = (condition) => ({ kind: "table", source: srcLabel, condition });
    const zoneChange = `${row.from_zone} → ${row.to_zone} (용도지역 변경이 실제로 가능한지 미검증)`;
    const prefill = {
      business_type: bt.name,
      use_type: _ddGuessUseTypeLabel(row.use_condition),
      zone_after: row.to_zone,
      business_type_id: bt.id,
      far_base: row.base_far_percent,
      // 허용 용적률은 표에서 가져올 수 있는 값이 아닙니다 — 계획안별 인센티브
      // 산정표의 결과입니다(용산 특계9 사례: 기준 250% + 항목별 360.4%p = 610%).
      // 기준값을 그대로 복사해 넣으면 확인된 값처럼 보이므로 비워 둡니다.
      far_allowed: "",
      // far_table의 cap은 "제도가 정한 한도"입니다. 이 프로그램이 계산하는
      // "계산상 상한"(허용 + 공공기여 완화)과 다른 값이라 칸을 나눕니다.
      far_rule_cap: row.cap_far_percent,
      // 공공기여율은 이제 OP의 계산 결과(계획안 계산 공공기여율)로 나옵니다. 표의 최소
      // 기여율은 별도 칸(rule_min_contribution_pct)에 두어 계산값과 섞이지 않게 합니다.
      rule_min_contribution_pct: contribRow ? contribRow.contribution_rate_percent : "",
      notes: [leadNotes, row.use_condition, contribRow ? "제도상 최소 공공기여율은 상세보기의 별도 칸을 확인하세요(완화조건·서울도심 여부 미반영)." : ""]
        .filter(Boolean)
        .join(" / "),
      _origin: {
        zone_after: draft(zoneChange),
        far_base: draft(zoneChange),
        far_rule_cap: draft(zoneChange),
        rule_min_contribution_pct: contribRow
          ? { kind: "table", source: srcLabel, condition: `${row.from_zone} → ${row.to_zone}` }
          : undefined,
      },
    };
    if (typeof addDevelopmentOption === "function") {
      const created = addDevelopmentOption(prefill);
      if (!firstCreated) firstCreated = created;
    }
  });
  if (typeof selectDevWorkspaceTab === "function") selectDevWorkspaceTab("capacity");
  // 만든 OP 중 첫 번째의 조건·계산 근거를 바로 열어, 어디서 값을 넣는지 보이게 합니다.
  if (firstCreated && typeof openOpDetail === "function") openOpDetail(firstCreated.id);
}

/* ------------------------------------------------------------------ */
/* 메인 렌더 + 클릭 위임                                                   */
/* ------------------------------------------------------------------ */

let _ddLastAnalyses = null;
let _ddLastContext = null;

function _renderDashboard({ context, analyses }) {
  _ddLastAnalyses = analyses;
  _ddLastContext = context;

  if (!devDashboardEl.root) return;

  if (analyses.length === 0) {
    devDashboardEl.root.innerHTML = `<p class="panel-hint">사업제도 목록을 불러오지 못했습니다.</p>`;
    if (devDashboardEl.followups) devDashboardEl.followups.innerHTML = "";
    return;
  }

  // 정렬 기준(모두 실제 계산된 판정에서 나온 신호만 씀 — 추측 없음):
  // 1) 종합판정(적용가능 > 조건부 > 확인필요 > 적용불가)
  // 2) 이미 "적용 불가"로 확인된 항목이 적을수록 우선(실제 결격 사유가 적은 쪽)
  // 3) 이미 "적용 가능/조건부"로 확인된 항목이 많을수록 우선(실제로 맞아떨어진 것이 많은 쪽)
  // 4) 남은 확인 항목이 적을수록 우선(마지막 타이브레이커) — 항목이 더 세세하게
  //    모델링됐다는 이유만으로 밀리지 않도록, 이 기준은 맨 마지막에만 씀
  const sorted = [...analyses].sort((a, b) => {
    const ra = DD_RECOMMEND_RANK[a.overallStatus] ?? 2;
    const rb = DD_RECOMMEND_RANK[b.overallStatus] ?? 2;
    if (ra !== rb) return ra - rb;
    if (a.blockedCount !== b.blockedCount) return a.blockedCount - b.blockedCount;
    if (a.positiveCount !== b.positiveCount) return b.positiveCount - a.positiveCount;
    return a.manualCount - b.manualCount;
  });

  const zoneName = context.zoneName || "확인 필요 (용도지역 조회 불가 또는 여러 용도지역 혼재)";

  // ⚠️ 정렬 첫 사업(sorted[0])의 개발규모·확인사항을 대표로 보여주던 구조를 없앴습니다.
  // 02는 사업유형별 요건과 사유만 보여주고, 개발규모·공공기여는 각 OP 안에서만
  // 연결합니다. 사용자가 OP를 고르기 전에 특정 사업을 추천으로 확정하지 않습니다.
  devDashboardEl.root.innerHTML = `
    <p class="dd-scale-current">현재 용도지역 <strong>${_escapeHtml(zoneName)}</strong> 기준입니다.</p>
    ${_renderDdRankSection(sorted, context)}
  `;

  if (typeof renderConclusionFollowups === "function") renderConclusionFollowups();
  if (typeof renderReviewSummary === "function") renderReviewSummary();
}

// 카드마다 클릭 핸들러를 따로 붙이지 않고, 루트 하나에 위임합니다(business-type-review.js의
// OP 카드처럼 매번 새로 그려지는 목록이라 위임이 더 안전합니다).
function _ddHandleActionClick(ev) {
  // 요건 확인 기록(충족/미충족/보류)
  const chk = ev.target.closest("[data-check]");
  if (chk) {
    const box = chk.closest("[data-check-key]");
    if (box) {
      const key = box.dataset.checkKey;
      const val = chk.dataset.check;
      if (_ddManualChecks[key] === val) delete _ddManualChecks[key];
      else _ddManualChecks[key] = val;
      _renderDashboard({ context: _ddLastContext, analyses: _ddLastAnalyses });
    }
    return;
  }

  const btn = ev.target.closest("[data-action]");
  if (!btn || !_ddLastAnalyses) return;

  if (btn.dataset.action === "checklist") {
    _ddOpenChecklistId = _ddOpenChecklistId === btn.dataset.btId ? null : btn.dataset.btId;
    _renderDashboard({ context: _ddLastContext, analyses: _ddLastAnalyses });
    return;
  }
  const btId = btn.dataset.btId;
  const analysis = _ddLastAnalyses.find((a) => a.bt.id === btId);
  if (!analysis) return;

  if (btn.dataset.action === "detail" && typeof openBusinessTypeDetailCard === "function") {
    openBusinessTypeDetailCard(btId);
  } else if (btn.dataset.action === "op") {
    _ddCreateOpFromBusinessType(analysis.bt, _ddLastContext, analysis);
  }
}

// 02 사업유형 검토와 05 종합의견 두 곳에서 같은 버튼이 나오므로 양쪽에 위임합니다.
if (devDashboardEl.root) devDashboardEl.root.addEventListener("click", _ddHandleActionClick);
if (devDashboardEl.followups) devDashboardEl.followups.addEventListener("click", _ddHandleActionClick);

/* ------------------------------------------------------------------ */
/* 진입점 — openDevelopmentWorkspace()가 호출합니다(js/dev-workspace.js)      */
/* ------------------------------------------------------------------ */

async function runDevelopmentAnalysis() {
  _renderDdProgress("대상지 현황 분석 중…");

  const totalArea = typeof mergedParcelResult !== "undefined" && mergedParcelResult ? mergedParcelResult.total_area_sqm : null;

  _renderDdProgress("적용 가능한 개발사업 검토 중…");
  const [businessTypes, zoningContext] = await Promise.all([
    fetchBusinessTypes(),
    typeof getZoningContextForSelection === "function" ? getZoningContextForSelection() : Promise.resolve({ zoneName: null }),
  ]);

  _renderDdProgress("개발조건 정리 중…");
  const context = { totalArea, zoneName: zoningContext.zoneName };
  if (typeof refreshBackendBusinessTypeEvaluations === "function") {
    await refreshBackendBusinessTypeEvaluations(context);
  }
  const analyses = businessTypes.map((bt) => _analyzeBusinessType(bt, context));

  _renderDashboard({ context, analyses });
  if (typeof renderBusinessRuleExplorer === "function") await renderBusinessRuleExplorer(context);
}
