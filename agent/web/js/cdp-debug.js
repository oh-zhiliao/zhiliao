/**
 * cdp-debug.js — Debug API for Playwright E2E tests.
 *
 * Exposes window.__zhiliao_cdp with:
 *   state()            — snapshot of current session/messages/lang/theme
 *   events             — append-only log of WS messages + user actions
 *   waitForEvent(pred, timeoutMs) — promise that resolves when pred matches an event
 *   reset()            — clears events
 *
 * Injected only when URL has ?debug=1 or ?test_token=<anything>.
 * No-op otherwise to avoid leaking internals in production.
 */
(function () {
  var params = new URLSearchParams(window.location.search);
  if (!params.has("debug") && !params.has("test_token")) return;

  var events = [];
  var listeners = [];

  function push(kind, payload) {
    var evt = { kind: kind, payload: payload, ts: Date.now() };
    events.push(evt);
    if (events.length > 500) events.shift();
    var remaining = [];
    for (var i = 0; i < listeners.length; i++) {
      try {
        if (listeners[i].pred(evt)) {
          listeners[i].resolve(evt);
        } else {
          remaining.push(listeners[i]);
        }
      } catch (e) {
        listeners[i].reject(e);
      }
    }
    listeners = remaining;
  }

  // Wrap WebSocket to observe frames
  var NativeWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    var ws = protocols ? new NativeWS(url, protocols) : new NativeWS(url);
    push("ws_open", { url: url });
    var origSend = ws.send.bind(ws);
    ws.send = function (data) {
      push("ws_send", safeParse(data));
      return origSend(data);
    };
    ws.addEventListener("message", function (ev) {
      push("ws_message", safeParse(ev.data));
    });
    ws.addEventListener("close", function () {
      push("ws_close", { url: url });
    });
    return ws;
  };
  // Preserve static constants
  window.WebSocket.CONNECTING = NativeWS.CONNECTING;
  window.WebSocket.OPEN = NativeWS.OPEN;
  window.WebSocket.CLOSING = NativeWS.CLOSING;
  window.WebSocket.CLOSED = NativeWS.CLOSED;

  function safeParse(data) {
    if (typeof data !== "string") return { raw: String(data) };
    try {
      return JSON.parse(data);
    } catch (e) {
      return { raw: data };
    }
  }

  window.__zhiliao_cdp = {
    state: function () {
      return {
        currentSessionId: window.App && typeof window.App.getCurrentSessionId === "function"
          ? window.App.getCurrentSessionId()
          : null,
        lang: window.I18n ? window.I18n.getLang() : null,
        sessions: window.Store ? window.Store.getSessions() : [],
        messageCount: document.querySelectorAll(".message").length,
        hasToken: !!localStorage.getItem("zhiliao_token"),
      };
    },
    events: events,
    eventKinds: function () {
      return events.map(function (e) { return e.kind; });
    },
    waitForEvent: function (pred, timeoutMs) {
      var timeout = typeof timeoutMs === "number" ? timeoutMs : 5000;
      return new Promise(function (resolve, reject) {
        // Check existing events first
        for (var i = 0; i < events.length; i++) {
          try {
            if (pred(events[i])) { resolve(events[i]); return; }
          } catch (e) { reject(e); return; }
        }
        var entry = { pred: pred, resolve: resolve, reject: reject };
        listeners.push(entry);
        setTimeout(function () {
          var idx = listeners.indexOf(entry);
          if (idx >= 0) {
            listeners.splice(idx, 1);
            reject(new Error("waitForEvent timeout after " + timeout + "ms"));
          }
        }, timeout);
      });
    },
    reset: function () {
      events.length = 0;
      listeners.length = 0;
    },
    recordUserAction: function (kind, payload) {
      push("user_" + kind, payload);
    },
  };
})();
