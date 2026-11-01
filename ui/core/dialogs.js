(() => {
  "use strict";
  let queue = Promise.resolve();
  function show(title, message, options = {}) {
    const task = queue.then(() => open(title, message, options));
    queue = task.catch(() => {}); return task;
  }
  function open(title, message, options) {
    const { confirm = false, confirmText = "Продолжить", cancelText = "Отмена", symbol = confirm ? "?" : "✓" } = options;
    const backdrop = document.querySelector("#modal-backdrop"); const dialog = backdrop.querySelector(".modal");
    const accept = document.querySelector("#modal-confirm"); const cancel = document.querySelector("#modal-cancel");
    const previous = document.activeElement;
    document.querySelector("#modal-title").textContent = title; document.querySelector("#modal-message").textContent = message;
    const badge = document.querySelector("#modal-symbol");
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("aria-hidden", "true");
    const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const paths = { "✓": "m5 12 4 4L19 6", "↺": "M3 11a9 9 0 1 1 2 7M3 4v7h7", "↻": "M21 11a9 9 0 1 0-2 7M21 4v7h-7", "↓": "M12 3v16m-6-6 6 6 6-6", "↑": "M12 21V5m-6 6 6-6 6 6", "!": "M12 3 2 21h20L12 3Zm0 6v5m0 3h.01", "⚠": "M12 3 2 21h20L12 3Zm0 6v5m0 3h.01" };
    shape.setAttribute("d", paths[symbol] || "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-12v7m0-10h.01");
    icon.append(shape); badge.replaceChildren(icon); badge.setAttribute("aria-hidden", "true");
    cancel.classList.toggle("hidden", !confirm); cancel.textContent = cancelText; accept.textContent = confirm ? confirmText : "Понятно";
    dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true"); dialog.setAttribute("aria-labelledby", "modal-title"); dialog.setAttribute("aria-describedby", "modal-message"); dialog.tabIndex = -1;
    const siblings = [...document.body.children].filter(node => node !== backdrop && !["SCRIPT", "STYLE"].includes(node.tagName)).map(node => [node, node.inert]);
    siblings.forEach(([node]) => { node.inert = true; }); backdrop.classList.remove("hidden", "closing");
    return new Promise(resolve => {
      let done = false;
      const controls = () => [...dialog.querySelectorAll("button, a[href], input, select, textarea, [tabindex]")].filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length);
      const focus = () => (confirm ? cancel : accept).focus({ preventScroll: true });
      const finish = value => {
        if (done) return; done = true; accept.onclick = null; cancel.onclick = null;
        document.removeEventListener("keydown", keydown, true); document.removeEventListener("focusin", focusin, true);
        backdrop.classList.add("hidden"); siblings.forEach(([node, inert]) => { node.inert = inert; });
        if (previous?.isConnected && !previous.closest("[inert]")) previous.focus({ preventScroll: true });
        resolve(value);
      };
      const keydown = event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(false); }
        if (event.key === "Tab") {
          const items = controls(); if (!items.length) { event.preventDefault(); dialog.focus(); return; }
          const index = items.indexOf(document.activeElement);
          if (event.shiftKey && index <= 0) { event.preventDefault(); items.at(-1).focus(); }
          else if (!event.shiftKey && (index === -1 || index === items.length - 1)) { event.preventDefault(); items[0].focus(); }
        }
      };
      const focusin = event => { if (!dialog.contains(event.target)) focus(); };
      document.addEventListener("keydown", keydown, true); document.addEventListener("focusin", focusin, true);
      accept.onclick = () => finish(true); cancel.onclick = () => finish(false); focus();
    });
  }
  window.cgsDialogs = { show };
})();
