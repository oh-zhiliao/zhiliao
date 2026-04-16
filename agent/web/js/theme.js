/**
 * theme.js — Light/dark theme toggle with localStorage persistence.
 * Light is the default. Theme is stored in [data-theme] on <html>.
 */
var Theme = (function () {
  var STORAGE_KEY = "zhiliao_theme";

  function get() {
    return localStorage.getItem(STORAGE_KEY) || "light";
  }

  function set(theme) {
    if (theme !== "light" && theme !== "dark") return;
    localStorage.setItem(STORAGE_KEY, theme);
    document.documentElement.setAttribute("data-theme", theme);
    _updateToggle();
  }

  function toggle() {
    set(get() === "light" ? "dark" : "light");
  }

  function _updateToggle() {
    var btn = document.getElementById("theme-toggle");
    if (!btn) return;
    var isDark = get() === "dark";
    var iconLight = btn.querySelector(".icon-sun");
    var iconDark = btn.querySelector(".icon-moon");
    if (iconLight) iconLight.style.display = isDark ? "none" : "block";
    if (iconDark) iconDark.style.display = isDark ? "block" : "none";

    // Update text label in settings dropdown
    var textEl = document.getElementById("theme-toggle-text");
    if (textEl) {
      textEl.textContent = isDark ? "Dark" : "Light";
    }
  }

  /** Call once after DOM is ready. */
  function init() {
    var theme = get();
    document.documentElement.setAttribute("data-theme", theme);
    _updateToggle();
  }

  return {
    get: get,
    set: set,
    toggle: toggle,
    init: init,
  };
})();
