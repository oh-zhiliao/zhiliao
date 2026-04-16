/**
 * i18n.js — Internationalization: English (default) and Chinese.
 */
var I18n = (function () {
  var STORAGE_KEY = "zhiliao_lang";
  var _lang = localStorage.getItem(STORAGE_KEY) || "en";
  var _changeHandlers = [];

  var _dict = {
    en: {
      "app.title": "Zhiliao",
      "app.subtitle": "Zhiliao WebChat",
      "login.password": "Password",
      "login.submit": "Sign In",
      "login.submitting": "Signing in\u2026",
      "chat.newChat": "New Chat",
      "chat.placeholder": "Send a message\u2026",
      "chat.welcome": "How can I help?",
      "chat.welcomeHint": "Start a conversation or pick one from the sidebar.",
      "chat.manualStop": "Manually stopped",
      "chat.connectionLost": "Connection lost",
      "chat.defaultTitle": "Zhiliao",
      "tools.collapsed": " more",
      "sidebar.newChat": "New Chat",
      "sidebar.purge": "Purge All",
      "sidebar.logout": "Logout",
      "sidebar.empty": "No conversations yet",
      "sidebar.today": "Today",
      "sidebar.yesterday": "Yesterday",
      "sidebar.rename": "Rename",
      "sidebar.delete": "Delete",
      "sidebar.confirmDelete": "Delete this conversation?",
      "sidebar.confirmPurge": "Delete all conversations? This cannot be undone.",
      "sidebar.renamePrompt": "Rename session:",
      "status.connected": "Connected",
      "status.disconnected": "Disconnected",
    },
    zh: {
      "app.title": "\u77E5\u4E86",
      "app.subtitle": "\u77E5\u4E86 WebChat",
      "login.password": "\u5BC6\u7801",
      "login.submit": "\u767B\u5F55",
      "login.submitting": "\u767B\u5F55\u4E2D\u2026",
      "chat.newChat": "\u65B0\u5BF9\u8BDD",
      "chat.placeholder": "\u53D1\u9001\u6D88\u606F\u2026",
      "chat.welcome": "\u6709\u4EC0\u4E48\u53EF\u4EE5\u5E2E\u4F60\u7684\uFF1F",
      "chat.welcomeHint": "\u5F00\u59CB\u65B0\u5BF9\u8BDD\u6216\u4ECE\u4FA7\u8FB9\u680F\u9009\u62E9\u3002",
      "chat.manualStop": "\u5DF2\u624B\u52A8\u505C\u6B62",
      "chat.connectionLost": "\u8FDE\u63A5\u5DF2\u65AD\u5F00",
      "chat.defaultTitle": "\u77E5\u4E86",
      "tools.collapsed": " \u66F4\u591A",
      "sidebar.newChat": "\u65B0\u5BF9\u8BDD",
      "sidebar.purge": "\u6E05\u9664\u5168\u90E8",
      "sidebar.logout": "\u9000\u51FA",
      "sidebar.empty": "\u6682\u65E0\u5BF9\u8BDD",
      "sidebar.today": "\u4ECA\u5929",
      "sidebar.yesterday": "\u6628\u5929",
      "sidebar.rename": "\u91CD\u547D\u540D",
      "sidebar.delete": "\u5220\u9664",
      "sidebar.confirmDelete": "\u5220\u9664\u6B64\u5BF9\u8BDD\uFF1F",
      "sidebar.confirmPurge": "\u5220\u9664\u6240\u6709\u5BF9\u8BDD\uFF1F\u6B64\u64CD\u4F5C\u65E0\u6CD5\u64A4\u9500\u3002",
      "sidebar.renamePrompt": "\u91CD\u547D\u540D\u4F1A\u8BDD\uFF1A",
      "status.connected": "\u5DF2\u8FDE\u63A5",
      "status.disconnected": "\u672A\u8FDE\u63A5",
    },
  };

  function t(key) {
    return (_dict[_lang] && _dict[_lang][key]) || _dict.en[key] || key;
  }

  function getLang() {
    return _lang;
  }

  function setLang(lang) {
    if (lang !== "en" && lang !== "zh") return;
    _lang = lang;
    localStorage.setItem(STORAGE_KEY, lang);
    _applyToDOM();
    _changeHandlers.forEach(function (fn) { fn(lang); });
  }

  function toggle() {
    setLang(_lang === "en" ? "zh" : "en");
  }

  function onChange(fn) {
    _changeHandlers.push(fn);
  }

  /** Scan DOM for [data-i18n] and update text/placeholder. */
  function _applyToDOM() {
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var key = el.getAttribute("data-i18n");
      var val = t(key);
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        el.placeholder = val;
      } else {
        el.textContent = val;
      }
    });
    // Update lang toggle button text
    var langBtn = document.getElementById("lang-toggle");
    if (langBtn) langBtn.textContent = _lang === "en" ? "EN" : "\u4E2D";
    // Update login page lang toggle button text
    var loginLangBtn = document.getElementById("login-lang-toggle");
    if (loginLangBtn) loginLangBtn.textContent = _lang === "en" ? "EN" : "\u4E2D";
  }

  function init() {
    _applyToDOM();
  }

  return {
    t: t,
    getLang: getLang,
    setLang: setLang,
    toggle: toggle,
    onChange: onChange,
    init: init,
  };
})();
