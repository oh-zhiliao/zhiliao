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
      return marked.parse(text);
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

  return {
    render: render,
    renderInto: renderInto,
  };
})();
