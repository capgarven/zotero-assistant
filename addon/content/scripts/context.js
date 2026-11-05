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

  var PYTHON_PREF = "extensions.zotero.zoteroassistant.python";
  var PYTHON_VERSIONS = ["314", "313", "312", "311", "310"];
  var detectedPython = null;

  function configuredPython() {
    try {
      return String(Zotero.Prefs.get(PYTHON_PREF, true) || "").trim();
    } catch (error) {
      return "";
    }
  }

  function environment() {
    try {
      return Components.classes["@mozilla.org/process/environment;1"].getService(Components.interfaces.nsIEnvironment);
    } catch (error) {
      return null;
    }
  }

  function windowsPythons(env) {
    var local = env ? env.get("LOCALAPPDATA") : "";
    var profile = env ? env.get("USERPROFILE") : "";
    var list = ["D:\\anaconda3\\python.exe", "C:\\ProgramData\\anaconda3\\python.exe"];
    PYTHON_VERSIONS.forEach(function (version) {
      if (local) list.push(local + "\\Programs\\Python\\Python" + version + "\\python.exe");
    });
    if (profile) {
      ["anaconda3", "miniconda3", "miniforge3"].forEach(function (name) {
        list.push(profile + "\\" + name + "\\python.exe");
      });
    }
    return list;
  }

  function unixPythons(env) {
    var home = env ? env.get("HOME") : "";
    var list = [];
    if (Zotero.isMac) {
      list.push("/opt/homebrew/bin/python3");
      PYTHON_VERSIONS.forEach(function (version) {
        var dotted = version[0] + "." + version.slice(1);
        list.push("/Library/Frameworks/Python.framework/Versions/" + dotted + "/bin/python3");
      });
    }
    list.push("/usr/local/bin/python3");
    if (home) {
      ["miniconda3", "anaconda3", "miniforge3", "mambaforge"].forEach(function (name) {
        list.push(home + "/" + name + "/bin/python3");
      });
      list.push(home + "/.pyenv/shims/python3", home + "/.local/bin/python3");
    }
    ["/opt/anaconda3", "/opt/miniconda3", "/opt/homebrew/anaconda3", "/opt/homebrew/Caskroom/miniconda/base"].forEach(
      function (root) {
        list.push(root + "/bin/python3");
      },
    );
    // On macOS /usr/bin/python3 is a stub that pops up an installer when the developer tools are missing.
    list.push(Zotero.isMac ? "/Library/Developer/CommandLineTools/usr/bin/python3" : "/usr/bin/python3");
    return list;
  }

  function pythonCandidates() {
    var env = environment();
    var list = Zotero.isWin ? windowsPythons(env) : unixPythons(env);
    String((env && env.get("PATH")) || "")
      .split(Zotero.isWin ? ";" : ":")
      .forEach(function (dir) {
        if (!dir) return;
        dir = dir.replace(/[\\/]+$/, "");
        if (Zotero.isWin) list.push(dir + "\\python.exe");
        else if (!(Zotero.isMac && dir === "/usr/bin")) list.push(dir + "/python3");
      });
    var seen = new Set();
    return list.filter(function (path) {
      if (seen.has(path) || /WindowsApps/i.test(path)) return false;
      seen.add(path);
      try {
        return fileExists(path);
      } catch (error) {
        return false;
      }
    });
  }

  function hasMarkItDownScript(python) {
    try {
      var dir = Zotero.File.pathToFile(python).parent;
      var names = Zotero.isWin ? ["Scripts\\markitdown.exe", "markitdown.exe"] : ["markitdown"];
      return names.some(function (name) {
        var file = dir.clone();
        name.split("\\").forEach(function (part) {
          file.append(part);
        });
        return file.exists();
      });
    } catch (error) {
      return false;
    }
  }

  async function hasMarkItDown(python) {
    try {
      await Zotero.Utilities.Internal.exec(python, ["-c", "import markitdown"]);
      return true;
    } catch (error) {
      return false;
    }
  }

  async function checkPython(path) {
    var python = String(path || "").trim();
    if (!python) return { ok: false, path: "", message: "No Python path was given." };
    var exists = false;
    try {
      exists = fileExists(python);
    } catch (error) {}
    if (!exists) return { ok: false, path: python, message: "This file does not exist." };
    if (!(await hasMarkItDown(python))) {
      return {
        ok: false,
        path: python,
        message: "MarkItDown is not installed for this Python. Run: " + python + " -m pip install 'markitdown[pdf]'",
      };
    }
    return { ok: true, path: python, message: "MarkItDown is ready." };
  }

  async function detectPython() {
    var candidates = pythonCandidates();
    var ordered = candidates.filter(hasMarkItDownScript).concat(
      candidates.filter(function (path) {
        return !hasMarkItDownScript(path);
      }),
    );
    for (var i = 0; i < ordered.length; i += 1) {
      if (await hasMarkItDown(ordered[i])) return { ok: true, path: ordered[i], message: "MarkItDown is ready." };
    }
    if (ordered.length) {
      return {
        ok: false,
        path: ordered[0],
        message: "Python was found, but MarkItDown is not installed. Run: " + ordered[0] + " -m pip install 'markitdown[pdf]'",
      };
    }
    return {
      ok: false,
      path: "",
      message: "Python was not found. Install Python 3.10 or newer with MarkItDown, or set the Python path in Zassistant settings.",
    };
  }

  async function findPython() {
    var configured = configuredPython();
    var cached = detectedPython && detectedPython.ok && detectedPython.configured === configured;
    if (!cached) {
      detectedPython = configured ? await checkPython(configured) : await detectPython();
      detectedPython.configured = configured;
    }
    return detectedPython;
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
    var python = await findPython();
    if (!python.ok) throw new Error(python.message);
    var tempFile = Zotero.File.pathToFile(temp);
    if (tempFile.exists()) tempFile.remove(false);
    await Zotero.Utilities.Internal.exec(python.path, ["-m", "markitdown", pdfPath, "-o", temp]);
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

  var collectionCache = new Map();

  function clearCache() {
    textCache.clear();
    collectionCache.clear();
  }

  function pdfFileOf(attachment) {
    var path = attachmentFilePath(attachment);
    if (!/\.pdf$/i.test(path)) return null;
    try {
      var file = Zotero.File.pathToFile(path);
      if (!file.exists() || file.isDirectory()) return null;
      return { path: file.path, name: file.leafName, size: file.fileSize };
    } catch (error) {
      return null;
    }
  }

  async function paperText(attachment, reader) {
    var result = { text: "", error: "", markdown: false };
    if (!attachment) return result;
    var pdf = pdfFileOf(attachment);
    if (pdf) {
      var started = Date.now();
      try {
        result.text = await ZoteroAssistantUtil.withTimeout(
          pdfToMarkdown(pdf.path),
          600000,
          "Timed out while converting the PDF",
        );
        result.markdown = !!result.text;
        if (!result.text) result.error = "MarkItDown did not return any Markdown.";
        ZoteroAssistantUtil.log(
          "markdown: " + String(result.text || "").length + " chars in " + (Date.now() - started) + " ms",
        );
      } catch (error) {
        result.error = error && error.message ? error.message : "Could not convert the PDF to Markdown.";
        ZoteroAssistantUtil.log("markdown failed after " + (Date.now() - started) + " ms", error);
      }
    } else {
      ZoteroAssistantUtil.log("no local PDF path for attachment " + attachment.id);
    }
    if (result.text) return result;
    try {
      var extracted = await ZoteroAssistantUtil.withTimeout(
        attachmentText(attachment, reader),
        45000,
        "Timed out while reading the paper text",
      );
      result.text = extracted.text;
      if (!result.error) result.error = extracted.error;
    } catch (error) {
      if (!result.error) {
        result.error =
          error && error.message === "Timed out while reading the paper text"
            ? "Timed out while reading the paper text."
            : "Could not read the paper text.";
      }
    }
    return result;
  }

  function tagsOf(item) {
    try {
      return item
        .getTags()
        .map(function (tag) {
          return tag.tag;
        })
        .join(", ");
    } catch (error) {
      return "";
    }
  }

  function yearOf(item) {
    var date = field(item, "date");
    return (String(date).match(/\d{4}/) || [date])[0] || "";
  }

  function paperMetadata(parent, attachment, location) {
    return metadataBlock({
      title: field(parent, "title") || field(attachment, "title") || "Untitled",
      creators: creators(parent),
      year: yearOf(parent),
      itemType: itemTypeLabel(parent),
      publication: field(parent, "publicationTitle"),
      doi: field(parent, "DOI"),
      url: field(parent, "url"),
      tags: tagsOf(parent),
      attachmentName: attachment ? field(attachment, "title") || attachment.attachmentFilename || "" : "",
      location: location ? "p. " + location : "",
      abstract: field(parent, "abstractNote"),
    });
  }

  async function build(item, tabType, options) {
    var prefs = options.prefs;
    var usePdf = options.source === "pdf";
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
    var annotations = annotationText(attachment);
    var notes = noteText(parent);
    var selected = inspected.mode === "reader" ? selectedText(reader) : "";
    var metadata = paperMetadata(parent, attachment, currentLocation(reader));
    var pdf = usePdf ? pdfFileOf(attachment) : null;
    var text = { text: "", error: "", markdown: false };
    if (!pdf) text = await paperText(attachment, reader);
    var fitted = ZoteroAssistantUtil.fitContext({
      metadata: metadata,
      selectedText: selected,
      annotations: annotations.text,
      notes: notes.text,
      fulltext: text.text,
      fulltextError: text.error,
      maxChars: prefs.maxContextChars,
      prompt: prefs.prompt,
      markdown: text.markdown,
      attachedPdf: pdf ? pdf.name : "",
    });
    var attachmentName = attachment
      ? attachment.attachmentFilename || field(attachment, "title") || "Attachment"
      : "";
    var systemPrompt = ZoteroAssistantUtil.buildSystemPrompt(fitted);
    ZoteroAssistantUtil.log(
      "context: " +
        (pdf ? "pdf " + pdf.size + " bytes" : (text.markdown ? "markdown " : "fallback text ") +
          fitted.fulltext.length + " of " + fitted.fulltextTotal + " chars") +
        ", system " + systemPrompt.length + " chars" +
        (text.error && !fitted.fulltext && !pdf ? ", error: " + text.error : ""),
    );
    return {
      scope: "paper",
      source: pdf ? "pdf" : "markdown",
      itemKey: inspected.itemKey,
      mode: inspected.mode,
      title: title,
      creators: creators(parent),
      year: yearOf(parent),
      attachment: attachment,
      attachmentName: attachmentName,
      parent: parent,
      selectedChars: fitted.selectedText.length,
      annotationCount: annotations.count,
      noteCount: notes.count,
      fulltextChars: fitted.fulltext.length,
      fulltextTotal: fitted.fulltextTotal,
      fulltextTruncated: fitted.fulltextTruncated,
      fulltextMissing: !pdf && !fitted.fulltext,
      files: pdf ? [pdf] : [],
      metadata: metadata,
      systemPrompt: systemPrompt,
    };
  }

  function libraries() {
    try {
      return Zotero.Libraries.getAll().filter(function (library) {
        return library.libraryType !== "feed";
      });
    } catch (error) {
      return [Zotero.Libraries.userLibrary].filter(Boolean);
    }
  }

  function byName(a, b) {
    return String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true });
  }

  function listCollections() {
    var groups = [];
    libraries().forEach(function (library) {
      var rows = [];
      function walk(collection, depth) {
        rows.push({ id: collection.id, name: collection.name, depth: depth });
        collection
          .getChildCollections(false)
          .slice()
          .sort(byName)
          .forEach(function (child) {
            walk(child, depth + 1);
          });
      }
      try {
        Zotero.Collections.getByLibrary(library.libraryID, false)
          .slice()
          .sort(byName)
          .forEach(function (collection) {
            walk(collection, 0);
          });
      } catch (error) {
        ZoteroAssistantUtil.log("list collections failed for library " + library.libraryID, error);
      }
      if (rows.length) groups.push({ libraryID: library.libraryID, name: library.name, collections: rows });
    });
    return groups;
  }

  function selectedCollectionID() {
    try {
      var pane = activeWindow() && activeWindow().ZoteroPane;
      var collection = pane && pane.getSelectedCollection && pane.getSelectedCollection();
      return collection ? collection.id : null;
    } catch (error) {
      return null;
    }
  }

  function collectionPapers(collection, deep) {
    var seen = new Set();
    var papers = [];
    function walk(current) {
      current.getChildItems(false).forEach(function (item) {
        var top = item.isRegularItem() || (item.isAttachment() && !item.parentItemID && isPdf(item));
        if (!top || seen.has(item.id)) return;
        seen.add(item.id);
        papers.push(item);
      });
      if (deep) current.getChildCollections(false).forEach(walk);
    }
    walk(collection);
    return papers.sort(function (a, b) {
      return String(field(a, "title")).localeCompare(String(field(b, "title")), undefined, { numeric: true });
    });
  }

  function collectionCount(collectionID, deep) {
    var collection = Zotero.Collections.get(collectionID);
    return collection ? collectionPapers(collection, deep).length : 0;
  }

  async function buildCollection(collectionID, options) {
    var prefs = options.prefs;
    var usePdf = options.source === "pdf";
    var deep = !!options.deep;
    var collection = Zotero.Collections.get(collectionID);
    if (!collection) throw new Error("That collection no longer exists.");
    var papers = collectionPapers(collection, deep);
    var cacheKey = [collectionID, usePdf ? "pdf" : "md", deep ? "deep" : "flat", papers.map(function (item) {
      return item.id + "@" + item.dateModified;
    }).join(",")].join("|");
    if (collectionCache.has(cacheKey)) return collectionCache.get(cacheKey);
    var entries = new Array(papers.length);
    var done = 0;
    var next = 0;
    async function worker() {
      while (next < papers.length) {
        var index = next++;
        var item = papers[index];
        var attachment = bestAttachment(item);
        var parent = item;
        var pdf = usePdf ? pdfFileOf(attachment) : null;
        var text = { text: "", error: "", markdown: false };
        if (!pdf && attachment) text = await paperText(attachment, null);
        entries[index] = {
          title: field(parent, "title") || field(attachment, "title") || "Untitled",
          metadata: paperMetadata(parent, attachment, ""),
          annotations: annotationText(attachment).text,
          notes: item.isRegularItem() ? noteText(item).text : "",
          text: text.text,
          markdown: text.markdown,
          error: text.error || (attachment ? "" : "This item has no attachment."),
          pdf: pdf,
        };
        done += 1;
        if (options.onProgress) options.onProgress(done, papers.length, entries[index].title);
      }
    }
    await Promise.all([worker(), worker()]);
    var files = [];
    entries.forEach(function (entry) {
      if (entry.pdf) {
        files.push(entry.pdf);
        entry.attachedPdf = entry.pdf.name;
      }
    });
    var systemPrompt = ZoteroAssistantUtil.buildCollectionPrompt({
      prompt: prefs.prompt,
      name: collection.name,
      papers: entries,
    });
    var textChars = entries.reduce(function (sum, entry) {
      return sum + entry.text.length;
    }, 0);
    var missing = entries.filter(function (entry) {
      return !entry.pdf && !entry.text;
    }).length;
    var bytes = files.reduce(function (sum, file) {
      return sum + (file.size || 0);
    }, 0);
    ZoteroAssistantUtil.log(
      "collection context: " + collection.name + ", " + entries.length + " papers, " + files.length +
        " pdf (" + bytes + " bytes), text " + textChars + " chars, system " + systemPrompt.length + " chars",
    );
    var context = {
      scope: "collection",
      source: files.length ? "pdf" : "markdown",
      collectionID: collectionID,
      collectionKey: collection.key,
      itemKey: "collection:" + collectionID,
      title: collection.name,
      paperCount: entries.length,
      missingCount: missing,
      files: files,
      fileBytes: bytes,
      systemChars: systemPrompt.length,
      metadata:
        "Collection: " + collection.name + "\n" +
        entries
          .map(function (entry, index) {
            return "[" + (index + 1) + "] " + entry.title;
          })
          .join("\n"),
      systemPrompt: systemPrompt,
    };
    collectionCache.set(cacheKey, context);
    return context;
  }

  return {
    build: build,
    buildCollection: buildCollection,
    listCollections: listCollections,
    selectedCollectionID: selectedCollectionID,
    collectionCount: collectionCount,
    clearCache: clearCache,
    inspectItem: inspectItem,
    checkPython: checkPython,
    detectPython: detectPython,
  };
})();
