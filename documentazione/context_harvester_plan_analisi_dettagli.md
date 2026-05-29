# Context Harvester — Piano Analisi Dettagli

> **Stato:** Implementato (maggio 2026). Le sezioni seguenti riflettono sia la specifica originale che le modifiche effettive nel codebase.

Questo documento descrive l'implementazione degli edge inter-procedurali (chiamate tra metodi di file diversi) nel knowledge graph. È un piano separato dai piani v1-v4 perché introduce dipendenze e complessità specifiche che devono essere implementate dopo che il grafo base è stabile.

**Prerequisiti:** Piano v4/v5 completamente implementato e funzionante.

**Principio guida:** tutto è disabilitabile. Ogni fase della risoluzione delle chiamate ha il suo toggle nei settings. Su codebase molto grandi o con problemi di build, si può tornare al comportamento v4 senza perdere nulla.

---

## Problema che risolviamo

Il grafo attuale (v4) ha edge a livello file:

- `contains` — file contiene classi, classi contengono metodi
- `imports` — file A importa file B
- `references` — file A usa un simbolo definito in file B
- `http_calls` — metodo frontend chiama endpoint backend

**Manca:** edge tipo `calls` che dicano "il metodo `Foo.Bar()` chiama il metodo `Baz.Qux()` di un'altra classe/file".

Questo limita l'impact analysis: "ContractService.cs usa GZipHelper.cs" invece di "ContractService.SaveCompressed() chiama GZipHelper.Compress() alla riga 145".

---

## Architettura della soluzione — Analisi a Cascata

La risoluzione degli edge inter-procedurali avviene in tre fasi successive. Ogni fase lavora solo sui casi che la fase precedente non ha risolto. La Fase 3 è opzionale.

```
Tutte le call expression estratte dai parser
            │
            ▼
┌─────────────────────────────────────┐
│  FASE 1 — Livello A                 │
│  Match diretto su name_lookup       │
│  Costo: millisecondi                │
│  Copertura: ~70%                    │
│  Disabilitabile: no (base)          │
└──────────────┬──────────────────────┘
               │ irrisolti (~30%)
               ▼
┌─────────────────────────────────────┐
│  FASE 2 — DI Resolution             │
│  Interfaccia → implementazione      │
│  via name_lookup["interfaces"]      │
│  Costo: millisecondi                │
│  Copertura aggiuntiva: ~20%         │
│  Totale: ~90%                       │
│  Disabilitabile: sì                 │
└──────────────┬──────────────────────┘
               │ irrisolti (~10%)
               ▼
┌─────────────────────────────────────┐
│  FASE 3 — Semantic Resolution       │
│  Roslyn SemanticModel (C#)          │
│  TypeScript compiler API (TS)       │
│  Solo sui casi irrisolti            │
│  Costo: 30-90 secondi               │
│  Copertura aggiuntiva: ~5%          │
│  Totale: ~95%                       │
│  Disabilitabile: sì (default off)   │
└─────────────────────────────────────┘
            │
            ▼
    call_edges_resolved.json
            │
            ▼
    edge "calls" nel grafo NetworkX
```

---

## FASE 1 — Livello A: conversione call expression esistenti

### Situazione attuale

I parser già estraggono le call expression ma non le convertono in edge del grafo:

- `ts_parser.py`: estrae `result.calls` per ogni file TypeScript — dato presente, non usato come edge
- `RoslynHarvester`: estrae la struttura sintattica ma non le invocations cross-file

### C# — estensione RoslynHarvester (Fase 1)

Aggiungere l'estrazione delle invocations sintattiche senza SemanticModel — veloce, nessuna risoluzione dei tipi, usa solo i nomi come appaiono nel codice.

**File:** `tools/RoslynHarvester/Program.cs`

```csharp
// Aggiunta alla pipeline esistente
public class CallEdgeExtractor
{
    public static List<RawCallEdge> ExtractRawCalls(
        SyntaxTree tree,
        string currentFile,
        string currentClass,
        string currentMethod)
    {
        var root = tree.GetRoot();
        var edges = new List<RawCallEdge>();

        var invocations = root.DescendantNodes()
            .OfType<InvocationExpressionSyntax>();

        foreach (var invocation in invocations)
        {
            string targetClass = null;
            string targetMethod = null;

            // pattern: NomeClasse.NomeMetodo(...)
            if (invocation.Expression is MemberAccessExpressionSyntax memberAccess)
            {
                targetClass = memberAccess.Expression.ToString();
                targetMethod = memberAccess.Name.Identifier.Text;
            }
            // pattern: NomeMetodo(...) — chiamata su this
            else if (invocation.Expression is IdentifierNameSyntax identifier)
            {
                targetClass = currentClass;
                targetMethod = identifier.Identifier.Text;
            }

            if (targetMethod != null)
            {
                edges.Add(new RawCallEdge
                {
                    FromFile = currentFile,
                    FromClass = currentClass,
                    FromMethod = currentMethod,
                    TargetClassRaw = targetClass,  // non ancora risolto
                    TargetMethod = targetMethod,
                    Line = invocation.GetLocation()
                                    .GetLineSpan()
                                    .StartLinePosition.Line
                });
            }
        }

        return edges;
    }
}

public record RawCallEdge
{
    public string FromFile { get; init; }
    public string FromClass { get; init; }
    public string FromMethod { get; init; }
    public string TargetClassRaw { get; init; }  // es. "this.leadService", "LeadService", "_validator"
    public string TargetMethod { get; init; }
    public int Line { get; init; }
}
```

**Output aggiuntivo di RoslynHarvester:** `call_edges_raw_cs.json`

```json
[
  {
    "fromFile": "src/Services/ContractService.cs",
    "fromClass": "ContractService",
    "fromMethod": "SaveCompressed",
    "targetClassRaw": "_gzipHelper",
    "targetMethod": "Compress",
    "line": 145
  }
]
```

### TypeScript — estensione ts_parser.py (Fase 1)

`result.calls` è già estratto — basta esportarlo in `call_edges_raw_ts.json`.

**File:** `python/ts_parser.py`

```python
# Già presente nel parser — aggiungere export
def extract_and_export_calls(file_path: str, result: ParseResult) -> list:
    raw_calls = []
    for call in result.calls:
        raw_calls.append({
            "fromFile": file_path,
            "fromClass": result.main_class or "",
            "fromMethod": call.get("containing_function", ""),
            "targetClassRaw": call.get("object", ""),    # es. "api", "this.validator"
            "targetMethod": call.get("method", ""),
            "line": call.get("line", 0)
        })
    return raw_calls
```

**Output:** `call_edges_raw_ts.json`

---

## FASE 1 — Risoluzione con name_lookup

**File:** `python/phase_call_resolution.py`

```python
def resolve_phase1(raw_calls: list, name_lookup: dict) -> tuple[list, list]:
    """
    Tenta di risolvere il target di ogni chiamata raw usando name_lookup.
    Restituisce (resolved, unresolved).
    """
    resolved = []
    unresolved = []

    for call in raw_calls:
        target_raw = call["targetClassRaw"]

        # Pulisci il target raw — rimuovi "this.", "_", prefissi comuni
        clean = clean_target_name(target_raw)
        # es. "this.leadService" → "leadService" → "LeadService" (capitalizza)
        # es. "_validator" → "validator" → cerca nel lookup

        # Prova match diretto
        node_id = name_lookup["byClassName"].get(clean)
        if not node_id:
            # Prova case-insensitive
            node_id = name_lookup["byClassNameLower"].get(clean.lower())

        if node_id:
            resolved.append({
                **call,
                "toNodeId": node_id,
                "toClass": name_lookup["nodeToClass"][node_id],
                "toFile": name_lookup["nodeToFile"][node_id],
                "resolvedBy": "direct"
            })
        else:
            unresolved.append(call)

    return resolved, unresolved


def clean_target_name(raw: str) -> str:
    """
    Normalizza il nome del target da come appare nel codice
    a come appare nel name_lookup.
    """
    # Rimuovi "this."
    name = raw.removeprefix("this.")
    # Rimuovi underscore iniziale (field convention C#: _leadService)
    name = name.lstrip("_")
    # Capitalizza primo carattere (leadService → LeadService)
    if name:
        name = name[0].upper() + name[1:]
    # Rimuovi generics (List<LeadService> → LeadService)
    if "<" in name:
        name = re.search(r"<(\w+)>", name)
        name = name.group(1) if name else raw
    return name
```

---

## FASE 2 — DI Resolution

**File:** `python/phase_call_resolution.py` (stessa funzione, step successivo)

```python
def resolve_phase2(unresolved: list, name_lookup: dict) -> tuple[list, list]:
    """
    Risolve i casi DI: interfaccia → implementazione concreta.
    ILeadService → LeadService (se unica implementazione nel progetto).
    """
    resolved = []
    still_unresolved = []

    for call in unresolved:
        clean = clean_target_name(call["targetClassRaw"])

        # Cerca nel mapping interfacce → implementazioni
        concrete_class = name_lookup["interfaces"].get(clean)
        if not concrete_class:
            # Prova con prefisso I rimosso (ILeadService → LeadService)
            if clean.startswith("I") and len(clean) > 1:
                candidate = clean[1:]  # rimuovi "I"
                concrete_class = name_lookup["byClassName"].get(candidate)
                if concrete_class:
                    concrete_class = candidate  # usa il nome senza I

        if concrete_class:
            node_id = name_lookup["byClassName"].get(concrete_class)
            if node_id:
                resolved.append({
                    **call,
                    "toNodeId": node_id,
                    "toClass": concrete_class,
                    "toFile": name_lookup["nodeToFile"][node_id],
                    "resolvedBy": "di_resolution"
                })
                continue

        still_unresolved.append(call)

    return resolved, still_unresolved
```

---

## FASE 3 — Semantic Resolution (opzionale)

### C# — Roslyn SemanticModel

**File:** `tools/RoslynHarvester/SemanticResolver.cs` (nuovo file)

Viene invocato SOLO per i casi irrisolti passati come input — non analizza tutto il codebase.

```csharp
public class SemanticResolver
{
    private readonly Compilation _compilation;

    public SemanticResolver(Compilation compilation)
    {
        _compilation = compilation;
    }

    public List<ResolvedCallEdge> ResolveUnresolved(
        List<RawCallEdge> unresolvedCalls)
    {
        var resolved = new List<ResolvedCallEdge>();

        foreach (var call in unresolvedCalls)
        {
            var tree = _compilation.SyntaxTrees
                .FirstOrDefault(t => t.FilePath == call.FromFile);
            if (tree == null) continue;

            var semanticModel = _compilation.GetSemanticModel(tree);
            var root = tree.GetRoot();

            // Trova l'invocation corrispondente (per file + metodo + riga)
            var invocation = root.DescendantNodes()
                .OfType<InvocationExpressionSyntax>()
                .FirstOrDefault(i =>
                    i.GetLocation().GetLineSpan()
                     .StartLinePosition.Line == call.Line);

            if (invocation == null) continue;

            var symbolInfo = semanticModel.GetSymbolInfo(invocation);
            var targetSymbol = symbolInfo.Symbol as IMethodSymbol;

            if (targetSymbol == null) continue;

            // Solo simboli definiti nel nostro assembly
            if (!SymbolEqualityComparer.Default.Equals(
                    targetSymbol.ContainingAssembly,
                    _compilation.Assembly)) continue;

            var targetFile = targetSymbol.Locations
                .FirstOrDefault()?.SourceTree?.FilePath;

            if (targetFile == null) continue;

            resolved.Add(new ResolvedCallEdge
            {
                FromFile = call.FromFile,
                FromClass = call.FromClass,
                FromMethod = call.FromMethod,
                ToFile = targetFile,
                ToClass = targetSymbol.ContainingType.Name,
                ToMethod = targetSymbol.Name,
                Line = call.Line,
                ResolvedBy = "roslyn_semantic"
            });
        }

        return resolved;
    }
}
```

**Nota importante:** `Compilation` richiede che il progetto sia compilabile. Il `RoslynHarvester` deve essere invocato con il `.csproj` come entry point (già fa questo) per avere la compilation completa. Se ci sono errori di compilazione, i simboli non risolvibili vengono semplicemente saltati — non bloccano il processo.

**Invocazione da Python:**

```python
# python/phase_call_resolution.py
def resolve_phase3_csharp(unresolved_cs: list, roslyn_path: str) -> list:
    if not unresolved_cs:
        return []

    # Scrivi i casi irrisolti in un file temp
    temp_input = write_temp_json(unresolved_cs)

    # Invoca RoslynHarvester con flag --resolve-semantic
    result = subprocess.run([
        roslyn_path,
        "--resolve-semantic",
        "--input", temp_input,
        "--output", "semantic_resolved_cs.json"
    ], capture_output=True, timeout=120)

    if result.returncode != 0:
        logger.warning("Semantic resolution fallita: %s", result.stderr)
        return []

    return read_json("semantic_resolved_cs.json")
```

### TypeScript — TypeScript Compiler API via Node.js

**File:** `tools/ts_semantic_resolver/index.js` (nuovo file Node.js)

```javascript
const ts = require("typescript");
const fs = require("fs");

// Legge i casi irrisolti da stdin o file
const unresolvedCalls = JSON.parse(fs.readFileSync(process.argv[2]));

// Crea il program TypeScript con tutti i file del progetto
const sourceFiles = [...new Set(unresolvedCalls.map((c) => c.fromFile))];
const program = ts.createProgram(sourceFiles, {
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.CommonJS,
  strict: false,
  noEmit: true,
});
const checker = program.getTypeChecker();

const resolved = [];

for (const call of unresolvedCalls) {
  const sourceFile = program.getSourceFile(call.fromFile);
  if (!sourceFile) continue;

  // Trova il nodo AST corrispondente alla riga
  const callNode = findCallAtLine(sourceFile, call.line);
  if (!callNode) continue;

  // Risolvi il simbolo target
  const symbol = checker.getSymbolAtLocation(
    ts.isCallExpression(callNode) ? callNode.expression : callNode,
  );
  if (!symbol) continue;

  const declarations = symbol.declarations || [];
  for (const decl of declarations) {
    const targetFile = decl.getSourceFile().fileName;
    const targetClass = getContainingClass(decl)?.name?.text || "";
    const targetMethod = symbol.getName();

    // Solo simboli nel nostro progetto (non node_modules)
    if (targetFile.includes("node_modules")) continue;

    resolved.push({
      ...call,
      toFile: targetFile,
      toClass: targetClass,
      toMethod: targetMethod,
      resolvedBy: "ts_semantic",
    });
    break;
  }
}

// Output JSON su stdout
console.log(JSON.stringify(resolved));

function findCallAtLine(sourceFile, lineNumber) {
  function visit(node) {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line;
    if (line === lineNumber && ts.isCallExpression(node)) return node;
    return ts.forEachChild(node, visit);
  }
  return visit(sourceFile);
}

function getContainingClass(node) {
  let current = node.parent;
  while (current) {
    if (ts.isClassDeclaration(current)) return current;
    current = current.parent;
  }
  return null;
}
```

**Invocazione da Python:**

```python
def resolve_phase3_typescript(unresolved_ts: list) -> list:
    if not unresolved_ts:
        return []

    temp_input = write_temp_json(unresolved_ts)
    resolver_path = Path(__file__).parent.parent / "tools/ts_semantic_resolver/index.js"

    result = subprocess.run(
        ["node", str(resolver_path), temp_input],
        capture_output=True,
        text=True,
        timeout=120
    )

    if result.returncode != 0:
        logger.warning("TS semantic resolution fallita: %s", result.stderr)
        return []

    return json.loads(result.stdout)
```

**Dipendenza:** Node.js deve essere installato. `package.json` nella cartella `tools/ts_semantic_resolver/`:

```json
{
  "name": "ts-semantic-resolver",
  "dependencies": {
    "typescript": "^5.0.0"
  }
}
```

---

## Orchestrazione completa

**File:** `python/phase_call_resolution.py`

```python
def resolve_all_call_edges(
    raw_cs: list,
    raw_ts: list,
    name_lookup: dict,
    settings: dict
) -> list:

    all_raw = raw_cs + raw_ts
    all_resolved = []

    # FASE 1 — match diretto
    resolved_1, unresolved = resolve_phase1(all_raw, name_lookup)
    all_resolved.extend(resolved_1)
    emit_progress("call_resolution", f"Fase 1: {len(resolved_1)} risolti, {len(unresolved)} irrisolti")

    # FASE 2 — DI resolution
    if settings.get("enableDIResolution", True) and unresolved:
        resolved_2, unresolved = resolve_phase2(unresolved, name_lookup)
        all_resolved.extend(resolved_2)
        emit_progress("call_resolution", f"Fase 2: +{len(resolved_2)} risolti, {len(unresolved)} irrisolti")

    # FASE 3 — Semantic resolution (opzionale)
    if settings.get("enableSemanticResolution", False) and unresolved:
        unresolved_cs = [c for c in unresolved if c["fromFile"].endswith(".cs")]
        unresolved_ts = [c for c in unresolved if c["fromFile"].endswith((".ts", ".tsx"))]

        if unresolved_cs:
            resolved_3_cs = resolve_phase3_csharp(
                unresolved_cs,
                settings["roslynPath"]
            )
            all_resolved.extend(resolved_3_cs)
            emit_progress("call_resolution", f"Fase 3 C#: +{len(resolved_3_cs)} risolti")

        if unresolved_ts and settings.get("enableTypeScriptSemantic", True):
            resolved_3_ts = resolve_phase3_typescript(unresolved_ts)
            all_resolved.extend(resolved_3_ts)
            emit_progress("call_resolution", f"Fase 3 TS: +{len(resolved_3_ts)} risolti")

    # Statistiche finali
    total = len(all_raw)
    coverage = len(all_resolved) / total * 100 if total > 0 else 0
    emit_progress("call_resolution", f"Completato: {len(all_resolved)}/{total} ({coverage:.1f}%)")

    return all_resolved
```

---

## Integrazione nel grafo NetworkX

**File:** `python/graph_v2.py` — integrazione dopo il build del grafo base (la funzione `add_call_edges_to_graph` non è in un file separato `phase_graph.py`, ma integrata direttamente in `run_graph_v2`).

```python
# In graph_v2.py, dopo aver caricato simboli, import graph e API links:
# 1. Legge call_edges_raw_cs.json e call_edges_raw_ts.json
# 2. Costruisce name_lookup con _build_name_lookup(nodes)
# 3. Chiama phase_call_resolution.resolve_all_call_edges()
# 4. Aggiunge edge "calls" direttamente alla lista edges di graph_detail.json

for call in resolved:
    from_file = call.get("fromFile", "")
    to_node_id = call.get("toNodeId", "")
    from_node_id = name_lookup.get("fileToNodeId", {}).get(from_file)
    if from_node_id and to_node_id and from_node_id != to_node_id:
        edges.append({
            "source": from_node_id,
            "target": to_node_id,
            "type": "calls",
            "weight": 1.0,
            "confidence": 0.9,
            "origin": call.get("resolvedBy", "phase1"),
            "callDetail": {
                "fromMethod": call.get("fromMethod", ""),
                "toMethod": call.get("targetMethod", ""),
                "line": call.get("line", 0),
            },
        })
```

---

## Aggiornamento graph_detail.json / graph_file.json per la web app

Gli edge `calls` vengono aggiunti a `graph_detail.json` (grafo fine-grained) e sono visibili anche nella vista aggregata `graph_file.json`. Il viewer è **3D Force Graph** (non vis.js). Ogni edge ha il dettaglio metodo per il drill-down:

```json
{
  "edges": [
    {
      "source": "contractservice-energydeal-...",
      "target": "gziphelper-energydeal-...",
      "type": "calls",
      "weight": 1.0,
      "confidence": 0.9,
      "origin": "di_resolution",
      "callDetail": {
        "fromMethod": "SaveCompressed",
        "toMethod": "Compress",
        "line": 145
      }
    }
  ]
}
```

---

## Drill-down nel Graph View (web app)

Il viewer è **3D Force Graph** (Three.js). Gli edge `calls` sono colorati in arancione (`#ffaa00`) e hanno distanza link 80 (intermedia tra `contains` a 30 e default 100). Il tooltip mostra il tipo di edge; i dettagli metodo (`fromMethod`, `toMethod`, `line`) sono accessibili via API o espansione del nodo.

In futuro si può aggiungere un pannello laterale o overlay che mostri per il nodo selezionato:

- **Chiamate uscenti** — quali file/metodi chiama questo nodo
- **Chiamate entranti** — quali file/metodi chiamano questo nodo
- **Dettaglio per metodo** — da `callDetail` negli edge `calls`

---

## Impact Analysis potenziata

Con gli edge `calls`, l'impact analysis diventa precisa a livello metodo:

```
┌──────────────────────────────────────────────────────────────┐
│  ⚡ Impact Analysis                                          │
│                                                              │
│  Se modifico:  [GZipHelper.Compress    ] [🔍 Analizza]      │
│                  ↑ ricerca a livello metodo                  │
│                                                              │
│  🔴 Chiamanti diretti del metodo Compress():                 │
│  ● ContractService.SaveCompressed() — riga 145              │
│  ● LeadService.ArchiveLead() — riga 89                      │
│  ● OCRService.StoreResult() — riga 234                      │
│                                                              │
│  🟡 File impattati indirettamente (usano i chiamanti):       │
│  ● ContractController.cs (chiama ContractService)           │
│  ● LeadController.cs (chiama LeadService)                   │
│                                                              │
│  [📋 Esporta]  [🔍 Usa come contesto harvester]             │
└──────────────────────────────────────────────────────────────┘
```

La ricerca può avvenire sia a livello file (`GZipHelper.cs`) che a livello metodo (`GZipHelper.Compress`) — il sistema capisce dall'input quale livello di granularità usare.

---

## Settings

```jsonc
// ── Call Edge Resolution ──────────────────────────
"contextHarvester.callEdges.enabled": true,
  // master switch — se false, nessun edge calls viene generato

"contextHarvester.callEdges.enableLevelA": true,
  // Fase 1 — match diretto su name_lookup (sempre veloce)

"contextHarvester.callEdges.enableDIResolution": true,
  // Fase 2 — risoluzione interfacce → implementazioni

"contextHarvester.callEdges.enableSemanticResolution": false,
  // Fase 3 — Roslyn SemanticModel + TypeScript compiler API
  // default OFF — opt-in esplicito

"contextHarvester.callEdges.enableTypeScriptSemantic": true,
  // Fase 3 TypeScript — richiede Node.js installato
  // ignorato se enableSemanticResolution è false

"contextHarvester.callEdges.semanticTimeoutSeconds": 120,
  // timeout per la Fase 3 — se supera, usa solo Fase 1+2

"contextHarvester.callEdges.maxCallsPerFile": 500,
  // limite per file molto grandi — evita esplosione su file generati
```

---

## Aggiornamento struttura progetto

```
context-harvester/
├── tools/
│   ├── RoslynHarvester/
│   │   ├── Program.cs              ← esteso con CallEdgeExtractor + RawCall
│   │   └── SemanticResolver.cs     ← NUOVO — Fase 3 C# (placeholder, richiede Compilation)
│   └── ts_semantic_resolver/       ← NUOVO — Fase 3 TypeScript
│       ├── index.js
│       └── package.json
└── python/
    ├── phase_call_resolution.py    ← NUOVO — orchestrazione Fase 1+2+3
    ├── graph_v2.py                 ← integrazione edge calls in run_graph_v2()
    ├── roslyn_bridge.py            ← extract_raw_calls_from_roslyn()
    ├── ts_parser.py                ← extract_and_export_calls()
    └── import_graph.py             ← salva call_edges_raw_ts.json
```

---

## Aggiornamento struttura file `.context-harvester/`

```
.context-harvester/
├── ...                             (invariato)
├── call_edges_raw_cs.json          ← NUOVO — output RoslynHarvester Fase 1
├── call_edges_raw_ts.json          ← NUOVO — output ts_parser.py Fase 1
├── call_edges_resolved.json        ← NUOVO — output dopo tutte le fasi
└── call_resolution_stats.json      ← NUOVO — statistiche copertura
    {
      "total": 5000,
      "resolved": 4750,
      "coverage": 95.0
    }
```

---

## Aggiornamento Harvester Lab

Nuova sezione nel Lab per testare e monitorare la risoluzione delle chiamate:

```
Call Edges
[Estrai raw C#]        [Estrai raw TS]
[Risolvi Fase 1]       [Risolvi Fase 2]
[Risolvi Fase 3 C#]    [Risolvi Fase 3 TS]
[Pipeline completa]    [Stats copertura]
```

Il bottone "Stats copertura" mostra i dati di `call_resolution_stats.json` nel pannello output.

---

## Ordine di implementazione

1. **Estendi RoslynHarvester** con `CallEdgeExtractor` — estrazione raw calls C# (Fase 1)
2. **Aggiorna `roslyn_bridge.py`** per leggere `call_edges_raw_cs.json`
3. **Aggiorna `ts_parser.py`** per esportare `call_edges_raw_ts.json`
4. **`phase_call_resolution.py`** — Fase 1 (match diretto)
5. **Fase 2** — DI resolution in `phase_call_resolution.py`
6. **Integra edge `calls` in `graph_v2.py`** (`_build_name_lookup` + `phase_call_resolution.resolve_all_call_edges`)
7. **Aggiorna `graph_detail.json`** con edge calls e dettaglio metodi per 3D Force Graph
8. **Drill-down nel Graph View** — tooltip/overlay con chiamate entranti/uscenti
9. **Impact analysis potenziata** — ricerca a livello metodo nella web app
10. **`SemanticResolver.cs`** — Fase 3 C# (opzionale)
11. **`ts_semantic_resolver/index.js`** — Fase 3 TypeScript con Node.js (opzionale)
12. **`phase_call_resolution.py`** — integrazione Fase 3
13. **Settings** — tutti i toggle disabilitabili
14. **Harvester Lab** — sezione call edges
15. **Aggiornamento README** con spiegazione analisi a cascata e requisiti Node.js per Fase 3 TS

---

## Note per l'implementatore

- La Fase 3 C# richiede che il progetto compili — se ci sono errori di compilazione i simboli non risolvibili vengono saltati silenziosamente, non bloccano il processo
- La Fase 3 TypeScript richiede Node.js installato — verificare presenza con `node --version` prima di invocarla, fallback graceful se non disponibile
- `maxCallsPerFile` è importante — file generati automaticamente (es. migration EF, scaffolding) possono avere migliaia di invocations che inflazionano il grafo inutilmente
- Gli edge `calls` non sostituiscono gli edge `imports`/`references` esistenti — si aggiungono al grafo
- Il drill-down nella web app non carica tutto il grafo a livello metodo — carica solo le chiamate del nodo selezionato (lazy loading via API)
- `call_resolution_stats.json` è utile per diagnosticare problemi — se la copertura Fase 1 è molto bassa (<50%) significa che i `clean_target_name` non stanno normalizzando correttamente i nomi del progetto specifico
- Per EnergyDeal il pattern C# `_nomeServizio` (field con underscore) è molto comune — `clean_target_name` deve gestirlo come priorità
- Il timeout della Fase 3 (default 120s) è conservativo — su EnergyDeal con ~500 chiamate irrisolte stimiamo 30-60 secondi per C# e 20-40 secondi per TypeScript
