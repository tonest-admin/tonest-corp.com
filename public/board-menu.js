(() => {
  "use strict";

  if (
    window.__TONEST_BOARD_MENU_INIT__
  ) {
    return;
  }

  window.__TONEST_BOARD_MENU_INIT__ = true;


  const BUILD =
    "20261002-favicon-fullwidth-v2";


  const PAGES = [
    {
      key:"home",
      label:"Home",
      path:"/home",
      desc:"투네스트 운영 홈"
    },
    {
      key:"info",
      label:"TO:NEST 정보",
      path:"/tonest_info",
      desc:"인사 · 운영 기본정보"
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

    let value =
      String(path || "/")
        .replace(/[?#].*$/,"");


    if(
      !value.startsWith("/")
    ){
      value =
        "/" + value;
    }


    if(
      value.length > 1 &&
      value.endsWith("/")
    ){
      value =
        value.slice(0,-1);
    }


    return value;
  };


  const currentPath =
    norm(location.pathname);


  function installStyles(){

    if(
      document.getElementById(
        "tn-board-menu-style"
      )
    ){
      return;
    }


    const style =
      document.createElement("style");


    style.id =
      "tn-board-menu-style";


    style.textContent = `

      .tn-menu-backdrop{
        position:fixed;
        inset:0;
        z-index:99990;
        display:none;
        background:
          rgba(15,33,36,.42);
        backdrop-filter:
          blur(2px);
      }

      .tn-menu-backdrop.open{
        display:block;
      }


      .tn-menu-panel{
        position:fixed;
        top:14px;
        left:14px;
        z-index:99991;

        width:
          min(
            390px,
            calc(100vw - 28px)
          );

        max-height:
          calc(100vh - 28px);

        overflow:auto;

        display:none;

        border:
          1px solid
          rgba(255,255,255,.08);

        border-radius:20px;

        background:#102326;
        color:#fff;

        box-shadow:
          0 24px 80px
          rgba(0,0,0,.34);
      }


      .tn-menu-panel.open{
        display:block;
      }


      .tn-menu-head{
        display:flex;
        align-items:center;
        gap:10px;

        padding:
          13px 14px;

        border-bottom:
          1px solid
          rgba(255,255,255,.10);
      }


      .tn-menu-brand{
        width:38px;
        height:38px;

        flex:
          0 0 38px;

        display:grid;
        place-items:center;

        border-radius:10px;

        background:#fff;
      }


      /*
       * Home과 동일하게
       * board menu도 favicon.ico 사용.
       */
      .tn-menu-brand img{
        width:34px;
        height:34px;
        display:block;
        object-fit:contain;
      }


      .tn-menu-title{
        min-width:0;
        flex:1;

        font-size:15px;
        font-weight:850;
        letter-spacing:-.02em;
      }


      .tn-menu-subtitle{
        margin-top:2px;

        color:#a8babc;

        font-size:10px;
        font-weight:650;
      }


      .tn-menu-close{
        height:34px;
        padding:0 11px;

        border-radius:999px;

        border:
          1px solid
          rgba(255,255,255,.14);

        background:
          rgba(255,255,255,.06);

        color:#fff;

        font-weight:800;
        cursor:pointer;
      }


      .tn-menu-list{
        display:grid;
        gap:9px;

        padding:12px;
      }


      .tn-menu-item{
        display:block;

        padding:13px;

        border:
          1px solid
          rgba(255,255,255,.10);

        border-radius:14px;

        background:
          rgba(255,255,255,.04);

        color:#fff;
        text-decoration:none;

        transition:
          background .15s,
          border-color .15s;
      }


      .tn-menu-item:hover,
      .tn-menu-item.current{
        border-color:
          rgba(45,212,191,.55);

        background:
          rgba(20,184,166,.14);
      }


      .tn-menu-item-title{
        font-size:14px;
        font-weight:850;
      }


      .tn-menu-item-desc{
        margin-top:4px;

        color:#b7c8ca;

        font-size:11px;
        line-height:1.45;
      }


      @media(
        max-width:640px
      ){

        .tn-menu-panel{
          top:7px;
          left:7px;

          width:
            calc(100vw - 14px);

          max-height:
            calc(100vh - 14px);

          border-radius:16px;
        }

      }

    `;


    document.head.appendChild(
      style
    );
  }


  function init(){

    console.info(
      "[TO:NEST board-menu]",
      BUILD
    );


    installStyles();


    const backdrop =
      document.createElement("div");


    const panel =
      document.createElement("div");


    backdrop.className =
      "tn-menu-backdrop";


    panel.className =
      "tn-menu-panel";


    panel.innerHTML = `

      <div class="tn-menu-head">

        <div class="tn-menu-brand">
          <img
            src="/favicon.ico?v=6"
            alt="TO:NEST"
          >
        </div>

        <div class="tn-menu-title">
          TO:NEST 메뉴

          <div class="tn-menu-subtitle">
            OPERATIONS
          </div>
        </div>

        <button
          class="tn-menu-close"
          type="button"
        >
          닫기
        </button>

      </div>


      <div class="tn-menu-list">

        ${
          PAGES.map(page => `

            <a
              class="
                tn-menu-item
                ${
                  norm(page.path) ===
                  currentPath
                    ? "current"
                    : ""
                }
              "
              href="${esc(page.path)}"
            >

              <div
                class="tn-menu-item-title"
              >
                ${esc(page.label)}
              </div>

              <div
                class="tn-menu-item-desc"
              >
                ${esc(page.desc)}
              </div>

            </a>

          `).join("")
        }

      </div>

    `;


    document.body.append(
      backdrop,
      panel
    );


    const close = () => {

      backdrop
        .classList
        .remove("open");

      panel
        .classList
        .remove("open");

    };


    const open = () => {

      backdrop
        .classList
        .add("open");

      panel
        .classList
        .add("open");

    };


    backdrop.addEventListener(
      "click",
      close
    );


    panel
      .querySelector(
        ".tn-menu-close"
      )
      .addEventListener(
        "click",
        close
      );


    document.addEventListener(
      "keydown",
      event => {

        if(
          event.key ===
          "Escape"
        ){
          close();
        }

      }
    );


    const toggle =
      document.getElementById(
        "tnBoardMenuToggle"
      );


    if(toggle){

      toggle.addEventListener(
        "click",
        event => {

          event.preventDefault();
          open();

        }
      );

    }

  }


  if(
    document.readyState ===
    "loading"
  ){

    document.addEventListener(
      "DOMContentLoaded",
      init,
      {
        once:true
      }
    );

  }else{

    init();

  }

})();
