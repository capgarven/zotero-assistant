var ZoteroAssistantUtil = (function () {
  var NOTE_MARKER = "<!-- zotero-assistant -->";

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, function (char) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[char];
    });
  }

  function textOf(value) {
    if (!value) return "";
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      return value
        .map(function (part) {
          if (typeof part === "string") return part;
          if (part && typeof part.text === "string") return part.text;
          return "";
        })
        .join("");
    }
    return "";
  }

  function normalizeEndpoint(base) {
    var url = String(base || "").trim().replace(/\/+$/, "");
    if (!url) {
      throw new Error("Set an endpoint in Settings → Zassistant → Config.");
    }
    if (!/^https?:\/\//i.test(url)) {
      throw new Error("The endpoint must start with http:// or https://.");
    }
    if (/\/chat\/completions$/i.test(url)) return url;
    return url + "/chat/completions";
  }

  function extractSSEEvents(buffer) {
    var normalized = String(buffer || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    var parts = normalized.split("\n\n");
    var rest = parts.pop();
    var events = [];
    parts.forEach(function (part) {
      var data = part
        .split("\n")
        .filter(function (line) {
          return line.indexOf("data:") === 0;
        })
        .map(function (line) {
          return line.slice(5).replace(/^\s/, "");
        });
      if (data.length) events.push(data.join("\n"));
    });
    return { events: events, rest: rest || "" };
  }

  function readStreamDelta(data) {
    if (data === "[DONE]") {
      return { done: true, content: "", reasoning: "" };
    }
    var json;
    try {
      json = JSON.parse(data);
    } catch (error) {
      return { done: false, content: "", reasoning: "", ignore: true };
    }
    if (json.error) {
      var message = json.error.message || json.error;
      return {
        done: true,
        error: typeof message === "string" ? message : "The service returned an error.",
        content: "",
        reasoning: "",
      };
    }
    var choice = json.choices && json.choices[0];
    if (!choice) return { done: false, content: "", reasoning: "" };
    var delta = choice.delta || {};
    var messageBody = choice.message || {};
    return {
      done: false,
      content: textOf(delta.content) || textOf(messageBody.content) || "",
      reasoning:
        textOf(delta.reasoning_content) ||
        textOf(delta.reasoning) ||
        textOf(messageBody.reasoning_content) ||
        "",
    };
  }

  function truncate(text, max) {
    var value = String(text || "");
    var limit = Math.max(0, Number(max) || 0);
    if (value.length <= limit) return { text: value, truncated: false };
    return { text: value.slice(0, limit), truncated: true };
  }

  function tailText(text, max) {
    var value = String(text || "");
    var limit = Math.max(0, Number(max) || 0);
    if (value.length <= limit) return value;
    return "…(earlier text omitted)\n" + value.slice(value.length - limit);
  }

  function fitContext(input) {
    var maxChars = Math.max(2000, Number(input.maxChars) || 24000);
    var metadata = String(input.metadata || "");
    var selected = truncate(input.selectedText, Math.min(8000, maxChars));
    var annotations = truncate(input.annotations, Math.min(8000, maxChars));
    var notes = truncate(input.notes, Math.min(4000, maxChars));
    var reserved =
      metadata.length + selected.text.length + annotations.text.length + notes.text.length + 800;
    var full = truncate(input.fulltext, Math.max(0, maxChars - reserved));
    return {
      metadata: metadata,
      selectedText: selected.text,
      selectedTruncated: selected.truncated,
      annotations: annotations.text,
      annotationsTruncated: annotations.truncated,
      notes: notes.text,
      notesTruncated: notes.truncated,
      fulltext: full.text,
      fulltextTruncated: full.truncated,
      fulltextTotal: String(input.fulltext || "").length,
      fulltextError: input.fulltextError || "",
      prompt: String(input.prompt || ""),
      markdown: !!input.markdown,
    };
  }

  function buildSystemPrompt(fitted) {
    var lines = [];
    var instruction = String(fitted.prompt || "").trim();
    if (instruction) lines.push(instruction, "");
    else {
      lines.push(
        "You are Zassistant, a reading assistant inside Zotero. Answer only from the material below.",
        "If the material does not support a claim, say you do not know. Do not invent pages, numbers, or conclusions.",
        "Reply in the language of the question. When you quote the paper, say whether it came from the abstract, the selection, an annotation, a note, or the text.",
        "",
      );
    }
    lines.push(
      "## Paper",
      fitted.metadata || "(No bibliographic record.)",
    );
    if (fitted.selectedText) {
      lines.push("", "## Selected text", fitted.selectedText);
    }
    if (fitted.annotations) {
      lines.push("", "## Annotations", fitted.annotations);
    }
    if (fitted.notes) {
      lines.push("", "## Item notes", fitted.notes);
    }
    lines.push("", fitted.markdown ? "## Markdown" : "## Text");
    if (fitted.fulltext) {
      if (fitted.fulltextTruncated) {
        lines.push(
          "The text is long. Only the first " +
            fitted.fulltext.length +
            " characters are included, out of about " +
            fitted.fulltextTotal +
            ".",
        );
      }
      lines.push(fitted.fulltext);
    } else {
      lines.push(fitted.fulltextError || "The paper text is not available. Answer from the material above and say so.");
    }
    return lines.join("\n");
  }

  function buildSummaryPrompt(input) {
    var transcript = tailText(input.transcript, input.maxChars || 24000);
    return {
      system:
        "Turn this round of questions about a paper into a reading note. Use only the record and the conversation. Do not invent anything that is not there. Write Markdown with no title and no preamble. Use three sections: Points, Evidence, and Open questions. Write in the language of the questions.",
      user: "Paper:\n" + (input.metadata || "(No bibliographic record.)") + "\n\nThis round:\n" + transcript,
    };
  }

  function formatNoteTime(date) {
    var pad = function (value) {
      return String(value).padStart(2, "0");
    };
    return (
      date.getFullYear() +
      "-" +
      pad(date.getMonth() + 1) +
      "-" +
      pad(date.getDate()) +
      " " +
      pad(date.getHours()) +
      ":" +
      pad(date.getMinutes())
    );
  }

  function renderNoteFile(input) {
    var prior = String(input.existing || "");
    if (prior.trim() && prior.indexOf(NOTE_MARKER) === -1) {
      return { ok: false, reason: "conflict" };
    }
    var text = prior;
    if (!text.trim()) {
      text = [
        NOTE_MARKER,
        "# Reading note",
        "",
        "- Paper: " + (input.title || "Untitled"),
        "- Attachment: " + (input.attachmentName || "Unknown attachment"),
        "",
      ].join("\n");
    }
    if (!text.endsWith("\n")) text += "\n";
    var questions = (input.questions || [])
      .map(function (question) {
        return "- " + String(question).replace(/\s+/g, " ").trim();
      })
      .filter(function (line) {
        return line !== "- ";
      });
    text += [
      "",
      "## " + (input.time || formatNoteTime(new Date())),
      "",
      "### Questions",
      "",
      questions.length ? questions.join("\n") : "- (No question text was recorded.)",
      "",
      "### Note",
      "",
      String(input.summary || "").trim(),
      "",
    ].join("\n");
    return { ok: true, text: text };
  }

  function isBlockStart(lines, index) {
    var line = lines[index] || "";
    if (!line.trim()) return false;
    if (/^#{1,6}\s+/.test(line)) return true;
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) return true;
    if (/^>\s?/.test(line)) return true;
    if (/^[-*]\s+/.test(line)) return true;
    if (/^\d+\.\s+/.test(line)) return true;
    return isTableStart(lines, index);
  }

  function isTableStart(lines, index) {
    var line = lines[index] || "";
    var next = lines[index + 1] || "";
    return line.indexOf("|") !== -1 && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next);
  }

  function splitRow(line) {
    var trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    return trimmed.split("|").map(function (cell) {
      return cell.trim();
    });
  }

  function inline(source) {
    var text = escapeHTML(source);
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, function (_match, alt, url) {
      return (alt || "image") + " (" + url + ")";
    });
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_match, label, url) {
      var raw = url
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"');
      if (!/^https?:\/\//i.test(raw)) return label;
      var href = escapeHTML(raw);
      return (
        '<a href="' +
        href +
        '" target="_blank" rel="noreferrer noopener">' +
        label +
        "</a>"
      );
    });
    text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    return text;
  }

  function renderProse(text) {
    var lines = String(text || "").split("\n");
    var html = [];
    var index = 0;
    while (index < lines.length) {
      var line = lines[index];
      if (!line.trim()) {
        index += 1;
        continue;
      }
      var heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        var level = heading[1].length;
        html.push("<h" + level + ">" + inline(heading[2]) + "</h" + level + ">");
        index += 1;
        continue;
      }
      if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
        html.push("<hr/>");
        index += 1;
        continue;
      }
      if (isTableStart(lines, index)) {
        var headers = splitRow(line);
        index += 2;
        var rows = [];
        while (index < lines.length && lines[index].indexOf("|") !== -1 && lines[index].trim()) {
          rows.push(splitRow(lines[index]));
          index += 1;
        }
        html.push(
          "<table><thead><tr>" +
            headers
              .map(function (cell) {
                return "<th>" + inline(cell) + "</th>";
              })
              .join("") +
            "</tr></thead><tbody>" +
            rows
              .map(function (row) {
                return (
                  "<tr>" +
                  row
                    .map(function (cell) {
                      return "<td>" + inline(cell) + "</td>";
                    })
                    .join("") +
                  "</tr>"
                );
              })
              .join("") +
            "</tbody></table>",
        );
        continue;
      }
      if (/^>\s?/.test(line)) {
        var quote = [];
        while (index < lines.length && /^>\s?/.test(lines[index])) {
          quote.push(lines[index].replace(/^>\s?/, ""));
          index += 1;
        }
        html.push("<blockquote>" + renderProse(quote.join("\n")) + "</blockquote>");
        continue;
      }
      if (/^[-*]\s+/.test(line)) {
        var unordered = [];
        while (index < lines.length && /^[-*]\s+/.test(lines[index])) {
          unordered.push("<li>" + inline(lines[index].replace(/^[-*]\s+/, "")) + "</li>");
          index += 1;
        }
        html.push("<ul>" + unordered.join("") + "</ul>");
        continue;
      }
      if (/^\d+\.\s+/.test(line)) {
        var ordered = [];
        while (index < lines.length && /^\d+\.\s+/.test(lines[index])) {
          ordered.push("<li>" + inline(lines[index].replace(/^\d+\.\s+/, "")) + "</li>");
          index += 1;
        }
        html.push("<ol>" + ordered.join("") + "</ol>");
        continue;
      }
      var paragraph = [];
      while (index < lines.length && lines[index].trim() && !isBlockStart(lines, index)) {
        paragraph.push(lines[index]);
        index += 1;
      }
      if (!paragraph.length) {
        index += 1;
        continue;
      }
      html.push("<p>" + inline(paragraph.join("\n")).replace(/\n/g, "<br/>") + "</p>");
    }
    return html.join("");
  }

  function renderMarkdown(source, options) {
    var text = String(source || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (options && options.streaming) {
      var fences = text.split("```").length - 1;
      if (fences % 2 === 1) text += "\n```";
    }
    var lines = text.split("\n");
    var blocks = [];
    var prose = [];
    var code = [];
    var inFence = false;
    function flushProse() {
      if (!prose.length) return;
      blocks.push({ type: "prose", text: prose.join("\n") });
      prose = [];
    }
    lines.forEach(function (line) {
      if (!inFence && line.trim().indexOf("```") === 0) {
        flushProse();
        inFence = true;
        code = [];
        return;
      }
      if (inFence && line.trim().indexOf("```") === 0) {
        blocks.push({ type: "code", text: code.join("\n") });
        inFence = false;
        return;
      }
      (inFence ? code : prose).push(line);
    });
    if (inFence) blocks.push({ type: "code", text: code.join("\n") });
    else flushProse();
    return blocks
      .map(function (block) {
        if (block.type === "code") {
          return "<pre><code>" + escapeHTML(block.text) + "</code></pre>";
        }
        return renderProse(block.text);
      })
      .join("");
  }

  function timerHost() {
    if (typeof setTimeout === "function" && typeof clearTimeout === "function") {
      return { set: setTimeout, clear: clearTimeout };
    }
    var win = Zotero.getMainWindow();
    return {
      set: function (fn, ms) {
        return win.setTimeout(fn, ms);
      },
      clear: function (id) {
        win.clearTimeout(id);
      },
    };
  }

  function withTimeout(promise, milliseconds, message) {
    var timers = timerHost();
    return new Promise(function (resolve, reject) {
      var timer = timers.set(function () {
        reject(new Error(message || "Timed out"));
      }, milliseconds);
      Promise.resolve(promise).then(
        function (value) {
          timers.clear(timer);
          resolve(value);
        },
        function (error) {
          timers.clear(timer);
          reject(error);
        },
      );
    });
  }

  var logLines = [];
  var logWriting = null;

  function log(message, error) {
    var line = new Date().toISOString() + " " + String(message || "");
    if (error) line += " | " + String((error && error.message) || error) + (error && error.stack ? "\n" + error.stack : "");
    logLines.push(line);
    if (logLines.length > 300) logLines = logLines.slice(-300);
    try {
      Zotero.debug("Zassistant: " + line);
      if (error) Zotero.logError(error);
      var dir = Zotero.DataDirectory && Zotero.DataDirectory.dir;
      if (!dir) return;
      var file = Zotero.File.pathToFile(dir);
      file.append("zassistant.log");
      var text = logLines.join("\n") + "\n";
      logWriting = Promise.resolve(logWriting).then(function () {
        return Zotero.File.putContentsAsync(file.path, text);
      }).catch(function () {});
    } catch (ignored) {}
  }

  function createController() {
    var listeners = [];
    var signal = {
      aborted: false,
      addEventListener: function (type, listener) {
        if (type === "abort" && typeof listener === "function") listeners.push(listener);
      },
      removeEventListener: function (type, listener) {
        listeners = listeners.filter(function (entry) {
          return entry !== listener;
        });
      },
    };
    return {
      signal: signal,
      abort: function () {
        if (signal.aborted) return;
        signal.aborted = true;
        var pending = listeners;
        listeners = [];
        pending.forEach(function (listener) {
          try {
            listener({ type: "abort" });
          } catch (error) {}
        });
      },
    };
  }

  function isAbortError(error) {
    if (!error) return false;
    return (
      error.name === "AbortError" ||
      /aborted|The operation was aborted|NS_ERROR_ABORT/i.test(String(error.message || error))
    );
  }

  return {
    NOTE_MARKER: NOTE_MARKER,
    escapeHTML: escapeHTML,
    textOf: textOf,
    normalizeEndpoint: normalizeEndpoint,
    extractSSEEvents: extractSSEEvents,
    readStreamDelta: readStreamDelta,
    truncate: truncate,
    tailText: tailText,
    fitContext: fitContext,
    buildSystemPrompt: buildSystemPrompt,
    buildSummaryPrompt: buildSummaryPrompt,
    formatNoteTime: formatNoteTime,
    renderNoteFile: renderNoteFile,
    renderMarkdown: renderMarkdown,
    withTimeout: withTimeout,
    createController: createController,
    log: log,
    isAbortError: isAbortError,
  };
})();
