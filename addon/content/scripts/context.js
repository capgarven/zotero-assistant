var ZoteroAssistantContext = (function () {
  var textCache = new Map();

  function field(item, name) {
    try {
      return item && item.getField ? item.getField(name) || "" : "";
    } catch (error) {
      return "";
    }
  }

  function activeWindow() {
    try {
      return Zotero.getMainWindow();
    } catch (error) {
      return null;
    }
  }

  function activeReader() {
    try {
      var win = activeWindow();
      var tabs = win && win.Zotero_Tabs;
      if (!tabs || tabs.selectedType !== "reader" || !tabs.selectedID) return null;
      return Zotero.Reader.getByTabID(tabs.selectedID) || null;
    } catch (error) {
      return null;
    }
  }

  function selectionFrom(win) {
    try {
      var text = win && win.getSelection ? win.getSelection().toString() : "";
      return text ? text.trim() : "";
    } catch (error) {
      return "";
    }
  }

  function selectedText(reader) {
    if (!reader) return "";
    var found = [];
    function push(text) {
      var value = String(text || "").trim();
      if (value) found.push(value);
    }
    push(selectionFrom(reader._iframeWindow));
    try {
      push(selectionFrom(reader._internalReader._primaryView._iframeWindow));
    } catch (error) {}
    try {
      var frames = reader._iframeWindow.document.querySelectorAll("iframe");
      Array.prototype.forEach.call(frames, function (frame) {
        push(selectionFrom(frame.contentWindow));
      });
    } catch (error) {}
    try {
      push(reader._internalReader._lastView._selectionPopup.annotation.text);
    } catch (error) {}
    found.sort(function (a, b) {
      return b.length - a.length;
    });
    return found[0] || "";
  }

  function currentLocation(reader) {
    var states = [];
    try {
      states.push(reader._internalReader._state);
    } catch (error) {}
    try {
      states.push(reader._state);
    } catch (error) {}
    try {
      states.push(reader._internalReader._primaryView);
    } catch (error) {}
    for (var i = 0; i < states.length; i += 1) {
      var state = states[i];
      if (!state) continue;
      var pageIndex = state.pageIndex;
      if (pageIndex === undefined) pageIndex = state.page;
      var label = state.pageLabel || state.label;
      if (label || Number.isInteger(pageIndex)) {
        return label || String(pageIndex + 1);
      }
    }
    return "";
  }

  function creators(item) {
    try {
      return item
        .getCreators()
        .map(function (creator) {
          if (creator.name) return creator.name;
          if (creator.fieldMode === 1) return creator.lastName || "";
          return [creator.firstName, creator.lastName].filter(Boolean).join(" ");
        })
        .filter(Boolean)
        .join(", ");
    } catch (error) {
      return "";
    }
  }

  function itemTypeLabel(item) {
    try {
      if (Zotero.ItemTypes.getLocalizedString) {
        return Zotero.ItemTypes.getLocalizedString(item.itemTypeID) || "";
      }
    } catch (error) {}
    try {
      return Zotero.ItemTypes.getName(item.itemTypeID) || "";
    } catch (error) {
      return "";
    }
  }

  function isPdf(item) {
    try {
      return !!(item && (item.isPDFAttachment?.() || item.attachmentContentType === "application/pdf"));
    } catch (error) {
      return false;
    }
  }

  function bestAttachment(item) {
    if (!item) return null;
    try {
      if (item.isAttachment()) return item;
    } catch (error) {}
    var ids = [];
    try {
      ids = item.getAttachments ? item.getAttachments() : [];
    } catch (error) {
      return null;
    }
    var attachments = Zotero.Items.get(ids) || [];
    return (
      attachments.find(isPdf) ||
      attachments.find(function (attachment) {
        try {
          return attachment.isAttachment();
        } catch (error) {
          return false;
        }
      }) ||
      null
    );
  }

  function parentOf(item) {
    if (!item) return null;
    try {
      if (item.isAttachment() || item.isNote()) return item.parentItem || item;
    } catch (error) {}
    return item;
  }

  function inspectItem(item, tabType) {
    var reader = null;
    if (tabType === "reader" || !tabType) {
      var candidate = activeReader();
      if (candidate && candidate.itemID) {
        var readerAttachment = Zotero.Items.get(candidate.itemID);
        var readerParent = parentOf(readerAttachment);
        var matches =
          !item ||
          item.id === candidate.itemID ||
          item.id === readerAttachment?.id ||
          item.id === readerParent?.id;
        if (tabType === "reader" || matches) {
          reader = candidate;
          return {
            mode: "reader",
            reader: reader,
            attachment: readerAttachment,
            parent: readerParent,
            itemKey: "attachment:" + candidate.itemID,
          };
        }
      }
      if (tabType === "reader") {
        reader = candidate;
      }
    }
    var parent = parentOf(item);
    var attachment = bestAttachment(item);
    var key = attachment ? "attachment:" + attachment.id : parent ? "item:" + parent.id : "";
    return {
      mode: attachment || parent ? "selection" : "none",
      reader: reader,
      attachment: attachment,
      parent: parent || item || null,
      itemKey: key,
    };
  }

  function metadataBlock(info) {
    var lines = [];
    function add(label, value) {
      if (value) lines.push(label + ": " + value);
    }
    add("Title", info.title);
    add("Authors", info.creators);
    add("Year", info.year);
    add("Type", info.itemType);
    add("Publication", info.publication);
    add("DOI", info.doi);
    add("URL", info.url);
    add("Tags", info.tags);
    add("Attachment", info.attachmentName);
    add("Location", info.location);
    if (info.abstract) {
      lines.push("", "Abstract:", info.abstract);
    }
    return lines.join("\n");
  }

  function annotationText(attachment) {
    if (!attachment || !attachment.getAnnotations) return { text: "", count: 0 };
    var rows = [];
    try {
      attachment.getAnnotations().forEach(function (annotation) {
        var text = annotation.annotationText || "";
        var comment = annotation.annotationComment || "";
        if (!text && !comment) return;
        var page = annotation.annotationPageLabel ? "p." + annotation.annotationPageLabel + " " : "";
        rows.push(page + text + (comment ? "\nNote: " + comment : ""));
      });
    } catch (error) {
      Zotero.debug("Zotero Assistant annotations: " + error);
    }
    return { text: rows.join("\n\n"), count: rows.length };
  }

  function noteText(item) {
    if (!item || !item.getNotes) return { text: "", count: 0 };
    var rows = [];
    try {
      var notes = Zotero.Items.get(item.getNotes()) || [];
      notes.forEach(function (note) {
        var text = htmlToText(note.getNote ? note.getNote() : "");
        if (text) rows.push(text);
      });
    } catch (error) {
      Zotero.debug("Zotero Assistant notes: " + error);
    }
    return { text: rows.join("\n\n"), count: rows.length };
  }

  function htmlToText(html) {
    return String(html || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .trim();
  }

  function visibleText(reader) {
    if (!reader) return "";
    function collect(win) {
      if (!win || !win.document || !win.document.body) return "";
      var chunks = [];
      var total = 0;
      try {
        var walker = win.document.createTreeWalker(win.document.body, 4);
        var node;
        while ((node = walker.nextNode())) {
          var parent = node.parentElement;
          var tag = parent && parent.localName;
          if (tag === "script" || tag === "style" || tag === "noscript") continue;
          var text = String(node.nodeValue || "").replace(/\s+/g, " ").trim();
          if (text.length < 2) continue;
          chunks.push(text);
          total += text.length;
          if (total > 20000) break;
        }
      } catch (error) {
        return "";
      }
      return chunks.join(" ");
    }
    var primary = "";
    try {
      primary = collect(reader._internalReader._primaryView._iframeWindow);
    } catch (error) {}
    if (primary.length > 200) return primary;
    var outer = collect(reader._iframeWindow);
    return primary.length > outer.length ? primary : outer;
  }

  async function indexedText(attachment) {
    try {
      var fulltext = Zotero.FullText || Zotero.Fulltext;
      if (!fulltext || !fulltext.getItemCacheFile) return "";
      var cache = fulltext.getItemCacheFile(attachment);
      if (!cache || !cache.exists()) return "";
      return (await Zotero.File.getContentsAsync(cache, "UTF-8")) || "";
    } catch (error) {
      return "";
    }
  }

  async function workerText(itemID) {
    if (!Zotero.PDFWorker || typeof Zotero.PDFWorker.getFullText !== "function") return "";
    try {
      var result = await Zotero.PDFWorker.getFullText(itemID, null);
      return typeof result === "string" ? result : (result && result.text) || "";
    } catch (error) {
      Zotero.debug("Zotero Assistant fulltext worker: " + error);
      return "";
    }
  }

  function attachmentFilePath(attachment) {
    if (!attachment) return "";
    try {
      if (typeof attachment.getFilePath === "function") return attachment.getFilePath() || "";
    } catch (error) {}
    return "";
  }

  function fileExists(path) {
    var file = Zotero.File.pathToFile(path);
    return file.exists() && !file.isDirectory();
  }

  function findPython() {
    var candidates = [];
    try {
      var configured = String(Zotero.Prefs.get("extensions.zotero.zoteroassistant.python", true) || "").trim();
      if (configured) candidates.push(configured);
    } catch (error) {}
    candidates.push(
      "D:\\anaconda3\\python.exe",
      "C:\\ProgramData\\anaconda3\\python.exe",
    );
    try {
      var env = Components.classes["@mozilla.org/process/environment;1"].getService(
        Components.interfaces.nsIEnvironment,
      );
      var local = env.get("LOCALAPPDATA");
      var profile = env.get("USERPROFILE");
      ["Python313", "Python312", "Python311"].forEach(function (version) {
        if (local) candidates.push(local + "\\Programs\\Python\\" + version + "\\python.exe");
      });
      if (profile) {
        candidates.push(profile + "\\anaconda3\\python.exe", profile + "\\miniconda3\\python.exe");
      }
      String(env.get("PATH") || "")
        .split(Zotero.isWin ? ";" : ":")
        .forEach(function (dir) {
          if (!dir) return;
          candidates.push(dir.replace(/[\\/]+$/, "") + (Zotero.isWin ? "\\python.exe" : "/python3"));
        });
    } catch (error) {}
    for (var i = 0; i < candidates.length; i += 1) {
      if (/WindowsApps/i.test(candidates[i])) continue;
      try {
        if (fileExists(candidates[i])) return candidates[i];
      } catch (error) {}
    }
    return "";
  }

  var conversions = new Map();

  function pdfToMarkdown(pdfPath) {
    if (!conversions.has(pdfPath)) {
      var job = convertPdf(pdfPath);
      conversions.set(pdfPath, job);
      job.then(
        function () {
          conversions.delete(pdfPath);
        },
        function () {
          conversions.delete(pdfPath);
        },
      );
    }
    return conversions.get(pdfPath);
  }

  async function convertPdf(pdfPath) {
    var output = pdfPath + ".zassistant.md";
    var temp = pdfPath + ".zassistant.tmp.md";
    var pdfFile = Zotero.File.pathToFile(pdfPath);
    var outFile = Zotero.File.pathToFile(output);
    if (outFile.exists() && outFile.lastModifiedTime >= pdfFile.lastModifiedTime) {
      var cached = await Zotero.File.getContentsAsync(output, "UTF-8");
      if (String(cached || "").trim()) return String(cached);
    }
    var python = findPython();
    if (!python) throw new Error("Python was not found, so the PDF could not be converted.");
    var tempFile = Zotero.File.pathToFile(temp);
    if (tempFile.exists()) tempFile.remove(false);
    await Zotero.Utilities.Internal.exec(python, ["-m", "markitdown", pdfPath, "-o", temp]);
    if (!tempFile.exists()) throw new Error("MarkItDown did not write a Markdown file.");
    var text = String((await Zotero.File.getContentsAsync(temp, "UTF-8")) || "");
    if (!text.trim()) {
      tempFile.remove(false);
      throw new Error("MarkItDown returned an empty file.");
    }
    if (outFile.exists()) outFile.remove(false);
    tempFile.moveTo(null, outFile.leafName);
    return text;
  }

  async function attachmentText(attachment, reader) {
    if (!attachment) return { text: "", error: "" };
    var key = attachment.id + ":" + (attachment.dateModified || "");
    if (textCache.has(key)) {
      var cached = textCache.get(key);
      return { text: cached, error: cached ? "" : "No text was found in the full-text cache or the extractor." };
    }
    var text = await indexedText(attachment);
    if (!text) text = await workerText(attachment.id);
    if (!text && reader) text = visibleText(reader);
    textCache.set(key, text || "");
    return {
      text: text,
      error: text ? "" : "No text was found in the index, the extractor, or the current page.",
    };
  }

  function clearCache() {
    textCache.clear();
  }

  async function build(item, tabType, options) {
    var prefs = options.prefs;
    var inspected = inspectItem(item, tabType);
    var parent = inspected.parent;
    var attachment = inspected.attachment;
    var reader = inspected.reader;
    if (reader && reader._initPromise) {
      try {
        await ZoteroAssistantUtil.withTimeout(reader._initPromise, 4000, "The reader is not ready.");
      } catch (error) {}
    }
    var title = field(parent, "title") || field(attachment, "title") || "Untitled";
    var date = field(parent, "date");
    var year = (String(date).match(/\d{4}/) || [date])[0] || "";
    var tags = "";
    try {
      tags = parent
        .getTags()
        .map(function (tag) {
          return tag.tag;
        })
        .join(", ");
    } catch (error) {}
    var annotations = annotationText(attachment);
    var notes = noteText(parent);
    var selected = inspected.mode === "reader" ? selectedText(reader) : "";
    var location = currentLocation(reader);
    var metadata = metadataBlock({
      title: title,
      creators: creators(parent),
      year: year,
      itemType: itemTypeLabel(parent),
      publication: field(parent, "publicationTitle"),
      doi: field(parent, "DOI"),
      url: field(parent, "url"),
      tags: tags,
      attachmentName: attachment ? field(attachment, "title") || attachment.attachmentFilename || "" : "",
      location: location ? "p. " + location : "",
      abstract: field(parent, "abstractNote"),
    });
    var fulltext = "";
    var fulltextError = "";
    var markdown = false;
    if (attachment) {
      var pdfPath = attachmentFilePath(attachment);
      if (/\.pdf$/i.test(pdfPath)) {
        var started = Date.now();
        try {
          fulltext = await ZoteroAssistantUtil.withTimeout(
            pdfToMarkdown(pdfPath),
            600000,
            "Timed out while converting the PDF",
          );
          markdown = !!fulltext;
          if (!fulltext) fulltextError = "MarkItDown did not return any Markdown.";
          ZoteroAssistantUtil.log(
            "markdown: " + String(fulltext || "").length + " chars in " + (Date.now() - started) + " ms",
          );
        } catch (error) {
          fulltextError = error && error.message ? error.message : "Could not convert the PDF to Markdown.";
          ZoteroAssistantUtil.log("markdown failed after " + (Date.now() - started) + " ms", error);
        }
      } else {
        ZoteroAssistantUtil.log("no local PDF path for attachment " + attachment.id);
      }
      if (!fulltext) {
        try {
          var extracted = await ZoteroAssistantUtil.withTimeout(
            attachmentText(attachment, reader),
            45000,
            "Timed out while reading the paper text",
          );
          fulltext = extracted.text;
          if (!fulltextError) fulltextError = extracted.error;
        } catch (error) {
          if (!fulltextError) {
            fulltextError = error && error.message === "Timed out while reading the paper text"
              ? "Timed out while reading the paper text."
              : "Could not read the paper text.";
          }
        }
      }
    }
    var fitted = ZoteroAssistantUtil.fitContext({
      metadata: metadata,
      selectedText: selected,
      annotations: annotations.text,
      notes: notes.text,
      fulltext: fulltext,
      fulltextError: fulltextError,
      maxChars: prefs.maxContextChars,
      prompt: prefs.prompt,
      markdown: markdown,
    });
    var attachmentName = attachment
      ? attachment.attachmentFilename || field(attachment, "title") || "Attachment"
      : "";
    var systemPrompt = ZoteroAssistantUtil.buildSystemPrompt(fitted);
    ZoteroAssistantUtil.log(
      "context: " + (markdown ? "markdown" : "fallback text") + " " + fitted.fulltext.length + " of " +
        fitted.fulltextTotal + " chars, system " + systemPrompt.length + " chars" +
        (fulltextError && !fitted.fulltext ? ", error: " + fulltextError : ""),
    );
    return {
      itemKey: inspected.itemKey,
      mode: inspected.mode,
      title: title,
      creators: creators(parent),
      year: year,
      attachment: attachment,
      attachmentName: attachmentName,
      parent: parent,
      selectedChars: fitted.selectedText.length,
      annotationCount: annotations.count,
      noteCount: notes.count,
      fulltextChars: fitted.fulltext.length,
      fulltextTotal: fitted.fulltextTotal,
      fulltextTruncated: fitted.fulltextTruncated,
      fulltextIncluded: true,
      metadata: metadata,
      systemPrompt: systemPrompt,
    };
  }

  return {
    build: build,
    clearCache: clearCache,
    inspectItem: inspectItem,
  };
})();
