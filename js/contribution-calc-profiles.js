/**
 * 공공시설등 기부채납 용적률 인센티브 운영기준(서울특별시, 2025-03-18 일부개정,
 * 행정2부시장방침 제71호)의 3-1-4. 사업유형별 건축물·현금 기부채납 계수를
 * 데이터로 분리한 파일입니다.
 *
 * ⚠️ 이 파일은 "코드에서 사업유형 이름을 보고 숫자를 하드코딩"하지 않기 위한
 * 계산 프로필 테이블입니다 — computeContributionFar()는 이 테이블에서 고른
 * profile_id 하나를 넘겨받아야만 상한용적률을 계산하고, 프로필을 고르지 않으면
 * 미산정으로 남깁니다.
 *
 * 토지계수(1.3)는 운영기준 3-1-1.의 일반식에서 모든 사업유형에 공통이므로
 * 프로필마다 동일하게 1.3을 넣어 두었습니다(사업유형별로 다른 값이 확인되면
 * 그때 프로필별로 분리). 토지 "가중치"(제공부지 허용용적률 ÷ 사업부지
 * 허용용적률)는 대상지마다 달라 프로필에 넣지 않고 항상 사용자 입력을 받습니다.
 *
 * 역세권 활성화사업 등 운영기준 1-2-2.에 열거된 특별기준 사업은 이 표에 없습니다
 * — 최소 공공기여율·완화조건은 각자의 운영기준을 따르고(Rule Set 쪽에서 이미
 * 처리), 토지·건축물·현금 환산과 상한용적률 인센티브 산식만 이 표를 "준용"할
 * 수 있되 특별규정이 있으면 그 규정이 우선합니다(1-2-2, 5장 참고) — 이번
 * 작업에서 그 특별규정 유무까지는 확인하지 못해 "확인 필요"로 남깁니다.
 */

const CONTRIBUTION_CALC_PROFILES = [
  {
    profile_id: "jigudanwi_default",
    plan_type: "지구단위계획",
    special_business_type: null,
    label: "지구단위계획(일반)",
    land_coefficient: 1.3,
    land_weight_required: true,
    building_coefficient_options: [
      { value: 1.0, label: "원칙 1.0" },
      { value: 1.2, label: "완화 1.2 — 권역생활서비스시설·정책적 필요시설, 도시·건축공동위원회 인정 필요" },
    ],
    cash_coefficient: 1.0,
    site_value_method: "확인 필요",
    building_cost_method: "확인 필요",
    source: "공공시설등 기부채납 용적률 인센티브 운영기준 3-1-4.가 (2025-03-18 일부개정, 행정2부시장방침 제71호)",
    applicability_conditions:
      "지구단위계획 전반. 단 사전협상형 지구단위계획·역세권활성화사업 등 1-2-2.에 열거된 특별기준 사업은 제외(해당 사업의 운영기준 우선).",
    verification_status: "공식 기준 확인(원문 3-1-1., 3-1-4.가)",
  },
  {
    profile_id: "jeongbi_dosijeongbi",
    plan_type: "정비계획-도시정비형재개발",
    special_business_type: null,
    label: "정비계획 · 도시정비형재개발",
    land_coefficient: 1.3,
    land_weight_required: true,
    building_coefficient_options: [{ value: 1.2, label: "1.2(원칙)" }],
    cash_coefficient: 1.0,
    site_value_method: "확인 필요",
    building_cost_method: "확인 필요",
    source: "공공시설등 기부채납 용적률 인센티브 운영기준 3-1-4.나.(1) (2025-03-18 일부개정)",
    applicability_conditions:
      "도시정비형재개발정비구역. 용도지역 변경을 수반하는 '주거 주용도' 개발은 주택정비형재개발정비구역 기준(jeongbi_jutaek)을 적용한다고 원문에 명시됨 — 대상지가 이 조건에 해당하면 프로필을 바꿔야 함.",
    verification_status: "공식 기준 확인(원문 3-1-4.나.(1))",
  },
  {
    profile_id: "jeongbi_jutaek",
    plan_type: "정비계획-주택정비형재개발·재건축",
    special_business_type: null,
    label: "정비계획 · 주택정비형재개발/재건축",
    land_coefficient: 1.3,
    land_weight_required: true,
    building_coefficient_options: [
      { value: 0.7, label: "원칙 0.7" },
      { value: 1.0, label: "완화 1.0 — 공공임대주택·전략육성용도(원문 3-1-4.나.(2) 표 참고)" },
    ],
    cash_coefficient: 0.7,
    site_value_method: "확인 필요",
    building_cost_method: "확인 필요",
    source: "공공시설등 기부채납 용적률 인센티브 운영기준 3-1-4.나.(2) (2025-03-18 일부개정)",
    applicability_conditions: "주택정비형재개발 및 재건축 정비구역.",
    verification_status: "공식 기준 확인(원문 3-1-4.나.(2))",
  },
  {
    profile_id: "jeongbi_chokjin_seun",
    plan_type: "재정비촉진계획-세운재정비촉진지구",
    special_business_type: null,
    label: "재정비촉진계획 · 세운재정비촉진지구(도시정비형재개발)",
    land_coefficient: 1.3,
    land_weight_required: true,
    building_coefficient_options: [{ value: 1.2, label: "1.2(원칙)" }],
    cash_coefficient: 0.7,
    site_value_method: "확인 필요",
    building_cost_method: "확인 필요",
    source: "공공시설등 기부채납 용적률 인센티브 운영기준 3-1-4.다.(1) (2025-03-18 일부개정)",
    applicability_conditions: "세운재정비촉진지구 내 도시정비형재개발정비사업.",
    verification_status: "공식 기준 확인(원문 3-1-4.다.(1))",
  },
  {
    profile_id: "jeongbi_chokjin_gita",
    plan_type: "재정비촉진계획-그 외 촉진지구",
    special_business_type: null,
    label: "재정비촉진계획 · 그 외 촉진지구(도시정비형재개발)",
    land_coefficient: 1.3,
    land_weight_required: true,
    building_coefficient_options: [
      { value: 0.7, label: "0.7 — 도시정비형재개발사업 중 주거비율완화대상" },
      { value: 1.0, label: "1.0 — 도시정비형재개발사업" },
      { value: 1.2, label: "1.2 — 시정책목표 달성을 재정비위원회 심의시 인정받은 경우" },
    ],
    cash_coefficient: 0.7,
    site_value_method: "확인 필요",
    building_cost_method: "확인 필요",
    source: "공공시설등 기부채납 용적률 인센티브 운영기준 3-1-4.다.(2) (2025-03-18 일부개정)",
    applicability_conditions: "세운재정비촉진지구 외의 재정비촉진지구 내 도시정비형재개발정비사업.",
    verification_status: "공식 기준 확인(원문 3-1-4.다.(2))",
  },
];

function getContributionCalcProfile(profileId) {
  return CONTRIBUTION_CALC_PROFILES.find((p) => p.profile_id === profileId) || null;
}
