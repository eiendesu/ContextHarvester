/*
 * Context Harvester — 3D Force Graph viewer (replaces Sigma.js)
 *
 * Architecture choices:
 * 1. Vanilla 3d-force-graph (not react-force-graph): the existing codebase is
 *    plain HTML/JS without a React build pipeline. Adding React would require
 *    bundler infrastructure far beyond the scope of a rendering-layer swap.
 * 2. Grouping strategy: invisible "group anchor" nodes are injected in grouped
 *    mode, connected to every member with very short link distance. This lets
 *    the built-in d3-force-3d simulation create natural clusters without
 *    external plugins like d3-force-cluster or custom Three.js group meshes.
 *    Group labels are rendered as text sprites on the anchor nodes via
 *    nodeThreeObject, keeping the approach self-contained.
 * 3. Forces: charge repulsion is stronger in detail view (more nodes need
 *    spreading). Link distance is 30 for "contains" edges and 80–120 for
 *    semantic edges (calls/uses/inherits/imports), so structural containment
 *    stays tight while cross-file dependencies have breathing room.
 * 4. Search highlight: accessor functions (nodeColor, nodeVal, linkColor)
 *    read from a highlightState Map instead of mutating the graph. This avoids
 *    rebuilding graphData on every highlight change and keeps transitions smooth.
 * 5. Performance: linkDirectionalParticles is disabled when node count > 1000.
 *    In grouped mode with >500 nodes alphaDecay is increased so the layout
 *    converges faster. pauseAnimation()/resumeAnimation() are wired to tab
 *    visibility to save GPU cycles when the graph tab is hidden.
 */
(function () {
  const $ = (id) => document.getElementById(id);

  /* ── State ────────────────────────────────────────────── */
  let graph3d = null; // ForceGraph3D instance
  let fileViewData = { nodes: [], edges: [] };
  let fileViewLoaded = false;
  let expandedGraphCache = null;
  let detailCache = null;
  let viewMode = "file"; // file | expanded | full
  let displayMode = "normal"; // normal | grouped
  let expandedFile = null;
  let focusNodeId = null;
  let searchHighlightSet = new Set();
  let highlightState = new Map(); // nodeId/linkKey -> { color, val, opacity }
  let nodeDegrees = new Map();
  let viewHistory = [];
  let _detailNode = null;
  let _funcList = [];
  let msProjectCombo, msFolderCombo;
  let searchMode = false;
  let isReady = false;
  let hoverNodeId = null;
  let _fullGraphData = null;

  /* Dynamic node size by degree (connections) */
  const DEFAULT_SIZE_CONFIG = [
    { min: 0, max: 0, radius: 4 },
    { min: 1, max: 3, radius: 7 },
    { min: 4, max: 7, radius: 12 },
    { min: 8, max: 12, radius: 19 },
    { min: 13, max: 15, radius: 26 },
  ];
  function loadSizeSettings() {
    try {
      const raw = localStorage.getItem("ch_node_size_config");
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return DEFAULT_SIZE_CONFIG;
  }
  function loadLabelScale() {
    try {
      const raw = localStorage.getItem("ch_node_label_scale");
      if (raw) return parseFloat(raw);
    } catch (_) {}
    return 1.0;
  }
  let nodeSizeConfig = loadSizeSettings();
  let nodeLabelScale = loadLabelScale();
  let tempNodeSizeConfig = JSON.parse(JSON.stringify(nodeSizeConfig));
  let tempNodeLabelScale = nodeLabelScale;

  function getNodeRadius(deg) {
    const d = Math.min(deg || 0, 15);
    for (const cfg of nodeSizeConfig) {
      if (d >= cfg.min && d <= cfg.max) return cfg.radius;
    }
    return 5;
  }

  function getLabelFontSize(r) {
    return Math.max(8, r * 1.4) * nodeLabelScale;
  }

  /* ── Hierarchical expansion state ─────────────────────── */
  let expandedNodes = new Set(); // ids of expanded parent nodes
  let nodePositionCache = new Map(); // id -> {x,y,z}
  let allNodesForHierarchy = []; // all raw nodes to build children map
  let allEdgesForHierarchy = []; // all raw edges

  function buildChildrenMap(nodes) {
    const map = new Map(); // parentId -> [childIds]
    const parentOf = new Map(); // childId -> parentId
    const levelOf = new Map(); // nodeId -> level
    const allIds = new Set(nodes.map((n) => normPath(n.id)));

    // First pass: detect parent->child links via fullPath reference
    nodes.forEach((n) => {
      const nid = normPath(n.id);
      const fp = normPath(n.fullPath || "");
      if (fp && fp !== nid && allIds.has(fp)) {
        // This node is a child of the node whose id == fp
        if (!map.has(fp)) map.set(fp, []);
        map.get(fp).push(nid);
        parentOf.set(nid, fp);
      }
    });

    // Second pass: nodes not listed as children are roots (level 0)
    nodes.forEach((n) => {
      const nid = normPath(n.id);
      if (!parentOf.has(nid)) {
        levelOf.set(nid, 0);
      } else {
        levelOf.set(nid, 1);
      }
    });

    return { map, parentOf, levelOf };
  }

  function getVisibleNodes(
    allNodes,
    childrenMap,
    parentMap,
    levelMap,
    collapsed,
  ) {
    const visibleIds = new Set();
    allNodes.forEach((n) => {
      const nid = normPath(n.id);
      if (!collapsed) {
        // Show everything when collapsed mode is OFF
        visibleIds.add(nid);
        return;
      }
      const level = levelMap.get(nid) ?? 0;
      if (level === 0) {
        visibleIds.add(nid);
      } else {
        const pid = parentMap.get(nid);
        if (pid && expandedNodes.has(pid)) visibleIds.add(nid);
      }
    });
    return visibleIds;
  }

  function seedChildrenRadial(parentNode, childNodes, cache) {
    const count = childNodes.length;
    if (!count) return;
    const radius = Math.max(50, 18 * count);
    childNodes.forEach((child, i) => {
      if (cache.has(child.id)) return; // preserve existing position
      const angle = (i / count) * Math.PI * 2;
      child.x = (parentNode.x || 0) + Math.cos(angle) * radius;
      child.y = (parentNode.y || 0) + Math.sin(angle) * radius;
      child.z = (parentNode.z || 0) + (Math.random() - 0.5) * radius * 0.35;
    });
  }

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

  /* ── Constants ────────────────────────────────────────── */
  const LINK_COLOR_BY_TYPE = {
    contains: "#666666",
    imports: "#44b4ff",
    calls: "#ffaa00",
    uses: "#cc77ff",
    inherits: "#44ffaa",
    http_calls: "#2ec4b6",
    http_calls_inferred: "#f97316",
  };

  const NODE_DIM_COLOR = "#2d3f55";
  const EDGE_DIM_COLOR = "#263042";
  const SEARCH_HI_COLOR = "#ffeb3b";
  const SEARCH_CONN_COLOR = "#ffa500";

  const VAL_BY_TYPE = {
    method: 1,
    field: 2,
    class: 3,
    dto: 3,
    api_client_method: 2,
    api_endpoint: 3,
    file: 5,
    api_client_file: 5,
    folder: 7,
    project: 10,
  };

  const DEFAULT_TYPES = {
    file: true,
    class: true,
    method: true,
    dto: true,
    api_client_file: true,
    api_client_method: true,
    api_endpoint: true,
  };

  const SIGMA_MAX_NODES_CAP = 100000;

  /* ── Color Manager (centralized) ──────────────────────── */
  const colorManager = {
    palette: [
      "#4e79a7",
      "#f28e2b",
      "#e15759",
      "#76b7b2",
      "#59a14f",
      "#edc948",
      "#b07aa1",
      "#ff9da7",
      "#9c755f",
      "#bab0ac",
      "#00b4d8",
      "#90e0ef",
      "#f72585",
      "#7209b7",
      "#3a0ca3",
      "#4361ee",
      "#4cc9f0",
      "#06d6a0",
      "#ffd166",
      "#ef476f",
    ],
    maps: {
      community: {},
      project: {},
      folder: {},
      nodeType: {
        file: "#4e79a7",
        class: "#f28e2b",
        method: "#59a14f",
        dto: "#76b7b2",
        api_client_file: "#e15759",
        api_client_method: "#edc948",
        api_endpoint: "#b07aa1",
        field: "#ff9da7",
        folder: "#9c755f",
        project: "#bab0ac",
        default: "#888888",
      },
    },
    getColor(value, mapName) {
      if (!value || value === "unassigned" || value === "other" || value === "")
        return "#444444";
      const map = this.maps[mapName];
      if (!map) return "#888888";
      if (!map[value]) {
        const idx = Object.keys(map).length % this.palette.length;
        map[value] = this.palette[idx];
      }
      return map[value];
    },
    buildFromData(nodes) {
      nodes.forEach((n) => {
        if (n.group) this.getColor(n.group, "community");
        if (n.project) this.getColor(n.project, "project");
        if (n.folder) this.getColor(n.folder, "folder");
      });
    },
  };

  let currentColorMode = $("sigma-color-by")?.value || "type";

  function getNodeColor(node, mode) {
    const hi = highlightState.get(node.id);
    if (hi?.color) return hi.color;
    if (node.isAnchor) return "rgba(0,0,0,0)";
    switch (mode) {
      case "community":
        return colorManager.getColor(node.group, "community");
      case "project":
        return colorManager.getColor(node.project, "project");
      case "folder":
        return colorManager.getColor(node.folder, "folder");
      case "type":
      default:
        return colorManager.maps.nodeType[node.type] || "#888888";
    }
  }

  function nodeColorForDisplay(n) {
    return getNodeColor(n, currentColorMode);
  }

  /* ── Helpers ────────────────────────────────────────────── */
  function normPath(id) {
    return String(id || "").replace(/\\/g, "/");
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function parseMaxNodes() {
    const raw = parseInt($("sigma-max-nodes")?.value ?? "0", 10);
    if (!Number.isFinite(raw) || raw <= 0) return Infinity;
    return Math.min(raw, SIGMA_MAX_NODES_CAP);
  }

  function nodeZone(nodeId) {
    const parts = String(nodeId || "")
      .replace(/\\/g, "/")
      .split("/");
    const project = parts[0] || "other";
    const folder = parts.length > 2 ? parts.slice(1, -1).join("/") : "";
    return { project, folder };
  }

  function api(path, opts, label) {
    const mock = IS_MOCK ? mockUrl(path) : null;
    if (mock) return fetch(mock, opts).then((r) => r.json());
    if (window.chProgress?.fetchJson) {
      return window.chProgress.fetchJson(path, opts, label);
    }
    return fetch(path, opts).then((r) => r.json());
  }

  function mockUrl(path) {
    for (const [prefix, mock] of Object.entries(MOCK_MAP)) {
      if (path.startsWith(prefix)) return mock;
    }
    return null;
  }

  /* ── Filters (preserved from sigma-view.js) ─────────────── */
  function getFilters() {
    const types = {};
    document.querySelectorAll("[data-sigma-type]").forEach((cb) => {
      types[cb.dataset.sigmaType] = cb.checked;
    });
    const zoneModeEl = document.querySelector(
      'input[name="zone-mode"]:checked',
    );
    const zoneMode = zoneModeEl ? zoneModeEl.value : "off";
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
      collapsed: $("sigma-collapsed")?.checked ?? true,
      layoutStyle: $("sigma-layout-style")?.value || "cloud",
      useZones: zoneMode !== "off",
      filterProject: ($("sigma-filter-project")?.value || "").trim(),
      filterFolder: ($("sigma-filter-folder")?.value || "").trim(),
      filterGroup: ($("sigma-filter-group")?.value || "").trim(),
      groupBy:
        zoneMode === "off"
          ? "community"
          : zoneMode === "project"
            ? "project"
            : zoneMode,
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
    if (f.filterGroup) {
      const groups = f.filterGroup
        .split("|")
        .map((s) => s.toLowerCase())
        .filter(Boolean);
      const nodeGroup = (
        n.group ||
        nodeZone(normPath(n.id)).project ||
        ""
      ).toLowerCase();
      if (groups.length && !groups.some((g) => nodeGroup === g)) return false;
    }
    if (!f.query) return true;
    const hay =
      `${n.label || ""} ${n.qualifiedName || ""} ${n.filePath || ""} ${n.id || ""}`.toLowerCase();
    return hay.includes(f.query);
  }

  /* ── 3D Graph Rendering ─────────────────────────────────── */
  function destroyGraph() {
    if (graph3d) {
      try {
        graph3d.pauseAnimation();
        graph3d._destructor && graph3d._destructor();
      } catch {}
      graph3d = null;
    }
    const container = $("sigma-container");
    if (container) container.innerHTML = "";
    hoverNodeId = null;
  }

  /* (colorByType / colorByGroup / old nodeColorForDisplay removed — now centralized in colorManager) */

  function valByType(type) {
    return VAL_BY_TYPE[type] || 3;
  }

  function edgeColor(e) {
    const t = e.type || e.label;
    return LINK_COLOR_BY_TYPE[t] || LINK_COLOR_BY_TYPE.contains;
  }

  function edgeWidth(e) {
    const t = e.type || e.label;
    return t === "contains" ? 1 : 2;
  }

  function shouldShowParticles(e, nodeCount) {
    if (nodeCount > 1000) return false;
    const t = e.type || e.label;
    return t === "calls" || t === "imports" || t === "http_calls";
  }

  /** Build the data set consumed by 3d-force-graph */
  function buildGraphData(rawNodes, rawEdges, f, viewModeName) {
    const filtered = rawNodes.filter((n) => nodePasses(n, f));
    let nodes = filtered;
    let truncated = false;
    if (Number.isFinite(f.maxNodes) && nodes.length > f.maxNodes) {
      nodes = nodes.slice(0, f.maxNodes);
      truncated = true;
    }

    const idSet = new Set(nodes.map((n) => normPath(n.id)));
    const edges = (rawEdges || []).filter((e) => {
      const from = normPath(e.from || e.source);
      const to = normPath(e.to || e.target);
      if (!idSet.has(from) || !idSet.has(to)) return false;
      return (e.weight || 1) >= f.minWeight;
    });

    // Compute degrees
    nodeDegrees = new Map();
    nodes.forEach((n) => nodeDegrees.set(normPath(n.id), 0));
    edges.forEach((e) => {
      const from = normPath(e.from || e.source);
      const to = normPath(e.to || e.target);
      if (nodeDegrees.has(from))
        nodeDegrees.set(from, nodeDegrees.get(from) + 1);
      if (nodeDegrees.has(to)) nodeDegrees.set(to, nodeDegrees.get(to) + 1);
    });

    // Build 3d-force-graph nodes — derive project/folder from fullPath
    const gNodes = nodes.map((n) => {
      const nid = normPath(n.id);
      const deg = nodeDegrees.get(nid) || 0;
      const baseVal = valByType(n.type);
      // Cap degree at 15 for sizing; store raw deg too
      const cappedDeg = Math.min(deg, 15);
      const val = Math.min(baseVal + cappedDeg * 0.5, 14);
      const label = n.label || nid;
      const shortLabel = String(label).split(/[/\\]/).pop() || label;
      const fp = n.fullPath || nid;
      const { project, folder } = nodeZone(fp);
      const group = n.group || project || "other";
      return {
        id: nid,
        name: shortLabel,
        fullLabel: label,
        type: n.type || "file",
        val,
        filePath: fp,
        group,
        project,
        folder,
        raw: n,
        deg,
      };
    });

    // Pre-populate colorManager from all displayed nodes
    colorManager.buildFromData(gNodes);

    // Build links
    const gLinks = edges.map((e, i) => ({
      id: `l${i}`,
      source: normPath(e.from || e.source),
      target: normPath(e.to || e.target),
      type: e.type || e.label || "contains",
      weight: e.weight || 1,
      color: edgeColor(e),
      width: edgeWidth(e),
    }));

    // If every node has the same group, grouped mode becomes a hairball.
    const uniqueGroups = new Set(gNodes.map((n) => n.group));
    const isSingleGroup = uniqueGroups.size <= 1;
    if (isSingleGroup && displayMode === "grouped") displayMode = "normal";

    // Compute stable group centroids from ALL filtered nodes (not just visible)
    const groupCentroids = {};
    const groupList = [...uniqueGroups];
    const clusterRadius = Math.max(800, groupList.length * 140);
    groupList.forEach((g, i) => {
      const angle = (i / groupList.length) * 2 * Math.PI;
      groupCentroids[g] = {
        x: Math.cos(angle) * clusterRadius,
        y: Math.sin(angle) * clusterRadius,
        z: (Math.random() - 0.5) * 80,
      };
    });

    // ── Layout-aware initial seeding ──
    const layout = f.layoutStyle || "cloud";
    const count = gNodes.length;

    if (layout === "cloud") {
      // Large random sphere, no grouping bias
      const spread = Math.max(2000, Math.sqrt(count) * 40);
      gNodes.forEach((n) => {
        if (typeof n.x !== "number") n.x = (Math.random() - 0.5) * spread;
        if (typeof n.y !== "number") n.y = (Math.random() - 0.5) * spread;
        if (typeof n.z !== "number") n.z = (Math.random() - 0.5) * spread;
      });
    } else if (layout === "cluster") {
      // Seed near group centroid + jitter
      const jitter = displayMode === "grouped" ? 300 : 600;
      gNodes.forEach((n) => {
        const c = groupCentroids[n.group || "other"];
        if (typeof n.x !== "number")
          n.x = (c?.x || 0) + (Math.random() - 0.5) * jitter;
        if (typeof n.y !== "number")
          n.y = (c?.y || 0) + (Math.random() - 0.5) * jitter;
        if (typeof n.z !== "number")
          n.z = (c?.z || 0) + (Math.random() - 0.5) * jitter * 0.6;
      });
    } else if (layout === "radial") {
      // Each group is a ring; leader near center, others around
      const groupsArr = [...new Set(gNodes.map((n) => n.group || "other"))];
      const maxR = Math.max(600, groupsArr.length * 180);
      groupsArr.forEach((g, gi) => {
        const groupNodes = gNodes.filter(
          (n) => (n.group || "other") === g && !n.isAnchor,
        );
        const ringR = ((gi + 1) / groupsArr.length) * maxR;
        groupNodes.forEach((n, i) => {
          const a = (i / Math.max(groupNodes.length, 1)) * 2 * Math.PI;
          if (typeof n.x !== "number") n.x = Math.cos(a) * ringR;
          if (typeof n.y !== "number") n.y = Math.sin(a) * ringR;
          if (typeof n.z !== "number") n.z = (Math.random() - 0.5) * 60;
        });
      });
    } else if (layout === "hierarchical" || layout === "tree") {
      // Vertical layers: level 0 at top, level 1 below, etc.
      const levelSpacing = layout === "tree" ? 200 : 140;
      const nodesByLevel = new Map();
      gNodes.forEach((n) => {
        const lvl = n.level ?? 0;
        if (!nodesByLevel.has(lvl)) nodesByLevel.set(lvl, []);
        nodesByLevel.get(lvl).push(n);
      });
      nodesByLevel.forEach((levelNodes, lvl) => {
        const y = -lvl * levelSpacing;
        const width = Math.max(600, levelNodes.length * 40);
        levelNodes.forEach((n, i) => {
          if (typeof n.x !== "number")
            n.x = (i / Math.max(levelNodes.length - 1, 1) - 0.5) * width;
          if (typeof n.y !== "number") n.y = y + (Math.random() - 0.5) * 40;
          if (typeof n.z !== "number") n.z = (Math.random() - 0.5) * 80;
        });
      });
    }

    // Build id→gNode map for fast lookups
    const gNodeById = new Map(gNodes.map((n) => [n.id, n]));

    // Grouped mode: inject invisible anchor nodes + strong links
    if (displayMode === "grouped") {
      const groups = new Map(); // groupKey -> { project, folder, nodeIds: [] }
      gNodes.forEach((n) => {
        if (n.isAnchor) return;
        const key = n.group || "other";
        if (!groups.has(key)) {
          const { project, folder } = nodeZone(n.id);
          groups.set(key, { project, folder, nodeIds: [] });
        }
        groups.get(key).nodeIds.push(n.id);
      });

      groups.forEach((info, key) => {
        const anchorId = `_group_${key}`;
        let cx = 0,
          cy = 0,
          cz = 0;
        info.nodeIds.forEach((id) => {
          const n = gNodes.find((x) => x.id === id);
          if (n) {
            cx += n.x || 0;
            cy += n.y || 0;
            cz += n.z || 0;
          }
        });
        const count = info.nodeIds.length || 1;
        cx /= count;
        cy /= count;
        cz /= count;

        gNodes.push({
          id: anchorId,
          name: key,
          type: "_anchor",
          val: 0,
          color: "rgba(0,0,0,0)",
          isAnchor: true,
          anchorGroup: key,
          x: cx || (Math.random() - 0.5) * 200,
          y: cy || (Math.random() - 0.5) * 200,
          z: cz || (Math.random() - 0.5) * 200,
        });

        info.nodeIds.forEach((id) => {
          gLinks.push({
            id: `ga_${key}_${id}`,
            source: anchorId,
            target: id,
            type: "_group_anchor",
            weight: 5,
            color: "rgba(0,0,0,0)",
            width: 0,
          });
        });
      });
    }

    /* ── Hierarchical filtering & positioning ─────────────── */
    const { map: childrenMap, parentOf, levelOf } = buildChildrenMap(rawNodes);
    gNodes.forEach((n) => {
      n.level = levelOf.get(n.id) ?? 0;
      n.parentId = parentOf.get(n.id) || null;
      n.hasChildren = (childrenMap.get(n.id)?.length || 0) > 0;
      n.childrenCount = childrenMap.get(n.id)?.length || 0;
    });

    const visibleIds = getVisibleNodes(
      rawNodes,
      childrenMap,
      parentOf,
      levelOf,
      f.collapsed,
    );
    let visibleNodes = gNodes.filter((n) => visibleIds.has(n.id));

    // Restore cached positions
    visibleNodes.forEach((n) => {
      const cached = nodePositionCache.get(n.id);
      if (cached) {
        n.x = cached.x;
        n.y = cached.y;
        n.z = cached.z;
      }
    });

    // Seed radial positions for newly expanded children (detail view hierarchy)
    expandedNodes.forEach((pid) => {
      const parentNode = visibleNodes.find((n) => n.id === pid);
      if (!parentNode) return;
      const childIds = childrenMap.get(pid) || [];
      const children = visibleNodes.filter((n) => childIds.includes(n.id));
      seedChildrenRadial(parentNode, children, nodePositionCache);
    });

    // ── Group-based collapsed view for "Solo file" + grouped mode ──
    // When showing only files and grouping is active, collapsed mode hides
    // all but the "leader" (most connected node) of each group.
    // Double-clicking any node in an expanded group collapses it again.
    if (f.collapsed && displayMode === "grouped" && viewModeName === "file") {
      const leaders = new Map(); // group -> { id, deg }
      visibleNodes.forEach((n) => {
        if (n.isAnchor) return;
        const g = n.group || "other";
        const cur = leaders.get(g);
        if (!cur || (n.deg || 0) > cur.deg) {
          leaders.set(g, { id: n.id, deg: n.deg || 0 });
        }
      });
      const expandedGroups = new Set();
      expandedNodes.forEach((eid) => {
        const en = visibleNodes.find((n) => n.id === eid);
        if (en) expandedGroups.add(en.group || "other");
      });
      visibleNodes = visibleNodes.filter((n) => {
        if (n.isAnchor) return true; // keep anchors
        const g = n.group || "other";
        if (expandedGroups.has(g)) return true;
        return n.id === leaders.get(g)?.id;
      });
      // Mark leaders so UI knows they can be expanded
      visibleNodes.forEach((n) => {
        const g = n.group || "other";
        if (n.id === leaders.get(g)?.id) {
          const total = gNodes.filter(
            (x) => !x.isAnchor && (x.group || "other") === g,
          ).length;
          n.hasChildren = total > 1;
          n.childrenCount = total - 1;
        }
      });
    }

    // Fallback random seed for nodes without position
    const spread2 = displayMode === "grouped" ? 2000 : 2500;
    visibleNodes.forEach((n) => {
      if (typeof n.x !== "number") n.x = (Math.random() - 0.5) * spread2;
      if (typeof n.y !== "number") n.y = (Math.random() - 0.5) * spread2;
      if (typeof n.z !== "number") n.z = (Math.random() - 0.5) * spread2;
    });

    // Keep group anchors that still have visible members
    const visibleGroups = new Set(visibleNodes.map((n) => n.group));
    const extraAnchors = gNodes.filter(
      (n) => n.isAnchor && visibleGroups.has(n.anchorGroup),
    );
    extraAnchors.forEach((a) => {
      if (!visibleNodes.some((n) => n.id === a.id)) visibleNodes.push(a);
    });

    // Filter links to visible nodes only
    const visibleNodeIds = new Set(visibleNodes.map((n) => n.id));
    const visibleLinks = gLinks.filter((l) => {
      const s = typeof l.source === "object" ? l.source.id : l.source;
      const t = typeof l.target === "object" ? l.target.id : l.target;
      return visibleNodeIds.has(s) && visibleNodeIds.has(t);
    });

    return {
      nodes: visibleNodes,
      links: visibleLinks,
      truncated,
      nodeCount: visibleNodes.length,
      groupCentroids,
    };
  }

  /** Create a text sprite for group labels */
  function makeTextSprite(text, color = "#e2e8f0", fontSize = 18) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const scale = 2;
    ctx.font = `bold ${fontSize * scale}px Inter, sans-serif`;
    const metrics = ctx.measureText(text);
    canvas.width = metrics.width + 20;
    canvas.height = fontSize * scale + 10;
    ctx.font = `bold ${fontSize * scale}px Inter, sans-serif`;
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0.9,
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(canvas.width / 15, canvas.height / 15, 1);
    return sprite;
  }

  /** Create an outlined degree-label sprite that stays readable on any color */
  function makeDegreeLabelSprite(text, fontSize = 22) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const scale = 3;
    ctx.font = `bold ${fontSize * scale}px Inter, sans-serif`;
    const metrics = ctx.measureText(text);
    const w = metrics.width + 24;
    const h = fontSize * scale + 16;
    canvas.width = w;
    canvas.height = h;
    ctx.font = `bold ${fontSize * scale}px Inter, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // Dark outline for contrast
    ctx.lineWidth = fontSize * scale * 0.15;
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.lineJoin = "round";
    ctx.strokeText(text, w / 2, h / 2);
    // White fill
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, w / 2, h / 2);
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 1.0,
      depthTest: false, // always on top of the sphere
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(w / 7, h / 7, 1);
    return sprite;
  }

  async function waitForLibrary(timeoutMs = 10000) {
    if (typeof ForceGraph3D !== "undefined") return true;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (typeof ForceGraph3D !== "undefined") return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  async function renderGraph(data, labelKey) {
    // Save positions before destroying so they survive re-renders
    if (graph3d) {
      try {
        graph3d.graphData().nodes.forEach((n) => {
          if (n.x != null && n.y != null && n.z != null) {
            nodePositionCache.set(n.id, { x: n.x, y: n.y, z: n.z });
          }
        });
      } catch (_) {}
    }
    destroyGraph();
    const container = $("sigma-container");
    const ready = await waitForLibrary();
    if (!ready) {
      $("sigma-status").textContent =
        "3d-force-graph non caricato. Verifica /vendor/force-graph/.";
      return;
    }
    if (!container) return;

    const f = getFilters();
    displayMode = f.useZones ? "grouped" : "normal";
    allNodesForHierarchy = data.nodes || [];
    allEdgesForHierarchy = data.edges || [];
    const { nodes, links, truncated, nodeCount, groupCentroids } =
      buildGraphData(data.nodes || [], data.edges || [], f, viewMode);

    searchHighlightSet.clear();
    highlightState.clear();

    const buildTask = window.chProgress?.begin("Rendering grafo 3D…", 0);
    buildTask?.set(20, "Inizializzazione motore…");

    // Background: very dark but not pure black for better contrast
    const bgColor = "#060712";

    _fullGraphData = { nodes, links };
    graph3d = ForceGraph3D()(container)
      .graphData({ nodes, links })
      .backgroundColor(bgColor)
      .showNavInfo(false)
      .nodeLabel((n) => "")
      .nodeColor((n) => nodeColorForDisplay(n))
      .nodeVal((n) => {
        const hi = highlightState.get(n.id);
        if (hi?.val != null) return hi.val;
        if (n.isAnchor) return 0;
        return Math.min(n.val * 1.2, 14); // slightly larger, cap at 14
      })
      .nodeOpacity((n) => {
        const hi = highlightState.get(n.id);
        if (hi?.opacity != null) return hi.opacity;
        if (n.isAnchor) return 0;
        return 0.95; // slightly less opaque for better depth
      })
      .nodeThreeObject((n) => {
        if (n.isAnchor) {
          return makeTextSprite(n.name, "#e2e8f0", 16);
        }
        const rawDeg = n.deg || 0;
        const deg = Math.min(rawDeg, 15);
        const r = getNodeRadius(deg);
        const color = nodeColorForDisplay(n);
        const geometry = new THREE.SphereGeometry(r, 12, 12);
        const material = new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.92,
        });
        const sphere = new THREE.Mesh(geometry, material);
        return sphere;
      })
      .linkColor((l) => {
        const hi = highlightState.get(l.id);
        if (hi?.color) return hi.color;
        if (l.type === "_group_anchor") return "rgba(0,0,0,0)";
        return l.color;
      })
      .linkOpacity((l) => {
        const hi = highlightState.get(l.id);
        if (hi?.opacity != null) return hi.opacity;
        if (l.type === "_group_anchor") return 0;
        if (!f.showEdges) return 0;
        // Subtle edges — visible but not distracting
        if (displayMode === "normal") return 0.035;
        return 0.09;
      })
      .linkWidth((l) => {
        if (l.type === "_group_anchor") return 0;
        const hi = highlightState.get(l.id);
        if (hi?.width != null) return hi.width;
        return 0.4; // thin but visible lines
      })
      .linkDirectionalArrowLength((l) => {
        // Arrows disabled to reduce visual clutter; nodes are the focus
        return 0;
      })
      .linkDirectionalArrowRelPos(1)
      .linkDirectionalArrowColor((l) => l.color)
      .linkDirectionalParticles((l) => {
        // Particles disabled to reduce visual clutter
        return 0;
      })
      .linkDirectionalParticleSpeed((l) => {
        if (l.type === "imports") return 0.008;
        return 0.005;
      })
      .linkDirectionalParticleColor((l) => l.color)
      .linkDirectionalParticleWidth((l) => Math.max(1, l.width))
      .onNodeClick((n) => handleNodeClick(n))
      .onNodeHover((n) => handleNodeHover(n));

    // Configure forces — layout-aware force profiles
    buildTask?.set(40, "Configurazione forze…");
    const layout = f.layoutStyle || "cloud";
    const sliderVal = parseFloat($("sigma-repulsion")?.value ?? "400");
    const baseCharge = -Math.max(200, Math.min(1200, sliderVal));

    // ── 1. Center force ──
    const centerForce = graph3d.d3Force("center");
    if (centerForce) {
      if (layout === "cloud") {
        centerForce.strength(0.0005); // very weak, let repulsion dominate
      } else if (layout === "radial") {
        centerForce.strength(0.008); // keep rings circular
      } else if (layout === "hierarchical" || layout === "tree") {
        centerForce.strength(0.015); // stronger, keep levels aligned
      } else {
        centerForce.strength(0.001); // cluster default
      }
      graph3d.d3Force("center", centerForce);
    }

    // ── 2. Charge (repulsion) ──
    let chargeStrength;
    if (layout === "cloud") {
      chargeStrength = baseCharge * 2.0; // very strong repulsion
    } else if (layout === "cluster") {
      chargeStrength =
        displayMode === "grouped" ? baseCharge * 1.6 : baseCharge;
    } else if (layout === "radial") {
      chargeStrength = baseCharge * 0.8; // moderate
    } else if (layout === "hierarchical") {
      chargeStrength = baseCharge * 0.4; // low, keep layers intact
    } else if (layout === "tree") {
      chargeStrength = baseCharge * 0.25; // very low
    }
    graph3d.d3Force("charge").strength(chargeStrength);

    // ── 3. Collision force ──
    const collideForce =
      graph3d.d3Force("collide") ||
      (window.d3 && window.d3.forceCollide ? window.d3.forceCollide() : null);
    if (collideForce) {
      collideForce
        .radius((n) => {
          if (n.isAnchor) return 0;
          const deg = Math.min(n.deg || 0, 15);
          return getNodeRadius(deg) + 1.5;
        })
        .strength(layout === "cloud" ? 0.95 : layout === "tree" ? 0.6 : 0.9);
      graph3d.d3Force("collide", collideForce);
    }

    // ── 4. Link springs ──
    graph3d.d3Force("link").distance((l) => {
      if (l.type === "_group_anchor") return 20;
      const lvl = l.level || 0;
      if (layout === "tree") {
        return lvl >= 1 ? 35 : 70;
      } else if (layout === "hierarchical") {
        return lvl >= 1 ? 40 : 90;
      } else if (layout === "radial") {
        return lvl >= 1 ? 50 : 70;
      } else if (layout === "cloud") {
        return lvl >= 1 ? 55 : 130;
      }
      return displayMode === "grouped" ? 110 : 80;
    });
    let linkStrength;
    if (layout === "cloud") linkStrength = 0.02;
    else if (layout === "cluster") linkStrength = 0.05;
    else if (layout === "radial") linkStrength = 0.12;
    else if (layout === "hierarchical") linkStrength = 0.2;
    else if (layout === "tree") linkStrength = 0.3;
    graph3d.d3Force("link").strength(linkStrength);

    // ── 5. Zone force (cluster attraction) ──
    const groupBy = f.groupBy || "community";
    if (layout === "cloud" || layout === "tree") {
      // No zone force — let repulsion dominate
      removeZoneForce(graph3d);
    } else if (
      layout === "cluster" ||
      layout === "radial" ||
      layout === "hierarchical"
    ) {
      const muXY =
        layout === "cluster" ? 0.38 : layout === "radial" ? 0.25 : 0.06;
      const muZ =
        layout === "cluster" ? 0.12 : layout === "radial" ? 0.08 : 0.02;
      applyZoneForce(
        graph3d,
        nodes,
        groupBy,
        groupCentroids,
        displayMode,
        muXY,
        muZ,
      );
    }

    // ── 6. Layout-specific custom forces ──
    if (layout === "hierarchical" || layout === "tree") {
      // Pull each node toward its level's target Y (vertical layers)
      const levelSpacing = layout === "tree" ? 200 : 140;
      graph3d.d3Force("level", (alpha) => {
        graph3d.graphData().nodes.forEach((node) => {
          if (node.isAnchor) return;
          const lvl = node.level || 0;
          const targetY = -lvl * levelSpacing;
          node.vy += (targetY - node.y) * alpha * 0.35;
        });
      });
    } else if (layout === "radial") {
      // Pull each node toward its group's ring radius
      graph3d.d3Force("ring", (alpha) => {
        graph3d.graphData().nodes.forEach((node) => {
          if (node.isAnchor) return;
          const g = getGroupValue(node, groupBy);
          const c = groupCentroids[g];
          if (!c) return;
          const dx = node.x - c.x;
          const dy = node.y - c.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const targetR = Math.max(120, Math.sqrt(nodeCount) * 12);
          const diff = dist - targetR;
          node.vx -= (dx / dist) * diff * alpha * 0.12;
          node.vy -= (dy / dist) * diff * alpha * 0.12;
        });
      });
    } else {
      graph3d.d3Force("level", null);
      graph3d.d3Force("ring", null);
    }

    // ── 7. Damping ──
    if (layout === "cloud") {
      graph3d.d3AlphaDecay(0.02);
      graph3d.d3VelocityDecay(0.15);
    } else if (layout === "cluster") {
      graph3d.d3AlphaDecay(0.008);
      graph3d.d3VelocityDecay(0.3);
    } else if (layout === "radial") {
      graph3d.d3AlphaDecay(0.01);
      graph3d.d3VelocityDecay(0.25);
    } else if (layout === "hierarchical") {
      graph3d.d3AlphaDecay(0.005);
      graph3d.d3VelocityDecay(0.4);
    } else if (layout === "tree") {
      graph3d.d3AlphaDecay(0.003);
      graph3d.d3VelocityDecay(0.45);
    }

    // Initial camera: proportional to sqrt(nodeCount)
    const camDist = Math.max(800, Math.sqrt(nodeCount) * 80);
    graph3d.cameraPosition({ z: layout === "cloud" ? camDist * 1.3 : camDist });

    // Wire slider live update
    const sliderEl = $("sigma-repulsion");
    if (sliderEl && !sliderEl.dataset.wired) {
      sliderEl.dataset.wired = "1";
      sliderEl.addEventListener("input", () => {
        if (!graph3d) return;
        const v = parseFloat(sliderEl.value);
        const newCharge = displayMode === "grouped" ? -v * 1.3 : -v;
        graph3d.d3Force("charge").strength(newCharge);
        graph3d.d3AlphaDecay(0.01);
      });
    }

    // Zone labels disabled — all labels now live only in the right panel
    graph3d.onEngineStop(() => {
      removeZoneLabels();
    });

    buildTask?.set(70, "Avvio simulazione…");
    await new Promise((r) => setTimeout(r, 50));

    buildTask?.end();

    // Update stats
    const edgeNote = !f.showEdges ? " (archi nascosti)" : "";
    $("sigma-status").textContent = truncated
      ? `Mostrati ${nodes.length} di ${data.nodes.length} nodi. Affina i filtri o alza Max nodi.`
      : `${viewMode}: ${nodes.length} nodi · ${links.length} archi${edgeNote} · ${displayMode} mode · rotazione/trascina/zoom`;
    const st = $("status-line");
    if (st)
      st.textContent = `Grafo pronto — ${nodes.length} nodi, ${links.length} archi`;

    // Fit camera and render legend after layout converges
    setTimeout(() => {
      cameraFit();
      updateLegend(currentColorMode, nodes);
    }, 800);

    renderNodeList(nodes, f.groupBy);
  }

  /* ── Node list panel ────────────────────────────────────── */
  function renderNodeList(nodes, groupBy) {
    const listEl = $("sigma-node-list");
    const countEl = $("sigma-node-list-count");
    const searchEl = $("sigma-node-list-search");
    if (!listEl || !countEl) return;

    const isGrouped = displayMode === "grouped";
    const q = (searchEl?.value || "").toLowerCase().trim();
    const filtered = nodes.filter((n) => !n.isAnchor);

    let html = "";
    let total = 0;

    function itemHtml(n) {
      const name = escapeHtml(n.fullLabel || n.name || n.id);
      const dotColor = nodeColorForDisplay(n);
      return (
        '<button class="node-list-item" data-node-id="' +
        escapeHtml(n.id) +
        '">' +
        '<span class="nl-dot" style="background-color:' +
        dotColor +
        '"></span>' +
        '<span class="nl-name">' +
        name +
        "</span>" +
        '<span class="nl-conn">' +
        (n.deg || 0) +
        "</span>" +
        "</button>"
      );
    }

    function headerHtml(label, count) {
      return (
        '<div class="node-list-header" data-group="' +
        escapeHtml(label) +
        '" style="padding:6px 4px 2px;border-top:1px solid var(--border);margin-top:2px;cursor:pointer;">' +
        '<span class="sb-section-title" style="padding:0;border:none;">' +
        escapeHtml(label) +
        "</span>" +
        '<span style="margin-left:auto;font-size:10px;opacity:.6">' +
        count +
        "</span>" +
        "</div>"
      );
    }

    if (isGrouped && groupBy) {
      const byGroup = {};
      filtered.forEach((n) => {
        const g = n.group || "other";
        if (!byGroup[g]) byGroup[g] = [];
        byGroup[g].push(n);
      });
      const keys = Object.keys(byGroup).sort((a, b) => a.localeCompare(b));
      keys.forEach((g) => {
        const arr = byGroup[g].sort((a, b) => {
          const na = (a.fullLabel || a.name || a.id).toLowerCase();
          const nb = (b.fullLabel || b.name || b.id).toLowerCase();
          return na.localeCompare(nb);
        });
        const visible = q
          ? arr.filter((n) =>
              (n.fullLabel || n.name || n.id).toLowerCase().includes(q),
            )
          : arr;
        if (!visible.length) return;
        html += headerHtml(g, arr.length);
        visible.forEach((n) => {
          html += itemHtml(n);
          total++;
        });
      });
    } else {
      const arr = filtered.sort((a, b) => {
        const na = (a.fullLabel || a.name || a.id).toLowerCase();
        const nb = (b.fullLabel || b.name || b.id).toLowerCase();
        return na.localeCompare(nb);
      });
      const visible = q
        ? arr.filter((n) =>
            (n.fullLabel || n.name || n.id).toLowerCase().includes(q),
          )
        : arr;
      visible.forEach((n) => {
        html += itemHtml(n);
        total++;
      });
    }

    listEl.innerHTML = html;
    countEl.textContent = total + " nodi";

    listEl.querySelectorAll(".node-list-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const nid = btn.dataset.nodeId;
        if (!nid) return;
        document
          .querySelectorAll(".node-list-item.active")
          .forEach((el) => el.classList.remove("active"));
        btn.classList.add("active");
        const n = filtered.find((x) => x.id === nid);
        if (n) {
          showNodeDetail(n.raw || { id: n.id });
          showSubgraph(n.id);
        }
      });
    });

    listEl.querySelectorAll(".node-list-header").forEach((hdr) => {
      hdr.addEventListener("click", () => {
        const g = hdr.dataset.group;
        if (!g) return;
        highlightGroupInGraph(g);
      });
    });

    if (searchEl && !searchEl.dataset.wired) {
      searchEl.dataset.wired = "1";
      searchEl.addEventListener("input", () => {
        renderNodeList(nodes, groupBy);
      });
    }
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function highlightGroupInGraph(groupName) {
    if (!graph3d) return;
    const gData = graph3d.graphData();
    if (!gData) return;
    const groupNodes = gData.nodes.filter(
      (n) => !n.isAnchor && (n.group || "other") === groupName,
    );
    if (!groupNodes.length) return;
    const groupColor = nodeColorForDisplay(groupNodes[0]);
    const groupIds = new Set(groupNodes.map((n) => n.id));
    highlightState.clear();
    groupNodes.forEach((n) => {
      highlightState.set(n.id, {
        color: groupColor,
        val: (n.val || 3) + 4,
        opacity: 1,
      });
    });
    gData.links.forEach((l) => {
      const src = typeof l.source === "object" ? l.source.id : l.source;
      const tgt = typeof l.target === "object" ? l.target.id : l.target;
      if (groupIds.has(src) && groupIds.has(tgt)) {
        highlightState.set(l.id, {
          color: groupColor,
          opacity: 0.7,
          width: 1.5,
        });
      } else if (!highlightState.has(l.id)) {
        highlightState.set(l.id, { opacity: 0.05 });
      }
    });
    gData.nodes.forEach((n) => {
      if (!n.isAnchor && !highlightState.has(n.id)) {
        highlightState.set(n.id, { opacity: 0.25 });
      }
    });
    graph3d.refresh();
  }

  function showSubgraph(centerNodeId) {
    if (!graph3d || !_fullGraphData) return;
    const allNodes = _fullGraphData.nodes;
    const allLinks = _fullGraphData.links;
    const connectedIds = new Set([centerNodeId]);
    allLinks.forEach((l) => {
      const src = typeof l.source === "object" ? l.source.id : l.source;
      const tgt = typeof l.target === "object" ? l.target.id : l.target;
      if (src === centerNodeId) connectedIds.add(tgt);
      if (tgt === centerNodeId) connectedIds.add(src);
    });
    const visibleNodes = allNodes.filter((n) => connectedIds.has(n.id));
    const visibleLinks = allLinks.filter((l) => {
      const src = typeof l.source === "object" ? l.source.id : l.source;
      const tgt = typeof l.target === "object" ? l.target.id : l.target;
      return connectedIds.has(src) && connectedIds.has(tgt);
    });
    graph3d.graphData({ nodes: visibleNodes, links: visibleLinks });
    setTimeout(() => cameraFit(), 100);
    const resetBtn = $("sigma-node-list-reset");
    if (resetBtn) resetBtn.style.display = "";
  }

  function restoreFullGraph() {
    if (!graph3d || !_fullGraphData) return;
    graph3d.graphData({
      nodes: _fullGraphData.nodes,
      links: _fullGraphData.links,
    });
    cameraFit();
    const resetBtn = $("sigma-node-list-reset");
    if (resetBtn) resetBtn.style.display = "none";
  }

  /* ── Interaction ────────────────────────────────────────── */
  let _lastClickNode = null;
  let _clickTimer = null;

  function toggleNodeExpansion(n) {
    if (!n) return;

    // ── Grouped file view: expand/collapse entire group ──
    if (displayMode === "grouped" && viewMode === "file" && n.group) {
      const g = n.group || "other";
      const isGroupExpanded = [...expandedNodes].some((eid) => {
        const en = allNodesForHierarchy.find((x) => normPath(x.id) === eid);
        return en && (en.group || "other") === g;
      });
      if (isGroupExpanded) {
        // Collapse: remove every node of this group from expanded set
        allNodesForHierarchy.forEach((x) => {
          if ((x.group || "other") === g) expandedNodes.delete(normPath(x.id));
        });
      } else {
        expandedNodes.add(n.id);
      }
      rerenderCurrentView();
      return;
    }

    // ── Detail view: expand/collapse parent-child hierarchy ──
    if (!n.hasChildren) return;
    if (expandedNodes.has(n.id)) {
      expandedNodes.delete(n.id);
      // Also collapse any descendants recursively
      const collapseDescendants = (pid) => {
        const { map: cm } = buildChildrenMap(allNodesForHierarchy);
        const childIds = cm.get(pid) || [];
        childIds.forEach((cid) => {
          if (expandedNodes.has(cid)) {
            expandedNodes.delete(cid);
            collapseDescendants(cid);
          }
        });
      };
      collapseDescendants(n.id);
    } else {
      expandedNodes.add(n.id);
    }
    rerenderCurrentView();
  }

  function handleNodeClick(n) {
    if (!n || n.isAnchor) return;
    if (_lastClickNode === n.id) {
      // Double click → expand/collapse
      clearTimeout(_clickTimer);
      _lastClickNode = null;
      toggleNodeExpansion(n);
      return;
    }
    _lastClickNode = n.id;
    _clickTimer = setTimeout(() => {
      _lastClickNode = null;
      focusNodeId = n.id;
      showNodeDetail(n.raw || { id: n.id });
      runImpactPreview(n.id);
    }, 280);
  }

  function handleNodeHover(n) {
    hoverNodeId = n ? n.id : null;
    if (!n || n.isAnchor) {
      $("sigma-status").textContent = "";
      return;
    }
    const deg = nodeDegrees.get(n.id) || 0;
    $("sigma-status").textContent =
      `${n.fullLabel || n.name} — ${deg} connessioni`;
  }

  /* ── Search & Highlight ───────────────────────────────── */
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

    // If exact id not in graph, fuzzy match
    const data = graph3d?.graphData();
    const hasNode = data?.nodes?.some((n) => n.id === nid);
    if (!hasNode) {
      const fname = nid.split("/").pop().toLowerCase().replace(/\./g, "-");
      const qLabel = (first.label || "").toLowerCase();
      const byLabel = data?.nodes?.find(
        (n) => (n.fullLabel || "").toLowerCase() === qLabel,
      );
      const byIdEnd = data?.nodes?.find((n) =>
        n.id.toLowerCase().endsWith(fname),
      );
      const byIdContains = data?.nodes?.find((n) =>
        n.id.toLowerCase().includes(fname),
      );
      const found = byLabel || byIdEnd || byIdContains;
      if (found) nid = found.id;
    }

    if (!graph3d) {
      $("sigma-status").textContent = "Grafo non inizializzato.";
      return;
    }

    const gData = graph3d.graphData();
    const targetNode = gData.nodes.find((n) => n.id === nid);
    if (!targetNode) {
      $("sigma-status").textContent = "Nodo non trovato nel grafo corrente.";
      return;
    }

    applySearchHighlight(nid);

    // Camera focus
    graph3d.cameraPosition(
      {
        x: (targetNode.x || 0) + 100,
        y: (targetNode.y || 0) + 50,
        z: (targetNode.z || 0) + 100,
      },
      targetNode,
      1500,
    );

    $("sigma-status").textContent = `Focus: ${first.label} (${first.type})`;
  }

  function applySearchHighlight(nodeId) {
    if (!graph3d) return;
    const highlightEnabled = $("sigma-highlight-found")?.checked ?? true;
    searchHighlightSet.clear();
    highlightState.clear();

    if (!highlightEnabled) {
      graph3d.refresh();
      return;
    }

    const gData = graph3d.graphData();
    if (!gData) return;

    searchHighlightSet.add(nodeId);
    highlightState.set(nodeId, {
      color: SEARCH_HI_COLOR,
      val: (gData.nodes.find((n) => n.id === nodeId)?.val || 3) + 8,
      opacity: 1,
    });

    // Highlight connected links and neighbor nodes
    gData.links.forEach((l) => {
      const src = typeof l.source === "object" ? l.source.id : l.source;
      const tgt = typeof l.target === "object" ? l.target.id : l.target;
      if (src === nodeId || tgt === nodeId) {
        highlightState.set(l.id, {
          color: SEARCH_HI_COLOR,
          opacity: 0.9,
          width: 3,
        });
        const neighborId = src === nodeId ? tgt : src;
        if (!highlightState.has(neighborId)) {
          const neighbor = gData.nodes.find((n) => n.id === neighborId);
          highlightState.set(neighborId, {
            color: SEARCH_CONN_COLOR,
            val: (neighbor?.val || 3) + 3,
            opacity: 1,
          });
        }
        searchHighlightSet.add(neighborId);
      }
    });

    // Dim non-highlighted nodes and links
    gData.nodes.forEach((n) => {
      if (!highlightState.has(n.id)) {
        highlightState.set(n.id, {
          color: NODE_DIM_COLOR,
          opacity: 0.15,
          val: Math.max(1, n.val * 0.5),
        });
      }
    });
    gData.links.forEach((l) => {
      if (!highlightState.has(l.id)) {
        highlightState.set(l.id, {
          color: EDGE_DIM_COLOR,
          opacity: 0.1,
          width: 0.5,
        });
      }
    });

    graph3d.refresh();
  }

  function clearSearchHighlight() {
    searchHighlightSet.clear();
    highlightState.clear();
    graph3d?.refresh();
  }

  /* ── Detail & Info Box (preserved UI) ─────────────────── */
  function showNodeInfoBox(nodeId) {
    const infoEl = $("sigma-node-info");
    if (!infoEl) return;
    const data = graph3d?.graphData();
    if (!data) return;
    const n = data.nodes.find((x) => x.id === nodeId);
    if (!n) return;
    const raw = n.raw || {};
    const type = raw.type || n.type || "file";
    const label = raw.label || raw.qualifiedName || n.fullLabel || nodeId;
    const path = raw.filePath || raw.id || "";
    const deg = nodeDegrees.get(nodeId) || 0;
    const icon = $("sigma-node-info-icon");
    const lbl = $("sigma-node-info-label");
    const pth = $("sigma-node-info-path");
    const conn = $("sigma-node-info-conn");
    if (icon) {
      icon.textContent = type.slice(0, 2);
      icon.style.background = colorManager.maps.nodeType[type] || "#888888";
    }
    if (lbl) lbl.textContent = String(label).split(/[/\\]/).pop() || label;
    if (pth) pth.textContent = path;
    if (conn)
      conn.textContent = deg > 0 ? `${deg} connessioni` : "0 connessioni";
    infoEl.classList.remove("hidden");
  }

  function showNodeDetail(n) {
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
    api("/api/graph/api-links", undefined, "Collegamenti API")
      .catch(() => ({ links: [] }))
      .then((links) => {
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
          html += "</ul>";
        }
        if (n.dtos?.length) {
          html += `<p><strong>DTO (${n.dtos.length}):</strong></p><ul>`;
          n.dtos
            .slice(0, 5)
            .forEach((d) => (html += `<li>${escapeHtml(d)}</li>`));
          if (n.dtos.length > 5)
            html += `<li>… e altri ${n.dtos.length - 5}</li>`;
          html += "</ul>";
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
          html += "</ul>";
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
          html += "</ul>";
        }
        detailBody.innerHTML = html;
      });
  }

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

  /* ── View switching ───────────────────────────────────── */
  function fileViewGraphPayload() {
    return {
      nodes: (fileViewData.nodes || []).map((n) => ({ ...n, type: "file" })),
      edges: fileViewData.edges || [],
    };
  }

  async function renderFileView() {
    if (!fileViewLoaded) return loadFileView(true);
    viewMode = "file";
    expandedFile = null;
    expandedGraphCache = null;
    if ($("sigma-collapse")) $("sigma-collapse").disabled = true;
    await renderGraph(fileViewGraphPayload(), "label");
    isReady = true;
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
    populateZoneFilters(fileViewData?.nodes || []);
    await renderGraph(fileViewGraphPayload(), "label");
    isReady = true;
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
    isReady = true;
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
    isReady = true;
  }

  async function rerenderCurrentView() {
    clearSearchHighlight();
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

  /* ── Zoom helpers (new for 3D) ─────────────────────────── */
  function cameraZoom(factor) {
    if (!graph3d) return;
    const cam = graph3d.camera();
    const controls = graph3d.controls();
    if (controls) {
      // OrbitControls / TrackballControls: zoom by adjusting distance
      const dist = cam.position.distanceTo(
        controls.target || { x: 0, y: 0, z: 0 },
      );
      const newDist = dist / factor;
      const dir = cam.position.clone().sub(controls.target).normalize();
      cam.position.copy(controls.target).add(dir.multiplyScalar(newDist));
    }
  }

  function cameraFit() {
    if (!graph3d) return;
    const data = graph3d.graphData();
    if (!data.nodes.length) return;
    let minX = Infinity,
      maxX = -Infinity;
    let minY = Infinity,
      maxY = -Infinity;
    let minZ = Infinity,
      maxZ = -Infinity;
    data.nodes.forEach((n) => {
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
      if (n.z < minZ) minZ = n.z;
      if (n.z > maxZ) maxZ = n.z;
    });
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    const size = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
    const dist = Math.max(size * 1.5, 200);
    graph3d.cameraPosition(
      { x: cx, y: cy + dist * 0.5, z: dist },
      { x: cx, y: cy, z: cz },
      1000,
    );
  }

  /* ── UI event bindings (preserved from sigma-view.js) ───── */
  function clearFilters() {
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

  async function resetView() {
    searchMode = false;
    searchHighlightSet.clear();
    highlightState.clear();
    clearFilters();
    focusNodeId = null;
    detailCache = null;
    await loadFileView(true);
  }

  function onTabShown() {
    populateFuncSelect();
    if (!isReady) {
      loadFileView(false);
      return;
    }
    graph3d?.resumeAnimation();
    cameraFit();
  }

  function onTabHidden() {
    graph3d?.pauseAnimation();
  }

  /* ── Multi-select combos (preserved) ───────────────────── */
  function makeMsCombo(inputId, dropId, tagsId, hiddenId, onChangeCallback) {
    const qInput = $(inputId);
    const drop = $(dropId);
    const tagsEl = $(tagsId);
    const hidden = $(hiddenId);
    if (!qInput || !drop || !tagsEl || !hidden)
      return { setOptions: () => {}, reset: () => {} };

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

  /* ── Group value helper ───────────────────────────────── */
  function getGroupValue(node, groupBy) {
    if (groupBy === "project") return node.project || "other";
    if (groupBy === "folder") return node.folder || "other";
    if (groupBy === "project_folder")
      return (node.project || "other") + " / " + (node.folder || "other");
    if (groupBy === "community") return node.group || "other";
    return node.type || "other";
  }

  /* ── Dynamic Legend ───────────────────────────────────── */
  function updateLegend(mode, nodeList) {
    const container = $("sigma-community-legend");
    if (!container) return;
    container.innerHTML = "";
    if (!nodeList || !nodeList.length) return;

    const map =
      mode === "type" ? colorManager.maps.nodeType : colorManager.maps[mode];
    if (!map) return;

    const counts = new Map();
    nodeList.forEach((n) => {
      let val;
      if (mode === "type") val = n.type || "file";
      else if (mode === "community") val = n.group || "other";
      else if (mode === "project") val = n.project || "other";
      else if (mode === "folder") val = n.folder || "other";
      else val = n.type || "file";
      counts.set(val, (counts.get(val) || 0) + 1);
    });

    const sorted = Object.entries(map)
      .filter(([k]) => counts.has(k))
      .sort((a, b) => a[0].localeCompare(b[0]));

    sorted.forEach(([label, color]) => {
      const count = counts.get(label) || 0;
      const item = document.createElement("div");
      item.className = "legend-item";
      item.dataset.value = label;
      item.dataset.mode = mode;
      item.innerHTML = `<span class="legend-dot" style="background:${color}"></span><span class="legend-label">${escapeHtml(label)} <small>(${count})</small></span>`;
      item.addEventListener("click", () => {
        isolateGroup(label, mode);
      });
      container.appendChild(item);
    });
  }

  /* ── Isolation ────────────────────────────────────────── */
  let _isolationReset = null;
  function isolateGroup(value, mode) {
    if (!graph3d) return;
    const allNodes = graph3d.graphData().nodes;
    const allLinks = graph3d.graphData().links;

    const getVal = (n) => {
      if (mode === "community") return n.group || "other";
      if (mode === "project") return n.project || "other";
      if (mode === "folder") return n.folder || "other";
      return n.type || "file";
    };

    const primaryIds = new Set(
      allNodes.filter((n) => getVal(n) === value).map((n) => n.id),
    );

    // Include 1-hop neighbors
    allLinks.forEach((l) => {
      const s = l.source?.id || l.source;
      const t = l.target?.id || l.target;
      if (primaryIds.has(s)) primaryIds.add(t);
      if (primaryIds.has(t)) primaryIds.add(s);
    });

    graph3d
      .nodeOpacity((node) => (primaryIds.has(node.id) ? 1.0 : 0.05))
      .linkOpacity((link) => {
        const s = link.source?.id || link.source;
        const t = link.target?.id || link.target;
        return primaryIds.has(s) && primaryIds.has(t) ? 0.4 : 0.02;
      });

    showResetIsolationButton(() => {
      graph3d.nodeOpacity(1.0).linkOpacity(0.3);
      hideResetIsolationButton();
    });
  }

  function showResetIsolationButton(onClick) {
    hideResetIsolationButton();
    const btn = document.createElement("button");
    btn.id = "sigma-reset-isolation";
    btn.className = "sb-btn sb-btn-ghost sb-btn-full";
    btn.style.cssText = "margin-top:6px; font-size:11px;";
    btn.textContent = "Mostra tutti";
    btn.addEventListener("click", onClick);
    const legend = $("sigma-community-legend");
    if (legend) legend.parentNode.insertBefore(btn, legend.nextSibling);
    _isolationReset = btn;
  }

  function hideResetIsolationButton() {
    if (_isolationReset) {
      _isolationReset.remove();
      _isolationReset = null;
    }
  }

  /* ── Zone Force (physical grouping) ───────────────────── */
  let _lastCentroids = {};
  function applyZoneForce(
    graph,
    nodeList,
    groupBy,
    precomputedCentroids,
    mode,
    muXYOverride,
    muZOverride,
  ) {
    if (!graph) return;
    let centroids = precomputedCentroids || _lastCentroids;
    if (!precomputedCentroids) {
      const groups = [
        ...new Set(nodeList.map((n) => getGroupValue(n, groupBy))),
      ];
      const radius = Math.max(1000, groups.length * 220);
      groups.forEach((g, i) => {
        const angle = (i / groups.length) * 2 * Math.PI;
        centroids[g] = {
          x: Math.cos(angle) * radius,
          y: Math.sin(angle) * radius,
          z: (Math.random() - 0.5) * 200,
        };
      });
    }
    _lastCentroids = centroids;

    // Layout-aware coefficients; overrides take precedence
    const muXY = muXYOverride ?? (mode === "grouped" ? 0.38 : 0.06);
    const muZ = muZOverride ?? (mode === "grouped" ? 0.12 : 0.02);

    graph.d3Force("zones", (alpha) => {
      graph.graphData().nodes.forEach((node) => {
        const c = centroids[getGroupValue(node, groupBy)];
        if (!c) return;
        node.vx += (c.x - node.x) * alpha * muXY;
        node.vy += (c.y - node.y) * alpha * muXY;
        node.vz += (c.z - node.z) * alpha * muZ;
      });
    });
  }

  function removeZoneForce(graph) {
    if (!graph) return;
    graph.d3Force("zones", null);
    removeZoneLabels();
  }

  /* ── Zone Labels (HTML overlay) ─────────────────────────── */
  let zoneLabels = [];
  function renderZoneLabels(nodeList, groupBy) {
    removeZoneLabels();
    if (!graph3d) return;
    const container = $("sigma-container");
    if (!container) return;

    const centroids = {};
    nodeList.forEach((node) => {
      const g = getGroupValue(node, groupBy);
      if (!centroids[g]) centroids[g] = { x: 0, y: 0, z: 0, count: 0 };
      centroids[g].x += node.x || 0;
      centroids[g].y += node.y || 0;
      centroids[g].z += node.z || 0;
      centroids[g].count++;
    });

    Object.entries(centroids).forEach(([group, pos]) => {
      if (pos.count === 0) return;
      const avg = {
        x: pos.x / pos.count,
        y: pos.y / pos.count,
        z: pos.z / pos.count,
      };
      const screen = graph3d.graph2ScreenCoords(avg.x, avg.y, avg.z);
      const label = document.createElement("div");
      label.className = "zone-label";
      label.textContent = group;
      const color =
        currentColorMode === "type"
          ? "#ffffff"
          : colorManager.getColor(
              group,
              currentColorMode === "community"
                ? "community"
                : currentColorMode === "project"
                  ? "project"
                  : currentColorMode === "folder"
                    ? "folder"
                    : "community",
            );
      label.style.cssText = `
        position: absolute;
        left: ${screen.x}px;
        top: ${screen.y}px;
        transform: translate(-50%, -50%);
        color: white;
        background: rgba(0,0,0,0.6);
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: bold;
        pointer-events: none;
        border-left: 3px solid ${color};
        z-index: 10;
      `;
      container.appendChild(label);
      zoneLabels.push(label);
    });
  }

  function removeZoneLabels() {
    zoneLabels.forEach((l) => l.remove());
    zoneLabels = [];
  }

  /* ── Node Size Settings UI ──────────────────────────────── */
  function renderNodeSizeSettings() {
    const container = $("node-size-config");
    if (!container) return;
    container.innerHTML = "";
    tempNodeSizeConfig.forEach((cfg, idx) => {
      const row = document.createElement("div");
      row.className = "node-size-row";
      row.innerHTML = `
        <input type="number" data-idx="${idx}" data-field="min" value="${cfg.min}" min="0" max="15" />
        <span>-</span>
        <input type="number" data-idx="${idx}" data-field="max" value="${cfg.max}" min="0" max="15" />
        <span>conn →</span>
        <input type="number" data-idx="${idx}" data-field="radius" value="${cfg.radius}" min="1" max="60" />
        <span>px</span>
        <button type="button" data-remove="${idx}">×</button>
      `;
      container.appendChild(row);
    });
    // Wire inputs — update temp immediately on every keystroke
    container.querySelectorAll("input").forEach((inp) => {
      inp.addEventListener("input", () => {
        const idx = parseInt(inp.dataset.idx, 10);
        const field = inp.dataset.field;
        const val = parseFloat(inp.value);
        if (!isNaN(val) && tempNodeSizeConfig[idx]) {
          tempNodeSizeConfig[idx][field] = val;
        }
      });
    });
    // Wire remove buttons — update temp only
    container.querySelectorAll("button[data-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.remove, 10);
        tempNodeSizeConfig.splice(idx, 1);
        renderNodeSizeSettings();
      });
    });
    // Sync label size slider to temp value
    const lblSlider = $("node-label-size");
    if (lblSlider) lblSlider.value = tempNodeLabelScale;
  }

  function saveNodeSizeSettings() {
    nodeSizeConfig = JSON.parse(JSON.stringify(tempNodeSizeConfig));
    nodeLabelScale = tempNodeLabelScale;
    try {
      localStorage.setItem(
        "ch_node_size_config",
        JSON.stringify(nodeSizeConfig),
      );
      localStorage.setItem("ch_node_label_scale", String(nodeLabelScale));
    } catch (_) {}
    rerenderCurrentView();
  }

  function bindFilters() {
    initMsCombos();
    document
      .querySelectorAll(
        "[data-sigma-type], #sigma-hide-private, #sigma-collapsed, #sigma-layout-style, #sigma-min-weight, #sigma-max-nodes, #sigma-show-labels, #sigma-show-edges, #sigma-color-by",
      )
      .forEach((el) => {
        el.addEventListener("change", () => {
          if (el.id === "sigma-color-by") currentColorMode = el.value;
          rerenderCurrentView();
        });
      });

    // Zone-mode radios
    document.querySelectorAll('input[name="zone-mode"]').forEach((r) => {
      r.addEventListener("change", () => rerenderCurrentView());
    });

    // Detail-mode radios
    document.querySelectorAll('input[name="detail-mode"]').forEach((r) => {
      r.addEventListener("change", async (e) => {
        if (e.target.value === "file") {
          await renderFileView();
        } else {
          await loadFullDetail();
        }
      });
    });

    // Node size settings (temp only, no rerender until Save)
    $("node-size-add")?.addEventListener("click", () => {
      const last = tempNodeSizeConfig[tempNodeSizeConfig.length - 1];
      const start = last ? last.max + 1 : 0;
      tempNodeSizeConfig.push({
        min: start,
        max: Math.min(start + 2, 15),
        radius: 10,
      });
      renderNodeSizeSettings();
    });
    $("node-label-size")?.addEventListener("input", (e) => {
      tempNodeLabelScale = parseFloat(e.target.value) || 1.0;
    });
    $("settings-save")?.addEventListener("click", saveNodeSizeSettings);
  }

  /* ── Functions panel (preserved) ──────────────────────── */
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
      resetView();
      return;
    }
    const func = _funcList.find((f) => f.id === id);
    if (func) showFunction(func);
  });

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
    isReady = true;
    $("sigma-status").textContent =
      `Funzionalità: ${func.name} — ${filteredNodes.length} file, ${filteredEdges.length} archi`;
    const sel = $("sigma-func-select");
    if (sel) sel.value = func.id;
  }

  /* ── Path tracing (preserved) ──────────────────────────── */
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

  /* ── Detail panel actions (preserved) ───────────────────── */
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
  $("sigma-detail-view-graph")?.addEventListener("click", async () => {
    if (!_detailNode || !graph3d) return;
    $("sigma-detail")?.classList.add("hidden");
    const nid = normPath(_detailNode.id);
    const data = graph3d.graphData();
    if (!data) return;
    // 1-hop neighborhood
    const neighborIds = new Set([nid]);
    data.links.forEach((l) => {
      const src = typeof l.source === "object" ? l.source.id : l.source;
      const tgt = typeof l.target === "object" ? l.target.id : l.target;
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
    isReady = true;
    $("sigma-status").textContent =
      `Grafo di ${subNodes.length} nodi, ${subEdges.length} archi`;
  });

  $("sigma-node-info-close")?.addEventListener("click", () => {
    $("sigma-node-info")?.classList.add("hidden");
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
    clearSearchHighlight();
    await renderGraph(fileViewGraphPayload(), "label");
    isReady = true;
    if (prev.hadHighlight && focusNodeId) {
      applySearchHighlight(focusNodeId);
    }
    $("sigma-detail")?.classList.add("hidden");
    $("sigma-node-info")?.classList.add("hidden");
  });

  /* ── Toolbar buttons (preserved / adapted) ────────────── */
  $("sigma-fit")?.addEventListener("click", cameraFit);
  $("sigma-reset")?.addEventListener("click", () => resetView());
  $("sigma-collapse")?.addEventListener("click", () => renderFileView());
  $("sigma-full-detail")?.addEventListener("click", () => loadFullDetail());
  $("sigma-search-btn")?.addEventListener("click", searchAndFocus);
  $("sigma-path-btn")?.addEventListener("click", tracePath);
  $("sigma-search")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchAndFocus();
  });

  /* ── Tab visibility (new for 3D perf) ───────────────────── */
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.tab === "sigma") onTabShown();
      else onTabHidden();
    });
  });

  /* ── Zoom buttons (new 3D wiring) ───────────────────────── */
  $("sigma-zoom-in")?.addEventListener("click", () => cameraZoom(1.3));
  $("sigma-zoom-out")?.addEventListener("click", () => cameraZoom(0.7));
  $("sigma-zoom-fit")?.addEventListener("click", cameraFit);

  /* ── Init ───────────────────────────────────────────────── */
  populateFuncSelect();
  renderNodeSizeSettings();
  bindFilters();

  window.chSigmaView = {
    loadFileView,
    renderFileView,
    resetSigmaView: resetView,
    expandFile,
    loadFullDetail,
    searchAndFocus,
    onSigmaTabShown: onTabShown,
    showFunction,
    restoreFullGraph,
  };
})();
