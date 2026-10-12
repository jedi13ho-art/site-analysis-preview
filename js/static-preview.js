/*
 * GitHub Pages 화면 점검 모드.
 *
 * 정적 URL에서는 백엔드 API를 실행할 수 없으므로 화면과 지도를 점검하는 용도로만
 * 동작한다. localhost에서 ?preview=1을 붙이면 같은 상태를 재현할 수 있다.
 */
(function setupStaticPreview() {
  const params = new URLSearchParams(window.location.search);
  const isStaticPreview = window.location.hostname.endsWith(".github.io") || params.get("preview") === "1";
  if (!isStaticPreview) return;

  window.__STATIC_REVIEW_MODE__ = true;

  const nativeFetch = window.fetch.bind(window);
  function jsonResponse(body, status = 200) {
    return Promise.resolve(new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }));
  }

  const sampleRuleEvaluations = {
    status: "success",
    schema_version: "preview",
    evaluations: [
      {
        business_type_id: "growth_potential_area_revitalization",
        name: "성장잠재권 활성화사업",
        overall_result: "부적합",
        relaxations: { UPZONE: [], FAR: [] },
        entries: [
          { category: "LOC", status: "MISMATCH", site_value: "역세권 / 최대 35m 도로변", summary: "비역세권의 폭 35m 이상 주요 간선도로변에 접한 지역", comparison_method: "SPATIAL", applies_when: null },
          { category: "AREA", status: "MATCH", site_value: "3,420㎡", summary: "사업대상지 최소 1,500㎡ 이상", comparison_method: "EXACT", applies_when: null },
          { category: "AREA", status: "MATCH", site_value: "3,420㎡", summary: "지구단위계획 방식은 사업대상지 5,000㎡ 이하", comparison_method: "EXACT", applies_when: { field: "business_method", value: "지구단위계획" } },
          { category: "AREA", status: "MATCH", site_value: "3,420㎡", summary: "도시정비형 재개발 방식은 사업대상지 10,000㎡ 이하", comparison_method: "EXACT", applies_when: { field: "business_method", value: "도시정비형 재개발" } },
          { category: "ZONE", status: "MATCH", site_value: "제3종일반주거지역", summary: "제2종·제3종일반주거지역 또는 준주거지역", comparison_method: "EXACT", applies_when: null },
          { category: "ROAD", status: "MATCH", site_value: "35m 이상 도로 접도 40.0m / 둘레 260.0m (15.4%)", summary: "사업대상지 둘레의 1/8 이상이 폭 35m 이상 주요 간선도로에 접함", comparison_method: "SPATIAL", applies_when: null },
        ],
      },
      {
        business_type_id: "station_area_revitalization_catalog",
        name: "역세권 활성화사업",
        overall_result: "주요 요건 부합",
        relaxations: { UPZONE: [], FAR: [] },
        entries: [
          { category: "LOC", status: "MATCH", site_value: "역세권형 / 시청역 승강장 경계 180m", summary: "역세권형 또는 비역세권 노선형 상업지역 간선도로변형", comparison_method: "SPATIAL", applies_when: null },
          { category: "AREA", status: "MATCH", site_value: "3,420㎡", summary: "사업대상지 최소 1,500㎡ 이상", comparison_method: "EXACT", applies_when: null },
          { category: "AREA", status: "MATCH", site_value: "3,420㎡", summary: "사업대상지 10,000㎡ 이하", comparison_method: "EXACT", applies_when: null },
          { category: "ZONE", status: "MATCH", site_value: "제3종일반주거지역", summary: "제2종·제3종일반주거지역, 준주거지역 또는 상업지역", comparison_method: "EXACT", applies_when: null },
          { category: "ROAD", status: "MATCH", site_value: "접도 3면 (8m, 12m, 35m)", summary: "2면 이상 폭 4m 이상 도로에 접하고 그중 최소 1면은 폭 8m 이상", comparison_method: "SPATIAL", applies_when: null },
          { category: "COND", status: "MATCH", site_value: "노후건축물 73.3% (11/15동)", summary: "지구단위계획 방식: 20년 이상 건축물 2/3 이상", comparison_method: "EXACT", applies_when: { field: "business_method", value: "지구단위계획" } },
          { category: "COND", status: "MATCH", site_value: "구조·용도별 노후기준 충족 건축물 66.7% (10/15동)", summary: "도시정비형 재개발 방식: 구조·용도별 노후기준 충족 건축물 60% 이상", comparison_method: "EXACT", applies_when: { field: "business_method", value: "도시정비형 재개발" } },
        ],
      },
    ],
  };

  function previewApiResponse(url) {
    const path = new URL(String(url || ""), window.location.href).pathname;
    if (path === "/api/health") return { status: "preview" };
    if (path === "/api/business-types") return { status: "success", business_types: [] };
    if (path === "/api/business-type-evaluations") return { status: "success", evaluations: [] };
    if (path === "/api/business-rule-evaluations") return sampleRuleEvaluations;
    if (path === "/api/district-plan") return { status: "not_included", plans: [] };
    if (path === "/api/station-area") return { status: "ok", verdict: "included", distance_m: 180, nearest: [{ station_name: "시청역", distance_m: 180 }] };
    if (path === "/api/road-requirement") return { status: "ok", faces: [{ width_m: 8, contact_m: 34 }, { width_m: 12, contact_m: 26 }, { width_m: 35, contact_m: 40 }] };
    if (path === "/api/aging-requirement") return {
      status: "success",
      measurement: { total_building_count: 15, resolved_building_count: 15 },
      routes: [
        { route_id: "district_unit_plan", status: "확정 충족", measured_ratio: 11 / 15, measured_numerator: 11, measured_denominator: 15, reason: "화면 점검용 샘플" },
        { route_id: "urban_redevelopment", status: "확정 충족", measured_ratio: 10 / 15, measured_numerator: 10, measured_denominator: 15, reason: "화면 점검용 샘플" },
      ],
    };
    if (path === "/api/exclusion-screening") return { status: "success", screening_status: "no_overlap", layers: [] };
    if (path === "/api/zoning/point-zone") return { status: "ok", zone_name: "제3종일반주거지역", base_far_percent: 250, far_reference_source: "화면 점검용 샘플", far_reference_last_verified: null };
    return null;
  }

  window.fetch = function previewAwareFetch(input, init) {
    const url = typeof input === "string" ? input : input && input.url;
    const previewBody = previewApiResponse(url);
    if (previewBody) return jsonResponse(previewBody);
    if (String(url || "").startsWith("/api/")) return jsonResponse({ detail: "화면 점검 모드에서는 실행하지 않는 기능입니다." }, 503);
    return nativeFetch(input, init);
  };

  function setNoticeMessage(message) {
    const messageEl = document.getElementById("static-preview-message");
    if (messageEl) messageEl.textContent = message;
  }

  function loadStaticReviewSample() {
    try {
      const parcels = [
        { pnu: "PREVIEW001", address: "서울특별시 중구 화면점검동", jibun: "샘플 1", area_sqm: 1120, jiga_per_sqm: 9250000, jiga_gosi_date: "2026-01-01", centroid: { latitude: 37.5668, longitude: 126.9781 }, geometry: { type: "Polygon", coordinates: [[[126.9776,37.5664],[126.9781,37.5664],[126.9781,37.5670],[126.9776,37.5670],[126.9776,37.5664]]] } },
        { pnu: "PREVIEW002", address: "서울특별시 중구 화면점검동", jibun: "샘플 2", area_sqm: 1180, jiga_per_sqm: 9100000, jiga_gosi_date: "2026-01-01", centroid: { latitude: 37.5668, longitude: 126.9786 }, geometry: { type: "Polygon", coordinates: [[[126.9781,37.5664],[126.9787,37.5664],[126.9787,37.5670],[126.9781,37.5670],[126.9781,37.5664]]] } },
        { pnu: "PREVIEW003", address: "서울특별시 중구 화면점검동", jibun: "샘플 3", area_sqm: 1120, jiga_per_sqm: 9000000, jiga_gosi_date: "2026-01-01", centroid: { latitude: 37.5668, longitude: 126.9790 }, geometry: { type: "Polygon", coordinates: [[[126.9787,37.5664],[126.9792,37.5664],[126.9792,37.5670],[126.9787,37.5670],[126.9787,37.5664]]] } },
      ];
      selectedParcels.clear();
      parcels.forEach((parcel) => selectedParcels.set(parcel.pnu, parcel));
      mergedParcelResult = {
        status: "success",
        total_area_sqm: 3420,
        perimeter_m: 260,
        is_disjoint: false,
        centroid: { latitude: 37.5668, longitude: 126.9784 },
        geometry: { type: "Polygon", coordinates: [[[126.9776,37.5664],[126.9792,37.5664],[126.9792,37.5670],[126.9776,37.5670],[126.9776,37.5664]]] },
      };
      activateRealParcel({
        pnu: null,
        address: "화면 점검용 샘플 대상지",
        area_sqm: 3420,
        centroid: mergedParcelResult.centroid,
        geometry: mergedParcelResult.geometry,
        dataset: "화면 점검용 샘플",
      });
      renderMultiParcelOverlay();
      updateMultiParcelUI();
      setNoticeMessage("샘플 대상지 3필지를 선택했습니다. 화면의 ‘개발가능성 분석’을 눌러 다음 단계로 이동하세요.");
    } catch (error) {
      console.error("화면 점검 샘플 준비 실패:", error);
      setNoticeMessage("샘플 화면을 준비하지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.");
    }
  }
  window.loadStaticReviewSample = loadStaticReviewSample;

  function showPreviewNotice() {
    if (document.getElementById("static-preview-notice")) return;

    const notice = document.createElement("div");
    notice.id = "static-preview-notice";
    notice.setAttribute("role", "status");
    Object.assign(notice.style, {
      position: "fixed",
      right: "12px",
      bottom: "12px",
      zIndex: "3000",
      maxWidth: "min(420px, calc(100vw - 24px))",
      padding: "9px 13px",
      borderRadius: "10px",
      background: "rgba(44, 62, 80, 0.94)",
      color: "#fff",
      fontSize: "12px",
      lineHeight: "1.45",
      boxShadow: "0 4px 16px rgba(0, 0, 0, 0.2)",
    });
    const message = document.createElement("span");
    message.id = "static-preview-message";
    message.textContent = "화면 점검용 · 샘플 대상지로 전체 화면을 둘러볼 수 있습니다.";
    notice.appendChild(message);
    const sampleButton = document.createElement("button");
    sampleButton.type = "button";
    sampleButton.textContent = "샘플 대상지 선택";
    Object.assign(sampleButton.style, {
      display: "block",
      marginTop: "7px",
      padding: "6px 10px",
      border: "1px solid rgba(255,255,255,.55)",
      borderRadius: "7px",
      background: "#fff",
      color: "#2c3e50",
      fontWeight: "700",
      cursor: "pointer",
    });
    sampleButton.addEventListener("click", loadStaticReviewSample);
    notice.appendChild(sampleButton);
    document.body.appendChild(notice);

    const status = document.getElementById("server-status");
    if (status) {
      status.textContent = "화면 점검용";
      status.classList.remove("error");
      status.classList.add("ok");
    }
    window.setTimeout(() => {
      if (!status) return;
      status.textContent = "화면 점검용";
      status.classList.remove("error");
      status.classList.add("ok");
    }, 300);
  }

  function explainUnavailableAction(event) {
    if (event.target.closest("#btn-show-feasibility")) {
      window.setTimeout(() => setNoticeMessage("샘플 데이터로 01 대상지부터 04 종합의견까지 화면을 점검할 수 있습니다."), 0);
      return;
    }
    const blocked = event.target.closest("#search-button, #btn-area-select-start");
    if (!blocked) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    loadStaticReviewSample();
    const notice = document.getElementById("static-preview-notice");
    if (notice) {
      notice.animate(
        [{ transform: "translateY(0)" }, { transform: "translateY(-5px)" }, { transform: "translateY(0)" }],
        { duration: 260 }
      );
    }
  }

  document.addEventListener("click", explainUnavailableAction, true);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", showPreviewNotice, { once: true });
  } else {
    showPreviewNotice();
  }
  window.setTimeout(showPreviewNotice, 0);
})();
