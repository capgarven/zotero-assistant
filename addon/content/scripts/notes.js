var ZoteroAssistantNotes = (function () {
  var PRIMARY_NAME = "reading-note.md";
  var FALLBACK_NAME = "reading-note-zassistant.md";
  var MARKER = ZoteroAssistantUtil.NOTE_MARKER;

  function fileFor(path) {
    return Zotero.File.pathToFile(path);
  }

  function joinPath(dir, name) {
    var file = fileFor(dir);
    file.append(name);
    return file.path;
  }

  async function attachmentPath(attachment) {
    if (!attachment || !attachment.getFilePathAsync) return "";
    try {
      var path = await attachment.getFilePathAsync();
      return path || "";
    } catch (error) {
      Zotero.debug("Zotero Assistant attachment path: " + error);
      return "";
    }
  }

  async function locate(attachment) {
    var path = await attachmentPath(attachment);
    if (!path) {
      return {
        ok: false,
        message: "The attachment is not on this computer yet. Download a cloud file first. A web link has no folder for a note.",
      };
    }
    var file = fileFor(path);
    if (!file.exists()) {
      return { ok: false, message: "The attachment file could not be found, so the note cannot be saved beside it." };
    }
    if (!file.parent || !file.parent.exists()) {
      return { ok: false, message: "The attachment folder could not be found." };
    }
    return {
      ok: true,
      filePath: file.path,
      directory: file.parent.path,
      fileName: file.leafName,
    };
  }

  function listMarkdown(directory) {
    var folder = fileFor(directory);
    if (!folder.exists() || !folder.isDirectory()) return [];
    var entries = folder.directoryEntries;
    var files = [];
    while (entries.hasMoreElements()) {
      var child = entries.getNext().QueryInterface(Components.interfaces.nsIFile);
      if (!child.isFile()) continue;
      var lower = child.leafName.toLowerCase();
      if (!lower.endsWith(".md") && !lower.endsWith(".markdown")) continue;
      if (lower.endsWith(".zassistant.md") || lower.endsWith(".zassistant.tmp.md")) continue;
      files.push({
        name: child.leafName,
        path: child.path,
        size: child.fileSize,
        primary: child.leafName === PRIMARY_NAME || child.leafName === FALLBACK_NAME,
      });
    }
    files.sort(function (a, b) {
      return Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name, "zh");
    });
    return files;
  }

  async function readMarkdown(path) {
    var file = fileFor(path);
    if (!file.exists() || !file.isFile()) {
      throw new Error("That Markdown file could not be found.");
    }
    if (file.fileSize > 1500000) {
      throw new Error("This Markdown file is over 1.5 MB, so it is not opened in the pane.");
    }
    var text = await Zotero.File.getContentsAsync(file, "UTF-8");
    return { path: file.path, name: file.leafName, text: text || "" };
  }

  function existingNote(directory) {
    var primary = fileFor(joinPath(directory, PRIMARY_NAME));
    var fallback = fileFor(joinPath(directory, FALLBACK_NAME));
    if (primary.exists()) {
      return { file: primary, name: PRIMARY_NAME };
    }
    if (fallback.exists()) {
      return { file: fallback, name: FALLBACK_NAME };
    }
    return { file: primary, name: PRIMARY_NAME };
  }

  async function writeRound(location, input) {
    var chosen = existingNote(location.directory);
    var existing = "";
    if (chosen.file.exists()) {
      existing = (await Zotero.File.getContentsAsync(chosen.file, "UTF-8")) || "";
    }
    var rendered = ZoteroAssistantUtil.renderNoteFile({
      existing: existing,
      title: input.title,
      attachmentName: location.fileName,
      time: input.time,
      questions: input.questions,
      summary: input.summary,
    });
    var target = chosen.file;
    if (!rendered.ok) {
      target = fileFor(joinPath(location.directory, FALLBACK_NAME));
      var fallbackText = "";
      if (target.exists()) {
        fallbackText = (await Zotero.File.getContentsAsync(target, "UTF-8")) || "";
        if (fallbackText.trim() && fallbackText.indexOf(MARKER) === -1) {
          throw new Error("This folder already has a note with that name, and Zassistant did not write it. Move reading-note.md or reading-note-zassistant.md first.");
        }
      }
      rendered = ZoteroAssistantUtil.renderNoteFile({
        existing: fallbackText.indexOf(MARKER) === -1 ? "" : fallbackText,
        title: input.title,
        attachmentName: location.fileName,
        time: input.time,
        questions: input.questions,
        summary: input.summary,
      });
    }
    await Zotero.File.putContentsAsync(target, rendered.text);
    return { path: target.path, name: target.leafName, text: rendered.text };
  }

  function reveal(path) {
    try {
      Zotero.File.reveal(path);
      return true;
    } catch (error) {
      Zotero.debug("Zotero Assistant reveal: " + error);
      return false;
    }
  }

  async function chooseMarkdown(win, directory) {
    var module = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
    var picker = new module.FilePicker();
    picker.init(win, "Open Markdown", picker.modeOpen);
    picker.appendFilter("Markdown", "*.md; *.markdown");
    picker.appendFilters(picker.filterAll);
    if (directory) {
      try {
        picker.displayDirectory = directory;
      } catch (error) {}
    }
    var result = await picker.show();
    if (result !== picker.returnOK) return "";
    return picker.file || "";
  }

  return {
    PRIMARY_NAME: PRIMARY_NAME,
    locate: locate,
    listMarkdown: listMarkdown,
    readMarkdown: readMarkdown,
    writeRound: writeRound,
    reveal: reveal,
    chooseMarkdown: chooseMarkdown,
  };
})();
