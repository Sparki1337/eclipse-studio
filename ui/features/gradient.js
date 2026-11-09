(() => {
  "use strict";

  // gradient — редактор положения подсветки: мышь, касание и клавиатура
  const api = window.cgsGradient;
  const panel = document.getElementById("collapse-gradient");
  if (!api || !panel) return;
  const controls = document.getElementById("gradient-controls");
  const map = document.getElementById("gradient-map");
  const surface = document.getElementById("gradient-surface");
  const note = document.getElementById("gradient-note");
  const x = document.getElementById("gradient-x");
  const y = document.getElementById("gradient-y");
  const modeButtons = [...panel.querySelectorAll("[data-gradient-mode]")];
  const pointButtons = [...panel.querySelectorAll("[data-gradient-point]")];
  const markers = [...panel.querySelectorAll("[data-gradient-marker]")];
  let saved = api.normalize(window.cgsStorage.getItem(api.KEY));
  let draft = api.normalize(saved);
  let selected = 0;
  let pending = false;
  let drag = null;
  const text = value => window.cgsI18n?.t?.(value) || value;
  function status(value, error = false) {
    note.dataset.sourceText = value;
    note.textContent = text(value);
    note.hidden = !value;
    note.setAttribute("role", error ? "alert" : "status");
  }
  function render() {
    draft = api.apply(draft);
    const custom = draft.mode !== "theme";
    if (draft.mode !== "two") selected = 0;
    controls.hidden = !custom;
    modeButtons.forEach(button => {
      button.classList.toggle("active", button.dataset.gradientMode === draft.mode);
      button.setAttribute("aria-pressed", String(button.dataset.gradientMode === draft.mode));
    });
    pointButtons.forEach((button, index) => {
      button.hidden = index === 1 && draft.mode !== "two";
      button.classList.toggle("active", selected === index);
      button.setAttribute("aria-pressed", String(selected === index));
    });
    markers.forEach((marker, index) => {
      marker.hidden = !custom || (index === 1 && draft.mode !== "two");
      marker.classList.toggle("active", selected === index);
      marker.style.left = `${draft.points[index].x}%`;
      marker.style.top = `${draft.points[index].y}%`;
    });
    x.value = String(draft.points[selected].x);
    y.value = String(draft.points[selected].y);
    for (const [input, output] of [[x, "gradient-x-value"], [y, "gradient-y-value"]]) {
      document.getElementById(output).textContent = `${input.value}%`;
      input.style.setProperty("--fill", `${input.value}%`);
    }
    panel.querySelectorAll("button, input").forEach(control => { control.disabled = pending; });
    map.setAttribute("aria-busy", String(pending));
  }
  async function commit() {
    if (pending || JSON.stringify(draft) === JSON.stringify(saved)) return;
    const candidate = api.normalize(draft);
    const focused = document.activeElement;
    pending = true; render();
    try {
      await window.cgsStorage.setItemVerified(api.KEY, JSON.stringify(candidate));
      saved = candidate;
      status("Положение градиента сохранено.");
    } catch (_) {
      draft = api.normalize(saved);
      status("Не удалось сохранить градиент. Предыдущее положение восстановлено.", true);
    } finally {
      pending = false; render();
      if (focused && panel.contains(focused) && !focused.hidden) focused.focus({ preventScroll: true });
    }
  }
  modeButtons.forEach(button => button.addEventListener("click", () => {
    if (pending) return;
    draft.mode = button.dataset.gradientMode;
    render(); void commit();
  }));
  pointButtons.forEach((button, index) => button.addEventListener("click", () => {
    selected = index; render();
  }));
  document.getElementById("gradient-reset").addEventListener("click", () => {
    if (pending) return;
    draft = api.defaults(); selected = 0; render(); void commit();
  });
  for (const [input, axis] of [[x, "x"], [y, "y"]]) {
    input.addEventListener("input", () => {
      if (pending) return;
      draft.points[selected][axis] = Number(input.value); render();
    });
    input.addEventListener("change", () => { void commit(); });
  }
  function move(event) {
    const rect = surface.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    draft.points[selected] = {
      x: Math.max(0, Math.min(100, (event.clientX - rect.left - drag.dx) / rect.width * 100)),
      y: Math.max(0, Math.min(100, (event.clientY - rect.top - drag.dy) / rect.height * 100))
    };
    render();
  }
  map.addEventListener("pointerdown", event => {
    if (pending || draft.mode === "theme" || drag || !event.isPrimary || event.button !== 0) return;
    const marker = event.target.closest("[data-gradient-marker]");
    if (marker) selected = Number(marker.dataset.gradientMarker);
    const rect = surface.getBoundingClientRect();
    drag = { id: event.pointerId, dx: marker ? event.clientX - rect.left - rect.width * draft.points[selected].x / 100 : 0,
      dy: marker ? event.clientY - rect.top - rect.height * draft.points[selected].y / 100 : 0 };
    map.setPointerCapture(event.pointerId); event.preventDefault();
    markers[selected].focus({ preventScroll: true }); move(event);
  });
  map.addEventListener("pointermove", event => { if (drag?.id === event.pointerId) move(event); });
  function finish(event, cancelled) {
    if (drag?.id !== event.pointerId) return;
    const id = drag.id; drag = null;
    if (map.hasPointerCapture(id)) map.releasePointerCapture(id);
    if (cancelled) { draft = api.normalize(saved); render(); }
    else { void commit(); }
  }
  map.addEventListener("pointerup", event => finish(event, false));
  map.addEventListener("pointercancel", event => finish(event, true));
  map.addEventListener("lostpointercapture", event => finish(event, true));
  markers.forEach((marker, index) => marker.addEventListener("keydown", event => {
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!delta || pending) return;
    event.preventDefault(); selected = index;
    const step = event.shiftKey ? 10 : 1;
    const point = draft.points[selected];
    point.x = Math.max(0, Math.min(100, point.x + delta[0] * step));
    point.y = Math.max(0, Math.min(100, point.y + delta[1] * step));
    render(); void commit();
  }));
  window.addEventListener("cgs:language-changed", () => {
    if (note.dataset.sourceText) note.textContent = text(note.dataset.sourceText);
  });
  render();
})();
