# Context Harvester — Piano di Implementazione v4

Questo documento estende il Piano v3 con miglioramenti specifici al knowledge graph e alla Functional Analysis, emersi dall'analisi del grafo reale generato su EnergyDeal.

Problemi osservati sul grafo reale:
- Molti nodi "unassigned" — Leiden non riesce ad assegnarli a una community
- Nomi dei nodi costruiti dal path del file invece che dal nome della classe — gli edge non vengono creati correttamente
- Il clustering automatico produce community troppo tecniche e granulari, non funzionalità semantiche

Soluzioni implementate in v4:
- Approccio 1: Normalizzazione nomi nodi (prerequisito di tutto)
- Approccio 2: Soglia minima Leiden per ridurre unassigned
- Approccio 3: Modalità label-first con AI query expansion per definire funzionalità in linguaggio naturale

---

## Approccio 1 — Normalizzazione nomi nodi

### Problema
I nodi nel grafo sono identificati dal path del file trasformato in stringa, es:
`leadservice-energydeal-backend-energydeal-api-server-models-lead-getleadswithpaginationresponse-cs`

Quando l'AST di `ContractService.cs` trova una chiamata a `new LeadService()`, cerca un nodo chiamato `LeadService` — ma nel grafo quel nodo si chiama con il path lungo. L'edge non viene creato, il nodo rimane disconnesso, Leiden lo mette in "unassigned".

### Soluzione
Durante la fase di build del grafo (`phase_graph.py`), costruire una **lookup table** che mappa ogni variante del nome al corretto id nodo.

**Script:** aggiunta a `python/graphify_core/build_graph.py` e `python/phase_graph.py`

**Processo:**

Step 1 — Per ogni file nel repo, estrarre il nome "canonico" della classe/componente principale:
```python
# Per file .cs
# "src/Services/LeadService.cs" → classe principale → "LeadService"
# Regex: class\s+(\w+) nel file → prende il primo match

# Per file .tsx/.ts
# "src/Components/LeadList.tsx" → "LeadList"
# Regex: export\s+(default\s+)?function\s+(\w+) o export\s+const\s+(\w+)

# Per file .sql
# "schema.sql" → tabelle: "Contract.Lead", "Contract.EntityLead"
```

Step 2 — Costruire lookup table:
```python
name_lookup = {
    # path-based id → class name
    "leadservice-energydeal-backend-...": "LeadService",
    # varianti → stesso nodo
    "LeadService": "leadservice-energydeal-backend-...",
    "leadservice": "leadservice-energydeal-backend-...",
    "ILeadService": "leadservice-energydeal-backend-...",  # interfaccia → implementazione
}
```

Step 3 — Durante la creazione degli edge, risolvere i nomi:
```python
def resolve_node_id(name: str, lookup: dict) -> str | None:
    # prova match esatto
    if name in lookup:
        return lookup[name]
    # prova lowercase
    if name.lower() in lookup:
        return lookup[name.lower()]
    # prova partial match (per generics: List<LeadService> → LeadService)
    for key in lookup:
        if name in key or key in name:
            return lookup[key]
    return None  # nodo non trovato nel repo — dipendenza esterna, ignorata
```

Step 4 — Aggiornare il `graph.json` con label leggibili:
```json
{
  "nodes": [
    {
      "id": "leadservice-energydeal-backend-...",
      "label": "LeadService",           ← nome breve per la UI
      "fullPath": "src/Services/LeadService.cs",
      "className": "LeadService",
      "group": "unassigned"
    }
  ]
}
```

**Output:**
- `name_lookup.json` salvato in `.context-harvester/` — usato anche dal Symbol Index del Layer 1
- Grafo rieseguito con edge corretti → drastica riduzione degli unassigned
- Label brevi nei nodi del grafo vis.js → molto più leggibile

**AI:** ❌ nessuna
**Quando eseguire:** durante `phase_graph.py`, prima del clustering Leiden
**Nota:** `name_lookup.json` viene riusato dal Symbol Index della v2 — non serve costruirlo due volte

---

## Approccio 2 — Soglia minima Leiden per ridurre unassigned

### Problema
Nodi con poche connessioni (es. modelli DTO, utility class) rimangono unassigned perché Leiden non trova una community sufficientemente densa per includerli.

### Soluzione
Post-processing del risultato Leiden: i nodi unassigned vengono riassegnati alla community del loro vicino più connesso.

**Script:** aggiunta a `python/phase_graph.py`

**Processo:**
```python
def reassign_unassigned(graph: nx.Graph, communities: dict) -> dict:
    unassigned = [n for n, c in communities.items() if c == "unassigned"]

    for node in unassigned:
        neighbors = list(graph.neighbors(node))
        if not neighbors:
            continue  # nodo veramente isolato — rimane unassigned

        # trova il vicino con più connessioni (più probabile che appartenga
        # a una community significativa)
        best_neighbor = max(neighbors, key=lambda n: graph.degree(n))
        neighbor_community = communities.get(best_neighbor)

        if neighbor_community and neighbor_community != "unassigned":
            communities[node] = neighbor_community

    return communities
```

**Configurazione:**
```jsonc
"contextHarvester.graph.reassignUnassigned": true,   // default true
"contextHarvester.graph.minDegreeForReassign": 1,    // riassegna se ha almeno 1 edge
```

**Risultato atteso:** riduzione degli unassigned dall'attuale ~30-40% a meno del 5% (solo nodi veramente isolati senza nessuna connessione rilevata).

**AI:** ❌ nessuna

---

## Approccio 3 — Modalità Label-First con AI Query Expansion

### Panoramica

Modalità alternativa alla validazione delle community Leiden. Invece di partire dai cluster automatici e approvarli, l'utente **parte da un nome in linguaggio naturale** e il sistema trova tutti i nodi del grafo correlati.

Esempio: l'utente scrive "pagina lista contratti" → il sistema evidenzia nel grafo tutti i nodi collegati a quella funzionalità → l'utente conferma → la funzionalità viene salvata in `functional_map.json`.

### Flusso completo

```
Input: "pagina lista contratti"
        │
        ▼
[STEP 1 — AI Query Expansion]  ← qwen3:4b
  Estrae termini tecnici dall'input naturale
        │
        ▼
[STEP 2 — Seed Finding]  ← no AI
  Matching termini → nodi del grafo
        │
        ▼
[STEP 3 — Graph Traversal]  ← no AI
  Espande dai seed per N livelli
        │
        ▼
[STEP 4 — UI Conferma]
  Utente vede nodi evidenziati, aggiunge/rimuove
        │
        ▼
[STEP 5 — Salvataggio]
  functional_map.json aggiornato
```

### Step 1 — AI Query Expansion

**Modello:** configurabile (`contextHarvester.ollama.labelExpansion.model`, default `qwen3:4b`)

**Prompt:**
```
Sei un assistente che analizza codebase software.
Dato un input in linguaggio naturale che descrive una funzionalità,
estrai i termini tecnici che potrebbero identificarla nel codice.

Vocabolario del progetto (classi, componenti, tabelle note):
{project_vocabulary_summary}  ← top 100 termini più frequenti dal vocabulary

Input: "{input_utente}"

Restituisci SOLO un oggetto JSON valido:
{
  "terms_it": ["termine1", "termine2"],
  "terms_en": ["term1", "term2"],
  "class_patterns": ["NomeClasse", "AltroNome"],
  "file_patterns": ["pattern-nel-path"],
  "table_patterns": ["Schema.Tabella"]
}

Esempi:
Input: "pagina lista contratti"
Output: {"terms_it": ["contratto", "lista", "paginazione"],
         "terms_en": ["contract", "list", "pagination"],
         "class_patterns": ["ContractList", "ContractPage", "GetContracts"],
         "file_patterns": ["contractlist", "contractpage", "contracts"],
         "table_patterns": []}

Input: "gestione lead e disqualifica"
Output: {"terms_it": ["lead", "disqualifica", "motivazione"],
         "terms_en": ["lead", "disqualification", "motivation"],
         "class_patterns": ["LeadService", "DisqualificationModal", "LeadList"],
         "file_patterns": ["lead", "disqualif"],
         "table_patterns": ["Contract.Lead", "Contract.EntityLead"]}
```

**Fallback:** se il modello non risponde con JSON valido, usa l'input diretto come termine di ricerca (split per parole, ricerca stringa semplice).

### Step 2 — Seed Finding

**Input:** output JSON dello step 1 + grafo NetworkX + `name_lookup.json`

**Processo:**
```python
def find_seed_nodes(expansion: dict, graph: nx.Graph, name_lookup: dict) -> list:
    seeds = []

    # Matching su class_patterns (più preciso)
    for pattern in expansion["class_patterns"]:
        node_id = resolve_node_id(pattern, name_lookup)
        if node_id and node_id in graph:
            seeds.append(node_id)

    # Matching su file_patterns (più ampio)
    for node_id in graph.nodes:
        node_data = graph.nodes[node_id]
        file_path = node_data.get("fullPath", "").lower()
        for pattern in expansion["file_patterns"]:
            if pattern.lower() in file_path:
                seeds.append(node_id)
                break

    # Matching su table_patterns per nodi SQL
    for pattern in expansion["table_patterns"]:
        node_id = resolve_node_id(pattern, name_lookup)
        if node_id and node_id in graph:
            seeds.append(node_id)

    # Matching su terms_en e terms_it come fallback
    if not seeds:
        all_terms = expansion["terms_en"] + expansion["terms_it"]
        for node_id in graph.nodes:
            label = graph.nodes[node_id].get("label", "").lower()
            for term in all_terms:
                if term.lower() in label:
                    seeds.append(node_id)
                    break

    return list(set(seeds))  # deduplicazione
```

### Step 3 — Graph Traversal

**Input:** lista seed nodes + grafo NetworkX

**Processo:**
```python
def traverse_from_seeds(
    seeds: list,
    graph: nx.Graph,
    depth: int = 2,        # configurabile
    max_nodes: int = 100   # limite per evitare esplosione
) -> list:

    visited = set(seeds)
    frontier = set(seeds)

    for level in range(depth):
        new_frontier = set()
        for node in frontier:
            # segui edge in uscita (cosa chiama questo nodo)
            for neighbor in graph.successors(node):
                if neighbor not in visited:
                    new_frontier.add(neighbor)
            # segui edge in entrata (chi chiama questo nodo)
            # solo al primo livello — evita esplosione combinatoria
            if level == 0:
                for neighbor in graph.predecessors(node):
                    if neighbor not in visited:
                        new_frontier.add(neighbor)

        visited.update(new_frontier)
        frontier = new_frontier

        if len(visited) >= max_nodes:
            break

    return list(visited)
```

**Configurazione:**
```jsonc
"contextHarvester.graph.labelFirst.traversalDepth": 2,
"contextHarvester.graph.labelFirst.maxNodes": 100,
```

### Step 4 — UI nel Graph View

Nella WebView del grafo, nuova sezione in alto:

```
┌─────────────────────────────────────────────────────┐
│  CREA FUNZIONALITÀ DA LABEL                         │
│                                                     │
│  [pagina lista contratti              ] [🔍 Cerca]  │
│                                                     │
│  [se in elaborazione:]                              │
│  🔄 Espansione query... → 🔄 Ricerca nodi...        │
│                                                     │
│  [se trovato:]                                      │
│  ✅ Trovati 47 nodi per "pagina lista contratti"    │
│                                                     │
│  Nome funzionalità: [Pagina Lista Contratti    ]    │
│                                                     │
│  Nodi inclusi (evidenziati nel grafo):              │
│  ┌─────────────────────────────────────────────┐   │
│  │ ● ContractListPage.tsx              [- Rimuovi] │
│  │ ● ContractListService.cs            [- Rimuovi] │
│  │ ● GetContractsWithPagination.cs     [- Rimuovi] │
│  │ ● ContractFilters.tsx               [- Rimuovi] │
│  │ ...                                             │
│  └─────────────────────────────────────────────┘   │
│  [+ Aggiungi nodo manualmente]                      │
│                                                     │
│  Profondità traversal: [2 ▼]  Max nodi: [100]      │
│                                                     │
│  [✅ Salva come funzionalità]  [✕ Annulla]         │
└─────────────────────────────────────────────────────┘
```

**Comportamento visivo nel grafo:**
- Nodi trovati: evidenziati con bordo spesso nel colore della funzionalità
- Nodi non trovati: opacity ridotta a 0.2
- Click su nodo non evidenziato: lo aggiunge alla selezione corrente
- Click su nodo evidenziato: lo rimuove dalla selezione
- Il grafo si aggiorna in tempo reale mentre si aggiungono/rimuovono nodi

### Step 5 — Salvataggio

Alla conferma, il sistema:
1. Crea una nuova entry in `functional_map.json` con `validated: true` e `source: "label-first"`
2. Ricolora i nodi nel grafo con il colore assegnato alla funzionalità
3. Aggiorna il dropdown Community/Funzione con la nuova funzionalità
4. I nodi che appartenevano a "unassigned" vengono rimossi da unassigned

---

## Coesistenza Label-First e Leiden

Le due modalità non si escludono — si complementano:

```
Leiden clustering (automatico)
    ↓
Community tecniche/granulari → utente valida quelle utili

Label-first (manuale)
    ↓
Funzionalità semantiche → utente definisce in linguaggio naturale

functional_map.json
    contiene entrambi i tipi:
    - source: "leiden"    → validata dal clustering automatico
    - source: "label-first" → definita dall'utente
```

Un nodo può appartenere a una sola funzionalità. Se un nodo è già assegnato da Leiden e viene incluso in una funzionalità label-first, la funzionalità label-first ha la precedenza (l'utente ha esplicitamente scelto).

---

## Aggiornamento `functional_map.json`

```json
{
  "functions": [
    {
      "id": "pagina-lista-contratti",
      "name": "Pagina Lista Contratti",
      "source": "label-first",        ← NUOVO campo
      "labelInput": "pagina lista contratti",  ← input originale utente
      "validated": true,
      "manuallyEdited": false,
      "traversalDepth": 2,
      "nodes": [...],
      "terms": {...}
    },
    {
      "id": "lead-management",
      "name": "Lead Management",
      "source": "leiden",             ← da clustering automatico
      "validated": true,
      ...
    }
  ]
}
```

---

## Aggiornamento `name_lookup.json`

Nuovo file in `.context-harvester/`:

```json
{
  "byClassName": {
    "LeadService": "leadservice-energydeal-backend-energydeal-api-server-...",
    "ContractListPage": "contractlistpage-energydeal-frontend-...",
    "ILeadDal": "lead-energydeal-backend-energydeal-common-dal-..."
  },
  "byPathFragment": {
    "lead/getleadswithpaginationresponse": "leadservice-energydeal-...",
    "contractvalidation/gassaleselectricity": "defaultelectricitydatavalidator-..."
  },
  "interfaces": {
    "ILeadDal": "LeadDal"   ← interfaccia → implementazione concreta
  }
}
```

---

## Settings aggiornati — v4

```jsonc
// ── Graph — Normalizzazione ───────────────────────
"contextHarvester.graph.normalizeNodeNames": true,   // Approccio 1

// ── Graph — Leiden post-processing ───────────────
"contextHarvester.graph.reassignUnassigned": true,   // Approccio 2
"contextHarvester.graph.minDegreeForReassign": 1,

// ── Graph — Label-First ───────────────────────────
"contextHarvester.graph.labelFirst.traversalDepth": 2,
"contextHarvester.graph.labelFirst.maxNodes": 100,
"contextHarvester.ollama.labelExpansion.url": "http://localhost:11434",
"contextHarvester.ollama.labelExpansion.model": "qwen3:4b",
```

---

## Aggiornamento struttura file

```
.context-harvester/
├── ...                         (invariato da v3)
├── name_lookup.json            ← NUOVO — mapping nomi classi → id nodi
├── graphify_graph.pkl          ← aggiornato con edge corretti (Approccio 1)
├── graph.json                  ← aggiornato con label brevi leggibili
├── communities_raw.json        ← aggiornato con meno unassigned (Approccio 2)
└── functional_map.json         ← aggiornato con source label-first/leiden
```

---

## Ordine di implementazione v4

Da aggiungere dopo lo step 26 del piano v3:

27. **`name_lookup.json`** — costruzione lookup table classe→nodo durante `phase_graph.py`. Prerequisito di tutto il resto.
28. **Risoluzione edge con lookup** — aggiornamento `graphify_core/build_graph.py` per usare la lookup table durante la creazione degli edge. Rigenera il grafo.
29. **Label brevi in `graph.json`** — aggiornamento serializzazione per vis.js: label = nome classe, non path.
30. **Approccio 2 — Post-processing Leiden** — funzione `reassign_unassigned()` in `phase_graph.py`, eseguita dopo il clustering.
31. **AI Query Expansion per label-first** — `python/phase_label_expansion.py` con prompt e fallback.
32. **Seed finding** — `python/phase_label_seeds.py` con matching multi-strategia.
33. **Graph traversal** — `python/phase_label_traversal.py` con depth configurabile.
34. **UI label-first nel Graph View** — nuova sezione nella WebView con campo input, lista nodi trovati, aggiunta/rimozione manuale.
35. **Comportamento visivo** — highlighting nodi trovati, opacity ridotta per gli altri, click per aggiungere/rimuovere.
36. **Salvataggio in `functional_map.json`** con campo `source: "label-first"`.
37. **Coesistenza Leiden + label-first** — gestione priorità se un nodo appartiene a entrambi.
38. **Aggiornamento README** con spiegazione delle tre modalità di creazione funzionalità.

---

## Aggiornamento README — sezione Functional Analysis

Aggiungere al README una sezione che spiega le tre modalità disponibili per costruire la mappa delle funzionalità:

### Modalità 1 — Clustering automatico (Leiden)
Il sistema analizza le connessioni tra file e raggruppa automaticamente quelli che lavorano insieme. Produce una lista di community candidate che l'utente valida nel Graph View. Ideale come punto di partenza — dà una prima mappa del progetto in pochi minuti.

### Modalità 2 — Validazione community
Dopo il clustering, ogni community viene presentata con i suoi nodi principali. L'utente approva, rinomina, unisce o esclude le community. Il risultato è una mappa pulita e significativa.

### Modalità 3 — Label-First
L'utente scrive il nome di una funzionalità in linguaggio naturale ("pagina lista contratti", "flusso di firma digitale"). Il sistema espande la query con AI, trova i nodi del grafo correlati, e li evidenzia per conferma. Ideale per funzionalità che il clustering automatico non ha identificato correttamente, o per utenti che preferiscono definire le funzionalità dall'alto verso il basso invece che dal basso verso l'alto.

Le tre modalità si usano insieme — il clustering dà la struttura di base, label-first completa con le funzionalità semantiche che l'algoritmo non riesce a trovare da solo.

---

---

## Cambio architetturale — Graph View come Web App locale

### Motivazione

La WebView embedded in VS Code ha limitazioni concrete per un grafo con 2000+ nodi:
- Larghezza fissa, non ridimensionabile liberamente
- Impossibile aprire su secondo monitor
- Performance degradata con grafi grandi
- Impossibile avere tab multipli aperti contemporaneamente
- Nessun layout complesso (pannelli side-by-side, resize, ecc.)

Il Graph View e tutte le analisi correlate (impact analysis, dead code, hotspot, ecc.) vengono spostate in una **web app locale** servita dal MCP server già presente.

### Architettura

Il MCP server FastAPI (porta 3456, già presente dal piano v3) viene esteso con route aggiuntive:

```
MCP Server (FastAPI, porta 3456)
    ├── /mcp                    ← tool MCP per Copilot/Roo Code/Claude Code
    ├── /                       ← Graph Web App (SPA)
    ├── /api/graph              ← dati grafo JSON
    ├── /api/graph/impact       ← impact analysis
    ├── /api/graph/analysis     ← dead code, circular deps, hotspot, ecc.
    ├── /api/graph/label-first  ← query expansion + seed finding + traversal
    ├── /api/functions          ← functional_map.json CRUD
    ├── /api/functions/validate ← salva validazione community
    └── /ws/graph               ← websocket per risultati in tempo reale
```

**Frontend della web app:** HTML + vanilla JS + vis.js (nessun framework — mantieni semplicità)

**Apertura dal pannello VS Code:**
```typescript
// Bottone "Apri Graph View" nel pannello principale e nel Lab
vscode.env.openExternal(vscode.Uri.parse('http://localhost:3456'));
```

Si apre nel browser di sistema. L'utente può metterlo su secondo monitor, aprire più tab, usare i bookmark del browser.

**Nota:** se il MCP server non è avviato quando si clicca il bottone, l'estensione lo avvia automaticamente prima di aprire il browser.

### Struttura file web app

```
python/
└── webapp/
    ├── static/
    │   ├── vis-network.min.js    ← vis.js incluso localmente (no CDN)
    │   ├── app.css
    │   └── app.js                ← logica SPA
    └── templates/
        └── index.html            ← shell HTML, tutto il resto via JS
```

### Websocket per risultati in tempo reale

Per operazioni lente (label-first expansion, impact analysis su grafi grandi), il server streamma i risultati via websocket invece di bloccare la risposta HTTP:

```python
# FastAPI websocket endpoint
@app.websocket("/ws/graph")
async def websocket_graph(websocket: WebSocket):
    await websocket.accept()
    async for message in websocket.iter_json():
        if message["action"] == "label_first":
            async for result in label_first_stream(message["input"]):
                await websocket.send_json(result)
        elif message["action"] == "impact":
            result = compute_impact(message["node_id"])
            await websocket.send_json(result)
```

Il frontend mostra risultati progressivi mentre arrivano — stessa UX del pannello VS Code con gli eventi JSON stdout.

---

## Web App — struttura con tab

La web app ha 4 tab principali accessibili dalla navbar in alto:

```
┌──────────────────────────────────────────────────────────────┐
│  🌾 Context Harvester — Graph View          v0.3.0           │
├──────────┬──────────────┬──────────────┬────────────────────-┤
│  🗺 Grafo │  ⚡ Impact   │  🔍 Analisi  │  🏷 Funzionalità   │
└──────────┴──────────────┴──────────────┴─────────────────────┘
```

---

### Tab 1 — Grafo

Visualizzazione vis.js del knowledge graph. Equivalente di quello che esiste già, ma con più spazio e performance migliori.

**Controlli:**
```
┌──────────────────────────────────────────────────────────────┐
│  🔍 [Ricerca nodo o simbolo...          ]                    │
│                                                              │
│  Community/Funzione: [Tutte ▼]                               │
│  Tipo: [☑ C#] [☑ TypeScript] [☑ SQL]                        │
│  Edge: [☑ EXTRACTED] [☐ INFERRED]                            │
│  [Reset zoom]  [Fit all]                                     │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  [vis.js grafo interattivo — tutto lo spazio disponibile]   │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  Nodo selezionato: LeadService                               │
│  File: src/Services/LeadService.cs                           │
│  Community: Lead Management  │  Connessioni: 12 out / 4 in  │
│  [📄 Info]  [⚡ Impact]  [🔍 Usa come seed retrieval]       │
└──────────────────────────────────────────────────────────────┘
```

**"Usa come seed retrieval":** apre una nuova tab del browser su `http://localhost:3456/?seed=LeadService` che pre-popola il campo feature input con il simbolo selezionato e lancia direttamente il retrieval nel context harvester — senza dover tornare al pannello VS Code.

---

### Tab 2 — Impact Analysis

**Scopo:** "se modifico X, quali altri file potrebbero essere impattati?"

```
┌──────────────────────────────────────────────────────────────┐
│  ⚡ Impact Analysis                                          │
│                                                              │
│  Se modifico:  [GZipHelper              ] [🔍 Analizza]     │
│                                                              │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                              │
│  📊 Riepilogo                                                │
│  Impattati diretti  (dist. 1):  8 file                      │
│  Impattati indiretti (dist. 2): 23 file                     │
│  Impattati indiretti (dist. 3): 41 file                     │
│  Totale raggiungibili:          72 file                     │
│                                                              │
│  Mostra fino a distanza: [3 ▼]                              │
│                                                              │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                              │
│  🔴 Distanza 1 — impatto diretto                            │
│  ● ContractService.cs          [📄 Apri nel grafo]          │
│  ● LeadService.cs              [📄 Apri nel grafo]          │
│  ● OCRService.cs               [📄 Apri nel grafo]          │
│  ...                                                         │
│                                                              │
│  🟡 Distanza 2 — impatto indiretto                          │
│  ● ContractForm.tsx            [📄 Apri nel grafo]          │
│  ...                                                         │
│                                                              │
│  [📋 Esporta lista]  [🔍 Usa come contesto harvester]       │
└──────────────────────────────────────────────────────────────┘
```

**Implementazione Python:**
```python
@app.get("/api/graph/impact/{node_id}")
async def impact_analysis(node_id: str, max_depth: int = 3):
    graph = load_graph()
    resolved = resolve_node_id(node_id, name_lookup)

    results = {}
    for depth in range(1, max_depth + 1):
        # tutti i nodi raggiungibili a esattamente questa distanza
        nodes_at_depth = {
            n for n in nx.single_source_shortest_path_length(graph, resolved, cutoff=depth)
            if nx.shortest_path_length(graph, resolved, n) == depth
        }
        results[depth] = [
            {"id": n, "label": graph.nodes[n].get("label"), "file": graph.nodes[n].get("fullPath")}
            for n in nodes_at_depth
        ]

    return {"node": node_id, "impact": results, "total": sum(len(v) for v in results.values())}
```

**"Usa come contesto harvester":** i file impattati diventano seed per il retrieval — utile quando stai per fare una refactoring e vuoi capire il contesto completo.

---

### Tab 3 — Analisi Codebase

Sezioni collassabili, tutte calcolate con NetworkX senza AI. Il badge nel tab mostra il numero totale di issues trovate.

```
┌──────────────────────────────────────────────────────────────┐
│  🔍 Analisi Codebase                    [🔄 Ricalcola]      │
│  Ultima analisi: 27/05/2026 10:54                           │
│                                                              │
│  ┌─ 🔴 Dead Code Candidates ──────────────────── 12 [▼] ──┐ │
│  │ File senza chiamanti e non entry point noti             │ │
│  │ ● LegacyExportHelper.cs    — 0 chiamanti               │ │
│  │ ● OldContractMapper.cs     — 0 chiamanti               │ │
│  │ ...                                                      │ │
│  │ [📋 Esporta lista]                                      │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─ 🔵 Dipendenze Circolari ───────────────────── 3 [▼] ──┐ │
│  │ Cicli nel grafo diretto — potenziali problemi           │ │
│  │ ● ContractService → ValidatorFactory → ContractService  │ │
│  │ ...                                                      │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─ 🟡 Hotspot (freq. modifiche + connessioni) ── 8 [▼] ──┐ │
│  │ File modificati spesso con molte dipendenze             │ │
│  │ ● ContractService.cs   — 47 conn. / 23 commit recenti  │ │
│  │ ...                                                      │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─ ⚪ Test Coverage Gap ──────────────────────── 34 [▼] ──┐ │
│  │ Classi senza file di test associato                     │ │
│  │ ● LeadService.cs       — nessun test trovato            │ │
│  │ ...                                                      │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─ 🟣 Funzionalità Simili (overlap alto) ─────── 4 [▼] ──┐ │
│  │ Funzionalità con molti nodi condivisi                   │ │
│  │ ● "OCR" ↔ "Allegati" — 8 nodi condivisi                │ │
│  │ Considera merge o estrazione layer condiviso            │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─ 🔗 Edge Frontend ↔ Backend ────────────────── [▼] ────┐ │
│  │ Chiamate API che attraversano il confine                │ │
│  │ ● ContractForm.tsx → POST /api/contracts                │ │
│  │   → ContractController.CreateContract()                 │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

**Implementazione delle analisi (tutto NetworkX, zero AI):**

```python
# Dead code — nodi senza predecessori e non entry point
def find_dead_code(graph, entry_points):
    return [
        n for n in graph.nodes
        if graph.in_degree(n) == 0
        and n not in entry_points
    ]

# Circular dependencies
def find_circular_deps(graph):
    try:
        cycles = list(nx.find_cycle(graph, orientation="original"))
        return cycles
    except nx.NetworkXNoCycle:
        return []

# Hotspot — betweenness centrality + git log
def find_hotspots(graph, git_log: dict):
    centrality = nx.betweenness_centrality(graph)
    return sorted(
        [(n, centrality[n], git_log.get(n, 0)) for n in graph.nodes],
        key=lambda x: x[1] * x[2],  # centralità × frequenza modifiche
        reverse=True
    )[:20]

# Funzionalità simili — Jaccard similarity sui nodi
def find_similar_functions(functional_map):
    results = []
    functions = functional_map["functions"]
    for i, f1 in enumerate(functions):
        for f2 in functions[i+1:]:
            set1 = set(n["id"] for n in f1["nodes"])
            set2 = set(n["id"] for n in f2["nodes"])
            jaccard = len(set1 & set2) / len(set1 | set2)
            if jaccard > 0.3:  # soglia configurabile
                results.append({"f1": f1["name"], "f2": f2["name"],
                                 "shared": len(set1 & set2), "similarity": jaccard})
    return sorted(results, key=lambda x: x["similarity"], reverse=True)

# Edge frontend ↔ backend — analisi statica API calls
def find_api_edges(repo_path, graph, name_lookup):
    edges = []
    # Cerca pattern fetch/axios nei file .ts/.tsx
    for ts_file in glob("**/*.tsx", recursive=True):
        content = open(ts_file).read()
        api_calls = re.findall(r"(?:fetch|axios\.\w+)\(['\"](/api/[^'\"]+)", content)
        for api_path in api_calls:
            # Cerca il controller che gestisce questa route nel backend
            controller = find_controller_for_route(api_path, repo_path)
            if controller:
                edges.append({"from": ts_file, "to": controller, "api": api_path})
    return edges
```

**Git log per hotspot:** usa `subprocess` con `git log --format="%H" --since="90 days ago" -- {file}` per contare i commit recenti per file. Zero AI.

---

### Tab 4 — Funzionalità

Gestione della `functional_map.json` — lista, creazione label-first, validazione community.

```
┌──────────────────────────────────────────────────────────────┐
│  🏷 Funzionalità mappate                   [+ Nuova]        │
│                                                              │
│  Filtro: [Tutte ▼]  [🔍 cerca...]                           │
│                                                              │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                              │
│  ● Lead Management          leiden   23 nodi  [✏️] [🗑]     │
│  ● Pagina Lista Contratti   label    47 nodi  [✏️] [🗑]     │
│  ● Contract Validation      leiden   18 nodi  [✏️] [🗑]     │
│  ...                                                         │
│                                                              │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                              │
│  ➕ CREA DA LABEL                                            │
│  [pagina lista contratti              ] [🔍 Cerca nel grafo]│
│                                                              │
│  [risultati label-first come da piano v4...]                │
│                                                              │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                              │
│  📋 VALIDA COMMUNITY LEIDEN                                  │
│  Da validare: 6 community                                    │
│  [Inizia validazione →]                                      │
└──────────────────────────────────────────────────────────────┘
```

---

## Notifiche nel pannello VS Code

Il pannello principale (prima schermata in VS Code) aggiunge badge di notifica basati sui risultati dell'analisi codebase, senza richiedere di aprire il Graph View:

```
FUNCTIONAL ANALYSIS                                          ▲
Community: 26 (26 validate) — pronto
⚠️ 3 dipendenze circolari  •  12 dead code candidates
[📊 Apri Graph View]   [✅ Valida community]
```

I badge si aggiornano ogni volta che viene rieseguita la functional analysis. Zero AI — sono solo i risultati delle analisi NetworkX già calcolate.

---

## Aggiornamento struttura progetto

```
context-harvester/
├── ...                          (invariato)
└── python/
    ├── ...                      (invariato)
    ├── mcp_server.py            ← esteso con route web app + websocket
    ├── graph_analyses.py        ← NUOVO — dead code, circular deps, hotspot, ecc.
    ├── graph_api_edges.py       ← NUOVO — rilevazione edge frontend↔backend
    └── webapp/                  ← NUOVO — web app servita da FastAPI
        ├── static/
        │   ├── vis-network.min.js
        │   ├── app.css
        │   └── app.js
        └── templates/
            └── index.html
```

---

## Settings aggiornati — web app e analisi

```jsonc
// ── Web App ───────────────────────────────────────
"contextHarvester.webapp.autoOpenBrowser": true,  // apre browser automaticamente
"contextHarvester.webapp.port": 3456,             // stesso del MCP server

// ── Analisi codebase ──────────────────────────────
"contextHarvester.analysis.gitLogDays": 90,       // giorni di git history per hotspot
"contextHarvester.analysis.functionSimilarityThreshold": 0.3,  // soglia Jaccard
"contextHarvester.analysis.deadCodeMinDegree": 0, // soglia per dead code
"contextHarvester.analysis.apiEdgePatterns": ["fetch", "axios"], // pattern da cercare

// ── Entry points noti (esclusi da dead code) ──────
"contextHarvester.analysis.entryPointPatterns": [
    "Controller", "Program.cs", "Startup.cs",
    "Page.tsx", "App.tsx", "index.ts"
]
```

---

## Ordine di implementazione aggiornato — v4 completo

Da aggiungere dopo lo step 26 del piano v3:

**Graph fixes (prerequisiti):**
27. `name_lookup.json` — lookup table classe→nodo
28. Risoluzione edge con lookup in `build_graph.py`
29. Label brevi in `graph.json`
30. Post-processing Leiden (`reassign_unassigned`)

**Label-first:**
31. `phase_label_expansion.py` — AI query expansion
32. `phase_label_seeds.py` — seed finding
33. `phase_label_traversal.py` — graph traversal
34. API endpoint `/api/graph/label-first` nel MCP server

**Web app — infrastruttura:**
35. Estensione MCP server con route web app (`/`, `/api/graph/*`, `/ws/graph`)
32. Shell HTML + struttura tab in `webapp/templates/index.html`
37. Aggiornamento bottone "Apri Graph View" nel pannello VS Code per aprire browser

**Web app — Tab 1 Grafo:**
38. Migrazione vis.js da WebView VS Code a web app
39. Tutti i controlli esistenti (ricerca, filtri, selezione nodo)
40. "Usa come seed retrieval" — link a context harvester

**Web app — Tab 2 Impact Analysis:**
41. `graph_analyses.py` — funzione `impact_analysis()` con NetworkX
42. API endpoint `/api/graph/impact/{node_id}`
43. UI Tab Impact con lista risultati per distanza
44. "Usa come contesto harvester" — seed retrieval da lista impattati

**Web app — Tab 3 Analisi Codebase:**
45. `graph_analyses.py` — dead code, circular deps, hotspot, test gap, funzionalità simili
46. `graph_api_edges.py` — rilevazione edge frontend↔backend
47. API endpoint `/api/graph/analysis`
48. UI Tab Analisi con sezioni collassabili

**Web app — Tab 4 Funzionalità:**
49. API endpoint `/api/functions` CRUD
50. UI Tab Funzionalità con lista, label-first integrato, validazione community
51. Comportamento visivo label-first (highlighting, opacity, click add/remove)
52. Salvataggio in `functional_map.json`

**Integrazione e rifinitura:**
53. Badge notifiche nel pannello VS Code (circular deps, dead code)
54. Websocket per risultati in tempo reale (label-first, impact)
55. Coesistenza Leiden + label-first — gestione priorità nodi
56. Aggiornamento README con documentazione web app e analisi

---

## Note per l'implementatore

- La costruzione di `name_lookup.json` deve avvenire PRIMA del Leiden clustering — senza edge corretti il clustering produce risultati sbagliati che poi richiedono più lavoro manuale
- Il fallback del label-first (se l'AI non risponde con JSON valido) deve funzionare sempre — usare le parole dell'input direttamente come pattern di ricerca stringa sul path dei file
- La funzione `reassign_unassigned()` deve essere idempotente — se chiamata più volte produce lo stesso risultato
- Il traversal depth di default (2) è un buon compromesso — depth 1 trova troppo poco, depth 3+ può includere metà del codebase su progetti grandi. Rendere configurabile e mostrare un counter "trovati N nodi" in tempo reale mentre l'utente cambia la profondità
- I nodi veramente isolati (zero edge anche dopo la normalizzazione) rimangono unassigned — candidati per la sezione "Nodi isolati" del GRAPH_REPORT.md
- `qwen3:4b` per la label expansion è sufficiente — task semplice di estrazione terminologica
- vis.js va incluso come file locale nella web app, non caricato da CDN — garantisce funzionamento offline
- Il MCP server deve gestire richieste concorrenti con `asyncio` — un utente può avere la web app aperta mentre Copilot chiama tool MCP
- La web app non richiede autenticazione — è localhost, accessibile solo dalla macchina locale
- Per l'analisi git log, gestire gracefully i repo senza git inizializzato (fallback: tutti i file hanno score 0 per hotspot)
- Gli entry point patterns per il dead code sono configurabili — un progetto senza `Controller` nel nome dei controller produrrebbe falsi positivi senza questa configurazione
- L'analisi edge frontend↔backend è best-effort — i pattern `fetch`/`axios` coprono il 90% dei casi ma non tutti (es. GraphQL, custom HTTP clients)
