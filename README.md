# Context Harvester

Estensione **VS Code / Cursor** che offre una ricerca semantica sul codebase **interamente in locale**, usando [Ollama](https://ollama.com). A partire dalla descrizione di una feature, genera un file Markdown con i frammenti di codice più rilevanti — senza inviare il codice a servizi cloud.

**v3** aggiunge: **Functional Analysis** (knowledge graph + community), **Graph View**, **MCP Server**, integrazione `functional_map.json` nel retrieval.

**v4** migliora il grafo (`name_lookup.json`, riassegnazione unassigned, label-first da linguaggio naturale) e sposta **Graph View** in una **web app locale** su `http://127.0.0.1:3456/` (stessa porta del MCP), con tab Impact, Analisi codebase e Funzionalità.

## I 4 layer (modulari)

| Layer | Cosa fa | Quando usarlo |
|-------|---------|---------------|
| **1 — Context Harvester** | Retrieval semantico per feature | Sempre |
| **2 — Functional Analysis** | Mappa funzionalità del progetto (`functional_map.json`) | Progetti grandi, una tantum |
| **3 — Graph View + Report** | Visualizza il grafo, `GRAPH_REPORT.md` | Esplorare il codebase |
| **4 — MCP Server** | Tool MCP per AI assistant in chat | Se usi Copilot Agent / Roo Code |

## Cosa fa (Layer 1)

1. **Indicizza** il repository: vocabolario, ChromaDB, symbol index.
2. **Query Understanding** — tipo feature, aree, simboli, `related_function` (se Layer 2 validato).
3. **HyDE** + retrieval vettoriale + symbol search + iterativo + grep + re-ranking.
4. **Output** — `{CARD}_context.md` (+ JSON/TXT), fingerprint, confidence opzionale.

## Prerequisiti

- **VS Code** 1.96+ o **Cursor**
- **Python 3.10+**
- **Ollama** in esecuzione

```bash
ollama pull nomic-embed-text
ollama pull qwen3:8b
```

## Installazione (pacchetto release)

Sul PC di sviluppo, genera il pacchetto:

```bat
scripts\build-release-context-harvester.bat
```

Output in `D:\Rilasci\ContextHarvester\<versione>\<timestamp>\`:

- `context-harvester-<versione>.vsix`
- `Installa-su-VSCode.bat` — installa VSIX, venv Python, Ollama e modelli
- `LEGGIMI-RILASCIO.txt`

Sul PC destinazione: copia l’intera cartella e lancia **Installa-su-VSCode.bat**.

Lo script propone anche:

- installazione **Ollama** (se assente)
- download modelli in `..\ContextHarvesterModelli` (variabile `OLLAMA_MODELS`)
- `pip install` di chromadb, ollama, networkx, graspologic, mcp, uvicorn

## Utilizzo rapido

1. Apri il workspace.
2. Sidebar **Context Harvester v3**.
3. **Rebuild Index**.
4. *(Opzionale)* **Rigenera analisi** → **Valida community** → **Apri Graph View**.
5. Feature + CARD ID → **Genera Contesto**.

## Layer 2 — Functional Analysis

1. **Rigenera analisi** — costruisce grafo file→file, clustering Leiden, `functional_map.json`, `graph.json`, `GRAPH_REPORT.md`.
2. **Valida community** — approva/rinomina/escludi le funzionalità candidate.
3. Dopo validazione, `functionalMapReady: true` arricchisce Query Understanding, HyDE e retrieval.

Artefatti in `.context-harvester/`:

```
graphify_graph.pkl
communities_raw.json
functional_map.json
graph.json
GRAPH_REPORT.md
```

## Layer 3 — Graph View (v4 web app)

**Apri Graph View** avvia (se necessario) il server su porta MCP e apre il browser su `http://127.0.0.1:3456/`.

Tab disponibili:

| Tab | Contenuto |
|-----|-----------|
| **Grafo** | vis.js, ricerca, filtro community |
| **Impact** | file impattati per distanza da un nodo |
| **Analisi** | dead code, cicli, hotspot, test gap, funzioni simili, edge API |
| **Funzionalità** | lista `functional_map.json`, **crea da label** |

### Tre modalità per la mappa funzionalità

1. **Clustering Leiden** — community automatiche (`source: leiden`), validazione nel pannello VS Code.
2. **Validazione community** — approva/rinomina/escludi cluster.
3. **Label-first** — scrivi es. `pagina lista contratti` → espansione query (Ollama) → seed + traversal sul grafo → conferma → salva (`source: label-first`). Ha precedenza sui file rispetto a Leiden.

### Artefatti v4 aggiuntivi

```
name_lookup.json      — mapping classe → file
graph_analysis.json   — cache analisi NetworkX
```

### Settings v4

| Setting | Default |
|---------|---------|
| `graph.normalizeNodeNames` | true |
| `graph.reassignUnassigned` | true |
| `graph.labelFirst.traversalDepth` | 2 |
| `graph.labelFirst.maxNodes` | 100 |
| `ollama.labelExpansion.model` | qwen3:4b |
| `webapp.autoOpenBrowser` | true |

## Layer 4 — MCP Server

Abilita in Settings:

- `contextHarvester.enableMcpServer`
- `contextHarvester.mcp.autoStart` (opzionale)
- `contextHarvester.mcp.port` (default `3456`)

Dal pannello: **Avvia MCP**. Viene generato `.vscode/mcp.json` (aggiunto a `.gitignore`).

Tool esposti: `generate_context`, `search_codebase`, `get_function_info`, `get_index_status`, `list_functions`.

**GitHub Copilot (Agent Mode):** il file MCP viene rilevato automaticamente.

**Roo Code / altri:** URL `http://localhost:3456/mcp`

## Profili AI

| Profilo | Uso |
|---------|-----|
| `laptop-balanced` | Raccomandato laptop |
| `laptop-speed` / `laptop-quality` | Velocità vs qualità |
| `minisforum-*` | Server Ollama remoto (RTX 3090) |

## Settings principali

| Setting | Default | Descrizione |
|---------|---------|-------------|
| `enableFunctionalAnalysis` | false | Auto-run analisi se manca functional_map |
| `graph.minCommunitySize` | 3 | Community minime |
| `graph.autoValidate` | false | Salta UI validazione |
| `enableMcpServer` | false | Layer 4 |
| `mcp.port` | 3456 | Porta MCP |
| `enableConfidenceScore` | false | Score 1–10 opzionale |

## Sviluppo

```bash
npm install
npm run compile
```

Scarica vis.js (se manca):

```bat
scripts\download-vis-network.bat
```

Poi **F5** in VS Code.

## Licenza

Uso e modifica liberi; **vietata la rivendita** senza autorizzazione scritta. Vedi [LICENSE](LICENSE).

Piano v3: [context_harvester_plan_v3.md](https://github.com/eiendesu/ContextHarvester/blob/main/documentazione/context_harvester_plan_v3.md)

Repository: [eiendesu/ContextHarvester](https://github.com/eiendesu/ContextHarvester)
