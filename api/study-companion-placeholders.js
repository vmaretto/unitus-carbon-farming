// api/study-companion-placeholders.js
// Pool di artefatti placeholder per lo Sprint 1 dello Study Companion.
//
// In Sprint 2 questi template saranno generati dinamicamente dall'agente
// Claude. Per ora servono a popolare il widget con contenuti realistici
// derivati dai materiali del Master (Modulo 1-4) così possiamo testare il
// flow end-to-end (form -> persistenza -> widget -> artifact viewer) senza
// spendere chiamate API.
//
// I source_module_ids sono volutamente vuoti: la funzione generatePlanArtifacts()
// applica un filtro best-effort se lo studente ha scelto moduli focus, e
// fallback all'intero pool altrimenti.

module.exports = [
  {
    type: 'summary',
    title: 'Il ciclo del carbonio in 4 punti chiave',
    description: 'Riassunto introduttivo sui flussi di carbonio tra atmosfera, biosfera, idrosfera e geosfera.',
    estimated_minutes: 12,
    difficulty: 'easy',
    source_module_ids: [],
    source_citations: [
      { source: 'Dispensa M1L1', page: '2-6' },
      { source: 'IPCC AR6 WG1 Cap. 5', page: 'Box 5.1' }
    ],
    content: {
      format: 'markdown',
      body: `## Il ciclo del carbonio in 4 punti chiave

**1. I quattro serbatoi.** Il carbonio circola tra quattro grandi serbatoi: l'atmosfera (~870 GtC), la biosfera terrestre (~2300 GtC inclusi suoli), gli oceani (~38000 GtC) e la litosfera (combustibili fossili e sedimenti, decine di milioni di GtC). I flussi naturali tra atmosfera e biosfera/oceani sono dell'ordine delle 100-200 GtC/anno per direzione.

**2. La perturbazione antropica.** L'attività umana aggiunge ~10 GtC/anno alla colonna atmosferica (combustibili fossili + deforestazione). È un flusso piccolo in termini relativi ma cumulativo: dal 1750 abbiamo aumentato la CO2 atmosferica da 280 a oltre 420 ppm.

**3. I sink terrestri.** Suoli e foreste riassorbono ~3-4 GtC/anno della CO2 antropica, ma la loro capacità è limitata dalla disponibilità di nutrienti, acqua, temperatura. È qui che si gioca la partita del carbon farming.

**4. Tempi di residenza.** La CO2 in atmosfera ha un tempo di residenza effettivo di centinaia di anni. Questo è il motivo per cui le emissioni accumulate "pesano" molto più dell'emissione del singolo anno.

> **Fonti**: Dispensa Modulo 1 Lezione 1 (Fondamenti del ciclo del carbonio), IPCC AR6 WG1.`
    }
  },

  {
    type: 'quiz_personalized',
    title: 'Quiz lampo: Flussi di CO2 e gas serra',
    description: '5 domande sui flussi di carbonio e sui principali gas climalteranti.',
    estimated_minutes: 8,
    difficulty: 'easy',
    source_module_ids: [],
    source_citations: [{ source: 'Dispensa M1L2', page: '4-9' }],
    content: {
      format: 'quiz',
      questions: [
        {
          q: 'Quale gas serra ha il maggior potere riscaldante a 100 anni (GWP100)?',
          options: ['CO2', 'CH4', 'N2O', 'SF6'],
          correct: 3,
          explain: 'Il SF6 ha GWP100 ≈ 22800. CH4 ≈ 28, N2O ≈ 265.'
        },
        {
          q: 'Qual è la concentrazione di CO2 atmosferica preindustriale di riferimento?',
          options: ['180 ppm', '280 ppm', '380 ppm', '420 ppm'],
          correct: 1,
          explain: 'L\'IPCC fissa il riferimento preindustriale a 280 ppm (anno 1750 circa).'
        },
        {
          q: 'Quale flusso naturale è dominante nello scambio CO2 atmosfera-biosfera?',
          options: ['Eruzioni vulcaniche', 'Respirazione + fotosintesi', 'Decomposizione marina', 'Erosione delle rocce'],
          correct: 1,
          explain: 'Respirazione e fotosintesi scambiano ~120 GtC/anno per direzione.'
        }
      ]
    }
  },

  {
    type: 'summary',
    title: 'Il Regolamento UE 2024/3012 (CRCF): cosa fa e perché',
    description: 'I quattro criteri QU.A.L.ITY e la struttura del primo framework europeo per la certificazione dei crediti di carbonio.',
    estimated_minutes: 15,
    difficulty: 'medium',
    source_module_ids: [],
    source_citations: [
      { source: 'Dispensa Massai M2L3', page: '4-8' },
      { source: 'Reg. UE 2024/3012', page: 'art. 4-6' }
    ],
    content: {
      format: 'markdown',
      body: `## Il Regolamento UE 2024/3012 in 4 punti chiave

**1. Cosa fa il CRCF.** Istituisce il primo quadro europeo per la certificazione degli assorbimenti di carbonio e delle riduzioni di emissioni da attività agricole. Non crea un mercato — crea le regole per dire cosa conta come credito legittimo.

**2. I quattro criteri QU.A.L.ITY.** *Quantification*, *Additionality*, *Long-term storage*, *sustainabilITY*. Ogni attività certificata deve dimostrarli tutti e quattro. Il più controverso per il carbon farming è la *long-term storage* (minimo 5 anni di monitoraggio).

**3. Tre categorie di attività.** *Permanent storage* (es. mineralizzazione), *Carbon farming* (suoli, biomassa), *Carbon storage in products* (legno strutturale, bio-char). Il Master si concentra sulla seconda.

**4. Timeline.** Adottato dicembre 2024, applicazione progressiva 2025-2028. La Commissione adotterà metodologie settoriali specifiche tramite atti delegati.

> **Fonti**: Dispensa Massai (Modulo 2 Lezione 3, p. 4-8); Regolamento UE 2024/3012 artt. 1-6.`
    }
  },

  {
    type: 'flashcards',
    title: 'Termini chiave del CRCF (12 carte)',
    description: 'Definizioni operative del Regolamento UE 2024/3012.',
    estimated_minutes: 18,
    difficulty: 'medium',
    source_module_ids: [],
    source_citations: [{ source: 'Reg. UE 2024/3012 art. 2', page: 'definizioni' }],
    content: {
      format: 'flashcards',
      cards: [
        { front: 'Additionality', back: 'Principio per cui un\'attività di sequestro è certificabile solo se non sarebbe avvenuta in assenza dell\'incentivo del credito. Esclude il business-as-usual.' },
        { front: 'Baseline', back: 'Scenario controfattuale che descrive cosa sarebbe successo senza l\'intervento di carbon farming. Differenza tra baseline e realtà = net carbon removal benefit.' },
        { front: 'Reversal', back: 'Rilascio non intenzionale di carbonio precedentemente sequestrato (incendio, cambio d\'uso del suolo). Gestito tramite buffer pool o assicurazione.' },
        { front: 'Carbon farming', back: 'Una delle tre categorie di attività CRCF. Comprende pratiche agricole che aumentano il sequestro di carbonio nel suolo o nella biomassa.' },
        { front: 'QU.A.L.ITY', back: 'I quattro criteri del CRCF: Quantification, Additionality, Long-term storage, sustainabilITY.' },
        { front: 'Buffer pool', back: 'Riserva di crediti accantonati per coprire eventuali reversal. Gestita centralmente per gruppi di progetti.' }
      ]
    }
  },

  {
    type: 'micro_lesson',
    title: 'UNFCCC, Protocollo di Kyoto e Accordo di Parigi: la genealogia delle policy climatiche',
    description: 'Come siamo arrivati al sistema attuale di governance climatica internazionale.',
    estimated_minutes: 14,
    difficulty: 'medium',
    source_module_ids: [],
    source_citations: [{ source: 'Dispensa M2L1', page: '1-12' }],
    content: {
      format: 'markdown',
      body: `## Da Rio a Parigi: 30 anni di policy climatica

**1992 — UNFCCC.** Al Summit della Terra di Rio nasce la Convenzione Quadro delle Nazioni Unite sui Cambiamenti Climatici. È un trattato "ombrello" — fissa l'obiettivo (stabilizzare le concentrazioni di GHG) ma non impone target vincolanti. Introduce il principio della *responsabilità comune ma differenziata* (CBDR).

**1997 — Protocollo di Kyoto.** Primo strumento operativo: target vincolanti di riduzione per i paesi industrializzati (Annex I), nessun obbligo per i paesi in via di sviluppo. Crea i tre meccanismi flessibili: ET (emission trading), CDM (Clean Development Mechanism), JI (Joint Implementation).

**Anni 2000 — Difficoltà.** Gli USA non ratificano. La Cina e l'India crescono come emettitori ma sono fuori dagli obblighi. Il modello "Annex I vs non-Annex I" diventa insostenibile.

**2015 — Accordo di Parigi.** Rovescia la logica: tutti i paesi presentano *contributi determinati a livello nazionale* (NDC), aggiornati ogni 5 anni con il principio di *progressione*. Articolo 6 introduce i meccanismi di cooperazione (ITMO, mercato regolato, framework di mitigazione non basato sul mercato).

**Oggi.** Siamo nella fase di operativizzazione dell'Articolo 6 (regole tecniche adottate a COP26 e seguenti) e nella corsa al *net zero* entro metà secolo. L'UE è il "campo di battaglia regolatorio" più avanzato — CRCF, ETS, CBAM.

> **Fonti**: Dispensa Modulo 2 Lezione 1 (Politiche climatiche globali UNFCCC).`
    }
  },

  {
    type: 'summary',
    title: 'Monitoraggio MRV: come si misura un credito di carbonio',
    description: 'I tre pilastri del Monitoring, Reporting, Verification per il carbon farming.',
    estimated_minutes: 14,
    difficulty: 'hard',
    source_module_ids: [],
    source_citations: [{ source: 'Dispensa M3L2', page: '5-11' }],
    content: {
      format: 'markdown',
      body: `## MRV: Monitoring, Reporting, Verification

**Monitoring.** È la raccolta sistematica di dati nel tempo. Per il carbon farming combina: misurazioni dirette del SOC (Soil Organic Carbon) tramite campionamento, modelli biogeochimici (RothC, Century, DNDC), remote sensing (NDVI, SAR), e dati di gestione aziendale (avvicendamenti, fertilizzazione, lavorazioni).

**Reporting.** È la comunicazione strutturata dei risultati. Il CRCF prevede report annuali con format standardizzato. Devono dimostrare la consistenza temporale (la baseline non può essere ri-aggiustata opportunisticamente) e la trasparenza metodologica.

**Verification.** È la validazione indipendente da parte di un ente terzo accreditato. Si fa tipicamente ogni 3-5 anni con audit sul campo e desk review della documentazione. È l'anello che dà credibilità a tutta la filiera.

**Costo MRV.** È un punto critico: il costo del MRV può facilmente erodere il 20-40% del valore del credito per piccoli progetti. Le metodologie *grouped* (gruppi di agricoltori con un unico audit) sono il principale strumento per abbattere i costi.

> **Fonti**: Dispensa Modulo 3 Lezione 2 (Metodi monitoraggio e quantificazione GHG).`
    }
  },

  {
    type: 'quiz_personalized',
    title: 'Quiz: Mercato ETS e Articolo 6',
    description: '6 domande sul mercato europeo dell\'emission trading e sui meccanismi di Parigi.',
    estimated_minutes: 12,
    difficulty: 'hard',
    source_module_ids: [],
    source_citations: [{ source: 'Dispensa M2L5', page: '8-15' }],
    content: {
      format: 'quiz',
      questions: [
        {
          q: 'Quale settore è coperto dall\'EU ETS classico (Phase IV)?',
          options: ['Solo grandi industrie energivore', 'Energia + industria + aviazione intra-UE', 'Tutti i settori inclusa agricoltura', 'Solo trasporti e edilizia'],
          correct: 1,
          explain: 'L\'EU ETS Phase IV copre energia, industria energy-intensive e aviazione intra-UE. Trasporti ed edilizia entrano con ETS2 dal 2027.'
        },
        {
          q: 'Cosa sono gli ITMO nell\'Articolo 6 dell\'Accordo di Parigi?',
          options: ['Tasse sulle emissioni', 'Unità di trasferimento internazionale dei risultati di mitigazione', 'Sanzioni per i paesi inadempienti', 'Fondi di adattamento'],
          correct: 1,
          explain: 'ITMO = Internationally Transferred Mitigation Outcomes, le unità che permettono il trasferimento contabile dei risultati di mitigazione tra paesi (art. 6.2).'
        },
        {
          q: 'Cos\'è il "corresponding adjustment" nell\'Articolo 6?',
          options: ['Un meccanismo di compensazione finanziaria', 'L\'aggiustamento contabile per evitare il doppio conteggio', 'Una tassa sulle emissioni', 'Un fondo di adattamento'],
          correct: 1,
          explain: 'Il corresponding adjustment è la doppia registrazione contabile (somma sul paese acquirente, sottrazione sul paese venditore) necessaria a evitare il double counting.'
        }
      ]
    }
  },

  {
    type: 'micro_lesson',
    title: 'Mercato volontario vs mercato regolato: due mondi a confronto',
    description: 'Differenze strutturali, attori, prezzi, qualità tra VCM e mercati compliance.',
    estimated_minutes: 13,
    difficulty: 'medium',
    source_module_ids: [],
    source_citations: [{ source: 'Dispensa M4L1', page: '3-10' }],
    content: {
      format: 'markdown',
      body: `## Mercato volontario vs mercato regolato

**Mercato regolato (compliance).** I partecipanti sono obbligati per legge a rendere conto delle emissioni (es. installazioni EU ETS). I crediti sono quote standardizzate, l\'autorità è pubblica, i prezzi sono determinati da supply e demand vincolati dalla policy. Volume 2024: ~10 miliardi di tonnellate CO2eq.

**Mercato volontario (VCM).** Le aziende acquistano crediti per impegni *voluntary* (net zero corporate, claim ESG). Gli standard sono privati (Verra/VCS, Gold Standard, Plan Vivo, ecc.), la qualità è eterogenea, i prezzi vanno da pochi euro a oltre 100 euro per tonnellata. Volume 2024: ~200 milioni di tonnellate CO2eq.

**Il CRCF cambia il quadro UE.** Pur essendo formalmente un sistema *voluntary* (non sostituisce l\'ETS), il CRCF introduce per la prima volta uno standard pubblico europeo. L\'aspettativa è che diventi il riferimento qualitativo del VCM europeo nei prossimi 5-10 anni.

**Il ruolo del carbon farming.** Quasi inesistente nel mercato regolato (l\'agricoltura non è nell\'EU ETS). Nel VCM, il carbon farming pesa ~10-15% del volume, in forte crescita. Il CRCF è il principale strumento di policy per portarlo a scala.

> **Fonti**: Dispensa Modulo 4 Lezione 1 (Mercato volontario e registro nazionale).`
    }
  }
];
