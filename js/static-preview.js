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
  window.fetch = function previewAwareFetch(input, init) {
    const url = typeof input === "string" ? input : input && input.url;
    if (url === "/api/health" || String(url || "").endsWith("/api/health")) {
      return Promise.resolve(new Response(JSON.stringify({ status: "preview" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }
    return nativeFetch(input, init);
  };

  function showPreviewNotice() {
    if (document.getElementById("static-preview-notice")) return;

    const notice = document.createElement("div");
    notice.id = "static-preview-notice";
    notice.setAttribute("role", "status");
    notice.textContent = "화면 점검용 · 주소검색과 GIS 분석은 회사 로컬 Main에서 확인합니다.";
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
    document.body.appendChild(notice);

    const status = document.getElementById("server-status");
    if (status) {
      status.textContent = "화면 점검용";
      status.classList.remove("error");
      status.classList.add("ok");
    }
  }

  function explainUnavailableAction(event) {
    const blocked = event.target.closest("#search-button, #btn-area-select-start, #btn-zoning-toggle");
    if (!blocked) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const notice = document.getElementById("static-preview-notice");
    if (notice) {
      notice.textContent = "이 주소에서는 화면만 점검합니다. 실제 주소검색·대상지 선택·GIS 분석은 회사 로컬 Main에서 실행됩니다.";
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
