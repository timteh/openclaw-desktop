// OpenClaw Desktop v2 — Frontend Logic
// Gateway WebSocket chat client with streaming, attachments, markdown

(() => {
  'use strict';

  // ---- Config defaults ----
  const DEFAULT_URL = 'ws://100.124.75.56:18791';
  const DEFAULT_TOKEN = '2f82c41c9fa07294686be9171f31e316224f679d58d875eb';
  const DEFAULT_PASSWORD = 'tim0teh';
  const FILE_SERVER_BASE = 'http://100.124.75.56:18789/files';
  const HEARTBEAT_INTERVAL = 15000;
  const RECONNECT = { initialMs: 500, maxMs: 10000, factor: 1.5, jitter: 0.3, maxAttempts: 20 };

  // ---- State ----
  let ws = null;  // kept for readyState tracking
  let wsConnected = false;  // Rust-side connection state
  let msgId = 1;
  let connected = false;
  let sessionKey = null;
  let deviceToken = null;
  let isStreaming = false;
  let streamingMsgEl = null;
  let streamBuffer = '';
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let userScrolled = false;
  let pendingAttachments = [];
  let currentRunId = null;
  let typingIndicator = null;
  const pendingRpc = new Map();

  // ---- DOM refs ----
  const $ = s => document.querySelector(s);
  const chatContainer = $('#chat-container');
  const chatMessages = $('#chat-messages');
  const messageInput = $('#message-input');
  const sendBtn = $('#send-btn');
  const abortBtn = $('#abort-btn');
  const attachBtn = $('#attach-btn');
  const settingsBtn = $('#settings-btn');
  const settingsOverlay = $('#settings-overlay');
  const settingsClose = $('#settings-close');
  const settingsSave = $('#settings-save');
  const settingsCancel = $('#settings-cancel');
  const settingUrl = $('#setting-url');
  const settingToken = $('#setting-token');
  const settingPassword = $('#setting-password');
  const connectionBadge = $('#connection-badge');
  const dropOverlay = $('#drop-overlay');
  const attachmentBar = $('#attachment-bar');
  const attachmentChips = $('#attachment-chips');

  // ---- Marked config ----
  marked.setOptions({
    highlight: (code, lang) => {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    },
    breaks: true,
    gfm: true,
  });

  // Custom renderer for code blocks with copy button
  const renderer = new marked.Renderer();
  const origCode = renderer.code;
  renderer.code = function({ text, lang }) {
    const langLabel = lang || 'code';
    const escaped = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const highlighted = lang && hljs.getLanguage(lang)
      ? hljs.highlight(text, { language: lang }).value
      : hljs.highlightAuto(text).value;
    return `<pre><div class="code-header"><span>${langLabel}</span><button class="copy-btn" onclick="copyCode(this)">Copy</button></div><code class="hljs language-${langLabel}">${highlighted}</code></pre>`;
  };
  marked.use({ renderer });

  // Global copy function
  window.copyCode = function(btn) {
    const code = btn.closest('pre').querySelector('code');
    const text = code.textContent;
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = 'Copy';
        btn.classList.remove('copied');
      }, 2000);
    });
  };

  // ---- Settings ----
  function loadSettings() {
    return {
      url: localStorage.getItem('oc_url') || DEFAULT_URL,
      token: localStorage.getItem('oc_token') || DEFAULT_TOKEN,
      password: localStorage.getItem('oc_password') || DEFAULT_PASSWORD,
    };
  }

  function saveSettings(url, token, password) {
    localStorage.setItem('oc_url', url);
    localStorage.setItem('oc_token', token);
    localStorage.setItem('oc_password', password);
  }

  // ---- Connection (via Tauri Rust backend — bypasses origin restrictions) ----
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  // Set up Tauri event listeners (once) — MUST complete before connect()
  let listenersReady = Promise.all([
    listen('ws-message', (event) => {
      try {
        const data = JSON.parse(event.payload);
        handleMessage(data);
      } catch (e) {
        console.error('Parse error:', e, event.payload);
      }
    }),
    listen('ws-status', (event) => {
      const status = event.payload;
      console.log('[ws-status]', status);
      if (status.connected) {
        wsConnected = true;
        isConnecting = false;
        reconnectAttempt = 0;
      } else {
        wsConnected = false;
        connected = false;
        sessionKey = null;
        isConnecting = false;
        for (const [, p] of pendingRpc) { clearTimeout(p.timer); p.reject(new Error('disconnected')); }
        pendingRpc.clear();
        setConnectionStatus('disconnected', status.message || 'Connection lost');
        scheduleReconnect();
      }
    })
  ]);

  let isConnecting = false;
  async function connect() {
    if (isConnecting) return;
    const settings = loadSettings();
    wsConnected = false;
    connected = false;
    isConnecting = true;
    setConnectionStatus('connecting');

    try {
      await invoke('ws_connect', { url: settings.url });
      // ws-status event will fire from Rust side
    } catch (e) {
      isConnecting = false;
      setConnectionStatus('disconnected', String(e));
      scheduleReconnect();
    }
  }

  function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function wsSend(method, params = {}) {
    if (!wsConnected) return null;
    const id = uuidv4();
    const msg = JSON.stringify({ type: 'req', id, method, params });
    invoke('ws_send_raw', { message: msg }).catch(e => {
      console.error('ws_send_raw failed:', e);
    });
    return id;
  }

  function rpcCall(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = wsSend(method, params);
      if (!id) { reject(new Error('not connected')); return; }
      const timer = setTimeout(() => {
        pendingRpc.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, 30000);
      pendingRpc.set(id, { resolve, reject, timer });
    });
  }

  async function disconnect() {
    try {
      await invoke('ws_disconnect');
    } catch (_) {}
    wsConnected = false;
    connected = false;
    sessionKey = null;
    for (const [, p] of pendingRpc) { clearTimeout(p.timer); p.reject(new Error('disconnected')); }
    pendingRpc.clear();
    setConnectionStatus('disconnected');
    stopHeartbeat();
  }

  function scheduleReconnect() {
    if (reconnectAttempt >= RECONNECT.maxAttempts) {
      addSystemMessage('Max reconnect attempts reached. Click settings to reconnect.');
      return;
    }
    const delay = Math.min(
      RECONNECT.initialMs * Math.pow(RECONNECT.factor, reconnectAttempt),
      RECONNECT.maxMs
    ) * (1 + (Math.random() - 0.5) * RECONNECT.jitter * 2);
    reconnectAttempt++;
    setConnectionStatus('connecting', `Reconnecting in ${(delay / 1000).toFixed(1)}s (${reconnectAttempt}/${RECONNECT.maxAttempts})`);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
  }

  function setConnectionStatus(status, detail) {
    connectionBadge.className = `badge badge-${status}`;
    if (status === 'connected') {
      connectionBadge.textContent = 'Connected';
    } else if (status === 'connecting') {
      connectionBadge.textContent = detail || 'Connecting...';
    } else {
      connectionBadge.textContent = detail ? `Disconnected: ${detail}` : 'Disconnected';
    }
  }

  // Extract text from message content (handles string, content array, or nested message)
  function extractText(msg) {
    if (!msg) return '';
    if (typeof msg === 'string') return msg;
    if (typeof msg.content === 'string') return msg.content;
    if (typeof msg.text === 'string') return msg.text;
    if (Array.isArray(msg.content)) {
      const parts = [];
      for (const c of msg.content) {
        // Skip tool blocks — they don't contain displayable text
        if (c.type === 'toolCall' || c.type === 'tool_use' || c.type === 'toolResult' || c.type === 'tool_result') continue;
        if (c.text) parts.push(c.text);
      }
      if (parts.length > 0) return parts.join('\n');
    }
    // Try nested message object (gateway history format)
    if (msg.message) return extractText(msg.message);
    // Try delta/chunk fields
    if (msg.delta) return extractText(msg.delta);
    return '';
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (wsConnected) {
        wsSend('ping', {});
      }
    }, HEARTBEAT_INTERVAL);
  }

  function stopHeartbeat() {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  async function sendConnect(nonce) {
    const settings = loadSettings();
    const connectParams = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'openclaw-control-ui',
        version: '1.0.0',
        platform: 'win32',
        mode: 'ui',
        deviceFamily: 'Windows'
      },
      role: 'operator',
      scopes: ['operator.admin', 'operator.read', 'operator.write', 'operator.approvals', 'operator.pairing'],
      caps: ['tool_events'],
      commands: [],
      permissions: {},
      userAgent: 'openclaw-control-ui/1.0.0',
      locale: 'en-US'
    };
    if (nonce) {
      try {
        const deviceData = await invoke('sign_device_v3', {
          req: {
            clientId: 'openclaw-control-ui',
            clientMode: 'ui',
            role: 'operator',
            scopes: ['operator.admin', 'operator.read', 'operator.write', 'operator.approvals', 'operator.pairing'],
            token: settings.token || '',
            nonce: nonce,
            platform: 'win32',
            deviceFamily: 'Windows'
          }
        });
        connectParams.device = deviceData;
      } catch (e) {
        console.error('Failed to sign device capability:', e);
      }
    }
    if (settings.token) {
      connectParams.auth = { token: settings.token };
    } else if (settings.password) {
      connectParams.auth = { password: settings.password };
    }
    wsSend('connect', connectParams);
  }

  async function setupSession() {
    let key = null;
    try {
      const res = await rpcCall('sessions.resolve', { label: 'desktop-session' });
      key = res?.key;
    } catch {
      // Session not found — try creating
    }
    if (!key) {
      try {
        const res = await rpcCall('sessions.create', { label: 'desktop-session' });
        key = res?.key;
      } catch (e) {
        addSystemMessage(`Session setup failed: ${e.message}`);
        return;
      }
    }
    if (!key) {
      addSystemMessage('Session setup failed: no key in response');
      return;
    }
    sessionKey = key;
    // Subscribe to streaming events
    try { await rpcCall('sessions.subscribe', {}); } catch (e) { console.warn('sessions.subscribe:', e.message); }
    try { await rpcCall('sessions.messages.subscribe', { key: sessionKey }); } catch (e) { console.warn('sessions.messages.subscribe:', e.message); }
    wsSend('chat.history', { sessionKey, limit: 50 });
  }

  // ---- Message handling ----
  function handleMessage(data) {
    // Gateway protocol: { type: "res", id, ok, payload/error } or { type: "event", event, payload }

    // Route responses to pending rpcCall promises
    if (data.type === 'res' && data.id && pendingRpc.has(data.id)) {
      const p = pendingRpc.get(data.id);
      pendingRpc.delete(data.id);
      clearTimeout(p.timer);
      if (data.ok) {
        p.resolve(data.payload);
      } else {
        p.reject(new Error(data.error?.message || JSON.stringify(data.error)));
      }
      return;
    }

    // Handle connect.challenge — gateway sends this before we can send connect
    if (data.type === 'event' && data.event === 'connect.challenge') {
      sendConnect(data.payload.nonce);
      return;
    }

    // Handle responses
    if (data.type === 'res') {
      if (!data.ok) {
        const errMsg = data.error?.message || JSON.stringify(data.error);
        if (!connected) {
          setConnectionStatus('disconnected', errMsg);
        } else {
          addSystemMessage(`Error: ${errMsg}`);
        }
        return;
      }

      // Connect response
      if (!connected && data.payload && data.payload.type === 'hello-ok') {
        connected = true;
        if (data.payload.auth?.deviceToken) {
          deviceToken = data.payload.auth.deviceToken;
          localStorage.setItem('oc_deviceToken', deviceToken);
        }
        setConnectionStatus('connected');
        setupSession();
        return;
      }

      // chat.history response
      if (data.payload && Array.isArray(data.payload.messages)) {
        const welcome = chatMessages.querySelector('.welcome-msg');
        if (welcome) welcome.remove();
        
        data.payload.messages.forEach(msg => {
          const text = extractText(msg);
          if (!text) return; // skip empty messages
          if (msg.role === 'user') {
            addUserMessage(text, msg.attachments);
          } else if (msg.role === 'assistant') {
            addAssistantMessage(text, msg);
          }
        });
        scrollToBottom(true);
        return;
      }

      // chat.send ack
      if (data.payload && data.payload.runId) {
        currentRunId = data.payload.runId;
        if (data.payload.status === 'started') {
          showAbortBtn(true);
        }
        return;
      }
      return;
    }

    // Handle events
    if (data.type === 'event') {
      const evtPayload = data.payload || {};
      const evtSessionKey = evtPayload.sessionKey;

      // Filter: only show chat/message/tool/agent events for the CURRENT session
      if (data.event === 'chat' || data.event === 'chat.delta' || data.event === 'chat.completion'
          || data.event === 'session.message' || data.event === 'session.tool' || data.event === 'agent') {
        if (evtSessionKey && sessionKey && evtSessionKey !== sessionKey) return;
      }

      if (data.event === 'chat.delta') {
        handleDelta(evtPayload.delta || evtPayload.text || extractText(evtPayload));
      } else if (data.event === 'chat.completion') {
        handleFinalMessage(evtPayload);
      } else if (data.event === 'chat') {
        handleChatEvent(evtPayload);
      }
      return;
    }

    // Legacy fallback for any other format
    if (data.error) {
      addSystemMessage(`Error: ${data.error.message || JSON.stringify(data.error)}`);
      return;
    }
  }

  function handleChatEvent(params) {
    if (!params) return;

    // Gateway chat events have params.state: 'delta' | 'final' | 'aborted' | 'error'
    const state = params.state;

    switch (state) {
      case 'delta': {
        // Accumulated text — replace buffer
        const text = extractText(params.message || {});
        if (text) handleDelta(text, true);
        break;
      }

      case 'final':
        handleFinalMessage(params);
        break;

      case 'aborted':
        finishStreaming();
        addSystemMessage('Response aborted.');
        break;

      case 'error':
        addSystemMessage(`Stream error: ${params.errorMessage || 'Unknown'}`);
        finishStreaming();
        break;

      case 'run_complete':
        finishStreaming();
        break;

      default:
        // Legacy format fallback
        if (params.type === 'delta' || params.event === 'delta') {
          handleDelta(params.text || params.delta?.text || '');
        } else if (params.type === 'final' || params.type === 'message') {
          handleFinalMessage(params);
        } else if (params.text && !params.role) {
          handleDelta(params.text);
        } else if (params.content && params.role === 'assistant') {
          handleFinalMessage(params);
        }
        break;
    }
  }

  function handleDelta(text, replace) {
    if (!text) return;
    hideTypingIndicator();

    // Clear welcome message
    const welcome = chatMessages.querySelector('.welcome-msg');
    if (welcome) welcome.remove();

    if (!streamingMsgEl) {
      streamingMsgEl = createMessageElement('assistant');
      streamBuffer = '';
    }

    streamBuffer = replace ? text : streamBuffer + text;
    isStreaming = true;
    showAbortBtn(true);
    renderStreamContent();
    autoScroll();
  }

  function handleFinalMessage(params) {
    const content = extractText(params.message || params) || params.content || params.text || '';
    if (streamingMsgEl) {
      // Finalize streaming message
      if (content) streamBuffer = content;
      renderStreamContent();
      finishStreaming();
    } else if (content) {
      // Standalone final message
      hideTypingIndicator();
      const welcome = chatMessages.querySelector('.welcome-msg');
      if (welcome) welcome.remove();
      addAssistantMessage(content);
    }
    // If no content and no streaming in progress, keep typing indicator alive —
    // the agent is likely doing tool calls and will send text later.
  }

  function handleToolCall(params) {
    if (!streamingMsgEl) {
      streamingMsgEl = createMessageElement('assistant');
      streamBuffer = '';
    }
    const name = params.name || params.tool || 'tool';
    const input = params.input || params.arguments || params.params || {};
    const toolEl = document.createElement('div');
    toolEl.className = 'tool-call';
    toolEl.innerHTML = `
      <div class="tool-header" onclick="this.nextElementSibling.classList.toggle('open')">
        ⚡ ${escapeHtml(name)}
      </div>
      <div class="tool-body">${escapeHtml(typeof input === 'string' ? input : JSON.stringify(input, null, 2))}</div>
    `;
    const contentEl = streamingMsgEl.querySelector('.msg-content');
    contentEl.appendChild(toolEl);
    autoScroll();
  }

  function handleToolResult(params) {
    // Tool results displayed inline if relevant
    const result = params.content || params.result || params.output || '';
    if (result && streamingMsgEl) {
      const toolEls = streamingMsgEl.querySelectorAll('.tool-call');
      const last = toolEls[toolEls.length - 1];
      if (last) {
        const body = last.querySelector('.tool-body');
        const resultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        if (resultText.length < 500) {
          body.textContent += '\n→ ' + resultText;
        }
      }
    }
  }

  function renderStreamContent() {
    if (!streamingMsgEl) return;
    const contentEl = streamingMsgEl.querySelector('.msg-content');
    // Preserve tool call elements
    const toolCalls = contentEl.querySelectorAll('.tool-call');
    
    try {
      const rendered = marked.parse(streamBuffer);
      // Create a temp container
      const temp = document.createElement('div');
      temp.innerHTML = rendered;
      
      // Clear text nodes and non-tool elements, keep tool calls
      const fragment = document.createDocumentFragment();
      temp.childNodes.forEach(n => fragment.appendChild(n.cloneNode(true)));
      
      contentEl.innerHTML = '';
      contentEl.appendChild(fragment);
      toolCalls.forEach(tc => contentEl.appendChild(tc));
      
      contentEl.classList.add('streaming-cursor');
    } catch (e) {
      // Fallback: plain text
      contentEl.textContent = streamBuffer;
    }
  }

  function showTypingIndicator() {
    if (typingIndicator) return;
    typingIndicator = document.createElement('div');
    typingIndicator.className = 'msg msg-assistant';
    typingIndicator.innerHTML = `
      <div class="msg-label msg-label-assistant">🐾 Claw</div>
      <div class="typing-dots">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>`;
    chatMessages.appendChild(typingIndicator);
    autoScroll();
  }

  function hideTypingIndicator() {
    if (typingIndicator) { typingIndicator.remove(); typingIndicator = null; }
  }

  function finishStreaming() {
    hideTypingIndicator();
    if (streamingMsgEl) {
      const contentEl = streamingMsgEl.querySelector('.msg-content');
      contentEl.classList.remove('streaming-cursor');
      // Re-render final markdown cleanly
      if (streamBuffer) {
        const toolCalls = contentEl.querySelectorAll('.tool-call');
        try {
          contentEl.innerHTML = marked.parse(streamBuffer);
        } catch (e) {
          contentEl.textContent = streamBuffer;
        }
        toolCalls.forEach(tc => contentEl.appendChild(tc));
        renderFileChips(contentEl, streamBuffer);
      }
    }
    streamingMsgEl = null;
    streamBuffer = '';
    isStreaming = false;
    currentRunId = null;
    showAbortBtn(false);
    autoScroll();
  }

  // ---- Message creation ----
  function createMessageElement(role) {
    const el = document.createElement('div');
    el.className = `msg msg-${role}`;
    
    const label = document.createElement('div');
    label.className = `msg-label msg-label-${role}`;
    label.textContent = role === 'user' ? 'You' : '🐾 Claw';
    el.appendChild(label);

    const content = document.createElement('div');
    content.className = 'msg-content';
    el.appendChild(content);

    chatMessages.appendChild(el);
    return el;
  }

  function addUserMessage(text, attachments) {
    const el = createMessageElement('user');
    const contentEl = el.querySelector('.msg-content');
    contentEl.textContent = text;

    if (attachments && attachments.length > 0) {
      const attDiv = document.createElement('div');
      attDiv.className = 'msg-attachments';
      attachments.forEach(att => {
        const chip = document.createElement('span');
        chip.className = 'msg-attachment-chip';
        chip.textContent = `📎 ${att.name || 'file'}`;
        attDiv.appendChild(chip);
      });
      el.appendChild(attDiv);
    }
    autoScroll();
    return el;
  }

  function addAssistantMessage(content, msgObj) {
    const el = createMessageElement('assistant');
    const contentEl = el.querySelector('.msg-content');
    try {
      contentEl.innerHTML = marked.parse(content);
    } catch (e) {
      contentEl.textContent = content;
    }
    renderFileChips(contentEl, content, msgObj);
    autoScroll();
    return el;
  }

  function addSystemMessage(text) {
    const el = document.createElement('div');
    el.className = 'msg msg-system';
    el.textContent = text;
    chatMessages.appendChild(el);
    autoScroll();
  }

  // ---- File detection & download ----
  const FILE_PATTERNS = [
    /MEDIA:(\S+)/g,
    /(?:saved to|generated at|wrote to|created|File:)\s+[`"]?(\S+\.(?:pdf|docx|xlsx|pptx|png|jpg|jpeg|gif|webp|txt|md|csv|json|zip|tar|gz))[`"]?/gi,
    /\/root\/\.openclaw\/workspace\/[^\s`")\]]+/g,
    /\/root\/\.openclaw\/media\/[^\s`")\]]+/g,
    /\/tmp\/[^\s`")\]]+\.(?:pdf|docx|xlsx|pptx|png|jpg|jpeg|gif|webp|txt|md|csv|json|zip)/g,
  ];
  const MD_LINK_RE = /\[([^\]]+)\]\((sandbox:)?([^)]+)\)/g;

  function resolveMediaUrl(ref) {
    if (!ref) return null;
    ref = ref.replace(/^sandbox:/, '');
    if (ref.startsWith('http://') || ref.startsWith('https://')) return ref;
    if (ref.startsWith('/root/.openclaw/workspace/'))
      return `${FILE_SERVER_BASE}/workspace/${ref.slice('/root/.openclaw/workspace/'.length)}`;
    if (ref.startsWith('/root/.openclaw/media/'))
      return `${FILE_SERVER_BASE}/media/${ref.slice('/root/.openclaw/media/'.length)}`;
    if (ref.startsWith('/tmp/'))
      return `${FILE_SERVER_BASE}/workspace${ref}`;
    if (ref.match(/\.\w{2,5}$/))
      return `${FILE_SERVER_BASE}/media/outbound/${ref}`;
    return null;
  }

  function detectFileReferences(text) {
    if (!text) return [];
    const files = new Set();
    for (const pattern of FILE_PATTERNS) {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(text)) !== null) {
        const p = (m[1] || m[0]).replace(/[`"]/g, '');
        if (p) files.add(p);
      }
    }
    MD_LINK_RE.lastIndex = 0;
    let mdm;
    while ((mdm = MD_LINK_RE.exec(text)) !== null) {
      if (mdm[3] && /\.(csv|pdf|xlsx|docx|json|txt|md|png|jpg|jpeg|gif|webp|zip|tar|gz)$/i.test(mdm[3]))
        files.add(mdm[3]);
    }
    return [...files];
  }

  function extractAttachments(msg) {
    const atts = [];
    if (!msg) return atts;
    if (Array.isArray(msg.attachments)) {
      for (const a of msg.attachments) {
        const path = a.url || a.path || a.MediaPath || '';
        atts.push({
          fileName: a.fileName || a.name || path.split('/').pop() || 'file',
          mimeType: a.mimeType || a.contentType || guessMime(path),
          url: resolveMediaUrl(path),
          content: a.content,
        });
      }
    }
    if (msg.MediaPath) atts.push({ fileName: msg.MediaPath.split('/').pop(), mimeType: guessMime(msg.MediaPath), url: resolveMediaUrl(msg.MediaPath) });
    if (Array.isArray(msg.MediaPaths)) msg.MediaPaths.forEach(p => atts.push({ fileName: p.split('/').pop(), mimeType: guessMime(p), url: resolveMediaUrl(p) }));
    if (msg.mediaUrl) atts.push({ fileName: msg.mediaUrl.split('/').pop(), url: resolveMediaUrl(msg.mediaUrl) });
    if (Array.isArray(msg.mediaUrls)) msg.mediaUrls.forEach(u => atts.push({ fileName: u.split('/').pop(), url: resolveMediaUrl(u) }));
    return atts;
  }

  function guessMime(path) {
    const ext = (path || '').split('.').pop()?.toLowerCase();
    return { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp',
      pdf:'application/pdf', csv:'text/csv', json:'application/json', txt:'text/plain', md:'text/markdown' }[ext] || 'application/octet-stream';
  }

  function getFileIcon(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (['png','jpg','jpeg','gif','webp'].includes(ext)) return '🖼️';
    if (ext === 'pdf') return '📄';
    if (['docx','doc'].includes(ext)) return '📝';
    if (['xlsx','xls','csv'].includes(ext)) return '📊';
    if (['md','txt'].includes(ext)) return '📃';
    if (['zip','tar','gz'].includes(ext)) return '📦';
    return '📎';
  }

  function isImageFile(name) { return /\.(png|jpg|jpeg|gif|webp)$/i.test(name); }

  function renderFileChips(contentEl, text, msgObj) {
    const textFiles = detectFileReferences(text);
    const metaAtts = extractAttachments(msgObj);
    const seen = new Set();
    const all = [];

    for (const a of metaAtts) {
      if (a.url && !seen.has(a.fileName)) { seen.add(a.fileName); all.push(a); }
    }
    for (const path of textFiles) {
      const name = path.split('/').pop();
      if (!seen.has(name)) {
        seen.add(name);
        all.push({ fileName: name, url: resolveMediaUrl(path), mimeType: guessMime(path) });
      }
    }
    if (all.length === 0) return;

    const images = all.filter(f => f.url && isImageFile(f.fileName));
    const files = all.filter(f => f.url && !isImageFile(f.fileName));

    if (images.length > 0) {
      const grid = document.createElement('div');
      grid.className = 'msg-image-grid';
      images.forEach(img => {
        const wrap = document.createElement('div');
        wrap.className = 'msg-image-preview';
        const imgEl = document.createElement('img');
        imgEl.src = img.url;
        imgEl.alt = img.fileName;
        imgEl.loading = 'lazy';
        imgEl.onerror = () => wrap.remove();
        wrap.appendChild(imgEl);
        const ov = document.createElement('div');
        ov.className = 'img-overlay';
        ov.innerHTML = `<button class="file-download-btn" title="Download ${escapeHtml(img.fileName)}">⬇️</button>`;
        ov.querySelector('button').onclick = (e) => { e.stopPropagation(); downloadFile(img.url, img.fileName); };
        wrap.appendChild(ov);
        grid.appendChild(wrap);
      });
      contentEl.appendChild(grid);
    }

    if (files.length > 0) {
      const container = document.createElement('div');
      container.className = 'file-chips-container';
      files.forEach(file => {
        const chip = document.createElement('div');
        chip.className = 'file-chip';
        chip.innerHTML = `<span class="file-icon">${getFileIcon(file.fileName)}</span><span class="file-name">${escapeHtml(file.fileName)}</span><span class="file-download-btn">⬇️</span>`;
        chip.title = `Download ${file.fileName}`;
        chip.onclick = () => downloadFile(file.url, file.fileName);
        container.appendChild(chip);
      });
      contentEl.appendChild(container);
    }
  }

  async function downloadFile(url, fileName) {
    const resolved = url && url.startsWith('http') ? url : resolveMediaUrl(url);
    if (!resolved) { addSystemMessage('Cannot download: unknown path'); return; }
    try {
      // Try fetch + blob download first
      const response = await fetch(resolved);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = fileName || resolved.split('/').pop() || 'download';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { a.remove(); URL.revokeObjectURL(blobUrl); }, 1000);
    } catch (e) {
      // Fallback: open in system browser via Tauri opener or window.open
      try {
        if (window.__TAURI__?.opener?.openUrl) {
          await window.__TAURI__.opener.openUrl(resolved);
          addSystemMessage(`Opening ${fileName || 'file'} in browser...`);
        } else {
          window.open(resolved, '_blank');
          addSystemMessage(`Opening ${fileName || 'file'} in browser...`);
        }
      } catch (e2) {
        addSystemMessage(`Download failed: ${e.message}`);
      }
    }
  }

  // ---- Send message ----
  function sendMessage() {
    const text = messageInput.value.trim();
    if (!text && pendingAttachments.length === 0) return;

    // Handle slash commands (except inject, which sends as chat)
    if (text.startsWith('/') && pendingAttachments.length === 0) {
      const parsed = parseCommandInput(text);
      if (parsed && parsed.cmd.action !== 'inject') {
        messageInput.value = '';
        autoResizeInput();
        closeCommandMenu();
        const { cmd, args } = parsed;
        if (cmd.action === 'local') handleLocalCommand(cmd, args);
        else if (cmd.action === 'rpc') {
          if (cmd.requiresConfirm) showConfirmDialog(cmd, args);
          else executeRpcCommand(cmd, args);
        }
        return;
      }
    }

    if (!connected) {
      addSystemMessage('Not connected. Check settings.');
      return;
    }

    // Clear welcome
    const welcome = chatMessages.querySelector('.welcome-msg');
    if (welcome) welcome.remove();

    // Show user message
    addUserMessage(text, pendingAttachments.map(a => ({ name: a.name })));

    // Build params — deliver:false means we receive the response via events
    const params = {
      message: text || '',
      sessionKey,
      deliver: false,
      idempotencyKey: uuidv4(),
    };
    if (pendingAttachments.length > 0) {
      params.attachments = pendingAttachments.map(a => ({
        type: a.mimeType.startsWith('image/') ? 'image' : 'file',
        mimeType: a.mimeType,
        fileName: a.name,
        content: a.content,
      }));
    }

    wsSend('chat.send', params);
    showTypingIndicator();

    // Clear input
    messageInput.value = '';
    autoResizeInput();
    clearAttachments();
  }

  function abortGeneration() {
    if (connected) {
      wsSend('chat.abort', currentRunId ? { sessionKey, runId: currentRunId } : { sessionKey });
    }
    finishStreaming();
  }

  // ---- Attachments ----
  function addAttachment(name, content, mimeType) {
    pendingAttachments.push({ name, content, mimeType });
    renderAttachmentChips();
  }

  function removeAttachment(index) {
    pendingAttachments.splice(index, 1);
    renderAttachmentChips();
  }

  function clearAttachments() {
    pendingAttachments = [];
    renderAttachmentChips();
  }

  function renderAttachmentChips() {
    attachmentChips.innerHTML = '';
    if (pendingAttachments.length === 0) {
      attachmentBar.classList.add('hidden');
      return;
    }
    attachmentBar.classList.remove('hidden');
    pendingAttachments.forEach((att, idx) => {
      const chip = document.createElement('div');
      chip.className = 'att-chip';

      // Image preview
      if (att.mimeType.startsWith('image/')) {
        const img = document.createElement('img');
        img.className = 'att-chip-preview';
        img.src = `data:${att.mimeType};base64,${att.content}`;
        chip.appendChild(img);
      }

      const nameSpan = document.createElement('span');
      nameSpan.className = 'att-chip-name';
      nameSpan.textContent = att.name;
      chip.appendChild(nameSpan);

      const removeBtn = document.createElement('span');
      removeBtn.className = 'att-chip-remove';
      removeBtn.textContent = '×';
      removeBtn.onclick = () => removeAttachment(idx);
      chip.appendChild(removeBtn);

      attachmentChips.appendChild(chip);
    });
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function handleFiles(files) {
    for (const file of files) {
      try {
        const base64 = await fileToBase64(file);
        addAttachment(file.name, base64, file.type || 'application/octet-stream');
      } catch (e) {
        addSystemMessage(`Failed to read ${file.name}: ${e.message}`);
      }
    }
  }

  // ---- Scroll ----
  function autoScroll() {
    if (!userScrolled) {
      scrollToBottom();
    }
  }

  function scrollToBottom(force) {
    if (force) userScrolled = false;
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  chatContainer.addEventListener('scroll', () => {
    const threshold = 80;
    const atBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < threshold;
    userScrolled = !atBottom;
  });

  // ---- Auto-resize input ----
  function autoResizeInput() {
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + 'px';
  }

  // ---- Utility ----
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function showAbortBtn(show) {
    if (show) {
      sendBtn.classList.add('hidden');
      abortBtn.classList.remove('hidden');
    } else {
      sendBtn.classList.remove('hidden');
      abortBtn.classList.add('hidden');
    }
  }

  // ---- Command System ----
  const CATEGORY_META = {
    sessions: { icon: '📋', label: 'SESSIONS' },
    agent: { icon: '🤖', label: 'AGENT' },
    cron: { icon: '⏰', label: 'CRON' },
    system: { icon: '🔧', label: 'SYSTEM' },
    memory: { icon: '🧠', label: 'MEMORY' },
    files: { icon: '📎', label: 'FILES' },
    voice: { icon: '🔊', label: 'VOICE' },
    quick: { icon: '⚡', label: 'QUICK' },
  };

  const COMMANDS = [
    { name: '/sessions', aliases: ['/s', '/sess'], description: 'List active sessions', category: 'sessions', action: 'rpc', rpcMethod: 'sessions.list', rpcParams: () => ({}) },
    { name: '/new', description: 'Create a new session', category: 'sessions', action: 'rpc', rpcMethod: 'sessions.create', args: [{ name: 'name', description: 'Session name', required: false }], rpcParams: (a) => a.name ? { name: a.name } : {} },
    { name: '/switch', description: 'Switch to another session', category: 'sessions', args: [{ name: 'key', description: 'Session key', required: true }], action: 'local' },
    { name: '/compact', description: 'Compact current session', category: 'sessions', action: 'rpc', rpcMethod: 'sessions.compact', rpcParams: () => ({ key: sessionKey }), requiresConfirm: true },
    { name: '/reset', description: 'Reset current session', category: 'sessions', action: 'rpc', rpcMethod: 'sessions.reset', rpcParams: () => ({ key: sessionKey }), requiresConfirm: true },
    { name: '/delete', description: 'Delete a session', category: 'sessions', action: 'rpc', rpcMethod: 'sessions.delete', args: [{ name: 'key', description: 'Session key', required: true }], rpcParams: (a) => ({ key: a.key }), requiresConfirm: true },

    { name: '/model', aliases: ['/m'], description: 'View or change model', category: 'agent', args: [{ name: 'model', description: 'Model name (blank = show)', required: false }], action: 'rpc', rpcMethod: 'agents.defaults.model', rpcParams: (a) => a.model ? { model: a.model } : {} },
    { name: '/models', description: 'List available models', category: 'agent', action: 'rpc', rpcMethod: 'models.list', rpcParams: () => ({}) },
    { name: '/status', description: 'Session status & usage', category: 'agent', action: 'rpc', rpcMethod: 'sessions.usage', rpcParams: () => ({ key: sessionKey }) },
    { name: '/abort', aliases: ['/stop'], description: 'Abort current run', category: 'agent', action: 'rpc', rpcMethod: 'chat.abort', rpcParams: () => ({ sessionKey }) },
    { name: '/history', description: 'Reload chat history', category: 'agent', action: 'rpc', rpcMethod: 'chat.history', rpcParams: () => ({ sessionKey, limit: 100 }) },
    { name: '/reasoning', description: 'Toggle extended thinking', category: 'agent', action: 'inject' },
    { name: '/skills', description: 'List agent skills', category: 'agent', action: 'rpc', rpcMethod: 'skills.status', rpcParams: () => ({}) },

    { name: '/cron list', aliases: ['/crons'], description: 'List cron jobs', category: 'cron', action: 'rpc', rpcMethod: 'cron.list', rpcParams: () => ({}) },
    { name: '/cron run', description: 'Trigger a cron job', category: 'cron', args: [{ name: 'id', description: 'Job ID', required: true }], action: 'rpc', rpcMethod: 'cron.run', rpcParams: (a) => ({ id: a.id }) },
    { name: '/cron status', description: 'Scheduler status', category: 'cron', action: 'rpc', rpcMethod: 'cron.status', rpcParams: () => ({}) },
    { name: '/cron enable', description: 'Enable a cron job', category: 'cron', args: [{ name: 'id', description: 'Job ID', required: true }], action: 'rpc', rpcMethod: 'cron.update', rpcParams: (a) => ({ id: a.id, enabled: true }) },
    { name: '/cron disable', description: 'Disable a cron job', category: 'cron', args: [{ name: 'id', description: 'Job ID', required: true }], action: 'rpc', rpcMethod: 'cron.update', rpcParams: (a) => ({ id: a.id, enabled: false }) },

    { name: '/health', description: 'Gateway health check', category: 'system', action: 'rpc', rpcMethod: 'gateway.health', rpcParams: () => ({}) },
    { name: '/channels', description: 'Channel status', category: 'system', action: 'rpc', rpcMethod: 'channels.status', rpcParams: () => ({}) },
    { name: '/config', description: 'View gateway config', category: 'system', args: [{ name: 'key', description: 'Config key (blank = all)', required: false }], action: 'rpc', rpcMethod: 'config.get', rpcParams: (a) => a.key ? { key: a.key } : {} },
    { name: '/logs', description: 'Tail gateway logs', category: 'system', action: 'rpc', rpcMethod: 'logs.tail', rpcParams: () => ({ lines: 50 }) },
    { name: '/hooks', description: 'List active hooks', category: 'system', action: 'rpc', rpcMethod: 'hooks.list', rpcParams: () => ({}) },
    { name: '/devices', description: 'List paired devices', category: 'system', action: 'rpc', rpcMethod: 'device.pair.list', rpcParams: () => ({}) },
    { name: '/nodes', description: 'List connected nodes', category: 'system', action: 'rpc', rpcMethod: 'node.list', rpcParams: () => ({}) },

    { name: '/remember', aliases: ['/save', '/store'], description: 'Save to memory', category: 'memory', args: [{ name: 'text', description: 'What to remember', required: true }], action: 'inject' },
    { name: '/me', description: 'View preferences', category: 'memory', args: [{ name: 'topic', description: 'Topic (optional)', required: false }], action: 'inject' },
    { name: '/router', description: 'Query memory backends', category: 'memory', args: [{ name: 'query', description: 'Search query', required: true }], action: 'inject' },
    { name: '/memhealth', aliases: ['/memory health'], description: 'Memory health check', category: 'memory', action: 'inject' },

    { name: '/attach', aliases: ['/file', '/upload'], description: 'Attach a file', category: 'files', action: 'local' },

    { name: '/tts', description: 'Text to speech', category: 'voice', args: [{ name: 'text', description: 'Text to speak', required: true }], action: 'rpc', rpcMethod: 'tts.convert', rpcParams: (a) => ({ text: a.text }) },
    { name: '/talk', description: 'Voice mode config', category: 'voice', action: 'rpc', rpcMethod: 'talk.config', rpcParams: () => ({}) },

    { name: '/clear', aliases: ['/cls'], description: 'Clear chat display', category: 'quick', action: 'local' },
    { name: '/reconnect', aliases: ['/rc'], description: 'Reconnect WebSocket', category: 'quick', action: 'local' },
    { name: '/theme', description: 'Toggle theme settings', category: 'quick', action: 'local' },
  ];

  // Command menu state
  let cmdMenuOpen = false;
  let cmdFilter = '';
  let cmdHighlight = 0;
  let cmdToasts = [];
  let cmdToastId = 0;
  let cmdConfirmCb = null;

  // Command menu DOM refs
  const menuBtn = $('#menu-btn');
  const commandMenu = $('#command-menu');
  const commandToastContainer = $('#command-toasts');
  const confirmOverlay = $('#confirm-overlay');
  const confirmTitle = $('#confirm-title');
  const confirmMsg = $('#confirm-message');
  const confirmCancelBtn = $('#confirm-cancel');
  const confirmProceedBtn = $('#confirm-proceed');

  // -- Menu rendering --
  function filterCommands(filter) {
    if (!filter) return COMMANDS;
    const lower = filter.toLowerCase();
    return COMMANDS.filter(cmd => {
      const haystack = [cmd.name, cmd.description, ...(cmd.aliases || [])].join(' ').toLowerCase();
      return haystack.includes(lower);
    });
  }

  function renderCommandMenu() {
    const filtered = filterCommands(cmdFilter);
    commandMenu.innerHTML = '';

    // Header
    const header = document.createElement('div');
    header.className = 'command-menu-header';
    header.innerHTML = cmdFilter
      ? `🔍 <span style="color:var(--text-primary)">/${escapeHtml(cmdFilter)}</span>`
      : '🔍 Type to filter commands...';
    commandMenu.appendChild(header);

    // List
    const list = document.createElement('div');
    list.className = 'command-menu-list';

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:16px;text-align:center;color:var(--text-muted);font-size:13px;';
      empty.textContent = 'No matching commands';
      list.appendChild(empty);
      commandMenu.appendChild(list);
      return;
    }

    // Group by category
    const groups = {};
    filtered.forEach(cmd => {
      if (!groups[cmd.category]) groups[cmd.category] = [];
      groups[cmd.category].push(cmd);
    });

    let idx = 0;
    for (const [cat, cmds] of Object.entries(groups)) {
      const meta = CATEGORY_META[cat] || { icon: '📁', label: cat.toUpperCase() };
      const catEl = document.createElement('div');
      catEl.className = 'command-category';
      catEl.textContent = `${meta.icon} ${meta.label}`;
      list.appendChild(catEl);

      cmds.forEach(cmd => {
        const item = document.createElement('div');
        item.className = 'command-item' + (idx === cmdHighlight ? ' highlighted' : '');
        item.dataset.idx = idx;

        let html = `<span class="command-item-name">${escapeHtml(cmd.name)}</span>`;
        if (cmd.aliases?.length) html += `<span class="command-item-aliases">(${cmd.aliases.join(', ')})</span>`;
        html += `<span class="command-item-desc">${escapeHtml(cmd.description)}</span>`;
        if (cmd.args?.length) {
          const hints = cmd.args.map(a => a.required ? `<${a.name}>` : `[${a.name}]`).join(' ');
          html += `<span class="command-item-args">${escapeHtml(hints)}</span>`;
        }
        item.innerHTML = html;
        item.addEventListener('click', () => selectCommand(cmd));
        item.addEventListener('mouseenter', () => {
          cmdHighlight = parseInt(item.dataset.idx);
          highlightMenuItem();
        });
        list.appendChild(item);
        idx++;
      });
    }
    commandMenu.appendChild(list);
  }

  function highlightMenuItem() {
    const items = commandMenu.querySelectorAll('.command-item');
    items.forEach((el, i) => {
      el.classList.toggle('highlighted', i === cmdHighlight);
      if (i === cmdHighlight) el.scrollIntoView({ block: 'nearest' });
    });
  }

  function openCommandMenu() {
    cmdMenuOpen = true;
    commandMenu.classList.remove('hidden');
    menuBtn.classList.add('active');
    cmdHighlight = 0;
    renderCommandMenu();
  }

  function closeCommandMenu() {
    cmdMenuOpen = false;
    cmdFilter = '';
    commandMenu.classList.add('hidden');
    menuBtn.classList.remove('active');
  }

  // -- Command parsing --
  function parseCommandInput(input) {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) return null;
    const sorted = COMMANDS.slice().sort((a, b) => b.name.length - a.name.length);
    for (const cmd of sorted) {
      const names = [cmd.name, ...(cmd.aliases || [])];
      for (const name of names) {
        if (trimmed === name || trimmed.startsWith(name + ' ')) {
          const argStr = trimmed.slice(name.length).trim();
          const args = {};
          if (cmd.args?.length && argStr) args[cmd.args[0].name] = argStr;
          return { cmd, args };
        }
      }
    }
    return null;
  }

  function selectCommand(cmd) {
    closeCommandMenu();
    messageInput.value = '';

    if (cmd.action === 'local') {
      handleLocalCommand(cmd, {});
      return;
    }
    if (cmd.action === 'inject') {
      if (cmd.args?.some(a => a.required)) {
        messageInput.value = cmd.name + ' ';
        messageInput.focus();
        return;
      }
      messageInput.value = cmd.name;
      sendMessage();
      return;
    }
    if (cmd.action === 'rpc') {
      if (cmd.requiresConfirm) { showConfirmDialog(cmd, {}); return; }
      if (cmd.args?.some(a => a.required)) {
        messageInput.value = cmd.name + ' ';
        messageInput.focus();
        return;
      }
      executeRpcCommand(cmd, {});
    }
  }

  // -- Local command handlers --
  function handleLocalCommand(cmd, args) {
    switch (cmd.name) {
      case '/clear':
        chatMessages.innerHTML = '';
        addSystemMessage('Chat cleared.');
        break;
      case '/reconnect':
        addSystemMessage('Reconnecting...');
        disconnect();
        reconnectAttempt = 0;
        setTimeout(connect, 500);
        break;
      case '/attach':
        attachBtn.click();
        break;
      case '/switch':
        if (args.key) {
          sessionKey = args.key;
          rpcCall('sessions.messages.subscribe', { key: sessionKey }).catch(() => {});
          chatMessages.innerHTML = '';
          wsSend('chat.history', { sessionKey, limit: 50 });
          addSystemMessage(`Switched to session: ${args.key}`);
        } else {
          addSystemMessage('Usage: /switch <session-key>');
        }
        break;
      case '/theme':
        settingsBtn.click();
        break;
      default:
        addSystemMessage(`Unknown command: ${cmd.name}`);
    }
  }

  // -- RPC execution --
  async function executeRpcCommand(cmd, args) {
    if (!connected) {
      addSystemMessage('Not connected. Cannot run command.');
      return;
    }
    const toastId = addCmdToast(cmd.name, 'pending');
    const params = cmd.rpcParams ? cmd.rpcParams(args) : {};

    try {
      const result = await rpcCall(cmd.rpcMethod, params);
      updateCmdToast(toastId, 'success', 'done');

      const formatter = RESULT_FORMATTERS[cmd.rpcMethod];
      if (formatter) {
        addCommandResult(formatter(result));
      } else {
        addCommandResult('<pre><code>' + escapeHtml(JSON.stringify(result, null, 2)) + '</code></pre>');
      }
    } catch (e) {
      updateCmdToast(toastId, 'error', e.message);
    }
  }

  function addCommandResult(html) {
    const el = document.createElement('div');
    el.className = 'msg msg-system';
    el.innerHTML = html;
    chatMessages.appendChild(el);
    autoScroll();
  }

  // -- Result formatters --
  const RESULT_FORMATTERS = {
    'sessions.list': (data) => {
      const sessions = data?.sessions || (Array.isArray(data) ? data : []);
      if (sessions.length === 0) return 'No active sessions.';
      const rows = sessions.map(s =>
        `<tr><td>${escapeHtml(s.key || s.id || '')}</td><td>${escapeHtml(s.label || '-')}</td><td>${escapeHtml(s.model || '-')}</td></tr>`
      ).join('');
      return `<table><thead><tr><th>Key</th><th>Label</th><th>Model</th></tr></thead><tbody>${rows}</tbody></table>`;
    },
    'cron.list': (data) => {
      const jobs = data?.jobs || (Array.isArray(data) ? data : []);
      if (jobs.length === 0) return 'No cron jobs.';
      const rows = jobs.map(j =>
        `<tr><td>${escapeHtml(j.id || j.name || '')}</td><td>${escapeHtml(j.schedule || '-')}</td><td>${j.enabled !== false ? '🟢' : '🔴'}</td><td>${escapeHtml(j.lastRun || '-')}</td></tr>`
      ).join('');
      return `<table><thead><tr><th>Job</th><th>Schedule</th><th>Status</th><th>Last Run</th></tr></thead><tbody>${rows}</tbody></table>`;
    },
    'models.list': (data) => {
      const models = data?.models || (Array.isArray(data) ? data : []);
      if (models.length === 0) return 'No models available.';
      return '<strong>Available Models:</strong><br>' + models.map(m =>
        typeof m === 'string' ? `• ${escapeHtml(m)}` : `• <strong>${escapeHtml(m.id || m.name || '')}</strong> ${escapeHtml(m.provider || '')}`
      ).join('<br>');
    },
    'channels.status': (data) => {
      const ch = data?.channels || data || {};
      const entries = typeof ch === 'object' && !Array.isArray(ch) ? Object.entries(ch) : [];
      if (entries.length === 0) return 'No channels configured.';
      return '<strong>Channels:</strong><br>' + entries.map(([name, info]) => {
        const status = info?.running ? '🟢 running' : '🔴 stopped';
        return `• <strong>${escapeHtml(name)}</strong>: ${status}`;
      }).join('<br>');
    },
    'gateway.health': (data) => {
      const ok = data?.ok !== false;
      return `Gateway: ${ok ? '🟢 Healthy' : '🔴 Unhealthy'}` +
        (data?.uptime ? ` • Uptime: ${escapeHtml(String(data.uptime))}` : '') +
        (data?.version ? ` • Version: ${escapeHtml(data.version)}` : '');
    },
    'sessions.usage': (data) => {
      const parts = [];
      if (data?.tokens) parts.push(`Tokens: ${data.tokens.toLocaleString()}`);
      if (data?.cost) parts.push(`Cost: $${Number(data.cost).toFixed(4)}`);
      if (data?.contextPercent) parts.push(`Context: ${data.contextPercent}%`);
      if (data?.model) parts.push(`Model: ${data.model}`);
      return parts.length > 0 ? '<strong>Session Usage:</strong><br>' + parts.join(' • ') : 'No usage data.';
    },
    'device.pair.list': (data) => {
      const devices = data?.devices || (Array.isArray(data) ? data : []);
      if (devices.length === 0) return 'No paired devices.';
      return '<strong>Devices:</strong><br>' + devices.map(d =>
        `• <strong>${escapeHtml(d.name || d.id || '')}</strong> ${d.online ? '🟢' : '⚫'} ${escapeHtml(d.platform || '')}`
      ).join('<br>');
    },
  };

  // -- Toast system --
  function addCmdToast(name, status) {
    const id = 'toast-' + (++cmdToastId);
    cmdToasts.push({ id, name, status, message: null });
    if (cmdToasts.length > 5) cmdToasts.shift();
    renderCmdToasts();
    return id;
  }

  function updateCmdToast(id, status, message) {
    const t = cmdToasts.find(t => t.id === id);
    if (!t) return;
    t.status = status;
    t.message = message;
    renderCmdToasts();
    if (status === 'success') setTimeout(() => removeCmdToast(id), 5000);
  }

  function removeCmdToast(id) {
    cmdToasts = cmdToasts.filter(t => t.id !== id);
    renderCmdToasts();
  }

  function renderCmdToasts() {
    commandToastContainer.innerHTML = '';
    cmdToasts.forEach(t => {
      const el = document.createElement('div');
      el.className = `command-toast ${t.status}`;
      const icon = t.status === 'pending' ? '<span class="command-toast-spinner"></span>'
        : t.status === 'success' ? '✅' : '❌';
      const text = t.status === 'pending' ? 'running...' : (t.message || t.status);
      el.innerHTML = `${icon} <strong>${escapeHtml(t.name)}</strong> — ${escapeHtml(text)}`;
      if (t.status !== 'pending') {
        const btn = document.createElement('button');
        btn.className = 'command-toast-dismiss';
        btn.textContent = '×';
        btn.onclick = () => removeCmdToast(t.id);
        el.appendChild(btn);
      }
      commandToastContainer.appendChild(el);
    });
  }

  // -- Confirm dialog --
  function showConfirmDialog(cmd, args) {
    confirmTitle.textContent = `Run ${cmd.name}?`;
    confirmMsg.textContent = 'This action may modify or delete data. Proceed?';
    confirmOverlay.classList.remove('hidden');
    cmdConfirmCb = () => {
      confirmOverlay.classList.add('hidden');
      cmdConfirmCb = null;
      if (cmd.action === 'rpc') executeRpcCommand(cmd, args);
    };
  }

  function hideConfirmDialog() {
    confirmOverlay.classList.add('hidden');
    cmdConfirmCb = null;
  }

  // ---- Event listeners ----

  // Send
  sendBtn.addEventListener('click', sendMessage);
  abortBtn.addEventListener('click', abortGeneration);

  messageInput.addEventListener('keydown', (e) => {
    // Command menu keyboard navigation
    if (cmdMenuOpen) {
      const filtered = filterCommands(cmdFilter);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        cmdHighlight = Math.min(cmdHighlight + 1, filtered.length - 1);
        highlightMenuItem();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        cmdHighlight = Math.max(cmdHighlight - 1, 0);
        highlightMenuItem();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (filtered[cmdHighlight]) {
          selectCommand(filtered[cmdHighlight]);
          return;
        }
        closeCommandMenu();
        // Fall through to sendMessage for unrecognized slash text
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeCommandMenu();
        messageInput.value = '';
        return;
      }
      if (e.key === 'Tab' && filtered.length > 0) {
        e.preventDefault();
        const cmd = filtered[cmdHighlight];
        messageInput.value = cmd.name + (cmd.args?.length ? ' ' : '');
        cmdFilter = messageInput.value.slice(1);
        cmdHighlight = 0;
        renderCommandMenu();
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  messageInput.addEventListener('input', () => {
    autoResizeInput();
    const value = messageInput.value;
    if (value.startsWith('/')) {
      cmdFilter = value.slice(1);
      if (!cmdMenuOpen) openCommandMenu();
      else { cmdHighlight = 0; renderCommandMenu(); }
    } else if (cmdMenuOpen) {
      closeCommandMenu();
    }
  });

  // Paste handler (screenshots)
  messageInput.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const ext = file.type.split('/')[1] || 'png';
          const renamedFile = new File([file], `screenshot-${timestamp}.${ext}`, { type: file.type });
          await handleFiles([renamedFile]);
          addSystemMessage(`📋 Screenshot pasted: ${renamedFile.name}`);
        }
      }
    }
  });

  // Drag and drop
  let dragCounter = 0;

  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    dropOverlay.classList.remove('hidden');
  });

  document.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      dropOverlay.classList.add('hidden');
    }
  });

  document.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropOverlay.classList.add('hidden');
    if (e.dataTransfer?.files?.length > 0) {
      await handleFiles(e.dataTransfer.files);
    }
  });

  // Menu button
  menuBtn.addEventListener('click', () => {
    if (cmdMenuOpen) {
      closeCommandMenu();
      messageInput.value = '';
    } else {
      messageInput.value = '/';
      messageInput.focus();
      cmdFilter = '';
      openCommandMenu();
    }
  });

  // Confirm dialog
  confirmCancelBtn.addEventListener('click', hideConfirmDialog);
  confirmProceedBtn.addEventListener('click', () => { if (cmdConfirmCb) cmdConfirmCb(); });
  confirmOverlay.addEventListener('click', (e) => { if (e.target === confirmOverlay) hideConfirmDialog(); });

  // Close menu on outside click
  document.addEventListener('click', (e) => {
    if (cmdMenuOpen && !commandMenu.contains(e.target) && e.target !== menuBtn && e.target !== messageInput) {
      closeCommandMenu();
      if (messageInput.value === '/') messageInput.value = '';
    }
  });

  // Attach button (file picker)
  attachBtn.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = async () => {
      if (input.files?.length > 0) {
        await handleFiles(input.files);
      }
    };
    input.click();
  });

  // Settings
  settingsBtn.addEventListener('click', () => {
    const s = loadSettings();
    settingUrl.value = s.url;
    settingToken.value = s.token;
    settingPassword.value = s.password;
    settingsOverlay.classList.remove('hidden');
  });

  settingsClose.addEventListener('click', () => settingsOverlay.classList.add('hidden'));
  settingsCancel.addEventListener('click', () => settingsOverlay.classList.add('hidden'));

  settingsSave.addEventListener('click', () => {
    saveSettings(
      settingUrl.value.trim() || DEFAULT_URL,
      settingToken.value.trim(),
      settingPassword.value.trim()
    );
    settingsOverlay.classList.add('hidden');
    disconnect();
    reconnectAttempt = 0;
    connect();
  });

  settingsOverlay.addEventListener('click', (e) => {
    if (e.target === settingsOverlay) settingsOverlay.classList.add('hidden');
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Escape closes settings
    if (e.key === 'Escape') {
      if (cmdMenuOpen) {
        closeCommandMenu();
        messageInput.value = '';
      } else if (!confirmOverlay.classList.contains('hidden')) {
        hideConfirmDialog();
      } else if (!settingsOverlay.classList.contains('hidden')) {
        settingsOverlay.classList.add('hidden');
      }
    }
    // Ctrl+L focus input
    if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
      e.preventDefault();
      messageInput.focus();
    }
  });

  // ---- Init ----
  async function init() {
    await listenersReady;
    console.log('[init] Tauri event listeners registered, connecting...');
    messageInput.focus();
    connect();
  }

  init();
})();
