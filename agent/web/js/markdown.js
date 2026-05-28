/**
 * markdown.js — Markdown rendering wrapper using marked + highlight.js
 */
var Markdown = (function () {
  // Configure marked
  marked.setOptions({
    highlight: function (code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(code, { language: lang }).value;
        } catch (e) {
          // fall through
        }
      }
      // Auto-detect for unlabeled code blocks
      try {
        return hljs.highlightAuto(code).value;
      } catch (e) {
        return code;
      }
    },
    breaks: true,
    gfm: true,
  });

  /**
   * Render markdown string to sanitized HTML.
   */
  function render(text) {
    if (!text) return "";
    try {
      return _sanitizeHtml(marked.parse(text));
    } catch (e) {
      // Fallback: escape HTML and wrap in <p>
      return "<p>" + _escapeHtml(text) + "</p>";
    }
  }

  /**
   * Render markdown into a DOM element, then apply highlight.js to any
   * code blocks that were not already highlighted by marked.
   */
  function renderInto(element, text) {
    element.innerHTML = render(text);
    // Highlight any code blocks that need it
    element.querySelectorAll("pre code").forEach(function (block) {
      if (!block.classList.contains("hljs")) {
        hljs.highlightElement(block);
      }
    });
  }

  function _escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function _sanitizeHtml(html) {
    if (typeof document === "undefined") return html;

    var template = document.createElement("template");
    template.innerHTML = html;

    var blockedTags = {
      SCRIPT: true,
      STYLE: true,
      IFRAME: true,
      OBJECT: true,
      EMBED: true,
      LINK: true,
      META: true,
      BASE: true,
      FORM: true,
      INPUT: true,
      BUTTON: true,
      SVG: true,
      MATH: true,
    };
    var uriAttrs = {
      href: true,
      src: true,
      "xlink:href": true,
      action: true,
      formaction: true,
    };
    var nodes = template.content.querySelectorAll("*");
    nodes.forEach(function (node) {
      var tagName = node.tagName.toUpperCase();
      if (blockedTags[tagName] || node.namespaceURI !== "http://www.w3.org/1999/xhtml") {
        node.remove();
        return;
      }

      Array.prototype.slice.call(node.attributes).forEach(function (attr) {
        var name = attr.name.toLowerCase();
        var value = attr.value || "";
        if (name.indexOf("on") === 0 || name === "srcdoc" || name === "style") {
          node.removeAttribute(attr.name);
          return;
        }
        var normalizedValue = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
        if (uriAttrs[name] && /^\s*(?:javascript|data|vbscript):/i.test(normalizedValue)) {
          node.removeAttribute(attr.name);
        }
      });
    });

    return template.innerHTML;
  }

  return {
    render: render,
    renderInto: renderInto,
  };
})();
