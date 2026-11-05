var ZoteroAssistantPrefs = (function () {
  var PDF_HINTS = {
    deepseek: "DeepSeek's chat API does not accept PDF files. Leave this unchecked.",
    gemini: "Gemini's OpenAI-compatible API does not accept PDF files. Leave this unchecked.",
    kimi: "Kimi reads a PDF through its file API: the PDF is uploaded, Kimi extracts the text (with OCR), and that text is sent.",
    openai: "The PDF is sent inside the request, so the model sees its pages and figures. The total limit is 50 MB.",
    qwen: "The PDF is sent inside the request. Use qwen3.8-max or qwen3.8-flash, which read PDF files.",
    custom: "Check this if the service accepts PDF files as Chat Completions file parts.",
  };

  function selectMenu(menu, id) {
    var item = menu.querySelector('menuitem[value="' + id + '"]');
    if (item) menu.selectedItem = item;
    menu.value = id;
  }

  function init(event) {
    var node = event && event.target;
    var win = node && (node.ownerGlobal || (node.ownerDocument && node.ownerDocument.defaultView));
    var doc = win && win.document;
    if (!doc || doc.documentElement.dataset.zaPrefs === "1") return;
    doc.documentElement.dataset.zaPrefs = "1";
    var api = Zotero.ZoteroAssistant;
    function $(id) {
      return doc.getElementById(id);
    }
    var list = $("za-profiles");
    var name = $("za-name");
    var provider = $("za-provider");
    var endpoint = $("za-endpoint");
    var model = $("za-model");
    var modelHint = $("za-model-hint");
    var secret = $("za-secret");
    var temperature = $("za-temperature");
    var pdf = $("za-pdf");
    var pdfHint = $("za-pdf-hint");
    var prompt = $("za-prompt");
    var status = $("za-status");
    var shown = api.activeProfileId();

    function preset(id) {
      return (
        api.PRESETS.find(function (entry) {
          return entry.id === id;
        }) || api.PRESETS[api.PRESETS.length - 1]
      );
    }

    function autoName(providerId, modelName) {
      var entry = preset(providerId);
      return entry.id === "custom" ? modelName || "Custom" : entry.label + " " + (modelName || entry.model);
    }

    function renderList() {
      var active = api.activeProfileId();
      list.replaceChildren();
      api.getProfiles().forEach(function (profile) {
        var option = doc.createElementNS("http://www.w3.org/1999/xhtml", "option");
        option.value = profile.id;
        option.textContent =
          profile.name +
          (profile.pdf ? "  · PDF" : "") +
          (profile.hasKey ? "" : "  · no key") +
          (profile.id === active ? "  · in use" : "");
        list.appendChild(option);
      });
      list.value = shown;
    }

    function paintHints() {
      var entry = preset(provider.value);
      modelHint.value = entry.models.length ? "Suggested: " + entry.models.join(", ") : "";
      pdfHint.textContent = PDF_HINTS[entry.id] || "";
    }

    function fill(id) {
      var profile = api.getProfile(id);
      shown = profile.id;
      name.value = profile.name;
      selectMenu(provider, profile.provider);
      endpoint.value = profile.apiBase;
      model.value = profile.model;
      secret.value = profile.apiKey || "";
      temperature.value = String(profile.temperature);
      pdf.checked = !!profile.pdf;
      status.value = "";
      paintHints();
      renderList();
    }

    function save() {
      api.saveProfile({
        id: shown,
        name: name.value.trim() || autoName(provider.value, model.value.trim()),
        provider: provider.value,
        apiBase: endpoint.value.trim(),
        model: model.value.trim(),
        temperature: temperature.value,
        pdf: pdf.checked,
        apiKey: secret.value.trim(),
      });
      api.setPrompt(prompt.value);
      renderList();
    }

    prompt.value = api.getPrefs().prompt || "";
    fill(shown);

    list.addEventListener("change", function () {
      if (!list.value || list.value === shown) return;
      save();
      fill(list.value);
    });
    [name, endpoint, secret, temperature, prompt].forEach(function (field) {
      field.addEventListener("change", save);
    });
    model.addEventListener("change", function () {
      var previous = api.getProfile(shown);
      if (!name.value.trim() || name.value === autoName(previous.provider, previous.model)) {
        name.value = autoName(provider.value, model.value.trim());
      }
      save();
    });
    pdf.addEventListener("command", save);
    provider.addEventListener("command", function () {
      var previous = api.getProfile(shown);
      if (previous.provider === provider.value) return;
      var entry = preset(provider.value);
      var renamed = !name.value.trim() || name.value === autoName(previous.provider, previous.model);
      endpoint.value = entry.apiBase;
      model.value = entry.model;
      pdf.checked = !!entry.pdf;
      if (renamed) name.value = autoName(entry.id, entry.model);
      paintHints();
      save();
    });
    $("za-add").addEventListener("command", function () {
      save();
      fill(api.addProfile("deepseek").id);
      name.focus();
    });
    $("za-remove").addEventListener("command", function () {
      try {
        api.removeProfile(shown);
        fill(api.activeProfileId());
      } catch (error) {
        status.value = error.message || String(error);
      }
    });
    $("za-test").addEventListener("command", async function () {
      save();
      status.value = "Testing…";
      try {
        var reply = await api.testConnection(api.prefsForProfile(shown));
        status.value = "Connected: " + (reply || "OK");
      } catch (error) {
        status.value = error && error.message ? error.message : String(error);
      }
    });
    win.addEventListener("unload", save);
    initPython(doc, win, api);
  }

  function initPython(doc, win, api) {
    var field = doc.getElementById("za-python");
    var status = doc.getElementById("za-python-status");
    var runs = 0;

    async function report(path) {
      var run = (runs += 1);
      status.textContent = path ? "Checking…" : "Searching for Python…";
      var result;
      try {
        result = await api.checkPython(path);
      } catch (error) {
        result = { ok: false, path: path, message: error && error.message ? error.message : String(error) };
      }
      if (run !== runs) return result;
      var where = !path && result.path ? "Found " + result.path + ". " : "";
      status.textContent = (result.ok ? "✓ " : "✗ ") + where + result.message;
      return result;
    }

    function commit() {
      api.setPython(field.value);
      report(field.value.trim());
    }

    field.value = api.getPython();
    field.addEventListener("change", commit);
    doc.getElementById("za-python-detect").addEventListener("command", async function () {
      var result = await report("");
      if (result.ok) {
        field.value = result.path;
        api.setPython(result.path);
      }
    });
    doc.getElementById("za-python-browse").addEventListener("command", async function () {
      try {
        var { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
        var picker = new FilePicker();
        picker.init(win, "Choose the Python executable", picker.modeOpen);
        if (Zotero.isWin) picker.appendFilter("python.exe", "python*.exe");
        picker.appendFilters(picker.filterAll);
        if ((await picker.show()) !== picker.returnOK) return;
        field.value = String((picker.file && picker.file.path) || picker.file);
        commit();
      } catch (error) {
        status.textContent = "✗ " + (error && error.message ? error.message : String(error));
      }
    });
    if (field.value.trim()) report(field.value.trim());
  }

  return { init: init };
})();
