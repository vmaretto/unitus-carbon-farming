// learn/js/study-companion.js
// Widget AI Study Companion. Custom Element <study-companion-widget>.
//
// - Pesca lo stato corrente da /api/companion/study-plan/today
// - Se nessun piano: mostra CTA "Crea il tuo piano" che apre il modal di setup
// - Se piano in 'generating': mostra spinner e polla ogni 3 sec
// - Se piano 'active': mostra header + lista artefatti del giorno + progresso
// - Click su un artefatto: lo espande in-place con il contenuto reso
//   (markdown / quiz / flashcards / micro_lesson)
//
// Auth: JWT in localStorage.learnToken (stesso pattern del resto del /learn/).
//
// Uso:
//   <study-companion-widget></study-companion-widget>
//   <script src="/learn/js/study-companion.js" defer></script>

(function () {
  'use strict';

  const API = '/api/companion';
  const TOKEN_KEYS = ['learnToken', 'token'];
  const POLL_INTERVAL_MS = 3000;
  const POLL_TIMEOUT_MS = 60000;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function getToken() {
    for (const k of TOKEN_KEYS) {
      const v = localStorage.getItem(k);
      if (v) return v;
    }
    return null;
  }

  async function api(path, opts = {}) {
    const token = getToken();
    if (!token) throw new Error('Non autenticato');
    const res = await fetch(API + path, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(opts.headers || {})
      }
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status} ${text || res.statusText}`);
    }
    return res.json();
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  // Mini markdown parser: gestisce headings, bold, italic, blockquote, paragrafi.
  // Volutamente minimale — l'agente in Sprint 2 genererà markdown semplice.
  function renderMarkdown(md) {
    if (!md) return '';
    const lines = String(md).split(/\n/);
    let html = '';
    let inBlockquote = false;
    let buf = [];

    function flushBuf() {
      if (buf.length) {
        const para = buf.join(' ')
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replace(/\*([^*]+)\*/g, '<em>$1</em>');
        html += `<p>${para}</p>`;
        buf = [];
      }
    }

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) {
        flushBuf();
        if (inBlockquote) { html += '</blockquote>'; inBlockquote = false; }
        continue;
      }
      if (line.startsWith('## ')) {
        flushBuf();
        if (inBlockquote) { html += '</blockquote>'; inBlockquote = false; }
        html += `<h3>${escapeHtml(line.slice(3))}</h3>`;
        continue;
      }
      if (line.startsWith('> ')) {
        flushBuf();
        if (!inBlockquote) { html += '<blockquote>'; inBlockquote = true; }
        const content = line.slice(2)
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replace(/\*([^*]+)\*/g, '<em>$1</em>');
        html += content + ' ';
        continue;
      }
      // Linea con bold inline a inizio paragrafo "**1. Titolo.**"
      buf.push(
        escapeHtml(line)
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      );
    }
    flushBuf();
    if (inBlockquote) html += '</blockquote>';
    return html;
  }

  const ARTIFACT_ICONS = {
    summary: { icon: 'M3 4h18M3 12h18M3 20h12', bg: '#E6F1FB', fg: '#185FA5' },
    quiz_personalized: { icon: 'M12 17v.01M12 14a3 3 0 1 0-3-3', bg: '#FAEEDA', fg: '#854F0B' },
    flashcards: { icon: 'M4 6h12v12H4zM8 2h12v12', bg: '#E1F5EE', fg: '#0F6E56' },
    micro_lesson: { icon: 'M4 4h16v16H4zM8 8h8M8 12h8M8 16h5', bg: '#EEEDFE', fg: '#3C3489' },
    mind_map: { icon: 'M12 12m-3 0a3 3 0 1 0 6 0 3 3 0 1 0-6 0', bg: '#FBEAF0', fg: '#993556' },
    audio_overview: { icon: 'M9 4v16l13-8L9 4z', bg: '#FCEBEB', fg: '#A32D2D' }
  };

  const ARTIFACT_LABELS = {
    summary: 'Riassunto',
    quiz_personalized: 'Quiz',
    flashcards: 'Flashcards',
    micro_lesson: 'Micro-lezione',
    mind_map: 'Mappa concettuale',
    audio_overview: 'Audio overview'
  };

  // ---------------------------------------------------------------------------
  // Custom Element
  // ---------------------------------------------------------------------------
  class StudyCompanionWidget extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this._state = { loading: true, plan: null, artifacts: [], progress: null, modules: [] };
      this._pollTimer = null;
      this._pollStart = 0;
    }

    connectedCallback() {
      this._renderShell();
      this.refresh();
    }

    disconnectedCallback() {
      if (this._pollTimer) clearTimeout(this._pollTimer);
    }

    _renderShell() {
      this.shadowRoot.innerHTML = `
        <style>
          :host {
            display: block;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #1f2933;
            margin: 1rem 0 1.5rem;
          }
          .card {
            background: #ffffff;
            border-radius: 12px;
            border: 1px solid #e5e7eb;
            padding: 1.25rem 1.5rem;
            box-shadow: 0 1px 2px rgba(0,0,0,0.04);
          }
          .row { display: flex; align-items: center; gap: 12px; }
          .between { justify-content: space-between; }
          .title { font-size: 18px; font-weight: 600; margin: 0; }
          .muted { font-size: 13px; color: #6b7280; }
          .btn {
            font-size: 13px;
            padding: 6px 14px;
            background: #ffffff;
            border: 1px solid #d1d5db;
            border-radius: 6px;
            cursor: pointer;
            color: #1f2933;
            transition: all .15s;
            font-family: inherit;
          }
          .btn:hover { background: #f9fafb; border-color: #9ca3af; }
          .btn:active { transform: scale(0.98); }
          .btn-primary {
            background: #16a34a; color: white; border-color: #16a34a;
          }
          .btn-primary:hover { background: #15803d; border-color: #15803d; }
          .btn-link {
            background: transparent; border: none; color: #16a34a;
            padding: 4px 8px; font-size: 13px;
          }
          .btn-link:hover { text-decoration: underline; background: transparent; }
          .artifact {
            display: flex; align-items: center; gap: 12px;
            padding: 12px 14px; border: 1px solid #e5e7eb;
            border-radius: 8px; margin-top: 8px; cursor: pointer;
            transition: all .15s;
          }
          .artifact:hover { border-color: #9ca3af; background: #f9fafb; }
          .artifact.consumed { opacity: 0.6; }
          .artifact-icon {
            width: 38px; height: 38px; border-radius: 8px;
            display: flex; align-items: center; justify-content: center; flex-shrink: 0;
          }
          .artifact-body { flex: 1; min-width: 0; }
          .artifact-title { font-size: 14px; font-weight: 500; margin: 0; }
          .artifact-meta { font-size: 12px; color: #6b7280; margin-top: 2px; }
          .progress {
            margin-top: 1.25rem; padding-top: 1rem;
            border-top: 1px solid #e5e7eb;
            display: flex; align-items: center; gap: 12px;
          }
          .bar {
            flex: 1; height: 6px; background: #f3f4f6;
            border-radius: 99px; overflow: hidden;
          }
          .bar-fill { height: 100%; background: #16a34a; transition: width .3s; }
          .modal-bg {
            position: fixed; inset: 0;
            background: rgba(0,0,0,0.45);
            display: flex; align-items: center; justify-content: center;
            z-index: 9999;
          }
          .modal {
            background: white; border-radius: 12px;
            padding: 1.5rem 1.75rem; max-width: 540px; width: 90%;
            max-height: 90vh; overflow-y: auto;
          }
          .field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
          .field label { font-size: 13px; color: #4b5563; font-weight: 500; }
          .field input, .field select, .field textarea {
            font-family: inherit; font-size: 14px;
            padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px;
          }
          .field input:focus, .field select:focus, .field textarea:focus {
            outline: none; border-color: #16a34a;
            box-shadow: 0 0 0 3px rgba(22, 163, 74, 0.15);
          }
          .days { display: flex; gap: 4px; }
          .days label {
            flex: 1; text-align: center; padding: 6px 0;
            border: 1px solid #d1d5db; border-radius: 6px; cursor: pointer;
            font-size: 12px; user-select: none;
          }
          .days input { display: none; }
          .days input:checked + span {
            display: block; background: #16a34a; color: white;
            margin: -6px 0; padding: 6px 0; border-radius: 5px;
          }
          .modules-list {
            max-height: 180px; overflow-y: auto;
            border: 1px solid #e5e7eb; border-radius: 6px; padding: 6px;
          }
          .modules-list label {
            display: flex; align-items: center; gap: 8px;
            padding: 6px 8px; font-size: 13px; cursor: pointer;
            border-radius: 4px;
          }
          .modules-list label:hover { background: #f3f4f6; }
          .viewer {
            margin-top: 12px; background: #f9fafb;
            border-radius: 8px; padding: 1.25rem 1.5rem;
          }
          .viewer h3 { font-size: 16px; margin: 0 0 8px; }
          .viewer p { font-size: 14px; line-height: 1.7; margin: 0 0 12px; }
          .viewer blockquote {
            font-size: 12px; color: #6b7280;
            border-left: 3px solid #d1d5db; padding-left: 12px; margin: 12px 0 0;
          }
          .viewer .actions { margin-top: 16px; display: flex; gap: 8px; flex-wrap: wrap; }
          .empty {
            text-align: center; padding: 2rem 1rem;
          }
          .empty h2 { font-size: 18px; margin: 0 0 8px; }
          .empty p { color: #6b7280; font-size: 14px; margin: 0 0 16px; }
          .spinner {
            display: inline-block; width: 16px; height: 16px;
            border: 2px solid #d1d5db; border-top-color: #16a34a;
            border-radius: 50%; animation: spin 0.7s linear infinite;
            vertical-align: -3px; margin-right: 6px;
          }
          @keyframes spin { to { transform: rotate(360deg); } }
          .flash-card {
            background: white; border: 1px solid #d1d5db;
            border-radius: 10px; padding: 1.5rem;
            min-height: 100px; text-align: center; cursor: pointer;
            margin: 12px 0;
          }
          .flash-card .hint { font-size: 11px; color: #9ca3af; margin-top: 10px; }
          .quiz-q { font-size: 14px; line-height: 1.6; margin: 8px 0 12px; }
          .quiz-opt {
            display: block; padding: 10px 12px; margin: 6px 0;
            border: 1px solid #d1d5db; border-radius: 6px; cursor: pointer;
            font-size: 13px;
          }
          .quiz-opt:hover { background: #f9fafb; }
          .quiz-opt.correct { background: #d1fae5; border-color: #16a34a; }
          .quiz-opt.wrong { background: #fee2e2; border-color: #dc2626; }
          .quiz-explain {
            font-size: 12px; color: #6b7280; margin-top: 10px;
            padding: 8px 10px; background: #f3f4f6; border-radius: 6px;
          }
        </style>
        <div class="card" id="root">
          <div class="empty"><div class="spinner"></div> Carico il tuo piano...</div>
        </div>
      `;
    }

    async refresh() {
      try {
        this._state.loading = true;
        const today = await api('/study-plan/today');
        this._state.plan = today.plan;
        this._state.artifacts = today.artifacts || [];
        this._state.progress = today.progress;
        this._state.loading = false;

        if (today.plan && today.plan.status === 'generating') {
          this._startPolling();
        } else if (this._pollTimer) {
          clearTimeout(this._pollTimer);
          this._pollTimer = null;
        }

        this._render();
      } catch (err) {
        console.error('[study-companion] refresh:', err);
        this.shadowRoot.getElementById('root').innerHTML = `
          <div class="empty">
            <p>Non sono riuscito a caricare il tuo piano di studio.</p>
            <button class="btn" onclick="this.getRootNode().host.refresh()">Riprova</button>
          </div>
        `;
      }
    }

    _startPolling() {
      if (this._pollTimer) return;
      this._pollStart = Date.now();
      const tick = () => {
        if (Date.now() - this._pollStart > POLL_TIMEOUT_MS) {
          this._pollTimer = null;
          return;
        }
        this._pollTimer = setTimeout(() => {
          this.refresh().catch(() => {});
        }, POLL_INTERVAL_MS);
      };
      tick();
    }

    _render() {
      const root = this.shadowRoot.getElementById('root');
      const { plan, artifacts, progress } = this._state;

      if (!plan) {
        root.innerHTML = `
          <div class="empty">
            <h2>Crea il tuo piano di studio</h2>
            <p>Definisci il tuo obiettivo e l'AI Study Companion genera ogni giorno i materiali su misura per te.</p>
            <button class="btn btn-primary" id="cta">Definisci obiettivo</button>
          </div>
        `;
        root.querySelector('#cta').onclick = () => this._openSetupModal();
        return;
      }

      if (plan.status === 'generating') {
        root.innerHTML = `
          <div class="empty">
            <div class="spinner"></div>
            <p>Sto preparando i tuoi materiali di studio personalizzati...</p>
            <p class="muted">Di solito ci vogliono pochi secondi.</p>
          </div>
        `;
        return;
      }

      const daysLeft = plan.days_to_target;
      const totalMin = artifacts.reduce((s, a) => s + (a.estimated_minutes || 0), 0);
      const goalLine = plan.goal
        ? escapeHtml(plan.goal)
        : `Obiettivo entro ${daysLeft} giorni`;

      const progressPct = progress
        ? Math.round((progress.progress_ratio || 0) * 100)
        : 0;

      root.innerHTML = `
        <div class="row between" style="margin-bottom: 1rem;">
          <div>
            <p class="title">Oggi &mdash; ${totalMin} minuti di studio</p>
            <p class="muted">${goalLine} &middot; ${daysLeft} giorni alla deadline</p>
          </div>
          <button class="btn" id="edit">Modifica obiettivo</button>
        </div>
        <div id="artifacts"></div>
        <div class="progress">
          <span class="muted" style="min-width:90px;">Progresso piano</span>
          <div class="bar"><div class="bar-fill" style="width:${progressPct}%"></div></div>
          <span style="font-size:12px; font-weight:500;">${progressPct}%</span>
          <button class="btn btn-link" id="regenerate">Rigenera</button>
        </div>
        <div id="viewer-slot"></div>
      `;

      const list = root.querySelector('#artifacts');
      if (artifacts.length === 0) {
        list.innerHTML = '<p class="muted" style="padding: 12px 0;">Per oggi nessun materiale schedulato. Goditi una pausa!</p>';
      } else {
        for (const a of artifacts) {
          const iconCfg = ARTIFACT_ICONS[a.type] || ARTIFACT_ICONS.summary;
          const consumed = a.consumed_at ? 'consumed' : '';
          const item = document.createElement('div');
          item.className = `artifact ${consumed}`;
          item.innerHTML = `
            <div class="artifact-icon" style="background:${iconCfg.bg}">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${iconCfg.fg}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="${iconCfg.icon}"/>
              </svg>
            </div>
            <div class="artifact-body">
              <p class="artifact-title">${escapeHtml(a.title)}</p>
              <p class="artifact-meta">
                ${ARTIFACT_LABELS[a.type] || a.type} &middot;
                ${a.estimated_minutes} min &middot;
                ${a.difficulty || 'medium'}
                ${a.consumed_at ? '&middot; <span style="color:#16a34a">Completato</span>' : ''}
              </p>
            </div>
            <button class="btn" data-id="${a.id}">${a.consumed_at ? 'Rivedi' : 'Inizia'}</button>
          `;
          item.querySelector('button').onclick = (e) => {
            e.stopPropagation();
            this._openArtifact(a.id);
          };
          list.appendChild(item);
        }
      }

      root.querySelector('#edit').onclick = () => this._openSetupModal();
      root.querySelector('#regenerate').onclick = () => this._regenerate();
    }

    async _regenerate() {
      try {
        await api('/study-plan/regenerate', { method: 'POST' });
        await this.refresh();
      } catch (err) {
        alert('Errore durante la rigenerazione: ' + err.message);
      }
    }

    async _openArtifact(id) {
      const slot = this.shadowRoot.getElementById('viewer-slot');
      slot.innerHTML = '<div class="viewer"><div class="spinner"></div> Carico...</div>';
      try {
        const { artifact } = await api(`/study-artifacts/${id}`);
        api(`/study-artifacts/${id}/start`, { method: 'POST' }).catch(() => {});
        slot.innerHTML = this._renderArtifact(artifact);
        slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        this._wireArtifact(slot, artifact);
      } catch (err) {
        slot.innerHTML = `<div class="viewer"><p>Errore: ${escapeHtml(err.message)}</p></div>`;
      }
    }

    _renderArtifact(a) {
      const content = a.content || {};
      const citations = (a.source_citations || [])
        .map(c => `${escapeHtml(c.source)}${c.page ? ' &mdash; p. ' + escapeHtml(c.page) : ''}`)
        .join('; ');

      let body = '';
      if (content.format === 'markdown') {
        body = renderMarkdown(content.body);
      } else if (content.format === 'quiz') {
        body = `<div id="quiz-host" data-questions='${escapeHtml(JSON.stringify(content.questions || []))}'></div>`;
      } else if (content.format === 'flashcards') {
        body = `<div id="flash-host" data-cards='${escapeHtml(JSON.stringify(content.cards || []))}'></div>`;
      } else {
        body = `<p class="muted">Tipo di artefatto non supportato.</p>`;
      }

      return `
        <div class="viewer">
          <h3>${escapeHtml(a.title)}</h3>
          ${body}
          ${citations ? `<blockquote>Fonti: ${citations}</blockquote>` : ''}
          <div class="actions">
            <button class="btn btn-primary" data-action="complete">Segna come completato</button>
            <button class="btn" data-action="ask-tutor">Approfondisci con Prof. Carbonio</button>
            <button class="btn" data-action="close">Chiudi</button>
          </div>
        </div>
      `;
    }

    _wireArtifact(slot, artifact) {
      const quizHost = slot.querySelector('#quiz-host');
      if (quizHost) {
        const questions = JSON.parse(quizHost.dataset.questions);
        this._renderQuiz(quizHost, questions);
      }
      const flashHost = slot.querySelector('#flash-host');
      if (flashHost) {
        const cards = JSON.parse(flashHost.dataset.cards);
        this._renderFlashcards(flashHost, cards);
      }

      slot.querySelector('[data-action=close]').onclick = () => { slot.innerHTML = ''; };
      slot.querySelector('[data-action=complete]').onclick = async () => {
        try {
          await api(`/study-artifacts/${artifact.id}/complete`, {
            method: 'POST',
            body: JSON.stringify({ time_spent_seconds: 0 })
          });
          slot.innerHTML = '';
          await this.refresh();
        } catch (err) {
          alert('Errore: ' + err.message);
        }
      };
      slot.querySelector('[data-action=ask-tutor]').onclick = () => {
        const chat = document.querySelector('prof-carbonio-chat');
        if (chat && typeof chat.openWithPrompt === 'function') {
          chat.openWithPrompt(`Approfondisci: ${artifact.title}`);
        } else {
          window.location.href = '/learn/index.html#prof-carbonio';
        }
      };
    }

    _renderQuiz(host, questions) {
      let idx = 0;
      const render = () => {
        if (idx >= questions.length) {
          host.innerHTML = `<p style="font-size:14px;">Hai completato il quiz. Bravo!</p>`;
          return;
        }
        const q = questions[idx];
        host.innerHTML = `
          <p class="muted">Domanda ${idx + 1} di ${questions.length}</p>
          <p class="quiz-q">${escapeHtml(q.q)}</p>
          <div>${q.options.map((o, i) => `<label class="quiz-opt"><input type="radio" name="opt" value="${i}" style="margin-right:8px;">${escapeHtml(o)}</label>`).join('')}</div>
          <div id="explain" style="display:none;"></div>
          <button class="btn btn-primary" id="next" style="margin-top:12px;">Conferma</button>
        `;
        const next = host.querySelector('#next');
        next.onclick = () => {
          const sel = host.querySelector('input[name=opt]:checked');
          if (!sel) return;
          const chosen = Number(sel.value);
          const opts = host.querySelectorAll('.quiz-opt');
          opts.forEach((o, i) => {
            if (i === q.correct) o.classList.add('correct');
            if (i === chosen && i !== q.correct) o.classList.add('wrong');
          });
          host.querySelector('#explain').style.display = 'block';
          host.querySelector('#explain').innerHTML = `<div class="quiz-explain">${escapeHtml(q.explain || '')}</div>`;
          next.textContent = idx + 1 === questions.length ? 'Termina' : 'Prossima';
          next.onclick = () => { idx++; render(); };
        };
      };
      render();
    }

    _renderFlashcards(host, cards) {
      let idx = 0;
      let flipped = false;
      const render = () => {
        const c = cards[idx];
        host.innerHTML = `
          <p class="muted">Carta ${idx + 1} di ${cards.length}</p>
          <div class="flash-card" id="card">
            <p style="font-size:16px; font-weight:500;">${escapeHtml(flipped ? c.back : c.front)}</p>
            <p class="hint">${flipped ? '(click per tornare al fronte)' : '(click per vedere la definizione)'}</p>
          </div>
          <div style="display:flex; gap:8px; justify-content:space-between;">
            <button class="btn" id="prev" ${idx === 0 ? 'disabled' : ''}>Indietro</button>
            <div style="display:flex; gap:8px;">
              <button class="btn" id="review">Da rivedere</button>
              <button class="btn btn-primary" id="next">${idx === cards.length - 1 ? 'Termina' : 'Sapevo'}</button>
            </div>
          </div>
        `;
        host.querySelector('#card').onclick = () => { flipped = !flipped; render(); };
        host.querySelector('#prev').onclick = () => { if (idx > 0) { idx--; flipped = false; render(); } };
        host.querySelector('#next').onclick = () => {
          if (idx < cards.length - 1) { idx++; flipped = false; render(); }
          else { host.innerHTML = '<p>Hai finito il mazzo. Ottimo lavoro!</p>'; }
        };
        host.querySelector('#review').onclick = host.querySelector('#next').onclick;
      };
      render();
    }

    async _openSetupModal() {
      // Deduplicazione: rimuovi eventuali modal aperti precedentemente.
      document.querySelectorAll('.study-companion-modal-bg').forEach(el => el.remove());

      let modules = [];
      try {
        const res = await api('/lms-modules');
        modules = res.modules || [];
      } catch (e) { /* non blocchiamo il form */ }

      const existing = this._state.plan || {};
      const focusIds = new Set(existing.focus_module_ids || []);
      const todayIso = new Date().toISOString().slice(0, 10);
      const defaultDate = existing.target_date
        ? String(existing.target_date).slice(0, 10)
        : new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);

      // ATTENZIONE: questo modal vive nel light DOM (document.body) perché
      // position:fixed dentro Shadow DOM collassa rispetto al viewport.
      // Quindi TUTTI gli stili devono essere inline — gli stili dello
      // Shadow DOM del widget non arrivano qui.
      const S = {
        bg: 'position:fixed; inset:0; background:rgba(15,23,42,0.55); backdrop-filter:blur(2px); display:flex; align-items:center; justify-content:center; z-index:99999; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; padding:20px; box-sizing:border-box; overflow-y:auto;',
        card: 'background:#fff; border-radius:14px; padding:1.75rem; width:100%; max-width:520px; max-height:92vh; overflow-y:auto; box-shadow:0 20px 60px rgba(0,0,0,0.30); color:#1f2933;',
        h2: 'font-size:20px; font-weight:600; margin:0 0 6px; color:#1f2933;',
        sub: 'font-size:13px; color:#6b7280; margin:0 0 22px;',
        field: 'display:flex; flex-direction:column; gap:6px; margin-bottom:18px;',
        label: 'font-size:13px; font-weight:500; color:#374151;',
        input: 'font-family:inherit; font-size:14px; padding:9px 12px; border:1px solid #d1d5db; border-radius:7px; background:#fff; color:#1f2933; outline:none; box-sizing:border-box;',
        select: 'font-family:inherit; font-size:14px; padding:9px 12px; border:1px solid #d1d5db; border-radius:7px; background:#fff; color:#1f2933; outline:none; box-sizing:border-box; cursor:pointer;',
        textarea: 'font-family:inherit; font-size:14px; padding:9px 12px; border:1px solid #d1d5db; border-radius:7px; background:#fff; color:#1f2933; outline:none; box-sizing:border-box; resize:vertical; min-height:60px;',
        range: 'width:100%; cursor:pointer; accent-color:#16a34a;',
        rangeVal: 'font-weight:600; color:#16a34a;',
        days: 'display:flex; gap:6px;',
        dayLbl: 'flex:1; text-align:center; padding:9px 0; border:1px solid #d1d5db; border-radius:7px; cursor:pointer; font-size:13px; font-weight:500; user-select:none; background:#fff; transition:all .15s;',
        dayLblOn: 'flex:1; text-align:center; padding:9px 0; border:1px solid #16a34a; border-radius:7px; cursor:pointer; font-size:13px; font-weight:500; user-select:none; background:#16a34a; color:#fff;',
        mods: 'max-height:170px; overflow-y:auto; border:1px solid #e5e7eb; border-radius:7px; padding:4px; background:#fff;',
        modLbl: 'display:flex; align-items:center; gap:8px; padding:7px 10px; font-size:13px; cursor:pointer; border-radius:5px;',
        emptyMods: 'padding:14px 12px; font-size:13px; color:#9ca3af; text-align:center; font-style:italic;',
        actions: 'display:flex; gap:10px; justify-content:flex-end; margin-top:22px; padding-top:16px; border-top:1px solid #f3f4f6;',
        btn: 'font-family:inherit; font-size:14px; font-weight:500; padding:9px 18px; background:#fff; border:1px solid #d1d5db; border-radius:7px; cursor:pointer; color:#374151; transition:all .15s;',
        btnPri: 'font-family:inherit; font-size:14px; font-weight:500; padding:9px 22px; background:#16a34a; border:1px solid #16a34a; border-radius:7px; cursor:pointer; color:#fff; transition:all .15s;'
      };

      const dayLabels = ['Lun','Mar','Mer','Gio','Ven','Sab','Dom'];
      const initDays = (!existing.weekly_days || existing.weekly_days.length === 0)
        ? [1,2,3,4,5,6,7]
        : existing.weekly_days;
      const daysSet = new Set(initDays);

      const modal = document.createElement('div');
      modal.className = 'study-companion-modal-bg';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('style', S.bg);

      modal.innerHTML = `
        <div style="${S.card}">
          <h2 style="${S.h2}">Definisci il tuo obiettivo di studio</h2>
          <p style="${S.sub}">L'AI Study Companion userà queste informazioni per costruire il tuo piano personalizzato.</p>

          <div style="${S.field}">
            <label style="${S.label}">Obiettivo</label>
            <textarea name="goal" rows="2" placeholder="Es. superare l'esame finale del Master con voto alto" style="${S.textarea}">${escapeHtml(existing.goal || '')}</textarea>
          </div>

          <div style="${S.field}">
            <label style="${S.label}">Data obiettivo</label>
            <input type="date" name="target_date" min="${todayIso}" value="${defaultDate}" style="${S.input}">
          </div>

          <div style="${S.field}">
            <label style="${S.label}">Minuti di studio al giorno: <span id="mins-out" style="${S.rangeVal}">${existing.daily_minutes || 45}</span></label>
            <input type="range" name="daily_minutes" min="15" max="180" step="15" value="${existing.daily_minutes || 45}" style="${S.range}">
          </div>

          <div style="${S.field}">
            <label style="${S.label}">Giorni della settimana disponibili</label>
            <div style="${S.days}" id="days-row">
              ${dayLabels.map((lbl, i) => {
                const dayN = i + 1;
                const on = daysSet.has(dayN);
                return `
                  <label data-day="${dayN}" style="${on ? S.dayLblOn : S.dayLbl}">
                    <input type="checkbox" name="day" value="${dayN}" ${on ? 'checked' : ''} style="display:none;">
                    ${lbl}
                  </label>
                `;
              }).join('')}
            </div>
          </div>

          <div style="${S.field}">
            <label style="${S.label}">Livello di partenza</label>
            <select name="level" style="${S.select}">
              <option value="beginner" ${existing.level === 'beginner' ? 'selected' : ''}>Principiante</option>
              <option value="intermediate" ${(existing.level || 'intermediate') === 'intermediate' ? 'selected' : ''}>Intermedio</option>
              <option value="advanced" ${existing.level === 'advanced' ? 'selected' : ''}>Avanzato</option>
            </select>
          </div>

          <div style="${S.field}">
            <label style="${S.label}">Moduli focus (opzionale)</label>
            <div style="${S.mods}">
              ${modules.length === 0
                ? `<p style="${S.emptyMods}">Nessun modulo specifico disponibile &mdash; il piano coprir&agrave; tutti i temi del Master.</p>`
                : modules.map(m => `
                  <label style="${S.modLbl}">
                    <input type="checkbox" name="module" value="${m.id}" ${focusIds.has(m.id) ? 'checked' : ''}>
                    ${escapeHtml(m.title)}
                  </label>
                `).join('')}
            </div>
          </div>

          <div style="${S.actions}">
            <button type="button" id="cancel" style="${S.btn}">Annulla</button>
            <button type="button" id="save" style="${S.btnPri}">${existing.id ? 'Aggiorna piano' : 'Genera piano'}</button>
          </div>
        </div>
      `;

      document.body.appendChild(modal);

      const $ = (sel) => modal.querySelector(sel);
      const $$ = (sel) => Array.from(modal.querySelectorAll(sel));

      // Slider live readout
      $('input[name=daily_minutes]').oninput = (e) => {
        $('#mins-out').textContent = e.target.value;
      };

      // Day toggles: click sulla label commuta il checkbox e ricolora la pill.
      $$('#days-row label[data-day]').forEach(lbl => {
        lbl.onclick = (e) => {
          // evita doppio toggle (label che propaga al checkbox interno)
          e.preventDefault();
          const cb = lbl.querySelector('input[type=checkbox]');
          cb.checked = !cb.checked;
          lbl.setAttribute('style', cb.checked ? S.dayLblOn : S.dayLbl);
        };
      });

      // Focus styles per input (poiché non possiamo usare :focus inline)
      $$('input[type=text], input[type=date], input[type=range], select, textarea').forEach(el => {
        const baseStyle = el.getAttribute('style') || '';
        el.addEventListener('focus', () => {
          el.setAttribute('style', baseStyle + 'border-color:#16a34a; box-shadow:0 0 0 3px rgba(22,163,74,0.15);');
        });
        el.addEventListener('blur', () => {
          el.setAttribute('style', baseStyle);
        });
      });

      // Close handlers
      const close = () => {
        document.removeEventListener('keydown', onKey);
        modal.remove();
      };
      const onKey = (e) => { if (e.key === 'Escape') close(); };
      document.addEventListener('keydown', onKey);

      $('#cancel').onclick = close;
      modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

      $('#save').onclick = async () => {
        const goal = $('textarea[name=goal]').value.trim() || null;
        const target_date = $('input[name=target_date]').value;
        const daily_minutes = Number($('input[name=daily_minutes]').value);
        const level = $('select[name=level]').value;
        const days = Array.from(modal.querySelectorAll('input[name=day]:checked')).map(e => Number(e.value));
        const mods = Array.from(modal.querySelectorAll('input[name=module]:checked')).map(e => e.value);

        if (!target_date) { alert('Imposta una data obiettivo.'); return; }
        if (days.length === 0) { alert('Seleziona almeno un giorno della settimana.'); return; }

        $('#save').disabled = true;
        $('#save').textContent = 'Sto generando il piano...';
        $('#save').style.opacity = '0.7';
        try {
          await api('/study-plan', {
            method: 'POST',
            body: JSON.stringify({
              goal,
              target_date,
              daily_minutes,
              weekly_days: days,
              focus_module_ids: mods,
              level
            })
          });
          close();
          await this.refresh();
        } catch (err) {
          $('#save').disabled = false;
          $('#save').textContent = 'Genera piano';
          $('#save').style.opacity = '1';
          alert('Errore: ' + err.message);
        }
      };
    }
  }

  customElements.define('study-companion-widget', StudyCompanionWidget);
})();
