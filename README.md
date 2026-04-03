# 🐾 OpenClaw Desktop v2

A Tauri-based desktop chat client for the OpenClaw Gateway. Lightweight, fast, native.

## Features

- **Full streaming chat** — token-by-token display as responses arrive
- **Drag & drop files** — drop any file to attach it to your message
- **Clipboard screenshots** — Ctrl+V to paste screenshots directly
- **Markdown rendering** — code blocks with syntax highlighting, tables, lists
- **Dark obsidian theme** — sleek, modern dark UI
- **Auto-reconnect** — exponential backoff reconnection
- **Chat history** — loads previous messages on connect
- **Abort generation** — stop button during streaming
- **Settings panel** — configurable gateway URL and auth
- **Copy code blocks** — one-click copy on code blocks
- **Smart auto-scroll** — scrolls to bottom unless you've scrolled up

## Quick Start

### Prerequisites

- [Rust](https://rustup.rs/) (1.70+)
- [Node.js](https://nodejs.org/) (18+)
- System deps (Ubuntu): `apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev libgtk-3-dev libjavascriptcoregtk-4.1-dev libsoup-3.0-dev`
- System deps (Windows): WebView2 (comes with Windows 10/11)

### Development

```bash
npm install
npm run dev
```

### Build

```bash
# Linux
npm run build

# Windows (cross-compile or native)
npm run build:win
```

## Configuration

On first launch, click the ⚙️ settings button to configure:

- **Gateway URL**: `ws://100.124.75.56:18791` (Tailscale) or `ws://localhost:18791` (local)
- **Auth Token**: Your OpenClaw gateway token
- **Password**: Fallback password auth

Settings are saved in the browser's localStorage.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Enter | Send message |
| Shift+Enter | New line |
| Ctrl+V | Paste screenshot |
| Ctrl+L | Focus input |
| Escape | Close settings |

## Architecture

- **Backend**: Rust + Tauri 2 (WebSocket client, file I/O)
- **Frontend**: Vanilla JS + HTML + CSS (no framework overhead)
- **Markdown**: marked.js + highlight.js
- **Protocol**: OpenClaw Gateway JSON-RPC over WebSocket

## Gateway Protocol

The app communicates via JSON-RPC 2.0 over WebSocket:

- `connect` — authenticate with token/password
- `chat.send` — send message (non-blocking, streams back via events)
- `chat.history` — fetch prior messages
- `chat.abort` — stop generation
- Streaming events arrive as `{ method: "chat", params: { type: "delta", text: "..." } }`

## License

MIT
