# Zassistant

[中文](#中文) | [English](#english)

---

## 中文

Zassistant 是 Zotero 10 的条目面板插件。你可以就正在读的论文提问，也可以就一整个分组里的所有论文提问。论文以 Markdown 或 PDF 原文发给 AI。某一轮问答可以总结成 Markdown 笔记保存，下次在面板里直接阅读。

插件只支持 **Zotero 10**。

### 安装

1. 安装 [Zotero 10](https://www.zotero.org/download/)。
2. 安装 Python 和 MarkItDown：`pip install "markitdown[pdf]"`。插件会依次查找设置项 `extensions.zotero.zoteroassistant.python` 指定的 `python.exe`、常见的 Anaconda / Python 安装目录，以及 `PATH`。只用 PDF 模式时可以不装。
3. 从 [Releases](https://github.com/capgarven/zotero-assistant/releases) 下载最新的 `zotero-assistant-<版本>.xpi`，或在本目录运行 `npm run build`，得到 `dist/zotero-assistant-1.0.1.xpi`。
4. 在 Zotero 里打开「工具 → 插件」，点齿轮图标，选「从文件安装插件…」，选中这个 XPI，然后按提示重启。

安装后，右侧条目面板的侧栏会出现 Zassistant 图标。「工具」菜单和条目工具栏里也有入口，点一下会展开面板。

### 设置模型

打开「编辑 → 设置 → Zassistant」。**Models** 列表可以保存任意多套模型，每套有自己的接口、模型和密钥。点 **Add** 新建，点 **Remove** 删除。列表里会标出能读 PDF 的模型、缺少密钥的模型，以及当前正在使用的模型。

- **Name**：在面板里显示的名称。
- **Provider**：服务商。切换后会自动填入它的默认接口和模型。
- **Endpoint**：Chat Completions 的完整地址。只填到 `/v1` 也可以，插件会自动补上 `/chat/completions`。
- **Model**：模型名。输入框下方会列出推荐的模型。
- **Secret**：API 密钥，只保存在这台电脑的 Zotero 配置里。
- **Temperature**：部分思考模型会忽略这个参数。
- **Test**：发一句测试消息，确认连接可用。
- **Reads PDF files**：勾选后，来源选 PDF 时会使用这个模型。

| 服务商 | Endpoint | 模型 | 读取 PDF |
| --- | --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/chat/completions` | `deepseek-v4-pro`、`deepseek-flash` | 不支持 |
| OpenAI | `https://api.openai.com/v1/chat/completions` | `gpt-6.1-sol`、`gpt-6-luna` | 直接发送 PDF 文件 |
| 通义千问（北京） | `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions` | `qwen3.8-max`、`qwen3.8-flash`、`qwen3.7-plus` | 直接发送 PDF 文件（qwen3.8-max / qwen3.8-flash） |
| Kimi | `https://api.moonshot.ai/v1/chat/completions` | `kimi-k3`、`kimi-k3.1-pro` | 先上传 PDF，由 Kimi 解析出文字（含 OCR），再把文字发给模型 |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` | `gemini-3.8-flash` | 不支持（OpenAI 兼容接口不接收 PDF） |

通义千问的 `{WorkspaceId}` 要换成阿里云百炼控制台里的业务空间 ID。其他兼容 OpenAI Chat Completions 的服务，Provider 选 **Custom**，自己填 Endpoint 和 Model。

**Prompt** 是每次随论文一起发送的指令，可以随时修改。默认要求 AI 只依据论文作答，论文里没有的内容要明确说明，不要编造页码、数字或引用。

### 提问

打开一篇 PDF，或在文库里选中它，然后展开 Zassistant。面板分三部分：

- **顶栏**：显示当前的论文或分组。三个按钮分别是新对话、笔记、重新加载。
- **对话区**：你的问题显示在带边框的框里，上方注明这次问的范围和来源。AI 的回答直接铺开显示。思考过程折叠在「Thought for …」里，点开可以查看。回答和代码块都有 **Copy** 按钮。
- **输入框**：顶部的标签显示当前范围、选中文字、批注数和大约的 token 数。底部依次是三个下拉菜单：范围、来源、模型，以及保存笔记按钮和发送按钮。Enter 发送，Shift+Enter 换行。生成过程中按 Esc 或点停止按钮可以取消。

**范围**

- `@ This paper`：当前论文。阅读器里选中的文字、批注和条目笔记也会一起发送。
- `@ 分组名`：分组里的每一篇论文都会编号发送，AI 回答时按 [1]、[2] 这样的编号引用。点 **Subcollections** 标签，可以把子分组里的论文也包括进来。分组内容不会被截断，内容很多时面板会提示可能超出模型的上下文长度。

**来源**

- **Markdown**：用 MarkItDown 把 PDF 转成 Markdown 再发送。转换结果保存在 PDF 旁边的 `<PDF 文件名>.zassistant.md`，PDF 改过之后才会重新转换。转换失败时，改用 Zotero 的全文索引或当前页面上的文字。
- **PDF**：直接发送原始 PDF，模型可以看到图表和版式。如果当前模型读不了 PDF，插件会自动换成一个勾选了 Reads PDF files、并且填好接口、模型和密钥的模型；一个都没有时，改发 Markdown，并在面板里提示。

回答里的 LaTeX 公式（`$…$`、`$$…$$`、`\(…\)`、`\[…\]`）会排版成数学公式显示。复制出来的仍是原始 Markdown。

### 笔记

点保存笔记按钮，插件只整理上次保存之后的新问答。AI 写成 Markdown 后，插件补上时间和问题列表，再保存：

- 单篇论文的笔记保存在 PDF 所在的文件夹，文件名是 `reading-note.md`。如果那里已经有一份不是本插件创建的同名文件，就改写到 `reading-note-zassistant.md`，不会覆盖你自己的文件。
- 分组的笔记保存在 Zotero 数据目录下的 `zassistant/collections/<分组名> (<key>)/reading-note.md`。

如果已经有阅读笔记，下次打开这篇文献时面板会直接显示它。顶栏的笔记按钮会列出该文件夹里的所有 `.md` 文件，点文件名就能阅读：**Source** 查看原始 Markdown，**Open Markdown…** 打开别处的文件，**Show in folder** 在文件管理器里打开这个文件夹。

### 排查问题

每次转换、请求和报错都会记在 Zotero 数据目录下的 `zassistant.log`，例如 `C:\Users\<用户名>\Zotero\zassistant.log`。日志不会记录 API 密钥。

### 开发

```bash
npm install
npm test
npm run build
```

`npm test` 检查接口地址、流式响应、Markdown 和公式渲染、提示词拼装、PDF 附件和笔记文件。`npm run build` 生成可安装的 XPI。公式渲染使用打包在 `addon/content/lib/` 里的 [KaTeX](https://katex.org/)（MIT 许可）。

---

## English

Zassistant is an item pane plugin for Zotero 10. Ask about the paper you are reading, or about every paper in a collection. Each paper is sent to the AI as Markdown or as the original PDF. You can summarize a round of questions into a Markdown note and read it in the pane later.

Zassistant supports **Zotero 10** only.

### Install

1. Install [Zotero 10](https://www.zotero.org/download/).
2. Install Python and MarkItDown: `pip install "markitdown[pdf]"`. Zassistant looks for `python.exe` in the setting `extensions.zotero.zoteroassistant.python` first, then in common Anaconda and Python folders, then on `PATH`. You can skip this step if you only use PDF mode.
3. Download the latest `zotero-assistant-<version>.xpi` from [Releases](https://github.com/capgarven/zotero-assistant/releases), or run `npm run build` in this folder to get `dist/zotero-assistant-1.0.1.xpi`.
4. In Zotero, open **Tools → Plugins**, click the gear icon, choose **Install Plugin From File…**, pick the XPI, and restart when asked.

After you install it, a Zassistant icon appears in the side navigation of the item pane. The **Tools** menu and the items toolbar have a Zassistant entry that opens the pane.

### Set up models

Open **Edit → Settings → Zassistant**. The **Models** list holds as many models as you need, each with its own endpoint, model, and secret. Click **Add** to create one and **Remove** to delete one. The list marks models that read PDFs, models with no secret, and the model in use.

- **Name**: the label shown in the pane.
- **Provider**: the service. Changing it fills in that provider's default endpoint and model.
- **Endpoint**: the full Chat Completions URL. A URL that ends at `/v1` also works; Zassistant adds `/chat/completions`.
- **Model**: the model name. Suggested models are listed under the field.
- **Secret**: the API key. It is stored only in Zotero's settings on this computer.
- **Temperature**: some reasoning models ignore it.
- **Test**: sends a short message to check the connection.
- **Reads PDF files**: when checked, this model is used when the source is PDF.

| Provider | Endpoint | Models | PDF input |
| --- | --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/chat/completions` | `deepseek-v4-pro`, `deepseek-flash` | Not supported |
| OpenAI | `https://api.openai.com/v1/chat/completions` | `gpt-6.1-sol`, `gpt-6-luna` | Sends the PDF file |
| Qwen (Beijing) | `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions` | `qwen3.8-max`, `qwen3.8-flash`, `qwen3.7-plus` | Sends the PDF file (qwen3.8-max / qwen3.8-flash) |
| Kimi | `https://api.moonshot.ai/v1/chat/completions` | `kimi-k3`, `kimi-k3.1-pro` | Uploads the PDF, Kimi extracts the text (with OCR), and the text is sent |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` | `gemini-3.8-flash` | Not supported (the OpenAI-compatible API does not accept PDFs) |

For Qwen, replace `{WorkspaceId}` with the workspace ID from the Alibaba Cloud Model Studio console. For any other service that is compatible with OpenAI Chat Completions, choose **Custom** and fill in the endpoint and model.

The **Prompt** is the instruction sent with every paper, and you can change it at any time. By default, it tells the AI to answer only from the paper, to say so when the paper has no answer, and not to invent pages, numbers, or citations.

### Ask

Open a PDF, or select it in the library, then expand Zassistant. The pane has three parts:

- **Header**: shows the current paper or collection. Its three buttons start a new chat, open the notes, and reload.
- **Chat**: your questions appear in boxes, each labeled with its scope and source. Answers fill the full width. The model's reasoning is folded under "Thought for …"; click it to read. Every answer and every code block has a **Copy** button.
- **Composer**: the pills at the top show the scope, the selected text, the annotation count, and an estimated token count. Along the bottom are three menus, for scope, source, and model, then the save-note button and the send button. Press Enter to send and Shift+Enter for a new line. Press Esc or click the stop button to cancel a reply.

**Scope**

- `@ This paper`: the current paper. Text selected in the reader, annotations, and item notes are sent too.
- `@ <collection>`: every paper in the collection is sent, numbered, and the AI cites papers as [1], [2], and so on. Click the **Subcollections** pill to include papers from subcollections. A collection is never cut short; when it is very large, the pane warns that it may exceed the model's context window.

**Source**

- **Markdown**: MarkItDown converts the PDF to Markdown before it is sent. The result is saved next to the PDF as `<PDF name>.zassistant.md`, and is converted again only after the PDF changes. If the conversion fails, Zassistant uses Zotero's full-text index or the text on the current page instead.
- **PDF**: the original PDF is sent, so the model sees figures and layout. If the current model cannot read PDFs, Zassistant switches to a model that has **Reads PDF files** checked and has an endpoint, model, and secret. If no model qualifies, it sends Markdown and shows a notice.

LaTeX formulas in answers (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`) are typeset as math. **Copy** still copies the original Markdown.

### Notes

Click the save-note button to summarize the questions since the last save. The AI writes the note in Markdown, Zassistant adds the time and the list of questions, and then it saves the note:

- A paper's note is saved in the PDF's folder as `reading-note.md`. If that folder already has a `reading-note.md` that Zassistant did not create, the note goes to `reading-note-zassistant.md` instead, so your own file is never overwritten.
- A collection's note is saved in the Zotero data folder as `zassistant/collections/<collection> (<key>)/reading-note.md`.

When a paper already has a note, the pane shows it the next time you open that paper. The notes button in the header lists every `.md` file in the folder; click a name to read it. **Source** shows the raw Markdown, **Open Markdown…** opens a file from another folder, and **Show in folder** opens the folder in your file manager.

### Troubleshooting

Every conversion, request, and error is written to `zassistant.log` in the Zotero data folder, for example `C:\Users\<you>\Zotero\zassistant.log`. API keys are never written to the log.

### Development

```bash
npm install
npm test
npm run build
```

`npm test` checks endpoints, streamed replies, Markdown and math rendering, prompt assembly, PDF attachments, and note files. `npm run build` produces the installable XPI. Math is rendered with [KaTeX](https://katex.org/) (MIT license), bundled in `addon/content/lib/`.
