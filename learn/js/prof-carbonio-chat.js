// learn/js/prof-carbonio-chat.js
// Widget chat per Prof. Carbonio - AI tutor del Master in Carbon Farming.
//
// Custom Element con Shadow DOM: il CSS resta isolato dal resto del sito.
// Vanilla JS, nessun framework, nessun build step.
//
// Uso in una pagina /learn/*.html:
//   <prof-carbonio-chat></prof-carbonio-chat>
//   <script src="/learn/js/prof-carbonio-chat.js" defer></script>
//
// Auth: prende JWT da localStorage.learnToken (stesso pattern delle altre pagine).
// Backend: /api/tutor/* registrato in api/index.js (modulo prof-carbonio-routes.js).
// Avatar: HeyGen LiveAvatar SDK caricato on-demand quando l'utente attiva la voce.

(function () {
  'use strict';

  // =========================================================================
  // CONFIG
  // =========================================================================
  const API_BASE = '/api/tutor';
  const HEYGEN_AVATAR_ID = '1402006ac8c7459d97ae9e1dce024fb7';
  // SDK HeyGen Streaming Avatar (NON LiveAvatar). Compatibile con la chiave
  // del piano HeyGen Team Unlimited. Versione esplicita per evitare 404 dei CDN
  // su "@latest" per scoped packages.
  // SDK bundled localmente. Usiamo @heygen/streaming-avatar@2.0.16: il package
  // npm e' marcato deprecated da HeyGen per spingere all'upsell LiveAvatar,
  // MA l'API server api.heygen.com che usa e' ufficialmente supportata fino al
  // 31 ottobre 2026 (docs.heygen.com). Compatibile con la chiave HeyGen del
  // piano Team Unlimited senza subscription extra. Migrazione a client custom
  // (opzione 3) prevista come step successivo.
  const HEYGEN_SDK_URLS = [
    '/learn/js/vendor/heygen-bundle.mjs'
  ];
  const TOKEN_KEYS = ['learnToken', 'token'];
  const PERSIST_KEY = 'profCarbonio.openSessionId';
  const PERSIST_PANEL_KEY = 'profCarbonio.panelOpen';

  function getAuthToken() {
    for (const k of TOKEN_KEYS) {
      const v = localStorage.getItem(k);
      if (v) return v;
    }
    return null;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // Sostituisce i marker [^N] con chip cliccabili (data-cite="N")
  function renderCitations(text, citations) {
    const safe = escapeHtml(text);
    return safe.replace(/\[\^(\d+)\]/g, (_, n) => {
      const cit = citations?.find(c => c.n === Number(n));
      const title = cit ? escapeHtml(cit.title || '') : '';
      return `<a class="cite" data-cite="${n}" href="#" title="${title}">[${n}]</a>`;
    });
  }

  function fmtTime(d) {
    const dt = new Date(d);
    return dt.toLocaleString('it-IT', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
  }

  function buildCitationUrl(c) {
    if (!c?.url) return null;
    if (c.page) return `${c.url}#page=${c.page}`;
    return c.url;
  }

  // =========================================================================
  // TEMPLATE (HTML + CSS isolato in Shadow DOM)
  // =========================================================================
  const TEMPLATE = `
  <style>
    :host {
      --pc-primary: #2d6a4f;
      --pc-primary-dark: #1b4332;
      --pc-accent: #95d5b2;
      --pc-bg: #f7f9f6;
      --pc-surface: #ffffff;
      --pc-text: #1f2937;
      --pc-muted: #6b7280;
      --pc-user-bg: #2d6a4f;
      --pc-user-fg: #ffffff;
      --pc-assistant-bg: #ffffff;
      --pc-assistant-fg: #1f2937;
      --pc-border: #e5e7eb;
      --pc-shadow: 0 8px 32px rgba(0,0,0,0.12);
      --pc-radius: 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .fab {
      position: fixed; bottom: 24px; right: 24px;
      width: 60px; height: 60px;
      border-radius: 50%;
      background: var(--pc-primary);
      color: white;
      border: none;
      cursor: pointer;
      box-shadow: var(--pc-shadow);
      font-size: 28px;
      display: flex; align-items: center; justify-content: center;
      z-index: 9998;
      transition: transform .2s, background .2s;
    }
    .fab:hover { background: var(--pc-primary-dark); transform: scale(1.05); }
    .fab.open { display: none; }
    .fab-label {
      position: fixed; bottom: 32px; right: 92px;
      background: var(--pc-primary-dark); color: white;
      padding: 8px 14px; border-radius: 8px; font-size: 13px;
      z-index: 9998; pointer-events: none;
      box-shadow: var(--pc-shadow);
    }
    .fab.open ~ .fab-label { display: none; }

    .panel {
      position: fixed;
      top: 0; right: -100%; bottom: 0;
      width: 100%; max-width: 480px;
      background: var(--pc-bg);
      box-shadow: var(--pc-shadow);
      display: flex; flex-direction: column;
      transition: right .3s ease;
      z-index: 9999;
    }
    .panel.open { right: 0; }

    .panel-header {
      background: var(--pc-primary);
      color: white;
      padding: 16px 18px;
      display: flex; align-items: center; gap: 12px;
    }
    .panel-header .avatar-icon {
      width: 36px; height: 36px;
      border-radius: 50%;
      background: var(--pc-accent);
      display: flex; align-items: center; justify-content: center;
      font-size: 20px;
    }
    .panel-header .title { flex: 1; }
    .panel-header .title h2 { margin: 0; font-size: 16px; font-weight: 600; }
    .panel-header .title .subtitle { font-size: 11px; opacity: 0.85; }
    .panel-header button.icon {
      background: rgba(255,255,255,0.18); border: none; color: white;
      width: 32px; height: 32px; border-radius: 6px;
      cursor: pointer; font-size: 18px;
      display: flex; align-items: center; justify-content: center;
    }
    .panel-header button.icon:hover { background: rgba(255,255,255,0.32); }

    .mode-toggle {
      display: flex;
      background: var(--pc-surface);
      border-bottom: 1px solid var(--pc-border);
    }
    .mode-toggle button {
      flex: 1; padding: 12px;
      background: none; border: none;
      cursor: pointer; font-size: 13px; color: var(--pc-muted);
      border-bottom: 3px solid transparent;
      transition: all .2s;
    }
    .mode-toggle button.active {
      color: var(--pc-primary);
      border-bottom-color: var(--pc-primary);
      font-weight: 600;
    }

    .messages {
      flex: 1; overflow-y: auto;
      padding: 16px;
      display: flex; flex-direction: column; gap: 12px;
    }
    .msg { max-width: 88%; padding: 10px 14px; border-radius: 14px; line-height: 1.45; font-size: 14px; }
    .msg.user {
      align-self: flex-end;
      background: var(--pc-user-bg); color: var(--pc-user-fg);
      border-bottom-right-radius: 4px;
    }
    .msg.assistant {
      align-self: flex-start;
      background: var(--pc-assistant-bg); color: var(--pc-assistant-fg);
      border-bottom-left-radius: 4px;
      box-shadow: 0 1px 2px rgba(0,0,0,0.05);
    }
    .msg .actions {
      display: flex; gap: 6px; margin-top: 8px;
      font-size: 11px; color: var(--pc-muted);
    }
    .msg .actions button {
      background: transparent; border: 1px solid var(--pc-border);
      border-radius: 12px; padding: 3px 8px;
      cursor: pointer; font-size: 11px; color: var(--pc-muted);
      transition: all .15s;
    }
    .msg .actions button:hover { background: var(--pc-bg); color: var(--pc-text); }
    .msg .actions button.active.up { color: #2d6a4f; border-color: #95d5b2; }
    .msg .actions button.active.down { color: #c44; border-color: #fca5a5; }

    .cite {
      display: inline-block;
      background: var(--pc-accent);
      color: var(--pc-primary-dark);
      padding: 1px 6px;
      border-radius: 8px;
      font-size: 11px;
      font-weight: 600;
      text-decoration: none;
      margin: 0 2px;
      cursor: pointer;
    }
    .cite:hover { background: var(--pc-primary); color: white; }

    .citations-panel {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px dashed var(--pc-border);
      font-size: 12px;
      color: var(--pc-muted);
    }
    .citations-panel .cit-item { margin: 4px 0; line-height: 1.4; }
    .citations-panel a { color: var(--pc-primary); text-decoration: none; }
    .citations-panel a:hover { text-decoration: underline; }

    .empty {
      flex: 1; display: flex; align-items: center; justify-content: center;
      flex-direction: column; gap: 16px; text-align: center; padding: 30px;
      color: var(--pc-muted);
    }
    .empty h3 { color: var(--pc-text); margin: 0; }
    .empty .suggestions { display: flex; flex-direction: column; gap: 8px; width: 100%; }
    .empty .suggestions button {
      background: var(--pc-surface); border: 1px solid var(--pc-border);
      border-radius: 10px; padding: 10px 14px;
      cursor: pointer; text-align: left; font-size: 13px; color: var(--pc-text);
    }
    .empty .suggestions button:hover { border-color: var(--pc-primary); background: var(--pc-bg); }

    .input-area {
      padding: 12px; background: var(--pc-surface);
      border-top: 1px solid var(--pc-border);
      display: flex; flex-direction: column; gap: 8px;
    }
    .input-row { display: flex; gap: 8px; }
    .input-row textarea {
      flex: 1; border: 1px solid var(--pc-border); border-radius: 12px;
      padding: 10px 12px; resize: none; font-family: inherit; font-size: 14px;
      max-height: 120px; outline: none;
    }
    .input-row textarea:focus { border-color: var(--pc-primary); }
    .input-row button.send {
      background: var(--pc-primary); color: white;
      border: none; border-radius: 12px;
      padding: 0 18px; font-size: 14px; cursor: pointer;
      transition: background .15s;
    }
    .input-row button.send:hover { background: var(--pc-primary-dark); }
    .input-row button.send:disabled { background: var(--pc-muted); cursor: not-allowed; }

    .quota {
      font-size: 11px; color: var(--pc-muted); text-align: center;
    }
    .quota.warn { color: #d97706; }

    .typing { font-style: italic; color: var(--pc-muted); font-size: 13px; padding: 8px 14px; }

    .error-banner {
      background: #fef2f2; color: #991b1b; padding: 10px 14px;
      font-size: 13px; border-bottom: 1px solid #fecaca;
    }

    /* === AVATAR MODE === */
    .avatar-stage {
      flex: 1; display: flex; flex-direction: column;
      background: #000;
    }
    .avatar-video-wrap {
      flex: 1; position: relative; background: #000;
      min-height: 280px;
    }
    .avatar-video-wrap video {
      width: 100%; height: 100%; object-fit: cover;
    }
    .avatar-video-wrap .status {
      position: absolute; top: 12px; left: 12px;
      background: rgba(0,0,0,0.55); color: white;
      padding: 6px 12px; border-radius: 20px;
      font-size: 12px;
    }
    .avatar-video-wrap .status .dot {
      display: inline-block; width: 8px; height: 8px;
      background: #22c55e; border-radius: 50%; margin-right: 6px;
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    .avatar-start {
      flex: 1; display: flex; align-items: center; justify-content: center;
      flex-direction: column; gap: 18px; color: white;
      background: linear-gradient(135deg, #1b4332, #2d6a4f);
      padding: 30px; text-align: center;
    }
    .avatar-start h3 { margin: 0; font-size: 18px; }
    .avatar-start p { margin: 0; opacity: 0.85; max-width: 320px; line-height: 1.5; }
    .avatar-start button {
      background: var(--pc-accent); color: var(--pc-primary-dark);
      border: none; border-radius: 30px;
      padding: 14px 28px; font-size: 15px; font-weight: 600;
      cursor: pointer;
    }
    .avatar-start button:hover { background: white; }
    .avatar-controls {
      background: var(--pc-surface); padding: 12px;
      display: flex; gap: 8px; align-items: center; justify-content: center;
      border-top: 1px solid var(--pc-border);
    }
    .avatar-controls button {
      background: var(--pc-bg); border: 1px solid var(--pc-border);
      border-radius: 20px; padding: 8px 14px; font-size: 13px; cursor: pointer;
    }
    .avatar-controls button.danger { background: #fee2e2; color: #991b1b; border-color: #fca5a5; }

    .avatar-transcript {
      max-height: 200px; overflow-y: auto;
      background: var(--pc-bg); padding: 12px;
      border-top: 1px solid var(--pc-border);
      font-size: 13px;
    }
    .avatar-transcript .msg { max-width: 100%; }

    @media (max-width: 600px) {
      .panel { max-width: 100%; }
      .fab-label { display: none; }
    }
  </style>

  <button class="fab" part="fab" aria-label="Apri Prof. Carbonio">🌱</button>
  <div class="fab-label">Chiedi a Prof. Carbonio</div>

  <aside class="panel" role="dialog" aria-label="Prof. Carbonio">
    <header class="panel-header">
      <div class="avatar-icon">🌱</div>
      <div class="title">
        <h2>Prof. Carbonio</h2>
        <div class="subtitle">Tutor del Master in Carbon Farming</div>
      </div>
      <button class="icon" data-action="history" title="Sessioni precedenti">📚</button>
      <button class="icon" data-action="close" title="Chiudi">✕</button>
    </header>

    <div class="mode-toggle">
      <button data-mode="text" class="active">💬 Chat</button>
      <button data-mode="avatar">🎙️ Voce + Avatar</button>
    </div>

    <div class="content"></div>

    <footer class="input-area" data-when="text">
      <div class="quota"></div>
      <div class="input-row">
        <textarea placeholder="Scrivi qui la tua domanda..." rows="1"></textarea>
        <button class="send">Invia</button>
      </div>
    </footer>
  </aside>
  `;

  // =========================================================================
  // CUSTOM ELEMENT
  // =========================================================================
  class ProfCarbonioChat extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = TEMPLATE;
      this.state = {
        open: false,
        mode: 'text',
        session: null,
        messages: [],
        usage: null,
        sending: false,
        avatar: { sdkLoaded: false, session: null, connected: false, listening: false, talking: false }
      };
    }

    connectedCallback() {
      const sr = this.shadowRoot;
      this.refs = {
        fab: sr.querySelector('.fab'),
        panel: sr.querySelector('.panel'),
        content: sr.querySelector('.content'),
        modeButtons: sr.querySelectorAll('.mode-toggle button'),
        inputArea: sr.querySelector('.input-area'),
        textarea: sr.querySelector('textarea'),
        sendBtn: sr.querySelector('.send'),
        quota: sr.querySelector('.quota')
      };

      this.refs.fab.addEventListener('click', () => this.openPanel());
      sr.querySelector('[data-action="close"]').addEventListener('click', () => this.closePanel());
      sr.querySelector('[data-action="history"]').addEventListener('click', () => this.showHistory());

      this.refs.modeButtons.forEach(b =>
        b.addEventListener('click', () => this.switchMode(b.dataset.mode))
      );

      this.refs.textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.sendUserMessage();
        }
      });
      this.refs.textarea.addEventListener('input', () => this.autoresize());
      this.refs.sendBtn.addEventListener('click', () => this.sendUserMessage());

      // Reopen panel if it was open before page reload
      if (localStorage.getItem(PERSIST_PANEL_KEY) === '1') {
        this.openPanel();
      }
    }

    // -----------------------------------------------------------------------
    // API CLIENT
    // -----------------------------------------------------------------------
    async api(path, opts = {}) {
      const token = getAuthToken();
      if (!token) {
        throw new Error('Devi essere loggato per usare Prof. Carbonio');
      }
      const res = await fetch(API_BASE + path, {
        ...opts,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          ...(opts.headers || {})
        }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data?.error || `HTTP ${res.status}`);
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    }

    async fetchUsage() {
      try {
        this.state.usage = await this.api('/usage');
        this.renderQuota();
      } catch (_) { /* silent */ }
    }

    async ensureSession() {
      if (this.state.session) return this.state.session;
      const persistedId = localStorage.getItem(PERSIST_KEY);
      if (persistedId) {
        try {
          const data = await this.api(`/sessions/${persistedId}`);
          this.state.session = data.session;
          this.state.messages = data.messages || [];
          return this.state.session;
        } catch (_) {
          localStorage.removeItem(PERSIST_KEY);
        }
      }
      const { session } = await this.api('/sessions', {
        method: 'POST',
        body: JSON.stringify({ language: 'it' })
      });
      this.state.session = session;
      localStorage.setItem(PERSIST_KEY, session.id);
      return session;
    }

    // -----------------------------------------------------------------------
    // UI: PANEL OPEN/CLOSE/MODE
    // -----------------------------------------------------------------------
    openPanel() {
      this.state.open = true;
      this.refs.panel.classList.add('open');
      this.refs.fab.classList.add('open');
      localStorage.setItem(PERSIST_PANEL_KEY, '1');
      this.bootstrapSession();
    }

    closePanel() {
      this.state.open = false;
      this.refs.panel.classList.remove('open');
      this.refs.fab.classList.remove('open');
      localStorage.removeItem(PERSIST_PANEL_KEY);
      // Stop avatar se attivo
      this.stopAvatar().catch(() => {});
    }

    async bootstrapSession() {
      this.refs.content.innerHTML = '<div class="empty"><p>Carico...</p></div>';
      try {
        await this.ensureSession();
        await this.fetchUsage();
        this.renderMessages();
      } catch (err) {
        this.showError(err.message);
      }
    }

    switchMode(mode) {
      if (mode === this.state.mode) return;
      this.state.mode = mode;
      this.refs.modeButtons.forEach(b => {
        b.classList.toggle('active', b.dataset.mode === mode);
      });
      if (mode === 'text') {
        this.refs.inputArea.style.display = '';
        this.stopAvatar().catch(() => {});
        this.renderMessages();
      } else {
        this.refs.inputArea.style.display = 'none';
        this.renderAvatarStage();
      }
    }

    // -----------------------------------------------------------------------
    // UI: MESSAGES
    // -----------------------------------------------------------------------
    renderMessages() {
      const c = this.refs.content;
      if (!this.state.messages.length) {
        c.innerHTML = `
          <div class="empty">
            <div style="font-size: 48px;">🌱</div>
            <h3>Ciao! Sono Prof. Carbonio.</h3>
            <p>Chiedimi qualsiasi cosa sul Master in Carbon Farming: regolamento UE 2024/3012, pratiche agronomiche, calcolo dei crediti, monitoraggio del SOC. Cito sempre le fonti dai materiali del Master.</p>
            <div class="suggestions">
              <button>Cosa stabilisce il Regolamento UE 2024/3012?</button>
              <button>Spiegami il concetto di carbon farming</button>
              <button>Come si misura il SOC?</button>
              <button>Quali pratiche generano piu' crediti?</button>
            </div>
          </div>
        `;
        c.querySelectorAll('.suggestions button').forEach(b => {
          b.addEventListener('click', () => {
            this.refs.textarea.value = b.textContent;
            this.sendUserMessage();
          });
        });
        return;
      }

      const html = this.state.messages.map(m => this.renderMessageBubble(m)).join('');
      c.innerHTML = `<div class="messages">${html}</div>`;
      this.bindMessageActions();
      this.scrollMessagesToBottom();
    }

    renderMessageBubble(m) {
      const cls = m.role === 'user' ? 'user' : 'assistant';
      const citations = (typeof m.citations === 'string')
        ? safeParseJson(m.citations, [])
        : (m.citations || []);
      const body = m.role === 'assistant'
        ? renderCitations(m.content, citations)
        : escapeHtml(m.content).replace(/\n/g, '<br>');

      let citationsBlock = '';
      if (m.role === 'assistant' && citations.length) {
        citationsBlock = '<div class="citations-panel">' +
          citations.map(c => {
            const url = buildCitationUrl(c);
            const label = escapeHtml(c.title || 'fonte');
            const where = c.page ? `pag. ${c.page}`
                       : c.slide ? `slide ${c.slide}`
                       : c.startSeconds != null ? `min ${Math.floor(c.startSeconds/60)}:${String(c.startSeconds%60).padStart(2,'0')}`
                       : '';
            const link = url
              ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${label}</a>`
              : label;
            return `<div class="cit-item">[${c.n}] ${link}${where ? ' — ' + where : ''}</div>`;
          }).join('') + '</div>';
      }

      let actions = '';
      if (m.role === 'assistant' && m.id) {
        actions = `<div class="actions">
          <button data-thumb="up" data-msg="${m.id}">👍</button>
          <button data-thumb="down" data-msg="${m.id}">👎</button>
          <button data-action="escalate" data-msg="${m.id}">↗️ Chiedi al docente</button>
        </div>`;
      }

      return `<div class="msg ${cls}">${body}${citationsBlock}${actions}</div>`;
    }

    bindMessageActions() {
      this.refs.content.querySelectorAll('[data-action="escalate"]').forEach(b => {
        b.addEventListener('click', () => this.escalate(b.dataset.msg));
      });
      this.refs.content.querySelectorAll('.cite').forEach(a => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const n = Number(a.dataset.cite);
          // Trova citazione e apre URL se presente
          for (const m of this.state.messages) {
            const cits = (typeof m.citations === 'string')
              ? safeParseJson(m.citations, [])
              : (m.citations || []);
            const c = cits.find(x => x.n === n);
            if (c) {
              const url = buildCitationUrl(c);
              if (url) window.open(url, '_blank', 'noopener');
              return;
            }
          }
        });
      });
    }

    scrollMessagesToBottom() {
      const list = this.refs.content.querySelector('.messages');
      if (list) list.scrollTop = list.scrollHeight;
    }

    renderQuota() {
      if (!this.state.usage) { this.refs.quota.textContent = ''; return; }
      const u = this.state.usage;
      const txt = `${u.used}/${u.limit} domande oggi`;
      this.refs.quota.textContent = txt;
      this.refs.quota.classList.toggle('warn', u.remaining < 5);
    }

    showError(msg) {
      this.refs.content.innerHTML = `<div class="error-banner">${escapeHtml(msg)}</div>` + this.refs.content.innerHTML;
    }

    // -----------------------------------------------------------------------
    // SEND MESSAGE (TEXT MODE)
    // -----------------------------------------------------------------------
    async sendUserMessage() {
      if (this.state.sending) return;
      const text = this.refs.textarea.value.trim();
      if (!text) return;

      this.state.sending = true;
      this.refs.sendBtn.disabled = true;
      this.refs.textarea.value = '';
      this.autoresize();

      // Optimistic UI: aggiungi messaggio utente subito + spinner
      this.state.messages.push({ role: 'user', content: text, id: 'tmp-' + Date.now() });
      this.state.messages.push({ role: 'assistant', content: '_Sto pensando..._', id: 'thinking', _placeholder: true });
      this.renderMessages();

      try {
        const session = await this.ensureSession();
        const result = await this.api(`/sessions/${session.id}/messages`, {
          method: 'POST',
          body: JSON.stringify({ message: text, language: 'it' })
        });

        // Sostituisci placeholder con risposta vera
        this.state.messages = this.state.messages.filter(m => !m._placeholder);
        this.state.messages.push({
          id: result.messageId,
          role: 'assistant',
          content: result.reply,
          citations: result.citations,
          created_at: new Date().toISOString()
        });

        if (result.usage) {
          this.state.usage = {
            today: new Date().toISOString().slice(0,10),
            used: result.usage.messagesUsedToday,
            limit: result.usage.dailyLimit,
            remaining: Math.max(0, result.usage.dailyLimit - result.usage.messagesUsedToday)
          };
          this.renderQuota();
        }

        this.renderMessages();
      } catch (err) {
        this.state.messages = this.state.messages.filter(m => !m._placeholder);
        const msg = err.status === 429
          ? `⚠️ Hai raggiunto il limite giornaliero di domande. Riprova domani.`
          : `Errore: ${err.message}`;
        this.state.messages.push({
          role: 'assistant', content: msg,
          id: 'err-' + Date.now(), _error: true
        });
        this.renderMessages();
      } finally {
        this.state.sending = false;
        this.refs.sendBtn.disabled = false;
        this.refs.textarea.focus();
      }
    }

    autoresize() {
      const ta = this.refs.textarea;
      ta.style.height = 'auto';
      ta.style.height = Math.min(120, ta.scrollHeight) + 'px';
    }

    // -----------------------------------------------------------------------
    // ESCALATE
    // -----------------------------------------------------------------------
    async escalate(messageId) {
      if (!messageId || messageId.startsWith('tmp-') || messageId === 'thinking') return;
      if (!confirm('Vuoi inoltrare questa domanda al docente competente?')) return;
      try {
        await this.api(`/messages/${messageId}/escalate`, {
          method: 'POST',
          body: JSON.stringify({})
        });
        alert('Domanda inoltrata al docente. Riceverai la sua risposta nella sezione Domande del LMS.');
      } catch (err) {
        alert(`Errore: ${err.message}`);
      }
    }

    // -----------------------------------------------------------------------
    // HISTORY
    // -----------------------------------------------------------------------
    async showHistory() {
      try {
        const { sessions } = await this.api('/sessions');
        const items = sessions.length
          ? sessions.map(s => `
              <button class="history-item" data-id="${s.id}" style="text-align:left;padding:10px;background:var(--pc-surface);border:1px solid var(--pc-border);border-radius:8px;cursor:pointer;width:100%;margin-bottom:6px;">
                <strong>${escapeHtml(s.title || 'Senza titolo')}</strong><br>
                <small style="color:var(--pc-muted)">${fmtTime(s.last_message_at)} — ${s.message_count} messaggi</small>
              </button>
            `).join('')
          : '<p style="color:var(--pc-muted)">Nessuna conversazione precedente.</p>';
        this.refs.content.innerHTML = `
          <div style="padding:16px;">
            <h3 style="margin-top:0;">Sessioni precedenti</h3>
            <button id="newSess" style="background:var(--pc-primary);color:white;border:none;border-radius:8px;padding:8px 14px;cursor:pointer;margin-bottom:12px;">+ Nuova conversazione</button>
            ${items}
          </div>
        `;
        const newBtn = this.refs.content.querySelector('#newSess');
        if (newBtn) newBtn.addEventListener('click', () => this.startNewSession());
        this.refs.content.querySelectorAll('.history-item').forEach(b => {
          b.addEventListener('click', async () => {
            try {
              const data = await this.api(`/sessions/${b.dataset.id}`);
              this.state.session = data.session;
              this.state.messages = data.messages || [];
              localStorage.setItem(PERSIST_KEY, data.session.id);
              this.renderMessages();
            } catch (err) { alert(err.message); }
          });
        });
      } catch (err) {
        this.showError(err.message);
      }
    }

    async startNewSession() {
      localStorage.removeItem(PERSIST_KEY);
      this.state.session = null;
      this.state.messages = [];
      await this.ensureSession();
      this.renderMessages();
    }

    // =======================================================================
    // AVATAR MODE (HeyGen LiveAvatar)
    // =======================================================================
    renderAvatarStage() {
      const a = this.state.avatar;
      if (!a.connected) {
        this.refs.content.innerHTML = `
          <div class="avatar-stage">
            <div class="avatar-start">
              <h3>🎙️ Modalita' Voce + Avatar</h3>
              <p>Prof. Carbonio ti parla. Permetti l'accesso al microfono quando il browser lo chiede. Fai domande naturali, in italiano. Per fonti dettagliate torna alla Chat scritta.</p>
              <button data-action="avatar-start">Inizia conversazione</button>
              <small style="opacity:0.7;font-size:11px;">Powered by HeyGen LiveAvatar</small>
            </div>
          </div>
        `;
        this.refs.content.querySelector('[data-action="avatar-start"]')
          .addEventListener('click', () => this.startAvatar());
      } else {
        this.refs.content.innerHTML = `
          <div class="avatar-stage">
            <div class="avatar-video-wrap">
              <video autoplay playsinline></video>
              <div class="status"><span class="dot"></span><span class="status-text">Connesso</span></div>
            </div>
            <div class="avatar-controls">
              <button data-action="avatar-mute">🎤 ${a.muted ? 'Riattiva' : 'Muta'}</button>
              <button class="danger" data-action="avatar-stop">Termina</button>
            </div>
            <div class="avatar-transcript"></div>
          </div>
        `;
        this.avatarVideoEl = this.refs.content.querySelector('video');
        // Streaming Avatar SDK: assegna il MediaStream ricevuto dall'evento STREAM_READY
        if (this.state.avatar.stream && this.avatarVideoEl) {
          try {
            // Il payload puo' essere o lo stream direttamente, o un wrapper con .stream
            const stream = this.state.avatar.stream.getTracks
              ? this.state.avatar.stream
              : (this.state.avatar.stream.stream || this.state.avatar.stream);
            this.avatarVideoEl.srcObject = stream;
            this.avatarVideoEl.play().catch(() => {});
          } catch (e) { console.warn('video attach error', e); }
        }
        this.refs.content.querySelector('[data-action="avatar-mute"]')
          .addEventListener('click', () => this.toggleAvatarMute());
        this.refs.content.querySelector('[data-action="avatar-stop"]')
          .addEventListener('click', () => this.stopAvatar());
        this.refs.transcript = this.refs.content.querySelector('.avatar-transcript');
        this.refs.statusText = this.refs.content.querySelector('.status-text');
      }
    }

    async loadHeyGenSDK() {
      if (this.state.avatar.sdkLoaded) return this.state.avatar.sdk;
      this.refs.content.innerHTML = `<div class="empty"><p>Carico l'avatar...</p></div>`;

      // Prova ogni CDN in sequenza, fallback su quello successivo se uno fallisce
      const errors = [];
      for (const url of HEYGEN_SDK_URLS) {
        try {
          console.log('[prof-carbonio] Loading HeyGen SDK from', url);
          const mod = await import(/* @vite-ignore */ url);
          // Verifica che esporti effettivamente StreamingAvatar
          if (!mod || (!mod.default && !mod.StreamingAvatar)) {
            throw new Error('SDK module missing StreamingAvatar export');
          }
          this.state.avatar.sdk = mod;
          this.state.avatar.sdkLoaded = true;
          console.log('[prof-carbonio] HeyGen SDK loaded successfully');
          return mod;
        } catch (err) {
          console.warn(`[prof-carbonio] CDN ${url} failed:`, err.message);
          errors.push(`${url}: ${err.message}`);
        }
      }

      console.error('[prof-carbonio] All HeyGen SDK CDNs failed:', errors);
      throw new Error('Impossibile caricare l\'SDK dell\'avatar da nessun CDN. Controlla la connessione o riprova piu\' tardi.');
    }

    async startAvatar() {
      try {
        const sdk = await this.loadHeyGenSDK();
        // Pattern HeyGen Streaming Avatar (api.heygen.com, chiave HeyGen Team).
        const StreamingAvatar = sdk.default || sdk.StreamingAvatar;
        const StreamingEvents = sdk.StreamingEvents;
        const AvatarQuality = sdk.AvatarQuality || { Low: 'low', Medium: 'medium', High: 'high' };
        const TaskType = sdk.TaskType || { REPEAT: 'repeat', TALK: 'talk' };
        const VoiceChatTransport = sdk.VoiceChatTransport;
        if (!StreamingAvatar || !StreamingEvents) {
          throw new Error('SDK non espone StreamingAvatar/StreamingEvents');
        }
        this.state.avatar._enums = { StreamingEvents, AvatarQuality, TaskType };

        // 1) Token dal nostro backend (chiama api.heygen.com/v1/streaming.create_token)
        const { sessionToken, avatarId } = await this.api('/avatar/session', {
          method: 'POST',
          body: JSON.stringify({ language: 'it' })
        });

        // 2) Assicura sessione chat per persistere messaggi
        await this.ensureSession();

        // 3) Inizializza SDK
        const av = new StreamingAvatar({ token: sessionToken });
        this.state.avatar.session = av;

        // 4) Event listeners — stream
        av.on(StreamingEvents.STREAM_READY, (event) => {
          this.state.avatar.connected = true;
          this.state.avatar.stream = event?.detail || event;
          this.renderAvatarStage();
          // Saluto iniziale + avvia voice chat
          setTimeout(async () => {
            try {
              await av.speak({
                text: 'Ciao, sono Prof. Carbonio. Chiedimi qualsiasi cosa sul Master in Carbon Farming.',
                task_type: TaskType.REPEAT
              });
            } catch (e) { console.warn('welcome speak error', e); }
            try { await av.startVoiceChat(); } catch (e) { console.warn('startVoiceChat error', e); }
          }, 600);
        });

        av.on(StreamingEvents.STREAM_DISCONNECTED, () => {
          this.state.avatar.connected = false;
          this.renderAvatarStage();
        });

        // 5) Event listeners — avatar
        av.on(StreamingEvents.AVATAR_START_TALKING, () => {
          this.state.avatar.talking = true;
          if (this.refs.statusText) this.refs.statusText.textContent = 'Prof. Carbonio parla...';
        });
        av.on(StreamingEvents.AVATAR_STOP_TALKING, () => {
          this.state.avatar.talking = false;
          if (this.refs.statusText) this.refs.statusText.textContent = 'In ascolto...';
        });

        // 6) Event listeners — utente (l'SDK emette USER_TALKING_MESSAGE/USER_END_MESSAGE)
        av.on(StreamingEvents.USER_START, () => {
          if (this.state.avatar.muted) return;
          if (this.refs.statusText) this.refs.statusText.textContent = 'Ti ascolto...';
          this.userBuffer = '';
        });

        av.on(StreamingEvents.USER_TALKING_MESSAGE, (event) => {
          if (this.state.avatar.muted) return;
          const txt = event?.detail?.message || event?.detail?.text || event?.message || event?.text;
          if (!txt) return;
          try { av.interrupt && av.interrupt(); } catch (_) {}
          this.userBuffer = ((this.userBuffer || '') + ' ' + txt).trim();
        });

        let processingDelay = null;
        av.on(StreamingEvents.USER_END_MESSAGE, () => {
          if (this.state.avatar.muted) return;
          if (processingDelay) clearTimeout(processingDelay);
          processingDelay = setTimeout(() => this.processAvatarTurn(av), 800);
        });
        av.on(StreamingEvents.USER_STOP, () => {
          if (this.state.avatar.muted) return;
          if (processingDelay) clearTimeout(processingDelay);
          processingDelay = setTimeout(() => this.processAvatarTurn(av), 1200);
        });

        // 7) Avvia sessione streaming
        await av.createStartAvatar({
          quality: AvatarQuality.Low,
          avatarName: avatarId || HEYGEN_AVATAR_ID,
          language: 'it',
          disableIdleTimeout: false
        });

      } catch (err) {
        console.error('startAvatar error', err);
        this.state.avatar.connected = false;
        this.refs.content.innerHTML = `<div class="error-banner">Errore avatar: ${escapeHtml(err.message)}</div>` +
          `<div class="empty"><button id="btn-back-text">Torna alla chat scritta</button></div>`;
        const back = this.refs.content.querySelector('#btn-back-text');
        if (back) back.addEventListener('click', () => this.switchMode('text'));
      }
    }

    async processAvatarTurn(av) {
      const msg = (this.userBuffer || '').trim();
      this.userBuffer = '';
      if (!msg || msg.length < 3) return;
      if (this.state.avatar.processing) return;
      if (this.state.avatar.talking) {
        this.userBuffer = msg;
        setTimeout(() => this.processAvatarTurn(av), 1000);
        return;
      }
      this.state.avatar.processing = true;
      if (this.refs.statusText) this.refs.statusText.textContent = 'Sto pensando...';

      this.appendTranscript('user', msg);

      try {
        const session = await this.ensureSession();
        const result = await this.api('/avatar/turn', {
          method: 'POST',
          body: JSON.stringify({ sessionId: session.id, message: msg, language: 'it' })
        });
        const spoken = result.spoken || result.reply || '';
        this.appendTranscript('assistant', spoken, result.citations);
        const TaskType = this.state.avatar._enums?.TaskType || { REPEAT: 'repeat' };
        try {
          await av.speak({ text: spoken, task_type: TaskType.REPEAT });
        } catch (e) { console.warn('avatar speak error', e); }
      } catch (err) {
        const TaskType = this.state.avatar._enums?.TaskType || { REPEAT: 'repeat' };
        try {
          await av.speak({
            text: 'Scusami, non sono riuscito a rispondere. Puoi ripetere?',
            task_type: TaskType.REPEAT
          });
        } catch (_) {}
        console.error(err);
      } finally {
        this.state.avatar.processing = false;
      }
    }

    appendTranscript(role, text, citations) {
      if (!this.refs.transcript) return;
      const cls = role === 'user' ? 'user' : 'assistant';
      const body = role === 'assistant' && citations?.length
        ? renderCitations(text, citations)
        : escapeHtml(text);
      const div = document.createElement('div');
      div.className = `msg ${cls}`;
      div.innerHTML = body;
      this.refs.transcript.appendChild(div);
      this.refs.transcript.scrollTop = this.refs.transcript.scrollHeight;
    }

    async toggleAvatarMute() {
      const av = this.state.avatar.session;
      if (!av) return;
      try {
        if (this.state.avatar.muted) {
          if (typeof av.startVoiceChat === 'function') await av.startVoiceChat();
          this.state.avatar.muted = false;
        } else {
          if (typeof av.closeVoiceChat === 'function') await av.closeVoiceChat();
          else if (typeof av.stopVoiceChat === 'function') await av.stopVoiceChat();
          this.state.avatar.muted = true;
        }
        this.renderAvatarStage();
      } catch (err) {
        console.error('mute toggle error', err);
      }
    }

    async stopAvatar() {
      const av = this.state.avatar.session;
      if (!av) return;
      try {
        if (typeof av.stopAvatar === 'function') await av.stopAvatar();
        else if (typeof av.disconnect === 'function') await av.disconnect();
      } catch (_) {}
      this.state.avatar.session = null;
      this.state.avatar.connected = false;
      this.state.avatar.stream = null;
      if (this.state.mode === 'avatar' && this.state.open) {
        this.renderAvatarStage();
      }
    }
  }

  // safeParseJson per gestire citations come stringa JSON o array gia' parsato
  function safeParseJson(s, fallback) {
    if (Array.isArray(s)) return s;
    if (!s) return fallback;
    try { return JSON.parse(s); } catch (_) { return fallback; }
  }

  // Registra il Custom Element (solo se non gia' registrato)
  if (!customElements.get('prof-carbonio-chat')) {
    customElements.define('prof-carbonio-chat', ProfCarbonioChat);
  }

  // Auto-inject nelle pagine /learn/ se manca il tag (comodita')
  document.addEventListener('DOMContentLoaded', () => {
    if (!document.querySelector('prof-carbonio-chat')) {
      // Inserisce automaticamente nel body (non rompe layout grazie a position:fixed)
      const el = document.createElement('prof-carbonio-chat');
      document.body.appendChild(el);
    }
  });
})();
