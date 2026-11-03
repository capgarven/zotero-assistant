var chromeHandle;

function install() {}

function uninstall() {}

async function startup({ id, version, rootURI }) {
  const base = rootURI && rootURI.endsWith("/") ? rootURI : `${rootURI}/`;
  const aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  const manifestURI = Services.io.newURI(base + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "zoteroassistant", base + "content/"],
    ["locale", "zoteroassistant", "en-US", base + "locale/en-US/"],
    ["locale", "zoteroassistant", "zh-CN", base + "locale/zh-CN/"],
    ["locale", "zoteroassistant", "zh-TW", base + "locale/zh-TW/"],
  ]);

  const files = [
    "content/scripts/util.js",
    "content/scripts/context.js",
    "content/scripts/ai.js",
    "content/scripts/notes.js",
    "content/scripts/pane.js",
    "content/scripts/prefsPane.js",
    "content/scripts/main.js",
  ];
  for (const file of files) {
    Services.scriptloader.loadSubScript(base + file);
  }
  await Zotero.ZoteroAssistant.startup({ id, version, rootURI: base });
}

async function onMainWindowLoad({ window }) {
  await Zotero.ZoteroAssistant?.onMainWindowLoad(window);
}

async function onMainWindowUnload({ window }) {
  await Zotero.ZoteroAssistant?.onMainWindowUnload(window);
}

async function shutdown(_data, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }
  try {
    await Zotero.ZoteroAssistant?.shutdown();
  } catch (error) {
    Zotero.logError(error);
  }
  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}
