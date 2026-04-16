/**
 * app.js — Entry point: routes between login and chat screens, initializes modules.
 */
var App = (function () {
  var $loginScreen = null;
  var $chatScreen = null;
  var $loginForm = null;
  var $passwordInput = null;
  var $loginError = null;
  var $connectionStatus = null;
  var _chatInitialized = false;

  function init() {
    $loginScreen = document.getElementById("login-screen");
    $chatScreen = document.getElementById("chat-screen");
    $loginForm = document.getElementById("login-form");
    $passwordInput = document.getElementById("password-input");
    $loginError = document.getElementById("login-error");
    $connectionStatus = document.getElementById("connection-status");

    // Initialize theme and i18n
    Theme.init();
    I18n.init();

    // Wire up settings dropdown
    _initSettingsDropdown();

    // Wire up login page language toggle
    var loginLangBtn = document.getElementById("login-lang-toggle");
    if (loginLangBtn) loginLangBtn.addEventListener("click", I18n.toggle);

    // Wire up mobile new-chat button
    var mobileNewChat = document.getElementById("mobile-new-chat");
    if (mobileNewChat) {
      mobileNewChat.addEventListener("click", function () {
        var session = Store.createSession("New Chat");
        Chat.loadSession(session.id);
        Sidebar.refresh();
      });
    }

    $loginForm.addEventListener("submit", _handleLogin);

    // WS auth expiry handler
    WS.on("auth_expired", function () {
      _showLogin();
    });

    // WS connection status handlers
    WS.on("open", function () {
      _updateConnectionStatus(true);
    });

    WS.on("close", function () {
      _updateConnectionStatus(false);
    });

    // Route to correct screen
    if (Auth.isAuthenticated()) {
      _showChat();
    } else {
      _showLogin();
    }
  }

  function _initSettingsDropdown() {
    var $settingsToggle = document.getElementById("settings-toggle");
    var $settingsDropdown = document.getElementById("settings-dropdown");
    var $langToggle = document.getElementById("lang-toggle");
    var $themeToggle = document.getElementById("theme-toggle");
    var $logoutBtn = document.getElementById("logout-btn");

    if ($settingsToggle && $settingsDropdown) {
      $settingsToggle.addEventListener("click", function (e) {
        e.stopPropagation();
        $settingsDropdown.classList.toggle("open");
      });

      // Close dropdown on outside click
      document.addEventListener("click", function (e) {
        if (!$settingsDropdown.contains(e.target) && e.target !== $settingsToggle) {
          $settingsDropdown.classList.remove("open");
        }
      });
    }

    if ($langToggle) $langToggle.addEventListener("click", I18n.toggle);
    if ($themeToggle) $themeToggle.addEventListener("click", Theme.toggle);
    if ($logoutBtn) $logoutBtn.addEventListener("click", function () { App.logout(); });
  }

  function _updateConnectionStatus(connected) {
    if (!$connectionStatus) return;
    if (connected) {
      $connectionStatus.className = "status-dot connected";
      $connectionStatus.title = I18n.t("status.connected");
    } else {
      $connectionStatus.className = "status-dot disconnected";
      $connectionStatus.title = I18n.t("status.disconnected");
    }
  }

  async function _handleLogin(e) {
    e.preventDefault();
    var password = $passwordInput.value;
    if (!password) return;

    $loginError.hidden = true;
    var submitBtn = $loginForm.querySelector("button");
    submitBtn.disabled = true;
    submitBtn.textContent = I18n.t("login.submitting");

    var result = await Auth.login(password);

    submitBtn.disabled = false;
    submitBtn.textContent = I18n.t("login.submit");

    if (result.ok) {
      $passwordInput.value = "";
      _showChat();
    } else {
      $loginError.textContent = result.error;
      $loginError.hidden = false;
    }
  }

  function _showLogin() {
    WS.disconnect();
    _updateConnectionStatus(false);
    $chatScreen.hidden = true;
    $loginScreen.hidden = false;
    $passwordInput.focus();
  }

  function _showChat() {
    $loginScreen.hidden = true;
    $chatScreen.hidden = false;

    // Initialize UI modules (only once)
    if (!_chatInitialized) {
      Chat.init();
      Sidebar.init();
      _chatInitialized = true;
    } else {
      Sidebar.refresh();
    }

    // Connect WebSocket
    WS.connect();

    // Load most recent session or start fresh
    var sessions = Store.getSessions();
    if (sessions.length > 0) {
      Chat.loadSession(sessions[0].id);
    } else {
      // Create a fresh session
      var session = Store.createSession("New Chat");
      Chat.loadSession(session.id);
      Sidebar.refresh();
    }
  }

  function logout() {
    Auth.logout();
    Chat.clearMessages();
    _showLogin();
  }

  // Init on DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  return {
    logout: logout,
  };
})();
