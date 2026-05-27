# Context Harvester Plan v5

## Obiettivo

Questo piano descrive l'evoluzione di Context Harvester verso un modello di analisi a granularità mista, mantenendo la vista attuale a file come livello principale e introducendo un secondo livello di dettaglio per metodi, classi, DTO e endpoint API. L'obiettivo è migliorare l'impact analysis, rendere navigabili le dipendenze frontend-backend e conservare compatibilità con il flusso attuale di reindex e generazione grafo basato su comandi separati.

L'impostazione di partenza, ricavata dallo stack attuale condiviso, è questa:

- Il **reindex** resta il comando che esegue `phase0` + `phase1` + `symbol index`.
- La **Functional Analysis** continua a lanciare `phase_graph` (ed eventualmente `graph_report`) dopo il reindex.
- Oggi il reindex usa ChromaDB, Ollama, chunking sliding-window e un symbol index regex per C#/TS/SQL.
- Oggi il grafo è file-to-file, costruito con NetworkX, clusterizzato con Leiden via graspologic e visualizzato via vis-network.
- `tree-sitter` risulta previsto nelle dipendenze ma non realmente wired nei moduli Python correnti.

## Stato attuale sintetizzato

### Pipeline Reindex

| Area | Stato attuale |
|---|---|
| Orchestrazione | Estensione VS Code / Cursor con comando `rebuild_index` che invoca `python/orchestrator.py` |
| Phase 0 | `phase0_vocabulary.py` estrae vocabolario progetto via regex |
| Phase 1 | ChromaDB locale in `.context-harvester/chroma/` |
| Embedding | Ollama con `nomic-embed-text` |
| Chunking | Sliding window (`chunksize` / `chunkoverlap`) via `common.chunk_text_sliding` |
| Symbol index | `symbol_index.py` con regex su C#/TS/SQL, output `symbol_index.json` |
| Incrementalità | Hash file in `index_meta.json` |
| Storico | `index_timing.py` |

### Pipeline Grafo

| Area | Stato attuale |
|---|---|
| Input | `symbol_index.json` prodotto dal reindex |
| Grafo | NetworkX file-to-file, serializzato anche in pickle |
| Clustering | Leiden via graspologic, fallback Louvain |
| Post-processing | `graph_reassign.py`, `name_lookup.py` |
| AI opzionale | `label_first.py` con Ollama (`qwen3:4b` tipico) |
| Analisi | `graph_analyses.py` per cicli / dead code / hotspot |
| Output | `graph.json`, `functional_map.json`, `graph_analysis.json` |
| Visualizzazione | vis-network in web app HTML + vanilla JS servita via FastAPI + uvicorn |

## Direzione architetturale

L'evoluzione proposta non sostituisce subito il modello attuale: lo estende. La vista a file resta il livello principale perché è già leggibile, stabile e compatibile con i volumi attuali. Sopra questa base viene introdotto un **grafo typed e gerarchico** che abilita drill-down e impact analysis più precisa.

La nuova architettura deve supportare tre modalità di consultazione:

1. **File view**: comportamento attuale, un nodo per file, edge aggregati.
2. **Expanded file view**: click su un file e apertura del dettaglio locale con classi, metodi, DTO e collegamenti verso altri file.
3. **Full detail view**: vista globale con tutti i dettagli di tutti i nodi, attivabile esplicitamente e sempre accompagnata da filtri forti.

## Scelta visualizzazione

La visualizzazione proposta è **Sigma.js** al posto di vis-network per le viste dense. Questa scelta è coerente con l'obiettivo di gestire drill-down e grafi più grandi, mantenendo la fluidità nel rendering lato browser. La vista file-level può anche continuare a convivere inizialmente con l'output attuale, ma il target finale è convergere su un unico viewer Sigma.js.

### Motivazioni pratiche

- vis-network regge la vista a file, ma degrada troppo su granularità a metodo.
- Sigma.js è più adatto a rendering GPU/WebGL e quindi a grafi grandi.
- L'applicazione non deve eseguire algoritmi grafici complessi nel browser; il frontend deve soprattutto filtrare, esplodere nodi e navigare.
- La UX richiesta (click sul file, apertura dettaglio, vista full detail globale) è più naturale con un modello di subgraph dinamico.

## Modello dati proposto

Il grafo deve passare da un modello implicito file-to-file a un modello esplicito di nodi e relazioni tipizzate.

### Tipi di nodo

- `file`
- `class`
- `method`
- `dto`
- `api_client_file`
- `api_client_method`
- `api_endpoint`
- `namespace` (opzionale, utile per grouping futuro)

### Tipi di edge

- `contains` — relazione gerarchica file → classe → metodo / dto
- `calls` — chiamata tra metodi
- `imports` — import frontend / dipendenza esplicita
- `references` — uso di simbolo senza invocazione diretta
- `instantiates` — creazione oggetto
- `serializes`
- `deserializes`
- `http_calls` — metodo frontend che chiama un endpoint HTTP
- `served_by` — endpoint HTTP servito da una action backend
- `maps_to_file` — edge aggregato metodo → file o endpoint → file quando serve risalire alla vista alta

### Attributi minimi per nodo

| Campo | Descrizione |
|---|---|
| `id` | identificatore stabile |
| `type` | tipo nodo |
| `label` | label visualizzata |
| `qualifiedName` | nome completo simbolico |
| `filePath` | file sorgente |
| `lineStart` / `lineEnd` | posizione |
| `language` | `csharp`, `typescript`, `sql`, ecc. |
| `parentId` | nodo gerarchico padre |
| `visibility` | public/private/internal se disponibile |

### Attributi minimi per edge

| Campo | Descrizione |
|---|---|
| `source` | nodo sorgente |
| `target` | nodo destinazione |
| `type` | tipo edge |
| `weight` | peso aggregato o frequenza |
| `confidence` | affidabilità match |
| `origin` | parser / regola che lo ha prodotto |

## Evoluzione del reindex

Il reindex resta separato dal grafo, ma deve produrre più informazione strutturata. La modifica principale è trasformare il symbol index da regex-only a pipeline mista.

### Strategia parser

- **C# backend**: usare Roslyn come parser principale per controller, action, classi, metodi, attributi, DTO e riferimenti basilari.
- **TypeScript frontend**: usare TypeScript Compiler API oppure Tree-sitter TS come parser strutturale per import, export, funzioni API, chiamate fetch/axios e template string.
- **Regex**: mantenere come fallback per file non supportati o pattern legacy.

### Output nuovi del reindex

Il reindex dovrebbe produrre, oltre agli artefatti attuali, questi file intermedi:

| File | Contenuto |
|---|---|
| `symbol_index_v2.json` | simboli tipizzati e gerarchici |
| `api_client_index.json` | funzioni API frontend con verbo, route, file, parametri |
| `backend_route_index.json` | controller/action ASP.NET con route normalizzate |
| `entity_index.json` | DTO, model e oggetti rilevanti |
| `file_symbol_map.json` | mapping file ↔ simboli contenuti |

## Evoluzione della phase graph

La phase graph continua a partire dagli artefatti del reindex, ma non costruisce più solo edge file-to-file. Costruisce prima il grafo typed fine-grained e poi deriva la vista aggregata file-level.

### Nuovo flusso proposto

1. Carica `symbol_index_v2.json`, `api_client_index.json`, `backend_route_index.json`.
2. Costruisce il grafo fine-grained completo.
3. Applica regole di deduplica e normalizzazione simboli.
4. Calcola il grafo aggregato file-level derivando i pesi dagli edge dei nodi interni.
5. Applica clustering sul livello file e, opzionalmente, su subgraph locali.
6. Produce artefatti per viewer e analisi.

### Artefatti output proposti

| File | Scopo |
|---|---|
| `graph_file.json` | vista aggregata file-level |
| `graph_detail.json` | grafo completo typed |
| `graph_expansion_index.json` | mappa file → nodi/edge di dettaglio da espandere |
| `api_links.json` | connessioni frontend ↔ endpoint ↔ backend |
| `impact_index.json` | indice per ricerca e impact analysis |

## Impact analysis

La nuova impact analysis deve essere calcolata su nodi di dettaglio, non solo su file. La vista a file diventa una proiezione riassuntiva, mentre le query di impatto lavorano sul grafo fine-grained.

### Query target da supportare

- dato un **metodo**, trovare chiamanti, chiamati, file impattati, endpoint connessi
- dato un **DTO**, trovare serializzazioni, deserializzazioni, mapper e action coinvolte
- dato un **api client method**, trovare componenti chiamanti e action backend servente
- dato un **endpoint**, trovare frontend consumer e backend implementation
- dato un **file**, mostrare impatto aggregato e dettaglio interno

### Profondità e modalità

L'impact analysis dovrebbe supportare:

- `direct` — solo vicini di primo livello
- `transitive` — attraversamento multi-hop con depth limit
- `upstream` — chi impatta il nodo
- `downstream` — cosa viene impattato dal nodo
- `cross-layer` — solo relazioni frontend ↔ backend ↔ DTO

## Matching API type 2

Questo è il caso prioritario dichiarato: frontend con file/funzioni API che incapsulano fetch/axios, backend ASP.NET con attributi standard `[HttpGet]`, `[HttpPost]`, `[Route]`.

### Catena logica da costruire

```text
FrontendComponent
  -> imports -> ApiClientFile
  -> calls -> ApiClientMethod
  -> http_calls -> ApiEndpoint
  -> served_by -> BackendControllerAction
```

### Estrazione frontend

Per ogni file API TypeScript:

1. identificare funzioni esportate;
2. rilevare client usato (`fetch`, `axios`, wrapper interno);
3. estrarre verbo HTTP;
4. estrarre URL/template string;
5. normalizzare i segmenti dinamici;
6. registrare chiamanti tramite import graph + usage.

### Estrazione backend

Per ogni controller ASP.NET:

1. rilevare attributi di classe (`[Route]`, `[ApiController]`);
2. rilevare attributi di metodo (`[HttpGet]`, `[HttpPost]`, `[HttpPut]`, `[HttpDelete]`, `[Route]`);
3. combinare route controller + route action;
4. espandere placeholder come `[controller]` e `[action]`;
5. normalizzare la route finale.

### Normalizzazione route

Esempi:

- `/api/contracts/${id}` → `/api/contracts/{param}`
- `/api/contracts/${contractId}/lead` → `/api/contracts/{param}/lead`
- `api/[controller]` su `ContractsController` → `api/contracts`
- `[HttpPost("lead")]` su controller `api/contracts` → `POST /api/contracts/lead`

### Regole di matching

| Regola | Peso |
|---|---|
| Verbo HTTP identico | alto |
| Segmenti statici identici | alto |
| Placeholder dinamici compatibili | medio |
| Lunghezza route compatibile | medio |
| Match solo naming convention | basso |

### Confidenza suggerita

| Scenario | Confidence |
|---|---|
| Match esatto verbo + route normalizzata | 1.0 |
| Match con placeholder equivalenti | 0.9 |
| Match con wrapper o base path risolto | 0.75 |
| Match inferito solo da naming | 0.4 |

Il matching inferito da naming non deve essere trattato come edge certo. Deve essere visibile nel viewer come relazione probabile o suggerita.

## UX del viewer

### Modalità 1 — File view

Comportamento equivalente all'attuale:

- un nodo per file;
- edge aggregati tra file;
- clustering visibile;
- ricerca file;
- click su nodo per passare alla expanded file view.

### Modalità 2 — Expanded file view

Quando l'utente clicca un file:

- il file selezionato resta nodo principale;
- si espandono classi, metodi, DTO, funzioni API contenute;
- si mostrano i collegamenti in uscita e in entrata verso elementi esterni;
- i file esterni restano collassati, salvo il nodo di raccordo necessario alla leggibilità.

Questa modalità è il cuore del prodotto perché combina dettaglio e leggibilità.

### Modalità 3 — Full detail view

La vista globale a dettaglio completo va supportata, ma con guardrail forti:

- ricerca obbligatoria o filtri preattivi;
- filtro per tipo nodo;
- limite di profondità;
- soglia edge weight;
- focus mode su un solo nodo e intorno;
- toggle per mostrare/nascondere DTO, API, metodi privati.

Senza questi controlli la vista perde utilità pratica anche se la libreria regge tecnicamente il rendering.

## Compatibilità con pipeline attuale

Questa evoluzione deve essere incrementale.

### Fase compatibile immediata

- lasciare invariati `rebuild_index` e `phase_graph` come entrypoint;
- aggiungere feature flag `v2_symbols`, `v2_api_matching`, `sigma_viewer`;
- continuare a generare `graph.json` file-level per non rompere la UI attuale;
- generare in parallelo i nuovi artefatti v2.

### Strategia di transizione

| Fase | Obiettivo |
|---|---|
| 5.1 | Generare `symbol_index_v2.json` mantenendo `symbol_index.json` |
| 5.2 | Generare `backend_route_index.json` e `api_client_index.json` |
| 5.3 | Costruire `graph_detail.json` e derivare `graph_file.json` |
| 5.4 | Introdurre Sigma.js con file view + expanded file view |
| 5.5 | Abilitare full detail view |
| 5.6 | Introdurre impact analysis avanzata e query dedicate |

## Piano implementativo per milestone

### Milestone 1 — Data model e parser backend

Obiettivo: introdurre modello typed e parsing affidabile del backend.

Deliverable:
- schema JSON v2 per nodi/edge;
- parser Roslyn per controller/action/route/classi/metodi;
- `backend_route_index.json`;
- primi test su route standard ASP.NET.

### Milestone 2 — Parser frontend API

Obiettivo: estrarre in modo strutturato il layer API TypeScript.

Deliverable:
- parser TS per import/export/funzioni API;
- supporto fetch/axios/template string;
- `api_client_index.json`;
- primo import graph per caller mapping.

### Milestone 3 — Matching frontend/backend

Obiettivo: costruire gli edge API cross-layer.

Deliverable:
- motore di route normalization;
- matching con score di confidenza;
- `api_links.json`;
- visualizzazione distinta per edge certi e probabili.

### Milestone 4 — Graph builder v2

Obiettivo: costruire il grafo fine-grained e derivare la vista aggregata.

Deliverable:
- `graph_detail.json`;
- `graph_file.json` derivato;
- `graph_expansion_index.json`;
- impatto base su metodo / DTO / endpoint.

### Milestone 5 — Sigma viewer

Obiettivo: sostituire progressivamente la visualizzazione attuale.

Deliverable:
- file view Sigma.js;
- expanded file view con click su nodo;
- ricerca multi-tipo;
- pannello dettaglio nodo;
- performance tuning su grafi reali.

### Milestone 6 — Full detail e impact analysis avanzata

Obiettivo: abilitare vista globale dettagliata e query operative.

Deliverable:
- full detail view con filtri;
- upstream/downstream analysis;
- cross-layer impact;
- evidenziazione percorsi tra component, API client, endpoint e action backend.

## Rischi e mitigazioni

| Rischio | Impatto | Mitigazione |
|---|---|---|
| Parsing C# fragile con regex | alto | usare Roslyn come fonte primaria |
| URL frontend troppo dinamiche | medio | fallback a confidence bassa + analisi opzionale AI |
| Full detail view troppo rumorosa | alto | filtri obbligatori e focus mode |
| Costi complessità pipeline | medio | rollout incrementale con artefatti paralleli |
| Rottura compatibilità viewer attuale | medio | mantenere `graph.json` legacy per transizione |

## Uso opzionale dell'AI

L'AI non deve essere nel percorso critico del matching API. Va usata solo come supporto nei casi ambigui:

- path costruiti indirettamente;
- wrapper multipli che nascondono il verbo o la route;
- naming convention dove il path non compare mai esplicitamente;
- suggerimenti di label o cluster explanation.

Gli edge prodotti dall'AI devono avere `confidence` bassa/media e visualizzazione distinta.

## Decisioni consigliate

1. Mantenere **reindex** e **phase_graph** come pipeline separate anche in v5.
2. Tenere la vista **file-level** come default UX.
3. Introdurre **expanded file view** come esperienza principale di analisi.
4. Implementare la **full detail view** solo con filtri e focus mode.
5. Usare **Roslyn** per C# e parser strutturato per TypeScript.
6. Implementare subito il matching API **type 2** in modo deterministico.
7. Usare l'AI solo come supporto per casi non risolvibili staticamente.
8. Migrare il viewer verso **Sigma.js** come target finale.

## Risultato atteso

A fine v5, Context Harvester deve consentire di:

- vedere il panorama generale della codebase per file;
- cliccare un file e scendere ai suoi metodi, oggetti e API correlate;
- cercare un metodo, DTO o endpoint e ottenere l'impatto reale;
- collegare un componente frontend alla sua funzione API, all'endpoint HTTP e alla action backend che lo serve;
- distinguere relazioni certe da relazioni inferite.

Questo porta il sistema da una mappa file-to-file utile per orientamento a una piattaforma di impact analysis realmente operativa per refactoring, debugging e change assessment cross-layer.
