var ZoteroAssistantPane = (function () {
  var sessions = new Map();
  var mounts = new WeakMap();
  var views = new Set();
  var STYLE_ID = "zotero-assistant-stylesheet";
  var HTML_NS = "http://www.w3.org/1999/xhtml";

  function ensureStyle(doc) {
    if (!doc || doc.getElementById(STYLE_ID)) return;
    var link = doc.createElementNS(HTML_NS, "link");
    link.id = STYLE_ID;
    link.rel = "stylesheet";
    link.type = "text/css";
    link.href = "chrome://zoteroassistant/content/pane.css";
    (doc.head || doc.documentElement).appendChild(link);
  }

  function sessionFor(key) {
    var id = key || "none";
    if (!sessions.has(id)) {
      sessions.set(id, {
        messages: [],
        summarizedCount: 0,
        draft: "",
        busy: false,
        controller: null,
        pending: null,
        paintAt: 0,
      });
    }
    return sessions.get(id);
  }

  function repaintSession(session) {
    views.forEach(function (view) {
      if (sessionFor(view.itemKey) === session) view.repaint();
    });
  }

  function el(doc, tag, className, text) {
    var node = doc.createElementNS(HTML_NS, tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function setMarkdown(node, source, streaming) {
    try {
      node.innerHTML = ZoteroAssistantUtil.renderMarkdown(source, { streaming: !!streaming });
    } catch (error) {
      node.textContent = String(source || "");
    }
  }

  function roundMessages(session) {
    return session.messages.slice(session.summarizedCount).filter(function (message) {
      return message.role === "user" || (message.role === "assistant" && message.content && !message.error);
    });
  }

  function mount(props) {
    var previous = mounts.get(props.body);
    var itemID = props.item ? props.item.id : null;
    if (
      previous &&
      previous.itemID === itemID &&
      previous.tabType === props.tabType &&
      previous.root.isConnected &&
      previous.root.parentNode === props.body
    ) {
      previous.repaint();
      return previous;
    }
    if (previous) previous.dispose();
    ensureStyle(props.doc);
    var view = createView(props);
    mounts.set(props.body, view);
    view.refresh();
    return view;
  }

  function createView(props) {
    var doc = props.doc;
    var win = doc.defaultView;
    var inspected = ZoteroAssistantContext.inspectItem(props.item, props.tabType);
    var session = sessionFor(inspected.itemKey);
    var root = el(doc, "div", "za-root");
    var localStyle = el(doc, "style");
    localStyle.textContent = "@import url('chrome://zoteroassistant/content/pane.css');";
    root.appendChild(localStyle);
    props.body.replaceChildren(root);

    var header = el(doc, "div", "za-bar");
    var title = el(doc, "div", "za-title", "Zassistant");
    var actions = el(doc, "div", "za-actions");
    var refreshButton = el(doc, "button", "za-btn", "Refresh");
    refreshButton.type = "button";
    actions.append(refreshButton);
    header.append(title, actions);

    var detail = el(doc, "div", "za-detail");
    var chips = el(doc, "div", "za-chips");
    var status = el(doc, "div", "za-status");

    var tabs = el(doc, "div", "za-tabs");
    var chatTab = el(doc, "button", "za-tab is-active", "Ask");
    var notesTab = el(doc, "button", "za-tab", "Notes");
    chatTab.type = "button";
    notesTab.type = "button";
    tabs.append(chatTab, notesTab);

    var chat = el(doc, "section", "za-chat");
    var banner = el(doc, "div", "za-banner");
    banner.hidden = true;
    var dialog = el(doc, "div", "za-dialog");
    var transcript = el(doc, "div", "za-transcript");
    var compose = el(doc, "div", "za-compose");
    var input = el(doc, "textarea", "za-input");
    input.rows = 3;
    input.placeholder = "Ask about the paper you are reading";
    input.value = session.draft || "";
    var composeRow = el(doc, "div", "za-compose-row");
    var summarizeButton = el(doc, "button", "za-btn", "Summarize");
    var sendButton = el(doc, "button", "za-btn za-btn-primary", "Send");
    summarizeButton.type = "button";
    sendButton.type = "button";
    summarizeButton.title = "Summarize this round and save a Markdown note next to the PDF";
    composeRow.append(summarizeButton, sendButton);
    compose.append(input, composeRow);
    dialog.append(transcript, compose);
    chat.append(banner, dialog);

    var notes = el(doc, "section", "za-notes");
    notes.hidden = true;
    var notesIntro = el(doc, "div", "za-notes-intro");
    var noteList = el(doc, "div", "za-note-list");
    var noteButtons = el(doc, "div", "za-compose-row");
    var openButton = el(doc, "button", "za-btn", "Open Markdown");
    var revealButton = el(doc, "button", "za-btn", "Show in folder");
    openButton.type = "button";
    revealButton.type = "button";
    noteButtons.append(openButton, revealButton);
    var reader = el(doc, "div", "za-reader");
    reader.hidden = true;
    var readerBar = el(doc, "div", "za-reader-bar");
    var backButton = el(doc, "button", "za-btn", "All notes");
    var readerTitle = el(doc, "div", "za-reader-title");
    var sourceButton = el(doc, "button", "za-btn", "Source");
    backButton.type = "button";
    sourceButton.type = "button";
    readerBar.append(backButton, readerTitle, sourceButton);
    var readerBody = el(doc, "div", "za-reader-body za-md");
    reader.append(readerBar, readerBody);
    notes.append(notesIntro, noteList, noteButtons, reader);

    root.append(header, detail, chips, status, tabs, chat, notes);

    var view = {
      token: 0,
      root: root,
      openedExistingNote: false,
      tabType: props.tabType,
      itemID: props.item ? props.item.id : null,
      itemKey: inspected.itemKey,
      context: null,
      location: null,
      files: [],
      reading: null,
      showSource: false,
      dispose: dispose,
      refresh: refresh,
      repaint: repaint,
    };
    views.add(view);

    function repaint() {
      var current = sessionFor(view.itemKey);
      sendButton.textContent = current.busy ? "Stop" : "Send";
      summarizeButton.disabled = current.busy;
      paintMessages();
    }

    function currentItem() {
      return view.itemID ? Zotero.Items.get(view.itemID) : null;
    }

    function setStatus(text, isError) {
      status.textContent = text || "";
      status.classList.toggle("is-error", !!isError);
    }

    function paintChips(ctx) {
      chips.replaceChildren();
      if (!ctx) return;
      var values = [];
      if (ctx.mode === "reader") values.push("Reader");
      else if (ctx.mode === "selection") values.push("Selected item");
      if (ctx.selectedChars) values.push("Selection " + ctx.selectedChars);
      if (ctx.annotationCount) values.push("Annotations " + ctx.annotationCount);
      if (ctx.noteCount) values.push("Notes " + ctx.noteCount);
      if (!ctx.fulltextIncluded) values.push("Text off");
      else if (ctx.fulltextChars) {
        values.push((ctx.fulltextTruncated ? "Text clipped " : "Text ") + ctx.fulltextChars);
      } else values.push("No text");
      values.forEach(function (value) {
        chips.appendChild(el(doc, "span", "za-chip", value));
      });
    }

    function revealDialog() {
      var section = root.closest && root.closest("collapsible-section");
      if (section) {
        section.style.setProperty("--open-height", "auto");
        if (!section.open) section.open = true;
      }
      transcript.scrollTop = transcript.scrollHeight;
    }

    function paintMessages() {
      var current = sessionFor(view.itemKey);
      transcript.replaceChildren();
      if (!current.messages.length) {
        var empty = el(doc, "div", "za-empty");
        empty.appendChild(el(doc, "p", "", "Replies appear in this dialog. A text selection is included with the question."));
        ["What problem does this paper address?", "Summarize the method and the main result.", "How strong is the evidence, and what are the limits?"].forEach(
          function (prompt) {
            var button = el(doc, "button", "za-suggestion", prompt);
            button.type = "button";
            button.addEventListener("click", function () {
              input.value = prompt;
              send();
            });
            empty.appendChild(button);
          },
        );
        transcript.appendChild(empty);
        revealDialog();
        return;
      }
      current.messages.forEach(function (message) {
        if (message.role === "divider") {
          transcript.appendChild(el(doc, "div", "za-divider", message.content));
          return;
        }
        var bubble = el(doc, "article", "za-msg za-msg-" + message.role);
        var head = el(doc, "div", "za-msg-head");
        head.appendChild(el(doc, "div", "za-msg-label", message.role === "user" ? "You" : "Zassistant"));
        bubble.appendChild(head);
        if (message.role === "assistant") {
          var same = message.content && message.reasoning && message.content === message.reasoning;
          if (message.reasoning && !same) {
            bubble.appendChild(el(doc, "div", "za-reasoning", message.reasoning));
          }
          var waiting = current.busy && current.pending === message;
          var copyText = message.content || message.reasoning;
          if (copyText && !waiting) {
            var copy = el(doc, "button", "za-copy", "Copy");
            copy.type = "button";
            copy.title = "Copy this reply as Markdown";
            copy.addEventListener("click", function () {
              Zotero.Utilities.Internal.copyTextToClipboard(copyText);
              copy.textContent = "Copied";
              doc.defaultView.setTimeout(function () {
                copy.textContent = "Copy";
              }, 1500);
            });
            head.appendChild(copy);
          }
          var body = el(doc, "div", "za-md");
          if (message.content) {
            setMarkdown(body, message.content, waiting);
          } else if (waiting) {
            body.textContent = message.reasoning ? "Still thinking…" : "Thinking…";
          } else if (message.reasoning) {
            setMarkdown(body, message.reasoning, false);
          } else body.textContent = "(No reply.)";
          bubble.appendChild(body);
        } else {
          bubble.appendChild(el(doc, "div", "za-msg-text", message.content));
        }
        transcript.appendChild(bubble);
      });
      revealDialog();
    }

    function paintNotes() {
      noteList.replaceChildren();
      if (!view.location || !view.location.ok) {
        notesIntro.textContent = view.location ? view.location.message : "No attachment file yet.";
        return;
      }
      notesIntro.textContent = "Notes are saved next to the attachment: " + view.location.directory;
      if (!view.files.length) {
        noteList.appendChild(el(doc, "p", "za-empty-line", "This folder has no Markdown files."));
        return;
      }
      view.files.forEach(function (file) {
        var row = el(doc, "div", "za-note-row");
        var name = el(doc, "button", "za-note-name", file.name);
        name.type = "button";
        name.addEventListener("click", function () {
          openPath(file.path);
        });
        row.append(name, el(doc, "span", "za-note-size", formatSize(file.size)));
        noteList.appendChild(row);
      });
    }

    function paintBanner() {
      var primary = view.files.find(function (file) {
        return file.primary;
      });
      banner.replaceChildren();
      if (!primary) {
        banner.hidden = true;
        return;
      }
      banner.hidden = false;
      banner.appendChild(el(doc, "span", "", "This paper already has " + primary.name));
      var open = el(doc, "button", "za-btn", "Open");
      open.type = "button";
      open.addEventListener("click", function () {
        openPath(primary.path);
      });
      banner.appendChild(open);
    }

    function showTab(name) {
      var notesMode = name === "notes";
      chat.hidden = notesMode;
      notes.hidden = !notesMode;
      chatTab.classList.toggle("is-active", !notesMode);
      notesTab.classList.toggle("is-active", notesMode);
      if (!notesMode) {
        reader.hidden = true;
        noteList.hidden = false;
        noteButtons.hidden = false;
        notesIntro.hidden = false;
      }
    }

    function showReader(file, text) {
      view.reading = { path: file.path || file, name: file.name, text: text };
      readerTitle.textContent = file.name;
      reader.hidden = false;
      noteList.hidden = true;
      noteButtons.hidden = true;
      notesIntro.hidden = true;
      showTab("notes");
      paintReader();
      readerBody.scrollTop = readerBody.scrollHeight;
    }

    function paintReader() {
      if (!view.reading) return;
      sourceButton.textContent = view.showSource ? "Reading" : "Source";
      if (view.showSource) {
        readerBody.textContent = view.reading.text;
        readerBody.classList.add("is-source");
      } else {
        readerBody.classList.remove("is-source");
        setMarkdown(readerBody, view.reading.text, false);
      }
    }

    async function openPath(path) {
      try {
        var file = await ZoteroAssistantNotes.readMarkdown(path);
        view.showSource = false;
        showReader(file, file.text);
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
    }

    function refresh(force) {
      if (!force && view.context) {
        repaint();
        return Promise.resolve();
      }
      if (!force && view.loading) return view.loading;
      var loading = load();
      view.loading = loading;
      loading.finally(function () {
        if (view.loading === loading) view.loading = null;
      });
      return loading;
    }

    async function load() {
      var token = ++view.token;
      if (!sessionFor(view.itemKey).busy) setStatus("Converting the PDF to Markdown…");
      try {
        var ctx = await ZoteroAssistantContext.build(currentItem(), view.tabType, {
          prefs: Zotero.ZoteroAssistant.getPrefs(),
        });
        if (token !== view.token) return;
        view.context = ctx;
        view.itemKey = ctx.itemKey || view.itemKey;
        session = sessionFor(view.itemKey);
        input.value = session.draft || input.value;
        title.textContent = ctx.title || "Zassistant";
        detail.textContent = ctx.attachmentName
          ? "Notes are saved next to " + ctx.attachmentName + "."
          : "No attachment is available for a saved note.";
        paintChips(ctx);
        input.placeholder = ctx.selectedChars ? "Ask about the selected text" : "Ask about the paper you are reading";
        if (ctx.attachment) {
          view.location = await ZoteroAssistantNotes.locate(ctx.attachment);
          if (token !== view.token) return;
          view.files = view.location.ok ? ZoteroAssistantNotes.listMarkdown(view.location.directory) : [];
        } else {
          view.location = { ok: false, message: "This item has no local attachment." };
          view.files = [];
        }
        paintNotes();
        paintBanner();
        repaint();
        var primary = view.files.find(function (file) {
          return file.primary;
        });
        if (!view.openedExistingNote && !session.messages.length && primary && token === view.token) {
          view.openedExistingNote = true;
          await openPath(primary.path);
        }
        if (token !== view.token) return;
        if (sessionFor(view.itemKey).busy) return;
        var saved = Zotero.ZoteroAssistant.getPrefs();
        if (!saved.apiBase || !saved.model) setStatus("Set the API in Settings → Zassistant.");
        else if (!saved.apiKey && saved.service !== "ollama") setStatus("Add the API secret in Settings → Zassistant.");
        else setStatus("");
      } catch (error) {
        if (token !== view.token) return;
        setStatus(error.message || String(error), true);
      }
    }

    function beginRequest(target, pending) {
      if (target.controller) target.controller.abort();
      target.controller = ZoteroAssistantUtil.createController();
      target.busy = true;
      target.pending = pending || null;
      repaintSession(target);
      return target.controller;
    }

    function endRequest(target) {
      target.busy = false;
      target.controller = null;
      target.pending = null;
      repaintSession(target);
    }

    function historyFor(target) {
      var turns = [];
      var list = target.messages;
      for (var i = 0; i + 1 < list.length; i += 1) {
        var user = list[i];
        var reply = list[i + 1];
        if (user.role !== "user" || reply.role !== "assistant") continue;
        if (reply.error || !reply.content || reply === target.pending) continue;
        turns.push({ role: "user", content: user.content }, { role: "assistant", content: reply.content });
      }
      return turns.slice(-16);
    }

    async function send() {
      var target = sessionFor(view.itemKey);
      if (target.busy) {
        if (target.controller) target.controller.abort();
        return;
      }
      var question = input.value.trim();
      if (!question) return;
      session = target;
      target.draft = "";
      input.value = "";
      var history = historyFor(target);
      target.messages.push({ role: "user", content: question });
      var assistant = { role: "assistant", content: "", reasoning: "" };
      target.messages.push(assistant);
      ZoteroAssistantUtil.log("send: " + question.length + " chars, history " + history.length);
      try {
        var controller = beginRequest(target, assistant);
        setStatus("Thinking… The answer appears after the model finishes thinking.");
        if (!view.context && view.loading) {
          try {
            await view.loading;
          } catch (error) {}
        }
        if (!view.context) {
          view.context = await ZoteroAssistantContext.build(currentItem(), view.tabType, {
            prefs: Zotero.ZoteroAssistant.getPrefs(),
          });
        }
        var chatPrefs = Zotero.ZoteroAssistant.getPrefs();
        ZoteroAssistantUtil.log(
          "request: " + chatPrefs.service + " " + chatPrefs.model + " " + chatPrefs.apiBase +
            ", key " + (chatPrefs.apiKey ? "set" : "missing") +
            ", system " + view.context.systemPrompt.length + " chars",
        );
        var result = await ZoteroAssistantAI.complete({
          prefs: chatPrefs,
          signal: controller.signal,
          messages: [{ role: "system", content: view.context.systemPrompt }]
            .concat(history)
            .concat([{ role: "user", content: question }]),
          onDelta: function (delta) {
            if (delta.content) assistant.content += delta.content;
            if (delta.reasoning) assistant.reasoning += delta.reasoning;
            var now = Date.now();
            if (now - target.paintAt > 180) {
              target.paintAt = now;
              repaintSession(target);
            }
          },
        });
        if (result) {
          if (result.content) assistant.content = result.content;
          if (result.reasoning) assistant.reasoning = result.reasoning;
        }
        ZoteroAssistantUtil.log(
          "reply: content " + assistant.content.length + ", reasoning " + assistant.reasoning.length,
        );
        if (!assistant.content && assistant.reasoning) assistant.content = assistant.reasoning;
        if (!assistant.content) {
          assistant.content = "The service returned no reply.";
          assistant.error = true;
        }
      } catch (error) {
        ZoteroAssistantUtil.log("send failed", error);
        if (!ZoteroAssistantUtil.isAbortError(error)) {
          if (!assistant.content) {
            assistant.content = error.message || String(error);
            assistant.error = true;
          }
        } else if (!assistant.content && !assistant.reasoning) {
          assistant.content = "Stopped.";
          assistant.error = true;
        }
      } finally {
        setStatus("");
        try {
          endRequest(target);
        } catch (error) {
          ZoteroAssistantUtil.log("paint failed", error);
          setStatus(error.message || String(error), true);
        }
      }
    }

    async function summarize() {
      session = sessionFor(view.itemKey);
      if (session.busy) return;
      var round = roundMessages(session);
      var questions = round
        .filter(function (message) {
          return message.role === "user";
        })
        .map(function (message) {
          return message.content;
        });
      if (!questions.length) {
        setStatus("This round has no new question yet.", true);
        return;
      }
      if (!view.context || !view.context.attachment) {
        setStatus("No attachment was found, so the note cannot be saved.", true);
        return;
      }
      var location = view.location && view.location.ok ? view.location : null;
      if (!location) {
        location = await ZoteroAssistantNotes.locate(view.context.attachment);
        view.location = location;
      }
      if (!location.ok) {
        setStatus(location.message, true);
        return;
      }
      var transcriptText = round
        .map(function (message) {
          return (message.role === "user" ? "User: " : "Assistant: ") + message.content;
        })
        .join("\n\n");
      var prompt = ZoteroAssistantUtil.buildSummaryPrompt({
        metadata: view.context.metadata,
        transcript: transcriptText,
        maxChars: Zotero.ZoteroAssistant.getPrefs().maxContextChars,
      });
      var summary = "";
      showTab("notes");
      reader.hidden = false;
      noteList.hidden = true;
      noteButtons.hidden = true;
      notesIntro.hidden = true;
      readerTitle.textContent = "Summarizing this round…";
      readerBody.classList.remove("is-source");
      readerBody.textContent = "";
      var target = session;
      var controller = beginRequest(target, null);
      try {
        var result = await ZoteroAssistantAI.complete({
          prefs: Zotero.ZoteroAssistant.getPrefs(),
          signal: controller.signal,
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
          onDelta: function (delta) {
            summary += delta.content || "";
            setMarkdown(readerBody, summary, true);
            readerBody.scrollTop = readerBody.scrollHeight;
          },
        });
        if (result && result.content && result.content.length >= summary.length) summary = result.content;
        if (!summary.trim() && result && result.reasoning) summary = result.reasoning;
        if (!summary.trim()) throw new Error("The model returned an empty note.");
        var saved = await ZoteroAssistantNotes.writeRound(location, {
          title: view.context.title,
          time: ZoteroAssistantUtil.formatNoteTime(new Date()),
          questions: questions,
          summary: summary,
        });
        session.messages.push({ role: "divider", content: "Saved " + saved.name });
        session.summarizedCount = session.messages.length;
        view.files = ZoteroAssistantNotes.listMarkdown(location.directory);
        paintNotes();
        paintBanner();
        view.showSource = false;
        showReader(saved, saved.text);
        setStatus("Saved to " + saved.name);
      } catch (error) {
        if (ZoteroAssistantUtil.isAbortError(error)) {
          setStatus("Stopped. The note was not saved.");
          showTab("chat");
        } else {
          setStatus(error.message || String(error), true);
        }
      } finally {
        endRequest(target);
      }
    }

    function dispose() {
      view.token += 1;
      views.delete(view);
      sessionFor(view.itemKey).draft = input.value;
    }

    refreshButton.addEventListener("click", function () {
      ZoteroAssistantContext.clearCache();
      view.context = null;
      refresh(true);
    });
    chatTab.addEventListener("click", function () {
      showTab("chat");
    });
    notesTab.addEventListener("click", function () {
      showTab("notes");
      reader.hidden = true;
      noteList.hidden = false;
      noteButtons.hidden = false;
      notesIntro.hidden = false;
    });
    input.addEventListener("input", function () {
      sessionFor(view.itemKey).draft = input.value;
    });
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        send();
      }
    });
    sendButton.addEventListener("click", send);
    summarizeButton.addEventListener("click", summarize);
    openButton.addEventListener("click", async function () {
      try {
        var path = await ZoteroAssistantNotes.chooseMarkdown(
          win,
          view.location && view.location.directory,
        );
        if (path) await openPath(path);
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
    });
    revealButton.addEventListener("click", function () {
      if (!view.location || !view.location.ok) {
        setStatus("There is no attachment folder to open.", true);
        return;
      }
      if (!ZoteroAssistantNotes.reveal(view.location.directory)) {
        setStatus(view.location.directory, true);
      }
    });
    backButton.addEventListener("click", function () {
      reader.hidden = true;
      noteList.hidden = false;
      noteButtons.hidden = false;
      notesIntro.hidden = false;
    });
    sourceButton.addEventListener("click", function () {
      view.showSource = !view.showSource;
      paintReader();
    });

    repaint();
    return view;
  }

  function formatSize(size) {
    if (size < 1024) return size + " B";
    if (size < 1024 * 1024) return Math.ceil(size / 1024) + " KB";
    return (size / 1024 / 1024).toFixed(1) + " MB";
  }

  function destroy(body) {
    var view = mounts.get(body);
    if (!view) return;
    view.dispose();
    mounts.delete(body);
  }

  function refresh(body) {
    var view = mounts.get(body);
    if (view) return view.refresh();
    return null;
  }

  return {
    ensureStyle: ensureStyle,
    mount: mount,
    destroy: destroy,
    refresh: refresh,
  };
})();
