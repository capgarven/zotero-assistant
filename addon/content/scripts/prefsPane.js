var ZoteroAssistantPrefs = (function () {
  function selectedService(menu) {
    return menu.value || menu.getAttribute("value") || "custom";
  }

  function selectService(menu, id) {
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
    var service = doc.getElementById("za-service");
    var endpoint = doc.getElementById("za-endpoint");
    var model = doc.getElementById("za-model");
    var secret = doc.getElementById("za-secret");
    var temperature = doc.getElementById("za-temperature");
    var prompt = doc.getElementById("za-prompt");
    var status = doc.getElementById("za-status");
    api.migrateLegacy();
    var shown = api.getPrefs().service || "deepseek";

    function fill(id) {
      var prefs = api.getServicePrefs(id);
      shown = id;
      selectService(service, id);
      endpoint.value = prefs.apiBase || "";
      model.value = prefs.model || "";
      secret.value = prefs.apiKey || "";
      temperature.value = String(prefs.temperature);
      prompt.value = prefs.prompt || "";
    }

    function save() {
      api.setServiceConfig(shown, {
        apiBase: endpoint.value.trim(),
        model: model.value.trim(),
        temperature: temperature.value,
      });
      api.setServiceSecret(shown, secret.value.trim());
      var next = api.getPrefs();
      next.prompt = prompt.value;
      api.setPrefs(next);
      secret.value = secret.value.trim();
    }

    fill(shown);
    [endpoint, model, secret, temperature, prompt].forEach(function (field) {
      field.addEventListener("blur", save);
    });
    service.addEventListener("command", function () {
      save();
      var id = selectedService(service);
      api.setSelectedService(id);
      fill(id);
      status.value = "";
    });
    doc.getElementById("za-test").addEventListener("command", async function () {
      save();
      status.value = "Testing…";
      try {
        var reply = await api.testConnection(api.getServicePrefs(shown));
        status.value = "Connected: " + (reply || "OK");
      } catch (error) {
        status.value = error && error.message ? error.message : String(error);
      }
    });
  }

  return { init: init };
})();
