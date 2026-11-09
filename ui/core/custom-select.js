(() => {
  "use strict";

  // custom-select — выпадающие списки в стиле приложения вместо системных
  let activeDropdown = null;
  let activeTrigger = null;
  let activeSelect = null;
  let highlightedIndex = -1;

  function closeAll() {
    if (activeDropdown) {
      const dropdown = activeDropdown;
      dropdown.classList.remove("open");
      dropdown.inert = true;
      dropdown.setAttribute("aria-hidden", "true");
      dropdown.style.pointerEvents = "none";
      if (window.cgsMotion) window.cgsMotion.dismiss(dropdown, () => dropdown.remove());
      else dropdown.remove();
      activeDropdown = null;
    }
    if (activeTrigger) {
      activeTrigger.classList.remove("open");
      activeTrigger.setAttribute("aria-expanded", "false");
      activeTrigger = null;
    }
    activeSelect = null;
    highlightedIndex = -1;
    window.removeEventListener("scroll", handleWindowScroll, true);
    window.removeEventListener("resize", handleWindowResize);
    window.removeEventListener("keydown", handleKeyNavigation);
  }

  function handleWindowScroll(e) {
    // Скролл внутри самого списка не закрывает его
    if (activeDropdown && activeDropdown.contains(e.target)) return;
    closeAll();
  }

  function handleWindowResize() {
    closeAll();
  }

  function updateTriggerLabel(select, trigger) {
    const selectedOpt = select.options[select.selectedIndex];
    const labelSpan = trigger.querySelector(".custom-select-label");
    if (labelSpan) {
      labelSpan.textContent = selectedOpt ? selectedOpt.textContent : (select.value || "");
    }
  }

  function positionDropdown(trigger, dropdown) {
    const rect = trigger.getBoundingClientRect();
    const dropdownHeight = Math.min(dropdown.scrollHeight || 240, 260);
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;

    dropdown.style.position = "fixed";
    dropdown.style.left = `${rect.left}px`;
    dropdown.style.minWidth = `${rect.width}px`;
    dropdown.style.width = "max-content";
    dropdown.style.maxWidth = `${Math.max(rect.width, 320)}px`;
    dropdown.style.zIndex = "99999";

    // Снизу мало места, сверху достаточно — открываем вверх
    if (spaceBelow < dropdownHeight + 12 && spaceAbove > dropdownHeight + 12) {
      dropdown.style.top = `${rect.top - dropdownHeight - 6}px`;
      dropdown.classList.add("opens-up");
    } else {
      dropdown.style.top = `${rect.bottom + 6}px`;
      dropdown.classList.remove("opens-up");
    }
  }

  function handleKeyNavigation(e) {
    if (!activeDropdown || !activeSelect) return;
    const options = Array.from(activeDropdown.querySelectorAll(".custom-select-option"));
    if (!options.length) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlightedIndex = (highlightedIndex + 1) % options.length;
      updateHighlight(options);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlightedIndex = (highlightedIndex - 1 + options.length) % options.length;
      updateHighlight(options);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (highlightedIndex >= 0 && highlightedIndex < options.length) {
        options[highlightedIndex].click();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeAll();
    }
  }

  function updateHighlight(options) {
    options.forEach((opt, idx) => {
      const isHl = idx === highlightedIndex;
      opt.classList.toggle("highlighted", isHl);
      if (isHl) {
        opt.scrollIntoView({ block: "nearest" });
      }
    });
  }

  function populateDropdownOptions(select, dropdown, trigger) {
    dropdown.innerHTML = "";
    const options = Array.from(select.options);

    options.forEach((opt, index) => {
      // Disabled-опции и опции с тире превращаем в разделители
      const isSeparator = opt.disabled || opt.classList.contains("custom-sound-sep") || opt.classList.contains("separator");
      if (isSeparator) {
        const sep = document.createElement("div");
        sep.className = "custom-select-separator";
        const cleanTitle = opt.textContent.replace(/[─—\-]/g, "").trim();
        sep.innerHTML = `<span>${cleanTitle || opt.textContent}</span>`;
        dropdown.appendChild(sep);
        return;
      }

      const optEl = document.createElement("div");
      const isSelected = opt.selected || opt.value === select.value;
      optEl.className = `custom-select-option${isSelected ? " selected" : ""}`;
      optEl.dataset.value = opt.value;
      optEl.dataset.index = String(index);
      optEl.setAttribute("role", "option");
      optEl.setAttribute("aria-selected", isSelected ? "true" : "false");

      const textSpan = document.createElement("span");
      textSpan.className = "custom-select-option-text";
      textSpan.textContent = opt.textContent;
      optEl.appendChild(textSpan);

      const checkSpan = document.createElement("span");
      checkSpan.className = "custom-select-option-check";
      checkSpan.innerHTML = `<svg viewBox="0 0 16 16"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M3.5 8.5l3.5 3.5 6-7"/></svg>`;
      optEl.appendChild(checkSpan);

      optEl.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (select.value !== opt.value) {
          select.value = opt.value;
          select.selectedIndex = index;
          updateTriggerLabel(select, trigger);
          select.dispatchEvent(new Event("change", { bubbles: true }));
          select.dispatchEvent(new Event("input", { bubbles: true }));
        }
        closeAll();
      });

      dropdown.appendChild(optEl);
    });
  }

  function openDropdown(select, trigger) {
    if (activeTrigger === trigger) {
      closeAll();
      return;
    }
    closeAll();

    if (select.disabled || select.closest(".audio-disabled")) return;

    const dropdown = document.createElement("div");
    dropdown.className = "custom-select-dropdown";
    dropdown.setAttribute("role", "listbox");

    populateDropdownOptions(select, dropdown, trigger);

    document.body.appendChild(dropdown);
    positionDropdown(trigger, dropdown);

    requestAnimationFrame(() => {
      dropdown.classList.add("open");
      trigger.classList.add("open");
      trigger.setAttribute("aria-expanded", "true");
    });

    activeDropdown = dropdown;
    activeTrigger = trigger;
    activeSelect = select;

    const options = Array.from(dropdown.querySelectorAll(".custom-select-option"));
    highlightedIndex = options.findIndex((opt) => opt.classList.contains("selected"));

    window.addEventListener("scroll", handleWindowScroll, { passive: true, capture: true });
    window.addEventListener("resize", handleWindowResize, { passive: true });
    window.addEventListener("keydown", handleKeyNavigation);

    const selectedItem = dropdown.querySelector(".custom-select-option.selected");
    if (selectedItem) {
      selectedItem.scrollIntoView({ block: "nearest" });
    }
  }

  function enhanceSelect(select) {
    if (!select || select._customSelectEnhanced) return;
    select._customSelectEnhanced = true;

    // Оригинальный селект скрыт, но продолжает генерировать события
    select.classList.add("custom-select-hidden");
    select.setAttribute("tabindex", "-1");
    select.setAttribute("aria-hidden", "true");

    // Кнопка-триггер
    const trigger = document.createElement("div");
    trigger.className = "custom-select-trigger";
    trigger.setAttribute("role", "combobox");
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("tabindex", "0");

    // Классы оформления из исходного селекта
    if (select.classList.contains("ui-audio-select")) trigger.classList.add("ui-audio-select-trigger");
    if (select.classList.contains("ui-font-select")) trigger.classList.add("ui-font-select-trigger");

    const labelSpan = document.createElement("span");
    labelSpan.className = "custom-select-label";
    trigger.appendChild(labelSpan);

    const arrowSpan = document.createElement("span");
    arrowSpan.className = "custom-select-arrow";
    arrowSpan.innerHTML = `<svg viewBox="0 0 16 16"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 6l4 4 4-4"/></svg>`;
    trigger.appendChild(arrowSpan);

    updateTriggerLabel(select, trigger);

    select.parentNode.insertBefore(trigger, select.nextSibling);

    // Клик не должен проваливаться в родительский <label>
    trigger.addEventListener("mousedown", (e) => {
      e.preventDefault();
    });

    trigger.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openDropdown(select, trigger);
    });

    trigger.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        openDropdown(select, trigger);
      } else if (e.key === "Escape") {
        closeAll();
      }
    });

    select._customSelectUpdate = () => {
      updateTriggerLabel(select, trigger);
      trigger.classList.toggle("disabled", select.disabled);
    };

    // Синхронизация при изменении опций
    const observer = new MutationObserver(() => {
      updateTriggerLabel(select, trigger);
      if (activeSelect === select && activeDropdown) {
        populateDropdownOptions(select, activeDropdown, trigger);
        positionDropdown(trigger, activeDropdown);
      }
    });
    observer.observe(select, { childList: true, subtree: true, characterData: true });

    const attrObserver = new MutationObserver(() => {
      trigger.classList.toggle("disabled", select.disabled);
    });
    attrObserver.observe(select, { attributes: true, attributeFilter: ["disabled"] });
  }

  document.addEventListener("click", (e) => {
    if (activeDropdown && !activeDropdown.contains(e.target) && (!activeTrigger || !activeTrigger.contains(e.target))) {
      closeAll();
    }
  }, { capture: true });

  // Перехват setter select.value — мгновенная синхронизация метки триггера
  try {
    const proto = HTMLSelectElement.prototype;
    const originalDescriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (originalDescriptor && originalDescriptor.set) {
      Object.defineProperty(proto, "value", {
        set: function (val) {
          originalDescriptor.set.call(this, val);
          if (typeof this._customSelectUpdate === "function") {
            this._customSelectUpdate();
          }
        },
        get: originalDescriptor.get,
        configurable: true,
        enumerable: true
      });
    }
  } catch (_) {}

  function initAll() {
    const selects = document.querySelectorAll("select");
    selects.forEach(enhanceSelect);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAll);
  } else {
    initAll();
  }

  window.cgsCustomSelect = {
    initAll,
    enhanceSelect,
    closeAll,
    sync: (select) => {
      if (select && typeof select._customSelectUpdate === "function") {
        select._customSelectUpdate();
      }
    }
  };
})();
