# Context Harvester — Implementation Plan

## Obiettivo

Estensione VS Code che replica la funzionalità di semantic search di GitHub Copilot (`#codebase`) interamente in locale, usando Ollama. Il sistema analizza un codebase locale, costruisce un indice vettoriale, e dato un input (descrizione feature o file di requisiti) restituisce un file `{CARD}_context.md` con i chunk di codice più rilevanti.

---

## Stack tecnico

### Estensione VS Code
- **Linguaggio:** TypeScript
- **API:** VS Code Extension API
- **UI:** WebView (sidebar panel) con HTML/CSS/JS vanilla
- **Comunicazione con Python:** `child_process.spawn`

### Backend Python
- **Python:** 3.10+
- **Embedding:** `ollama` Python SDK
- **Vector store:** `chromadb` (persistente su disco)
- **Chunking semantico:** `tree-sitter` per C# e TypeScript, fallback a chunking a finestra fissa
- **Re-ranking:** `ollama` con modello `bge-reranker-base`
- **Grep:** modulo `subprocess` con `ripgrep` o fallback Python puro
- **Dependency graph:** analisi statica con regex su `using` (C#) e `import` (TS)

### Modelli Ollama richiesti
- `nomic-embed-text` — embedding (Fase 1 e Fase 3)
- `qwen2.5:3b` — HyDE query expansion (Fase 2)
- `bge-reranker-base` — re-ranking (Fase 3b) *(opzionale, abilitabile da settings)*

---

## Struttura del progetto

```
context-harvester/
├── package.json
├── tsconfig.json
├── .vscodeignore
├── src/
│   ├── extension.ts              # entry point, registra comandi e panel
│   ├── panel.ts                  # WebView sidebar manager
│   ├── settings.ts               # lettura/scrittura configurazione
│   ├── pythonRunner.ts           # spawn processi Python, streaming stdout
│   └── commands/
│       ├── rebuildIndex.ts       # lancia phase0 + phase1
│       ├── generateContext.ts    # lancia phase2 + phase3 + phase3b
│       └── openContext.ts        # apre il file context.md risultante
├── webview/
│   ├── panel.html
│   ├── panel.css
│   └── panel.js
└── python/
    ├── requirements.txt
    ├── config_loader.py          # legge config.json passato dall'estensione
    ├── phase0_vocabulary.py
    ├── phase1_index.py
    ├── phase2_hyde.py
    ├── phase3_retrieval.py
    ├── phase3b_rerank.py
    ├── phase_grep.py
    ├── phase_deps.py
    └── orchestrator.py           # entry point unico chiamato dall'estensione
```

---

## Cartella output nel repo dell'utente

```
{repoPath}/
└── .context-harvester/
    ├── chroma_db/
    │   ├── code_index/           # indice vettoriale codice
    │   └── docs_index/           # indice vettoriale .md (separato)
    ├── project_vocabulary.json
    ├── index_meta.json           # timestamp ultimo index, numero file, hash
    └── output/
        ├── NED-123_context.md
        ├── NED-456_context.md
        └── ...
```

Al primo avvio, l'estensione aggiunge automaticamente `.context-harvester/` al `.gitignore` del repo se non già presente.

---

## Configurazione estensione

Tutti i settings sono in `contributes.configuration` del `package.json` e accessibili da `Settings > Extensions > Context Harvester`.

```jsonc
{
  // Repo
  "contextHarvester.repoPath": "",               // path assoluto al repo. Se vuoto, usa workspace corrente
  "contextHarvester.outputPath": "",             // path assoluto custom per i file output. Se vuoto usa {repoPath}/.context-harvester/output/
  "contextHarvester.fileNameTemplate": "{CARD}_context",  // template nome file output

  // Ollama
  "contextHarvester.ollamaUrl": "http://localhost:11434",
  "contextHarvester.embeddingModel": "nomic-embed-text",
  "contextHarvester.hydeModel": "qwen2.5:3b",
  "contextHarvester.rerankModel": "bge-reranker-base",

  // Indexing — whitelist (se vuota, usa tutto tranne blacklist)
  "contextHarvester.includeExtensions": [],
  // Indexing — blacklist (sempre applicata se whitelist vuota)
  "contextHarvester.excludeExtensions": [".md", ".txt", ".json", ".lock", ".yaml", ".yml", ".png", ".jpg", ".svg", ".pdf", ".exe", ".dll", ".zip", ".nupkg"],
  // Cartelle sempre escluse
  "contextHarvester.excludeFolders": ["bin", "obj", "node_modules", ".git", "dist", ".context-harvester", "packages", ".vs", "TestResults"],
  // Estensioni documentazione (sempre in docs_index separato)
  "contextHarvester.docExtensions": [".md"],

  // Retrieval
  "contextHarvester.topK": 10,                  // chunk finali da restituire
  "contextHarvester.topKBeforeRerank": 20,       // chunk da passare al re-ranker (deve essere > topK)
  "contextHarvester.chunkSize": 400,             // token per chunk (chunking a finestra fissa)
  "contextHarvester.chunkOverlap": 50,

  // Qualità
  "contextHarvester.multiQueryHyde": true,       // genera 3 snippet HyDE con angolazioni diverse
  "contextHarvester.enableReranking": true,
  "contextHarvester.enableGrep": true,
  "contextHarvester.enableDependencyGraph": true,
  "contextHarvester.dependencyDepth": 1,
  "contextHarvester.includeDocsInRetrieval": false,  // include docs_index nella ricerca

  // Auto-index
  "contextHarvester.autoIndex": false,
  "contextHarvester.autoIndexOnSave": false,
  "contextHarvester.autoIndexIntervalMinutes": 60
}
```

---

## UI — WebView Sidebar

La sidebar è registrata come `viewsContainers` con icona dedicata nella Activity Bar.

### Layout HTML del pannello

Il pannello ha 4 sezioni verticali collassabili:

#### Sezione INDEX
```
┌─────────────────────────────────────┐
│ INDEX                           [▲] │
│ Ultimo index: 14/05/2026 10:23      │
│ File indicizzati: 1.243             │
│ Auto-index: [toggle ON/OFF]         │
│ [🔄 Rebuild Index]                  │
└─────────────────────────────────────┘
```
- Se nessun index presente: banner warning "⚠️ Index non costruito"
- Durante rebuild: progress bar + testo "Fase 0: vocabulary... (243/1243 file)"

#### Sezione FEATURE INPUT
```
┌─────────────────────────────────────┐
│ FEATURE INPUT                   [▲] │
│ ● Scrivi a mano                     │
│ ○ Seleziona file/i                  │
│                                     │
│ [textarea multiriga]                │
│                                     │
│ SOURCES                             │
│ ☑ Codice   ☐ Documentazione (.md)  │
│                                     │
│ FOCUS (opzionale)                   │
│ ☑ Backend  ☑ Frontend  ☑ SQL       │
└─────────────────────────────────────┘
```
- Radio button per modalità input
- In modalità "file": lista file selezionati con bottone + e X per rimuovere
- Checkbox SOURCES: se spunta Documentazione, il retrieval include anche docs_index
- Checkbox FOCUS: pre-filtro per linguaggio (Backend=.cs, Frontend=.tsx/.ts, SQL=.sql)

#### Sezione OUTPUT
```
┌─────────────────────────────────────┐
│ OUTPUT                          [▲] │
│ CARD ID: [NED-123     ]             │
│ → NED-123_context.md                │
│ Path: /custom/path/ (da settings)   │
└─────────────────────────────────────┘
```
- Campo CARD ID: testo libero, usato nel template nome file
- Preview del nome file risultante aggiornata in tempo reale
- Mostra il path di output (da settings)

#### Bottone principale
```
[  🔍 Genera Contesto  ]
```
- Disabilitato se: nessun index, Ollama non raggiungibile, CARD ID vuoto (se richiesto)
- Durante generazione: mostra step corrente con spinner
  - "HyDE: generazione query (1/3)..."
  - "Retrieval: ricerca vettoriale..."
  - "Grep: ricerca pattern esatti..."
  - "Re-ranking: ordinamento risultati..."
  - "Dependency graph: analisi dipendenze..."

#### Sezione RISULTATO (appare dopo generazione)
```
┌─────────────────────────────────────┐
│ ✅ NED-123_context.md               │
│ 18 chunk • 4 file dipendenti        │
│ [📄 Apri in VS Code]                │
└─────────────────────────────────────┘
```

### Messaggi di stato Ollama
- All'apertura del pannello: ping a `ollamaUrl/api/tags`
- Se non raggiungibile: banner rosso "❌ Ollama non raggiungibile su http://localhost:11434"
- Se raggiungibile ma modello mancante: "⚠️ Modello nomic-embed-text non trovato — esegui: ollama pull nomic-embed-text"

---

## Comunicazione TypeScript ↔ Python

L'estensione non chiama i script Python direttamente uno per uno. Chiama un **unico entry point**:

```
python orchestrator.py --config /path/config.json --action rebuild_index
python orchestrator.py --config /path/config.json --action generate_context
```

### config.json (generato dall'estensione a runtime)
```json
{
  "repoPath": "/path/to/repo",
  "outputPath": "/path/to/output",
  "cardId": "NED-123",
  "fileNameTemplate": "{CARD}_context",
  "ollamaUrl": "http://localhost:11434",
  "embeddingModel": "nomic-embed-text",
  "hydeModel": "qwen2.5:3b",
  "rerankModel": "bge-reranker-base",
  "includeExtensions": [],
  "excludeExtensions": [".md", ".lock"],
  "excludeFolders": ["bin", "obj", "node_modules"],
  "docExtensions": [".md"],
  "topK": 10,
  "topKBeforeRerank": 20,
  "chunkSize": 400,
  "chunkOverlap": 50,
  "multiQueryHyde": true,
  "enableReranking": true,
  "enableGrep": true,
  "enableDependencyGraph": true,
  "dependencyDepth": 1,
  "includeDocsInRetrieval": false,
  "focusBackend": true,
  "focusFrontend": true,
  "focusSql": true,
  "featureInput": "testo della feature oppure contenuto dei file selezionati concatenati"
}
```

### Protocollo stdout (per aggiornare la UI in tempo reale)
`orchestrator.py` emette su stdout righe JSON, una per evento:

```json
{"event": "progress", "phase": "phase0", "message": "Vocabulary extraction", "current": 243, "total": 1243}
{"event": "progress", "phase": "phase1", "message": "Indexing file", "current": 500, "total": 1243}
{"event": "progress", "phase": "phase2", "message": "HyDE query 1/3", "current": 1, "total": 3}
{"event": "progress", "phase": "phase3", "message": "Retrieval vettoriale"}
{"event": "progress", "phase": "phase3b", "message": "Re-ranking"}
{"event": "progress", "phase": "grep", "message": "Grep parallelo"}
{"event": "progress", "phase": "deps", "message": "Dependency graph"}
{"event": "done", "outputFile": "/path/NED-123_context.md", "chunksCount": 18, "depsCount": 4}
{"event": "error", "message": "Ollama non raggiungibile"}
```

`pythonRunner.ts` fa parsing di ogni riga e aggiorna la WebView via `panel.webview.postMessage`.

---

## Script Python — dettaglio implementativo

### `orchestrator.py`
- Legge `--config` e `--action`
- Per `rebuild_index`: esegue phase0 → phase1 (e phase1 su docs_index se docExtensions non vuoto)
- Per `generate_context`: esegue phase2 → phase3 → phase3b → grep → deps → assembla output
- Emette eventi JSON su stdout ad ogni step
- Gestisce eccezioni e le emette come `{"event": "error", ...}`

### `phase0_vocabulary.py`
**Input:** `repoPath`, `excludeFolders`, `includeExtensions`, `excludeExtensions`

**Logica:**
1. Walk ricorsivo del repo applicando filtri cartelle ed estensioni
2. Per ogni file `.cs`: regex per estrarre
   - `class\s+(\w+)`, `interface\s+I(\w+)`, `namespace\s+([\w.]+)`
   - `public\s+\w+\s+(\w+)\s*\(` (metodi pubblici)
   - Costanti con pattern `FF_` (feature flags)
3. Per ogni file `.tsx`/`.ts`: regex per estrarre
   - `export\s+(default\s+)?function\s+(\w+)`, `const\s+(\w+)\s*=\s*\(` (componenti)
   - `import\s+.*\s+from\s+'([^']+)'` (moduli usati)
4. Per ogni file `.sql`: regex per estrarre
   - `CREATE\s+TABLE\s+([\w.]+)`, `ALTER\s+TABLE\s+([\w.]+)`
   - `CREATE\s+(PROC|PROCEDURE)\s+([\w.]+)`
5. Deduplica e ordina tutto
6. Salva `project_vocabulary.json`

**Output:** `{repoPath}/.context-harvester/project_vocabulary.json`

### `phase1_index.py`
**Input:** config completo

**Logica:**
1. Determina lista file da indicizzare (whitelist/blacklist + excludeFolders)
2. Separa file codice da file doc (docExtensions)
3. Per ogni file codice:
   - Chunking: prova prima chunking semantico con tree-sitter
   - Se tree-sitter non disponibile o parsing fallisce: chunking a finestra fissa (chunkSize token, chunkOverlap)
   - Ogni chunk ha metadata: `{file_path, start_line, end_line, language, chunk_index}`
4. Per ogni chunk: chiama `ollama.embeddings(model=embeddingModel, prompt=chunk_text)`
5. Inserisce in ChromaDB collection `code_index` con upsert (id = hash del path+chunk_index)
6. Stessa procedura per file doc → collection `docs_index`
7. Salva `index_meta.json` con timestamp, numero file, lista path con hash contenuto

**Chunking semantico con tree-sitter:**
- C#: chunk = funzione/metodo completo. Se > chunkSize, split a metà
- TypeScript/TSX: chunk = funzione/componente/hook completo
- SQL: chunk = statement completo (CREATE TABLE, CREATE PROC, ecc.)
- Fallback: sliding window su token (split su whitespace)

**Update incrementale:**
- Al rebuild, confronta hash file in `index_meta.json` con hash correnti
- Re-indicizza solo file modificati o nuovi
- Rimuove da ChromaDB i chunk di file eliminati

**Output:** `{repoPath}/.context-harvester/chroma_db/code_index/` e `docs_index/`

### `phase2_hyde.py`
**Input:** `featureInput`, `project_vocabulary.json`, `hydeModel`, `ollamaUrl`, `multiQueryHyde`, `focusBackend`, `focusFrontend`, `focusSql`

**Logica:**

Se `multiQueryHyde = false`: genera 1 snippet generico.

Se `multiQueryHyde = true`: genera fino a 3 snippet con prompt diversi, solo per i focus abilitati:

**Prompt Backend (se focusBackend):**
```
Sei un developer C#/.NET che lavora su un progetto chiamato EnergyDeal.

Classi esistenti nel progetto: {classes[:50]}
Namespace: {namespaces[:20]}
Feature flags: {feature_flags}

Requisito: {featureInput}

Scrivi uno snippet C# ipotetico (20-30 righe) che rappresenti come questa
feature potrebbe essere implementata. Usa i nomi reali del progetto.
Rispondi SOLO con codice, nessuna spiegazione.
```

**Prompt Frontend (se focusFrontend):**
```
Sei un developer React/TypeScript che lavora su un progetto chiamato EnergyDeal.

Componenti esistenti: {components[:50]}
Moduli usati: {imports[:30]}

Requisito: {featureInput}

Scrivi uno snippet TypeScript/React ipotetico (20-30 righe).
Usa i nomi reali del progetto. SOLO codice.
```

**Prompt SQL (se focusSql):**
```
Sei un DBA che lavora su SQL Server per un progetto chiamato EnergyDeal.

Tabelle esistenti: {tables[:50]}
Stored procedure esistenti: {procedures[:30]}

Requisito: {featureInput}

Scrivi uno snippet SQL ipotetico (10-20 righe).
Usa i nomi reali del progetto. SOLO codice.
```

**Output:** lista di 1-3 snippet stringa

### `phase3_retrieval.py`
**Input:** lista snippet HyDE, config, `includeDocsInRetrieval`

**Logica:**
1. Per ogni snippet HyDE:
   - Embed con `nomic-embed-text`
   - Query ChromaDB `code_index` → top `topKBeforeRerank` risultati con score
   - Se `includeDocsInRetrieval`: query anche `docs_index` → top 5 risultati
2. Merge di tutti i risultati da query multiple
3. De-duplicazione per `file_path + start_line`
4. Se stesso file appare con chunk contigui, unifica in un unico chunk esteso
5. Ordina per score medio (se chunk appare in più query, media degli score)

**Output:** lista chunk con `{file_path, start_line, end_line, text, score, language}`

### `phase3b_rerank.py`
**Input:** lista chunk da phase3, `featureInput`, `rerankModel`, `topK`

**Logica:**
1. Per ogni chunk, chiama il re-ranker con coppia (featureInput, chunk_text)
2. Score di rilevanza restituito dal modello
3. Ordina per score re-ranker (descrescente)
4. Taglia ai top `topK`

**Nota implementativa:** `bge-reranker-base` via Ollama potrebbe non essere disponibile come modello di reranking nativo. Alternativa: usa il modello `hydeModel` (qwen2.5:3b) con prompt di scoring:
```
Da 0 a 10, quanto è rilevante questo codice per il requisito dato?
Requisito: {featureInput}
Codice: {chunk_text}
Rispondi SOLO con un numero intero.
```

### `phase_grep.py`
**Input:** `featureInput`, `repoPath`, `excludeFolders`, file list da index

**Logica:**
1. Estrai keyword dalla feature input: nomi di classi/tabelle/componenti menzionati esplicitamente (confronto con `project_vocabulary.json`)
2. Per ogni keyword trovata: esegui ricerca testuale nel repo
   - Se `ripgrep` disponibile: `rg --json -n {keyword} {repoPath}`
   - Altrimenti: Python `re.finditer` su ogni file
3. Per ogni match: estrai contesto ±10 righe
4. De-duplicazione con chunk già trovati in phase3 (per path+riga)
5. I chunk grep hanno score fisso = 0.75 (sotto i vettoriali top ma sopra i peggiori)

**Output:** lista chunk aggiuntivi da aggiungere al pool

### `phase_deps.py`
**Input:** lista chunk finali (post-rerank), `repoPath`, `dependencyDepth`

**Logica:**
1. Per ogni file presente nei chunk finali:
   - File `.cs`: estrai `using` statements → trova i file corrispondenti nel repo
   - File `.ts`/`.tsx`: estrai `import from` → risolvi path relativi → trova file
2. Per i file dipendenti trovati (profondità 1):
   - Leggi il file completo
   - Aggiungi al contesto finale come sezione separata "Dipendenze"
   - NON vengono re-rankati, vengono inclusi per intero se < 200 righe, altrimenti solo la firma delle classi/funzioni pubbliche

**Output:** lista file dipendenti con contenuto

### `assembler.py` (chiamato da orchestrator alla fine)
**Input:** chunk finali, file dipendenti, config, cardId

**Logica:**
Costruisce il file markdown finale:

```markdown
# Context: {cardId}
**Feature:** {featureInput primo rigo o primi 100 char}
**Generato:** {timestamp}
**Chunks:** {N} | **Dipendenze:** {M}

---

## Codice rilevante

### [{score:.2f}] `src/Validators/ContractValidator.cs` (righe 45–89)
```csharp
...codice...
```

### [{score:.2f}] `src/Components/ContractForm.tsx` (righe 78–120)
```tsx
...codice...
```

---

## File dipendenti

### `src/Validators/Base/DefaultValidator.cs`
```csharp
...contenuto o firme pubbliche...
```
```

Salva in `{outputPath}/{cardId}_context.md`

---

## Gestione virtualenv Python

L'estensione al primo avvio (o su comando manuale) esegue:

```typescript
// in extension.ts, activate()
await ensurePythonEnvironment(context);
```

`ensurePythonEnvironment`:
1. Cerca `python3` o `python` nel PATH
2. Crea virtualenv in `{extensionPath}/python/.venv` se non esiste
3. Esegue `pip install -r requirements.txt` nel venv
4. Salva path del python eseguibile nel globalState

Tutti gli spawn successivi usano il python del venv, non quello di sistema.

**`requirements.txt`:**
```
chromadb>=0.4.0
ollama>=0.1.0
tree-sitter>=0.21.0
tree-sitter-languages>=1.8.0
```

---

## `index_meta.json` — struttura

```json
{
  "lastIndexed": "2026-05-14T10:23:00Z",
  "totalFiles": 1243,
  "codeFiles": 1198,
  "docFiles": 45,
  "fileHashes": {
    "src/Validators/ContractValidator.cs": "sha256:abc123...",
    "src/Components/ContractForm.tsx": "sha256:def456..."
  },
  "settings": {
    "includeExtensions": [],
    "excludeExtensions": [".md", ".lock"],
    "excludeFolders": ["bin", "obj"]
  }
}
```

Usato per:
- Mostrare "Ultimo index: X" nel pannello
- Rilevare file modificati per update incrementale
- Rilevare se i settings di indexing sono cambiati (force rebuild)

---

## Auto-index

In `extension.ts`:

```typescript
// On save
vscode.workspace.onDidSaveTextDocument((doc) => {
  if (!config.autoIndexOnSave) return;
  if (!isFileInRepo(doc.uri.fsPath)) return;
  if (isExcluded(doc.uri.fsPath)) return;
  debounce(triggerIncrementalIndex, 2000)();
});

// Interval
if (config.autoIndex) {
  setInterval(() => {
    triggerIncrementalIndex();
  }, config.autoIndexIntervalMinutes * 60 * 1000);
}
```

L'auto-index esegue sempre l'update incrementale (non rebuild completo).

---

## Comandi VS Code registrati

```typescript
// package.json contributes.commands
"context-harvester.rebuildIndex"      // Rebuild Index completo
"context-harvester.generateContext"   // Genera contesto (apre panel se chiuso)
"context-harvester.openPanel"         // Apre sidebar
"context-harvester.openLastContext"   // Apre l'ultimo context.md generato
"context-harvester.checkOllama"       // Verifica connessione Ollama e modelli
```

---

## Gestione errori

| Errore | Comportamento |
|---|---|
| Ollama non raggiungibile | Banner rosso nel panel, bottone disabilitato |
| Modello non trovato | Warning con comando `ollama pull` suggerito |
| Repo path non valido | Errore inline nel settings |
| Python non trovato | Popup con istruzioni installazione |
| ChromaDB corrotto | Pulsante "Reset Index" nel panel |
| Nessun chunk trovato | Messaggio "Nessun contesto trovato — prova a riformulare o riduci i filtri FOCUS" |
| Timeout Ollama (>60s) | Errore con suggerimento di aumentare timeout o ridurre topKBeforeRerank |

---

## Ordine di implementazione consigliato

1. Scaffold estensione VS Code (package.json, extension.ts, WebView base)
2. Settings e lettura configurazione (`settings.ts`)
3. `pythonRunner.ts` con parsing eventi JSON stdout
4. `phase0_vocabulary.py` + UI feedback
5. `phase1_index.py` con chunking a finestra fissa (tree-sitter opzionale in secondo momento)
6. `phase2_hyde.py` con single query (multiQuery opzionale dopo)
7. `phase3_retrieval.py`
8. `assembler.py` + apertura file in VS Code
9. UI completa WebView con tutti gli stati
10. `phase3b_rerank.py`
11. `phase_grep.py`
12. `phase_deps.py`
13. Auto-index (on save + interval)
14. Update incrementale in phase1
15. Chunking semantico con tree-sitter
16. Multi-query HyDE
17. Virtualenv automatico

---

## Note finali per l'implementatore

- Tutti i path passati a Python devono essere assoluti e normalizzati (usare `path.resolve` in TS, `Path.resolve` in Python)
- ChromaDB deve essere inizializzato con `Settings(anonymized_telemetry=False)`
- Gli embed di Ollama hanno un limite di ~8192 token per chunk — il chunkSize di 400 token è ampiamente sicuro
- Su Windows, `child_process.spawn` richiede `shell: true` per trovare `python` nel PATH
- Il file `config.json` passato a orchestrator va scritto in una temp dir (`os.tmpdir()`) e cancellato dopo l'esecuzione
- La WebView deve usare `acquireVsCodeApi()` per la comunicazione con l'estensione
- Tutti i path nel `context.md` devono essere relativi alla root del repo (non assoluti) per portabilità
