/* Context Harvester — Hierarchy views: Sunburst + Radial Tree */
(function () {
  const $ = (id) => document.getElementById(id);
  const IS_MOCK = new URLSearchParams(location.search).has("mock");

  async function fetchJson(path, mockPath) {
    const url = IS_MOCK && mockPath ? mockPath : path;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  let detailData = null;
  let graphData = null;
  let hierarchyCache = null;
  let cacheMode = null;

  /* ---------- Data loading ---------- */
  async function ensureData() {
    if (!detailData) {
      detailData = await fetchJson(
        "/api/graph/detail",
        "/static/mock/graph-detail.json",
      );
    }
    if (!graphData) {
      graphData = await fetchJson("/api/graph", "/static/mock/graph.json");
    }
  }

  function getFileCommunity(filePath) {
    if (!graphData || !graphData.nodes) return null;
    for (const n of graphData.nodes) {
      if ((n.file || n.fullPath) === filePath && n.groupLabel) {
        return { id: n.group, label: n.groupLabel };
      }
    }
    return null;
  }

  /* ---------- Hierarchy builder ---------- */
  function buildHierarchy(mode) {
    const showDetails = mode.endsWith("-detail");
    const baseMode = showDetails ? mode.replace("-detail", "") : mode;

    const nodes = detailData.nodes || [];
    const fileByPath = new Map();
    const fileNodes = [];
    const otherNodes = [];

    for (const n of nodes) {
      if (n.type === "file") {
        fileNodes.push(n);
        fileByPath.set(n.filePath, n);
      } else {
        otherNodes.push(n);
      }
    }

    // Collect actual detail nodes per file
    const fileChildren = new Map(); // fileId -> array of detail nodes
    for (const n of otherNodes) {
      const fnode = fileByPath.get(n.filePath);
      if (!fnode) continue;
      if (!fileChildren.has(fnode.id)) fileChildren.set(fnode.id, []);
      fileChildren.get(fnode.id).push(n);
    }

    const root = { name: "root", children: [] };

    function getOrCreate(parent, key, factory) {
      if (!parent._map) parent._map = new Map();
      if (!parent._map.has(key)) {
        const node = factory();
        parent._map.set(key, node);
        parent.children.push(node);
      }
      return parent._map.get(key);
    }

    for (const f of fileNodes) {
      const parts = String(f.filePath || f.qualifiedName || f.label)
        .replace(/\\/g, "/")
        .split("/");
      const project = parts[0] || "unknown";
      const folder = parts.slice(1, -1).join("/") || "(root)";
      const fileName = parts[parts.length - 1] || f.label || "file";

      let target = root;
      if (baseMode === "community") {
        const comm = getFileCommunity(f.filePath) || { label: "Non assegnati" };
        target = getOrCreate(target, comm.label, () => ({
          name: comm.label,
          children: [],
        }));
      }

      target = getOrCreate(target, project, () => ({
        name: project,
        children: [],
      }));
      target = getOrCreate(target, folder, () => ({
        name: folder,
        children: [],
      }));

      const fileNode = { name: fileName, children: [] };
      if (showDetails) {
        const details = fileChildren.get(f.id);
        if (details && details.length > 0) {
          const seen = new Set();
          for (const d of details) {
            let name = d.label || d.qualifiedName || "item";
            const typeLabel = d.type ? ` [${d.type}]` : "";
            let unique = name + typeLabel;
            let counter = 1;
            while (seen.has(unique)) {
              counter++;
              unique = `${name} #${counter}${typeLabel}`;
            }
            seen.add(unique);
            fileNode.children.push({ name: unique, value: 1 });
          }
        }
      }
      if (fileNode.children.length === 0) {
        fileNode.value = 1;
      }
      target.children.push(fileNode);
    }

    function clean(node) {
      delete node._map;
      if (node.children) {
        node.children.forEach(clean);
        if (node.children.length === 0) delete node.children;
      }
    }
    clean(root);

    // Unwrap single-child root for cleaner display
    if (root.children && root.children.length === 1) return root.children[0];
    return root;
  }

  function getHierarchy(mode) {
    if (!hierarchyCache || cacheMode !== mode) {
      cacheMode = mode;
      hierarchyCache = buildHierarchy(mode);
    }
    return hierarchyCache;
  }

  function resetCache() {
    hierarchyCache = null;
    cacheMode = null;
  }

  const PALETTE = [
    "#00639a",
    "#0d9488",
    "#7c3aed",
    "#d97706",
    "#dc2626",
    "#059669",
    "#2563eb",
    "#be185d",
    "#4f46e5",
    "#0891b2",
    "#9333ea",
    "#c2410c",
    "#65a30d",
    "#0284c7",
    "#db2777",
    "#ea580c",
    "#14b8a6",
    "#f59e0b",
    "#8b5cf6",
    "#ef4444",
  ];

  /* ---------- Color branch decorator ---------- */
  function decorateColors(rootData) {
    if (!rootData || typeof d3 === "undefined") return;

    function walk(node, depth, parent, baseColor) {
      node._parent = parent;
      node._depth = depth;

      if (!node.children) {
        const factor = Math.min(Math.max(0, depth - 1) * 0.1, 0.35);
        node.color = d3.interpolateRgb(baseColor, "#cbd5e1")(factor);
        return;
      }
      if (depth === 0) {
        node.color = "#0f172a";
        node.children.forEach((child, i) => {
          const newBase = PALETTE[i % PALETTE.length];
          child.color = newBase;
          walk(child, depth + 1, node, newBase);
        });
      } else {
        node.children.forEach((child) => {
          const factor = Math.min((depth - 1) * 0.08, 0.22);
          child.color = d3.interpolateRgb(baseColor, "#cbd5e1")(factor);
          walk(child, depth + 1, node, baseColor);
        });
      }
    }

    walk(rootData, 0, null, null);
  }

  /* ---------- Sunburst ---------- */
  let sunburstObs = null;
  let sunburstZoom = null;
  let sunburstFocusNode = null;

  function renderSunburst() {
    const container = $("sunburst-container");
    if (!container) return;
    const mode = $("sunburst-mode")?.value || "project";
    const data = getHierarchy(mode);

    if (typeof Sunburst !== "function") {
      container.innerHTML =
        '<p class="muted small" style="padding:20px">Libreria Sunburst non caricata. Verifica la connessione a internet.</p>';
      return;
    }

    requestAnimationFrame(() => {
      container.innerHTML = "";
      const w = container.clientWidth || 800;
      const h = container.clientHeight || 600;

      const visibleRoot = sunburstFocusNode || data;
      decorateColors(visibleRoot);

      const chart = Sunburst()
        .data(visibleRoot)
        .width(w)
        .height(h)
        .children("children")
        .label((d) => {
          const isLeaf = d.children === undefined && d.value !== undefined;
          if (isLeaf) return "";
          let txt = d.name;
          if (txt.length > 18) txt = txt.slice(0, 16) + "…";
          return txt;
        })
        .size("value")
        .color((d) => d.color || "#64748b")
        .minSliceAngle(0.01)
        .tooltipContent((d) => `<strong>${d.name}</strong>`)
        .onClick((node) => {
          if (!node.children) return; // no drill-down on leaves
          if (node === visibleRoot) {
            // Clicked center → go back
            sunburstFocusNode = sunburstFocusNode
              ? sunburstFocusNode._parent
              : null;
          } else {
            sunburstFocusNode = node;
          }
          renderSunburst();
        });

      chart(container);
      applySunburstZoom(container);

      if (sunburstObs) sunburstObs.disconnect();
      sunburstObs = new ResizeObserver(() => {
        const w2 = container.clientWidth;
        const h2 = container.clientHeight;
        if (w2 && h2) {
          container.innerHTML = "";
          chart.width(w2).height(h2)(container);
          applySunburstZoom(container);
        }
      });
      sunburstObs.observe(container);
    });
  }

  function applySunburstZoom(container) {
    if (typeof d3 === "undefined") return;
    const svg = container.querySelector("svg");
    if (!svg) return;
    let wrapper = svg.querySelector(".zoom-wrapper");
    if (!wrapper) {
      const innerG = svg.querySelector("g");
      if (!innerG) return;
      wrapper = document.createElementNS("http://www.w3.org/2000/svg", "g");
      wrapper.classList.add("zoom-wrapper");
      svg.insertBefore(wrapper, innerG);
      wrapper.appendChild(innerG);
    }
    sunburstZoom = d3
      .zoom()
      .scaleExtent([0.5, 10])
      .on("zoom", (event) => {
        d3.select(wrapper).attr("transform", event.transform.toString());
      });
    d3.select(svg).call(sunburstZoom);
  }

  function resetSunburstZoom(container) {
    if (typeof d3 === "undefined") return;
    const svg = container.querySelector("svg");
    if (!svg || !sunburstZoom) return;
    d3.select(svg)
      .transition()
      .duration(300)
      .call(sunburstZoom.transform, d3.zoomIdentity);
  }

  function zoomSunburstBy(container, factor) {
    if (typeof d3 === "undefined") return;
    const svg = container.querySelector("svg");
    if (!svg || !sunburstZoom) return;
    d3.select(svg)
      .transition()
      .duration(200)
      .call(sunburstZoom.scaleBy, factor);
  }

  /* ---------- Radial Tree ---------- */
  let treeRoot = null;
  let treeSvg = null;
  let treeG = null;
  let treeRadius = 0;

  function setupTreeSvg(totalLeaves) {
    const container = $("tree-container");
    if (!container) return;
    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;
    // Ensure enough radius so leaves don't overlap (approx 16px arc each)
    const minRadius = Math.min(width, height) / 2;
    const desiredRadius = ((totalLeaves || 100) * 16) / (2 * Math.PI);
    treeRadius = Math.max(minRadius, Math.min(desiredRadius, 3000));
    container.innerHTML = "";
    treeSvg = d3
      .select(container)
      .append("svg")
      .attr("width", width)
      .attr("height", height)
      .attr("viewBox", [
        -treeRadius,
        -treeRadius,
        treeRadius * 2,
        treeRadius * 2,
      ])
      .style("font", "11px Inter, system-ui, sans-serif");
    treeG = treeSvg.append("g");
    treeSvg.call(
      d3
        .zoom()
        .scaleExtent([0.05, 4])
        .on("zoom", (e) => {
          treeG.attr("transform", e.transform);
        }),
    );
  }

  function drawTree() {
    if (!treeRoot || !treeG) return;
    const treeLayout = d3.tree().size([2 * Math.PI, treeRadius]);
    treeLayout(treeRoot);

    const nodes = treeRoot.descendants();
    const links = treeRoot.links();

    const linkGen = d3
      .linkRadial()
      .angle((d) => d.x)
      .radius((d) => d.y);

    treeG
      .selectAll("path.tree-link")
      .data(links, (d) => d.target.id)
      .join(
        (enter) =>
          enter
            .append("path")
            .attr("class", "tree-link")
            .attr("fill", "none")
            .attr("stroke", "#cbd5e1")
            .attr("stroke-width", 1)
            .attr("stroke-opacity", 0.7)
            .attr("d", linkGen),
        (update) => update.attr("d", linkGen),
        (exit) => exit.remove(),
      );

    treeG
      .selectAll("g.tree-node")
      .data(nodes, (d) => d.id)
      .join(
        (enter) => {
          const ng = enter
            .append("g")
            .attr("class", "tree-node")
            .attr(
              "transform",
              (d) =>
                `rotate(${(d.x * 180) / Math.PI - 90}) translate(${d.y},0)`,
            )
            .on("click", (event, d) => {
              if (d.children) {
                d._children = d.children;
                d.children = null;
              } else if (d._children) {
                d.children = d._children;
                d._children = null;
              }
              drawTree();
            });
          ng.append("circle")
            .attr("r", (d) => (d.children || d._children ? 4 : 2.5))
            .attr("fill", (d) =>
              d.children || d._children ? "var(--primary)" : "#fff",
            )
            .attr("stroke", "var(--primary)")
            .attr("stroke-width", 1.5);
          ng.append("text")
            .attr("dy", "0.31em")
            .attr("x", (d) => (d.x < Math.PI === !d.children ? 8 : -8))
            .attr("text-anchor", (d) =>
              d.x < Math.PI === !d.children ? "start" : "end",
            )
            .attr("transform", (d) => (d.x >= Math.PI ? "rotate(180)" : null))
            .text((d) => d.data.name)
            .style("font-size", "10px")
            .style("fill", "var(--txt-mid)")
            .clone(true)
            .lower()
            .attr("stroke", "var(--bg)")
            .attr("stroke-width", 3);
          return ng;
        },
        (update) =>
          update.attr(
            "transform",
            (d) => `rotate(${(d.x * 180) / Math.PI - 90}) translate(${d.y},0)`,
          ),
        (exit) => exit.remove(),
      );
  }

  function initTreeData(mode) {
    const data = getHierarchy(mode);
    treeRoot = d3.hierarchy(data);
    let i = 0;
    treeRoot.descendants().forEach((d) => {
      d.id = i++;
    });
    // Determine file depth dynamically: it's the first level whose children are type-aggregates (have value, no children)
    let fileDepth = 3;
    treeRoot.descendants().forEach((d) => {
      if (
        d.children &&
        d.children.some((c) => c.data.value !== undefined && !c.children)
      ) {
        fileDepth = Math.min(fileDepth, d.depth);
      }
    });
    treeRoot.descendants().forEach((d) => {
      if (d.depth >= fileDepth && d.children) {
        d._children = d.children;
        d.children = null;
      }
    });
  }

  function renderTree() {
    const mode = $("tree-mode")?.value || "project";
    initTreeData(mode);
    // Count maximum possible leaves (fully expanded) for radius sizing
    const fullRoot = d3.hierarchy(getHierarchy(mode));
    const totalLeaves = fullRoot.leaves().length;
    setupTreeSvg(totalLeaves);
    drawTree();
  }

  function expandAll(d) {
    if (d._children) {
      d.children = d._children;
      d._children = null;
    }
    if (d.children) d.children.forEach(expandAll);
  }

  function collapseAll(d) {
    if (d.children) {
      d._children = d.children;
      d.children = null;
    }
    if (d._children) d._children.forEach(collapseAll);
  }

  /* ---------- Event wiring ---------- */
  function onTabActive(tabName) {
    if (tabName === "sunburst") renderSunburst();
    if (tabName === "tree") renderTree();
  }

  async function bootstrap() {
    await ensureData();

    $("sunburst-mode")?.addEventListener("change", () => {
      sunburstFocusNode = null;
      resetCache();
      renderSunburst();
    });
    $("sunburst-reset")?.addEventListener("click", () => {
      sunburstFocusNode = null;
      resetCache();
      renderSunburst();
    });
    $("sunburst-zoom-in")?.addEventListener("click", () => {
      zoomSunburstBy($("sunburst-container"), 1.3);
    });
    $("sunburst-zoom-out")?.addEventListener("click", () => {
      zoomSunburstBy($("sunburst-container"), 0.7);
    });
    $("sunburst-fit")?.addEventListener("click", () => {
      resetSunburstZoom($("sunburst-container"));
    });

    $("tree-mode")?.addEventListener("change", () => {
      resetCache();
      renderTree();
    });
    $("tree-reset")?.addEventListener("click", () => {
      resetCache();
      renderTree();
    });
    $("tree-expand")?.addEventListener("click", () => {
      if (treeRoot) {
        expandAll(treeRoot);
        drawTree();
      }
    });
    $("tree-collapse")?.addEventListener("click", () => {
      if (treeRoot) {
        collapseAll(treeRoot);
        drawTree();
      }
    });

    // Hook into existing tab buttons
    document.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        onTabActive(btn.dataset.tab);
      });
    });
  }

  bootstrap();
})();
