var ZoteroAssistantMain = (function () {
  var PLUGIN_ID = "zotero-assistant@local";
  var PANE_ID = "zotero-assistant";
  var PREFIX = "extensions.zotero.zoteroassistant.";
  var DEFAULT_PROMPT = "Read the Markdown of the paper below. Answer only from that Markdown. If the paper does not contain the answer, say so. Do not invent pages, numbers, or citations. Reply in the language of the question.";
  var FTL = "zotero-assistant.ftl";
  var registeredPaneID = "";

  var PRESETS = [
    { id: "deepseek", label: "DeepSeek", apiBase: "https://api.deepseek.com/chat/completions", model: "deepseek-v4-pro", models: ["deepseek-v4-pro", "deepseek-flash"], pdf: "" },
    { id: "openai", label: "OpenAI", apiBase: "https://api.openai.com/v1/chat/completions", model: "gpt-6.1-sol", models: ["gpt-6.1-sol", "gpt-6-luna"], pdf: "file" },
    { id: "qwen", label: "Qwen", apiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", model: "qwen3.8-max", models: ["qwen3.8-max", "qwen3.8-flash", "qwen3.7-plus"], pdf: "file" },
    { id: "kimi", label: "Kimi", apiBase: "https://api.moonshot.ai/v1/chat/completions", model: "kimi-k3", models: ["kimi-k3", "kimi-k3.1-pro"], pdf: "extract" },
    { id: "gemini", label: "Gemini", apiBase: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", model: "gemini-3.8-flash", models: ["gemini-3.8-flash"], pdf: "" },
    { id: "custom", label: "Custom", apiBase: "", model: "", models: [], pdf: "file" },
  ];

  function readPref(name, fallback) {
    var value = Zotero.Prefs.get(PREFIX + name, true);
    return value === undefined || value === null ? fallback : value;
  }

  function writePref(name, value) {
    Zotero.Prefs.set(PREFIX + name, value, true);
  }

  function asBool(value, fallback) {
    if (value === undefined || value === null || value === "") return fallback;
    return !(value === false || value === "false" || value === 0 || value === "0");
  }

  function clamp(value, min, max, fallback) {
    var number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  function presetById(id) {
    for (var i = 0; i < PRESETS.length; i++) {
      if (PRESETS[i].id === id) return PRESETS[i];
    }
    return PRESETS[PRESETS.length - 1];
  }

  function parseJSON(value, fallback) {
    if (!value || typeof value !== "string") return fallback;
    try {
      var parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function readSecrets() {
    return parseJSON(String(readPref("secrets", "{}") || "{}"), {});
  }

  function writeSecrets(secrets) {
    writePref("secrets", JSON.stringify(secrets));
  }

  function newProfileId() {
    return "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function normalizeProfile(raw) {
    var provider = presetById(raw && raw.provider);
    var model = String((raw && raw.model) || "").trim();
    return {
      id: String((raw && raw.id) || newProfileId()),
      name: String((raw && raw.name) || "").trim() || model || provider.label,
      provider: provider.id,
      apiBase: String((raw && raw.apiBase) || "").trim(),
      model: model,
      temperature: clamp(raw && raw.temperature, 0, 2, 0.2),
      pdf: raw && raw.pdf !== undefined ? !!raw.pdf : !!provider.pdf,
    };
  }

  function legacyServiceProfiles() {
    var secrets = readSecrets();
    var selected = String(readPref("service", "deepseek") || "deepseek");
    var legacyKey = String(readPref("apiKey", "") || "");
    if (legacyKey && typeof secrets[selected] !== "string") {
      secrets[selected] = legacyKey;
      writeSecrets(secrets);
    }
    var list = [];
    ["deepseek", "openai", "qwen", "kimi", "gemini", "ollama", "custom"].forEach(function (id) {
      var base = String(readPref("service." + id + ".endPoint", "") || "");
      var model = String(readPref("service." + id + ".model", "") || "");
      if (id === selected) {
        base = base || String(readPref("apiBase", "") || "");
        model = model || String(readPref("model", "") || "");
      }
      if (!secrets[id] && !base && id !== selected) return;
      var preset = presetById(id === "ollama" ? "custom" : id);
      list.push(
        normalizeProfile({
          id: id,
          name: preset.id === "custom" ? model || "Custom" : preset.label + " " + (model || preset.model),
          provider: preset.id,
          apiBase: base || preset.apiBase,
          model: model || preset.model,
          temperature: readPref("service." + id + ".temperature", "0.2"),
          pdf: !!preset.pdf,
        }),
      );
    });
    return { list: list, selected: selected };
  }

  function readProfiles() {
    var saved = parseJSON(String(readPref("profiles", "") || ""), null);
    if (Array.isArray(saved) && saved.length) return saved.map(normalizeProfile);
    var legacy = legacyServiceProfiles();
    var list = legacy.list.length ? legacy.list : [defaultProfile("deepseek")];
    writeProfiles(list);
    var active = list.find(function (profile) {
      return profile.id === legacy.selected;
    });
    writePref("activeProfile", (active || list[0]).id);
    return list;
  }

  function writeProfiles(list) {
    writePref("profiles", JSON.stringify(list.map(normalizeProfile)));
  }

  function defaultProfile(providerId) {
    var preset = presetById(providerId);
    return normalizeProfile({
      id: newProfileId(),
      name: preset.id === "custom" ? "Custom" : preset.label + " " + preset.model,
      provider: preset.id,
      apiBase: preset.apiBase,
      model: preset.model,
      temperature: 0.2,
      pdf: !!preset.pdf,
    });
  }

  function activeProfileId() {
    var list = readProfiles();
    var id = String(readPref("activeProfile", "") || "");
    return list.some(function (profile) {
      return profile.id === id;
    })
      ? id
      : list[0].id;
  }

  function profileById(id) {
    var list = readProfiles();
    return (
      list.find(function (profile) {
        return profile.id === id;
      }) || list[0]
    );
  }

  function secretFor(id) {
    var value = readSecrets()[id];
    return typeof value === "string" ? value : "";
  }

  function isLocal(apiBase) {
    return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(String(apiBase || ""));
  }

  function getProfiles() {
    var secrets = readSecrets();
    return readProfiles().map(function (profile) {
      var copy = Object.assign({}, profile);
      copy.hasKey = !!secrets[profile.id] || isLocal(profile.apiBase);
      copy.providerLabel = presetById(profile.provider).label;
      return copy;
    });
  }

  function getProfile(id) {
    var profile = Object.assign({}, profileById(id));
    profile.apiKey = secretFor(profile.id);
    return profile;
  }

  function saveProfile(input) {
    var list = readProfiles();
    var profile = normalizeProfile(input);
    var index = list.findIndex(function (entry) {
      return entry.id === profile.id;
    });
    if (index === -1) list.push(profile);
    else list[index] = profile;
    writeProfiles(list);
    if (input.apiKey !== undefined) {
      var secrets = readSecrets();
      secrets[profile.id] = String(input.apiKey || "").trim();
      writeSecrets(secrets);
    }
    return profile;
  }

  function addProfile(providerId) {
    var profile = defaultProfile(providerId || "deepseek");
    var list = readProfiles();
    list.push(profile);
    writeProfiles(list);
    return profile;
  }

  function removeProfile(id) {
    var list = readProfiles();
    if (list.length <= 1) throw new Error("Keep at least one model.");
    writeProfiles(
      list.filter(function (profile) {
        return profile.id !== id;
      }),
    );
    var secrets = readSecrets();
    delete secrets[id];
    writeSecrets(secrets);
    if (String(readPref("activeProfile", "")) === id) writePref("activeProfile", readProfiles()[0].id);
  }

  function setActiveProfile(id) {
    writePref("activeProfile", String(profileById(id).id));
  }

  function readingPrefs() {
    var prompt = String(readPref("prompt", DEFAULT_PROMPT) || "");
    return {
      maxContextChars: Math.round(clamp(readPref("maxContextChars", 600000), 600000, 2000000, 600000)),
      prompt: prompt.trim() || DEFAULT_PROMPT,
      source: String(readPref("source", "markdown")) === "pdf" ? "pdf" : "markdown",
      deepCollections: asBool(readPref("deepCollections", false), false),
    };
  }

  function prefsFor(profile) {
    var preset = presetById(profile.provider);
    var reading = readingPrefs();
    return {
      profileId: profile.id,
      service: preset.id,
      serviceLabel: profile.name,
      providerLabel: preset.label,
      apiBase: profile.apiBase || preset.apiBase,
      apiKey: secretFor(profile.id),
      model: profile.model || preset.model,
      temperature: profile.temperature,
      supportsPdf: !!profile.pdf,
      pdfTransport: profile.pdf ? (preset.pdf === "extract" ? "extract" : "file") : "",
      localEndpoint: isLocal(profile.apiBase || preset.apiBase),
      maxContextChars: reading.maxContextChars,
      prompt: reading.prompt,
      source: reading.source,
      deepCollections: reading.deepCollections,
    };
  }

  function getPrefs() {
    return prefsFor(profileById(activeProfileId()));
  }

  function usable(profile, secrets) {
    var preset = presetById(profile.provider);
    var base = profile.apiBase || preset.apiBase;
    return !!(base && (profile.model || preset.model) && (secrets[profile.id] || isLocal(base)));
  }

  function pdfFallback(active) {
    var secrets = readSecrets();
    if (active.pdf && usable(active, secrets)) return active;
    return (
      readProfiles().find(function (profile) {
        return profile.pdf && usable(profile, secrets);
      }) || null
    );
  }

  function dropEmptyProfiles() {
    var secrets = readSecrets();
    var list = readProfiles();
    var kept = list.filter(function (profile) {
      return profile.apiBase || profile.model;
    });
    if (!kept.length || kept.length === list.length) return;
    writeProfiles(kept);
    list.forEach(function (profile) {
      if (kept.indexOf(profile) === -1) delete secrets[profile.id];
    });
    writeSecrets(secrets);
    if (!kept.some(function (profile) { return profile.id === String(readPref("activeProfile", "")); })) {
      writePref("activeProfile", kept[0].id);
    }
  }

  function getChatPrefs() {
    var active = profileById(activeProfileId());
    var reading = readingPrefs();
    var chosen = (reading.source === "pdf" && pdfFallback(active)) || active;
    var prefs = prefsFor(chosen);
    prefs.effectiveSource = reading.source === "pdf" && chosen.pdf && usable(chosen, readSecrets()) ? "pdf" : "markdown";
    prefs.switchedFrom = chosen.id !== active.id ? active.name : "";
    prefs.anyPdf = !!pdfFallback(active);
    return prefs;
  }

  function setSource(source) {
    var value = source === "pdf" ? "pdf" : "markdown";
    writePref("source", value);
    if (value === "pdf") {
      var choice = pdfFallback(profileById(activeProfileId()));
      if (choice) setActiveProfile(choice.id);
    }
  }

  function setDeepCollections(value) {
    writePref("deepCollections", !!value);
  }

  function setPrompt(text) {
    writePref("prompt", String(text || ""));
  }

  function getPython() {
    return String(readPref("python", "") || "").trim();
  }

  function setPython(path) {
    writePref("python", String(path || "").trim());
  }

  function installWindow(win) {
    if (!win || win.closed) return;
    try {
      win.MozXULElement?.insertFTLIfNeeded(FTL);
    } catch (error) {
      Zotero.debug("Zotero Assistant locale: " + error);
    }
    ZoteroAssistantPane.ensureStyle(win.document);
    addMenu(win);
    addToolbar(win);
  }

  function addMenu(win) {
    var doc = win.document;
    if (doc.getElementById("zotero-assistant-tools-item")) return;
    var popup = doc.getElementById("menu_ToolsPopup");
    if (!popup) return;
    var separator = doc.createXULElement("menuseparator");
    separator.id = "zotero-assistant-tools-separator";
    var item = doc.createXULElement("menuitem");
    item.id = "zotero-assistant-tools-item";
    item.setAttribute("label", "Zassistant");
    item.addEventListener("command", function () {
      reveal(win);
    });
    popup.appendChild(separator);
    popup.appendChild(item);
  }

  function addToolbar(win) {
    var doc = win.document;
    if (doc.getElementById("zotero-assistant-toolbar-button")) return;
    var toolbar = doc.getElementById("zotero-items-toolbar") || doc.getElementById("zotero-toolbar");
    if (!toolbar) return;
    var button = doc.createXULElement("toolbarbutton");
    button.id = "zotero-assistant-toolbar-button";
    button.className = "zotero-tb-button";
    button.setAttribute("tooltiptext", "Zassistant");
    button.style.listStyleImage = 'url("chrome://zoteroassistant/content/icons/pane-16.svg")';
    button.addEventListener("command", function () {
      reveal(win);
    });
    toolbar.appendChild(button);
  }

  function removeWindowUI(win) {
    if (!win || !win.document) return;
    ["zotero-assistant-tools-separator", "zotero-assistant-tools-item", "zotero-assistant-toolbar-button"].forEach(
      function (id) {
        var node = win.document.getElementById(id);
        if (node) node.remove();
      },
    );
  }

  function reveal(win) {
    var doc = win.document;
    try {
      if (win.ZoteroPane && typeof win.ZoteroPane.showContextPane === "function") {
        win.ZoteroPane.showContextPane();
      }
    } catch (error) {}
    var splitter = doc.getElementById("zotero-context-splitter");
    if (splitter && splitter.getAttribute("state") === "collapsed") {
      splitter.setAttribute("state", "open");
    }
    var section = doc.querySelector('item-pane-section[data-pane="' + PANE_ID + '"]');
    if (section) {
      try {
        section.collapsed = false;
      } catch (error) {}
      if (section.scrollIntoView) section.scrollIntoView({ block: "nearest" });
    }
    var button = doc.querySelector('button[data-pane="' + PANE_ID + '"]');
    if (button && button.getAttribute("aria-selected") !== "true") button.click();
  }

  function registerSection() {
    if (!Zotero.ItemPaneManager || !Zotero.ItemPaneManager.registerSection) {
      throw new Error("The item pane API is missing. Zassistant supports Zotero 10 only.");
    }
    registeredPaneID = Zotero.ItemPaneManager.registerSection({
      paneID: PANE_ID,
      pluginID: PLUGIN_ID,
      header: {
        l10nID: "zotero-assistant-pane-header",
        icon: "chrome://zoteroassistant/content/icons/pane-16.svg",
      },
      sidenav: {
        l10nID: "zotero-assistant-pane-sidenav",
        icon: "chrome://zoteroassistant/content/icons/pane-20.svg",
      },
      onItemChange: function (_event) {
        var item = _event.item;
        var enabled = false;
        try {
          enabled = !!item && !(item.isFeedItem && item.isFeedItem());
        } catch (error) {
          enabled = !!item;
        }
        _event.setEnabled(enabled);
        return true;
      },
      onRender: function (_event) {
        ZoteroAssistantPane.mount({
          body: _event.body,
          doc: _event.doc || _event.body.ownerDocument,
          item: _event.item,
          tabType: _event.tabType,
        });
      },
      onAsyncRender: function (_event) {
        return ZoteroAssistantPane.refresh(_event.body);
      },
      onDestroy: function (_event) {
        ZoteroAssistantPane.destroy(_event.body);
      },
    });
  }

  function registerPreferences() {
    if (!Zotero.PreferencePanes || !Zotero.PreferencePanes.register) return;
    Zotero.PreferencePanes.register({
      pluginID: PLUGIN_ID,
      src: "chrome://zoteroassistant/content/preferences.xhtml",
      label: "Zassistant",
      image: "chrome://zoteroassistant/content/icons/pane-20.svg",
    });
  }

  async function startup() {
    await Promise.all([Zotero.initializationPromise, Zotero.unlockPromise, Zotero.uiReadyPromise]);
    try {
      Zotero.ftl?.addResourceIds([FTL]);
    } catch (error) {
      Zotero.logError(error);
    }
    try {
      readProfiles();
      dropEmptyProfiles();
      Zotero.Prefs.clear(PREFIX + "includeFulltext", true);
    } catch (error) {
      Zotero.logError(error);
    }
    try {
      registerSection();
    } catch (error) {
      Zotero.logError(error);
    }
    try {
      registerPreferences();
    } catch (error) {
      Zotero.logError(error);
    }
    Zotero.getMainWindows().forEach(installWindow);
    ZoteroAssistantUtil.log(
      "startup, " + readProfiles().length + " models, active " + activeProfileId() +
        ", math " + (typeof ZoteroAssistantKatex !== "undefined" && ZoteroAssistantKatex ? "on" : "off"),
    );
    var python = getPython();
    (python ? ZoteroAssistantContext.checkPython(python) : ZoteroAssistantContext.detectPython()).then(
      function (result) {
        ZoteroAssistantUtil.log(
          "python " + (python ? "set" : "auto") + ": " + (result.path || "none") + ", " + (result.ok ? "ready" : result.message),
        );
      },
      function (error) {
        ZoteroAssistantUtil.log("python check failed: " + error);
      },
    );
  }

  function shutdown() {
    Zotero.getMainWindows().forEach(removeWindowUI);
    try {
      if (registeredPaneID) Zotero.ItemPaneManager.unregisterSection(registeredPaneID);
    } catch (error) {
      Zotero.debug("Zotero Assistant unregister section: " + error);
    }
    try {
      Zotero.ftl?.removeResourceIds([FTL]);
    } catch (error) {}
    delete Zotero.ZoteroAssistant;
  }

  Zotero.ZoteroAssistant = {
    PRESETS: PRESETS,
    getPrefs: getPrefs,
    getChatPrefs: getChatPrefs,
    getProfiles: getProfiles,
    getProfile: getProfile,
    saveProfile: saveProfile,
    addProfile: addProfile,
    removeProfile: removeProfile,
    activeProfileId: activeProfileId,
    setActiveProfile: setActiveProfile,
    prefsForProfile: function (id) {
      return prefsFor(profileById(id));
    },
    setSource: setSource,
    setDeepCollections: setDeepCollections,
    setPrompt: setPrompt,
    getPython: getPython,
    setPython: setPython,
    checkPython: function (path) {
      return path ? ZoteroAssistantContext.checkPython(path) : ZoteroAssistantContext.detectPython();
    },
    testConnection: function (prefs) {
      return ZoteroAssistantAI.testConnection(prefs || getPrefs());
    },
    reveal: reveal,
    onPrefsLoad: function (event) {
      ZoteroAssistantPrefs.init(event);
    },
    startup: startup,
    shutdown: shutdown,
    onMainWindowLoad: async function (win) {
      await Zotero.uiReadyPromise;
      installWindow(win);
    },
    onMainWindowUnload: async function (win) {
      removeWindowUI(win);
    },
  };
})();
