/**
 * store.js — localStorage wrapper for sessions and messages.
 *
 * Data shapes:
 *   Session: { id, title, createdAt, updatedAt }
 *   Message: { id, sessionId, role, content, tools?, timestamp }
 *     role: "user" | "bot" | "error"
 *     tools: [{ name, status }]  (status: "active" | "done")
 */
var Store = (function () {
  var SESSIONS_KEY = "zhiliao_sessions";
  var MESSAGES_PREFIX = "zhiliao_msgs_";
  var MAX_MESSAGES = 200;

  // ---- Sessions ----

  function getSessions() {
    try {
      return JSON.parse(localStorage.getItem(SESSIONS_KEY)) || [];
    } catch (e) {
      return [];
    }
  }

  function _saveSessions(sessions) {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  }

  function createSession(title) {
    var session = {
      id: _generateId(),
      title: title || "New Chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    var sessions = getSessions();
    sessions.unshift(session);
    _saveSessions(sessions);
    return session;
  }

  function getSession(id) {
    return getSessions().find(function (s) {
      return s.id === id;
    }) || null;
  }

  function updateSession(id, updates) {
    var sessions = getSessions();
    var idx = sessions.findIndex(function (s) {
      return s.id === id;
    });
    if (idx === -1) return null;
    Object.assign(sessions[idx], updates, { updatedAt: Date.now() });
    _saveSessions(sessions);
    return sessions[idx];
  }

  function deleteSession(id) {
    var sessions = getSessions().filter(function (s) {
      return s.id !== id;
    });
    _saveSessions(sessions);
    localStorage.removeItem(MESSAGES_PREFIX + id);

    // Clean up server-side agent session
    var token = Auth.getToken();
    if (token) {
      fetch("/api/sessions/" + id, {
        method: "DELETE",
        headers: { Authorization: "Bearer " + token },
      }).catch(function () {
        // Best-effort cleanup; ignore errors
      });
    }
  }

  function purgeAll() {
    var sessions = getSessions();
    sessions.forEach(function (s) {
      localStorage.removeItem(MESSAGES_PREFIX + s.id);
      // Clean up server-side session
      var token = Auth.getToken();
      if (token) {
        fetch("/api/sessions/" + s.id, {
          method: "DELETE",
          headers: { Authorization: "Bearer " + token },
        }).catch(function () {});
      }
    });
    _saveSessions([]);
  }

  // ---- Messages ----

  function getMessages(sessionId) {
    try {
      return JSON.parse(localStorage.getItem(MESSAGES_PREFIX + sessionId)) || [];
    } catch (e) {
      return [];
    }
  }

  function _saveMessages(sessionId, messages) {
    localStorage.setItem(MESSAGES_PREFIX + sessionId, JSON.stringify(messages));
  }

  function addMessage(sessionId, msg) {
    var messages = getMessages(sessionId);
    if (!msg.id) msg.id = _generateId();
    if (!msg.timestamp) msg.timestamp = Date.now();
    messages.push(msg);
    // Trim old messages to keep under limit
    if (messages.length > MAX_MESSAGES) {
      messages = messages.slice(messages.length - MAX_MESSAGES);
    }
    _saveMessages(sessionId, messages);
    return msg;
  }

  function updateMessage(sessionId, messageId, updates) {
    var messages = getMessages(sessionId);
    var idx = messages.findIndex(function (m) {
      return m.id === messageId;
    });
    if (idx === -1) return null;
    Object.assign(messages[idx], updates);
    _saveMessages(sessionId, messages);
    return messages[idx];
  }

  function getLastMessage(sessionId) {
    var messages = getMessages(sessionId);
    return messages.length > 0 ? messages[messages.length - 1] : null;
  }

  // ---- Utilities ----

  function _generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  return {
    getSessions: getSessions,
    createSession: createSession,
    getSession: getSession,
    updateSession: updateSession,
    deleteSession: deleteSession,
    purgeAll: purgeAll,
    getMessages: getMessages,
    addMessage: addMessage,
    updateMessage: updateMessage,
    getLastMessage: getLastMessage,
  };
})();
