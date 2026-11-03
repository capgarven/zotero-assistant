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
      if (error && /failed to fetch|networkerror|load failed/i.test(String(error.message))) {
        throw new Error("Could not reach the API. Check the endpoint, the network, or whether the local model is running.");
      }
      throw error;
    }
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
    testConnection: testConnection,
  };
})();
