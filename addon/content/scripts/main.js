var ZoteroAssistantMain = (function () {
  var PLUGIN_ID = "zotero-assistant@local";
  var PANE_ID = "zotero-assistant";
  var PREFIX = "extensions.zotero.zoteroassistant.";
  var DEFAULT_PROMPT = "Read the Markdown of the paper below. Answer only from that Markdown. If the paper does not contain the answer, say so. Do not invent pages, numbers, or citations. Reply in the language of the question.";
  var FTL = "zotero-assistant.ftl";
  var registeredPaneID = "";

  var PRESETS = [
    { id: "deepseek", label: "DeepSeek", apiBase: "https://api.deepseek.com/chat/completions", model: "deepseek-v4-pro", models: ["deepseek-v4-pro", "deepseek-flash"] },
    { id: "openai", label: "OpenAI", apiBase: "https://api.openai.com/v1/chat/completions", model: "gpt-6.1-sol", models: ["gpt-6.1-sol", "gpt-6-luna"] },
    { id: "qwen", label: "Qwen", apiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", model: "qwen3.8-max", models: ["qwen3.8-max", "qwen3.7-plus"] },
    { id: "kimi", label: "Kimi", apiBase: "https://api.moonshot.ai/v1/chat/completions", model: "kimi-k3.1-pro", models: ["kimi-k3.1-pro", "kimi-k3"] },
    { id: "gemini", label: "Gemini", apiBase: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", model: "gemini-3.8-flash", models: ["gemini-3.8-flash"] },
    { id: "ollama", label: "Ollama", apiBase: "http://127.0.0.1:11434/v1", model: "llama3.1", models: ["llama3.1"] },
    { id: "custom", label: "Custom", apiBase: "", model: "", models: [] },
  ];

  function readPref(name, fallback) {
    var value = Zotero.Prefs.get(PREFIX + name, true);
    return value === undefined || value === null ? fallback : value;
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

  function parseObject(value) {
    if (!value || typeof value !== "string") return {};
    try {
      var parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
      return {};
    }
  }

  function selectedServiceId() {
    return String(readPref("service", "deepseek") || "deepseek");
  }

  function readSecrets() {
    return parseObject(String(readPref("secrets", "{}") || "{}"));
  }

  function writeSecrets(secrets) {
    Zotero.Prefs.set(PREFIX + "secrets", JSON.stringify(secrets), true);
  }

  function migrateLegacy() {
    var selected = selectedServiceId();
    var secrets = readSecrets();
    var legacyKey = String(readPref("apiKey", "") || "");
    if (legacyKey && typeof secrets[selected] !== "string") {
      secrets[selected] = legacyKey;
      writeSecrets(secrets);
    }
    var legacyBase = String(readPref("apiBase", "") || "");
    var legacyModel = String(readPref("model", "") || "");
    var legacyTemperature = readPref("temperature", "");
    if (legacyBase && !readPref("service." + selected + ".endPoint", "")) {
      Zotero.Prefs.set(PREFIX + "service." + selected + ".endPoint", legacyBase, true);
    }
    if (legacyModel && !readPref("service." + selected + ".model", "")) {
      Zotero.Prefs.set(PREFIX + "service." + selected + ".model", legacyModel, true);
    }
    if (
      legacyTemperature !== "" &&
      legacyTemperature !== undefined &&
      legacyTemperature !== null &&
      !readPref("service." + selected + ".temperature", "")
    ) {
      Zotero.Prefs.set(PREFIX + "service." + selected + ".temperature", String(legacyTemperature), true);
    }
  }

  function getServiceSecret(serviceId) {
    migrateLegacy();
    var secrets = readSecrets();
    var saved = secrets[serviceId];
    if (typeof saved === "string" && saved) return saved;
    if (String(serviceId || "") === selectedServiceId()) {
      var legacy = String(readPref("apiKey", "") || "");
      if (legacy) return legacy;
    }
    return "";
  }

  function setServiceSecret(serviceId, secret) {
    var id = String(serviceId || "custom");
    var secrets = readSecrets();
    secrets[id] = String(secret || "").trim();
    writeSecrets(secrets);
    if (id === selectedServiceId()) Zotero.Prefs.set(PREFIX + "apiKey", secrets[id], true);
  }

  function setSelectedService(serviceId) {
    Zotero.Prefs.set(PREFIX + "service", String(serviceId || "custom"), true);
  }

  function setServiceConfig(serviceId, config) {
    var id = String(serviceId || "custom");
    var apiBase = String((config && config.apiBase) || "").trim();
    var model = String((config && config.model) || "").trim();
    var temperature = String(clamp(config && config.temperature, 0, 2, 0.2));
    Zotero.Prefs.set(PREFIX + "service." + id + ".endPoint", apiBase, true);
    Zotero.Prefs.set(PREFIX + "service." + id + ".model", model, true);
    Zotero.Prefs.set(PREFIX + "service." + id + ".temperature", temperature, true);
    if (id === selectedServiceId()) {
      Zotero.Prefs.set(PREFIX + "apiBase", apiBase, true);
      Zotero.Prefs.set(PREFIX + "model", model, true);
      Zotero.Prefs.set(PREFIX + "temperature", temperature, true);
    }
  }

  function readingPrefs() {
    var prompt = String(readPref("prompt", DEFAULT_PROMPT) || "");
    return {
      maxContextChars: Math.round(clamp(readPref("maxContextChars", 600000), 600000, 2000000, 600000)),
      includeFulltext: true,
      prompt: prompt.trim() || DEFAULT_PROMPT,
    };
  }

  function getServicePrefs(serviceId) {
    var id = String(serviceId || selectedServiceId());
    var preset = presetById(id);
    var reading = readingPrefs();
    var apiBase = String(readPref("service." + id + ".endPoint", "") || "");
    var model = String(readPref("service." + id + ".model", "") || "");
    var temperature = readPref("service." + id + ".temperature", "");
    if (!apiBase) apiBase = preset.apiBase || "";
    if (!model) model = preset.model || "";
    if (temperature === "" || temperature === undefined || temperature === null) temperature = "0.2";
    return {
      service: id,
      apiBase: apiBase,
      apiKey: getServiceSecret(id),
      model: model,
      temperature: clamp(temperature, 0, 2, 0.2),
      maxContextChars: reading.maxContextChars,
      includeFulltext: reading.includeFulltext,
      prompt: reading.prompt,
      models: preset.models ? preset.models.slice() : [],
    };
  }

  function getPrefs() {
    return getServicePrefs(selectedServiceId());
  }

  function setPrefs(prefs) {
    var id = String(prefs.service || selectedServiceId() || "custom");
    setSelectedService(id);
    setServiceConfig(id, prefs);
    setServiceSecret(id, prefs.apiKey || "");
    try {
      Zotero.Prefs.clear(PREFIX + "includeFulltext", true);
    } catch (error) {}
    if (prefs.prompt !== undefined) {
      Zotero.Prefs.set(PREFIX + "prompt", String(prefs.prompt || ""), true);
    }
    return getPrefs();
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
      migrateLegacy();
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
      "startup, AbortController " + (typeof AbortController) + ", setTimeout " + (typeof setTimeout),
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
    getServicePrefs: getServicePrefs,
    setPrefs: setPrefs,
    setSelectedService: setSelectedService,
    setServiceSecret: setServiceSecret,
    setServiceConfig: setServiceConfig,
    migrateLegacy: migrateLegacy,
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
