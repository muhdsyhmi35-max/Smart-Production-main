const { ipcRenderer } = require("electron");

function mountWindowControls() {
  if (document.getElementById("desktop-window-controls")) return;

  const header = document.querySelector(".header");
  document.documentElement.classList.add("desktop-app");

  const bar = document.createElement("div");
  bar.id = "desktop-window-controls";
  bar.innerHTML = `
    <button type="button" data-act="minimize" title="Minimize" aria-label="Minimize">&#8211;</button>
    <button type="button" data-act="restore" title="Restore" aria-label="Restore">&#9633;</button>
    <button type="button" data-act="close" title="Close" aria-label="Close">&#10005;</button>
  `;

  const style = document.createElement("style");
  style.textContent = `
    html.desktop-app .header{
      padding-right:168px !important;
    }
    html.desktop-app .fullscreen-btn{
      display:none !important;
    }
    html.desktop-app .header-title-wrap{
      -webkit-app-region:drag;
    }
    html.desktop-app .menu-btn,
    html.desktop-app .header-meta,
    html.desktop-app .header-role-dropdown{
      -webkit-app-region:no-drag;
    }
    #desktop-window-controls{
      position:absolute;
      top:50%;
      right:8px;
      transform:translateY(-50%);
      z-index:2147483646;
      display:flex;
      align-items:center;
      height:32px;
      -webkit-app-region:no-drag;
    }
    html.desktop-app:not(:has(.header)) #desktop-window-controls{
      position:fixed;
      top:8px;
      right:8px;
      transform:none;
    }
    #desktop-window-controls button{
      width:46px;
      height:32px;
      margin:0;
      padding:0;
      border:0;
      border-radius:6px;
      background:transparent;
      color:#e2e8f0;
      font:16px/32px "Segoe UI", sans-serif;
      cursor:pointer;
    }
    #desktop-window-controls button:hover{
      background:rgba(148,163,184,.22);
    }
    #desktop-window-controls button[data-act="close"]:hover{
      background:#e81123;
      color:#fff;
    }
  `;

  document.documentElement.appendChild(style);
  (header || document.documentElement).appendChild(bar);

  bar.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    event.stopPropagation();
    ipcRenderer.send("window-" + button.dataset.act);
  });
}

window.addEventListener("DOMContentLoaded", mountWindowControls);
