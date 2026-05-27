# Context Harvester — Piano di Implementazione v3

Questo documento estende il Piano v1 e v2 con:
- Integrazione Graphify (step 1 solo, via libreria Python) per knowledge graph e functional analysis
- Graph Report generato internamente dal grafo NetworkX
- Visualizzazione interattiva del grafo nel pannello VS Code (vis.js WebView)
- MCP Server locale che espone le funzionalità del sistema a qualsiasi AI assistant
- Sistema modulare: ogni layer è opzionale e indipendente
- Aggiornamento README con spiegazioni di tutti i concetti e moduli

---

## Principio architetturale v3

Il sistema è organizzato in **4 layer indipendenti**. Ogni layer funziona senza quelli superiori. L'utente abilita solo quello che vuole.

```
LAYER 1 — Context Harvester base (v1+v2)
  Sempre disponibile. Nessuna dipendenza aggiuntiva.
  Input: feature request → Output: {CARD}_context.md

LAYER 2 — Functional Analysis
  Richiede: graphify (libreria Python, solo step 1)
  Input: codebase → Output: functional_map.json + graph NetworkX

LAYER 3 — Graph Visualization + Report
  Richiede: Layer 2
  Input: graph NetworkX → Output: WebView vis.js + GRAPH_REPORT.md

LAYER 4 — MCP Server
  Richiede: Layer 1 attivo
  Espone: tool MCP usabili da GitHub Copilot, Roo Code, Claude Code, Continue, ecc.
```

---

## Nuove dipendenze Python

```
# requirements.txt — aggiunte v3
networkx>=3.0
graspologic>=3.0          # Leiden clustering
tree-sitter>=0.21.0       # già presente in v1/v2
tree-sitter-languages>=1.8.0  # già presente
fastapi>=0.110.0          # MCP server
uvicorn>=0.29.0           # MCP server runtime
mcp>=1.0.0                # MCP SDK Python
```

Graphify **non viene installato come pacchetto** — si importano direttamente le sue funzioni copiando i moduli rilevanti (`extract.py`, `build_graph.py`, `cluster.py`) nella cartella `python/graphify_core/` del progetto. Questo evita dipendenze dalla versione di Graphify e permette di usare solo lo step 1 senza il resto del pipeline.

---

## LAYER 2 — Functional Analysis

### Panoramica

Analizza il codebase per trovare le funzionalità esistenti, seguire il flusso del codice per ognuna, e raccogliere il naming usato in ogni flusso. Produce un `functional_map.json` che arricchisce tutto il sistema.

### Step 2.1 — Graph Extraction (nessuna AI)

**Script:** `python/graphify_core/extract.py` (adattato da Graphify step 1)

**Input:** codebase filtrato con le stesse regole di include/exclude del Layer 1

**Cosa estrae per C#:**
- Nodi: classi, interfacce, metodi pubblici, namespace
- Edge `calls`: chiamate a metodi (`NomeClasse.NomeMetodo()`)
- Edge `imports`: `using` statements
- Edge `inherits`: `: BaseClass`, `: IInterface`
- Edge `instantiates`: `new NomeClasse()`

**Cosa estrae per TypeScript/TSX:**
- Nodi: componenti, funzioni, hook, tipi
- Edge `imports`: `import from`
- Edge `uses`: componenti usati nel JSX (`<NomeComponente`)
- Edge `calls`: chiamate a funzioni/hook

**Cosa estrae per SQL:**
- Nodi: tabelle, viste, stored procedure, funzioni
- Edge `references`: foreign key, JOIN
- Edge `calls`: EXEC procedure

**Output:** dizionario Python `{nodes: [...], edges: [...]}` con campo `confidence: EXTRACTED|INFERRED`

**Nota:** usiamo solo edge `EXTRACTED` (trovati direttamente nell'AST) — ignoriamo `INFERRED` per massima affidabilità.

### Step 2.2 — Graph Building + Clustering (nessuna AI)

**Script:** `python/phase_graph.py`

**Input:** dizionario nodes/edges dallo step 2.1

**Processo:**
1. Costruisce grafo NetworkX diretto da nodes/edges
2. Applica **Leiden clustering** (via graspologic) per trovare community
3. Ogni community = gruppo di nodi fortemente connessi = funzionalità candidata
4. Assegna un nome automatico a ogni community basandosi sul nodo con più connessioni (god node della community)
5. Calcola per ogni community: dimensione, god nodes interni, edge verso altre community

**Output:**
- Grafo NetworkX salvato come `graphify_graph.pkl` in `.context-harvester/`
- `communities_raw.json` — lista community con nomi automatici, nodi, statistiche

### Step 2.3 — Validazione community (UI)

L'utente valida le community trovate nel pannello VS Code prima che diventino funzionalità ufficiali. Questa è la parte "ibrida" — il sistema propone, l'utente approva e corregge.

**Nel pannello VS Code, nuova sezione:**

```
┌─────────────────────────────────────┐
│  FUNCTIONAL ANALYSIS            [▲] │
│                                     │
│  Community trovate: 18              │
│  Validate: 12  │  Da validare: 6    │
│                                     │
│  [📊 Apri Graph View]               │
│  [✅ Valida community]              │
│  [🔄 Rigenera]                      │
└─────────────────────────────────────┘
```

**Schermata di validazione (WebView separata o modal):**

```
┌─────────────────────────────────────────────┐
│  Valida Community                           │
│                                             │
│  Community #3 — "LeadService" (23 nodi)     │
│  God nodes: LeadService, CrmApiClient       │
│                                             │
│  Nodi principali:                           │
│  • LeadService.cs                           │
│  • CrmApiClient.cs                          │
│  • ContractLead.cs                          │
│  • LeadList.tsx                             │
│  • Contract.Lead (SQL)                      │
│                                             │
│  Nome funzionalità: [Lead Management    ]   │
│                                             │
│  [✅ Approva]  [🔀 Unisci con altra]  [🗑 Escludi] │
│                                             │
│  < 3 / 18 >                                │
└─────────────────────────────────────────────┘
```

**Output dopo validazione:** `functional_map.json`

### Step 2.4 — Functional Map

**File:** `.context-harvester/functional_map.json`

```json
{
  "version": "1.0",
  "lastUpdated": "2026-05-27T10:00:00Z",
  "functions": [
    {
      "id": "lead-management",
      "name": "Lead Management",
      "validated": true,
      "manuallyEdited": false,
      "godNodes": ["LeadService", "CrmApiClient"],
      "nodes": [
        {"id": "LeadService", "file": "src/Services/LeadService.cs", "type": "class"},
        {"id": "CrmApiClient", "file": "src/Integrations/CrmApiClient.cs", "type": "class"},
        {"id": "ContractLead", "file": "src/Models/ContractLead.cs", "type": "class"},
        {"id": "LeadList", "file": "src/Components/LeadList.tsx", "type": "component"},
        {"id": "Contract.Lead", "file": "src/Database/schema.sql", "type": "table"}
      ],
      "edges": [
        {"from": "LeadService", "to": "CrmApiClient", "relation": "calls", "confidence": "EXTRACTED"},
        {"from": "LeadService", "to": "ContractLead", "relation": "uses", "confidence": "EXTRACTED"}
      ],
      "files": [
        "src/Services/LeadService.cs",
        "src/Integrations/CrmApiClient.cs",
        "src/Models/ContractLead.cs",
        "src/Components/LeadList.tsx"
      ],
      "terms": {
        "classes": ["LeadService", "CrmApiClient", "ContractLead"],
        "components": ["LeadList", "DisqualificationModal"],
        "tables": ["Contract.Lead", "Contract.EntityLead"],
        "methods": ["UpsertLead", "SyncLead", "DisqualifyLead"],
        "featureFlags": ["FF_NED_checkMorosita"],
        "domainConcepts": ["lead", "disqualification", "morosità", "CRM"]
      }
    }
  ]
}
```

Il campo `terms` viene popolato automaticamente dall'incrocio tra i nodi della community e il `project_vocabulary.json` già esistente dalla Fase 0.

### Step 2.5 — Integrazione con il Context Harvester (Layer 1)

Quando `functional_map.json` esiste, il Context Harvester lo usa in due modi:

**Nel Query Understanding:** oltre a classificare il tipo di feature, il modello riceve la lista dei nomi di funzionalità e identifica se la feature tocca una funzionalità esistente:

```json
{
  "type": "modify_existing",
  "areas": ["backend", "frontend"],
  "key_symbols": ["LeadService"],
  "related_function": "lead-management",   ← NUOVO
  "search_hints": ["UpsertLead", "DisqualifyLead"]
}
```

**Nel retrieval:** se `related_function` è valorizzato, i file della funzionalità vengono aggiunti al pool con score = 0.95 prima ancora di fare retrieval vettoriale. Il retrieval vettoriale si occupa di trovare i chunk specifici rilevanti all'interno di quei file.

**Nel prompt HyDE:** i `terms` della funzionalità correlata vengono iniettati nel prompt insieme al `project_vocabulary.json`, rendendo lo snippet ipotetico molto più preciso.

---

## LAYER 3 — Graph Visualization + Report

### Graph Report (generato internamente, nessuna AI)

**Script:** `python/graph_report.py`

**Input:** grafo NetworkX + `functional_map.json`

**Logica — tutto calcolabile con NetworkX:**

```python
import networkx as nx

# God nodes — nodi con più connessioni totali (in + out degree)
god_nodes = sorted(graph.nodes, key=lambda n: graph.degree(n), reverse=True)[:10]

# Bridge nodes — nodi che connettono community diverse (betweenness centrality alta)
bridges = nx.betweenness_centrality(graph)
bridge_nodes = sorted(bridges, key=bridges.get, reverse=True)[:10]

# Surprising connections — edge tra community distanti (path length > 3)
surprising = [
    (u, v) for u, v, d in graph.edges(data=True)
    if community_of(u) != community_of(v)
    and nx.shortest_path_length(graph, u, v) > 3
]

# Isolated nodes — nodi senza connessioni (candidati per pulizia)
isolated = list(nx.isolates(graph))

# Community density — community troppo sparse (candidati per merge)
community_density = {
    c: nx.density(subgraph_of_community(c))
    for c in communities
}
```

**Output:** `.context-harvester/GRAPH_REPORT.md`

```markdown
# Graph Report — EnergyDeal
Generato: 2026-05-27 | Nodi: 892 | Edge: 3401 | Community: 18

## God Nodes (elementi più connessi)
| Nodo | Connessioni | Community |
|---|---|---|
| ContractService | 47 | Contract Management |
| BTextInput | 38 | Frontend Components |

## Bridge Nodes (collegano aree diverse)
| Nodo | Betweenness | Connette |
|---|---|---|
| GZipHelper | 0.34 | Data Layer ↔ Services |

## Surprising Connections
- `LeadService` → `OCRService` (via ContractAttachment) — flusso non ovvio
- `BSelect` → `ValidationService` — componente UI con dipendenza diretta su validazione

## Community troppo sparse (candidati per merge)
- "Utility Misc" (3 nodi, density 0.12) — considera merge con "Common"

## Nodi isolati (nessuna connessione rilevata)
- LegacyExportHelper.cs — file probabilmente deprecato
```

### Graph Visualization (WebView vis.js)

**Componente:** `webview/graph_view.html` + `webview/graph_view.js`

**Apertura:** bottone "📊 Apri Graph View" nel pannello, apre una WebView dedicata a tab separato in VS Code.

**Funzionalità della WebView:**

```
┌─────────────────────────────────────────────────────┐
│  Knowledge Graph — EnergyDeal      [🔍 cerca nodo] │
├─────────────────────────────────────────────────────┤
│  FILTRI                                             │
│  ☑ C#  ☑ TypeScript  ☑ SQL                         │
│  Community: [Tutte ▼]                               │
│  Mostra: ☑ EXTRACTED  ☐ INFERRED                   │
├─────────────────────────────────────────────────────┤
│                                                     │
│  [grafo vis.js interattivo]                         │
│  - nodi colorati per community                      │
│  - dimensione nodo = numero connessioni             │
│  - edge colorati per tipo (calls/imports/uses)      │
│  - click su nodo → highlight connessioni dirette    │
│  - double click → apre il file in VS Code           │
│                                                     │
├─────────────────────────────────────────────────────┤
│  Nodo selezionato: LeadService                      │
│  File: src/Services/LeadService.cs                  │
│  Community: Lead Management                         │
│  Connessioni: 12 out / 4 in                         │
│  [Apri file]  [Usa come seed retrieval]             │
├─────────────────────────────────────────────────────┤
│  Community selezionata: Lead Management (23 nodi)   │
│  [✅ Valida come funzionalità]  [📊 Report]         │
└─────────────────────────────────────────────────────┘
```

**Ricerca nodo:** filtra il grafo in tempo reale mostrando solo il nodo cercato e le sue connessioni dirette. Utile per rispondere a "chi chiama ContractValidator?" o "cosa usa BTextInput?".

**"Usa come seed retrieval":** premendo questo bottone su un nodo nel grafo, il sistema lancia automaticamente un retrieval nel context harvester usando quel simbolo come seed diretto, saltando la fase HyDE.

**Dati al grafo:** la WebView riceve il grafo via `postMessage` dall'estensione TypeScript, che lo serializza da NetworkX (salvato come JSON in `.context-harvester/graph.json` durante la graph extraction).

**Formato graph.json per vis.js:**
```json
{
  "nodes": [
    {"id": "LeadService", "label": "LeadService", "group": "lead-management",
     "file": "src/Services/LeadService.cs", "size": 20, "type": "class"}
  ],
  "edges": [
    {"from": "LeadService", "to": "CrmApiClient",
     "label": "calls", "confidence": "EXTRACTED"}
  ]
}
```

---

## LAYER 4 — MCP Server

### Cos'è e perché

<context>
MCP (Model Context Protocol) è lo standard aperto adottato da VS Code, GitHub Copilot, Claude Code, Roo Code, Continue e praticamente tutti gli AI coding assistant moderni. Un MCP server è un processo locale che espone "tool" — funzioni che l'AI può invocare durante una conversazione.

Con il MCP server attivo, qualsiasi AI assistant che supporta MCP può chiamare il context harvester direttamente, senza aprire il pannello VS Code. L'utente scrive in Roo Code o Copilot:

"Genera il contesto per NED-123: aggiungi validazione IBAN al contratto"

e l'AI chiama il tool `generate_context`, riceve il `context.md` come tool result, e lo usa come contesto per la sua risposta.
</context>

### Tool esposti

Il MCP server espone questi tool:

```python
# Tool 1 — genera contesto per una feature
generate_context(
    card_id: str,           # "NED-123"
    feature_input: str,     # descrizione feature
    profile: str = "laptop-balanced",  # profilo AI da usare
    focus: list = ["backend", "frontend", "sql"],
    include_docs: bool = False
) -> str  # path del context.md generato + summary

# Tool 2 — cerca nel codebase (retrieval diretto senza HyDE)
search_codebase(
    query: str,             # query di ricerca
    top_k: int = 10,
    focus: list = ["backend", "frontend", "sql"]
) -> list  # lista chunk con file, righe, score

# Tool 3 — info su una funzionalità esistente
get_function_info(
    function_name: str      # "Lead Management" o "lead-management"
) -> dict  # nodi, file, terms, flusso della funzionalità

# Tool 4 — stato dell'index
get_index_status() -> dict  # ultimo index, numero file, profilo attivo

# Tool 5 — lista funzionalità mappate
list_functions() -> list    # lista nomi funzionalità in functional_map.json
```

### Implementazione

**Script:** `python/mcp_server.py`

**Stack:** FastAPI + uvicorn + MCP Python SDK

Il server gira come processo separato, avviato dall'estensione VS Code quando il Layer 4 è abilitato.

**Porta:** configurabile in settings (default: 3456), deve essere libera.

**Avvio:**
```bash
python mcp_server.py --config /path/config.json --port 3456
```

L'estensione avvia il server in background con `child_process.spawn` e lo termina quando VS Code si chiude.

### Configurazione in VS Code (.vscode/mcp.json)

L'estensione genera automaticamente questo file nella root del workspace quando il Layer 4 è abilitato:

```json
{
  "servers": {
    "context-harvester": {
      "type": "http",
      "url": "http://localhost:3456/mcp",
      "description": "Context Harvester — semantic codebase retrieval"
    }
  }
}
```

Questo file viene aggiunto al `.gitignore` automaticamente (contiene l'URL locale, non ha senso versionarlo).

### Compatibilità confermata

GitHub Copilot in VS Code (Agent Mode), Roo Code, Claude Code, Continue.dev, qualsiasi tool che supporti MCP standard. Non richiede configurazione aggiuntiva oltre al file `.vscode/mcp.json`.

### Pannello UI — sezione MCP

```
┌─────────────────────────────────────┐
│  MCP SERVER                     [▲] │
│  Stato: ● Attivo su :3456           │
│  Tool disponibili: 5                │
│  [⏹ Ferma]  [🔄 Riavvia]           │
│                                     │
│  Ultima chiamata:                   │
│  generate_context (NED-123) — 42s   │
└─────────────────────────────────────┘
```

---

## Struttura cartelle aggiornata

```
.context-harvester/
├── chroma_db/
│   ├── code_index/
│   └── docs_index/
├── project_vocabulary.json
├── project_context.md
├── symbol_index.json
├── index_meta.json
├── context_log.json
│
├── graphify_graph.pkl          ← NUOVO — grafo NetworkX serializzato
├── graph.json                  ← NUOVO — grafo serializzato per vis.js
├── communities_raw.json        ← NUOVO — community prima della validazione
├── functional_map.json         ← NUOVO — dopo validazione
├── GRAPH_REPORT.md             ← NUOVO — generato da graph_report.py
│
└── output/
    ├── NED-123_context.md
    ├── NED-123_context.json
    └── NED-123_context.txt
```

---

## Struttura progetto aggiornata

```
context-harvester/
├── package.json
├── tsconfig.json
├── src/
│   ├── extension.ts
│   ├── panel.ts
│   ├── graphView.ts              ← NUOVO — gestisce WebView grafo
│   ├── mcpServer.ts              ← NUOVO — gestisce processo MCP server
│   ├── settings.ts
│   ├── pythonRunner.ts
│   └── commands/
│       ├── rebuildIndex.ts
│       ├── generateContext.ts
│       ├── openContext.ts
│       ├── runFunctionalAnalysis.ts   ← NUOVO
│       ├── openGraphView.ts           ← NUOVO
│       └── validateCommunities.ts     ← NUOVO
├── webview/
│   ├── panel.html
│   ├── panel.css
│   ├── panel.js
│   ├── graph_view.html           ← NUOVO
│   ├── graph_view.css            ← NUOVO
│   └── graph_view.js             ← NUOVO (vis.js)
└── python/
    ├── requirements.txt
    ├── config_loader.py
    ├── orchestrator.py
    ├── phase0_vocabulary.py
    ├── phase1_index.py
    ├── phase2_hyde.py
    ├── phase3_retrieval.py
    ├── phase3b_rerank.py
    ├── phase_grep.py
    ├── phase_deps.py
    ├── assembler.py
    ├── phase_graph.py            ← NUOVO — step 2.1 + 2.2
    ├── graph_report.py           ← NUOVO — genera GRAPH_REPORT.md
    ├── mcp_server.py             ← NUOVO — MCP server FastAPI
    └── graphify_core/            ← NUOVO — moduli adattati da Graphify step 1
        ├── __init__.py
        ├── extract.py            ← AST extraction (adattato da Graphify)
        ├── build_graph.py        ← NetworkX graph building
        ├── cluster.py            ← Leiden clustering
        └── validate.py           ← schema validation nodes/edges
```

---

## Settings aggiornati — Layer 2, 3, 4

```jsonc
// ── Moduli attivi ─────────────────────────────────
"contextHarvester.enableFunctionalAnalysis": false,  // Layer 2
"contextHarvester.enableGraphView": false,            // Layer 3
"contextHarvester.enableMcpServer": false,            // Layer 4

// ── Functional Analysis ───────────────────────────
"contextHarvester.graph.minCommunitySize": 3,    // community con meno nodi vengono scartate
"contextHarvester.graph.maxCommunitySize": 50,   // community troppo grandi vengono suddivise
"contextHarvester.graph.useInferredEdges": false, // usa solo edge EXTRACTED (raccomandato)
"contextHarvester.graph.autoValidate": false,    // valida community automaticamente senza UI

// ── MCP Server ────────────────────────────────────
"contextHarvester.mcp.port": 3456,
"contextHarvester.mcp.autoStart": false,         // avvia MCP server all'apertura di VS Code
```

---

## Flusso completo v3

```
[LAYER 2 — una tantum]

Codebase
    │ graphify_core (step 1 solo, no AI)
    ▼
Grafo NetworkX + Leiden clustering
    │
    ▼
Community candidate
    │ validazione utente (WebView)
    ▼
functional_map.json
    │
    └──→ graph.json (per vis.js)
    └──→ GRAPH_REPORT.md (generato con NetworkX, no AI)


[LAYER 1 — ad ogni feature, arricchito da Layer 2]

Feature request
    │
    ▼
[Query Understanding] ← qwen3:8b
  + rileva related_function da functional_map.json
    │
    ├──→ se related_function trovata:
    │       file della funzionalità → pool con score 0.95
    │       terms della funzionalità → iniettati in HyDE
    │
    ▼
[HyDE] ← qwen3:8b
  + vocabulary + functional terms
    │
    ▼
[Symbol Search] ← symbol_index.json
    │
    ▼
[Retrieval vettoriale] ← nomic-embed-text
    │
    ▼
[Iterative Retrieval x2] ← analisi statica
    │
    ▼
[Grep parallelo] ← keyword + traduzioni IT/EN
    │
    └── merge + dedup
    │
    ▼
[Re-ranking] ← bge-reranker
    │
    ▼
[Test associati] ← no AI
    │
    ▼
[Struttura logica] ← qwen3:8b
    │
    ▼
[Negative context] ← no AI
    │
    ▼
[Dependency graph] ← no AI
    │
    ▼
[Confidence score] ← qwen3:14b (opzionale)
    │
    ▼
[Fingerprint] ← no AI
    │
    ▼
[Assembler]
    │
    ▼
{CARD}_context.md + .json + .txt


[LAYER 4 — sempre attivo se abilitato]

MCP Server (FastAPI, porta 3456)
    ↑
GitHub Copilot / Roo Code / Claude Code / Continue
    chiama tool: generate_context, search_codebase,
                 get_function_info, list_functions
```

---

## Pannello UI v3 completo

```
┌─────────────────────────────────────┐
│  🌾 Context Harvester            v3 │
├─────────────────────────────────────┤
│  PROFILO AI                         │
│  [Laptop — Balanced (rec.)   ▼]     │
│  [+ Nuovo] [✏️ Modifica] [🗑 Elimina]│
├─────────────────────────────────────┤
│  INDEX                              │
│  Ultimo: 27/05/2026 10:23           │
│  File: 1.243 • Simboli: 892         │
│  Auto-index: [toggle]               │
│  [🔄 Rebuild Index]                 │
├─────────────────────────────────────┤
│  FUNCTIONAL ANALYSIS        [▲/▼]   │
│  Community: 18 (12 validate)        │
│  [📊 Apri Graph View]               │
│  [✅ Valida community]              │
│  [🔄 Rigenera analisi]             │
├─────────────────────────────────────┤
│  MCP SERVER                 [▲/▼]   │
│  ● Attivo su :3456                  │
│  [⏹ Ferma]  [🔄 Riavvia]           │
├─────────────────────────────────────┤
│  FEATURE INPUT                      │
│  ● Scrivi a mano  ○ Seleziona file  │
│  [textarea]                         │
│                                     │
│  SOURCES                            │
│  ☑ Codice  ☐ Documentazione (.md)  │
│                                     │
│  FOCUS (da Query Understanding)     │
│  ☑ Backend  ☑ Frontend  ☑ SQL       │
├─────────────────────────────────────┤
│  OUTPUT                             │
│  CARD ID: [NED-123     ]            │
│  → NED-123_context.md               │
│  Export: ☐ JSON  ☐ TXT             │
├─────────────────────────────────────┤
│  [  🔍 Genera Contesto  ]           │
├─────────────────────────────────────┤
│  ✅ NED-123_context.md              │
│  18 chunk • 4 dep • score: 7/10     │
│  Funzionalità: Lead Management      │
│  [📄 Apri]  [📋 Copia]  [⬇JSON] [⬇TXT]│
└─────────────────────────────────────┘
```

---

## Ordine di implementazione v3

Continuando dall'ordine v2 (step 1-12 già completati):

13. **`graphify_core/`** — copia e adatta i moduli extract.py, build_graph.py, cluster.py, validate.py da Graphify. Test su EnergyDeal.
14. **`phase_graph.py`** — orchestrazione step 2.1 + 2.2, salva `graphify_graph.pkl` e `communities_raw.json`
15. **WebView validazione community** — schermata step 2.3 con approvazione/rinomina/merge/escludi
16. **Integrazione functional_map in Query Understanding** — rilevamento `related_function`
17. **Integrazione functional_map in HyDE** — inietta terms della funzionalità nel prompt
18. **Integrazione functional_map in retrieval** — file della funzionalità nel pool con score 0.95
19. **`graph_report.py`** — genera `GRAPH_REPORT.md` con NetworkX (centralità, bridge nodes, ecc.)
20. **`graph.json`** — serializzazione grafo per vis.js
21. **WebView Graph View** — vis.js interattivo con ricerca, filtri, selezione community, apertura file
22. **`mcp_server.py`** — FastAPI + MCP SDK, 5 tool esposti
23. **`mcpServer.ts`** — gestione processo MCP server dall'estensione
24. **Generazione automatica `.vscode/mcp.json`**
25. **Sezione MCP nel pannello UI**
26. **Aggiornamento README** (vedi sezione sotto)

---

## Aggiornamento README

Il README deve diventare una guida completa che spiega tutti i concetti a un utente che non ha mai sentito parlare di RAG o knowledge graph. Struttura:

### Sezione: Cos'è Context Harvester

Spiegazione in linguaggio semplice: il sistema analizza il tuo codebase e, quando descrivi una feature da implementare, trova automaticamente il codice più rilevante e lo raccoglie in un file di contesto pronto da dare in pasto a qualsiasi AI.

### Sezione: Come funziona — i concetti chiave

Spiegare con analogie semplici:
- **Embedding e retrieval vettoriale** — "come una ricerca Google sul tuo codice, ma per significato invece che per parole esatte"
- **HyDE (Hypothetical Document Embedding)** — "prima immaginiamo come potrebbe essere scritto il codice, poi cerchiamo quello che assomiglia di più"
- **Re-ranking** — "un secondo passaggio che riordina i risultati per qualità, non solo per similarità"
- **Knowledge graph** — "una mappa delle relazioni tra classi, componenti e tabelle del tuo progetto"
- **Leiden clustering** — "un algoritmo che trova automaticamente i 'quartieri' del tuo codebase — gruppi di codice che lavorano insieme"
- **MCP server** — "un ponte che permette a GitHub Copilot, Roo Code e altri tool di usare il Context Harvester direttamente dalla chat"

### Sezione: I 4 layer — cosa attivare

Spiegare i 4 layer con tabella chiara:

| Layer | Cosa fa | Dipendenze extra | Quando usarlo |
|---|---|---|---|
| 1 — Context Harvester | Retrieval semantico per feature | Ollama, Python | Sempre |
| 2 — Functional Analysis | Mappa le funzionalità del progetto | Graphify libs | Una tantum, per progetti grandi |
| 3 — Graph View + Report | Visualizza il knowledge graph | Layer 2 | Per esplorare il codebase |
| 4 — MCP Server | Usa il sistema da Copilot/Roo Code | Layer 1 | Se usi AI assistant in VS Code |

### Sezione: Profili di configurazione

Spiegare il sistema di profili e quando usare quale. Includere i 6 profili preconfigurati (3 laptop + 3 MINISFORUM) con tabella comparativa velocità/qualità.

### Sezione: Profili preconfigurati — Laptop (RTX 1000 Ada)

(contenuto già scritto nel piano v2 — da includere qui)

### Sezione: Profili preconfigurati — MINISFORUM RTX 3090

(contenuto già scritto nel piano v2 — da includere qui)

### Sezione: Setup step-by-step

Wizard testuale con prerequisiti, installazione, prima configurazione, primo index, prima generazione contesto. Ogni step con comando esatto da eseguire.

**Prerequisiti:**
- Python 3.10+
- Node.js 18+
- Ollama installato e in esecuzione
- Modelli Ollama: `ollama pull nomic-embed-text`, `ollama pull qwen3:8b`

**Installazione:**
1. Installa l'estensione da VS Code Marketplace (o da VSIX)
2. Apri il pannello Context Harvester dalla Activity Bar
3. Configura `repoPath` nelle impostazioni
4. Clicca "Rebuild Index" — attendi il completamento
5. Scrivi una feature nel campo input, inserisci CARD ID, clicca "Genera Contesto"

### Sezione: Configurazione avanzata — tutti i settings

Tabella completa di tutti i settings con tipo, default e descrizione.

### Sezione: MCP Server — configurazione per tool

Istruzioni specifiche per:
- **GitHub Copilot in VS Code**: abilitare Layer 4, il file `.vscode/mcp.json` viene generato automaticamente. In Copilot Agent Mode i tool sono disponibili subito.
- **Roo Code**: aggiungere il server MCP nelle impostazioni di Roo Code con URL `http://localhost:3456/mcp`
- **Claude Code**: aggiungere in `.claude/mcp.json`
- **OLLAMA_HOST per MINISFORUM**: istruzioni per esporre Ollama in rete locale (`OLLAMA_HOST=0.0.0.0`) e usare l'IP del MINISFORUM nei profili

### Sezione: FAQ e troubleshooting

- Ollama non raggiungibile → verificare che il processo sia in esecuzione
- Nessun chunk trovato → provare a ridurre i filtri FOCUS o riformulare la feature
- MCP server non risponde → verificare che la porta 3456 sia libera
- Graph View non mostra nodi → eseguire prima Functional Analysis
- Modello non trovato → eseguire `ollama pull {nome_modello}`

---

## Note per l'implementatore

- `graphify_core/` non va installato come pacchetto — i file vengono copiati direttamente nel progetto e adattati per usare solo lo step 1. Mantenere i nomi originali delle funzioni per facilità di aggiornamento futuro.
- Il grafo NetworkX viene salvato sia come `.pkl` (per uso Python) che come `.json` (per la WebView). Il `.pkl` non va versionato (nel `.gitignore`).
- vis.js va incluso come file locale nella WebView, non caricato da CDN — le WebView VS Code non hanno sempre accesso a internet.
- Il MCP server deve gestire richieste concorrenti — più tool call possono arrivare in parallelo da un AI agent. Usare `asyncio` in FastAPI.
- Il `.vscode/mcp.json` generato automaticamente deve essere aggiunto al `.gitignore` del repo dell'utente (contiene localhost — non ha senso condividerlo).
- La validazione delle community (step 2.3) deve sempre essere completata prima che il Layer 2 influenzi il Layer 1 — usare un flag `functionalMapReady: false` in `functional_map.json` fino a validazione completata.
- Per la Graph View, vis.js versione stabile raccomandata: 9.1.x — evitare versioni recenti non testate nelle WebView VS Code.
- Il Graph Report usa solo algoritmi NetworkX standard (betweenness_centrality, isolates, density) — nessuna AI, nessuna dipendenza aggiuntiva.
