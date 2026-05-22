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
// Avatar: HeyGen LiveAvatar SDK (@heygen/liveavatar-web-sdk) caricato on-demand
//         dal bundle locale /learn/js/vendor/liveavatar-bundle.mjs.

(function () {
  'use strict';

  // =========================================================================
  // CONFIG
  // =========================================================================
  const API_BASE = '/api/tutor';
  // LiveAvatar SDK — bundle locale (@heygen/liveavatar-web-sdk@^0.0.10) gia'
  // presente nel repo, stesso pattern usato in azzurra-wrapper. avatarId +
  // session token vengono dal backend (env LIVEAVATAR_API_KEY +
  // LIVEAVATAR_AVATAR_ID) via POST /api/tutor/avatar/session.
  const LIVEAVATAR_SDK_URLS = [
    '/learn/js/vendor/liveavatar-bundle.mjs'
  ];
  // D-ID Agents Client SDK — provider alternativo. Il widget instrada a uno
  // dei due flussi (LiveAvatar o D-ID) in base a state.config.avatarProvider,
  // letto da GET /api/tutor/config (controllato dall'admin via tutor_settings).
  const DID_SDK_URLS = [
    'https://esm.sh/@d-id/client-sdk',
    'https://cdn.jsdelivr.net/npm/@d-id/client-sdk/+esm'
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

  // Stringa "umana" di un errore: gestisce Error, Response, oggetti, stringhe.
  // Evita il classico "[object Object]" quando si fa template literal su un oggetto.
  function stringifyError(err) {
    if (!err) return 'Errore sconosciuto';
    if (typeof err === 'string') return err;
    if (err.message) return err.message;
    if (err.error) return typeof err.error === 'string' ? err.error : JSON.stringify(err.error);
    if (err.statusText) return `${err.status} ${err.statusText}`;
    try { return JSON.stringify(err); } catch (_) { return String(err); }
  }

  // Sostituisce i marker [N] o [^N] con chip cliccabili (data-cite="N").
  // Claude haiku spesso scrive [N] senza il caret nonostante il prompt, quindi
  // accettiamo entrambi i formati.
  function renderCitations(text, citations) {
    const safe = escapeHtml(text);
    const maxN = citations?.length || 0;
    return safe.replace(/\[\^?(\d+)\]/g, (match, n) => {
      const num = Number(n);
      // Solo numeri che corrispondono a una citazione disponibile
      if (!num || num < 1 || num > maxN) return match;
      const cit = citations.find(c => c.n === num);
      if (!cit) return match;
      const title = escapeHtml(cit.title || '');
      const url = buildCitationUrl(cit);
      return `<a class="cite" data-cite="${num}" data-url="${url ? escapeHtml(url) : ''}" href="${url ? escapeHtml(url) : '#'}" target="_blank" rel="noopener" title="${title}">[${num}]</a>`;
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

    .content {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .messages {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 16px;
      display: flex; flex-direction: column; gap: 12px;
      scrollbar-width: thin;
    }
    .messages::-webkit-scrollbar { width: 6px; }
    .messages::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
    .messages::-webkit-scrollbar-track { background: transparent; }
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
    .quick-prompts {
      display: flex; gap: 6px;
      overflow-x: auto;
      overflow-y: hidden;
      padding: 2px 0 6px;
      scrollbar-width: none;
    }
    .quick-prompts::-webkit-scrollbar { display: none; }
    .quick-prompts button {
      flex-shrink: 0;
      background: #f0fdf4;
      border: 1px solid #bbf7d0;
      color: var(--pc-primary-dark);
      padding: 6px 10px;
      border-radius: 14px;
      font-size: 11px;
      cursor: pointer;
      white-space: nowrap;
      transition: all .15s;
    }
    .quick-prompts button:hover { background: var(--pc-accent); border-color: var(--pc-primary); }
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
      background: var(--pc-bg); min-height: 0;
    }
    /* Video con aspect-ratio fissa: non si rimpicciolisce mai quando la
       trascrizione cresce sotto. flex-shrink:0 e' l'altra meta' del fix.
       object-fit: contain mostra tutto l'avatar senza tagliare (vs cover che
       ritaglia per riempire). Lo sfondo chiaro sostituisce le eventuali bande
       laterali nere quando l'aspect del video sorgente non matcha il container. */
    .avatar-video-wrap {
      position: relative; background: #f0f4ef;
      flex-shrink: 0;
      width: 100%;
      aspect-ratio: 4 / 3;
    }
    .avatar-video-wrap video {
      width: 100%; height: 100%; object-fit: contain; display: block;
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
      max-height: 200px; min-height: 60px; overflow-y: auto;
      background: var(--pc-bg); padding: 12px;
      border-top: 1px solid var(--pc-border);
      font-size: 13px;
    }
    .avatar-transcript .msg { max-width: 100%; }
    .avatar-transcript:empty::before {
      content: 'La trascrizione della conversazione apparira\' qui.';
      color: var(--pc-muted); font-style: italic; font-size: 12px;
    }

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
        <div class="subtitle session-title">Tutor del Master in Carbon Farming</div>
      </div>
      <button class="icon" data-action="new" title="Nuova conversazione">＋</button>
      <button class="icon" data-action="history" title="Sessioni precedenti">📚</button>
      <button class="icon" data-action="close" title="Chiudi">✕</button>
    </header>

    <div class="mode-toggle">
      <button data-mode="text" class="active">💬 Chat</button>
      <button data-mode="avatar">🎙️ Voce + Avatar</button>
    </div>

    <div class="content"></div>

    <footer class="input-area" data-when="text">
      <div class="quick-prompts">
        <button data-prompt="Cosa stabilisce il Regolamento UE 2024/3012?">📜 Regolamento UE 2024/3012</button>
        <button data-prompt="Cos'e' il carbon farming e come funziona?">🌱 Cos'è il carbon farming</button>
        <button data-prompt="Come si misura il SOC nel suolo?">🔬 Misurare il SOC</button>
        <button data-prompt="Quali pratiche generano piu' crediti CRCF?">📊 Pratiche e crediti</button>
        <button data-prompt="Cos'e' il biochar e come si applica?">🪨 Biochar</button>
        <button data-prompt="Che differenza c'e' tra DACCS, BioCCS e BCR?">⚗️ DACCS vs BioCCS</button>
      </div>
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
        config: null, // { chatEnabled, avatarEnabled, avatarProvider, dailyLimit }
        avatar: { sdkLoaded: false, session: null, connected: false, listening: false, talking: false }
      };
    }

    connectedCallback() {
      const sr = this.shadowRoot;
      this.refs = {
        fab: sr.querySelector('.fab'),
        fabLabel: sr.querySelector('.fab-label'),
        panel: sr.querySelector('.panel'),
        content: sr.querySelector('.content'),
        modeToggle: sr.querySelector('.mode-toggle'),
        modeButtons: sr.querySelectorAll('.mode-toggle button'),
        modeChat: sr.querySelector('.mode-toggle button[data-mode="text"]'),
        modeAvatar: sr.querySelector('.mode-toggle button[data-mode="avatar"]'),
        inputArea: sr.querySelector('.input-area'),
        textarea: sr.querySelector('textarea'),
        sendBtn: sr.querySelector('.send'),
        quota: sr.querySelector('.quota'),
        sessionTitle: sr.querySelector('.session-title')
      };

      // Nascondi il FAB finche' non abbiamo il config: evita "flash" se entrambi disabilitati
      this.refs.fab.style.display = 'none';
      if (this.refs.fabLabel) this.refs.fabLabel.style.display = 'none';

      this.refs.fab.addEventListener('click', () => this.openPanel());
      sr.querySelector('[data-action="close"]').addEventListener('click', () => this.closePanel());
      sr.querySelector('[data-action="history"]').addEventListener('click', () => this.showHistory());
      const newBtn = sr.querySelector('[data-action="new"]');
      if (newBtn) newBtn.addEventListener('click', () => this.startNewSession());

      // Quick-prompts: scrivono nel textarea e mandano la domanda
      sr.querySelectorAll('.quick-prompts button[data-prompt]').forEach(b => {
        b.addEventListener('click', () => {
          this.refs.textarea.value = b.dataset.prompt;
          this.sendUserMessage();
        });
      });

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

      // Carica feature flags PRIMA di decidere se mostrare il bottone
      this.bootstrapConfig();
    }

    async bootstrapConfig() {
      try {
        // Endpoint pubblico (autenticato studente) che ritorna i flag attivi
        const token = getAuthToken();
        if (!token) {
          // Non loggato: niente widget
          return;
        }
        const res = await fetch(API_BASE + '/config', {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        if (!res.ok) {
          // Fallback prudente: se l'endpoint non esiste, assumiamo tutto OFF
          this.state.config = { chatEnabled: false, avatarEnabled: false };
        } else {
          this.state.config = await res.json();
        }
      } catch (err) {
        console.warn('[prof-carbonio] config load failed, hiding widget', err);
        this.state.config = { chatEnabled: false, avatarEnabled: false };
      }
      this.applyConfig();
    }

    applyConfig() {
      const c = this.state.config || {};
      const anyEnabled = c.chatEnabled || c.avatarEnabled;

      // Se nessuna modalita' attiva, NON mostriamo il bottone fluttuante
      if (!anyEnabled) {
        this.refs.fab.style.display = 'none';
        if (this.refs.fabLabel) this.refs.fabLabel.style.display = 'none';
        // Chiudi il pannello se per caso era stato lasciato aperto
        this.closePanel();
        return;
      }

      // Mostra il FAB (e l'etichetta)
      this.refs.fab.style.display = '';
      if (this.refs.fabLabel) this.refs.fabLabel.style.display = '';

      // Mostra/nascondi i tab in base ai flag
      if (this.refs.modeChat) this.refs.modeChat.style.display = c.chatEnabled ? '' : 'none';
      if (this.refs.modeAvatar) this.refs.modeAvatar.style.display = c.avatarEnabled ? '' : 'none';

      // Se uno solo dei due è attivo, nascondiamo proprio la barra dei tab (non serve scegliere)
      if (c.chatEnabled !== c.avatarEnabled) {
        this.refs.modeToggle.style.display = 'none';
      } else {
        this.refs.modeToggle.style.display = '';
      }

      // Scegli la modalita' di default coerente coi flag
      if (this.state.mode === 'avatar' && !c.avatarEnabled) this.state.mode = 'text';
      if (this.state.mode === 'text' && !c.chatEnabled && c.avatarEnabled) this.state.mode = 'avatar';

      // Aggiorna stato visivo dei mode buttons
      this.refs.modeButtons.forEach(b => {
        b.classList.toggle('active', b.dataset.mode === this.state.mode);
      });

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
        this.updateSessionTitle();
        this.renderMessages();
      } catch (err) {
        this.showError(stringifyError(err));
      }
    }

    updateSessionTitle() {
      if (!this.refs.sessionTitle) return;
      if (this.state.session?.title && this.state.messages.length > 0) {
        const t = this.state.session.title;
        this.refs.sessionTitle.textContent = t.length > 50 ? t.slice(0, 50) + '…' : t;
      } else {
        this.refs.sessionTitle.textContent = 'Tutor del Master in Carbon Farming';
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
        // LiveAvatar ha STT integrato (voice chat in mode FULL), pero' lasciamo
        // visibile l'input testo come fallback: in ambienti rumorosi o quando
        // l'utente preferisce digitare. sendUserMessage() instrada verso
        // processAvatarTurn quando state.mode === 'avatar'.
        this.refs.inputArea.style.display = '';
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

      // Modalita' avatar: il messaggio va a /avatar/turn (Claude+RAG) e poi
      // viene pronunciato dall'avatar LiveAvatar via session.repeat(). La
      // trascrizione resta visibile sopra al video tramite appendTranscript()
      // in processAvatarTurn().
      if (this.state.mode === 'avatar') {
        this.refs.textarea.value = '';
        this.autoresize();
        this.refs.sendBtn.disabled = true;
        try {
          await this.processAvatarTurn(null, text);
        } finally {
          this.refs.sendBtn.disabled = false;
        }
        return;
      }

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

        // Aggiorna titolo sessione (la prima domanda diventa il titolo lato server)
        if (this.state.messages.filter(m => m.role === 'user').length === 1) {
          this.state.session = { ...this.state.session, title: text.slice(0, 80) };
          this.updateSessionTitle();
        }

        this.renderMessages();
      } catch (err) {
        this.state.messages = this.state.messages.filter(m => !m._placeholder);
        const msg = err.status === 429
          ? `⚠️ Hai raggiunto il limite giornaliero di domande. Riprova domani.`
          : `Errore: ${stringifyError(err)}`;
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
              this.updateSessionTitle();
              this.renderMessages();
            } catch (err) { alert(stringifyError(err)); }
          });
        });
      } catch (err) {
        this.showError(stringifyError(err));
      }
    }

    async startNewSession() {
      localStorage.removeItem(PERSIST_KEY);
      this.state.session = null;
      this.state.messages = [];
      this.refs.content.innerHTML = '<div class="empty"><p>Carico...</p></div>';
      try {
        await this.ensureSession();
        this.updateSessionTitle();
        this.renderMessages();
        this.refs.textarea.focus();
      } catch (err) {
        this.showError(stringifyError(err));
      }
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
              <small style="opacity:0.7;font-size:11px;">Powered by FIB</small>
            </div>
          </div>
        `;
        this.refs.content.querySelector('[data-action="avatar-start"]')
          .addEventListener('click', () => this.startAvatar());
      } else {
        // Bottone microfono: provider-specific.
        // - LiveAvatar: STT integrato sempre attivo, il bottone fa mute/unmute
        //   del microfono lato SDK.
        // - D-ID: niente STT integrato, il bottone attiva il Web Speech API
        //   del browser (push-to-talk). Action diverso (avatar-listen).
        const providerForBtn = this.state.avatar.provider || 'liveavatar';
        const isDidProvider = providerForBtn === 'd-id' || providerForBtn === 'did';
        const micButton = isDidProvider
          ? `<button data-action="avatar-listen">${a.isListening ? '⏹ Stop' : '🎤 Parla'}</button>`
          : `<button data-action="avatar-mute">🎤 ${a.muted ? 'Riattiva' : 'Muta'}</button>`;
        this.refs.content.innerHTML = `
          <div class="avatar-stage">
            <div class="avatar-video-wrap">
              <video autoplay playsinline></video>
              <div class="status"><span class="dot"></span><span class="status-text">Connesso</span></div>
            </div>
            <div class="avatar-controls">
              ${micButton}
              <button class="danger" data-action="avatar-stop">Termina</button>
            </div>
            <div class="avatar-transcript"></div>
          </div>
        `;
        this.avatarVideoEl = this.refs.content.querySelector('video');
        // Provider-specific attach del video element.
        const provider = this.state.avatar.provider || 'liveavatar';
        if ((provider === 'd-id' || provider === 'did') && this.state.avatar.stream && this.avatarVideoEl) {
          // D-ID: lo stream WebRTC arriva via onSrcObjectReady, va assegnato a srcObject.
          try {
            const stream = this.state.avatar.stream.getTracks
              ? this.state.avatar.stream
              : (this.state.avatar.stream.stream || this.state.avatar.stream);
            this.avatarVideoEl.srcObject = stream;
            this.avatarVideoEl.play().catch(() => {});
          } catch (e) { console.warn('D-ID video attach error', e); }
        } else if (this.state.avatar.session) {
          // LiveAvatar: pattern session.attach(videoElement). Lo facciamo qui
          // (oltre che in SESSION_STREAM_READY) perche' renderAvatarStage puo'
          // venire chiamato anche dopo che lo stream e' gia' pronto (es. resize,
          // toggle mute) e il video element appena ricreato va ri-attaccato.
          this.attachLiveAvatarVideo();
        }
        // Listener provider-specific per il bottone microfono.
        const micBtn = this.refs.content.querySelector('[data-action="avatar-listen"]')
                    || this.refs.content.querySelector('[data-action="avatar-mute"]');
        if (micBtn) {
          micBtn.addEventListener('click', () => {
            if (micBtn.dataset.action === 'avatar-listen') this.toggleAvatarListen();
            else this.toggleAvatarMute();
          });
        }
        this.refs.content.querySelector('[data-action="avatar-stop"]')
          .addEventListener('click', () => this.stopAvatar());
        this.refs.transcript = this.refs.content.querySelector('.avatar-transcript');
        this.refs.statusText = this.refs.content.querySelector('.status-text');
      }
    }

    // ----------------------------------------------------------------------
    // Dispatcher: sceglie il provider avatar in base a config.avatarProvider
    // ('liveavatar' = HeyGen LiveAvatar | 'd-id' = D-ID Agents | default liveavatar).
    // ----------------------------------------------------------------------
    async startAvatar() {
      const provider = (this.state.config?.avatarProvider || 'liveavatar').toLowerCase();
      this.state.avatar.provider = provider;
      if (provider === 'd-id' || provider === 'did') {
        return this.startAvatarDid();
      }
      return this.startAvatarLiveAvatar();
    }

    async loadLiveAvatarSDK() {
      if (this.state.avatar.liveAvatarSdk) return this.state.avatar.liveAvatarSdk;
      this.refs.content.innerHTML = `<div class="empty"><p>Carico l'avatar...</p></div>`;

      const errors = [];
      for (const url of LIVEAVATAR_SDK_URLS) {
        try {
          console.log('[prof-carbonio] Loading LiveAvatar SDK from', url);
          const mod = await import(/* @vite-ignore */ url);
          if (!mod || typeof mod.LiveAvatarSession !== 'function') {
            throw new Error('SDK module missing LiveAvatarSession export');
          }
          this.state.avatar.liveAvatarSdk = mod;
          console.log('[prof-carbonio] LiveAvatar SDK loaded');
          return mod;
        } catch (err) {
          console.warn(`[prof-carbonio] SDK ${url} failed:`, err.message);
          errors.push(`${url}: ${err.message}`);
        }
      }
      console.error('[prof-carbonio] All LiveAvatar SDK sources failed:', errors);
      throw new Error('Impossibile caricare l\'SDK LiveAvatar.');
    }

    async loadDidSDK() {
      if (this.state.avatar.didSdk) return this.state.avatar.didSdk;
      this.refs.content.innerHTML = `<div class="empty"><p>Carico l'avatar...</p></div>`;

      const errors = [];
      for (const url of DID_SDK_URLS) {
        try {
          console.log('[prof-carbonio] Loading D-ID SDK from', url);
          const mod = await import(/* @vite-ignore */ url);
          if (!mod || typeof mod.createAgentManager !== 'function') {
            throw new Error('SDK module missing createAgentManager export');
          }
          this.state.avatar.didSdk = mod;
          console.log('[prof-carbonio] D-ID SDK loaded');
          return mod;
        } catch (err) {
          console.warn(`[prof-carbonio] D-ID SDK ${url} failed:`, err.message);
          errors.push(`${url}: ${err.message}`);
        }
      }
      console.error('[prof-carbonio] All D-ID SDK CDNs failed:', errors);
      throw new Error('Impossibile caricare l\'SDK D-ID.');
    }

    async startAvatarLiveAvatar() {
      try {
        const sdk = await this.loadLiveAvatarSDK();
        const {
          LiveAvatarSession,
          SessionEvent,
          SessionState,
          AgentEventsEnum
        } = sdk;
        if (!LiveAvatarSession || !SessionEvent || !AgentEventsEnum) {
          throw new Error('SDK LiveAvatar non espone gli enum attesi');
        }
        this.state.avatar._enums = { SessionEvent, SessionState, AgentEventsEnum };

        // 1) Token sessione dal nostro backend (chiama api.liveavatar.com)
        const { sessionToken } = await this.api('/avatar/session', {
          method: 'POST',
          body: JSON.stringify({ language: 'it' })
        });
        if (!sessionToken) throw new Error('Backend non ha restituito sessionToken');

        // 2) Assicura sessione chat per persistere messaggi
        await this.ensureSession();

        // 3) Crea sessione LiveAvatar - mode FULL = voice chat con STT integrato
        const session = new LiveAvatarSession(sessionToken, {
          voiceChat: { defaultMuted: false }
        });
        this.state.avatar.session = session;
        this.state.avatar.muted = false;
        this.userBuffer = '';

        // 4) Eventi sessione
        session.on(SessionEvent.SESSION_STATE_CHANGED, (event) => {
          const state = event?.state || event;
          if (state === SessionState.CONNECTED || state === 'CONNECTED') {
            this.state.avatar.connected = true;
            if (this.refs.statusText) this.refs.statusText.textContent = 'In ascolto...';
            this.renderAvatarStage();
          } else if (state === SessionState.DISCONNECTED || state === 'DISCONNECTED') {
            this.state.avatar.connected = false;
            this.renderAvatarStage();
          }
        });

        // 5) Stream pronto -> attach al <video> + saluto iniziale
        session.on(SessionEvent.SESSION_STREAM_READY, () => {
          this.state.avatar.connected = true;
          this.renderAvatarStage();
          this.attachLiveAvatarVideo();
          setTimeout(async () => {
            try {
              await this.avatarSpeak('Ciao, sono Prof. Carbonio. Puoi chiedermi a voce o scrivermi una domanda sul Master in Carbon Farming.');
            } catch (e) { console.warn('welcome speak error', e); }
          }, 500);
        });

        // 6) Eventi avatar (parla / smette di parlare)
        session.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, () => {
          this.state.avatar.talking = true;
          if (this.refs.statusText) this.refs.statusText.textContent = 'Prof. Carbonio parla...';
        });
        session.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, () => {
          this.state.avatar.talking = false;
          if (this.refs.statusText) this.refs.statusText.textContent = 'In ascolto...';
          // Se c'erano trascrizioni accumulate mentre parlava, processale ora
          if ((this.userBuffer || '').trim().length >= 3) {
            setTimeout(() => this.processAvatarTurn(session), 200);
          }
        });

        // 7) Eventi utente (STT integrato del LiveAvatar)
        session.on(AgentEventsEnum.USER_SPEAK_STARTED, () => {
          if (this.state.avatar.muted) return;
          if (this.refs.statusText) this.refs.statusText.textContent = 'Ti ascolto...';
        });

        session.on(AgentEventsEnum.USER_TRANSCRIPTION, (event) => {
          if (this.state.avatar.muted) return;
          const text = event?.text || event?.transcript || event?.detail?.text;
          if (!text) return;
          // Interrompi eventuali risposte automatiche dell'SDK
          try { session.interrupt && session.interrupt(); } catch (_) {}
          this.userBuffer = ((this.userBuffer || '') + ' ' + text).trim();
        });

        let endTimer = null;
        session.on(AgentEventsEnum.USER_SPEAK_ENDED, () => {
          if (this.state.avatar.muted) return;
          if (endTimer) clearTimeout(endTimer);
          // 1.5s di silenzio prima di considerare il turno chiuso
          endTimer = setTimeout(() => this.processAvatarTurn(session), 1500);
        });

        // 8) Avvia sessione (parametri presi dal token: avatarId, language, mode)
        await session.start();

      } catch (err) {
        console.error('startAvatar error', err);
        this.state.avatar.connected = false;
        const msg = stringifyError(err);
        this.refs.content.innerHTML = `<div class="error-banner">Errore avatar: ${escapeHtml(msg)}</div>` +
          `<div class="empty"><button id="btn-back-text">Torna alla chat scritta</button></div>`;
        const back = this.refs.content.querySelector('#btn-back-text');
        if (back) back.addEventListener('click', () => this.switchMode('text'));
      }
    }

    // ----------------------------------------------------------------------
    // Provider D-ID — alternativo a LiveAvatar, scelto da admin via flag
    // tutor_settings.avatar_provider='d-id'. Niente STT integrato in v1:
    // l'utente scrive nella chat, l'avatar pronuncia la risposta Claude.
    // ----------------------------------------------------------------------
    async startAvatarDid() {
      try {
        const sdk = await this.loadDidSDK();
        const { createAgentManager } = sdk;

        const cfg = await this.api('/did/config', { method: 'GET' });
        if (!cfg?.agentId || !cfg?.clientKey) {
          throw new Error('Backend non ha restituito config D-ID');
        }
        await this.ensureSession();

        const self = this;
        // D-ID v1 NON ha STT integrato (a differenza di LiveAvatar): l'utente
        // deve scrivere nella textarea sotto. Quindi l'etichetta "In ascolto..."
        // sarebbe fuorviante: la sostituiamo con un invito esplicito a scrivere.
        const idleLabel = 'Scrivi qui sotto per chiedere';
        const callbacks = {
          onSrcObjectReady(value) {
            self.state.avatar.stream = value;
            self.state.avatar.connected = true;
            self.renderAvatarStage();
          },
          onConnectionStateChange(state) {
            if (state === 'connected') {
              if (self.refs.statusText) self.refs.statusText.textContent = idleLabel;
            } else if (state === 'disconnected' || state === 'fail' || state === 'failed') {
              self.state.avatar.connected = false;
              self.renderAvatarStage();
            }
          },
          onVideoStateChange(state) {
            const talking = state === 'START' || state === 'start';
            self.state.avatar.talking = talking;
            if (self.refs.statusText) {
              self.refs.statusText.textContent = talking
                ? 'Prof. Carbonio parla...'
                : idleLabel;
            }
          },
          onError(error) {
            // Rumore noto nei primi 200ms di sessione: "session_id" non pronto
            if (error?.kind === 'SessionError' && /session_id/i.test(error.description || '')) return;
            console.warn('[prof-carbonio] D-ID error:', error);
          }
        };

        const agentManager = await createAgentManager(cfg.agentId, {
          auth: { type: 'key', clientKey: cfg.clientKey },
          callbacks,
          streamOptions: { compatibilityMode: 'auto', streamWarmup: false }
        });
        this.state.avatar.session = agentManager;

        await agentManager.connect();

        setTimeout(async () => {
          try {
            await this.avatarSpeak('Ciao, sono Prof. Carbonio. Scrivimi pure una domanda sul Master in Carbon Farming e ti rispondo a voce.');
          } catch (e) { console.warn('welcome speak error', e); }
        }, 800);

      } catch (err) {
        console.error('startAvatarDid error', err);
        this.state.avatar.connected = false;
        const msg = stringifyError(err);
        this.refs.content.innerHTML = `<div class="error-banner">Errore avatar: ${escapeHtml(msg)}</div>` +
          `<div class="empty"><button id="btn-back-text">Torna alla chat scritta</button></div>`;
        const back = this.refs.content.querySelector('#btn-back-text');
        if (back) back.addEventListener('click', () => this.switchMode('text'));
      }
    }

    // LiveAvatar usa session.attach(videoElement) per legare lo stream WebRTC
    // al <video> della UI (renderAvatarStage crea il video element nel DOM).
    attachLiveAvatarVideo() {
      const session = this.state.avatar.session;
      if (!session || typeof session.attach !== 'function') return;
      if (!this.avatarVideoEl) {
        this.avatarVideoEl = this.refs.content && this.refs.content.querySelector('video');
      }
      if (this.avatarVideoEl) {
        try { session.attach(this.avatarVideoEl); }
        catch (e) { console.warn('LiveAvatar attach error', e); }
      }
    }

    // Dispatcher TTS: LiveAvatar usa session.repeat(text), D-ID usa
    // agentManager.speak({type:'text', input:text}). Discrimina su provider.
    async avatarSpeak(text) {
      const session = this.state.avatar.session;
      if (!session || !text) return;
      const provider = this.state.avatar.provider || 'liveavatar';
      if (provider === 'd-id' || provider === 'did') {
        if (typeof session.speak !== 'function') {
          console.warn('[prof-carbonio] D-ID SDK non espone speak()');
          return;
        }
        try { await session.speak({ type: 'text', input: text }); }
        catch (_) {
          try { await session.speak(text); }
          catch (e2) { console.warn('D-ID speak error', e2); }
        }
        return;
      }
      // LiveAvatar (default)
      if (typeof session.repeat !== 'function') {
        console.warn('[prof-carbonio] LiveAvatar SDK non espone repeat()');
        return;
      }
      try { await session.repeat(text); }
      catch (e) { console.warn('LiveAvatar repeat error', e); }
    }

    // Turno conversazionale: input puo' arrivare via voce (USER_TRANSCRIPTION
    // accumulato nel buffer) o via testo (sendUserMessage in modalita' avatar).
    async processAvatarTurn(_session, userMessage) {
      const msg = (userMessage || this.userBuffer || '').trim();
      this.userBuffer = '';
      if (!msg || msg.length < 3) return;
      if (this.state.avatar.processing) return;
      if (this.state.avatar.talking) {
        // Aspetta che l'avatar finisca di parlare prima di lanciare il turno nuovo
        this.userBuffer = msg;
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
        // Due testi distinti:
        //  - speakText: pulito (senza marker / markdown) per il TTS dell'avatar
        //  - transcriptText: con i marker [N] per renderizzare le chip citazione
        const speakText = result.spoken || result.reply || '';
        const transcriptText = result.replyWithMarkers || result.reply || speakText;
        const assistantMessageId = result.messageId || null;
        this.appendTranscript('assistant', transcriptText, result.citations, assistantMessageId);

        // Sincronizziamo i turni anche dentro state.messages cosi' la cronologia
        // avatar non si perde al "Termina" e e' visibile in modalita' Chat scritta
        // (entrambe le modalita' condividono la stessa sessione lato DB).
        this.state.messages.push({
          role: 'user',
          content: msg,
          id: 'avatar-u-' + Date.now(),
          created_at: new Date().toISOString()
        });
        if (assistantMessageId) {
          this.state.messages.push({
            id: assistantMessageId,
            role: 'assistant',
            content: transcriptText,
            citations: result.citations,
            created_at: new Date().toISOString()
          });
        }
        // Aggiorna usage giornaliero come fa sendUserMessage
        if (result.usage) {
          this.state.usage = {
            today: new Date().toISOString().slice(0, 10),
            used: result.usage.used,
            limit: result.usage.limit,
            remaining: result.usage.remaining,
            cost_cents: result.usage.cost_cents
          };
          this.updateQuotaBar && this.updateQuotaBar();
        }

        await this.avatarSpeak(speakText);
      } catch (err) {
        await this.avatarSpeak('Scusami, non sono riuscito a rispondere. Puoi ripetere?').catch(() => {});
        console.error(err);
      } finally {
        this.state.avatar.processing = false;
      }
    }

    appendTranscript(role, text, citations, messageId) {
      if (!this.refs.transcript) return;
      const cls = role === 'user' ? 'user' : 'assistant';
      const body = role === 'assistant' && citations?.length
        ? renderCitations(text, citations)
        : escapeHtml(text);
      const div = document.createElement('div');
      div.className = `msg ${cls}`;
      // Per i messaggi assistant con un ID persistito in DB aggiungiamo il
      // bottone "Chiedi al docente" — stessa azione di escalate della chat
      // testuale, riusa l'endpoint /messages/:id/escalate.
      const actions = (role === 'assistant' && messageId)
        ? `<div class="actions"><button data-action="escalate" data-msg="${escapeHtml(messageId)}">↗️ Chiedi al docente</button></div>`
        : '';
      div.innerHTML = body + actions;
      this.refs.transcript.appendChild(div);
      // Bind del click sul bottone appena aggiunto
      const escBtn = div.querySelector('[data-action="escalate"]');
      if (escBtn) {
        escBtn.addEventListener('click', () => this.escalate(escBtn.dataset.msg));
      }
      this.refs.transcript.scrollTop = this.refs.transcript.scrollHeight;
    }

    // ----------------------------------------------------------------------
    // Browser Web Speech API — fornisce STT lato browser per i provider che
    // non hanno il riconoscimento vocale integrato (es. D-ID). LiveAvatar
    // non lo usa perche' fa STT internamente. Funziona bene su Chrome / Edge
    // / Android Chrome; su Safari iOS e' limitato.
    // ----------------------------------------------------------------------
    initBrowserSTT() {
      const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!Rec) return null;
      const rec = new Rec();
      rec.lang = 'it-IT';
      rec.interimResults = true;
      rec.continuous = false; // si chiude da sola dopo silenzio
      rec.onresult = (event) => {
        let finalText = '';
        let interimText = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const r = event.results[i];
          if (r.isFinal) finalText += r[0].transcript;
          else interimText += r[0].transcript;
        }
        const combined = (finalText || interimText).trim();
        this.state.avatar.recognitionBuffer = combined;
        if (this.refs.statusText && combined) {
          this.refs.statusText.textContent = '🎤 ' + combined;
        }
      };
      rec.onend = () => {
        this.state.avatar.isListening = false;
        const text = (this.state.avatar.recognitionBuffer || '').trim();
        this.state.avatar.recognitionBuffer = '';
        // Aggiorna etichetta bottone in-place senza ri-renderare lo stage
        const btn = this.refs.content && this.refs.content.querySelector('[data-action="avatar-listen"]');
        if (btn) btn.textContent = '🎤 Parla';
        if (text) {
          this.processAvatarTurn(null, text);
        } else if (this.refs.statusText) {
          this.refs.statusText.textContent = 'Scrivi qui sotto per chiedere';
        }
      };
      rec.onerror = (event) => {
        console.warn('STT error:', event.error);
        this.state.avatar.isListening = false;
        const btn = this.refs.content && this.refs.content.querySelector('[data-action="avatar-listen"]');
        if (btn) btn.textContent = '🎤 Parla';
        if (this.refs.statusText) {
          this.refs.statusText.textContent = event.error === 'no-speech'
            ? 'Non ho sentito nulla, riprova'
            : event.error === 'not-allowed'
              ? 'Permesso microfono negato'
              : 'Microfono non disponibile';
        }
      };
      return rec;
    }

    async toggleAvatarListen() {
      if (!this.state.avatar.recognition) {
        this.state.avatar.recognition = this.initBrowserSTT();
      }
      const rec = this.state.avatar.recognition;
      if (!rec) {
        alert('Il tuo browser non supporta il riconoscimento vocale. Usa Chrome / Edge o scrivi la tua domanda nella casella di testo.');
        return;
      }
      const btn = this.refs.content && this.refs.content.querySelector('[data-action="avatar-listen"]');
      if (this.state.avatar.isListening) {
        try { rec.stop(); } catch (_) {}
      } else {
        this.state.avatar.recognitionBuffer = '';
        this.state.avatar.isListening = true;
        if (this.refs.statusText) this.refs.statusText.textContent = '🎤 Ti ascolto...';
        if (btn) btn.textContent = '⏹ Stop';
        try { rec.start(); }
        catch (e) {
          console.warn('STT start error:', e);
          this.state.avatar.isListening = false;
          if (btn) btn.textContent = '🎤 Parla';
        }
      }
    }

    // Dispatcher mute: LiveAvatar ha voice chat integrata (mute microfono SDK),
    // D-ID v1 non ha STT quindi il mute si applica al <video> element (silenzia
    // l'audio del rendering avatar, utile in ambiente pubblico).
    // IMPORTANTE: NON chiamiamo renderAvatarStage() qui — ricreerebbe l'HTML
    // dello stage svuotando la trascrizione. Aggiorniamo solo l'etichetta
    // del bottone mute in-place.
    async toggleAvatarMute() {
      const session = this.state.avatar.session;
      const provider = this.state.avatar.provider || 'liveavatar';
      try {
        if (provider === 'd-id' || provider === 'did') {
          if (!this.avatarVideoEl) return;
          this.state.avatar.muted = !this.state.avatar.muted;
          this.avatarVideoEl.muted = this.state.avatar.muted;
        } else {
          // LiveAvatar
          if (!session) return;
          if (this.state.avatar.muted) {
            if (typeof session.unmuteVoiceChat === 'function') await session.unmuteVoiceChat();
            else if (typeof session.startVoiceChat === 'function') await session.startVoiceChat();
            this.state.avatar.muted = false;
          } else {
            if (typeof session.muteVoiceChat === 'function') await session.muteVoiceChat();
            else if (typeof session.stopVoiceChat === 'function') await session.stopVoiceChat();
            this.state.avatar.muted = true;
          }
        }
        const muteBtn = this.refs.content && this.refs.content.querySelector('[data-action="avatar-mute"]');
        if (muteBtn) {
          muteBtn.textContent = `🎤 ${this.state.avatar.muted ? 'Riattiva' : 'Muta'}`;
        }
      } catch (err) {
        console.error('mute toggle error', err);
      }
    }

    async stopAvatar() {
      const session = this.state.avatar.session;
      if (session) {
        try {
          // LiveAvatar: session.stop()  |  D-ID: agentManager.disconnect()
          if (typeof session.stop === 'function') await session.stop();
          else if (typeof session.disconnect === 'function') await session.disconnect();
        } catch (_) {}
      }
      // Ferma eventuale Web Speech in corso (provider D-ID)
      if (this.state.avatar.recognition && this.state.avatar.isListening) {
        try { this.state.avatar.recognition.stop(); } catch (_) {}
      }
      this.state.avatar.session = null;
      this.state.avatar.provider = null;
      this.state.avatar.connected = false;
      this.state.avatar.stream = null;
      this.state.avatar.talking = false;
      this.state.avatar.processing = false;
      this.state.avatar.isListening = false;
      this.state.avatar.recognitionBuffer = '';
      this.userBuffer = '';
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
