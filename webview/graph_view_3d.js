/* Context Harvester — 3D Force Graph viewer for VS Code webview */
(function () {
  const vscode = acquireVsCodeApi();

  let graph = { nodes: [], edges: [] };
  let renderer = null;
  let hoveredNode = null;
  let lastClickedNode = null;
  let highlightState = new Map();

  const $container = document.getElementById("graph-container");
  const $subtitle = document.getElementById("graph-subtitle");
  const $statNodes = document.getElementById("stat-nodes");
  const $statEdges = document.getElementById("stat-edges");
  const $search = document.getElementById("search");
  const $filterGroup = document.getElementById("filter-group");
  const $details = document.getElementById("node-details");
  const $btnOpen = document.getElementById("btn-open");
  const $btnSeed = document.getElementById("btn-seed");

  const palette = [
    "#818cf8",
    "#34d399",
    "#fbbf24",
    "#f472b6",
    "#a78bfa",
    "#fb7185",
    "#22d3ee",
    "#38bdf8",
    "#f97316",
    "#4ade80",
  ];

  const EDGE_DEFAULT_COLOR = "#475569";
  const EDGE_HOVER_COLOR = "#93c5fd";
  const NODE_DIM_COLOR = "#1e293b";

  const EDGE_COLOR_BY_TYPE = {
    contains: "#666666",
    imports: "#44b4ff",
    calls: "#ffaa00",
    http_calls: "#ff4444",
    http_calls_inferred: "#ff8888",
    references: "#22d3ee",
    served_by: "#4ade80",
    maps_to_file: "#475569",
    uses_component: "#a78bfa",
    uses_hook: "#fb7185",
  };

  function colorForGroup(group) {
    const g = String(group ?? "unassigned");
    let hash = 0;
    for (let i = 0; i < g.length; i++)
      hash = (hash * 31 + g.charCodeAt(i)) >>> 0;
    return palette[hash % palette.length];
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }
  function escapeAttr(s) {
    return escapeHtml(s).replaceAll('"', "&quot;");
  }

  function buildVisData(filterQ, groupFilter) {
    const q = (filterQ || "").toLowerCase();
    const nodes = graph.nodes.filter((n) => {
      if (groupFilter && String(n.group) !== groupFilter) return false;
      if (!q) return true;
      return (
        String(n.label || "")
          .toLowerCase()
          .includes(q) ||
        String(n.id || "")
          .toLowerCase()
          .includes(q) ||
        String(n.file || "")
          .toLowerCase()
          .includes(q)
      );
    });
    const ids = new Set(nodes.map((n) => n.id));
    const edges = graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    return { nodes, edges };
  }

  function populateGroupFilter() {
    if (!$filterGroup) return;
    const groups = [
      ...new Set(graph.nodes.map((n) => String(n.group || "unassigned"))),
    ].sort();
    $filterGroup.innerHTML =
      '<option value="">Tutte</option>' +
      groups
        .map(
          (g) => `<option value="${escapeAttr(g)}">${escapeHtml(g)}</option>`,
        )
        .join("");
  }

  function destroyRenderer() {
    if (renderer) {
      try {
        renderer.pauseAnimation();
      } catch {}
      try {
        renderer._destructor && renderer._destructor();
      } catch {}
      renderer = null;
    }
    if ($container) $container.innerHTML = "";
  }

  function render() {
    if (!$container || typeof ForceGraph3D === "undefined") {
      if ($subtitle) $subtitle.textContent = "3d-force-graph non caricato";
      return;
    }

    hoveredNode = null;
    lastClickedNode = null;
    highlightState.clear();
    updateSelection(null);

    const q = $search?.value || "";
    const gf = $filterGroup?.value || "";
    const data = buildVisData(q, gf);

    destroyRenderer();

    // Compute degrees
    const degreeMap = new Map();
    for (const e of data.edges) {
      degreeMap.set(e.from, (degreeMap.get(e.from) || 0) + 1);
      degreeMap.set(e.to, (degreeMap.get(e.to) || 0) + 1);
    }
    const maxDeg = Math.max(...(degreeMap.size ? degreeMap.values() : [1]));

    // Build 3d-force-graph data
    const gNodes = data.nodes.map((n) => {
      const deg = degreeMap.get(n.id) || 0;
      return {
        id: n.id,
        name: n.label || n.id,
        val: 2 + (deg / maxDeg) * 8,
        color: n.color || colorForGroup(n.group),
        file: n.file || n.id,
        group: n.group,
        x: typeof n.x === "number" ? (n.x / 10 - 0.5) * 20 : undefined,
        y: typeof n.y === "number" ? (n.y / 10 - 0.5) * 20 : undefined,
        z: 0,
      };
    });

    const gLinks = data.edges.map((e, idx) => ({
      id: `e${idx}`,
      source: e.from,
      target: e.to,
      type: e.type || e.label || "",
      color: EDGE_COLOR_BY_TYPE[e.type || e.label] || EDGE_DEFAULT_COLOR,
      width: 0.5,
    }));

    renderer = ForceGraph3D()($container)
      .graphData({ nodes: gNodes, links: gLinks })
      .backgroundColor("#08090f")
      .showNavInfo(false)
      .nodeLabel((n) => `${n.name}\n${n.file}`)
      .nodeColor((n) => {
        const hi = highlightState.get(n.id);
        return hi?.color || n.color;
      })
      .nodeVal((n) => {
        const hi = highlightState.get(n.id);
        return hi?.val != null ? hi.val : n.val;
      })
      .linkColor((l) => {
        const hi = highlightState.get(l.id);
        return hi?.color || l.color;
      })
      .linkWidth((l) => {
        const hi = highlightState.get(l.id);
        return hi?.width != null ? hi.width : l.width;
      })
      .linkOpacity(0.6)
      .onNodeClick((n) => {
        lastClickedNode = { label: n.name, file: n.file, group: n.group };
        switchTab("nodo");
        updateSelection(lastClickedNode);
        vscode.postMessage({ type: "openFile", path: n.file || n.id });
      })
      .onNodeHover((n) => {
        if (n) {
          hoveredNode = n.id;
          const nodeData = { label: n.name, file: n.file, group: n.group };
          switchTab("nodo");
          updateSelection(nodeData);
          applyHoverHighlight(n.id);
        } else {
          hoveredNode = null;
          clearHighlight();
        }
      });

    // Configure forces
    renderer.d3Force("charge").strength(-120);
    renderer.d3Force("link").distance((l) => 50);
    renderer.cameraPosition({ z: Math.max(200, gNodes.length * 2) });

    if ($subtitle) {
      $subtitle.textContent = gf
        ? `Gruppo: ${gf}`
        : q
          ? `Ricerca: ${q}`
          : "Tutti i nodi";
    }
    if ($statNodes) $statNodes.textContent = String(data.nodes.length);
    if ($statEdges) $statEdges.textContent = String(data.edges.length);
  }

  function applyHoverHighlight(nodeId) {
    if (!renderer) return;
    highlightState.clear();
    const gData = renderer.graphData();
    if (!gData) return;

    // Highlight hovered node
    highlightState.set(nodeId, { color: "#ffffff", val: 12 });

    // Find neighbors and highlight links
    gData.links.forEach((l) => {
      const src = typeof l.source === "object" ? l.source.id : l.source;
      const tgt = typeof l.target === "object" ? l.target.id : l.target;
      if (src === nodeId || tgt === nodeId) {
        highlightState.set(l.id, { color: EDGE_HOVER_COLOR, width: 2 });
        const neighborId = src === nodeId ? tgt : src;
        if (!highlightState.has(neighborId)) {
          const n = gData.nodes.find((x) => x.id === neighborId);
          highlightState.set(neighborId, {
            color: n?.color,
            val: (n?.val || 3) + 2,
          });
        }
      }
    });

    // Dim non-neighbors
    gData.nodes.forEach((n) => {
      if (!highlightState.has(n.id)) {
        highlightState.set(n.id, {
          color: NODE_DIM_COLOR,
          val: Math.max(1, n.val * 0.5),
        });
      }
    });
    gData.links.forEach((l) => {
      if (!highlightState.has(l.id)) {
        highlightState.set(l.id, { color: EDGE_DEFAULT_COLOR, width: 0.2 });
      }
    });

    renderer.refresh();
  }

  function clearHighlight() {
    highlightState.clear();
    renderer?.refresh();
  }

  function switchTab(name) {
    document
      .querySelectorAll(".tab")
      .forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    document
      .querySelectorAll(".tab-pane")
      .forEach((p) => p.classList.toggle("active", p.id === `pane-${name}`));
  }

  function updateSelection(node) {
    if (!node) {
      if ($details) {
        $details.className = "node-card";
        $details.innerHTML = `<div class="node-empty">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4">
            <circle cx="12" cy="12" r="3"/>
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/>
          </svg>
          <span>Passa il mouse su un nodo</span>
        </div>`;
      }
      if ($btnOpen) $btnOpen.disabled = true;
      if ($btnSeed) $btnSeed.disabled = true;
      return;
    }
    if ($details) {
      $details.className = "node-card populated";
      const fileParts = (node.file || "").replace(/\\/g, "/").split("/");
      const shortFile = fileParts.slice(-2).join("/") || node.file || "—";
      $details.innerHTML = `
        <div class="node-name">${escapeHtml(node.label)}</div>
        <div class="node-row">
          <span class="node-key">File</span>
          <span class="node-val" title="${escapeAttr(node.file || "")}">${escapeHtml(shortFile)}</span>
        </div>
        ${node.group ? `<span class="node-badge">${escapeHtml(node.group)}</span>` : ""}
      `;
    }
    if ($btnOpen) $btnOpen.disabled = false;
    if ($btnSeed) $btnSeed.disabled = false;
  }

  // Tab bar wiring
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  $search?.addEventListener("focus", () => switchTab("cerca"));
  $search?.addEventListener("input", () => render());
  $filterGroup?.addEventListener("change", () => render());

  $btnOpen?.addEventListener("click", () => {
    if (lastClickedNode) {
      vscode.postMessage({ type: "openFile", path: lastClickedNode.file });
    }
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "init" || msg.type === "refresh") {
      graph = msg.graph ?? { nodes: [], edges: [] };
      populateGroupFilter();
      render();
    }
  });
})();
