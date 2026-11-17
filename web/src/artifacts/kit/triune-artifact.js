/* PolyForm Noncommercial 1.0.0.
 * Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
 * Optional native helpers; no application, network or provider dependency.
 */
(function () {
  "use strict";
  const initialized = new WeakSet();
  let serial = 0;
  function refresh(root) {
    root.querySelectorAll('input[type="range"]').forEach((control) => {
      const min = control.min === "" ? 0 : Number(control.min);
      const max = control.max === "" ? 100 : Number(control.max);
      const percent = max > min ? (100 * (control.valueAsNumber - min)) / (max - min) : 0;
      control.style.setProperty("--ta-range-progress", Math.max(0, Math.min(100, percent)) + "%");
    });
  }
  function init(root) {
    if (!root || initialized.has(root)) return;
    initialized.add(root);
    root.querySelectorAll('input[type="checkbox"][data-ta-mixed]').forEach((control) => {
      control.indeterminate = true;
    });
    refresh(root);
    root.addEventListener("input", () => refresh(root));
    root.addEventListener("change", () => refresh(root));
    root.addEventListener("reset", () => setTimeout(() => refresh(root), 0));
    window.addEventListener("triune-artifact:restored", () => refresh(root));
    root.querySelectorAll("[data-ta-theme]").forEach((control) => {
      control.addEventListener("change", () => {
        root.dataset.theme = control.value;
      });
    });
    root.querySelectorAll("[data-ta-density]").forEach((control) => {
      control.addEventListener("change", () => {
        root.dataset.density = control.value;
      });
    });
    root.querySelectorAll('[role="tablist"]').forEach((list) => {
      const tabs = [...list.querySelectorAll('[role="tab"]')];
      function select(tab, focus) {
        tabs.forEach((candidate) => {
          const active = candidate === tab;
          candidate.setAttribute("aria-selected", String(active));
          candidate.tabIndex = active ? 0 : -1;
          const panel = root.querySelector(
            "#" + CSS.escape(candidate.getAttribute("aria-controls")),
          );
          if (panel) panel.hidden = !active;
        });
        if (focus) tab.focus();
      }
      tabs.forEach((tab) => {
        tab.addEventListener("click", () => select(tab, false));
        tab.addEventListener("keydown", (event) => {
          let next;
          const index = tabs.indexOf(tab);
          if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
          else if (event.key === "ArrowLeft") next = tabs[(index - 1 + tabs.length) % tabs.length];
          else if (event.key === "Home") next = tabs[0];
          else if (event.key === "End") next = tabs[tabs.length - 1];
          if (next) {
            event.preventDefault();
            select(next, true);
          }
        });
      });
    });
    root.querySelectorAll("[data-ta-disclosure]").forEach((button) => {
      button.addEventListener("click", () => {
        const body = root.querySelector("#" + CSS.escape(button.getAttribute("aria-controls")));
        if (!body) return;
        const expanded = button.getAttribute("aria-expanded") !== "true";
        button.setAttribute("aria-expanded", String(expanded));
        body.hidden = !expanded;
        const summary = button.closest(".ta-message")?.querySelector("[data-ta-summary]");
        if (summary) summary.hidden = expanded;
      });
    });
    const tip = document.createElement("div");
    tip.className = "ta-tooltip";
    tip.id = "ta-tooltip-" + ++serial;
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    root.append(tip);
    let owner = null;
    let timer = 0;
    const hide = () => {
      clearTimeout(timer);
      tip.hidden = true;
      if (owner) owner.removeAttribute("aria-describedby");
      owner = null;
    };
    function show(target) {
      hide();
      owner = target;
      tip.textContent = target.dataset.taTip;
      tip.hidden = false;
      target.setAttribute("aria-describedby", tip.id);
      const bounds = root.getBoundingClientRect();
      const targetBounds = target.getBoundingClientRect();
      const tipBounds = tip.getBoundingClientRect();
      tip.style.left =
        Math.max(
          8,
          Math.min(
            bounds.width - tipBounds.width - 8,
            targetBounds.left - bounds.left + (targetBounds.width - tipBounds.width) / 2,
          ),
        ) + "px";
      tip.style.top = targetBounds.bottom - bounds.top + 4 + "px";
    }
    root.querySelectorAll("[data-ta-tip]").forEach((target) => {
      target.addEventListener("pointerenter", () => {
        clearTimeout(timer);
        timer = window.setTimeout(() => show(target), 600);
      });
      target.addEventListener("pointerleave", hide);
      target.addEventListener("focus", () => show(target));
      target.addEventListener("blur", hide);
      target.addEventListener("keydown", (event) => {
        if (event.key === "Escape") hide();
      });
    });
  }
  window.TriuneArtifact = Object.freeze({
    init,
    refresh,
    get maximumBodyHeight() {
      return window.TriuneArtifactLayout?.maximumBodyHeight;
    },
  });
  document.querySelectorAll("[data-ta-init]").forEach(init);
})();
