// OpenClaw Desktop v2 — Frontend Logic
// Gateway WebSocket chat client with streaming, attachments, markdown

(() => {
  'use strict';

  // ---- Config defaults ----
  const DEFAULT_URL = 'ws://100.124.75.56:18791';
  const DEFAULT_TOKEN = '2f82c41c9fa07294686be9171f31e316224f679d58d875eb';
  const DEFAULT_PASSWORD = 'tim0teh';
  const HEARTBEAT_INTERVAL = 15000;
  const RECONNECT = { initialMs: 500, maxMs: 10000, factor: 1.5, jitter: 0.3, maxAttempts: 20 };

  // ---- State ----
  let ws = null;  // kept for readyState tracking
  let wsConnected = false;  // Rust-side connection state
  let msgId = 1;
  let connected = false;
  let sessionKey = null;
  let isStreaming = false;
  let streamingMsgEl = null;
  let streamBuffer = '';
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let userScrolled = false;
  let pendingAttachments = [];
  let currentRunId = null;
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

  // Extract text from message content (handles string or content array)
  function extractText(msg) {
    if (typeof msg.content === 'string') return msg.content;
    if (typeof msg.text === 'string') return msg.text;
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');
    }
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
      scopes: ['operator.admin'],
      caps: ['tool-events'],
      userAgent: 'OpenClaw Desktop v2',
      locale: 'en-US'
    };
    if (nonce) {
      try {
        const deviceData = await invoke('sign_device_v3', {
          req: {
            clientId: 'openclaw-control-ui',
            clientMode: 'ui',
            role: 'operator',
            scopes: ['operator.admin'],
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
        setConnectionStatus('connected');
        setupSession();
        return;
      }

      // chat.history response
      if (data.payload && Array.isArray(data.payload.messages)) {
        const welcome = chatMessages.querySelector('.welcome-msg');
        if (welcome) welcome.remove();
        
        data.payload.messages.forEach(msg => {
          if (msg.role === 'user') {
            addUserMessage(extractText(msg), msg.attachments);
          } else if (msg.role === 'assistant') {
            addAssistantMessage(extractText(msg));
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
      if (data.event === 'chat.delta') {
        const payload = data.payload || {};
        handleDelta(payload.delta || payload.text || extractText(payload));
      } else if (data.event === 'chat.completion') {
        handleFinalMessage(data.payload || {});
      } else if (data.event === 'chat') {
        handleChatEvent(data.payload);
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
        // Extract text from message content
        const text = extractText(params.message || {});
        if (text) handleDelta(text);
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

  function handleDelta(text) {
    if (!text) return;

    // Clear welcome message
    const welcome = chatMessages.querySelector('.welcome-msg');
    if (welcome) welcome.remove();

    if (!streamingMsgEl) {
      streamingMsgEl = createMessageElement('assistant');
      streamBuffer = '';
    }

    streamBuffer += text;
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
      const welcome = chatMessages.querySelector('.welcome-msg');
      if (welcome) welcome.remove();
      addAssistantMessage(content);
    } else {
      finishStreaming();
    }
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

  function finishStreaming() {
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

  function addAssistantMessage(content) {
    const el = createMessageElement('assistant');
    const contentEl = el.querySelector('.msg-content');
    try {
      contentEl.innerHTML = marked.parse(content);
    } catch (e) {
      contentEl.textContent = content;
    }
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

  // ---- Send message ----
  function sendMessage() {
    const text = messageInput.value.trim();
    if (!text && pendingAttachments.length === 0) return;
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
        type: 'image',
        mimeType: a.mimeType,
        content: a.content,
      }));
    }

    wsSend('chat.send', params);

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

  // ---- Event listeners ----

  // Send
  sendBtn.addEventListener('click', sendMessage);
  abortBtn.addEventListener('click', abortGeneration);

  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  messageInput.addEventListener('input', autoResizeInput);

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
      if (!settingsOverlay.classList.contains('hidden')) {
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
