# Zassistant

Zotero 10 的条目面板插件。打开一篇 PDF 时，插件用 MarkItDown 把整篇论文转成 Markdown，连同你在设置里写好的提示词一起发给 AI，再就这篇论文回答你的问题。某一轮问答可以总结成 Markdown 笔记，存到 PDF 旁边；下次打开同一篇文献时，在面板里直接阅读。

插件只支持 **Zotero 10**。

## 安装

1. 安装 [Zotero 10](https://www.zotero.org/download/)。
2. 安装 Python 和 MarkItDown：`pip install "markitdown[pdf]"`。插件会依次查找设置项 `extensions.zotero.zoteroassistant.python` 指定的 `python.exe`、常见的 Anaconda / Python 安装目录，以及 `PATH`。
3. 在本目录运行 `npm run build`，得到 `dist/zotero-assistant-1.0.0.xpi`。
4. 打开 Zotero，进入「工具 → 插件」，点齿轮图标，选「从文件安装插件…」，选中这个 XPI，然后按提示重启。

安装后，右侧条目面板的侧栏会出现 Zassistant 图标。「工具」菜单和条目工具栏里也有 Zassistant 入口，点一下会展开这个面板。

## 连接模型

打开「编辑 → 设置 → Zassistant」：

- **Service**：选择服务商。切换后，该服务的 Endpoint、Model、Secret 会分别保存。
- **Endpoint**：Chat Completions 的完整地址。只填到 `/v1` 也可以，插件会自动补上 `/chat/completions`。
- **Model**：模型名。
- **Secret**：API 密钥，只保存在这台电脑的 Zotero 配置里。
- **Temperature**：部分思考模型会忽略这个参数。
- **Test**：发一句测试消息，确认连接可用。

| 服务 | Endpoint | 模型 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/chat/completions` | `deepseek-v4-pro`、`deepseek-flash` |
| OpenAI | `https://api.openai.com/v1/chat/completions` | `gpt-6.1-sol`、`gpt-6-luna` |
| 通义千问（北京） | `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions` | `qwen3.8-max`、`qwen3.7-plus` |
| Kimi | `https://api.moonshot.ai/v1/chat/completions` | `kimi-k3.1-pro`、`kimi-k3` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` | `gemini-3.8-flash` |

通义千问的 `{WorkspaceId}` 要换成阿里云百炼控制台里的业务空间 ID。设置里默认填的是旧域名 `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`，阿里云正在把用户迁到上表的新域名。

其他兼容 OpenAI Chat Completions 的服务，选 **Custom**，自己填 Endpoint 和 Model。

**Prompt** 是每次随论文一起发送的指令，可以随时修改。默认要求 AI 只依据论文作答，论文里没有的内容要明确说明，不要编造页码、数字或引用。

## 提问

打开一篇 PDF，或在文库里选中它，然后展开 Zassistant：

1. 面板第一次打开某篇 PDF 时，状态栏显示 `Converting the PDF to Markdown…`。转换结果保存在 PDF 旁边的 `<PDF 文件名>.zassistant.md`。下次直接读取，PDF 被改过才会重新转换。
2. 在 **Ask** 页输入问题：Enter 发送，Shift+Enter 换行。阅读器里选中的文字、批注和条目笔记也会一起发送。
3. 思考模型会先显示思考过程，再显示回答。回答出来之前，可以点 **Stop** 取消。

发给 AI 的内容依次是：提示词、题录、摘要、选中文字、批注、条目笔记、整篇论文的 Markdown。MarkItDown 转换失败时，改用 Zotero 的全文索引，或当前页面上的文字。

**Refresh** 会重新读取论文和题录。

## 把一轮问答写成笔记

点 **Summarize**，插件只整理上次保存之后的新问答。模型写成 Markdown 后，插件补上时间和问题列表，保存到 PDF 所在的文件夹：

- 默认文件名是 `reading-note.md`。
- 如果文件夹里已经有一份不是本插件创建的 `reading-note.md`，就改写 `reading-note-zassistant.md`，不会覆盖你自己的文件。

## 阅读笔记

如果 PDF 旁边已有阅读笔记，下次打开这篇文献时面板会直接显示它。

**Notes** 页列出该文件夹里的 `.md` 文件，点文件名即可阅读。阅读时可用的按钮：

- **Source**：查看原始 Markdown。
- **All notes**：回到文件列表。
- **Open Markdown**：打开别的位置的 Markdown 文件。
- **Show in folder**：在文件管理器里打开这个文件夹。

## 排查问题

每次转换、请求和报错都会记在 Zotero 数据目录下的 `zassistant.log`，例如 `C:\Users\<用户名>\Zotero\zassistant.log`。日志不会记录 API 密钥。

## 开发

```bash
npm test
npm run build
```

`npm test` 检查接口地址、流式响应、Markdown 渲染和笔记文件拼装。`npm run build` 生成可安装的 XPI。
