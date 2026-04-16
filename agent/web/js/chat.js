/**
 * chat.js — Chat UI: message rendering, streaming, send/stop.
 */
var Chat = (function () {
  var _currentSessionId = null;
  var _streamingMessageId = null;
  var _streamingContent = "";
  var _streamingTools = [];
  var _isStreaming = false;

  // DOM refs (set in init)
  var $messages = null;
  var $input = null;
  var $sendBtn = null;
  var $stopBtn = null;
  var $chatTitle = null;

  function init() {
    $messages = document.getElementById("messages");
    $input = document.getElementById("message-input");
    $sendBtn = document.getElementById("send-btn");
    $stopBtn = document.getElementById("stop-btn");
    $chatTitle = document.getElementById("chat-title");

    $sendBtn.addEventListener("click", _handleSend);
    $stopBtn.addEventListener("click", _handleStop);

    // Auto-expanding textarea
    $input.addEventListener("input", _autoResize);
    $input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        _handleSend();
      }
    });

    // WS message handlers
    WS.on("text_delta", _onTextDelta);
    WS.on("tool_start", _onToolStart);
    WS.on("tool_end", _onToolEnd);
    WS.on("message_complete", _onMessageComplete);
    WS.on("error", _onError);
  }

  /**
   * Switch to a session: load its messages, update title.
   */
  function loadSession(sessionId) {
    _currentSessionId = sessionId;
    _cancelStreaming();

    var session = Store.getSession(sessionId);
    if (session) {
      $chatTitle.textContent = session.title;
    } else {
      $chatTitle.textContent = "New Chat";
    }

    _renderAllMessages();
    $input.focus();
  }

  function getCurrentSessionId() {
    return _currentSessionId;
  }

  /**
   * Clear messages area (e.g., when no session selected).
   */
  function clearMessages() {
    _currentSessionId = null;
    _cancelStreaming();
    $messages.innerHTML = '<div class="welcome-placeholder">Start a new chat or select one from the sidebar</div>';
    $chatTitle.textContent = "New Chat";
  }

  // ---- Sending ----

  function _handleSend() {
    if (_isStreaming) return;
    var text = $input.value.trim();
    if (!text) return;
    if (!_currentSessionId) return;

    // Clear input
    $input.value = "";
    _autoResize();

    // Auto-title: set session title from first message
    var session = Store.getSession(_currentSessionId);
    if (session && session.title === "New Chat") {
      var title = text.length > 40 ? text.slice(0, 40) + "..." : text;
      Store.updateSession(_currentSessionId, { title: title });
      $chatTitle.textContent = title;
      Sidebar.refresh();
    }

    // Store and render user message
    var userMsg = Store.addMessage(_currentSessionId, {
      role: "user",
      content: text,
      sessionId: _currentSessionId,
    });
    _appendMessageEl(userMsg, true);
    _scrollToBottom();

    // Begin streaming state
    _isStreaming = true;
    _streamingContent = "";
    _streamingTools = [];
    _showStopButton(true);

    // Create placeholder bot message
    var botMsg = Store.addMessage(_currentSessionId, {
      role: "bot",
      content: "",
      tools: [],
      sessionId: _currentSessionId,
    });
    _streamingMessageId = botMsg.id;
    _appendMessageEl(botMsg, true);
    _scrollToBottom();

    // Send via WS
    WS.send({
      type: "message",
      sessionId: _currentSessionId,
      content: text,
    });
  }

  function _handleStop() {
    if (!_currentSessionId || !_isStreaming) return;
    WS.send({
      type: "stop",
      sessionId: _currentSessionId,
    });
    _finishStreaming();
  }

  // ---- WS event handlers ----

  function _onTextDelta(msg) {
    if (msg.sessionId !== _currentSessionId) return;
    if (!_streamingMessageId) return;

    _streamingContent += msg.content;
    _updateStreamingBubble();
    _scrollToBottom();
  }

  function _onToolStart(msg) {
    if (msg.sessionId !== _currentSessionId) return;
    if (!_streamingMessageId) return;

    _streamingTools.push({ name: msg.toolName, status: "active", summary: msg.summary || "" });
    _updateToolChips();
    _scrollToBottom();
  }

  function _onToolEnd(msg) {
    if (msg.sessionId !== _currentSessionId) return;
    if (!_streamingMessageId) return;

    for (var i = _streamingTools.length - 1; i >= 0; i--) {
      if (_streamingTools[i].name === msg.toolName && _streamingTools[i].status === "active") {
        _streamingTools[i].status = "done";
        break;
      }
    }
    _updateToolChips();
  }

  function _onMessageComplete(msg) {
    if (msg.sessionId !== _currentSessionId) return;

    if (_streamingMessageId) {
      // Streaming was active: replace content with final filtered version
      _streamingContent = msg.content;
      _updateStreamingBubble();

      // Save final state
      Store.updateMessage(_currentSessionId, _streamingMessageId, {
        content: msg.content,
        tools: _streamingTools.slice(),
      });

      _finishStreaming();
    } else {
      // Non-streaming response (e.g., command reply): add as new bot message
      var botMsg = Store.addMessage(_currentSessionId, {
        role: "bot",
        content: msg.content,
        sessionId: _currentSessionId,
      });
      _appendMessageEl(botMsg, true);
    }
    _scrollToBottom();
  }

  function _onError(msg) {
    if (msg.sessionId && msg.sessionId !== _currentSessionId) return;

    var errorText = msg.message || "An error occurred";

    if (_streamingMessageId) {
      // Update the streaming message DOM to show error
      var msgEl = $messages.querySelector('[data-message-id="' + _streamingMessageId + '"]');
      if (msgEl) {
        msgEl.className = "message error";
        var bubble = msgEl.querySelector(".message-bubble");
        if (bubble) bubble.textContent = errorText;
      }
      // Persist error state
      Store.updateMessage(_currentSessionId, _streamingMessageId, {
        role: "error",
        content: errorText,
      });
      _finishStreaming();
    } else if (_currentSessionId) {
      // Standalone error, add as a new message
      var errorMsg = Store.addMessage(_currentSessionId, {
        role: "error",
        content: errorText,
        sessionId: _currentSessionId,
      });
      _appendMessageEl(errorMsg, true);
    }
    _scrollToBottom();
  }

  // ---- Rendering ----

  function _renderAllMessages() {
    $messages.innerHTML = "";
    if (!_currentSessionId) {
      $messages.innerHTML = '<div class="welcome-placeholder">Start a new chat or select one from the sidebar</div>';
      return;
    }

    var messages = Store.getMessages(_currentSessionId);
    if (messages.length === 0) {
      $messages.innerHTML = '<div class="welcome-placeholder">Ask about your codebase...</div>';
      return;
    }

    messages.forEach(function (msg) {
      _appendMessageEl(msg, false);
    });
    _scrollToBottom();
  }

  /**
   * @param {object} msg - message data
   * @param {boolean} animate - whether to apply fade-in animation
   */
  function _appendMessageEl(msg, animate) {
    // Remove welcome placeholder if present
    var placeholder = $messages.querySelector(".welcome-placeholder");
    if (placeholder) placeholder.remove();

    var el = document.createElement("div");
    el.className = "message " + msg.role;
    if (animate) {
      el.classList.add("fade-in");
    }
    el.dataset.messageId = msg.id;

    if (msg.role === "bot" || msg.role === "error") {
      // Tool chips container
      if (msg.tools && msg.tools.length > 0) {
        var chipsEl = document.createElement("div");
        chipsEl.className = "tool-chips";
        msg.tools.forEach(function (tool) {
          chipsEl.appendChild(_createToolChip(tool));
        });
        el.appendChild(chipsEl);
      }
    }

    var bubble = document.createElement("div");
    bubble.className = "message-bubble";

    if (msg.role === "user") {
      bubble.textContent = msg.content;
    } else if (msg.role === "bot") {
      if (msg.content) {
        Markdown.renderInto(bubble, msg.content);
        _addCodeBlockLabels(bubble);
      }
    } else if (msg.role === "error") {
      bubble.textContent = msg.content;
    }

    el.appendChild(bubble);
    $messages.appendChild(el);
  }

  /**
   * Detect language in code blocks and add a label bar above them.
   */
  function _addCodeBlockLabels(container) {
    container.querySelectorAll("pre code").forEach(function (codeEl) {
      var lang = _detectCodeLanguage(codeEl);
      if (lang) {
        var pre = codeEl.parentElement;
        if (pre && pre.tagName === "PRE" && !pre.querySelector(".code-lang-label")) {
          var label = document.createElement("span");
          label.className = "code-lang-label";
          label.textContent = lang;
          pre.insertBefore(label, pre.firstChild);
        }
      }
    });
  }

  /**
   * Detect language from hljs class names on a <code> element.
   */
  function _detectCodeLanguage(codeEl) {
    // Check class names like "language-js", "hljs language-javascript", etc.
    var classes = codeEl.className.split(/\s+/);
    for (var i = 0; i < classes.length; i++) {
      var match = classes[i].match(/^language-(.+)$/);
      if (match && match[1] !== "undefined" && match[1] !== "plaintext") {
        return match[1];
      }
    }
    return null;
  }

  function _createToolChip(tool) {
    var chip = document.createElement("span");
    chip.className = "tool-chip " + tool.status;
    chip.dataset.tool = tool.name;

    var icon = document.createElement("span");
    icon.className = "tool-chip-icon";
    icon.textContent = tool.status === "active" ? "\u27F3" : "\u2713";

    var label = document.createElement("span");
    // Show short tool name (remove plugin prefix for display)
    var displayName = tool.name;
    var dotIdx = displayName.indexOf(".");
    if (dotIdx > -1) displayName = displayName.slice(dotIdx + 1);
    label.textContent = displayName;
    if (tool.summary) {
      chip.title = tool.summary;
    }

    chip.appendChild(icon);
    chip.appendChild(label);
    return chip;
  }

  function _updateStreamingBubble() {
    if (!_streamingMessageId) return;
    var msgEl = $messages.querySelector('[data-message-id="' + _streamingMessageId + '"]');
    if (!msgEl) return;

    var bubble = msgEl.querySelector(".message-bubble");
    if (bubble && _streamingContent) {
      Markdown.renderInto(bubble, _streamingContent);
      _addCodeBlockLabels(bubble);
    }
  }

  function _updateToolChips() {
    if (!_streamingMessageId) return;
    var msgEl = $messages.querySelector('[data-message-id="' + _streamingMessageId + '"]');
    if (!msgEl) return;

    var chipsEl = msgEl.querySelector(".tool-chips");
    if (!chipsEl) {
      chipsEl = document.createElement("div");
      chipsEl.className = "tool-chips";
      msgEl.insertBefore(chipsEl, msgEl.firstChild);
    }

    chipsEl.innerHTML = "";
    _streamingTools.forEach(function (tool) {
      chipsEl.appendChild(_createToolChip(tool));
    });
  }

  function _finishStreaming() {
    _isStreaming = false;
    _streamingMessageId = null;
    _streamingContent = "";
    _streamingTools = [];
    _showStopButton(false);
  }

  function _cancelStreaming() {
    if (_isStreaming) {
      _finishStreaming();
    }
  }

  function _showStopButton(show) {
    if (show) {
      $sendBtn.hidden = true;
      $stopBtn.hidden = false;
    } else {
      $sendBtn.hidden = false;
      $stopBtn.hidden = true;
    }
  }

  function _scrollToBottom() {
    requestAnimationFrame(function () {
      $messages.scrollTop = $messages.scrollHeight;
    });
  }

  function _autoResize() {
    $input.style.height = "auto";
    var newHeight = Math.min($input.scrollHeight, 200);
    $input.style.height = newHeight + "px";
  }

  return {
    init: init,
    loadSession: loadSession,
    getCurrentSessionId: getCurrentSessionId,
    clearMessages: clearMessages,
  };
})();
