<h1 align="center">TheOne for Codex</h1>

<p align="center"><b>Too many Codex sessions to find anything? Talk in one main chat and let it pick up the right thread.</b><br>Every message is routed to the matter it belongs to; each matter keeps its own Codex session and context, so you can come back days later and carry on.</p>

<p align="center">
  <img alt="Codex desktop / CLI" src="https://img.shields.io/badge/Codex-desktop%20%7C%20CLI-1f6feb">
  <img alt="Free and open source, MIT" src="https://img.shields.io/badge/open%20source-MIT-3c873a">
  <img alt="Ported from DSH TheOne 0.4.6" src="https://img.shields.io/badge/ported%20from-DSH%20TheOne%200.4.6-a75b1e">
</p>

<p align="center"><a href="./README.md">简体中文</a> | English</p>

<p align="center"><b>Install:</b> on Windows, download the zip from <a href="https://github.com/YunongDai2005/theone-codex/releases/latest">Releases</a>, extract it and double-click "安装 TheOne" (Install TheOne); or tell Codex "install https://github.com/YunongDai2005/theone-codex".</p>

<p align="center"><img src="./docs/images/topic-cells.png" alt="Under New chat in the Codex sidebar: the TheOne main-chat card, and below it the topic cells, with the current topic lit" width="380"></p>

---

TheOne started as a plugin for [DeepSeek Harness (DSH)](https://github.com/YunongDai2005/dsh-theone). This is its Codex edition: topics, routing, fact records and the cell interface are ported from DSH TheOne 0.4.6, and model calls use your existing Codex sign-in.

## The problem

- "Where was that conversation again?" Dozens of sessions in the Codex sidebar, and the old one is gone.
- "I'll just ask here." One session collects everything, and details vanish at the next compaction.
- "I told you this already." A new session does not know what an old one settled.

**What TheOne does:** you talk in one main chat. TheOne decides which matter each message belongs to (conversation routing) and sends it to that matter's own Codex session; something new gets a new topic. Answers come back to the main chat, so you only ever see one conversation.

## How routing works

Each message takes the first of these that applies:

1. **You named a topic**: it goes there.
2. **Pre-routing**: routing starts in the background the moment you press send, while the main model is still thinking. By the time the main model hands the task over, the result is usually ready.
3. **The main model's judgement**: the main chat's model has read the whole conversation and knows what "continue" or "that one" refers to. When it is confident and the topic checks out, TheOne uses its choice without another model call.
4. **The routing model**: one model call on your Codex sign-in, with a second look when the first answer is shaky. The prompt, validation and recheck rules are the same as in DSH.
5. **Local rules**: the fallback if a model call fails.

The routing model defaults to GPT-6 Luna at low reasoning effort and can be changed in settings. Measured on 8 sample messages: when the main model hands over after 3 seconds, the median extra wait is 1.5 s; after 5 seconds it is 0. See [pre-routing measurement](evidence/preroute-latency.json) and [model latency](evidence/router-latency-luna-low.json).

## Features

- **One Codex session per matter**: contexts stay apart; topics in the same project queue so they never edit the same files at once.
- **Topic cells**: under New chat sits the main-chat card, and under it a cell for each topic. Cells that are working, waiting for you or freshly answered show their names; the rest show them when the pointer comes near. Drop one cell on another to merge; drop a message on another cell to reroute it.
- **Fix a wrong route**: Recent topic routing lists where each message went, with "Move to …" beside likely mistakes and Undo after a move. Rerouting changes where a message belongs and never silently undoes work already done. Likely duplicates are joined by a dotted line for you to decide.
- **Checks the target before acting**: before a topic first writes a file or runs a command for a message, it asks once in main chat if that message might belong to another topic or the target lies outside the topic's folder; when routing is confident it just proceeds.
- **Keep talking while it works**: additions during a reply join that reply; other matters go to their own topics, up to three working at once. Returning to a topic after three days or more, it opens with "last recorded as …".
- **One-off asides**: a quick "how many cm in an inch" is answered and folds away, and the main chat returns to the topic you were on.
- **Facts with sources**: settled numbers and decisions are kept with their source and version; when a cited fact changes, the topics using it are told.
- **Organise past chats**: with your consent, a model of your choice reads the sessions you pick and turns them into topic cells. Read-only; your sessions stay as they are.
- **Privacy**: a topic can be private (never shared with other topics) or excluded (kept out of routing and search).
- **Your existing Codex sign-in**: no API key to enter. It uses your Codex account's model quota.

## Install

**Windows (recommended):**

1. Download `TheOne-for-Codex-<version>-windows.zip` from [Releases](https://github.com/YunongDai2005/theone-codex/releases/latest) and extract all of it.
2. Double-click **安装 TheOne.cmd** (Install TheOne). Node is bundled.
3. Quit Codex completely and start it from the **Codex TheOne** desktop shortcut; the main-chat card sits under New chat.

The installer registers the plugin and patches a local copy of Codex desktop, leaving your original install and shortcuts untouched. The interface patch targets Codex desktop `26.1103.4239.0`; on other builds only the plugin is installed (find it under Explore / More, or use `$theone` in project chats). Older installs are migrated with their topic data. To remove it, double-click **卸载 TheOne.cmd** (Uninstall); topic data is kept by default.

**Let Codex install it:** tell Codex "install https://github.com/YunongDai2005/theone-codex". It follows [INSTALL.md](INSTALL.md) to download, verify and run the installer, and asks before changing your Codex configuration.

**macOS / Linux (plugin only):** requires Node.js 24 or later.

```bash
git clone https://github.com/YunongDai2005/theone-codex.git && cd theone-codex && npm ci --ignore-scripts && npm run build
```

```bash
codex plugin marketplace add "$PWD/release" && codex plugin add theone@theone-codex
```

## Compared with the DSH edition

| | DSH | Codex |
|---|---|---|
| Model | The provider configured in DSH | Your Codex sign-in |
| When routing runs | Before the answer starts | Alongside the main model's thinking |
| Main model helps route | No | Yes, used when confident |
| Message bridges (WeChat, Telegram, iMessage) | Yes | No (needs the DSH server) |
| Tool-card mirroring | Yes | No (DSH host only) |

Full capability table: [implementation record](docs/implementation-status.md).

## FAQ

**Does it cost extra quota?** Not when the main model is confident. When the routing model is needed, a message costs one extra low-effort call; organising past chats is billed on the model you choose.

**Is the interface patch safe?** It only changes the local copy of Codex desktop it makes, never your original install or your chat data. After Codex updates, run the installer again.

**How do I report a problem?** Settings has Feedback at the bottom: it gathers versions and routing diagnostics (no chat content) for you to copy into [Issues](https://github.com/YunongDai2005/theone-codex/issues) or an email.

**Is this an official OpenAI project?** No. TheOne is an independent open-source project, not affiliated with OpenAI.

## Verification

Passed before 0.1.0: `npm run check` (type check, 231 unit tests, build), `npm run client:test` (42), 16 installer tests and the packaging checks. The Windows package ran a full install and uninstall against an isolated Codex configuration: plugin registered and enabled, client patch generated, MCP server started, data kept after uninstall.

## Origin and licence

MIT. The core is ported from [YunongDai2005/dsh-theone](https://github.com/YunongDai2005/dsh-theone); sources and commits are listed in [UPSTREAM.md](UPSTREAM.md).
