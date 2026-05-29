/* Context Harvester — Sigma.js viewer v5 (file / expanded / full detail) */
(function () {
  const $ = (id) => document.getElementById(id);
  let sigmaRenderer = null;
  let sigmaGraph = null;
  let fileViewData = { nodes: [], edges: [] };
  let fileViewLoaded = false;
  let expandedGraphCache = null;
  let detailCache = null;
  let viewMode = "file"; // file | expanded | full
  let expandedFile = null;
  let focusNodeId = null;
  let searchHighlightSet = new Set(); // nodo trovato + vicini, condiviso con renderGraph
  let nodeDegrees = new Map(); // degree di ogni nodo, condiviso con applySearchHighlight
  let sigmaReady = false;
  let dragSession = null;
  let suppressNodeClick = false;

  const IS_MOCK = new URLSearchParams(location.search).has("mock");
  const MOCK_MAP = {
    "/api/graph/file": "/static/mock/graph-file.json",
    "/api/graph/detail": "/static/mock/graph-detail.json",
    "/api/graph/search": "/static/mock/graph-search.json",
    "/api/graph/expand": "/static/mock/graph-expand.json",
    "/api/graph/impact": "/static/mock/graph-impact.json",
    "/api/graph/api-links": "/static/mock/graph-api-links.json",
    "/api/graph/path": "/static/mock/graph-path.json",
  };
  function mockUrl(path) {
    for (const [prefix, mock] of Object.entries(MOCK_MAP)) {
      if (path.startsWith(prefix)) return mock;
    }
    return null;
  }

  const TYPE_COLORS = {
    file: "#60a5fa",
    class: "#34d399",
    method: "#818cf8",
    dto: "#a78bfa",
    api_client_file: "#fbbf24",
    api_client_method: "#f97316",
    api_endpoint: "#2ec4b6",
    default: "#8594AA",
  };

  const NODE_DIM_COLOR = "#2d3f55";
  const EDGE_DIM_COLOR = "#263042";
  const EDGE_HI_COLOR = "#93c5fd";

  const DEFAULT_TYPES = {
    file: true,
    class: true,
    method: true,
    dto: true,
    api_client_file: true,
    api_client_method: true,
    api_endpoint: true,
  };

  /** 0 = nessun limite; altrimenti 1 … 100000 */
  const SIGMA_MAX_NODES_CAP = 100000;

  function parseMaxNodes() {
    const raw = parseInt($("sigma-max-nodes")?.value ?? "0", 10);
    if (!Number.isFinite(raw) || raw <= 0) return Infinity;
    return Math.min(raw, SIGMA_MAX_NODES_CAP);
  }

  function normPath(id) {
    return String(id || "").replace(/\\/g, "/");
  }

  /** Dimensione nodi in pixel: con migliaia di nodi restano piccoli così si vedono archi e spazio. */
  function nodePixelSize(nodeCount, isFileView) {
    if (nodeCount <= 80) return isFileView ? 12 : 14;
    if (nodeCount <= 400) return isFileView ? 7 : 9;
    if (nodeCount <= 1500) return isFileView ? 5 : 7;
    if (nodeCount <= 4000) return isFileView ? 5 : 6;
    return isFileView ? 4 : 5;
  }

  function edgePixelSize(nodeCount) {
    if (nodeCount <= 400) return 2;
    if (nodeCount <= 2000) return 1.5;
    return 1.2;
  }

  /** Palette colori per progetto (ciclica) */
  const PROJECT_PALETTE = [
    "#3b82f6", // blue
    "#10b981", // green
    "#f59e0b", // amber
    "#ef4444", // red
    "#8b5cf6", // violet
    "#06b6d4", // cyan
    "#f97316", // orange
    "#ec4899", // pink
    "#84cc16", // lime
    "#6366f1", // indigo
  ];
  const projectColorMap = new Map(); // project → color

  /** Estrae [progetto, cartella] da un node ID tipo "proj/src/pages/File.tsx" */
  function nodeZone(nodeId) {
    const parts = String(nodeId || "")
      .replace(/\\/g, "/")
      .split("/");
    const project = parts[0] || "other";
    const folder = parts.length > 2 ? parts.slice(1, -1).join("/") : "";
    return { project, folder };
  }

  function projectColor(proj) {
    if (!projectColorMap.has(proj)) {
      projectColorMap.set(
        proj,
        PROJECT_PALETTE[projectColorMap.size % PROJECT_PALETTE.length],
      );
    }
    return projectColorMap.get(proj);
  }

  /** Layout a zone / galassia: nodi con più connessioni al centro, dimensione per grado. */
  function computeNodePositions(nodeList, edgeList, mode, useZones, degrees) {
    const pos = new Map();
    const n = nodeList.length;
    if (!n) return pos;

    const isFileView = mode === "file";
    const degMap = degrees || new Map();

    if (!isFileView || n <= 30 || !useZones) {
      // Layout galassia: degree alto → vicino al centro, grande
      const maxDeg = Math.max(
        1,
        ...nodeList.map((n) => degMap.get(normPath(n.id)) || 0),
      );
      const maxR = Math.max(300, Math.sqrt(n) * 35);
      // Ordina per degree decrescente per posizionare prima i più connessi
      const sorted = [...nodeList].sort((a, b) => {
        const da = degMap.get(normPath(a.id)) || 0;
        const db = degMap.get(normPath(b.id)) || 0;
        return db - da;
      });
      sorted.forEach((node, i) => {
        const nid = normPath(node.id);
        const deg = degMap.get(nid) || 0;
        // Raggio: degree alto = vicino al centro (ma non esattamente 0)
        const normDeg = deg / maxDeg;
        const r = (1 - normDeg * 0.9) * maxR + 30 + (Math.random() - 0.5) * 40;
        // Angolo: distribuito uniformemente con jitter
        const baseAngle = (2 * Math.PI * i) / n;
        const angle =
          baseAngle + (Math.random() - 0.5) * ((2 * Math.PI) / n) * 0.8;
        pos.set(nid, { x: r * Math.cos(angle), y: r * Math.sin(angle) });
      });
    } else {
      // Layout a zone per progetto e sottocartella
      // 1. Raggruppa nodi per progetto → cartella
      const projects = new Map(); // project → Map(folder → [nodeId])
      nodeList.forEach((node) => {
        const nid = normPath(node.id);
        const { project, folder } = nodeZone(nid);
        if (!projects.has(project)) projects.set(project, new Map());
        const folders = projects.get(project);
        if (!folders.has(folder)) folders.set(folder, []);
        folders.get(folder).push(nid);
      });

      // 2. Calcola dimensione di ogni progetto (num nodi totali)
      const projList = [...projects.keys()];
      const nProj = projList.length;
      const projSizes = projList.map((p) => {
        let tot = 0;
        projects.get(p).forEach((ids) => (tot += ids.length));
        return tot;
      });
      const totalNodes = projSizes.reduce((a, b) => a + b, 0);

      // 3. Posiziona i progetti su cerchio, con angolo proporzionale alla dimensione
      let cumAngle = 0;
      const projCenters = projList.map((proj, pi) => {
        const fraction = projSizes[pi] / totalNodes;
        const midAngle = cumAngle + (fraction * 2 * Math.PI) / 2;
        cumAngle += fraction * 2 * Math.PI;
        // Raggio base proporzionale al numero di nodi del progetto
        const projNodeCount = projSizes[pi];
        const projRadius = Math.max(60, Math.sqrt(projNodeCount) * 10);
        // Distanza dal centro: compatta per evitare ratio camera troppo alto
        const orbitR = Math.max(300, Math.sqrt(totalNodes) * 18);
        return {
          proj,
          cx: orbitR * Math.cos(midAngle),
          cy: orbitR * Math.sin(midAngle),
          projRadius,
        };
      });

      projCenters.forEach(({ proj, cx: projCx, cy: projCy, projRadius }) => {
        const folders = projects.get(proj);
        const folderList = [...folders.keys()];
        const nFolders = folderList.length;
        const folderR = Math.max(projRadius * 0.35, Math.sqrt(nFolders) * 20);

        // 4. Posiziona le cartelle in cerchio all'interno del progetto
        folderList.forEach((folder, fi) => {
          const folderAngle = (2 * Math.PI * fi) / Math.max(1, nFolders);
          const folderCx = projCx + folderR * Math.cos(folderAngle);
          const folderCy = projCy + folderR * Math.sin(folderAngle);

          const nodeIds = folders.get(folder);
          const nNodes = nodeIds.length;
          const nodeR = Math.max(10, Math.sqrt(nNodes) * 8);

          // 5. Posiziona i nodi in modo casuale all'interno della cartella
          nodeIds.forEach((nid) => {
            const angle = Math.random() * 2 * Math.PI;
            const r = Math.sqrt(Math.random()) * nodeR;
            pos.set(nid, {
              x: folderCx + r * Math.cos(angle),
              y: folderCy + r * Math.sin(angle),
            });
          });
        });
      });
    }

    // Spring relaxation leggero lungo gli archi
    if (edgeList.length > 0) {
      const steps = n > 2000 ? 3 : n > 500 ? 5 : isFileView ? 10 : 20;
      const ideal = isFileView ? 40 : 25;
      for (let s = 0; s < steps; s++) {
        edgeList.forEach((e) => {
          const from = normPath(e.from || e.source);
          const to = normPath(e.to || e.target);
          const a = pos.get(from);
          const b = pos.get(to);
          if (!a || !b) return;
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = (dist - ideal) * 0.02;
          dx = (dx / dist) * force;
          dy = (dy / dist) * force;
          a.x += dx;
          a.y += dy;
          b.x -= dx;
          b.y -= dy;
        });
      }
    }
    return pos;
  }

  function sigmaSettingsForCount(nodeCount, isFileView, showLabels, showEdges) {
    const density = showLabels
      ? Math.max(0.03, 1.2 / Math.sqrt(Math.max(nodeCount, 1)))
      : 0;
    return {
      renderLabels: showLabels,
      renderEdgeLabels: false,
      labelDensity: density,
      labelGridCellSize: 56,
      labelSize: 11,
      labelColor: { attribute: "labelColor", defaultValue: "#3f4852" },
      labelWeight: "500",
      labelRenderedSizeThreshold: 0,
      labelBackgroundColor: "transparent",
      defaultEdgeColor: "#94a3b8",
      defaultEdgeType: "line",
      minEdgeSize: showEdges ? 1.5 : 0,
      maxEdgeSize: 4,
      zIndex: nodeCount < 500,
      hideEdgesOnMove: nodeCount > 300,
      hideEdgesOnZoom: false,
      hideLabelsOnMove: nodeCount > 300,
      stagePadding: 24,
      allowInvalidContainer: true,
    };
  }

  function edgeColor(e) {
    const t = e.type || e.label;
    if (t === "http_calls" || (e.confidence && e.confidence >= 0.9))
      return "#2ec4b6";
    if (t === "http_calls_inferred" || (e.confidence && e.confidence < 0.9))
      return "#f97316";
    if (t === "imports") return "#a78bfa";
    return "#94a3b8";
  }

  async function api(path, opts, label) {
    const mock = IS_MOCK ? mockUrl(path) : null;
    if (mock) {
      const res = await fetch(mock, opts);
      return res.json();
    }
    if (window.chProgress?.fetchJson) {
      return window.chProgress.fetchJson(path, opts, label);
    }
    const res = await fetch(path, opts);
    return res.json();
  }

  let searchMode = false; // quando true la query non filtra il grafo

  function getFilters() {
    const types = {};
    document.querySelectorAll("[data-sigma-type]").forEach((cb) => {
      types[cb.dataset.sigmaType] = cb.checked;
    });
    return {
      query: searchMode
        ? ""
        : ($("sigma-search")?.value || "").toLowerCase().trim(),
      minWeight: parseFloat($("sigma-min-weight")?.value || "0"),
      maxNodes: parseMaxNodes(),
      types,
      hidePrivate: $("sigma-hide-private")?.checked ?? true,
      showLabels: $("sigma-show-labels")?.checked ?? true,
      showEdges: $("sigma-show-edges")?.checked ?? true,
      useZones: $("sigma-zone-view")?.checked ?? true,
      filterProject: ($("sigma-filter-project")?.value || "").trim(),
      filterFolder: ($("sigma-filter-folder")?.value || "").trim(),
    };
  }

  function nodePasses(n, f) {
    const t = n.type || "file";
    if (f.types[t] === false) return false;
    if (f.hidePrivate && n.visibility === "private" && t === "method")
      return false;
    if (f.filterProject) {
      const { project } = nodeZone(normPath(n.id));
      const projs = f.filterProject
        .split("|")
        .map((s) => s.toLowerCase())
        .filter(Boolean);
      if (projs.length && !projs.some((p) => project.toLowerCase() === p))
        return false;
    }
    if (f.filterFolder) {
      const { folder } = nodeZone(normPath(n.id));
      const flds = f.filterFolder
        .split("|")
        .map((s) => s.toLowerCase())
        .filter(Boolean);
      if (flds.length && !flds.some((p) => folder.toLowerCase().includes(p)))
        return false;
    }
    if (!f.query) return true;
    const hay =
      `${n.label || ""} ${n.qualifiedName || ""} ${n.filePath || ""} ${n.id || ""}`.toLowerCase();
    return hay.includes(f.query);
  }

  function destroySigma() {
    console.log(
      "[destroySigma] called",
      new Error().stack.split("\n")[2]?.trim(),
    );
    dragSession = null;
    suppressNodeClick = false;
    if (sigmaRenderer) {
      sigmaRenderer.kill();
      sigmaRenderer = null;
    }
    sigmaGraph = null;
  }

  /** Trascina singoli nodi (Sigma 2: downNode + mousemovebody). */
  function bindNodeDrag(renderer) {
    if (!renderer || !sigmaGraph) return;

    renderer.on("downNode", (e) => {
      if (typeof e.preventSigmaDefault === "function") e.preventSigmaDefault();
      const x = sigmaGraph.getNodeAttribute(e.node, "x");
      const y = sigmaGraph.getNodeAttribute(e.node, "y");
      dragSession = { node: e.node, moved: false, startX: x, startY: y };
      renderer.getCamera().disable();
    });

    renderer.getMouseCaptor().on("mousemovebody", (e) => {
      if (!dragSession || !sigmaGraph.hasNode(dragSession.node)) return;
      const pos = renderer.viewportToGraph(e);
      const dx = pos.x - dragSession.startX;
      const dy = pos.y - dragSession.startY;
      if (!dragSession.moved && dx * dx + dy * dy > 9) dragSession.moved = true;
      if (dragSession.moved) {
        sigmaGraph.setNodeAttribute(dragSession.node, "x", pos.x);
        sigmaGraph.setNodeAttribute(dragSession.node, "y", pos.y);
      }
    });

    const endDrag = () => {
      if (!dragSession) return;
      suppressNodeClick = dragSession.moved;
      dragSession = null;
      renderer.getCamera().enable();
    };

    renderer.getMouseCaptor().on("mouseup", endDrag);
    renderer.getMouseCaptor().on("mouseleave", endDrag);
  }

  async function renderGraph(data, labelKey) {
    destroySigma();
    const container = $("sigma-container");
    if (!container) return;
    const GraphLib =
      typeof graphology !== "undefined" ? graphology : window.graphology;
    const SigmaLib = typeof sigma !== "undefined" ? sigma : window.Sigma;
    if (!GraphLib || !GraphLib.Graph || !SigmaLib) {
      if ($("sigma-status")) {
        $("sigma-status").textContent =
          "Sigma.js non caricato. Esegui scripts\\download-sigma.bat e ricompila il VSIX, oppure verifica /vendor/sigma/.";
      }
      return;
    }

    const f = getFilters();
    const filtered = (data.nodes || []).filter((n) => nodePasses(n, f));
    const totalFiltered = filtered.length;
    let nodes = filtered;
    let truncated = false;
    if (Number.isFinite(f.maxNodes) && nodes.length > f.maxNodes) {
      nodes = nodes.slice(0, f.maxNodes);
      truncated = true;
    }
    const idSet = new Set(nodes.map((n) => normPath(n.id)));
    const edges = (data.edges || []).filter((e) => {
      const from = normPath(e.from || e.source);
      const to = normPath(e.to || e.target);
      if (!idSet.has(from) || !idSet.has(to)) return false;
      return (e.weight || 1) >= f.minWeight;
    });

    searchHighlightSet.clear();
    const showLabels = f.showLabels;
    const showEdges = f.showEdges;
    const nodeBatch = 8000;
    const edgeBatch = 20000;
    const totalSteps = Math.max(1, nodes.length + edges.length);
    let doneSteps = 0;
    const buildTask = window.chProgress?.begin("Rendering grafo Sigma…", 0);

    function reportBuild(extraLabel) {
      if (!buildTask) return;
      const pct = Math.min(95, Math.round((doneSteps / totalSteps) * 90));
      buildTask.set(
        pct,
        extraLabel || `Rendering grafo… ${doneSteps}/${totalSteps}`,
      );
      const st = $("status-line");
      if (st) {
        st.textContent = `${extraLabel || "Caricamento grafo…"} — nodi: ${Math.min(doneSteps, nodes.length)}/${nodes.length}, archi: ${Math.max(0, doneSteps - nodes.length)}/${edges.length}`;
      }
    }

    const isFileView = viewMode === "file";
    // Calcola grado (num connessioni) di ogni nodo per layout galassia e dimensione
    nodeDegrees = new Map();
    nodes.forEach((n) => nodeDegrees.set(normPath(n.id), 0));
    edges.forEach((e) => {
      const from = normPath(e.from || e.source);
      const to = normPath(e.to || e.target);
      if (nodeDegrees.has(from))
        nodeDegrees.set(from, nodeDegrees.get(from) + 1);
      if (nodeDegrees.has(to)) nodeDegrees.set(to, nodeDegrees.get(to) + 1);
    });
    const positions = computeNodePositions(
      nodes,
      edges,
      viewMode,
      f.useZones,
      nodeDegrees,
    );
    const nodeSizePx = nodePixelSize(nodes.length, isFileView);
    const edgeSizePx = showEdges ? edgePixelSize(nodes.length) : 0;

    sigmaGraph = new GraphLib.Graph({ multi: false, type: "directed" });

    for (let i = 0; i < nodes.length; i += nodeBatch) {
      const chunk = nodes.slice(i, i + nodeBatch);
      chunk.forEach((n) => {
        const id = normPath(n.id);
        if (sigmaGraph.hasNode(id)) return;
        const label = n[labelKey] || n.label || id;
        const shortLabel = String(label).split(/[/\\]/).pop() || label;
        const highlighted = focusNodeId && normPath(focusNodeId) === id;
        const p = positions.get(id) || positions.get(n.id) || { x: 0, y: 0 };
        const deg = nodeDegrees.get(id) || 0;
        const effectiveDeg = Math.min(deg, 10);
        const sizeByDegree = Math.max(3, nodeSizePx + effectiveDeg * 0.6);
        const originalColor = highlighted
          ? "#ffeb3b"
          : (viewMode === "file" ? projectColor(nodeZone(id).project) : null) ||
            TYPE_COLORS[n.type] ||
            TYPE_COLORS.default;
        const originalLabel = showLabels
          ? `${String(shortLabel).slice(0, 35)}${deg > 0 ? ` (${deg})` : ""}`
          : "";
        sigmaGraph.addNode(id, {
          label: originalLabel,
          originalLabel,
          size: highlighted ? sizeByDegree + 4 : sizeByDegree,
          originalSize: sizeByDegree,
          color: originalColor,
          originalColor,
          x: p.x,
          y: p.y,
          raw: n,
        });
      });
      doneSteps += chunk.length;
      if (nodes.length > nodeBatch && i + nodeBatch < nodes.length) {
        const msg = `Nodi ${Math.min(i + nodeBatch, nodes.length)}/${nodes.length}`;
        $("sigma-status").textContent = `Costruzione grafo… ${msg}`;
        reportBuild(`Rendering nodi… ${msg}`);
        await new Promise((r) => requestAnimationFrame(r));
      } else {
        reportBuild();
      }
    }

    let ei = 0;
    let edgesAdded = 0;
    for (let i = 0; i < edges.length; i += edgeBatch) {
      const chunk = edges.slice(i, i + edgeBatch);
      chunk.forEach((e) => {
        const from = normPath(e.from || e.source);
        const to = normPath(e.to || e.target);
        if (!from || !to || !showEdges) return;
        try {
          sigmaGraph.addDirectedEdge(from, to, {
            size: edgeSizePx * Math.min(2, 0.6 + (e.weight || 1) * 0.2),
            color: edgeColor(e),
            type: "line",
          });
          edgesAdded++;
        } catch (err) {
          console.warn(`[sigma] edge skip ${from}->${to}:`, err.message);
        }
      });
      doneSteps += chunk.length;
      if (edges.length > edgeBatch && i + edgeBatch < edges.length) {
        const msg = `Archi ${Math.min(i + edgeBatch, edges.length)}/${edges.length}`;
        reportBuild(`Rendering archi… ${msg}`);
        await new Promise((r) => requestAnimationFrame(r));
      } else {
        reportBuild();
      }
    }

    buildTask?.set(98, "Avvio Sigma.js…");
    let hoverNodeId = null;
    let hoverNeighbors = new Set();
    const searchHighlightNodes = searchHighlightSet; // riferimento alla variabile di modulo
    const sigmaSettings = sigmaSettingsForCount(
      nodes.length,
      isFileView,
      showLabels,
      showEdges,
    );
    const nodeReducerFn = (node, attrs) => {
      const out = { ...attrs };
      const isSearchNode = searchHighlightNodes.has(node);
      if (hoverNodeId === null) return out;
      const isHovered = node === hoverNodeId;
      const isHoverNeighbor = hoverNeighbors.has(node);
      const hoverIsSearchCluster = searchHighlightNodes.has(hoverNodeId);
      if (hoverIsSearchCluster) {
        // Hover su cluster ricerca: cluster nero visibile, resto bianco
        if (isSearchNode) {
          out.color = attrs.color || "#000000";
          out.size = attrs.size || 4;
          out.zIndex = 2;
          out.label = attrs.label || "";
        } else {
          out.color = "#ffffff";
          out.label = "";
          out.size = Math.max((attrs.size || 4) - 1, 1);
          out.zIndex = 0;
        }
      } else {
        // Hover normale
        if (isHovered) {
          out.color = "#00639a";
          out.size = (attrs.size || 4) + 4;
          out.zIndex = 2;
          out.highlighted = true;
          out.label = attrs.label || "";
        } else if (isHoverNeighbor || isSearchNode) {
          out.size = (attrs.size || 4) + 1;
          out.zIndex = 1;
        } else {
          out.color = NODE_DIM_COLOR;
          out.label = "";
          out.size = Math.max((attrs.size || 4) - 1, 2);
          out.zIndex = 0;
        }
      }
      return out;
    };
    const edgeReducerFn = (edge, attrs) => {
      const out = { ...attrs };
      if (!showEdges) {
        out.hidden = true;
        return out;
      }
      if (hoverNodeId !== null) {
        const src = sigmaGraph.source(edge);
        const tgt = sigmaGraph.target(edge);
        const hoverIsSearchCluster = searchHighlightNodes.has(hoverNodeId);
        if (hoverIsSearchCluster) {
          // Hover su cluster ricerca: archi del cluster neri, resto bianco
          const srcSearch = searchHighlightNodes.has(src);
          const tgtSearch = searchHighlightNodes.has(tgt);
          if (srcSearch && tgtSearch) {
            out.color = "#000000";
            out.size = Math.max(attrs.size || 1, edgeSizePx);
            out.zIndex = 1;
          } else {
            out.color = "#eeeeee";
            out.size = Math.max(attrs.size || 1, edgeSizePx) * 0.3;
            out.zIndex = 0;
          }
        } else if (src === hoverNodeId || tgt === hoverNodeId) {
          out.color = EDGE_HI_COLOR;
          out.size = Math.max((attrs.size || 1) * 1.6, edgeSizePx + 1);
          out.zIndex = 1;
        } else {
          out.color = EDGE_DIM_COLOR;
          out.size = Math.max(attrs.size || 1, edgeSizePx) * 0.5;
          out.zIndex = 0;
        }
      } else {
        out.size = Math.max(attrs.size || 1, edgeSizePx);
        out.color = attrs.color || "#4a6890";
        out.zIndex = 0;
      }
      return out;
    };
    try {
      // Passa i reducer subito — sono no-op quando hoverNodeId è null
      sigmaSettings.nodeReducer = nodeReducerFn;
      sigmaSettings.edgeReducer = edgeReducerFn;
      sigmaRenderer = new SigmaLib(sigmaGraph, container, sigmaSettings);
    } catch (err) {
      console.error("[renderGraph] Sigma init failed:", err);
      $("sigma-status").textContent =
        "Errore inizializzazione Sigma: " + err.message;
    } finally {
      buildTask?.end();
      const st = $("status-line");
      if (st)
        st.textContent = `Grafo pronto — ${sigmaGraph.order} nodi, ${sigmaGraph.size} archi`;
    }

    bindNodeDrag(sigmaRenderer);

    sigmaRenderer.on("enterNode", ({ node }) => {
      hoverNodeId = node;
      // Se il nodo hovered è nella ricerca, espandi i vicini hover agli altri nodi ricerca
      const baseNeighbors = new Set(sigmaGraph.neighbors(node));
      if (searchHighlightNodes.has(node)) {
        searchHighlightNodes.forEach((n) => baseNeighbors.add(n));
      }
      hoverNeighbors = baseNeighbors;
      const attrs = sigmaGraph.getNodeAttributes(node);
      const lbl = attrs.raw?.label || attrs.label || node;
      const st = $("sigma-status");
      if (st && lbl) {
        st.textContent = `${lbl} — ${hoverNeighbors.size} connessioni · trascina per spostare`;
      }
      let tip = document.getElementById("sigma-node-tooltip");
      if (!tip) {
        tip = document.createElement("div");
        tip.id = "sigma-node-tooltip";
        tip.style.cssText =
          "position:fixed;pointer-events:none;z-index:999;background:#1e293b;color:#fff;font-size:12px;font-weight:600;padding:5px 10px;border-radius:6px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.2);transition:opacity 0.1s";
        document.body.appendChild(tip);
      }
      tip.textContent = lbl;
      tip.style.opacity = "1";
      sigmaRenderer.refresh();
    });
    sigmaRenderer.on("leaveNode", () => {
      hoverNodeId = null;
      hoverNeighbors = new Set();
      const tip = document.getElementById("sigma-node-tooltip");
      if (tip) tip.style.opacity = "0";
      const st = $("sigma-status");
      if (st) st.textContent = "";
      sigmaRenderer.refresh();
    });
    container.addEventListener("mousemove", (ev) => {
      const tip = document.getElementById("sigma-node-tooltip");
      if (tip && tip.style.opacity === "1") {
        tip.style.left = ev.clientX + 14 + "px";
        tip.style.top = ev.clientY - 8 + "px";
      }
    });

    sigmaRenderer.on("clickNode", ({ node }) => {
      if (suppressNodeClick) {
        suppressNodeClick = false;
        return;
      }
      const attrs = sigmaGraph.getNodeAttributes(node);
      showNodeDetail(attrs.raw || { id: node });
      focusNodeId = node;
      runImpactPreview(node);
    });

    if (sigmaRenderer.getCamera) {
      setTimeout(
        () => sigmaRenderer.getCamera().animatedReset({ duration: 500 }),
        80,
      );
    }

    if (truncated) {
      $("sigma-status").textContent =
        `Mostrati ${nodes.length} di ${totalFiltered} nodi. Affina i filtri o alza Max nodi (max ${SIGMA_MAX_NODES_CAP}).`;
    } else {
      const layoutHint = isFileView ? " · vista file" : "";
      const edgeNote =
        edgesAdded < edges.length
          ? ` (${edgesAdded} disegnati)`
          : showEdges
            ? ""
            : " (archi nascosti)";
      $("sigma-status").textContent =
        `${viewMode}: ${nodes.length} nodi · ${edges.length} archi${edgeNote}${layoutHint} · zoom · passa col mouse per nome · trascina nodi`;
    }
  }

  let _detailNode = null;
  let viewHistory = []; // stack per tasto Indietro

  function showNodeInfoBox(nodeId) {
    const infoEl = $("sigma-node-info");
    if (!infoEl || !sigmaGraph?.hasNode(nodeId)) return;
    const attrs = sigmaGraph.getNodeAttributes(nodeId);
    const raw = attrs.raw || {};
    const type = raw.type || "file";
    const label = raw.label || raw.qualifiedName || nodeId;
    const path = raw.filePath || raw.id || "";
    const deg = nodeDegrees.get(nodeId) || 0;
    const icon = $("sigma-node-info-icon");
    const lbl = $("sigma-node-info-label");
    const pth = $("sigma-node-info-path");
    const conn = $("sigma-node-info-conn");
    if (icon) {
      icon.textContent = type.slice(0, 2);
      icon.style.background = TYPE_COLORS[type] || TYPE_COLORS.default;
    }
    if (lbl) lbl.textContent = String(label).split(/[/\\]/).pop() || label;
    if (pth) pth.textContent = path;
    if (conn)
      conn.textContent = deg > 0 ? `${deg} connessioni` : "0 connessioni";
    infoEl.classList.remove("hidden");
  }
  function pushHistory() {
    const btn = $("sigma-back");
    if (btn) btn.disabled = false;
    viewHistory.push({
      nodes: fileViewData.nodes,
      edges: fileViewData.edges,
      viewMode,
      expandedFile,
      focusNodeId,
      hadHighlight: searchHighlightSet.size > 0,
    });
    if (viewHistory.length > 10) viewHistory.shift();
  }
  async function showNodeDetail(n) {
    const panel = $("sigma-detail");
    if (!panel) return;
    _detailNode = n;
    panel.classList.remove("hidden");
    showNodeInfoBox(normPath(n.id));
    $("sigma-detail-title").textContent =
      `${n.label || n.id} (${n.type || "?"})`;
    const isFile = n.type === "file";
    const actions = $("sigma-detail-actions");
    if (actions) actions.style.display = isFile ? "block" : "none";
    const links = await api(
      "/api/graph/api-links",
      undefined,
      "Collegamenti API",
    ).catch(() => ({ links: [] }));
    const related = (links.links || []).filter(
      (l) =>
        l.clientFile === n.filePath ||
        l.backendFile === n.filePath ||
        l.clientFunction === n.label,
    );
    const detailBody = $("sigma-detail-body");
    if (!detailBody) return;
    let html = `<p><strong>ID:</strong> ${escapeHtml(n.id)}</p>`;
    if (n.filePath)
      html += `<p><strong>Path:</strong> ${escapeHtml(n.filePath)}</p>`;
    if (n.group)
      html += `<p><strong>Gruppo:</strong> ${escapeHtml(n.group)}</p>`;
    if (n.visibility)
      html += `<p><strong>Visibilità:</strong> ${escapeHtml(n.visibility)}</p>`;
    if (n.endpoints?.length) {
      html += `<p><strong>Endpoint (${n.endpoints.length}):</strong></p><ul>`;
      n.endpoints.slice(0, 5).forEach((ep) => {
        html += `<li>${escapeHtml(ep.method || "GET")} ${escapeHtml(ep.path || ep)}</li>`;
      });
      if (n.endpoints.length > 5)
        html += `<li>… e altri ${n.endpoints.length - 5}</li>`;
      html += `</ul>`;
    }
    if (n.dtos?.length) {
      html += `<p><strong>DTO (${n.dtos.length}):</strong></p><ul>`;
      n.dtos.slice(0, 5).forEach((d) => (html += `<li>${escapeHtml(d)}</li>`));
      if (n.dtos.length > 5) html += `<li>… e altri ${n.dtos.length - 5}</li>`;
      html += `</ul>`;
    }
    if (n.methods?.length) {
      html += `<p><strong>Metodi (${n.methods.length}):</strong></p><ul>`;
      n.methods
        .slice(0, 5)
        .forEach(
          (m) =>
            (html += `<li>${escapeHtml(m.name || m)} (${escapeHtml(m.visibility || "public")})</li>`),
        );
      if (n.methods.length > 5)
        html += `<li>… e altri ${n.methods.length - 5}</li>`;
      html += `</ul>`;
    }
    if (related.length) {
      html += `<p><strong>API Links (${related.length}):</strong></p><ul>`;
      related
        .slice(0, 5)
        .forEach(
          (l) =>
            (html += `<li>${escapeHtml(l.label || l.backendFile || l.clientFile)}</li>`),
        );
      if (related.length > 5)
        html += `<li>… e altri ${related.length - 5}</li>`;
      html += `</ul>`;
    }
    detailBody.innerHTML = html;
  }

  $("sigma-detail-close")?.addEventListener("click", () => {
    $("sigma-detail")?.classList.add("hidden");
  });
  $("sigma-detail-expand")?.addEventListener("click", () => {
    if (_detailNode) {
      expandFile(
        _detailNode.id || _detailNode.fullPath || _detailNode.filePath,
      );
    }
  });

  async function runImpactPreview(nodeId) {
    const depth = $("sigma-impact-depth")?.value || 2;
    const dir = $("sigma-impact-dir")?.value || "downstream";
    const cross = $("sigma-cross-layer")?.checked ? "true" : "false";
    const data = await api(
      `/api/graph/impact-v2/${encodeURIComponent(nodeId)}?max_depth=${depth}&direction=${dir}&mode=transitive&cross_layer=${cross}`,
      undefined,
      "Anteprima impatto",
    );
    const el = $("sigma-impact-preview");
    if (!el) return;
    let html = `<strong>Impact ${dir}</strong> (${data.total} nodi)<ul>`;
    for (const [d, items] of Object.entries(data.impact || {})) {
      html += `<li>Distanza ${d}: ${items.map((x) => escapeHtml(x.label)).join(", ")}</li>`;
    }
    html += "</ul>";
    el.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function fileViewGraphPayload() {
    return {
      nodes: (fileViewData.nodes || []).map((n) => ({ ...n, type: "file" })),
      edges: fileViewData.edges || [],
    };
  }

  async function renderFileView() {
    if (!fileViewLoaded) {
      return loadFileView(true);
    }
    viewMode = "file";
    expandedFile = null;
    expandedGraphCache = null;
    if ($("sigma-collapse")) $("sigma-collapse").disabled = true;
    await renderGraph(fileViewGraphPayload(), "label");
    sigmaReady = true;
  }

  async function loadFileView(force) {
    viewMode = "file";
    expandedFile = null;
    expandedGraphCache = null;
    focusNodeId = null;
    if ($("sigma-collapse")) $("sigma-collapse").disabled = true;
    if ($("sigma-full-detail")) $("sigma-full-detail").disabled = false;
    if (!fileViewLoaded || force) {
      const data = await api("/api/graph/file", undefined, "Vista file");
      if (data.error) {
        $("sigma-status").textContent = data.error;
        return;
      }
      fileViewData = data;
      fileViewLoaded = true;
    }
    const payload = fileViewGraphPayload();
    populateZoneFilters(fileViewData?.nodes || []);
    await renderGraph(payload, "label");
    sigmaReady = true;
  }

  function clearSigmaFilters() {
    if ($("sigma-search")) $("sigma-search").value = "";
    msProjectCombo?.reset();
    msFolderCombo?.reset();
    if ($("sigma-filter-project")) $("sigma-filter-project").value = "";
    if ($("sigma-filter-folder")) $("sigma-filter-folder").value = "";
    if ($("sigma-min-weight")) $("sigma-min-weight").value = "0";
    if ($("sigma-max-nodes")) $("sigma-max-nodes").value = "0";
    if ($("sigma-hide-private")) $("sigma-hide-private").checked = true;
    if ($("sigma-zone-view")) $("sigma-zone-view").checked = true;
    document.querySelectorAll("[data-sigma-type]").forEach((cb) => {
      cb.checked = true;
    });
    if ($("sigma-path-from")) $("sigma-path-from").value = "";
    if ($("sigma-path-to")) $("sigma-path-to").value = "";
    if ($("sigma-path-result")) $("sigma-path-result").textContent = "";
    $("sigma-detail")?.classList.add("hidden");
    const impact = $("sigma-impact-preview");
    if (impact) impact.innerHTML = "";
  }

  async function resetSigmaView() {
    searchMode = false;
    searchHighlightSet.clear();
    clearSigmaFilters();
    focusNodeId = null;
    detailCache = null;
    await loadFileView(true);
  }

  async function rerenderCurrentView() {
    if (viewMode === "file") {
      await renderFileView();
    } else if (viewMode === "expanded" && expandedGraphCache) {
      await renderGraph(
        { nodes: expandedGraphCache.nodes, edges: expandedGraphCache.edges },
        "label",
      );
    } else if (viewMode === "full" && detailCache) {
      await renderGraph(detailCache, "label");
    }
  }

  function onSigmaTabShown() {
    populateFuncSelect();
    if (!sigmaReady) {
      loadFileView(false);
      return;
    }
    if (sigmaRenderer) {
      try {
        sigmaRenderer.refresh();
        setTimeout(() => {
          sigmaRenderer.getCamera().animatedReset({ duration: 300 });
        }, 100);
      } catch (_) {}
    }
  }

  async function expandFile(filePath) {
    viewMode = "expanded";
    expandedFile = filePath;
    $("sigma-detail")?.classList.add("hidden");
    const impact = $("sigma-impact-preview");
    if (impact) impact.innerHTML = "";
    if ($("sigma-collapse")) $("sigma-collapse").disabled = false;
    const data = await api(
      `/api/graph/expand?file=${encodeURIComponent(filePath)}`,
      undefined,
      "Espansione file",
    );
    if (data.error) {
      $("sigma-status").textContent = data.error;
      return;
    }
    const inner = data.nodes || [];
    const innerIds = new Set(inner.map((n) => n.id));
    const crossEdges = (data.edges || []).filter(
      (e) => !innerIds.has(e.source) || !innerIds.has(e.target),
    );
    const fileNode = fileViewData.nodes.find((n) => n.id === filePath) || {
      id: filePath,
      label: filePath.split("/").pop(),
      type: "file",
      filePath,
    };
    const graphPayload = {
      nodes: [fileNode, ...inner],
      edges: data.edges || [],
    };
    expandedGraphCache = {
      filePath,
      nodes: graphPayload.nodes,
      edges: graphPayload.edges,
    };
    pushHistory();
    await renderGraph(graphPayload, "label");
    sigmaReady = true;
    $("sigma-status").textContent =
      `Expanded: ${filePath} — ${inner.length} nodi interni`;
  }

  async function loadFullDetail() {
    viewMode = "full";
    expandedFile = null;
    if ($("sigma-collapse")) $("sigma-collapse").disabled = false;
    if ($("sigma-full-detail")) $("sigma-full-detail").disabled = true;
    if (!detailCache) {
      detailCache = await api(
        "/api/graph/detail",
        undefined,
        "Grafo dettagliato",
      );
    }
    if (detailCache.error) {
      $("sigma-status").textContent = detailCache.error;
      return;
    }
    pushHistory();
    await renderGraph(detailCache, "label");
    sigmaReady = true;
  }

  async function searchAndFocus() {
    const q = ($("sigma-search")?.value || "").trim();
    if (!q) return;
    searchMode = true;
    const res = await api(
      `/api/graph/search?q=${encodeURIComponent(q)}&limit=20`,
      undefined,
      "Ricerca nodi",
    );
    let results = res.results || [];
    // Se il backend (mock) non filtra, filtra client-side
    if (results.length > 10) {
      const ql = q.toLowerCase();
      results = results.filter(
        (r) =>
          (r.label || "").toLowerCase().includes(ql) ||
          (r.id || "").toLowerCase().includes(ql),
      );
    }
    const first = results[0];
    if (!first) {
      $("sigma-status").textContent = "Nessun nodo trovato.";
      return;
    }
    focusNodeId = first.id;
    let nid = normPath(first.id);
    // Se l'ID esatto non è nel grafo, cerca fuzzy per label o ID
    if (sigmaGraph && !sigmaGraph.hasNode(nid)) {
      const fname = nid.split("/").pop().toLowerCase().replace(/\./g, "-");
      const qLabel = (first.label || "").toLowerCase();
      const allNodes = sigmaGraph.nodes();
      const byLabel = allNodes.find((n) => {
        const a = sigmaGraph.getNodeAttributes(n);
        return (a.label || "").toLowerCase() === qLabel;
      });
      const byIdEnd = allNodes.find((n) => n.toLowerCase().endsWith(fname));
      const byIdContains = allNodes.find((n) =>
        n.toLowerCase().includes(fname),
      );
      const found = byLabel || byIdEnd || byIdContains;
      if (found) nid = found;
    }

    function relocateSearchCluster() {
      if (!sigmaGraph || searchHighlightSet.size === 0) return;
      // Centroide del cluster
      let cx = 0,
        cy = 0,
        n = 0;
      sigmaGraph.nodes().forEach((nid) => {
        if (searchHighlightSet.has(nid)) {
          cx += sigmaGraph.getNodeAttribute(nid, "x");
          cy += sigmaGraph.getNodeAttribute(nid, "y");
          n++;
        }
      });
      if (n === 0) return;
      cx /= n;
      cy /= n;
      // Centroide degli altri nodi
      let ox = 0,
        oy = 0,
        m = 0;
      sigmaGraph.nodes().forEach((nid) => {
        if (!searchHighlightSet.has(nid)) {
          ox += sigmaGraph.getNodeAttribute(nid, "x");
          oy += sigmaGraph.getNodeAttribute(nid, "y");
          m++;
        }
      });
      if (m === 0) return;
      ox /= m;
      oy /= m;
      // Vettore dai nodi esterni verso il cluster → spingi il cluster oltre
      let dx = cx - ox,
        dy = cy - oy;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      dx /= dist;
      dy /= dist;
      const shift = Math.max(300, dist * 0.6);
      searchHighlightSet.forEach((nid) => {
        const x = sigmaGraph.getNodeAttribute(nid, "x");
        const y = sigmaGraph.getNodeAttribute(nid, "y");
        sigmaGraph.setNodeAttribute(nid, "x", x + dx * shift);
        sigmaGraph.setNodeAttribute(nid, "y", y + dy * shift);
      });
    }

    function applySearchHighlight(nodeId) {
      if (!sigmaGraph || !sigmaGraph.hasNode(nodeId)) return;
      const highlightEnabled = $("sigma-highlight-found")?.checked ?? true;
      searchHighlightSet.clear();
      if (!highlightEnabled) {
        try {
          sigmaGraph.nodes().forEach((nid) => {
            const raw = sigmaGraph.getNodeAttribute(nid, "raw");
            const originalColor = TYPE_COLORS[raw?.type] || TYPE_COLORS.default;
            const deg = nodeDegrees.get(nid) || 0;
            const effDeg = Math.min(deg, 10);
            const originalSize = Math.max(
              3,
              nodePixelSize(sigmaGraph.order, viewMode === "file") +
                effDeg * 0.6,
            );
            sigmaGraph.setNodeAttribute(nid, "color", originalColor);
            sigmaGraph.setNodeAttribute(nid, "size", originalSize);
          });
          sigmaGraph.edges().forEach((eid) => {
            sigmaGraph.setEdgeAttribute(eid, "color", null);
          });
          sigmaRenderer?.refresh();
        } catch (_) {}
        return;
      }
      try {
        searchHighlightSet.add(nodeId);
        const attrs = sigmaGraph.getNodeAttributes(nodeId);
        sigmaGraph.setNodeAttribute(nodeId, "color", "#000000");
        sigmaGraph.setNodeAttribute(nodeId, "size", (attrs.size || 5) + 20);
        sigmaGraph.edges().forEach((eid) => {
          const src = sigmaGraph.source(eid);
          const tgt = sigmaGraph.target(eid);
          if (src === nodeId || tgt === nodeId) {
            sigmaGraph.setEdgeAttribute(eid, "color", "#000000");
            const neighborId = src === nodeId ? tgt : src;
            if (sigmaGraph.hasNode(neighborId)) {
              const na = sigmaGraph.getNodeAttributes(neighborId);
              sigmaGraph.setNodeAttribute(neighborId, "color", "#333333");
              sigmaGraph.setNodeAttribute(
                neighborId,
                "size",
                (na.size || 5) + 6,
              );
              searchHighlightSet.add(neighborId);
            }
          }
        });
        relocateSearchCluster();
        sigmaRenderer?.refresh();
      } catch (err) {
        console.warn("[search] highlight error:", err);
      }
    }

    function focusCameraOnNode(nodeId) {
      if (!sigmaRenderer) return;
      sigmaRenderer.getCamera().animatedReset({ duration: 400 });
    }

    if (sigmaGraph && sigmaGraph.hasNode(nid)) {
      applySearchHighlight(nid);
      focusCameraOnNode(nid);
      $("sigma-status").textContent = `Focus: ${first.label} (${first.type})`;
      return;
    }
    // Se siamo in file view o full detail, ricarica la vista corrente con focusNodeId
    if (viewMode === "file") {
      await renderGraph(fileViewGraphPayload(), "label");
      fitGraphWithPadding(400);
    } else if (viewMode === "full") {
      if (!detailCache) {
        detailCache = await api(
          "/api/graph/detail",
          undefined,
          "Grafo dettagliato",
        );
      }
      await renderGraph(detailCache, "label");
      fitGraphWithPadding(400);
    } else if (first.type === "file" || first.filePath) {
      await expandFile(first.filePath || first.id);
      fitGraphWithPadding(400);
    }
    // Dopo renderGraph evidenzia e sposta la camera sul nodo
    applySearchHighlight(nid);
    focusCameraOnNode(nid);
    $("sigma-status").textContent = `Focus: ${first.label} (${first.type})`;
  }

  async function tracePath() {
    const src = ($("sigma-path-from")?.value || "").trim();
    const tgt = ($("sigma-path-to")?.value || "").trim();
    if (!src || !tgt) return;
    const cross = $("sigma-cross-layer")?.checked ? "true" : "false";
    const data = await api(
      `/api/graph/path?source=${encodeURIComponent(src)}&target=${encodeURIComponent(tgt)}&cross_layer=${cross}`,
      undefined,
      "Percorso API",
    );
    const el = $("sigma-path-result");
    if (!el) return;
    if (!data.found) {
      el.textContent = "Percorso non trovato.";
      return;
    }
    el.innerHTML = data.path
      .map((p) => `<span class="path-hop">${escapeHtml(p.label)}</span>`)
      .join(" → ");
    focusNodeId = data.path[0]?.id;
  }

  /** Multi-select combo con ricerca — usato per progetto e cartella */
  function makeMsCombo(inputId, dropId, tagsId, hiddenId, onChangeCallback) {
    const qInput = $(inputId);
    const drop = $(dropId);
    const tagsEl = $(tagsId);
    const hidden = $(hiddenId);
    if (!qInput || !drop || !tagsEl || !hidden) return { setOptions: () => {} };

    let allOptions = [];
    let selected = new Set();

    function renderTags() {
      tagsEl.innerHTML = "";
      selected.forEach((v) => {
        const tag = document.createElement("span");
        tag.className = "ms-combo-tag";
        tag.textContent = v;
        const btn = document.createElement("button");
        btn.textContent = "×";
        btn.onclick = (e) => {
          e.stopPropagation();
          selected.delete(v);
          commit();
        };
        tag.appendChild(btn);
        tagsEl.appendChild(tag);
      });
      qInput.placeholder = selected.size
        ? ""
        : qInput.closest(".ms-combo").dataset.placeholder || "";
    }

    function renderDrop(q) {
      drop.innerHTML = "";
      const ql = (q || "").toLowerCase();
      const filtered = ql
        ? allOptions.filter((o) => o.toLowerCase().includes(ql))
        : allOptions;
      if (!filtered.length) {
        drop.innerHTML =
          "<div class='ms-combo-opt' style='color:#888'>Nessun risultato</div>";
        return;
      }
      filtered.forEach((opt) => {
        const div = document.createElement("div");
        div.className = "ms-combo-opt" + (selected.has(opt) ? " selected" : "");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = selected.has(opt);
        const lbl = document.createTextNode(opt);
        div.appendChild(cb);
        div.appendChild(lbl);
        div.onclick = () => {
          if (selected.has(opt)) selected.delete(opt);
          else selected.add(opt);
          commit();
          renderDrop(qInput.value);
        };
        drop.appendChild(div);
      });
    }

    function commit() {
      hidden.value = [...selected].join("|");
      renderTags();
      onChangeCallback();
    }

    const comboEl = qInput.closest(".ms-combo");
    qInput.addEventListener("focus", () => {
      renderDrop(qInput.value);
      drop.classList.add("open");
      comboEl?.classList.add("open");
    });
    qInput.addEventListener("input", () => renderDrop(qInput.value));
    qInput.addEventListener("blur", () => {
      setTimeout(() => {
        drop.classList.remove("open");
        comboEl?.classList.remove("open");
      }, 150);
    });
    drop.addEventListener("mousedown", (e) => e.preventDefault());

    function setOptions(opts) {
      allOptions = [...new Set(opts)].sort();
      selected = new Set([...selected].filter((s) => allOptions.includes(s)));
      renderTags();
    }

    function reset() {
      selected.clear();
      hidden.value = "";
      renderTags();
    }

    return { setOptions, reset };
  }

  let msProjectCombo, msFolderCombo;

  function initMsCombos() {
    msProjectCombo = makeMsCombo(
      "sigma-filter-project-q",
      "ms-project-drop",
      "ms-project-tags",
      "sigma-filter-project",
      () => rerenderCurrentView(),
    );
    msFolderCombo = makeMsCombo(
      "sigma-filter-folder-q",
      "ms-folder-drop",
      "ms-folder-tags",
      "sigma-filter-folder",
      () => rerenderCurrentView(),
    );
  }

  /** Popola le opzioni dei combo da un elenco di nodi */
  function populateZoneFilters(nodeList) {
    const projects = new Set();
    const folders = new Set();
    (nodeList || []).forEach((n) => {
      const { project, folder } = nodeZone(normPath(n.id));
      if (project) projects.add(project);
      if (folder) folders.add(folder);
    });
    msProjectCombo?.setOptions([...projects]);
    msFolderCombo?.setOptions([...folders]);
  }

  function bindFilters() {
    initMsCombos();
    document
      .querySelectorAll(
        "[data-sigma-type], #sigma-hide-private, #sigma-min-weight, #sigma-max-nodes, #sigma-show-labels, #sigma-show-edges, #sigma-zone-view",
      )
      .forEach((el) => {
        el.addEventListener("change", () => {
          rerenderCurrentView();
        });
      });
  }

  let _funcList = [];
  async function populateFuncSelect() {
    const sel = $("sigma-func-select");
    if (!sel || sel.dataset.loaded) return;
    try {
      const data = await api("/api/functions", undefined, "Funzionalità");
      _funcList = (data.functions || []).filter((f) => f.validated !== false);
      sel.innerHTML =
        '<option value="">Tutte</option>' +
        _funcList
          .map(
            (f) =>
              `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name || f.id)}</option>`,
          )
          .join("");
      sel.dataset.loaded = "1";
    } catch (_) {}
  }
  $("sigma-func-select")?.addEventListener("change", (e) => {
    const id = e.target.value;
    if (!id) {
      resetSigmaView();
      return;
    }
    const func = _funcList.find((f) => f.id === id);
    if (func) showFunction(func);
  });

  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.tab === "sigma") onSigmaTabShown();
    });
  });

  function fitGraphWithPadding(duration) {
    if (!sigmaRenderer || !sigmaGraph || sigmaGraph.order === 0) return;
    sigmaRenderer.getCamera().animatedReset({ duration: duration || 300 });
  }

  $("sigma-fit")?.addEventListener("click", () => fitGraphWithPadding(300));
  $("sigma-reset")?.addEventListener("click", () => resetSigmaView());
  $("sigma-collapse")?.addEventListener("click", () => renderFileView());
  $("sigma-full-detail")?.addEventListener("click", () => loadFullDetail());
  $("sigma-search-btn")?.addEventListener("click", searchAndFocus);
  $("sigma-path-btn")?.addEventListener("click", tracePath);
  $("sigma-search")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchAndFocus();
  });
  $("sigma-node-info-close")?.addEventListener("click", () => {
    $("sigma-node-info")?.classList.add("hidden");
  });

  $("sigma-detail-view-graph")?.addEventListener("click", async () => {
    if (!_detailNode || !sigmaGraph) return;
    $("sigma-detail")?.classList.add("hidden");
    const nid = normPath(_detailNode.id);
    if (!sigmaGraph.hasNode(nid)) return;
    // Trova nodi e archi del vicinato
    const neighborIds = new Set([nid]);
    sigmaGraph.edges().forEach((eid) => {
      const src = sigmaGraph.source(eid);
      const tgt = sigmaGraph.target(eid);
      if (src === nid) neighborIds.add(tgt);
      if (tgt === nid) neighborIds.add(src);
    });
    const subNodes = (fileViewData.nodes || []).filter((n) =>
      neighborIds.has(normPath(n.id)),
    );
    const subNodeIds = new Set(subNodes.map((n) => normPath(n.id)));
    const subEdges = (fileViewData.edges || []).filter((e) => {
      const from = normPath(e.from || e.source);
      const to = normPath(e.to || e.target);
      return subNodeIds.has(from) && subNodeIds.has(to);
    });
    pushHistory();
    await renderGraph({ nodes: subNodes, edges: subEdges }, "label");
    focusNodeId = nid;
    showNodeInfoBox(nid);
    sigmaReady = true;
    $("sigma-status").textContent =
      `Grafo di ${subNodes.length} nodi, ${subEdges.length} archi`;
  });

  $("sigma-back")?.addEventListener("click", async () => {
    if (!viewHistory.length) return;
    const prev = viewHistory.pop();
    const btn = $("sigma-back");
    if (btn) btn.disabled = viewHistory.length === 0;
    fileViewData.nodes = prev.nodes;
    fileViewData.edges = prev.edges;
    viewMode = prev.viewMode;
    expandedFile = prev.expandedFile;
    focusNodeId = prev.focusNodeId;
    await renderGraph(fileViewGraphPayload(), "label");
    sigmaReady = true;
    if (prev.hadHighlight && focusNodeId && sigmaGraph?.hasNode(focusNodeId)) {
      applySearchHighlight(focusNodeId);
    }
    $("sigma-detail")?.classList.add("hidden");
    $("sigma-node-info")?.classList.add("hidden");
  });

  populateFuncSelect();

  async function showFunction(func) {
    if (!fileViewLoaded) await renderFileView();
    const files = new Set(func.files || []);
    const filteredNodes = (fileViewData.nodes || []).filter((n) =>
      files.has(n.id),
    );
    const presentTypes = new Set(filteredNodes.map((n) => n.type || "file"));
    document.querySelectorAll("[data-sigma-type]").forEach((cb) => {
      cb.checked = presentTypes.has(cb.dataset.sigmaType);
    });
    const nodeIds = new Set(filteredNodes.map((n) => normPath(n.id)));
    const filteredEdges = (fileViewData.edges || []).filter((e) => {
      const from = normPath(e.from || e.source);
      const to = normPath(e.to || e.target);
      return nodeIds.has(from) && nodeIds.has(to);
    });
    viewMode = "file";
    expandedFile = null;
    if ($("sigma-collapse")) $("sigma-collapse").disabled = true;
    pushHistory();
    await renderGraph({ nodes: filteredNodes, edges: filteredEdges }, "label");
    sigmaReady = true;
    $("sigma-status").textContent =
      `Funzionalità: ${func.name} — ${filteredNodes.length} file, ${filteredEdges.length} archi`;
    const sel = $("sigma-func-select");
    if (sel) sel.value = func.id;
  }

  bindFilters();
  window.chSigmaView = {
    loadFileView,
    renderFileView,
    resetSigmaView,
    expandFile,
    loadFullDetail,
    searchAndFocus,
    onSigmaTabShown,
    showFunction,
  };
})();
