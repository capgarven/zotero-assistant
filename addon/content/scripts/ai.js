var ZoteroAssistantAI = (function () {
  function headers(prefs) {
    var result = { "Content-Type": "application/json" };
    if (prefs.apiKey) result.Authorization = "Bearer " + prefs.apiKey;
    return result;
  }

  function errorFromStatus(status, detail) {
    if (status === 401 || status === 403) {
      return "The API secret was rejected (" + status + "). Check the secret and the endpoint.";
    }
    if (status === 404) {
      return "The endpoint was not found (404). Use an OpenAI-compatible URL, or paste the full /chat/completions address.";
    }
    if (status === 429) return "The service is rate-limiting this request (429).";
    return detail || "The request failed (" + status + ").";
  }

  function messageFromJSON(json) {
    if (json && json.error) {
      throw new Error(json.error.message || "The service returned an error.");
    }
    var choice = json && json.choices && json.choices[0];
    var message = (choice && choice.message) || {};
    return {
      content: ZoteroAssistantUtil.textOf(message.content || (choice && choice.text)),
      reasoning: ZoteroAssistantUtil.textOf(message.reasoning_content || message.reasoning),
    };
  }

  function applyEvents(events, state, onDelta) {
    events.forEach(function (event) {
      var delta = ZoteroAssistantUtil.readStreamDelta(event);
      if (delta.ignore) return;
      if (delta.error) throw new Error(delta.error);
      if (delta.content || delta.reasoning) {
        state.content += delta.content || "";
        state.reasoning += delta.reasoning || "";
        if (onDelta) onDelta({ content: delta.content || "", reasoning: delta.reasoning || "" });
      }
    });
  }

  function statusError(status, raw) {
    var detail = "";
    try {
      var parsed = JSON.parse(raw || "");
      detail = (parsed.error && parsed.error.message) || parsed.message || "";
    } catch (error) {
      detail = String(raw || "").slice(0, 500);
    }
    var wrapped = new Error(errorFromStatus(status, detail));
    wrapped.status = status;
    wrapped.detail = detail;
    wrapped.retryWithoutTemperature = status === 400 && /temperature/i.test(detail);
    return wrapped;
  }

  function replyFromBody(raw) {
    var text = String(raw || "").trim();
    if (!text) return { content: "", reasoning: "" };
    if (text.charAt(0) === "{") return messageFromJSON(JSON.parse(text));
    var state = { content: "", reasoning: "" };
    var parsed = ZoteroAssistantUtil.extractSSEEvents(text + "\n\n");
    applyEvents(parsed.events, state, null);
    return state;
  }

  function textOfXhr(xmlhttp) {
    if (!xmlhttp) return "";
    try {
      if (typeof xmlhttp.response === "string" && xmlhttp.response) return xmlhttp.response;
      if (xmlhttp.response && typeof xmlhttp.response === "object") return JSON.stringify(xmlhttp.response);
    } catch (error) {}
    try {
      if (xmlhttp.responseText) return String(xmlhttp.responseText);
    } catch (error) {}
    return "";
  }

  function replySnippet(raw) {
    return String(raw || "")
      .replace(/sk-[A-Za-z0-9]+/g, "sk-…")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
  }

  function emptyReplyMessage(status, raw) {
    var extra = replySnippet(raw);
    var message = "The service returned no reply";
    if (status) message += " (HTTP " + status + ")";
    message += ".";
    if (extra) message += " " + extra;
    return message;
  }

  function chatPayload(prefs, messages, stream, omitTemperature) {
    var payload = {
      model: prefs.model,
      stream: !!stream,
      messages: messages,
    };
    var temperature = Number(prefs.temperature);
    if (!omitTemperature && Number.isFinite(temperature)) payload.temperature = temperature;
    return payload;
  }

  async function requestChat(options) {
    var prefs = options.prefs;
    var stream = !options.jsonFallback;
    var url = ZoteroAssistantUtil.normalizeEndpoint(prefs.apiBase);
    var body = JSON.stringify(chatPayload(prefs, options.messages, stream, options.omitTemperature));
    var hdrs = headers(prefs);
    var sent = { content: "", reasoning: "" };
    function emitTotals(total) {
      var content = (total && total.content) || "";
      var reasoning = (total && total.reasoning) || "";
      var contentDelta = content.indexOf(sent.content) === 0 ? content.slice(sent.content.length) : content;
      var reasoningDelta = reasoning.indexOf(sent.reasoning) === 0 ? reasoning.slice(sent.reasoning.length) : reasoning;
      if (content.length < sent.content.length) contentDelta = "";
      if (reasoning.length < sent.reasoning.length) reasoningDelta = "";
      sent.content = content.length >= sent.content.length ? content : sent.content;
      sent.reasoning = reasoning.length >= sent.reasoning.length ? reasoning : sent.reasoning;
      if (options.onDelta && (contentDelta || reasoningDelta)) {
        options.onDelta({ content: contentDelta, reasoning: reasoningDelta });
      }
    }
    function publishRaw(raw) {
      if (!raw) return null;
      try {
        var reply = replyFromBody(raw);
        emitTotals(reply);
        return reply;
      } catch (error) {
        return null;
      }
    }
    function watch(xmlhttp) {
      xmlhttp.onprogress = function (event) {
        var target = (event && event.target) || xmlhttp;
        try {
          if (target.timeout) target.timeout = 0;
        } catch (error) {}
        if (stream) publishRaw(textOfXhr(target));
      };
    }
    function stopOnAbort(cancel) {
      if (!options.signal) return;
      var stop = function () {
        try {
          cancel();
        } catch (error) {}
      };
      if (options.signal.aborted) stop();
      else options.signal.addEventListener("abort", stop, { once: true });
    }
    var xhr;
    try {
      if (options.signal && options.signal.aborted) throw aborted();
      xhr = await Zotero.HTTP.request("POST", url, {
        body: body,
        headers: hdrs,
        responseType: stream ? "text" : "json",
        timeout: 0,
        errorDelayMax: 0,
        requestObserver: watch,
        cancellerReceiver: stopOnAbort,
      });
    } catch (error) {
      if (options.signal && options.signal.aborted) throw aborted();
      if (ZoteroAssistantUtil.isAbortError(error)) throw error;
      var failed = error && (error.xmlhttp || error.xhr);
      var status = (failed && failed.status) || (error && error.status) || 0;
      ZoteroAssistantUtil.log("http failed, status " + status + (stream ? ", stream" : ", json"), error);
      if (!options.jsonFallback && status !== 401 && status !== 403 && status !== 404) {
        return requestChat({
          prefs: options.prefs,
          messages: options.messages,
          onDelta: options.onDelta,
          signal: options.signal,
          omitTemperature: options.omitTemperature,
          jsonFallback: true,
        });
      }
      var raw = textOfXhr(failed);
      if (status) throw statusError(status, raw);
      var detail = String((error && error.message) || "");
      throw new Error(
        detail || "Could not reach the API. Check the endpoint, the network, or whether the local model is running.",
      );
    }
    var status = xhr.status || 0;
    var raw = textOfXhr(xhr);
    ZoteroAssistantUtil.log(
      "http " + status + ", " + raw.length + " bytes, " + (stream ? "stream" : "json") + ", start " +
        JSON.stringify(replySnippet(raw).slice(0, 80)),
    );
    if (status < 200 || status >= 300) throw statusError(status, raw);
    var reply = publishRaw(raw);
    if (!sent.content && !sent.reasoning && !options.jsonFallback) {
      return requestChat({
        prefs: options.prefs,
        messages: options.messages,
        onDelta: options.onDelta,
        signal: options.signal,
        omitTemperature: options.omitTemperature,
        jsonFallback: true,
      });
    }
    if (!sent.content && !sent.reasoning) throw new Error(emptyReplyMessage(status, raw));
    return {
      content: sent.content || (reply && reply.content) || "",
      reasoning: sent.reasoning || (reply && reply.reasoning) || "",
    };
  }

  function aborted() {
    var error = new Error("Stopped");
    error.name = "AbortError";
    return error;
  }

  async function completeOnce(options) {
    return requestChat(options);
  }

  async function complete(options) {
    if (!options.prefs.model || !String(options.prefs.model).trim()) {
      throw new Error("Set a model in Settings → Zassistant → Config.");
    }
    try {
      return await completeOnce(options);
    } catch (error) {
      if (error && error.retryWithoutTemperature && !options.omitTemperature) {
        return completeOnce({
          prefs: options.prefs,
          messages: options.messages,
          onDelta: options.onDelta,
          signal: options.signal,
          omitTemperature: true,
        });
      }
      if (options.hasFiles && error && (error.status === 400 || error.status === 413)) {
        throw new Error(
          "The service did not accept the PDF (" + error.status + "). Pick a model that reads PDF files, or switch the source to Markdown." +
            (error.detail ? " " + error.detail : ""),
        );
      }
      if (error && /failed to fetch|networkerror|load failed/i.test(String(error.message))) {
        throw new Error("Could not reach the API. Check the endpoint, the network, or whether the local model is running.");
      }
      throw error;
    }
  }

  var encoded = new Map();

  function base64(binary) {
    if (typeof btoa === "function") return btoa(binary);
    return Zotero.getMainWindow().btoa(binary);
  }

  async function pdfPart(file) {
    var stamp = "";
    try {
      stamp = String(Zotero.File.pathToFile(file.path).lastModifiedTime);
    } catch (error) {}
    var key = file.path + "@" + stamp;
    if (!encoded.has(key)) {
      var binary = await Zotero.File.getBinaryContentsAsync(file.path);
      if (!binary) throw new Error("Could not read " + file.name + ".");
      encoded.set(key, "data:application/pdf;base64," + base64(binary));
      while (encoded.size > 12) encoded.delete(encoded.keys().next().value);
    }
    return { type: "file", file: { filename: file.name, file_data: encoded.get(key) } };
  }

  function filesEndpoint(apiBase) {
    return ZoteroAssistantUtil.normalizeEndpoint(apiBase).replace(/\/chat\/completions$/i, "/files");
  }

  async function responseError(response) {
    var raw = "";
    try {
      raw = await response.text();
    } catch (error) {}
    return statusError(response.status, raw);
  }

  async function extractedText(prefs, file, signal) {
    var cachePath = file.path + ".kimi.zassistant.md";
    var cache = Zotero.File.pathToFile(cachePath);
    var pdf = Zotero.File.pathToFile(file.path);
    if (cache.exists() && cache.lastModifiedTime >= pdf.lastModifiedTime) {
      var cached = String((await Zotero.File.getContentsAsync(cachePath, "UTF-8")) || "");
      if (cached.trim()) return cached;
    }
    var win = Zotero.getMainWindow();
    var base = filesEndpoint(prefs.apiBase);
    var auth = { Authorization: "Bearer " + prefs.apiKey };
    var form = new win.FormData();
    form.append("purpose", "file-extract");
    form.append("file", new win.File([await win.IOUtils.read(file.path)], file.name, { type: "application/pdf" }));
    var started = Date.now();
    var upload = await win.fetch(base, { method: "POST", headers: auth, body: form });
    if (!upload.ok) throw await responseError(upload);
    var uploaded = await upload.json();
    if (signal && signal.aborted) throw aborted();
    var fileURL = base + "/" + encodeURIComponent(uploaded.id);
    var text = "";
    try {
      var response = await win.fetch(fileURL + "/content", { headers: auth });
      if (!response.ok) throw await responseError(response);
      var raw = await response.text();
      text = raw;
      try {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed.content === "string") text = parsed.content;
      } catch (error) {}
    } finally {
      win.fetch(fileURL, { method: "DELETE", headers: auth }).catch(function () {});
    }
    if (!String(text).trim()) throw new Error("The service returned no text for " + file.name + ".");
    ZoteroAssistantUtil.log("file-extract: " + file.name + ", " + text.length + " chars in " + (Date.now() - started) + " ms");
    await Zotero.File.putContentsAsync(cachePath, text);
    return text;
  }

  async function withPdfFiles(messages, files, prefs, signal) {
    if (!files || !files.length) return messages;
    if (prefs && prefs.pdfTransport === "extract") {
      var extracted = [];
      for (var j = 0; j < files.length; j += 1) {
        if (signal && signal.aborted) throw aborted();
        extracted.push({
          role: "system",
          content: "Content of the PDF file \"" + files[j].name + "\":\n\n" + (await extractedText(prefs, files[j], signal)),
        });
      }
      return messages.slice(0, 1).concat(extracted, messages.slice(1));
    }
    var parts = [];
    for (var i = 0; i < files.length; i += 1) parts.push(await pdfPart(files[i]));
    return ZoteroAssistantUtil.attachToFirstUser(messages, parts);
  }

  async function testConnection(prefs) {
    var result = await complete({
      prefs: prefs,
      messages: [{ role: "user", content: "Reply with the single word OK." }],
      omitTemperature: false,
    });
    return result.content || "OK";
  }

  return {
    complete: complete,
    withPdfFiles: withPdfFiles,
    testConnection: testConnection,
  };
})();
