(function () {
  var api = Zotero.ZoteroAssistant;
  var args = (window.arguments && window.arguments[0]) || {};
  var serviceId = args.serviceId || api.getPrefs().service;
  var prefs = api.getServicePrefs(serviceId);
  var preset = api.PRESETS.find(function (item) {
    return item.id === serviceId;
  });
  var models = (prefs.models || []).slice();
  if (prefs.model && models.indexOf(prefs.model) === -1) models.unshift(prefs.model);
  var popup = document.getElementById("za-model-popup");
  models.forEach(function (model) {
    var item = document.createXULElement("menuitem");
    item.setAttribute("label", model);
    item.setAttribute("value", model);
    popup.appendChild(item);
  });
  document.getElementById("za-title").textContent = (preset && preset.label) || "Custom";
  document.getElementById("za-endpoint").value = prefs.apiBase || "";
  document.getElementById("za-model").value = prefs.model || "";
  document.getElementById("za-temperature").value = String(prefs.temperature);

  document.getElementById("za-cancel").addEventListener("command", function () {
    window.close();
  });
  document.getElementById("za-save").addEventListener("command", function () {
    api.setServiceConfig(serviceId, {
      apiBase: document.getElementById("za-endpoint").value.trim(),
      model: String(document.getElementById("za-model").value || "").trim(),
      temperature: document.getElementById("za-temperature").value,
    });
    window.close();
  });
})();
