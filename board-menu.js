(() => {
  "use strict";

  if (window.__TONEST_BOARD_MENU_INIT__) {
    return;
  }

  window.__TONEST_BOARD_MENU_INIT__ = true;

  /*
   * TO:NEST 공통 페이지 정의.
   * 새 페이지가 생기면 여기만 추가하면 됩니다.
   *
   * 실제 확장자 없는 파일 렌더링은 Cloudflare Worker가 담당합니다.
   */
  const PAGES = [
    {
      key: "home",
      label: "Home",
      path: "/home"
    }
  ];

  function normalizePath(path) {
    let value = String(path || "/")
      .replace(/[?#].*$/, "");

    if (!value.startsWith("/")) {
      value = "/" + value;
    }

    if (
      value.length > 1 &&
      value.endsWith("/")
    ) {
      value = value.slice(0, -1);
    }

    return value;
  }

  function currentPage() {
    const current =
      normalizePath(location.pathname);

    return PAGES.find(
      (page) =>
        normalizePath(page.path) === current
    ) || null;
  }

  window.TONEST_PAGES = PAGES;
  window.TONEST_CURRENT_PAGE = currentPage();
})();
