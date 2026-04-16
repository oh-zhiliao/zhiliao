/**
 * ws.js — WebSocket connection with auto-reconnect and message dispatch.
 */
var WS = (function () {
  var _socket = null;
  var _handlers = {};
  var _reconnectTimer = null;
  var _reconnectDelay = 3000;
  var _intentionallyClosed = false;

  /**
   * Connect to the WebSocket server.
   */
  function connect() {
    if (_socket && (_socket.readyState === WebSocket.OPEN || _socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    var token = Auth.getToken();
    if (!token) return;

    _intentionallyClosed = false;
    var protocol = location.protocol === "https:" ? "wss:" : "ws:";
    var url = protocol + "//" + location.host + "/ws?token=" + encodeURIComponent(token);

    try {
      _socket = new WebSocket(url);
    } catch (e) {
      console.error("[WS] Failed to create WebSocket:", e);
      _scheduleReconnect();
      return;
    }

    _socket.onopen = function () {
      console.log("[WS] Connected");
      _dispatch("open", null);
    };

    _socket.onmessage = function (event) {
      try {
        var msg = JSON.parse(event.data);
        _dispatch(msg.type, msg);
      } catch (e) {
        console.error("[WS] Failed to parse message:", e);
      }
    };

    _socket.onclose = function (event) {
      console.log("[WS] Closed:", event.code, event.reason);
      _socket = null;
      _dispatch("close", { code: event.code, reason: event.reason });

      // 4001 = unauthorized (token expired)
      if (event.code === 4001) {
        Auth.logout();
        _dispatch("auth_expired", null);
        return;
      }

      if (!_intentionallyClosed) {
        _scheduleReconnect();
      }
    };

    _socket.onerror = function (event) {
      console.error("[WS] Error:", event);
    };
  }

  /**
   * Disconnect and do not reconnect.
   */
  function disconnect() {
    _intentionallyClosed = true;
    if (_reconnectTimer) {
      clearTimeout(_reconnectTimer);
      _reconnectTimer = null;
    }
    if (_socket) {
      _socket.close();
      _socket = null;
    }
  }

  /**
   * Send a JSON message through the WebSocket.
   */
  function send(msg) {
    if (_socket && _socket.readyState === WebSocket.OPEN) {
      _socket.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  /**
   * Register a handler for a message type.
   * type can be: "open", "close", "auth_expired",
   *   "text_delta", "tool_start", "tool_end", "message_complete", "error", "history"
   */
  function on(type, handler) {
    if (!_handlers[type]) _handlers[type] = [];
    _handlers[type].push(handler);
  }

  /**
   * Remove a handler.
   */
  function off(type, handler) {
    if (!_handlers[type]) return;
    _handlers[type] = _handlers[type].filter(function (h) {
      return h !== handler;
    });
  }

  function _dispatch(type, data) {
    var handlers = _handlers[type];
    if (handlers) {
      handlers.forEach(function (h) {
        try {
          h(data);
        } catch (e) {
          console.error("[WS] Handler error for " + type + ":", e);
        }
      });
    }
  }

  function _scheduleReconnect() {
    if (_reconnectTimer) return;
    console.log("[WS] Reconnecting in " + (_reconnectDelay / 1000) + "s...");
    _reconnectTimer = setTimeout(function () {
      _reconnectTimer = null;
      connect();
    }, _reconnectDelay);
  }

  function isConnected() {
    return _socket && _socket.readyState === WebSocket.OPEN;
  }

  return {
    connect: connect,
    disconnect: disconnect,
    send: send,
    on: on,
    off: off,
    isConnected: isConnected,
  };
})();
