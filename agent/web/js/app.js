/**
 * app.js — Entry point: routes between login and chat screens, initializes modules.
 */
var App = (function () {
  var $loginScreen = null;
  var $chatScreen = null;
  var $loginForm = null;
  var $passwordInput = null;
  var $loginError = null;
  var _chatInitialized = false;

  function init() {
    $loginScreen = document.getElementById("login-screen");
    $chatScreen = document.getElementById("chat-screen");
    $loginForm = document.getElementById("login-form");
    $passwordInput = document.getElementById("password-input");
    $loginError = document.getElementById("login-error");

    $loginForm.addEventListener("submit", _handleLogin);

    // WS auth expiry handler
    WS.on("auth_expired", function () {
      _showLogin();
    });

    // Route to correct screen
    if (Auth.isAuthenticated()) {
      _showChat();
    } else {
      _showLogin();
    }
  }

  async function _handleLogin(e) {
    e.preventDefault();
    var password = $passwordInput.value;
    if (!password) return;

    $loginError.hidden = true;
    var submitBtn = $loginForm.querySelector("button");
    submitBtn.disabled = true;
    submitBtn.textContent = "Logging in...";

    var result = await Auth.login(password);

    submitBtn.disabled = false;
    submitBtn.textContent = "Login";

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
