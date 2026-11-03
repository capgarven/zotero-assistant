var ZoteroAssistantPane = (function () {
  var sessions = new Map();
  var mounts = new WeakMap();
  var views = new Set();
  var STYLE_ID = "zotero-assistant-stylesheet";
  var HTML_NS = "http://www.w3.org/1999/xhtml";
  var scope = { type: "paper", id: null };

  var ICONS = {
    plus: '<path d="M8 3v10M3 8h10"/>',
    refresh: '<path d="M13 8a5 5 0 1 1-1.46-3.54"/><path d="M13 2.5v3h-3"/>',
    notes: '<path d="M4 1.5h5.5l2.5 2.5v10.5h-8z"/><path d="M6 7.5h4M6 10h4"/>',
    file: '<path d="M4 1.5h5l3 3v10h-8z"/><path d="M9 1.5v3h3"/>',
    folder: '<path d="M1.5 4v8.5h13V5.5H8L6.5 4z"/>',
    send: '<path d="M8 13V3.5M4 7.5l4-4 4 4"/>',
    stop: '<rect x="4.5" y="4.5" width="7" height="7" rx="1.2" fill="currentColor" stroke="none"/>',
    back: '<path d="M10 3 5 8l5 5"/>',
    save: '<path d="M3 2.5h8l2 2v9H3z"/><path d="M5.5 2.5v3h4v-3M5 13.5v-4h6v4"/>',
    layers: '<path d="M8 2 1.5 5.5 8 9l6.5-3.5z"/><path d="M1.5 9 8 12.5 14.5 9"/>',
  };

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
      if (sessionFor(view.sessionKey()) === session) view.repaint();
    });
  }

  function el(doc, tag, className, text) {
    var node = doc.createElementNS(HTML_NS, tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(doc, name) {
    var span = el(doc, "span", "za-icon");
    span.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' +
      ICONS[name] +
      "</svg>";
    return span;
  }

  function iconButton(doc, name, title, className) {
    var button = el(doc, "button", "za-icon-btn" + (className ? " " + className : ""));
    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.appendChild(icon(doc, name));
    return button;
  }

  function copyButton(doc, getText) {
    var button = el(doc, "button", "za-ghost", "Copy");
    button.type = "button";
    button.title = "Copy as Markdown";
    button.addEventListener("click", function () {
      Zotero.Utilities.Internal.copyTextToClipboard(getText());
      button.textContent = "Copied";
      doc.defaultView.setTimeout(function () {
        button.textContent = "Copy";
      }, 1500);
    });
    return button;
  }

  function renderMath(tex, display) {
    var katex = typeof ZoteroAssistantKatex !== "undefined" ? ZoteroAssistantKatex : null;
    if (!katex) return "";
    return katex
      .renderToString(tex, { output: "mathml", displayMode: display, throwOnError: false, strict: "ignore" })
      .replace(/&nbsp;/g, "&#160;");
  }

  function setMarkdown(node, source, streaming) {
    try {
      node.innerHTML = ZoteroAssistantUtil.renderMarkdown(source, { streaming: !!streaming, math: renderMath });
    } catch (error) {
      ZoteroAssistantUtil.log("markdown render failed, retrying without math", error);
      try {
        node.innerHTML = ZoteroAssistantUtil.renderMarkdown(source, { streaming: !!streaming });
        return;
      } catch (ignored) {}
      node.textContent = String(source || "");
      return;
    }
    if (streaming) return;
    var doc = node.ownerDocument;
    Array.prototype.forEach.call(node.querySelectorAll("pre"), function (pre) {
      var wrap = el(doc, "div", "za-code");
      var bar = el(doc, "div", "za-code-bar");
      bar.appendChild(
        copyButton(doc, function () {
          return pre.textContent;
        }),
      );
      pre.parentNode.insertBefore(wrap, pre);
      wrap.append(bar, pre);
    });
  }

  function seconds(ms) {
    var value = Math.max(1, Math.round((Number(ms) || 0) / 1000));
    return value < 60 ? value + "s" : Math.floor(value / 60) + "m " + (value % 60) + "s";
  }

  function roundMessages(session) {
    return session.messages.slice(session.summarizedCount).filter(function (message) {
      return message.role === "user" || (message.role === "assistant" && message.content && !message.error);
    });
  }

  function effectiveSource(prefs) {
    return prefs.effectiveSource || "markdown";
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
    var root = el(doc, "div", "za-root");
    var localStyle = el(doc, "style");
    localStyle.textContent = "@import url('chrome://zoteroassistant/content/pane.css');";
    root.appendChild(localStyle);
    props.body.replaceChildren(root);

    var header = el(doc, "div", "za-header");
    var heading = el(doc, "div", "za-heading");
    var headingLabel = el(doc, "span", "za-heading-label", "Chat");
    var headingTitle = el(doc, "span", "za-heading-title");
    heading.append(headingLabel, headingTitle);
    var headerActions = el(doc, "div", "za-header-actions");
    var newButton = iconButton(doc, "plus", "New chat");
    var notesButton = iconButton(doc, "notes", "Notes");
    var refreshButton = iconButton(doc, "refresh", "Reload the paper or collection");
    headerActions.append(newButton, notesButton, refreshButton);
    header.append(heading, headerActions);

    var banner = el(doc, "div", "za-banner");
    banner.hidden = true;

    var chat = el(doc, "section", "za-chat");
    var transcript = el(doc, "div", "za-transcript");

    var composer = el(doc, "div", "za-composer");
    var pills = el(doc, "div", "za-pills");
    var input = el(doc, "textarea", "za-input");
    input.rows = 2;
    var bar = el(doc, "div", "za-composer-bar");
    var scopeSelect = el(doc, "select", "za-select za-select-scope");
    scopeSelect.title = "What the AI reads: this paper, or every paper in a collection";
    var sourceSelect = el(doc, "select", "za-select");
    sourceSelect.title = "Send the paper as Markdown text, or as the original PDF file";
    var modelSelect = el(doc, "select", "za-select za-select-model");
    modelSelect.title = "Model";
    var spacer = el(doc, "span", "za-spacer");
    var saveButton = iconButton(doc, "save", "Summarize this round into a Markdown note");
    var sendButton = iconButton(doc, "send", "Send (Enter)", "za-send");
    bar.append(scopeSelect, sourceSelect, modelSelect, spacer, saveButton, sendButton);
    composer.append(pills, input, bar);
    var status = el(doc, "div", "za-status");
    chat.append(transcript, composer, status);

    var notes = el(doc, "section", "za-notes");
    notes.hidden = true;
    var notesIntro = el(doc, "div", "za-notes-intro");
    var noteList = el(doc, "div", "za-note-list");
    var noteButtons = el(doc, "div", "za-row");
    var openButton = el(doc, "button", "za-btn", "Open Markdown…");
    var revealButton = el(doc, "button", "za-btn", "Show in folder");
    openButton.type = "button";
    revealButton.type = "button";
    noteButtons.append(openButton, revealButton);
    var reader = el(doc, "div", "za-reader");
    reader.hidden = true;
    var readerBar = el(doc, "div", "za-row za-reader-bar");
    var backButton = iconButton(doc, "back", "All notes");
    var readerTitle = el(doc, "div", "za-reader-title");
    var sourceButton = el(doc, "button", "za-btn", "Source");
    sourceButton.type = "button";
    readerBar.append(backButton, readerTitle, sourceButton);
    var readerBody = el(doc, "div", "za-reader-body za-md");
    reader.append(readerBar, readerBody);
    notes.append(notesIntro, noteList, noteButtons, reader);

    root.append(header, banner, chat, notes);

    var view = {
      token: 0,
      root: root,
      openedExistingNote: false,
      tabType: props.tabType,
      itemID: props.item ? props.item.id : null,
      itemKey: inspected.itemKey,
      context: null,
      contextKey: "",
      loadError: null,
      location: null,
      files: [],
      reading: null,
      showSource: false,
      painted: { session: null, count: -1, last: null },
      shownSession: null,
      sessionKey: sessionKey,
      dispose: dispose,
      refresh: refresh,
      repaint: repaint,
      sync: sync,
    };
    views.add(view);

    function prefs() {
      return Zotero.ZoteroAssistant.getChatPrefs();
    }

    function sessionKey() {
      return scope.type === "collection" ? "collection:" + scope.id : view.itemKey;
    }

    function session() {
      return sessionFor(sessionKey());
    }

    function contextKey() {
      var current = prefs();
      var key = sessionKey() + "|" + effectiveSource(current);
      if (scope.type === "collection") key += current.deepCollections ? "|deep" : "|flat";
      return key;
    }

    function currentItem() {
      return view.itemID ? Zotero.Items.get(view.itemID) : null;
    }

    function setStatus(text, isError) {
      status.textContent = text || "";
      status.classList.toggle("is-error", !!isError);
    }

    function option(value, label) {
      var node = el(doc, "option", "", label);
      node.value = value;
      return node;
    }

    function fillScope() {
      var wanted = scope.type === "collection" ? "collection:" + scope.id : "paper";
      scopeSelect.replaceChildren(option("paper", "@ This paper"));
      var found = wanted === "paper";
      try {
        ZoteroAssistantContext.listCollections().forEach(function (group) {
          var list = el(doc, "optgroup");
          list.label = group.name;
          group.collections.forEach(function (collection) {
            var value = "collection:" + collection.id;
            if (value === wanted) found = true;
            list.appendChild(option(value, "\u00a0\u00a0".repeat(collection.depth) + "@ " + collection.name));
          });
          scopeSelect.appendChild(list);
        });
      } catch (error) {
        ZoteroAssistantUtil.log("fill collections failed", error);
      }
      if (!found) scope = { type: "paper", id: null };
      scopeSelect.value = found ? wanted : "paper";
    }

    function fillSource(current) {
      sourceSelect.replaceChildren(
        option("markdown", "Markdown"),
        option("pdf", current.anyPdf ? "PDF" : "PDF (no saved model reads PDFs)"),
      );
      sourceSelect.value = current.source;
    }

    function fillModels(current) {
      modelSelect.replaceChildren();
      Zotero.ZoteroAssistant.getProfiles().forEach(function (profile) {
        var label = profile.name + (profile.pdf ? " · PDF" : "") + (profile.hasKey ? "" : " (no key)");
        var node = option(profile.id, label);
        node.title = profile.providerLabel + " · " + profile.model;
        modelSelect.appendChild(node);
      });
      modelSelect.value = current.profileId;
    }

    function fillControls() {
      var current = prefs();
      fillScope();
      fillSource(current);
      fillModels(current);
    }

    function pill(text, options) {
      var node = el(doc, options && options.button ? "button" : "span", "za-pill" + (options && options.className ? " " + options.className : ""));
      if (options && options.button) node.type = "button";
      if (options && options.icon) node.appendChild(icon(doc, options.icon));
      node.appendChild(el(doc, "span", "za-pill-text", text));
      if (options && options.title) node.title = options.title;
      pills.appendChild(node);
      return node;
    }

    function paintPills() {
      pills.replaceChildren();
      var current = prefs();
      var ctx = view.context && view.contextKey === contextKey() ? view.context : null;
      if (scope.type === "collection") {
        var name = ctx ? ctx.title : (scopeSelect.selectedOptions[0] || {}).textContent || "Collection";
        var count = ctx ? ctx.paperCount : ZoteroAssistantContext.collectionCount(scope.id, current.deepCollections);
        pill(String(name).replace(/^[\s\u00a0]*@ /, "") + " · " + count + " papers", { icon: "folder", className: "is-scope" });
        var deep = pill("Subcollections", {
          button: true,
          icon: "layers",
          className: current.deepCollections ? "is-on" : "",
          title: current.deepCollections ? "Papers in subcollections are included" : "Only papers directly in this collection are included",
        });
        deep.setAttribute("aria-pressed", current.deepCollections ? "true" : "false");
        deep.addEventListener("click", function () {
          Zotero.ZoteroAssistant.setDeepCollections(!prefs().deepCollections);
          sync();
        });
      } else {
        pill(ctx ? ctx.title : "This paper", { icon: "file", className: "is-scope" });
        if (ctx && ctx.selectedChars) pill("Selection · " + ZoteroAssistantUtil.formatCount(ctx.selectedChars) + " chars");
        if (ctx && ctx.annotationCount) pill(ctx.annotationCount + " annotations");
      }
      if (!ctx) return;
      if (ctx.source === "pdf") {
        var pdfLabel = ctx.files.length === 1 ? "PDF" : ctx.files.length + " PDFs";
        var bytes = ctx.files.reduce(function (sum, file) {
          return sum + (file.size || 0);
        }, 0);
        pill(pdfLabel + " · " + ZoteroAssistantUtil.formatBytes(bytes));
        if (bytes > 50 * 1024 * 1024) pill("Over 50 MB of PDFs, the service may refuse it", { className: "is-warn" });
      } else {
        pill("Markdown · ≈" + ZoteroAssistantUtil.formatCount(ZoteroAssistantUtil.estimateTokens(ctx.systemPrompt.length)) + " tokens");
      }
      if (current.switchedFrom && current.effectiveSource === "pdf") {
        pill("PDF reader: " + current.serviceLabel, {
          title: current.switchedFrom + " reads text only, so " + current.serviceLabel + " answers when the source is PDF.",
        });
      }
      if (current.source === "pdf" && current.effectiveSource !== "pdf") {
        pill("No saved model reads PDFs, so Markdown is sent. Add one in Settings.", { className: "is-warn" });
      }
      if (scope.type === "collection" && ctx.missingCount) {
        pill(ctx.missingCount + " without full text", { className: "is-warn", title: "These items have no readable PDF. Their records and abstracts are sent." });
      }
      if (ctx.fulltextMissing) pill("No full text", { className: "is-warn" });
      if (ctx.fulltextTruncated) pill("Text clipped", { className: "is-warn" });
      if (ZoteroAssistantUtil.estimateTokens(ctx.systemPrompt.length) > 250000) {
        pill("Large context, it may exceed the model's limit", { className: "is-warn" });
      }
    }

    function paintHeader() {
      var ctx = view.context;
      headingLabel.textContent = scope.type === "collection" ? "Collection" : "Paper";
      headingTitle.textContent = ctx && view.contextKey === contextKey() ? ctx.title : "";
      headingTitle.title = headingTitle.textContent;
      if (scope.type === "collection") {
        input.placeholder = "Ask across every paper in this collection";
      } else {
        input.placeholder = ctx && ctx.selectedChars ? "Ask about the selected text" : "Ask about this paper";
      }
    }

    function repaint() {
      var current = session();
      sendButton.replaceChildren(icon(doc, current.busy ? "stop" : "send"));
      sendButton.title = current.busy ? "Stop (Esc)" : "Send (Enter)";
      sendButton.classList.toggle("is-busy", current.busy);
      saveButton.disabled = current.busy;
      newButton.disabled = current.busy;
      if (view.shownSession !== current) {
        view.shownSession = current;
        input.value = current.draft || "";
        autosize();
      }
      paintMessages();
    }

    function revealDialog() {
      var section = root.closest && root.closest("collapsible-section");
      if (section) {
        section.style.setProperty("--open-height", "auto");
        if (!section.open) section.open = true;
      }
    }

    function emptyState() {
      var empty = el(doc, "div", "za-empty");
      var collection = scope.type === "collection";
      empty.appendChild(
        el(doc, "div", "za-empty-title", collection ? "Ask across this collection" : "Ask about this paper"),
      );
      empty.appendChild(
        el(
          doc,
          "div",
          "za-empty-hint",
          collection
            ? "Every paper in the collection is sent with your question."
            : "The whole paper is sent with your question. A text selection in the reader is included too.",
        ),
      );
      var prompts = collection
        ? ["Summarize each paper in one line.", "Compare the methods and the main results.", "Where do these papers agree, and where do they disagree?"]
        : ["What problem does this paper address?", "Summarize the method and the main result.", "How strong is the evidence, and what are the limits?"];
      prompts.forEach(function (prompt) {
        var button = el(doc, "button", "za-suggestion", prompt);
        button.type = "button";
        button.addEventListener("click", function () {
          input.value = prompt;
          send();
        });
        empty.appendChild(button);
      });
      return empty;
    }

    function renderMessage(current, message) {
      if (message.role === "divider") return el(doc, "div", "za-divider", message.content);
      if (message.role === "user") {
        var turn = el(doc, "div", "za-turn za-turn-user");
        if (message.scopeLabel) turn.appendChild(el(doc, "div", "za-turn-scope", message.scopeLabel));
        turn.appendChild(el(doc, "div", "za-user-box", message.content));
        return turn;
      }
      var node = el(doc, "div", "za-turn za-turn-ai" + (message.error ? " is-error" : ""));
      var waiting = current.busy && current.pending === message;
      var same = message.content && message.reasoning && message.content === message.reasoning;
      if (message.reasoning && !same) {
        var thought = el(doc, "details", "za-thought");
        if (message.thoughtOpen) thought.open = true;
        var thinking = waiting && !message.content;
        var summary = el(
          doc,
          "summary",
          thinking ? "is-live" : "",
          thinking ? "Thinking…" : "Thought for " + seconds(message.thoughtMs || message.elapsedMs),
        );
        thought.append(summary, el(doc, "div", "za-thought-body", message.reasoning));
        thought.addEventListener("toggle", function () {
          message.thoughtOpen = thought.open;
        });
        node.appendChild(thought);
      }
      var body = el(doc, "div", "za-md");
      if (message.content) {
        setMarkdown(body, message.content, waiting);
      } else if (waiting) {
        if (!message.reasoning) body.appendChild(el(doc, "div", "za-live", current.stage || "Thinking…"));
      } else if (message.reasoning) {
        setMarkdown(body, message.reasoning, false);
      } else {
        body.textContent = "(No reply.)";
      }
      node.appendChild(body);
      var copyText = message.content || message.reasoning;
      if (!waiting && copyText) {
        var actions = el(doc, "div", "za-turn-actions");
        actions.appendChild(
          copyButton(doc, function () {
            return copyText;
          }),
        );
        var meta = [message.model, message.elapsedMs ? seconds(message.elapsedMs) : ""].filter(Boolean).join(" · ");
        if (meta) actions.appendChild(el(doc, "span", "za-turn-meta", meta));
        node.appendChild(actions);
      }
      return node;
    }

    function paintMessages() {
      var current = session();
      var list = current.messages;
      var nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
      var painted = view.painted;
      if (painted.session === current && painted.count === list.length && list.length && painted.last && painted.last.isConnected) {
        var node = renderMessage(current, list[list.length - 1]);
        painted.last.replaceWith(node);
        painted.last = node;
      } else {
        var jump = painted.session !== current || painted.count !== list.length;
        transcript.replaceChildren();
        var last = null;
        if (!list.length) transcript.appendChild(emptyState());
        list.forEach(function (message) {
          last = renderMessage(current, message);
          transcript.appendChild(last);
        });
        view.painted = { session: current, count: list.length, last: last };
        if (jump) nearBottom = true;
      }
      revealDialog();
      if (nearBottom) transcript.scrollTop = transcript.scrollHeight;
    }

    function paintNotes() {
      noteList.replaceChildren();
      if (!view.location || !view.location.ok) {
        notesIntro.textContent = view.location ? view.location.message : "No attachment file yet.";
        return;
      }
      notesIntro.textContent =
        (scope.type === "collection" ? "Notes for this collection are saved in " : "Notes are saved next to the attachment: ") +
        view.location.directory;
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
        row.append(name, el(doc, "span", "za-note-size", ZoteroAssistantUtil.formatBytes(file.size)));
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
      banner.appendChild(el(doc, "span", "", "Saved note: " + primary.name));
      var open = el(doc, "button", "za-ghost", "Open");
      open.type = "button";
      open.addEventListener("click", function () {
        openPath(primary.path);
      });
      banner.appendChild(open);
    }

    function showNotes(visible) {
      chat.hidden = visible;
      notes.hidden = !visible;
      notesButton.classList.toggle("is-active", visible);
      if (!visible) showList();
    }

    function showList() {
      reader.hidden = true;
      noteList.hidden = false;
      noteButtons.hidden = false;
      notesIntro.hidden = false;
    }

    function showReader(file, text) {
      view.reading = { path: file.path || file, name: file.name, text: text };
      readerTitle.textContent = file.name;
      showNotes(true);
      reader.hidden = false;
      noteList.hidden = true;
      noteButtons.hidden = true;
      notesIntro.hidden = true;
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
      var key = contextKey();
      if (!force && view.context && view.contextKey === key) {
        repaint();
        return Promise.resolve();
      }
      if (!force && view.loading && view.loadingKey === key) return view.loading;
      var loading = load(key);
      view.loading = loading;
      view.loadingKey = key;
      loading.finally(function () {
        if (view.loading === loading) view.loading = null;
      });
      return loading;
    }

    function sync() {
      fillControls();
      paintHeader();
      paintPills();
      repaint();
      return refresh();
    }

    async function load(key) {
      var token = ++view.token;
      var current = prefs();
      var source = effectiveSource(current);
      var busy = session().busy;
      view.loadError = null;
      paintHeader();
      paintPills();
      try {
        var ctx;
        var location;
        if (scope.type === "collection") {
          if (!busy) setStatus("Reading the collection…");
          ctx = await ZoteroAssistantContext.buildCollection(scope.id, {
            prefs: current,
            source: source,
            deep: current.deepCollections,
            onProgress: function (done, total, title) {
              if (token !== view.token) return;
              var text = (source === "pdf" ? "Reading " : "Converting ") + done + " of " + total + ": " + title;
              session().stage = text;
              setStatus(text);
            },
          });
          if (token !== view.token) return;
          location = await ZoteroAssistantNotes.locateCollection(ctx);
        } else {
          if (!busy) setStatus(source === "pdf" ? "Reading the paper…" : "Converting the PDF to Markdown…");
          ctx = await ZoteroAssistantContext.build(currentItem(), view.tabType, { prefs: current, source: source });
          if (token !== view.token) return;
          view.itemKey = ctx.itemKey || view.itemKey;
          location = ctx.attachment
            ? await ZoteroAssistantNotes.locate(ctx.attachment)
            : { ok: false, message: "This item has no local attachment." };
        }
        if (token !== view.token) return;
        session().stage = "";
        view.context = ctx;
        view.contextKey = key.replace(/^[^|]*/, sessionKey());
        view.location = location;
        view.files = location.ok ? ZoteroAssistantNotes.listMarkdown(location.directory) : [];
        paintHeader();
        paintPills();
        paintNotes();
        paintBanner();
        repaint();
        var primary = view.files.find(function (file) {
          return file.primary;
        });
        if (scope.type === "paper" && !view.openedExistingNote && !session().messages.length && primary) {
          view.openedExistingNote = true;
          await openPath(primary.path);
        }
        if (token !== view.token || session().busy) return;
        var saved = prefs();
        if (!saved.apiBase || !saved.model) setStatus("Set the API in Settings → Zassistant.");
        else if (!saved.apiKey && !saved.localEndpoint) setStatus("Add the API secret for " + saved.serviceLabel + " in Settings → Zassistant.");
        else setStatus("");
      } catch (error) {
        if (token !== view.token) return;
        view.loadError = error;
        session().stage = "";
        ZoteroAssistantUtil.log("load failed", error);
        setStatus(error.message || String(error), true);
      }
    }

    async function ensureContext() {
      if (view.context && view.contextKey === contextKey()) return view.context;
      await refresh();
      if (view.context && view.contextKey === contextKey()) return view.context;
      throw view.loadError || new Error("The paper could not be prepared. Press Reload and try again.");
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
      target.stage = "";
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

    function scopeLabel() {
      var ctx = view.context && view.contextKey === contextKey() ? view.context : null;
      var source = effectiveSource(prefs()) === "pdf" ? "PDF" : "Markdown";
      if (scope.type === "collection") {
        return "@ " + (ctx ? ctx.title + " · " + ctx.paperCount + " papers" : "Collection") + " · " + source;
      }
      return "@ " + (ctx ? ctx.title : "This paper") + " · " + source;
    }

    async function send() {
      var target = session();
      if (target.busy) {
        if (target.controller) target.controller.abort();
        return;
      }
      var question = input.value.trim();
      if (!question) return;
      target.draft = "";
      input.value = "";
      autosize();
      var history = historyFor(target);
      var chatPrefs = prefs();
      target.messages.push({ role: "user", content: question, scopeLabel: scopeLabel() });
      var assistant = { role: "assistant", content: "", reasoning: "", model: chatPrefs.model, startedAt: Date.now() };
      target.messages.push(assistant);
      ZoteroAssistantUtil.log("send: " + question.length + " chars, history " + history.length + ", scope " + sessionKey());
      try {
        var controller = beginRequest(target, assistant);
        var ctx = await ensureContext();
        if (controller.signal.aborted) throw Object.assign(new Error("Stopped"), { name: "AbortError" });
        var messages = [{ role: "system", content: ctx.systemPrompt }]
          .concat(history)
          .concat([{ role: "user", content: question }]);
        chatPrefs = prefs();
        if (ctx.files && ctx.files.length) {
          var many = ctx.files.length === 1 ? "the PDF" : ctx.files.length + " PDFs";
          target.stage = (chatPrefs.pdfTransport === "extract" ? "Uploading " + many + " to " + chatPrefs.providerLabel + " for reading…" : "Attaching " + many + "…");
          repaintSession(target);
          messages = await ZoteroAssistantAI.withPdfFiles(messages, ctx.files, chatPrefs, controller.signal);
        }
        target.stage = "";
        assistant.model = chatPrefs.model;
        ZoteroAssistantUtil.log(
          "request: " + chatPrefs.service + " " + chatPrefs.model + " " + chatPrefs.apiBase +
            ", key " + (chatPrefs.apiKey ? "set" : "missing") +
            ", source " + ctx.source + ", files " + ctx.files.length +
            ", system " + ctx.systemPrompt.length + " chars",
        );
        setStatus("");
        var result = await ZoteroAssistantAI.complete({
          prefs: chatPrefs,
          signal: controller.signal,
          messages: messages,
          hasFiles: !!ctx.files.length,
          onDelta: function (delta) {
            if (delta.content) {
              if (!assistant.content && assistant.reasoning) assistant.thoughtMs = Date.now() - assistant.startedAt;
              assistant.content += delta.content;
            }
            if (delta.reasoning) assistant.reasoning += delta.reasoning;
            var now = Date.now();
            if (now - target.paintAt > 150) {
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
        assistant.elapsedMs = Date.now() - assistant.startedAt;
        if (assistant.reasoning && !assistant.thoughtMs) assistant.thoughtMs = assistant.elapsedMs;
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
      var target = session();
      if (target.busy) return;
      var round = roundMessages(target);
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
      var ctx = view.context && view.contextKey === contextKey() ? view.context : null;
      if (!ctx) {
        setStatus("The paper is still loading. Try again in a moment.", true);
        return;
      }
      var location = view.location && view.location.ok ? view.location : null;
      if (!location && scope.type === "paper") {
        if (!ctx.attachment) {
          setStatus("No attachment was found, so the note cannot be saved.", true);
          return;
        }
        location = await ZoteroAssistantNotes.locate(ctx.attachment);
        view.location = location;
      }
      if (!location || !location.ok) {
        setStatus(location ? location.message : "There is no folder for the note.", true);
        return;
      }
      var transcriptText = round
        .map(function (message) {
          return (message.role === "user" ? "User: " : "Assistant: ") + message.content;
        })
        .join("\n\n");
      var prompt = ZoteroAssistantUtil.buildSummaryPrompt({
        metadata: ctx.metadata,
        transcript: transcriptText,
        maxChars: prefs().maxContextChars,
      });
      var summary = "";
      showNotes(true);
      reader.hidden = false;
      noteList.hidden = true;
      noteButtons.hidden = true;
      notesIntro.hidden = true;
      readerTitle.textContent = "Summarizing this round…";
      readerBody.classList.remove("is-source");
      readerBody.textContent = "";
      var controller = beginRequest(target, null);
      try {
        var result = await ZoteroAssistantAI.complete({
          prefs: prefs(),
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
          title: ctx.title,
          time: ZoteroAssistantUtil.formatNoteTime(new Date()),
          questions: questions,
          summary: summary,
        });
        target.messages.push({ role: "divider", content: "Saved " + saved.name });
        target.summarizedCount = target.messages.length;
        view.files = ZoteroAssistantNotes.listMarkdown(location.directory);
        paintNotes();
        paintBanner();
        view.showSource = false;
        showReader(saved, saved.text);
        setStatus("Saved to " + saved.name);
      } catch (error) {
        if (ZoteroAssistantUtil.isAbortError(error)) {
          setStatus("Stopped. The note was not saved.");
          showNotes(false);
        } else {
          setStatus(error.message || String(error), true);
        }
      } finally {
        endRequest(target);
      }
    }

    function autosize() {
      input.style.height = "auto";
      input.style.height = Math.min(Math.max(input.scrollHeight, 40), 220) + "px";
    }

    function dispose() {
      view.token += 1;
      views.delete(view);
      session().draft = input.value;
    }

    function changeScope(value) {
      session().draft = input.value;
      var match = /^collection:(\d+)$/.exec(value);
      scope = match ? { type: "collection", id: Number(match[1]) } : { type: "paper", id: null };
      views.forEach(function (other) {
        other.sync();
      });
    }

    newButton.addEventListener("click", function () {
      var target = session();
      if (target.busy) return;
      target.messages = [];
      target.summarizedCount = 0;
      view.painted = { session: null, count: -1, last: null };
      showNotes(false);
      repaint();
      input.focus();
    });
    notesButton.addEventListener("click", function () {
      showNotes(notes.hidden);
    });
    refreshButton.addEventListener("click", function () {
      ZoteroAssistantContext.clearCache();
      view.context = null;
      view.contextKey = "";
      fillControls();
      refresh(true);
    });
    scopeSelect.addEventListener("mousedown", function () {
      if (!scopeSelect.dataset.filled) {
        scopeSelect.dataset.filled = "1";
        fillScope();
      }
    });
    scopeSelect.addEventListener("change", function () {
      changeScope(scopeSelect.value);
    });
    sourceSelect.addEventListener("change", function () {
      Zotero.ZoteroAssistant.setSource(sourceSelect.value);
      views.forEach(function (other) {
        other.sync();
      });
    });
    modelSelect.addEventListener("focus", function () {
      fillModels(prefs());
    });
    sourceSelect.addEventListener("focus", function () {
      fillSource(prefs());
    });
    modelSelect.addEventListener("change", function () {
      if (!modelSelect.value) return;
      Zotero.ZoteroAssistant.setActiveProfile(modelSelect.value);
      var picked = Zotero.ZoteroAssistant.getProfile(modelSelect.value);
      if (prefs().source === "pdf" && !picked.pdf) {
        Zotero.ZoteroAssistant.setSource("markdown");
        Zotero.ZoteroAssistant.setActiveProfile(picked.id);
        setStatus(picked.name + " reads text only, so the source is now Markdown.");
      }
      views.forEach(function (other) {
        other.sync();
      });
    });
    input.addEventListener("input", function () {
      session().draft = input.value;
      autosize();
    });
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        send();
      } else if (event.key === "Escape" && session().busy) {
        event.preventDefault();
        send();
      }
    });
    sendButton.addEventListener("click", send);
    saveButton.addEventListener("click", summarize);
    openButton.addEventListener("click", async function () {
      try {
        var path = await ZoteroAssistantNotes.chooseMarkdown(win, view.location && view.location.directory);
        if (path) await openPath(path);
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
    });
    revealButton.addEventListener("click", function () {
      if (!view.location || !view.location.ok) {
        setStatus("There is no folder to open.", true);
        return;
      }
      if (!ZoteroAssistantNotes.reveal(view.location.directory)) {
        setStatus(view.location.directory, true);
      }
    });
    backButton.addEventListener("click", showList);
    sourceButton.addEventListener("click", function () {
      view.showSource = !view.showSource;
      paintReader();
    });

    fillControls();
    paintHeader();
    paintPills();
    repaint();
    return view;
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
