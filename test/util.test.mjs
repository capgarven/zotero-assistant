import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const context = {};
vm.createContext(context);
vm.runInContext(readFileSync(new URL("../addon/content/scripts/util.js", import.meta.url), "utf8"), context);
const util = context.ZoteroAssistantUtil;

test("normalizes OpenAI-compatible endpoints", () => {
  assert.equal(util.normalizeEndpoint("https://api.openai.com/v1/"), "https://api.openai.com/v1/chat/completions");
  assert.equal(
    util.normalizeEndpoint("http://127.0.0.1:11434/v1/chat/completions"),
    "http://127.0.0.1:11434/v1/chat/completions",
  );
  assert.throws(() => util.normalizeEndpoint("ftp://example.com"), /http/);
});

test("parses server-sent events across chunk boundaries", () => {
  const first = util.extractSSEEvents('data: {"choices":[{"delta":{"content":"你"}}]}\r\n\r\n');
  assert.equal(first.events.length, 1);
  assert.equal(util.readStreamDelta(first.events[0]).content, "你");
  const split = util.extractSSEEvents('data: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n');
  assert.equal(split.events.length, 2);
  assert.equal(util.readStreamDelta(split.events[0]).content, "好");
  assert.equal(util.readStreamDelta(split.events[1]).done, true);
});

test("renders markdown without executing html", () => {
  const html = util.renderMarkdown(
    '# 标题\n\n<script>alert(1)</script>\n\n**要点** 与 `code`\n\n- 一条\n\n[安全](https://example.com)\n\n[坏](javascript:alert(1))\n\n![图](https://example.com/a.png)\n\n```js\nalert(1)\n```\n\n| 列 | 值 |\n| --- | --- |\n| A | 1 |\n',
  );
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("<img"), false);
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<strong>要点<\/strong>/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.equal(html.includes("javascript:"), false);
  assert.match(html, /<table>/);
  assert.match(html, /<pre><code>alert\(1\)/);
});

test("renders void tags that the XHTML item pane can parse", () => {
  const html = util.renderMarkdown("第一行\n第二行\n\n---\n\n结论");
  assert.equal(/<br>|<hr>/.test(html), false);
  assert.match(html, /第一行<br\/>第二行/);
  assert.match(html, /<hr\/>/);
});

test("keeps an unclosed fence inside a code block while streaming", () => {
  const html = util.renderMarkdown("正文\n```\nconst x = 1", { streaming: true });
  assert.match(html, /<pre><code>const x = 1/);
  assert.match(html, /<p>正文<\/p>/);
});

test("fits the paper context inside the character budget", () => {
  const fitted = util.fitContext({
    metadata: "标题：测试",
    selectedText: "选中",
    annotations: "",
    notes: "",
    fulltext: "正文".repeat(100),
    maxChars: 2000,
  });
  const prompt = util.buildSystemPrompt(fitted);
  assert.match(prompt, /标题：测试/);
  assert.match(prompt, /选中/);
  assert.match(prompt, /正文/);
  const tiny = util.fitContext({
    metadata: "标题",
    selectedText: "",
    annotations: "",
    notes: "",
    fulltext: "",
    fulltextError: "",
    maxChars: 2000,
  });
  assert.match(util.buildSystemPrompt(tiny), /paper text is not available/);
});

test("appends a marked reading note and refuses an unrelated file", () => {
  const created = util.renderNoteFile({
    existing: "",
    title: "一篇论文",
    attachmentName: "paper.pdf",
    time: "2026-11-03 00:20",
    questions: ["方法是什么？"],
    summary: "方法是对照实验。",
  });
  assert.equal(created.ok, true);
  assert.match(created.text, /<!-- zotero-assistant -->/);
  assert.match(created.text, /## 2026-11-03 00:20/);
  assert.match(created.text, /方法是什么？/);
  const appended = util.renderNoteFile({
    existing: created.text,
    title: "一篇论文",
    attachmentName: "paper.pdf",
    time: "2026-11-03 01:00",
    questions: ["局限呢？"],
    summary: "样本很小。",
  });
  assert.equal(appended.text.split("\n").filter((line) => line.startsWith("## ")).length, 2);
  const conflict = util.renderNoteFile({
    existing: "# 我自己的笔记\n",
    title: "一篇论文",
    attachmentName: "paper.pdf",
    time: "2026-11-03 01:00",
    questions: ["局限呢？"],
    summary: "样本很小。",
  });
  assert.equal(conflict.ok, false);
});

test("formats the note heading in local time", () => {
  assert.equal(util.formatNoteTime(new Date(2026, 10, 3, 0, 20)), "2026-11-03 00:20");
});
