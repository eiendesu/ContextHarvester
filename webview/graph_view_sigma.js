(function () {
  const vscode = acquireVsCodeApi();

  let graph = { nodes: [], edges: [] };
  let renderer = null;

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
    "#60a5fa",
    "#34d399",
    "#fbbf24",
    "#f472b6",
    "#a78bfa",
    "#fb7185",
    "#22c55e",
    "#38bdf8",
    "#f97316",
    "#2dd4bf",
  ];

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
    // If nodes already have coordinates (x,y) use them, otherwise apply circular layout
    const havePos = nodes.every(
      (n) => typeof n.x === "number" && typeof n.y === "number",
    );
    if (havePos) return nodes.map((n) => ({ ...n, x: n.x, y: n.y }));
    const n = nodes.length || 1;
    const out = nodes.map((node, i) => {
      const angle = (2 * Math.PI * i) / n;
      const r = 0.7 * (1 - 0.2 * (i % 5));
      return { ...node, x: Math.cos(angle) * r, y: Math.sin(angle) * r };
    });
    return out;
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

    const q = $search?.value || "";
    const gf = $filterGroup?.value || "";
    const data = buildVisData(q, gf);

    if (renderer) {
      try {
        renderer.kill();
      } catch {}
      renderer = null;
    }

    // Build a graphology graph
    const Graph = graphology.Graph;
    const g = new Graph({ type: "directed" });

    const laid = layoutNodes(data.nodes);

    for (const n of laid) {
      const size = Math.max(1, Number(n.value || n.size || 1));
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
          size: e.weight || 1,
          color: e.confidence === "INFERRED" ? "#9ca3af" : e.color || "#6b7280",
          type: "arrow",
        });
      } catch {
        // ignore duplicates
      }
    });

    const container = document.getElementById("graph-container");
    // Sigma renderer settings tuned for better contrast and label rendering
    renderer = new Sigma(g, container, {
      renderLabels: true,
      renderEdgeLabels: false,
      labelRenderedSizeThreshold: 0,
      labelDensity: 0.2,
      labelGridCellSize: 64,
      labelFont: "Arial, Helvetica, sans-serif",
      labelSize: 12,
      labelWeight: "600",
      labelColor: { color: "#e5e7eb" },
      defaultNodeColor: "#60a5fa",
      defaultEdgeColor: "#9ca3af",
      defaultNodeType: "circle",
      defaultEdgeType: "curve",
      minEdgeSize: 0.6,
      maxEdgeSize: 3,
      zIndex: true,
      hideEdgesOnMove: false,
      hideLabelsOnMove: false,
      stagePadding: 20,
    });

    // Click / double-click open file
    renderer.on &&
      renderer.on("clickNode", ({ node }) => {
        try {
          const attrs = g.getNodeAttributes(node);
          vscode.postMessage({ type: "openFile", path: attrs.file || node });
        } catch {}
      });
    renderer.on &&
      renderer.on("doubleClickNode", ({ node }) => {
        try {
          const attrs = g.getNodeAttributes(node);
          vscode.postMessage({ type: "openFile", path: attrs.file || node });
        } catch {}
      });

    // Hover / highlight behavior: enlarge node and brighten connected edges
    const origNodeSizes = new Map();
    const origEdgeColors = new Map();

    if (renderer.on) {
      renderer.on("enterNode", ({ node }) => {
        try {
          const attrs = g.getNodeAttributes(node);
          origNodeSizes.set(node, attrs.size || 1);
          g.setNodeAttribute(
            node,
            "size",
            Math.max(2, (attrs.size || 1) * 1.6),
          );

          g.forEachEdge((edge, edgeAttrs, source, target) => {
            if (source === node || target === node) {
              origEdgeColors.set(edge, edgeAttrs.color || "#9ca3af");
              g.setEdgeAttribute(edge, "color", "#ffffff");
              g.setEdgeAttribute(edge, "size", (edgeAttrs.size || 1) * 1.2);
            }
          });
          renderer.refresh();
        } catch {}
      });

      renderer.on("leaveNode", ({ node }) => {
        try {
          if (origNodeSizes.has(node)) {
            g.setNodeAttribute(node, "size", origNodeSizes.get(node));
            origNodeSizes.delete(node);
          }
          g.forEachEdge((edge, edgeAttrs) => {
            if (origEdgeColors.has(edge)) {
              g.setEdgeAttribute(edge, "color", origEdgeColors.get(edge));
              origEdgeColors.delete(edge);
            }
          });
          renderer.refresh();
        } catch {}
      });
    }

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

  function updateSelection(node) {
    if (!node) {
      if ($details) $details.textContent = "Seleziona un nodo";
      if ($btnOpen) $btnOpen.disabled = true;
      if ($btnSeed) $btnSeed.disabled = true;
      return;
    }
    if ($details) {
      $details.innerHTML = `<b>${escapeHtml(node.label)}</b><br/>File: ${escapeHtml(node.file)}<br/>Group: ${escapeHtml(node.group || "-")}`;
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

  $search?.addEventListener("input", () => render());
  $filterGroup?.addEventListener("change", () => render());

  $btnOpen?.addEventListener("click", () => {
    // try to open selected node via sigma selection is not implemented here
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
