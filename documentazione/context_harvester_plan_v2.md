# Context Harvester — Piano di Implementazione v2

Questo documento estende il Piano v1 con le seguenti aree:
- Miglioramenti alla qualità del retrieval (Symbol Search, Usages, Iterative Retrieval, Test associati)
- Nuove feature di contesto (Query Understanding, Struttura logica, Negative Context, Project Context persistente)
- Confidence Score opzionale
- Fingerprint del contesto
- Export formats aggiuntivi
- Sistema di profili di configurazione AI
- Aggiornamento README con profili hardware consigliati

Tutti i modelli sono **completamente configurabili** — ogni fase ha il proprio setting separato per URL Ollama e nome modello, permettendo di puntare fasi diverse a istanze diverse (laptop vs server remoto).

---

## Nuovi settings — configurazione modelli

Ogni modello ha due parametri: URL dell'istanza Ollama e nome del modello. Questo permette di usare istanze diverse per fasi diverse (es. laptop per embedding/HyDE, MINISFORUM per generazione).

```jsonc
// Ollama — configurazione per fase
"contextHarvester.ollama.embedding.url"        : "http://localhost:11434",
"contextHarvester.ollama.embedding.model"      : "nomic-embed-text",

"contextHarvester.ollama.hyde.url"             : "http://localhost:11434",
"contextHarvester.ollama.hyde.model"           : "qwen3:8b",

"contextHarvester.ollama.rerank.url"           : "http://localhost:11434",
"contextHarvester.ollama.rerank.model"         : "bge-reranker-base",

"contextHarvester.ollama.classifier.url"       : "http://localhost:11434",
"contextHarvester.ollama.classifier.model"     : "qwen3:8b",

"contextHarvester.ollama.structurer.url"       : "http://localhost:11434",
"contextHarvester.ollama.structurer.model"     : "qwen3:8b",

"contextHarvester.ollama.confidence.url"       : "http://localhost:11434",
"contextHarvester.ollama.confidence.model"     : "qwen3:14b",
```

### Sistema di profili

I profili sono preset named che sovrascrivono tutti i setting dei modelli in un'unica operazione. Salvati in `contextHarvester.profiles` come array JSON e selezionabili dal pannello con un dropdown.

```jsonc
"contextHarvester.activeProfile": "laptop-balanced",

"contextHarvester.profiles": [
  {
    "name": "laptop-balanced",
    "label": "Laptop — Balanced",
    "models": {
      "embedding":  { "url": "http://localhost:11434", "model": "nomic-embed-text" },
      "hyde":       { "url": "http://localhost:11434", "model": "qwen3:8b" },
      "rerank":     { "url": "http://localhost:11434", "model": "bge-reranker-base" },
      "classifier": { "url": "http://localhost:11434", "model": "qwen3:8b" },
      "structurer": { "url": "http://localhost:11434", "model": "qwen3:8b" },
      "confidence": { "url": "http://localhost:11434", "model": "qwen3:14b" }
    }
  }
]
```

Il pannello UI mostra:
```
┌─────────────────────────────────────┐
│ PROFILO AI                          │
│ [Laptop — Balanced        ▼]        │
│ [+ Nuovo] [✏️ Modifica] [🗑 Elimina] │
└─────────────────────────────────────┘
```

Cambiare profilo aggiorna immediatamente tutti i setting dei modelli. I profili sono salvati nel `globalState` dell'estensione e persistono tra sessioni.

---

## Nuova Fase: Query Understanding (prima di HyDE)

**Posizione nel flusso:** dopo la ricezione dell'input, prima della Fase 2 (HyDE).

**Scopo:** classificare il tipo di feature richiesta per orientare tutte le fasi successive in modo più preciso.

**Input:** testo della feature request

**Prompt al modello:**
```
Analizza questo requisito e restituisci SOLO un oggetto JSON con questa struttura:
{
  "type": "new_entity|modify_existing|integration|fix|other",
  "areas": ["backend", "frontend", "sql"],
  "key_symbols": ["NomeClasse1", "NomeTabella1"],
  "search_hints": ["termine specifico da cercare nel codice"]
}

Requisito: {featureInput}
Simboli noti nel progetto: {vocabulary.classes + vocabulary.tables + vocabulary.components}

Rispondi SOLO con JSON valido, nessuna spiegazione.
```

**Output:** oggetto JSON `QueryAnalysis` con:
- `type`: orienta la strategia di retrieval
  - `new_entity` → cerca pattern simili (altri validator, altri componenti)
  - `modify_existing` → cerca il file specifico da modificare
  - `integration` → cerca adapter, handler, controller
  - `fix` → cerca dove il problema potrebbe originarsi
- `areas`: abilita/disabilita focus backend/frontend/sql automaticamente (sovrascrivibile dall'utente)
- `key_symbols`: nomi di classi/tabelle menzionati esplicitamente → usati direttamente in Symbol Search
- `search_hints`: termini aggiuntivi da usare nel grep

**AI:** ✅ modello configurabile (`contextHarvester.ollama.classifier`)
**Note:** se il modello non risponde con JSON valido, fallback silenzioso — il sistema continua senza query understanding come nel v1.

---

## Nuova Fase: Symbol Search + Usages Index

**Posizione nel flusso:** parallelamente al retrieval vettoriale (Fase 3), dopo Query Understanding.

### Symbol Index (costruito in Fase 1, aggiornato incrementalmente)

Durante l'indexing, costruire un indice separato `symbol_index.json`:

```json
{
  "symbols": {
    "ContractValidator": {
      "type": "class",
      "file": "src/Validators/ContractValidator.cs",
      "line": 12,
      "namespace": "EnergyDeal.Validators"
    },
    "BTextInput": {
      "type": "component",
      "file": "src/Components/BTextInput.tsx",
      "line": 1
    },
    "Contract.Lead": {
      "type": "table",
      "file": "src/Database/schema.sql",
      "line": 45
    }
  },
  "usages": {
    "ContractValidator": [
      "src/Services/ContractService.cs",
      "src/Controllers/ContractController.cs"
    ],
    "BTextInput": [
      "src/Components/ContractForm.tsx",
      "src/Pages/LeadPage.tsx"
    ]
  }
}
```

**Costruzione usages:**
- Per `.cs`: cerca `new NomeClasse(`, `NomeClasse.`, `: NomeClasse`, `<NomeClasse>`
- Per `.tsx`/`.ts`: cerca `import.*NomeClasse`, `<NomeClasse`, `NomeClasse()`
- Regex semplice, nessuna AI

### Utilizzo in fase di retrieval

Se `QueryAnalysis.key_symbols` è valorizzato (es. `["ContractValidator"]`):
1. Lookup diretto in `symbol_index.json` → file di definizione trovato immediatamente
2. Lookup in `usages` → tutti i file che usano il simbolo
3. Questi file vengono aggiunti al pool con score = 0.95 (altissimo, trovato per nome esatto)

Questo è il retrieval chirurgico che fa la differenza quando la feature menziona nomi specifici.

---

## Nuova Fase: Test File Associati

**Posizione nel flusso:** dopo il retrieval finale, prima dell'assemblaggio.

**Logica:**
Per ogni file nei chunk finali, cerca il file di test associato con queste convenzioni:
- `ContractValidator.cs` → cerca `ContractValidatorTests.cs`, `ContractValidatorTest.cs`, `TestContractValidator.cs` in tutto il repo
- `ContractForm.tsx` → cerca `ContractForm.test.tsx`, `ContractForm.spec.tsx`

Se trovato:
- Aggiunge il file di test al contesto in una sezione dedicata "Test associati"
- Non viene re-rankato — incluso per intero se < 150 righe, altrimenti solo i nomi dei metodi di test (che da soli sono già contesto utile)

**AI:** ❌ nessuna — solo ricerca file per naming convention
**File di test:** inclusi come sezione separata nel `context.md`, non mescolati ai chunk principali

---

## Nuova Fase: Iterative Retrieval

**Posizione nel flusso:** dopo il primo retrieval (Fase 3), prima del re-ranking.

**Scopo:** trovare chunk rilevanti che la prima pass vettoriale non ha trovato, analizzando i risultati intermedi.

**Logica (max 2 iterazioni aggiuntive):**

```
Iterazione 1 (già esistente):
  query iniziale → top 20 chunk

Iterazione 2 (nuova):
  Analizza i 20 chunk trovati:
  - estrai nuovi simboli presenti (nomi di classi/metodi referenziati nei chunk)
  - confronta con symbol_index → trova simboli non ancora nel pool
  - per ogni nuovo simbolo: lookup diretto + ricerca vettoriale mirata
  - aggiungi al pool (deduplicati)

Iterazione 3 (nuova, solo se iterazione 2 ha trovato qualcosa di nuovo):
  Stessa logica sull'output dell'iterazione 2
  Stop se nessun chunk nuovo trovato
```

L'estrazione dei nuovi simboli dai chunk è **statistica/regex** — nessuna AI. Cerca pattern `NomeClasse.`, `new NomeClasse(`, `import.*from` nei testi dei chunk.

**Stop condition:** nessun chunk nuovo trovato, oppure raggiunto il limite di 2 iterazioni aggiuntive.

**AI:** ❌ nessuna per le iterazioni — solo analisi statica dei chunk trovati

---

## Nuova Fase: Struttura Logica del Contesto

**Posizione nel flusso:** dopo re-ranking e prima dell'assemblaggio finale.

**Scopo:** riordinare i chunk da "ordinati per score" a "ordinati per flusso logico di lettura", che è molto più utile sia per l'utente che per l'AI che riceve il contesto.

**Livelli logici:**
1. `entry_point` — controller, endpoint, componente root, route
2. `service` — service, validator, handler, use case
3. `data` — modello, DTO, entità, tabella, repository
4. `utility` — helper, extension, utility class
5. `test` — test associati (sempre in fondo)
6. `dependency` — file dipendenti (sempre in fondo)

**Classificazione di ogni chunk:**

Prompt al modello:
```
Classifica questo chunk di codice in UNA di queste categorie:
entry_point, service, data, utility

Chunk:
{chunk_text}

Rispondi SOLO con la categoria, nessun altro testo.
```

Task semplicissimo per un modello piccolo — una parola come output.

**Fallback:** se il modello non risponde con una categoria valida, ordina per score come nel v1.

**AI:** ✅ modello configurabile (`contextHarvester.ollama.structurer`) — task molto leggero, 1 chiamata per chunk

---

## Nuova Fase: Negative Context

**Posizione nel flusso:** dopo struttura logica, prima dell'assemblaggio.

**Scopo:** identificare chunk con score medio (0.45-0.70) che potrebbero essere confusi con file rilevanti ma che probabilmente NON devono essere modificati.

**Logica (nessuna AI):**

Un chunk finisce in "negative context" se soddisfa almeno uno di questi criteri:
- Score tra 0.45 e 0.70 (rilevante ma non abbastanza per il contesto principale)
- Il file contiene nel nome o nel path: `Base`, `Abstract`, `Legacy`, `Deprecated`, `Old`, `Backup`, `Default` (base classes, file legacy)
- Il file è una base class da cui ereditano le classi nei chunk principali (rilevabile da `symbol_index` — se `ContractValidator` estende `DefaultValidator`, `DefaultValidator` è negative context)

Questi chunk NON vengono inclusi nel contesto principale. Vengono elencati nella sezione "⚠️ File esclusi" del `context.md` con solo path e motivazione:

```markdown
## ⚠️ File probabilmente non rilevanti (non modificare)

- `src/Validators/Base/DefaultContractValidator.cs` — base class, alta similarità ma probabile dipendenza da non toccare
- `src/Services/LegacyContractService.cs` — file legacy
```

**AI:** ❌ nessuna

---

## Nuova Feature: Project Context Persistente

**File:** `{repoPath}/.context-harvester/project_context.md`

Creato dall'utente una volta, mantenuto manualmente. L'estensione lo inietta sempre in fondo al `context.md` generato, in una sezione dedicata.

**Template suggerito (l'estensione lo crea vuoto con questa struttura al primo avvio):**

```markdown
# Project Context — EnergyDeal

## Architettura generale
<!-- Descrivi brevemente i layer principali del progetto -->

## Pattern dominanti
<!-- Es: FluentValidation per validazione, Dapper per data access, Grommet per UI -->

## Naming conventions
<!-- Es: DefaultXxxValidator / CustomerXxxValidator, FF_NED_* per feature flags -->

## Anti-pattern — NON fare
<!-- Es: non usare Entity Framework per query di lista, non modificare GZipHelper direttamente -->

## Note per l'AI
<!-- Qualsiasi cosa sia utile sapere prima di generare codice per questo progetto -->
```

**UI:** nel pannello aggiungere link "📄 Modifica Project Context" che apre il file in VS Code.

**AI:** ❌ nessuna a runtime — è un file statico

---

## Nuova Feature: Confidence Score (opzionale)

**Abilitabile da settings:** `contextHarvester.enableConfidenceScore: false` (default off)

**Posizione nel flusso:** ultima fase prima del salvataggio del file.

**Input:** feature request + tutti i chunk nel contesto finale (già strutturati)

**Prompt:**
```
Sei un code reviewer esperto. Valuta se il contesto di codice fornito è sufficiente
per implementare il requisito dato.

Requisito: {featureInput}

Contesto recuperato:
{chunks_summary}  ← solo path e prime 3 righe di ogni chunk, non il testo completo

Rispondi con JSON:
{
  "score": 7,
  "complete": true,
  "missing": ["descrizione di cosa potrebbe mancare"],
  "notes": "breve nota opzionale"
}

Scala: 1-4 insufficiente, 5-6 parziale, 7-8 buono, 9-10 completo.
Rispondi SOLO con JSON valido.
```

**Output nel context.md:**
```markdown
## 📊 Confidence Score: 7/10
**Valutazione:** Buono — il contesto dovrebbe essere sufficiente
**Note:** Potrebbe mancare la configurazione del middleware di autenticazione
```

Se score < 5:
```
⚠️ Confidence Score: 3/10 — Contesto probabilmente incompleto
Considera di aggiungere manualmente file relativi a: [missing]
```

**AI:** ✅ modello configurabile (`contextHarvester.ollama.confidence`) — raccomandato `qwen3:14b`
**Tempo stimato:** 20-35 secondi sul laptop con `qwen3:14b`
**Nota:** il prompt usa solo i path + prime 3 righe di ogni chunk, non il testo completo — mantiene il contesto input basso e la velocità ragionevole

---

## Nuova Feature: Fingerprint del Contesto

**Logica (nessuna AI):**

Dopo l'assemblaggio, calcola SHA256 dei path + hash dei file inclusi nel contesto. Salva in `context_log.json`:

```json
{
  "NED-123": {
    "lastGenerated": "2026-05-14T10:23:00Z",
    "fingerprint": "sha256:abc123...",
    "files": ["src/Validators/ContractValidator.cs", "..."],
    "chunksCount": 18,
    "confidenceScore": 7
  }
}
```

Se l'utente genera di nuovo per la stessa CARD e il fingerprint è identico, il pannello mostra:
```
ℹ️ Contesto identico all'ultima generazione (nessun file modificato)
[Rigenera comunque]  [Usa esistente]
```

Se il fingerprint è diverso (file modificati):
```
🔄 Codebase modificato dall'ultima generazione
[Rigenera]
```

---

## Nuova Feature: Export Formats

Dopo la generazione del `context.md`, offrire export aggiuntivi:

**JSON strutturato** (`{CARD}_context.json`) — per integrazione con `plan.py`:
```json
{
  "card": "NED-123",
  "feature": "...",
  "generated": "2026-05-14T10:23:00Z",
  "confidence": 7,
  "chunks": [
    {
      "file": "src/Validators/ContractValidator.cs",
      "startLine": 45,
      "endLine": 89,
      "score": 0.91,
      "level": "service",
      "source": "vector",
      "text": "..."
    }
  ],
  "dependencies": [...],
  "tests": [...],
  "negativeContext": [...],
  "projectContext": "..."
}
```

**Plain text** (`{CARD}_context.txt`) — per incollare in chat
**Clipboard** — bottone "📋 Copia" nel pannello che copia il markdown in clipboard

**UI nel pannello (sezione risultato):**
```
✅ NED-123_context.md — 18 chunk • 4 dipendenze • score: 7/10
[📄 Apri in VS Code]  [📋 Copia]  [⬇ JSON]  [⬇ TXT]
```

---

## Flusso completo aggiornato (v2)

```
Feature input (testo o file/i)
          │
          ▼
[QUERY UNDERSTANDING]          ← qwen3:8b
  type, areas, key_symbols,
  search_hints
          │
          ├──────────────────────────────────────┐
          │                                      │
          ▼                                      ▼
[HYDE — multi-query x3]        [SYMBOL SEARCH]
  qwen3:8b                       symbol_index.json
  + vocabulary                   (lookup diretto)
  + query understanding          + usages
          │                                      │
          ▼                                      │
[RETRIEVAL VETTORIALE]                           │
  nomic-embed-text                               │
  ChromaDB                                       │
          │                                      │
          ▼                                      │
[ITERATIVE RETRIEVAL x2]                         │
  analisi statica chunk                          │
  → nuovi simboli → nuovo retrieval              │
          │                                      │
          ▼                                      │
[GREP PARALLELO]                                 │
  keyword da vocabulary                          │
  + traduzioni IT/EN                             │
  + search_hints da QU                           │
          │                                      │
          └──────────────┬───────────────────────┘
                         │ merge + dedup
                         ▼
              [RE-RANKING]
                bge-reranker / qwen3:8b
                → top K chunk
                         │
                         ▼
              [TEST ASSOCIATI]
                ricerca file test
                (no AI)
                         │
                         ▼
              [STRUTTURA LOGICA]
                classifica chunk per livello
                qwen3:8b (1 call/chunk)
                         │
                         ▼
              [NEGATIVE CONTEXT]
                filtra base class / legacy
                (no AI)
                         │
                         ▼
              [DEPENDENCY GRAPH]
                1 livello di profondità
                (no AI)
                         │
                         ▼
              [CONFIDENCE SCORE] ← opzionale
                qwen3:14b
                         │
                         ▼
              [FINGERPRINT]
                (no AI)
                         │
                         ▼
              [ASSEMBLER]
                {CARD}_context.md
                + export opzionali
```

---

## Aggiornamento README

Il README del repository deve includere le seguenti sezioni.

### Sezione: Configurazione modelli

Spiegare che ogni fase AI è configurabile indipendentemente con:
- URL dell'istanza Ollama (permette di distribuire fasi su macchine diverse)
- Nome del modello (qualsiasi modello disponibile su quell'istanza Ollama)

### Sezione: Profili di configurazione

Spiegare il sistema di profili: preset named che configurano tutti i modelli in un'unica operazione. Selezionabili dal dropdown nel pannello. Salvabili, modificabili, eliminabili dall'interfaccia.

---

### Profili consigliati — Laptop (RTX 1000 Ada, 6GB VRAM dedicata + 17.9GB shared, 23.9GB totali)

---

#### Profilo 1: `laptop-speed` — Velocità massima

Priorità: tempo di risposta. Qualità buona ma non massima. Ideale per iterazioni rapide o codebase piccoli.

| Fase | Modello | VRAM | Note |
|---|---|---|---|
| Embedding | `nomic-embed-text` | 500MB | invariato |
| HyDE | `qwen3:4b` | ~2.5GB | generazione snippet rapida |
| Re-rank | `bge-reranker-base` | ~300MB | |
| Classifier | `qwen3:4b` | già carico | riuso |
| Structurer | `qwen3:4b` | già carico | riuso |
| Confidence | disabilitato | — | |

**Tempo stimato totale:** 15-25 secondi
**Qualità HyDE:** buona — `qwen3:4b` è la generazione più recente, HumanEval 76% nella classe sub-8B

```json
{
  "name": "laptop-speed",
  "label": "Laptop — Speed",
  "models": {
    "embedding":  { "url": "http://localhost:11434", "model": "nomic-embed-text" },
    "hyde":       { "url": "http://localhost:11434", "model": "qwen3:4b" },
    "rerank":     { "url": "http://localhost:11434", "model": "bge-reranker-base" },
    "classifier": { "url": "http://localhost:11434", "model": "qwen3:4b" },
    "structurer": { "url": "http://localhost:11434", "model": "qwen3:4b" },
    "confidence": { "url": "http://localhost:11434", "model": "" }
  },
  "settings": {
    "enableConfidenceScore": false
  }
}
```

---

#### Profilo 2: `laptop-balanced` — Equilibrio qualità/velocità *(raccomandato)*

Priorità: miglior rapporto qualità/tempo. Il profilo da usare quotidianamente.

| Fase | Modello | VRAM | Note |
|---|---|---|---|
| Embedding | `nomic-embed-text` | 500MB | |
| HyDE | `qwen3:8b` | ~5GB | nella VRAM dedicata, veloce |
| Re-rank | `bge-reranker-base` | ~300MB | |
| Classifier | `qwen3:8b` | già carico | riuso |
| Structurer | `qwen3:8b` | già carico | riuso |
| Confidence | `qwen3:8b` | già carico | riuso del modello carico |

**Tempo stimato totale:** 30-50 secondi (con confidence score)
**Qualità HyDE:** molto buona — `qwen3:8b` è il miglior modello sotto 8B parametri per coding e multilingua

```json
{
  "name": "laptop-balanced",
  "label": "Laptop — Balanced (raccomandato)",
  "models": {
    "embedding":  { "url": "http://localhost:11434", "model": "nomic-embed-text" },
    "hyde":       { "url": "http://localhost:11434", "model": "qwen3:8b" },
    "rerank":     { "url": "http://localhost:11434", "model": "bge-reranker-base" },
    "classifier": { "url": "http://localhost:11434", "model": "qwen3:8b" },
    "structurer": { "url": "http://localhost:11434", "model": "qwen3:8b" },
    "confidence": { "url": "http://localhost:11434", "model": "qwen3:8b" }
  },
  "settings": {
    "enableConfidenceScore": true
  }
}
```

---

#### Profilo 3: `laptop-quality` — Qualità massima sul laptop

Priorità: contesto più accurato possibile. Usa `qwen3:14b` per le fasi critiche. Il modello va in shared memory ma la qualità è sensibilmente superiore.

| Fase | Modello | VRAM | Note |
|---|---|---|---|
| Embedding | `nomic-embed-text` | 500MB | |
| HyDE | `qwen3:14b` | ~8.3GB shared | eccellente per snippet IT/EN |
| Re-rank | `bge-reranker-base` | ~300MB | |
| Classifier | `qwen3:14b` | già carico | riuso |
| Structurer | `qwen3:14b` | già carico | riuso |
| Confidence | `qwen3:14b` | già carico | riuso |

**Tempo stimato totale:** 60-90 secondi
**Qualità HyDE:** eccellente — conosce meglio pattern C#/.NET enterprise e multilingua IT/EN
**Nota:** `qwen3:14b` va in shared memory (oltre i 6GB dedicati) — leggermente più lento ma qualità nettamente superiore per ragionamento sul codice

```json
{
  "name": "laptop-quality",
  "label": "Laptop — Quality",
  "models": {
    "embedding":  { "url": "http://localhost:11434", "model": "nomic-embed-text" },
    "hyde":       { "url": "http://localhost:11434", "model": "qwen3:14b" },
    "rerank":     { "url": "http://localhost:11434", "model": "bge-reranker-base" },
    "classifier": { "url": "http://localhost:11434", "model": "qwen3:14b" },
    "structurer": { "url": "http://localhost:11434", "model": "qwen3:14b" },
    "confidence": { "url": "http://localhost:11434", "model": "qwen3:14b" }
  },
  "settings": {
    "enableConfidenceScore": true
  }
}
```

---

### Profili consigliati — MINISFORUM RTX 3090 (24GB VRAM)

Questi profili puntano all'istanza Ollama del MINISFORUM. Utili quando si vuole massima qualità e il MINISFORUM è disponibile, oppure per integrare il context harvester nella pipeline `plan.py`.

---

#### Profilo 4: `minisforum-balanced` — Equilibrio su 3090

Usa modelli di taglia media che girano interamente in VRAM dedicata — velocissimi.

| Fase | Modello | VRAM | Note |
|---|---|---|---|
| Embedding | `nomic-embed-text` | 500MB | |
| HyDE | `qwen3:14b` | ~8.3GB | interamente in VRAM, molto veloce |
| Re-rank | `bge-reranker-base` | ~300MB | |
| Classifier | `qwen3:14b` | già carico | |
| Structurer | `qwen3:14b` | già carico | |
| Confidence | `qwen3:14b` | già carico | |

**Tempo stimato totale:** 20-35 secondi (modello in VRAM dedicata = velocità massima)

```json
{
  "name": "minisforum-balanced",
  "label": "MINISFORUM 3090 — Balanced",
  "models": {
    "embedding":  { "url": "http://192.168.x.x:11434", "model": "nomic-embed-text" },
    "hyde":       { "url": "http://192.168.x.x:11434", "model": "qwen3:14b" },
    "rerank":     { "url": "http://192.168.x.x:11434", "model": "bge-reranker-base" },
    "classifier": { "url": "http://192.168.x.x:11434", "model": "qwen3:14b" },
    "structurer": { "url": "http://192.168.x.x:11434", "model": "qwen3:14b" },
    "confidence": { "url": "http://192.168.x.x:11434", "model": "qwen3:14b" }
  },
  "settings": {
    "enableConfidenceScore": true
  }
}
```

---

#### Profilo 5: `minisforum-quality` — Qualità massima su 3090

Usa `qwen3:30b-a3b` — modello MoE con 30B parametri totali e soli 3B attivi per token. Qualità da 30B, velocità da 3B. È il modello di riferimento per la 3090 in termini di rapporto qualità/velocità.

| Fase | Modello | VRAM | Note |
|---|---|---|---|
| Embedding | `nomic-embed-text` | 500MB | |
| HyDE | `qwen3:30b-a3b` | ~16.8GB | MoE, 3B attivi per token — veloce |
| Re-rank | `bge-reranker-base` | ~300MB | |
| Classifier | `qwen3:30b-a3b` | già carico | |
| Structurer | `qwen3:30b-a3b` | già carico | |
| Confidence | `qwen3:30b-a3b` | già carico | |

**Tempo stimato totale:** 30-50 secondi
**Qualità:** eccellente — equivalent a modelli dense da 30B+ per comprensione del codice
**Nota MoE:** tutti i pesi (16.8GB) devono stare in VRAM, ma solo 3B parametri vengono attivati per ogni token — inference veloce quanto un 3B dense

```json
{
  "name": "minisforum-quality",
  "label": "MINISFORUM 3090 — Quality (MoE)",
  "models": {
    "embedding":  { "url": "http://192.168.x.x:11434", "model": "nomic-embed-text" },
    "hyde":       { "url": "http://192.168.x.x:11434", "model": "qwen3:30b-a3b" },
    "rerank":     { "url": "http://192.168.x.x:11434", "model": "bge-reranker-base" },
    "classifier": { "url": "http://192.168.x.x:11434", "model": "qwen3:30b-a3b" },
    "structurer": { "url": "http://192.168.x.x:11434", "model": "qwen3:30b-a3b" },
    "confidence": { "url": "http://192.168.x.x:11434", "model": "qwen3:30b-a3b" }
  },
  "settings": {
    "enableConfidenceScore": true
  }
}
```

---

#### Profilo 6: `minisforum-max` — Qualità assoluta su 3090

Usa `qwen3-coder:30b-a3b` — variante fine-tuned specificamente per il codice dello stesso modello MoE. È il modello con il miglior equilibrio assoluto disponibile su 24GB VRAM per task di analisi e comprensione del codice.

| Fase | Modello | VRAM | Note |
|---|---|---|---|
| Embedding | `nomic-embed-text` | 500MB | |
| HyDE | `qwen3-coder:30b-a3b` | ~16.8GB | MoE coder fine-tune |
| Re-rank | `bge-reranker-base` | ~300MB | |
| Classifier | `qwen3-coder:30b-a3b` | già carico | |
| Structurer | `qwen3-coder:30b-a3b` | già carico | |
| Confidence | `qwen3-coder:30b-a3b` | già carico | |

**Tempo stimato totale:** 30-55 secondi
**Qualità:** massima disponibile su singola GPU da 24GB per task di codice
**Nota:** questo è anche il modello che usi già nel tuo workflow Roo Code — se è già carico in Ollama, nessun overhead di caricamento

```json
{
  "name": "minisforum-max",
  "label": "MINISFORUM 3090 — Max (Coder MoE)",
  "models": {
    "embedding":  { "url": "http://192.168.x.x:11434", "model": "nomic-embed-text" },
    "hyde":       { "url": "http://192.168.x.x:11434", "model": "qwen3-coder:30b-a3b" },
    "rerank":     { "url": "http://192.168.x.x:11434", "model": "bge-reranker-base" },
    "classifier": { "url": "http://192.168.x.x:11434", "model": "qwen3-coder:30b-a3b" },
    "structurer": { "url": "http://192.168.x.x:11434", "model": "qwen3-coder:30b-a3b" },
    "confidence": { "url": "http://192.168.x.x:11434", "model": "qwen3-coder:30b-a3b" }
  },
  "settings": {
    "enableConfidenceScore": true
  }
}
```

---

## Aggiornamento `index_meta.json`

Aggiungere il symbol index ai metadati:

```json
{
  "lastIndexed": "2026-05-14T10:23:00Z",
  "totalFiles": 1243,
  "symbolsIndexed": 892,
  "usagesIndexed": 3401,
  "fileHashes": { ... }
}
```

---

## Aggiornamento struttura cartella output

```
.context-harvester/
├── chroma_db/
│   ├── code_index/
│   └── docs_index/
├── project_vocabulary.json
├── project_context.md          ← NUOVO — editato dall'utente
├── symbol_index.json           ← NUOVO — costruito in fase 1
├── index_meta.json
├── context_log.json            ← NUOVO — storico fingerprint
└── output/
    ├── NED-123_context.md
    ├── NED-123_context.json    ← NUOVO — export JSON opzionale
    └── NED-123_context.txt     ← NUOVO — export plain text opzionale
```

---

## Aggiornamento pannello UI

```
┌─────────────────────────────────────┐
│  🌾 Context Harvester            v2 │
├─────────────────────────────────────┤
│  PROFILO AI                         │
│  [Laptop — Balanced (rec.)   ▼]     │
│  [+ Nuovo] [✏️ Modifica] [🗑 Elimina]│
├─────────────────────────────────────┤
│  INDEX                              │
│  Ultimo: 14/05/2026 10:23           │
│  File: 1.243 • Simboli: 892         │
│  Auto-index: [toggle]               │
│  [🔄 Rebuild Index]                 │
├─────────────────────────────────────┤
│  FEATURE INPUT                      │
│  ● Scrivi a mano  ○ Seleziona file  │
│  [textarea]                         │
│                                     │
│  SOURCES                            │
│  ☑ Codice  ☐ Documentazione (.md)  │
│                                     │
│  FOCUS (auto da Query Understanding)│
│  ☑ Backend  ☑ Frontend  ☑ SQL       │
├─────────────────────────────────────┤
│  OUTPUT                             │
│  CARD ID: [NED-123     ]            │
│  → NED-123_context.md               │
│  Export: ☐ JSON  ☐ TXT             │
├─────────────────────────────────────┤
│  [  🔍 Genera Contesto  ]           │
│                                     │
│  [se in corso:]                     │
│  🔄 Query Understanding...          │
│  🔄 Symbol Search...                │
│  🔄 HyDE (2/3)...                   │
│  🔄 Retrieval iterativo (iter 2)... │
│  🔄 Re-ranking...                   │
│  🔄 Struttura logica...             │
│  🔄 Confidence score...             │
├─────────────────────────────────────┤
│  ✅ NED-123_context.md              │
│  18 chunk • 4 dep • score: 7/10     │
│  [📄 Apri]  [📋 Copia]  [⬇JSON] [⬇TXT]│
│  [📄 Modifica Project Context]      │
└─────────────────────────────────────┘
```

---

## Ordine di implementazione v2

Implementare nell'ordine seguente — ogni step aggiunge valore indipendentemente:

1. **Sistema profili** — UI dropdown + salvataggio + settings per modello/URL — fondamentale prima di tutto il resto
2. **Symbol Index + Usages** — costruito durante phase1, nessuna AI, alto impatto
3. **Query Understanding** — nuova fase pre-HyDE, piccolo modello
4. **Test associati** — nessuna AI, aggiunta semplice all'assembler
5. **Iterative Retrieval** — estensione di phase3, nessuna AI
6. **Struttura logica** — classificazione chunk post-rerank
7. **Negative Context** — filtro statico post-struttura
8. **Project Context persistente** — file statico + link nel pannello
9. **Fingerprint** — post-assembler, nessuna AI
10. **Export formats** — JSON + TXT + clipboard
11. **Confidence Score** — ultima fase, opzionale, modello configurabile
12. **Aggiornamento README** con tutti i profili

---

## Note per l'implementatore

- Il sistema profili deve essere implementato per primo perché tutti gli script Python ricevono i parametri modello tramite `config.json` — basta che l'estensione popoli `config.json` dai valori del profilo attivo
- `qwen3:30b-a3b` e `qwen3-coder:30b-a3b` sono lo stesso modello base con fine-tuning diverso — stesse VRAM requirements (~16.8GB Q4)
- Il Symbol Index deve essere un file JSON semplice, non un secondo ChromaDB — è un lookup diretto per nome, non ricerca vettoriale
- L'Iterative Retrieval usa solo regex sui chunk già trovati — non chiamate AI aggiuntive
- Il Confidence Score riceve solo path + prime 3 righe per chunk (non il testo completo) per mantenere il prompt input piccolo e la risposta veloce
- Nei profili per il MINISFORUM, sostituire `192.168.x.x` con l'IP reale della macchina — documentarlo nel README con istruzioni su come abilitare `OLLAMA_HOST=0.0.0.0` sul server
- `qwen3-coder:30b-a3b` è già in uso nel workflow Roo Code sul MINISFORUM — se è già carico in Ollama quando si genera il contesto, il tempo di risposta sarà minimo (nessun cold start)
