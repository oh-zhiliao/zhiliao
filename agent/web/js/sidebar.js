/**
 * sidebar.js — Session list management: grouped by date, new/rename/delete/purge.
 */
var Sidebar = (function () {
  var $sessionList = null;
  var $newChatBtn = null;
  var $purgeBtn = null;
  var $logoutBtn = null;
  var $sidebarToggle = null;
  var $sidebar = null;
  var _sidebarOverlay = null;

  function init() {
    $sessionList = document.getElementById("session-list");
    $newChatBtn = document.getElementById("new-chat-btn");
    $purgeBtn = document.getElementById("purge-btn");
    $logoutBtn = document.getElementById("logout-btn");
    $sidebarToggle = document.getElementById("sidebar-toggle");
    $sidebar = document.getElementById("sidebar");

    // Create overlay for mobile
    _sidebarOverlay = document.createElement("div");
    _sidebarOverlay.id = "sidebar-overlay";
    document.getElementById("chat-screen").appendChild(_sidebarOverlay);

    $newChatBtn.addEventListener("click", _newChat);
    $purgeBtn.addEventListener("click", _purgeAll);
    $logoutBtn.addEventListener("click", function () {
      App.logout();
    });
    $sidebarToggle.addEventListener("click", _toggleSidebar);
    _sidebarOverlay.addEventListener("click", _closeSidebar);

    refresh();
  }

  /**
   * Re-render the session list from store.
   */
  function refresh() {
    var sessions = Store.getSessions();
    var currentId = Chat.getCurrentSessionId();
    $sessionList.innerHTML = "";

    if (sessions.length === 0) {
      var empty = document.createElement("div");
      empty.className = "welcome-placeholder";
      empty.style.padding = "24px 12px";
      empty.style.fontSize = "0.85rem";
      empty.textContent = "No conversations yet";
      $sessionList.appendChild(empty);
      return;
    }

    // Group by date
    var groups = _groupByDate(sessions);
    groups.forEach(function (group) {
      var label = document.createElement("div");
      label.className = "session-group-label";
      label.textContent = group.label;
      $sessionList.appendChild(label);

      group.sessions.forEach(function (session) {
        var item = _createSessionItem(session, session.id === currentId);
        $sessionList.appendChild(item);
      });
    });
  }

  function selectSession(sessionId) {
    Chat.loadSession(sessionId);
    refresh();
    _closeSidebar();
  }

  // ---- Internals ----

  function _newChat() {
    var session = Store.createSession("New Chat");
    Chat.loadSession(session.id);
    refresh();
    _closeSidebar();
  }

  function _purgeAll() {
    if (!confirm("Delete all conversations? This cannot be undone.")) return;
    Store.purgeAll();
    Chat.clearMessages();
    refresh();
  }

  function _createSessionItem(session, isActive) {
    var item = document.createElement("div");
    item.className = "session-item" + (isActive ? " active" : "");
    item.dataset.sessionId = session.id;

    var title = document.createElement("span");
    title.className = "session-item-title";
    title.textContent = session.title;
    item.appendChild(title);

    var actions = document.createElement("div");
    actions.className = "session-item-actions";

    var renameBtn = document.createElement("button");
    renameBtn.textContent = "\u270E"; // pencil
    renameBtn.title = "Rename";
    renameBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      _renameSession(session.id);
    });

    var deleteBtn = document.createElement("button");
    deleteBtn.className = "btn-delete";
    deleteBtn.textContent = "\u2715"; // x
    deleteBtn.title = "Delete";
    deleteBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      _deleteSession(session.id);
    });

    actions.appendChild(renameBtn);
    actions.appendChild(deleteBtn);
    item.appendChild(actions);

    item.addEventListener("click", function () {
      selectSession(session.id);
    });

    return item;
  }

  function _renameSession(id) {
    var session = Store.getSession(id);
    if (!session) return;
    var newTitle = prompt("Rename session:", session.title);
    if (newTitle !== null && newTitle.trim()) {
      Store.updateSession(id, { title: newTitle.trim() });
      if (Chat.getCurrentSessionId() === id) {
        document.getElementById("chat-title").textContent = newTitle.trim();
      }
      refresh();
    }
  }

  function _deleteSession(id) {
    if (!confirm("Delete this conversation?")) return;
    var wasCurrent = Chat.getCurrentSessionId() === id;
    Store.deleteSession(id);

    if (wasCurrent) {
      // Switch to most recent session or clear
      var sessions = Store.getSessions();
      if (sessions.length > 0) {
        Chat.loadSession(sessions[0].id);
      } else {
        Chat.clearMessages();
      }
    }
    refresh();
  }

  function _groupByDate(sessions) {
    var now = new Date();
    var todayStr = _dateStr(now);
    var yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    var yesterdayStr = _dateStr(yesterday);

    var groups = {};
    var order = [];

    sessions.forEach(function (session) {
      var d = new Date(session.updatedAt || session.createdAt);
      var key = _dateStr(d);
      var label;

      if (key === todayStr) {
        label = "Today";
      } else if (key === yesterdayStr) {
        label = "Yesterday";
      } else {
        label = key;
      }

      if (!groups[key]) {
        groups[key] = { label: label, sessions: [] };
        order.push(key);
      }
      groups[key].sessions.push(session);
    });

    return order.map(function (key) {
      return groups[key];
    });
  }

  function _dateStr(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function _toggleSidebar() {
    $sidebar.classList.toggle("open");
  }

  function _closeSidebar() {
    $sidebar.classList.remove("open");
  }

  return {
    init: init,
    refresh: refresh,
    selectSession: selectSession,
  };
})();
