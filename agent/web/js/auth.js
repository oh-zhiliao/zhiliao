/**
 * auth.js — JWT authentication: login, token storage, expiry check
 */
var Auth = (function () {
  var TOKEN_KEY = "zhiliao_token";

  /**
   * POST /api/auth/login with password, store JWT on success.
   * Returns { ok: true } or { ok: false, error: string }.
   */
  async function login(password) {
    try {
      var resp = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: password }),
      });
      if (!resp.ok) {
        var data = await resp.json().catch(function () {
          return {};
        });
        return { ok: false, error: data.error || "Login failed (" + resp.status + ")" };
      }
      var result = await resp.json();
      localStorage.setItem(TOKEN_KEY, result.token);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: "Network error: " + err.message };
    }
  }

  /**
   * Get stored token, or null if missing/expired.
   */
  function getToken() {
    var token = localStorage.getItem(TOKEN_KEY);
    if (!token) return null;
    if (_isExpired(token)) {
      localStorage.removeItem(TOKEN_KEY);
      return null;
    }
    return token;
  }

  /**
   * Remove stored token (logout).
   */
  function logout() {
    localStorage.removeItem(TOKEN_KEY);
  }

  /**
   * Check if user is authenticated (has non-expired token).
   */
  function isAuthenticated() {
    return getToken() !== null;
  }

  /**
   * Decode JWT payload and check exp claim.
   */
  function _isExpired(token) {
    try {
      var parts = token.split(".");
      if (parts.length !== 3) return true;
      // JWT uses base64url encoding — convert to standard base64 for atob()
      var b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      var payload = JSON.parse(atob(b64));
      if (!payload.exp) return false;
      // exp is in seconds, Date.now() is milliseconds
      return Date.now() >= payload.exp * 1000;
    } catch (e) {
      return true;
    }
  }

  /**
   * Redirect to Feishu OAuth authorize endpoint.
   */
  function feishuLogin() {
    window.location.href = "/api/auth/feishu/authorize";
  }

  /**
   * Check if Feishu auth is available and show/hide the button.
   */
  async function checkFeishuEnabled() {
    try {
      var resp = await fetch("/api/auth/feishu/config");
      var data = await resp.json();
      var section = document.getElementById("feishu-auth-section");
      if (section) {
        section.hidden = !data.enabled;
      }
    } catch (e) {
      // keep hidden on error
    }
  }

  return {
    login: login,
    getToken: getToken,
    logout: logout,
    isAuthenticated: isAuthenticated,
    feishuLogin: feishuLogin,
    checkFeishuEnabled: checkFeishuEnabled,
  };
})();
