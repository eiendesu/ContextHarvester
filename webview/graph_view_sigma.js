(function () {
  const vscode = acquireVsCodeApi();

  let graph = { nodes: [], edges: [] };
  let renderer = null;
  let hoveredNode = null;
  let hoveredNeighbors = new Set();
  let lastClickedNode = null;

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

  function colorForGroup(group) {
    const g = String(group ?? "unassigned");
    let hash = 0;
    for (let i = 0; i < g.length; i++)
      hash = (hash * 31 + g.charCodeAt(i)) >>> 0;
    return palette[hash % palette.length];
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

  function layoutNodes(nodes) {
    const havePos = nodes.every(
      (n) => typeof n.x === "number" && typeof n.y === "number",
    );
    if (havePos) {
      // Normalize pre-existing positions to a consistent [-10, 10] range
      const xs = nodes.map((n) => n.x);
      const ys = nodes.map((n) => n.y);
      const minX = Math.min(...xs),
        maxX = Math.max(...xs);
      const minY = Math.min(...ys),
        maxY = Math.max(...ys);
      const rangeX = maxX - minX || 1;
      const rangeY = maxY - minY || 1;
      return nodes.map((n) => ({
        ...n,
        x: ((n.x - minX) / rangeX - 0.5) * 20,
        y: ((n.y - minY) / rangeY - 0.5) * 20,
      }));
    }
    // Random spread layout — much better than circular for large graphs
    const spread = Math.max(10, Math.sqrt(nodes.length) * 1.6);
    return nodes.map((node) => ({
      ...node,
      x: (Math.random() - 0.5) * spread * 2,
      y: (Math.random() - 0.5) * spread * 2,
    }));
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

  function render() {
    if (
      !$container ||
      typeof Sigma === "undefined" ||
      typeof graphology === "undefined"
    ) {
      if ($subtitle) $subtitle.textContent = "sigma non caricato";
      return;
    }

    hoveredNode = null;
    hoveredNeighbors = new Set();
    lastClickedNode = null;
    updateSelection(null);

    const q = $search?.value || "";
    const gf = $filterGroup?.value || "";
    const data = buildVisData(q, gf);

    if (renderer) {
      try {
        renderer.kill();
      } catch {}
      renderer = null;
    }

    const Graph = graphology.Graph;
    const g = new Graph({ type: "directed" });

    const laid = layoutNodes(data.nodes);

    // Compute degree for each node to scale sizes
    const degreeMap = new Map();
    for (const e of data.edges) {
      degreeMap.set(e.from, (degreeMap.get(e.from) || 0) + 1);
      degreeMap.set(e.to, (degreeMap.get(e.to) || 0) + 1);
    }
    const maxDeg = Math.max(...(degreeMap.size ? degreeMap.values() : [1]));

    for (const n of laid) {
      const deg = degreeMap.get(n.id) || 0;
      const size = 2 + (deg / maxDeg) * 8;
      const color = n.color || colorForGroup(n.group);
      g.addNode(n.id, {
        label: n.label || n.id,
        x: typeof n.x === "number" ? n.x : 0,
        y: typeof n.y === "number" ? n.y : 0,
        size,
        color,
        file: n.file || n.id,
        group: n.group,
      });
    }

    data.edges.forEach((e, idx) => {
      try {
        g.addEdgeWithKey(`e${idx}`, e.from, e.to, {
          label: e.label || "",
          size: 0.5,
          color: EDGE_DEFAULT_COLOR,
          type: "arrow",
        });
      } catch {
        // ignore duplicates
      }
    });

    const container = document.getElementById("graph-container");

    renderer = new Sigma(g, container, {
      renderLabels: true,
      renderEdgeLabels: false,
      labelRenderedSizeThreshold: 5,
      labelDensity: 0.8,
      labelGridCellSize: 80,
      labelFont: "Arial, Helvetica, sans-serif",
      labelSize: 12,
      labelWeight: "600",
      labelColor: { color: "#e2e8f0" },
      defaultNodeColor: "#818cf8",
      defaultEdgeColor: EDGE_DEFAULT_COLOR,
      defaultNodeType: "circle",
      defaultEdgeType: "arrow",
      minEdgeSize: 0.3,
      maxEdgeSize: 3,
      zIndex: true,
      hideEdgesOnMove: false,
      hideLabelsOnMove: false,
      stagePadding: 30,

      // use-reducers storybook style: dim non-neighbors on hover
      nodeReducer(node, data) {
        const res = { ...data };
        if (hoveredNode) {
          if (node === hoveredNode) {
            res.highlighted = true;
            res.size = (data.size || 2) * 1.6;
            res.zIndex = 1;
          } else if (hoveredNeighbors.has(node)) {
            res.zIndex = 1;
          } else {
            res.label = "";
            res.color = NODE_DIM_COLOR;
            res.size = Math.max(1, (data.size || 2) * 0.5);
          }
        }
        return res;
      },

      edgeReducer(edge, data) {
        const res = { ...data };
        if (hoveredNode) {
          const [src, tgt] = g.extremities(edge);
          if (src === hoveredNode || tgt === hoveredNode) {
            res.color = EDGE_HOVER_COLOR;
            res.size = (data.size || 0.5) * 3;
            res.zIndex = 1;
          } else {
            res.hidden = true;
          }
        }
        return res;
      },
    });

    renderer.on("enterNode", ({ node }) => {
      hoveredNode = node;
      hoveredNeighbors = new Set(g.neighbors(node));
      renderer.refresh();
      try {
        const attrs = g.getNodeAttributes(node);
        const nodeData = {
          label: attrs.label,
          file: attrs.file,
          group: attrs.group,
        };
        switchTab("nodo");
        updateSelection(nodeData);
      } catch {}
    });

    renderer.on("leaveNode", () => {
      hoveredNode = null;
      hoveredNeighbors = new Set();
      renderer.refresh();
    });

    renderer.on("clickNode", ({ node }) => {
      try {
        const attrs = g.getNodeAttributes(node);
        lastClickedNode = {
          label: attrs.label,
          file: attrs.file,
          group: attrs.group,
        };
        vscode.postMessage({ type: "openFile", path: attrs.file || node });
      } catch {}
    });

    renderer.on("doubleClickNode", ({ node }) => {
      try {
        const attrs = g.getNodeAttributes(node);
        vscode.postMessage({ type: "openFile", path: attrs.file || node });
      } catch {}
    });

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

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }
  function escapeAttr(s) {
    return escapeHtml(s).replaceAll('"', "&quot;");
  }

  // ── Tab bar wiring ──────────────────────────────────────────
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
