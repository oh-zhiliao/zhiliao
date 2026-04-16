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
      if (e.key === "Enter") {
        // Don't send during IME composition
        if (e.isComposing || e.keyCode === 229) return;
        // Ctrl+Enter / Alt+Enter → explicitly insert newline (browsers don't do it by default)
        if (e.ctrlKey || e.altKey) {
          e.preventDefault();
          var start = $input.selectionStart;
          var end = $input.selectionEnd;
          $input.value = $input.value.substring(0, start) + "\n" + $input.value.substring(end);
          $input.selectionStart = $input.selectionEnd = start + 1;
          _autoResize();
          return;
        }
        // Shift+Enter → default textarea behavior (newline)
        if (e.shiftKey || e.metaKey) return;
        // Plain Enter → send
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

    // WS disconnect during streaming → clean up stop button
    WS.on("close", _onWsClose);

    // Re-render welcome placeholder on language change
    I18n.onChange(function () {
      if (_currentSessionId && Store.getMessages(_currentSessionId).length === 0) {
        _renderWelcome();
      }
    });
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
      $chatTitle.textContent = I18n.t("chat.newChat");
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
    _renderWelcome();
    $chatTitle.textContent = I18n.t("chat.defaultTitle");
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

    // Finalize the streaming bubble with stopped indicator
    if (_streamingMessageId) {
      _finalizeStreamingBubble(_streamingContent || I18n.t("chat.manualStop"), true);
      Store.updateMessage(_currentSessionId, _streamingMessageId, {
        content: _streamingContent || I18n.t("chat.manualStop"),
        tools: _streamingTools.slice(),
      });
    }
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

      // Finalize the bubble — render content, remove streaming cursor
      _finalizeStreamingBubble(_streamingContent, false);

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

  function _onWsClose() {
    if (!_isStreaming) return;
    // WS died mid-stream — server can't send message_complete/error anymore.
    if (_streamingMessageId) {
      _finalizeStreamingBubble(_streamingContent || I18n.t("chat.connectionLost"), !_streamingContent);
      Store.updateMessage(_currentSessionId, _streamingMessageId, {
        content: _streamingContent || I18n.t("chat.connectionLost"),
        tools: _streamingTools.slice(),
      });
    }
    _finishStreaming();
  }

  function _onError(msg) {
    // Ignore stale errors after streaming already ended (e.g. abort errors arriving late)
    if (!_isStreaming) return;

    if (msg.sessionId && msg.sessionId !== _currentSessionId) return;

    var errorText = msg.message || "An error occurred";

    if (_streamingMessageId) {
      var msgEl = $messages.querySelector('[data-message-id="' + _streamingMessageId + '"]');
      if (msgEl) {
        msgEl.className = "message error";
        var bubble = msgEl.querySelector(".message-bubble");
        if (bubble) bubble.textContent = errorText;
      }
      Store.updateMessage(_currentSessionId, _streamingMessageId, {
        role: "error",
        content: errorText,
      });
      _finishStreaming();
    } else if (_currentSessionId) {
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
      _renderWelcome();
      return;
    }

    var messages = Store.getMessages(_currentSessionId);
    if (messages.length === 0) {
      _renderWelcome();
      return;
    }

    messages.forEach(function (msg) {
      _appendMessageEl(msg, false);
    });
    _scrollToBottom();
  }

  function _renderWelcome() {
    $messages.innerHTML = "";
    var wrap = document.createElement("div");
    wrap.className = "welcome-placeholder";
    var title = document.createElement("div");
    title.className = "welcome-title";
    title.textContent = I18n.t("chat.welcome");
    var hint = document.createElement("div");
    hint.className = "welcome-hint";
    hint.textContent = I18n.t("chat.welcomeHint");
    wrap.appendChild(title);
    wrap.appendChild(hint);
    $messages.appendChild(wrap);
  }

  /**
   * @param {object} msg - message data
   * @param {boolean} animate - whether to apply entrance animation
   */
  function _appendMessageEl(msg, animate) {
    // Remove welcome placeholder if present
    var placeholder = $messages.querySelector(".welcome-placeholder");
    if (placeholder) placeholder.remove();

    var el = document.createElement("div");
    el.className = "message " + msg.role;
    if (!animate) el.style.animation = "none";
    el.dataset.messageId = msg.id;

    if (msg.role === "bot" || msg.role === "error") {
      if (msg.tools && msg.tools.length > 0) {
        var chipsEl = document.createElement("div");
        chipsEl.className = "tool-chips";
        _renderToolChipsInto(chipsEl, msg.tools);
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
      } else {
        // Loading indicator until first token arrives
        var dots = document.createElement("div");
        dots.className = "loading-dots";
        dots.innerHTML = "<span></span><span></span><span></span>";
        bubble.appendChild(dots);
      }
    } else if (msg.role === "error") {
      bubble.textContent = msg.content;
    }

    el.appendChild(bubble);
    $messages.appendChild(el);
  }

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

  function _detectCodeLanguage(codeEl) {
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
    label.textContent = tool.name;
    if (tool.summary) {
      chip.title = tool.summary;
    }

    chip.appendChild(icon);
    chip.appendChild(label);
    return chip;
  }

  /**
   * Update streaming bubble: render content + append streaming cursor.
   */
  function _updateStreamingBubble() {
    if (!_streamingMessageId) return;
    var msgEl = $messages.querySelector('[data-message-id="' + _streamingMessageId + '"]');
    if (!msgEl) return;

    var bubble = msgEl.querySelector(".message-bubble");
    if (!bubble || !_streamingContent) return;

    Markdown.renderInto(bubble, _streamingContent);
    _addCodeBlockLabels(bubble);
    _appendStreamingCursor(bubble);
  }

  /**
   * Append animated streaming cursor to bubble (removes any existing one first).
   */
  function _appendStreamingCursor(bubble) {
    // Remove existing cursor
    var existing = bubble.querySelector(".streaming-cursor");
    if (existing) existing.remove();

    var cursor = document.createElement("div");
    cursor.className = "streaming-cursor";
    cursor.innerHTML = "<span></span><span></span><span></span>";
    bubble.appendChild(cursor);
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

    _renderToolChipsInto(chipsEl, _streamingTools);
  }

  /** Render tool chips into container, collapsing older ones if > MAX_VISIBLE. */
  var MAX_VISIBLE_TOOLS = 5;

  function _renderToolChipsInto(container, tools) {
    container.innerHTML = "";
    if (tools.length <= MAX_VISIBLE_TOOLS) {
      tools.forEach(function (tool) { container.appendChild(_createToolChip(tool)); });
      return;
    }
    // Collapsed indicator for older tools
    var collapsed = tools.length - MAX_VISIBLE_TOOLS;
    var toggle = document.createElement("button");
    toggle.className = "tool-chip-toggle";
    toggle.textContent = "+" + collapsed + I18n.t("tools.collapsed");
    toggle.addEventListener("click", function () {
      // Expand: re-render all chips without collapse
      container.innerHTML = "";
      tools.forEach(function (tool) { container.appendChild(_createToolChip(tool)); });
    });
    container.appendChild(toggle);
    // Show only the latest MAX_VISIBLE_TOOLS
    for (var i = tools.length - MAX_VISIBLE_TOOLS; i < tools.length; i++) {
      container.appendChild(_createToolChip(tools[i]));
    }
  }

  /**
   * Finalize a streaming bubble: render final content, remove cursor,
   * optionally add a stopped notice.
   */
  function _finalizeStreamingBubble(content, showStopped) {
    if (!_streamingMessageId) return;
    var msgEl = $messages.querySelector('[data-message-id="' + _streamingMessageId + '"]');
    if (!msgEl) return;

    var bubble = msgEl.querySelector(".message-bubble");
    if (!bubble) return;

    // Remove streaming cursor
    var cursor = bubble.querySelector(".streaming-cursor");
    if (cursor) cursor.remove();

    if (content) {
      Markdown.renderInto(bubble, content);
      _addCodeBlockLabels(bubble);

      // Add stopped notice if needed (after the content)
      if (showStopped) {
        var notice = document.createElement("span");
        notice.className = "stopped-notice";
        notice.textContent = I18n.t("chat.manualStop");
        bubble.appendChild(notice);
      }
    } else {
      bubble.textContent = I18n.t("chat.manualStop");
      bubble.classList.add("stopped");
    }
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
    $stopBtn.hidden = !show;
    $sendBtn.disabled = show;
  }

  function _scrollToBottom() {
    requestAnimationFrame(function () {
      $messages.scrollTop = $messages.scrollHeight;
    });
  }

  /** Adaptive height: grow textarea up to max, then allow scroll (hidden scrollbar). */
  function _autoResize() {
    $input.style.height = "auto";
    var maxH = 160;
    if ($input.scrollHeight > maxH) {
      $input.style.height = maxH + "px";
      $input.style.overflowY = "auto";
    } else {
      $input.style.height = $input.scrollHeight + "px";
      $input.style.overflowY = "hidden";
    }
  }

  return {
    init: init,
    loadSession: loadSession,
    getCurrentSessionId: getCurrentSessionId,
    clearMessages: clearMessages,
  };
})();
