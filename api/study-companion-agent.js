// api/study-companion-agent.js
// Agente AI Study Companion: loop Claude con tool use che genera i materiali
// di studio personalizzati per uno studente, pescando dalla KB del Master.
//
// SPRINT 2: questo modulo sostituisce i template placeholder con generazione
// dinamica via Claude. Resta il fallback ai placeholder se ANTHROPIC_API_KEY
// non è configurata o il loop fallisce.
//
// Pipeline:
//   1. routes/POST /study-plan chiama runAgent(plan, ctx)
//   2. runAgent imposta system prompt + user context (obiettivo, progresso)
//   3. Loop Claude tool_use: l'agente chiama search_kb / get_course_outline /
//      get_student_progress per esplorare la situazione
//   4. L'agente genera contenuti (riassunti markdown, quiz JSON, flashcard JSON)
//      DIRETTAMENTE nel suo ragionamento e li persiste via save_artifact()
//   5. Dopo N tool calls, l'agente termina con un summary di cosa ha creato
//
// Architettura "agente unico": NON usiamo sub-tool tipo `generate_quiz` con
// sub-call Claude. L'agente fa tutto in un singolo flusso conversazionale.
// Più semplice, più economico, meno latency.

const { searchKBChunks } = require('./prof-carbonio-search');

const DEFAULT_MODEL = process.env.STUDY_COMPANION_MODEL || 'claude-sonnet-4-6';
const MAX_TURNS = 20;
const MAX_TOKENS_PER_TURN = 4096;
// Time budget interno: usciamo gracefully prima del timeout hard di Vercel
// (maxDuration nel vercel.json). Lasciamo un margine di sicurezza di 30 sec.
const TIME_BUDGET_MS = 240 * 1000;

// ===========================================================================
// SYSTEM PROMPT
// ===========================================================================

const SYSTEM_PROMPT = `Sei l'AI Study Companion del Master in Carbon Farming dell'Università della Tuscia. Il tuo compito è generare materiali di studio personalizzati per uno studente, sulla base del suo obiettivo specifico, del suo livello di partenza, dei giorni e minuti che ha a disposizione, e del progresso che ha già accumulato.

LE TUE LINEE GUIDA:

1. **Pesca dalla KB del Master.** Hai a disposizione il tool search_kb per cercare nei materiali reali del Master (Regolamento UE 2024/3012, dispense dei docenti, slide, blog post, ~750 chunk indicizzati). Cita sempre le fonti specifiche nei tuoi artefatti.

2. **Distribuisci sui giorni disponibili.** Il piano dello studente specifica weekly_days (giorni della settimana disponibili) e target_date. Schedula gli artefatti su date concrete, partendo da OGGI (CURRENT_DATE).

3. **Rispetta il budget di tempo giornaliero.** Lo studente ha dichiarato daily_minutes. Per ogni giorno schedula 2-4 artefatti che SOMMANO circa a quel budget.

4. **Bilancia i tipi.** Alterna: riassunti (densi di contenuto), quiz (consolidamento), flashcard (memorizzazione termini), micro-lezioni (approfondimenti narrativi). Non riempire un giorno solo di un tipo.

5. **Adatta al livello dichiarato.**
   - beginner: parti dai fondamenti, linguaggio accessibile, esempi concreti.
   - intermediate: assumi le basi note, vai sul tecnico, sfumature.
   - advanced: vai sul critico, contraddizioni, frontiera di ricerca.

6. **Considera il progresso già accumulato.** Usa get_student_progress per sapere cosa lo studente ha già visto. Non ripetergli materiali su lezioni che ha completato al 100%; piuttosto fanne ripassi mirati o approfondimenti.

7. **Citazioni obbligatorie.** Ogni artefatto deve includere source_citations: lista di oggetti {source, page} che indicano da quale dispensa/slide/articolo viene il contenuto. Pesca dai chunk restituiti da search_kb.

OUTPUT ATTESO:

Per ogni artefatto chiami il tool save_artifact con:
- type: 'summary' | 'quiz_personalized' | 'flashcards' | 'micro_lesson'
- title: titolo breve e chiaro
- description: 1 frase di descrizione
- scheduled_for: data ISO (YYYY-MM-DD)
- estimated_minutes: tempo realistico di fruizione
- difficulty: 'easy' | 'medium' | 'hard'
- source_module_ids: array di UUID (se hai i riferimenti)
- source_citations: array di {source, page}
- content: payload tipo-specifico (vedi sotto)

Formati di content:
- summary: { format: 'markdown', body: '## Titolo\\n\\n**Punto 1.** ...\\n\\n> Fonti: ...' }
- quiz_personalized: { format: 'quiz', questions: [{q, options[], correct, explain}] }
- flashcards: { format: 'flashcards', cards: [{front, back}] }
- micro_lesson: { format: 'markdown', body: '## ...' }

LIMITI OPERATIVI:

- Genera tra 6 e 20 artefatti totali (a seconda della durata del piano).
- Non generare più di 4 artefatti per lo stesso giorno.
- Non spendere più di 16-20 turni totali nell'esplorazione.
- Quando hai finito, scrivi un breve messaggio di chiusura ("Ho generato N artefatti distribuiti su M giorni...") e termina.`;

// ===========================================================================
// TOOL DEFINITIONS
// ===========================================================================

const TOOLS = [
  {
    name: 'search_kb',
    description: 'Cerca semanticamente nella knowledge base del Master. Ritorna chunk di testo rilevanti con sorgente (dispensa, slide, regolamento, blog) e numero pagina/slide. Usa query specifiche per recuperare materiale concreto da inserire nei riassunti/quiz/flashcard.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Query in italiano. Es: "criterio QU.A.L.ITY del CRCF", "additionality carbon farming", "mercato volontario crediti".' },
        top_k: { type: 'integer', description: 'Numero di chunk da ritornare (default 6).', default: 6 },
        source_types: {
          type: 'array',
          items: { type: 'string', enum: ['resource', 'lms_lesson', 'blog_post', 'normative', 'faq', 'manual'] },
          description: 'Filtra per tipo di sorgente (opzionale).'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'get_course_outline',
    description: "Ritorna la struttura del Master: lista dei moduli con cfu, ore, descrizione, e per ogni modulo le lezioni LMS associate con titolo e durata. Usalo all'inizio per orientarti sui temi del corso.",
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_student_progress',
    description: "Ritorna il progresso reale dello studente: lezioni LMS che ha completato (progress_percent), quiz che ha tentato (con voti). Usalo per evitare di rigenerare materiali su lezioni già padroneggiate e per intuire le sue aree deboli.",
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'save_artifact',
    description: "Persiste un artefatto di studio nel piano. Da chiamare una volta per ogni materiale che generi. Il content deve essere un oggetto JSON ben formato secondo il formato del tipo (vedi system prompt). Le source_citations sono obbligatorie e vanno popolate dai chunk restituiti da search_kb.",
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['summary', 'quiz_personalized', 'flashcards', 'micro_lesson'] },
        title: { type: 'string' },
        description: { type: 'string' },
        scheduled_for: { type: 'string', description: 'Data ISO YYYY-MM-DD.' },
        estimated_minutes: { type: 'integer', minimum: 3, maximum: 60 },
        difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
        source_module_ids: { type: 'array', items: { type: 'string' } },
        source_citations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              source: { type: 'string' },
              page: { type: 'string' }
            },
            required: ['source']
          }
        },
        content: {
          type: 'object',
          description: 'Payload del contenuto. Formato dipende dal type.'
        }
      },
      required: ['type', 'title', 'scheduled_for', 'estimated_minutes', 'content']
    }
  }
];

// ===========================================================================
// TOOL IMPLEMENTATIONS
// ===========================================================================

async function toolSearchKb(args, ctx) {
  const { query, top_k = 6, source_types = null } = args;
  const chunks = await searchKBChunks(ctx.pool, ctx.openai, query, {
    matchCount: top_k,
    language: 'it',
    sourceTypes: source_types,
    minSimilarity: 0.15
  });
  // Limita la dimensione del payload: prendi solo i campi utili e tronca content.
  return chunks.map(c => ({
    source_title: c.source_title,
    source_type: c.source_type,
    page: c.page_number || c.slide_number || null,
    heading: c.heading || null,
    content: String(c.content || '').slice(0, 1200),
    similarity: Number(c.similarity || 0).toFixed(3)
  }));
}

async function toolGetCourseOutline(_args, ctx) {
  const { rows: modules } = await ctx.pool.query(
    `SELECT id, name AS title, description_short, cfu, sort_order,
            COALESCE(hours_lectures, 0) + COALESCE(hours_lab, 0) + COALESCE(hours_study, 0) AS total_hours
       FROM modules
      WHERE is_published = TRUE
      ORDER BY sort_order ASC, name ASC`
  );
  // Allego le lms_lessons sotto ogni modulo, se la FK ci porta
  const { rows: lessons } = await ctx.pool.query(
    `SELECT id, lms_module_id, title, duration_seconds, sort_order
       FROM lms_lessons
      WHERE is_published = TRUE
      ORDER BY sort_order ASC`
  ).catch(() => ({ rows: [] }));
  const byModule = {};
  for (const l of lessons) {
    if (!l.lms_module_id) continue;
    (byModule[l.lms_module_id] ||= []).push({
      id: l.id,
      title: l.title,
      duration_minutes: l.duration_seconds ? Math.round(l.duration_seconds / 60) : null
    });
  }
  return modules.map(m => ({
    id: m.id,
    title: m.title,
    description: m.description_short || null,
    cfu: m.cfu || null,
    total_hours: Number(m.total_hours || 0),
    lessons: byModule[m.id] || []
  }));
}

async function toolGetStudentProgress(_args, ctx) {
  const userId = ctx.userId;
  const { rows: progress } = await ctx.pool.query(
    `SELECT l.id AS lesson_id, l.title, lp.progress_percent, lp.completed_at,
            l.lms_module_id
       FROM lesson_progress lp
       JOIN lms_lessons l ON l.id = lp.lms_lesson_id
      WHERE lp.user_id = $1
      ORDER BY lp.updated_at DESC
      LIMIT 80`,
    [userId]
  ).catch(() => ({ rows: [] }));

  const { rows: quizAttempts } = await ctx.pool.query(
    `SELECT q.id AS quiz_id, q.title, qa.score, qa.passed, qa.completed_at,
            q.lms_module_id
       FROM quiz_attempts qa
       JOIN quizzes q ON q.id = qa.quiz_id
      WHERE qa.user_id = $1 AND qa.completed_at IS NOT NULL
      ORDER BY qa.completed_at DESC
      LIMIT 40`,
    [userId]
  ).catch(() => ({ rows: [] }));

  const completedLessons = progress.filter(p => p.progress_percent >= 90).length;
  const totalLessons = progress.length;
  const avgQuizScore = quizAttempts.length
    ? Math.round(quizAttempts.reduce((s, q) => s + (q.score || 0), 0) / quizAttempts.length)
    : null;

  return {
    summary: {
      lessons_started: totalLessons,
      lessons_completed: completedLessons,
      quizzes_attempted: quizAttempts.length,
      quizzes_passed: quizAttempts.filter(q => q.passed).length,
      avg_quiz_score: avgQuizScore
    },
    recent_lessons: progress.slice(0, 12),
    recent_quizzes: quizAttempts.slice(0, 8)
  };
}

async function toolSaveArtifact(args, ctx) {
  const {
    type, title, description = null, scheduled_for,
    estimated_minutes = 15, difficulty = 'medium',
    source_module_ids = [], source_citations = [], content = {}
  } = args;

  if (!['summary', 'quiz_personalized', 'flashcards', 'micro_lesson'].includes(type)) {
    throw new Error(`type non valido: ${type}`);
  }
  if (!title || !scheduled_for) {
    throw new Error('title e scheduled_for sono obbligatori');
  }

  // UUID validation soft per source_module_ids: scarta valori non-UUID
  const cleanModuleIds = (source_module_ids || []).filter(s =>
    typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s)
  );

  const { rows } = await ctx.pool.query(
    `INSERT INTO study_artifacts
       (study_plan_id, type, title, description, scheduled_for,
        estimated_minutes, difficulty, source_module_ids, source_citations,
        content, status, generated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ready', NOW())
     RETURNING id, type, title, scheduled_for, estimated_minutes`,
    [
      ctx.planId, type, title, description, scheduled_for,
      estimated_minutes, difficulty, cleanModuleIds,
      JSON.stringify(source_citations),
      JSON.stringify(content)
    ]
  );

  ctx.artifactsSaved++;

  // SALVATAGGIO INCREMENTALE DELLO STATO: dopo il primo artefatto, marca il
  // piano come 'active'. Così se anche andassimo in timeout di Vercel più
  // avanti, lo studente vede subito gli artefatti già generati.
  if (ctx.artifactsSaved === 1) {
    await ctx.pool.query(
      `UPDATE study_plans
          SET status = 'active',
              generation_completed_at = NOW()
        WHERE id = $1`,
      [ctx.planId]
    ).catch(e => console.warn('[agent] incremental status update warn:', e.message));
  }

  return {
    ok: true,
    artifact: rows[0],
    artifacts_saved_so_far: ctx.artifactsSaved
  };
}

async function executeToolCall(name, args, ctx) {
  try {
    switch (name) {
      case 'search_kb': return await toolSearchKb(args, ctx);
      case 'get_course_outline': return await toolGetCourseOutline(args, ctx);
      case 'get_student_progress': return await toolGetStudentProgress(args, ctx);
      case 'save_artifact': return await toolSaveArtifact(args, ctx);
      default: return { error: `Tool sconosciuto: ${name}` };
    }
  } catch (err) {
    console.error(`[agent] tool ${name} error:`, err.message);
    return { error: err.message };
  }
}

// ===========================================================================
// AGENT LOOP
// ===========================================================================

/**
 * Esegue l'agente Claude per generare gli artefatti di un piano.
 *
 * @param {object} plan - row da study_plans
 * @param {object} deps - { pool, anthropic, openai }
 * @returns {Promise<{ok, count, turns, error?}>}
 */
async function runAgent(plan, deps) {
  const { pool, anthropic, openai } = deps;
  if (!anthropic) throw new Error('Anthropic non configurato');
  if (!openai) throw new Error('OpenAI non configurato (serve per embeddings)');

  // Soft-replace artefatti futuri non consumati prima di rigenerare.
  await pool.query(
    `UPDATE study_artifacts
        SET status = 'stale'
      WHERE study_plan_id = $1
        AND status IN ('queued', 'ready')
        AND consumed_at IS NULL
        AND scheduled_for >= CURRENT_DATE`,
    [plan.id]
  );

  const ctx = {
    pool, openai,
    userId: plan.user_id,
    planId: plan.id,
    artifactsSaved: 0
  };

  // User prompt iniziale: tutto il contesto del piano
  const today = new Date().toISOString().slice(0, 10);
  const userContext = `Ecco il piano dello studente da realizzare:

OBIETTIVO: ${plan.goal || '(non specificato)'}
DATA OBIETTIVO: ${plan.target_date} (oggi è ${today})
MINUTI DI STUDIO AL GIORNO: ${plan.daily_minutes}
GIORNI DISPONIBILI: ${(plan.weekly_days || []).join(', ')} (1=Lun, 7=Dom)
LIVELLO DICHIARATO: ${plan.level}
${plan.focus_module_ids && plan.focus_module_ids.length
  ? `MODULI FOCUS (UUID): ${plan.focus_module_ids.join(', ')}`
  : 'NESSUN FOCUS SPECIFICO — coprire tutti i moduli'}

Procedi: usa i tool per esplorare la KB e il progresso dello studente, poi genera e salva 6-20 artefatti di studio distribuiti sui giorni disponibili. Cita sempre le fonti.`;

  const messages = [{ role: 'user', content: userContext }];

  let turn = 0;
  let finalText = null;
  const startedAt = Date.now();

  while (turn < MAX_TURNS) {
    // Time budget interno: se siamo vicini al timeout di Vercel, esci con
    // quello che hai generato finora. Gli artefatti già salvati restano.
    const elapsed = Date.now() - startedAt;
    if (elapsed > TIME_BUDGET_MS) {
      console.warn(`[agent] time budget exhausted after ${turn} turns (${elapsed}ms), saved ${ctx.artifactsSaved} artifacts`);
      finalText = `Generazione interrotta per limite di tempo. ${ctx.artifactsSaved} artefatti generati con successo.`;
      break;
    }

    turn++;
    const response = await anthropic.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: MAX_TOKENS_PER_TURN,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages
    });

    // Aggiungi il turno dell'assistente alla storia
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      // Estrai eventuale testo finale
      const textBlocks = response.content.filter(b => b.type === 'text');
      finalText = textBlocks.map(b => b.text).join('\n').trim();
      break;
    }

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];
      for (const block of toolUseBlocks) {
        const result = await executeToolCall(block.name, block.input, ctx);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result).slice(0, 50000) // safety: cap
        });
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    if (response.stop_reason === 'max_tokens') {
      console.warn('[agent] hit max_tokens, breaking');
      break;
    }

    // stop_reason imprevisto: esci
    console.warn('[agent] unexpected stop_reason:', response.stop_reason);
    break;
  }

  return {
    ok: ctx.artifactsSaved > 0,
    count: ctx.artifactsSaved,
    turns: turn,
    final_text: finalText
  };
}

module.exports = {
  runAgent,
  SYSTEM_PROMPT,
  TOOLS,
  DEFAULT_MODEL
};
