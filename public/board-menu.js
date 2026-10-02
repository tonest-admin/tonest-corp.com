(() => {
  "use strict";

  if (window.__TONEST_BOARD_MENU_INIT__) return;
  window.__TONEST_BOARD_MENU_INIT__ = true;

  const PAGES = [
    {
      key: "home",
      label: "Home",
      path: "/home",
      desc: "투네스트 운영 홈"
    },
    {
      key: "info",
      label: "TO:NEST 정보",
      path: "/tonest_info",
      desc: "인사 · 운영 기본정보"
    }
  ];

  const esc = value =>
    String(value ?? "")
      .replaceAll("&","&amp;")
      .replaceAll("<","&lt;")
      .replaceAll(">","&gt;")
      .replaceAll('"',"&quot;")
      .replaceAll("'","&#39;");

  const norm = path => {
    let value = String(path || "/")
      .replace(/[?#].*$/,"");

    if (!value.startsWith("/")) {
      value = "/" + value;
    }

    if (
      value.length > 1 &&
      value.endsWith("/")
    ) {
      value = value.slice(0,-1);
    }

    return value;
  };

  const currentPath = norm(location.pathname);

  function installStyles(){
    if(document.getElementById("tn-board-menu-style")) return;

    const style = document.createElement("style");
    style.id = "tn-board-menu-style";
    style.textContent = `
      .tn-menu-backdrop{
        position:fixed;inset:0;z-index:99990;
        display:none;background:rgba(15,33,36,.42)
      }
      .tn-menu-backdrop.open{display:block}
      .tn-menu-panel{
        position:fixed;top:18px;left:18px;z-index:99991;
        width:min(360px,calc(100vw - 36px));
        max-height:min(82vh,720px);overflow:auto;
        display:none;border-radius:20px;
        background:#102326;color:#fff;
        box-shadow:0 24px 80px rgba(0,0,0,.34)
      }
      .tn-menu-panel.open{display:block}
      .tn-menu-head{
        display:flex;align-items:center;gap:10px;
        padding:14px 15px;border-bottom:1px solid rgba(255,255,255,.10)
      }
      .tn-menu-head img{
        width:34px;height:34px;object-fit:contain;border-radius:9px;background:#fff
      }
      .tn-menu-title{font-weight:850;flex:1}
      .tn-menu-close{
        height:34px;padding:0 11px;border-radius:999px;
        border:1px solid rgba(255,255,255,.14);
        background:rgba(255,255,255,.06);color:#fff;
        font-weight:800;cursor:pointer
      }
      .tn-menu-list{display:grid;gap:9px;padding:12px}
      .tn-menu-item{
        display:block;padding:13px;border-radius:14px;
        border:1px solid rgba(255,255,255,.10);
        background:rgba(255,255,255,.04);
        color:#fff;text-decoration:none
      }
      .tn-menu-item:hover,.tn-menu-item.current{
        border-color:rgba(45,212,191,.55);
        background:rgba(20,184,166,.14)
      }
      .tn-menu-item-title{font-size:14px;font-weight:850}
      .tn-menu-item-desc{margin-top:4px;color:#b7c8ca;font-size:11px}
    `;

    document.head.appendChild(style);
  }

  function init(){
    installStyles();

    const backdrop = document.createElement("div");
    const panel = document.createElement("div");

    backdrop.className = "tn-menu-backdrop";
    panel.className = "tn-menu-panel";

    panel.innerHTML = `
      <div class="tn-menu-head">
        <img src="/logo.png" alt="TO:NEST">
        <div class="tn-menu-title">TO:NEST 메뉴</div>
        <button class="tn-menu-close" type="button">닫기</button>
      </div>
      <div class="tn-menu-list">
        ${PAGES.map(page => `
          <a class="tn-menu-item ${norm(page.path) === currentPath ? "current" : ""}"
             href="${esc(page.path)}">
            <div class="tn-menu-item-title">${esc(page.label)}</div>
            <div class="tn-menu-item-desc">${esc(page.desc)}</div>
          </a>
        `).join("")}
      </div>
    `;

    document.body.append(backdrop,panel);

    const close = () => {
      backdrop.classList.remove("open");
      panel.classList.remove("open");
    };

    const open = () => {
      backdrop.classList.add("open");
      panel.classList.add("open");
    };

    backdrop.addEventListener("click",close);
    panel.querySelector(".tn-menu-close").addEventListener("click",close);

    const toggle = document.getElementById("tnBoardMenuToggle");
    if(toggle){
      toggle.addEventListener("click",event=>{
        event.preventDefault();
        open();
      });
    }
  }

  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded",init,{once:true});
  }else{
    init();
  }
})();
