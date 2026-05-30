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

  function getSunburstSize() {
    const auto = $("sunburst-size-auto")?.checked ?? true;
    if (auto) return null;
    return ($("sunburst-size-input")?.value || "").trim();
  }

  function resolveSunburstSize(val, container) {
    if (!val) return null;
    val = val.toLowerCase().trim();
    if (val.endsWith("%")) {
      const pct = parseFloat(val) / 100;
      if (isNaN(pct) || pct <= 0) return null;
      const parent = container.parentElement;
      return {
        width: Math.max(100, Math.floor((parent.clientWidth || 800) * pct)),
        height: Math.max(100, Math.floor((parent.clientHeight || 600) * pct)),
      };
    }
    const num = parseInt(val.replace("px", ""), 10);
    if (isNaN(num) || num <= 0) return null;
    return { width: num, height: num };
  }

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

    const sizeVal = getSunburstSize();
    const customSize = sizeVal ? resolveSunburstSize(sizeVal, container) : null;
    const panel = container.parentElement;

    if (customSize) {
      container.style.width = customSize.width + "px";
      container.style.height = customSize.height + "px";
      if (panel) panel.style.overflow = "auto";
    } else {
      container.style.width = "100%";
      container.style.height = "100%";
      if (panel) panel.style.overflow = "hidden";
    }

    requestAnimationFrame(() => {
      container.innerHTML = "";
      const w = customSize ? customSize.width : container.clientWidth || 800;
      const h = customSize ? customSize.height : container.clientHeight || 600;

      const visibleRoot = sunburstFocusNode || data;
      decorateColors(visibleRoot);
      renderSunburstNodeList(visibleRoot);

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
          if (!node.children) return;
          if (node === visibleRoot) {
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
        const sizeVal2 = getSunburstSize();
        const customSize2 = sizeVal2
          ? resolveSunburstSize(sizeVal2, container)
          : null;
        const w2 = customSize2 ? customSize2.width : container.clientWidth;
        const h2 = customSize2 ? customSize2.height : container.clientHeight;
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

  /* ---------- Sunburst node list ---------- */
  let sunburstNodeListData = [];

  function extractSunburstNodes(root) {
    const nodes = [];
    function walk(d, path) {
      const conn = d.children ? d.children.length : 0;
      nodes.push({
        name: d.name,
        path: path,
        conn,
        data: d,
        color: d.color || "#64748b",
      });
      if (d.children)
        d.children.forEach((c) =>
          walk(c, path ? path + " / " + d.name : d.name),
        );
    }
    walk(root, "");
    return nodes;
  }

  function getSunburstNodeFilters() {
    const search = ($("sunburst-node-search")?.value || "")
      .toLowerCase()
      .trim();
    const min = parseInt($("sunburst-conn-min")?.value || "", 10);
    const max = parseInt($("sunburst-conn-max")?.value || "", 10);
    return {
      search,
      min: isNaN(min) ? null : min,
      max: isNaN(max) ? null : max,
    };
  }

  function renderSunburstNodeList(data) {
    const listEl = $("sunburst-node-list");
    if (!listEl) return;
    sunburstNodeListData = extractSunburstNodes(data);
    filterAndRenderSunburstNodeList();
  }

  function filterAndRenderSunburstNodeList() {
    const listEl = $("sunburst-node-list");
    if (!listEl) return;
    const { search, min, max } = getSunburstNodeFilters();
    let filtered = sunburstNodeListData;
    if (search) {
      filtered = filtered.filter((n) => n.name.toLowerCase().includes(search));
    }
    if (min !== null) filtered = filtered.filter((n) => n.conn >= min);
    if (max !== null) filtered = filtered.filter((n) => n.conn <= max);

    listEl.innerHTML = filtered
      .map(
        (n) =>
          `<button class="node-list-item" type="button" data-name="${escapeHtml(n.name)}" title="${escapeHtml(n.path + " / " + n.name)}">
            <span class="nl-dot" style="background:${n.color}"></span>
            <span class="nl-name">${escapeHtml(n.name)}</span>
            <span class="nl-conn">${n.conn}</span>
          </button>`,
      )
      .join("");

    listEl.querySelectorAll(".node-list-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const name = btn.dataset.name;
        const node = sunburstNodeListData.find((n) => n.name === name)?.data;
        if (node) {
          sunburstFocusNode = node;
          renderSunburst();
        }
      });
    });
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* ---------- Loading helpers ---------- */
  function showLoading(container) {
    if (!container) return;
    const overlay = document.createElement("div");
    overlay.className = "loading-overlay";
    overlay.innerHTML = '<div class="loading-spinner"></div>';
    container.appendChild(overlay);
    return overlay;
  }

  function hideLoading(overlay) {
    if (overlay) {
      overlay.style.opacity = "0";
      setTimeout(() => overlay.remove(), 200);
    }
  }

  /* ---------- Circle Pack ---------- */
  let circlePackObs = null;
  let circlePackFocusNode = null; // D3 hierarchy node (not .data)

  function renderCirclePack() {
    const container = $("circlepack-container");
    if (!container) return;
    const loader = showLoading(container);
    const mode = $("circlepack-mode")?.value || "project";
    const data = getHierarchy(mode);

    if (typeof d3 === "undefined") {
      container.innerHTML =
        '<p class="muted small" style="padding:20px">Libreria D3 non caricata.</p>';
      return;
    }

    const visibleRootData = circlePackFocusNode
      ? circlePackFocusNode.data
      : data;
    decorateColors(visibleRootData);

    const w = container.clientWidth || 800;
    const h = container.clientHeight || 600;
    container.innerHTML = "";

    // Header breadcrumb
    const header = document.createElement("div");
    header.className = "circlepack-header";
    const pathNames = [];
    let p = circlePackFocusNode;
    while (p) {
      pathNames.unshift(p.data.name);
      p = p.parent;
    }
    header.innerHTML = pathNames.length
      ? `<span>📍</span><span class="cp-breadcrumb">${pathNames.join(" / ")}</span>`
      : `<span>📍</span><span class="cp-breadcrumb">Root</span>`;
    container.appendChild(header);

    const svg = d3
      .select(container)
      .append("svg")
      .attr("width", w)
      .attr("height", h)
      .attr("viewBox", [-w / 2, -h / 2, w, h])
      .style("font", "10px Inter, system-ui, sans-serif")
      .style("cursor", "pointer");

    const g = svg.append("g");
    svg.call(
      d3
        .zoom()
        .scaleExtent([0.5, 8])
        .on("zoom", (e) => {
          g.attr("transform", e.transform);
        }),
    );

    const root = d3
      .hierarchy(visibleRootData)
      .sum((d) => d.value || 1)
      .sort((a, b) => b.value - a.value);

    const pack = d3.pack().size([w, h]).padding(3);
    pack(root);

    // Tooltip HTML custom
    let tooltipDiv = container.querySelector(".cp-tooltip");
    if (!tooltipDiv) {
      tooltipDiv = document.createElement("div");
      tooltipDiv.className = "cp-tooltip";
      container.appendChild(tooltipDiv);
    }

    const node = g
      .selectAll("g")
      .data(root.descendants())
      .join("g")
      .attr("transform", (d) => `translate(${d.x - w / 2},${d.y - h / 2})`)
      .style("cursor", (d) => {
        if (d === root && circlePackFocusNode) return "pointer";
        return d.children ? "pointer" : "default";
      })
      .on("click", (event, d) => {
        event.stopPropagation();
        if (d === root && circlePackFocusNode) {
          circlePackFocusNode = circlePackFocusNode.parent || null;
          renderCirclePack();
        } else if (d.children) {
          circlePackFocusNode = d;
          renderCirclePack();
        }
      })
      .on("mouseover", (event, d) => {
        tooltipDiv.textContent = `${d.data.name} — ${d.children ? d.children.length + " figli" : "foglia"}`;
        tooltipDiv.style.visibility = "visible";
      })
      .on("mousemove", (event) => {
        const rect = container.getBoundingClientRect();
        tooltipDiv.style.left = event.clientX - rect.left + 10 + "px";
        tooltipDiv.style.top = event.clientY - rect.top - 24 + "px";
      })
      .on("mouseout", () => {
        tooltipDiv.style.visibility = "hidden";
      });

    node
      .append("circle")
      .attr("r", (d) => d.r)
      .attr("fill", (d) =>
        d.children ? "rgba(15, 23, 42, 0.6)" : d.data.color || "var(--primary)",
      )
      .attr("stroke", (d) => (d.depth === 0 ? "none" : "var(--border)"))
      .attr("stroke-width", (d) => (d.depth === 0 ? 0 : 1));

    node
      .filter((d) => d.r > 14 && d.depth < 3)
      .append("text")
      .attr("dy", "0.35em")
      .attr("text-anchor", "middle")
      .text((d) => {
        const name = d.data.name;
        const maxChars = Math.floor(d.r / 4);
        return name.length > maxChars && maxChars > 3
          ? name.slice(0, maxChars - 1) + "…"
          : name;
      })
      .style("font-size", (d) => Math.min(11, d.r / 2.5) + "px")
      .style("fill", (d) => (d.children ? "#94a3b8" : "#e2e8f0"))
      .style("pointer-events", "none");

    if (circlePackObs) circlePackObs.disconnect();
    circlePackObs = new ResizeObserver(() => {
      const w2 = container.clientWidth;
      const h2 = container.clientHeight;
      if (w2 && h2) renderCirclePack();
    });
    circlePackObs.observe(container);
    hideLoading(loader);
  }

  /* ---------- Radial Tree (multi) ---------- */
  const MINI_TREE_SIZE = 280;
  let miniTreeRegistry = [];

  function drawRadialTree(
    svgG,
    root,
    w,
    h,
    interactive,
    labelStyle = "compact",
  ) {
    const radius = Math.min(w, h) / 2 - 20;
    const treeLayout = d3.tree().size([2 * Math.PI, radius]);
    treeLayout(root);
    const nodes = root.descendants();
    const links = root.links();
    const linkGen = d3
      .linkRadial()
      .angle((d) => d.x)
      .radius((d) => d.y);
    const maxR = d3.max(nodes, (d) => d.y);
    const tipR = maxR + 40;
    const isLeaf = (d) => !d.children && !d._children;

    svgG
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

    const nodeJoin = svgG
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
            .on(
              "click",
              interactive
                ? (event, d) => {
                    if (d.children) {
                      d._children = d.children;
                      d.children = null;
                    } else if (d._children) {
                      d.children = d._children;
                      d._children = null;
                    }
                    drawMiniTree(svgG, root, "radial", w, h, true, labelStyle);
                  }
                : null,
            );

          ng.append("circle")
            .attr("r", (d) => (d.children ? 5.5 : d._children ? 4 : 2.5))
            .attr("fill", (d) => (d.children ? "var(--primary)" : "#fff"))
            .attr("stroke", (d) =>
              d.children ? "var(--primary-dk)" : "var(--primary)",
            )
            .attr("stroke-width", (d) => (d.children ? 2 : 1.5));

          // Tip-aligned guide line (hidden by default)
          ng.append("line")
            .attr("class", "tree-tip-line")
            .attr("x1", 0)
            .attr("y1", 0)
            .attr("x2", 0)
            .attr("y2", 0)
            .attr("stroke", "#94a3b8")
            .attr("stroke-width", 1)
            .attr("stroke-dasharray", "2,2")
            .style("opacity", 0);

          const labelX = (d) => {
            if (labelStyle === "tip-aligned" && isLeaf(d)) return tipR - d.y;
            return d.x < Math.PI === !d.children ? 8 : -8;
          };
          const labelAnchor = (d) => {
            if (labelStyle === "tip-aligned" && isLeaf(d))
              return d.x < Math.PI ? "start" : "end";
            return d.x < Math.PI === !d.children ? "start" : "end";
          };
          const labelTransform = (d) => {
            if (labelStyle === "tip-aligned" && isLeaf(d)) {
              return `rotate(${-((d.x * 180) / Math.PI - 90)})`;
            }
            return d.x >= Math.PI ? "rotate(180)" : null;
          };

          ng.append("text")
            .attr("class", "tree-label")
            .attr("dy", "0.31em")
            .attr("x", labelX)
            .attr("text-anchor", labelAnchor)
            .attr("transform", labelTransform)
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

    // Update circles
    nodeJoin
      .select("circle")
      .attr("r", (d) => (d.children ? 5.5 : d._children ? 4 : 2.5))
      .attr("fill", (d) => (d.children ? "var(--primary)" : "#fff"))
      .attr("stroke", (d) =>
        d.children ? "var(--primary-dk)" : "var(--primary)",
      )
      .attr("stroke-width", (d) => (d.children ? 2 : 1.5));

    // Update tip lines
    nodeJoin
      .select("line.tree-tip-line")
      .attr("x2", (d) =>
        labelStyle === "tip-aligned" && isLeaf(d) ? tipR - d.y : 0,
      )
      .style("opacity", (d) =>
        labelStyle === "tip-aligned" && isLeaf(d) ? 1 : 0,
      );

    // Update labels (both original and clone)
    nodeJoin
      .selectAll("text.tree-label")
      .attr("x", (d) => {
        if (labelStyle === "tip-aligned" && isLeaf(d)) return tipR - d.y;
        return d.x < Math.PI === !d.children ? 8 : -8;
      })
      .attr("text-anchor", (d) => {
        if (labelStyle === "tip-aligned" && isLeaf(d))
          return d.x < Math.PI ? "start" : "end";
        return d.x < Math.PI === !d.children ? "start" : "end";
      })
      .attr("transform", (d) => {
        if (labelStyle === "tip-aligned" && isLeaf(d)) {
          return `rotate(${-((d.x * 180) / Math.PI - 90)})`;
        }
        return d.x >= Math.PI ? "rotate(180)" : null;
      })
      .style("opacity", 1);
  }

  function drawLinearTree(svgG, root, w, h, interactive) {
    const treeLayout = d3.tree().size([w - 20, h - 30]);
    treeLayout(root);
    const nodes = root.descendants();
    const links = root.links();
    const linkGen = d3
      .linkVertical()
      .x((d) => d.x + 10)
      .y((d) => d.y + 15);

    svgG
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

    svgG
      .selectAll("g.tree-node")
      .data(nodes, (d) => d.id)
      .join(
        (enter) => {
          const ng = enter
            .append("g")
            .attr("class", "tree-node")
            .attr("transform", (d) => `translate(${d.x + 10},${d.y + 15})`)
            .on(
              "click",
              interactive
                ? (event, d) => {
                    if (d.children) {
                      d._children = d.children;
                      d.children = null;
                    } else if (d._children) {
                      d.children = d._children;
                      d._children = null;
                    }
                    drawMiniTree(svgG, root, "linear", w, h, true);
                  }
                : null,
            );
          ng.append("circle")
            .attr("r", (d) => (d.children ? 5.5 : d._children ? 4 : 2.5))
            .attr("fill", (d) => (d.children ? "var(--primary)" : "#fff"))
            .attr("stroke", (d) =>
              d.children ? "var(--primary-dk)" : "var(--primary)",
            )
            .attr("stroke-width", (d) => (d.children ? 2 : 1.5));
          ng.append("text")
            .attr("dy", "0.31em")
            .attr("x", 8)
            .attr("text-anchor", "start")
            .text((d) => d.data.name)
            .style("font-size", "9px")
            .style("fill", "var(--txt-mid)")
            .clone(true)
            .lower()
            .attr("stroke", "var(--bg)")
            .attr("stroke-width", 3);
          return ng;
        },
        (update) =>
          update.attr("transform", (d) => `translate(${d.x + 10},${d.y + 15})`),
        (exit) => exit.remove(),
      )
      .select("circle")
      .attr("r", (d) => (d.children ? 5.5 : d._children ? 4 : 2.5))
      .attr("fill", (d) => (d.children ? "var(--primary)" : "#fff"))
      .attr("stroke", (d) =>
        d.children ? "var(--primary-dk)" : "var(--primary)",
      )
      .attr("stroke-width", (d) => (d.children ? 2 : 1.5));
  }

  function drawUnrootedTree(svgG, root, w, h, interactive) {
    const nodes = root.descendants();
    const links = root.links();
    const margin = 20;
    const simW = w - margin * 2;
    const simH = h - margin * 2;

    nodes.forEach((d) => {
      if (d._px === undefined) {
        d._px = (Math.random() - 0.5) * simW * 0.5;
        d._py = (Math.random() - 0.5) * simH * 0.5;
      }
      d.x = d._px;
      d.y = d._py;
    });

    const simulation = d3
      .forceSimulation(nodes)
      .force(
        "link",
        d3
          .forceLink(links)
          .id((d) => d.id)
          .distance(30),
      )
      .force("charge", d3.forceManyBody().strength(-100))
      .force("center", d3.forceCenter(0, 0))
      .force("collide", d3.forceCollide().radius(12))
      .stop();

    for (let i = 0; i < 150; i++) simulation.tick();

    nodes.forEach((d) => {
      d._px = d.x;
      d._py = d.y;
    });

    const xEx = d3.extent(nodes, (d) => d.x);
    const yEx = d3.extent(nodes, (d) => d.y);
    const scale = Math.min(
      simW / Math.max(xEx[1] - xEx[0], 1),
      simH / Math.max(yEx[1] - yEx[0], 1),
      1,
    );
    const cx = (xEx[0] + xEx[1]) / 2;
    const cy = (yEx[0] + yEx[1]) / 2;

    const line = (s, t) => {
      const sx = (s.x - cx) * scale;
      const sy = (s.y - cy) * scale;
      const tx = (t.x - cx) * scale;
      const ty = (t.y - cy) * scale;
      return `M${sx},${sy}L${tx},${ty}`;
    };

    svgG
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
            .attr("d", (d) => line(d.source, d.target)),
        (update) => update.attr("d", (d) => line(d.source, d.target)),
        (exit) => exit.remove(),
      );

    const nodeTransform = (d) => {
      const x = (d.x - cx) * scale;
      const y = (d.y - cy) * scale;
      return `translate(${x},${y})`;
    };

    svgG
      .selectAll("g.tree-node")
      .data(nodes, (d) => d.id)
      .join(
        (enter) => {
          const ng = enter
            .append("g")
            .attr("class", "tree-node")
            .attr("transform", nodeTransform)
            .on(
              "click",
              interactive
                ? (event, d) => {
                    if (d.children) {
                      d._children = d.children;
                      d.children = null;
                    } else if (d._children) {
                      d.children = d._children;
                      d._children = null;
                    }
                    drawMiniTree(svgG, root, "unrooted", w, h, true);
                  }
                : null,
            );
          ng.append("circle")
            .attr("r", (d) => (d.children ? 5.5 : d._children ? 4 : 2.5))
            .attr("fill", (d) => (d.children ? "var(--primary)" : "#fff"))
            .attr("stroke", (d) =>
              d.children ? "var(--primary-dk)" : "var(--primary)",
            )
            .attr("stroke-width", (d) => (d.children ? 2 : 1.5));
          ng.append("text")
            .attr("dy", "0.31em")
            .attr("x", 8)
            .attr("text-anchor", "start")
            .text((d) => d.data.name)
            .style("font-size", "9px")
            .style("fill", "var(--txt-mid)")
            .clone(true)
            .lower()
            .attr("stroke", "var(--bg)")
            .attr("stroke-width", 3);
          return ng;
        },
        (update) => update.attr("transform", nodeTransform),
        (exit) => exit.remove(),
      )
      .select("circle")
      .attr("r", (d) => (d.children ? 5.5 : d._children ? 4 : 2.5))
      .attr("fill", (d) => (d.children ? "var(--primary)" : "#fff"))
      .attr("stroke", (d) =>
        d.children ? "var(--primary-dk)" : "var(--primary)",
      )
      .attr("stroke-width", (d) => (d.children ? 2 : 1.5));
  }

  function drawMiniTree(
    svgG,
    root,
    layoutType,
    w,
    h,
    interactive = true,
    labelStyle = "compact",
  ) {
    if (!svgG || !root) return;
    if (layoutType === "linear") drawLinearTree(svgG, root, w, h, interactive);
    else if (layoutType === "unrooted")
      drawUnrootedTree(svgG, root, w, h, interactive);
    else drawRadialTree(svgG, root, w, h, interactive, labelStyle);
  }

  function getTreeLayout() {
    return $("tree-layout")?.value || "radial";
  }

  function getTreeLabelStyle() {
    return $("tree-label-style")?.value || "compact";
  }

  function showTreeDetail(childData, title) {
    const container = $("tree-container");
    if (!container) return;
    const layoutType = getTreeLayout();

    const overlay = document.createElement("div");
    overlay.className = "tree-detail-overlay";
    overlay.innerHTML = `
      <div class="tree-detail-header">
        <span class="tree-detail-title"></span>
        <button class="tree-detail-close" type="button">&times;</button>
      </div>
      <div class="tree-detail-body"></div>
    `;
    overlay.querySelector(".tree-detail-title").textContent = title;
    const body = overlay.querySelector(".tree-detail-body");
    container.appendChild(overlay);

    const hRoot = d3.hierarchy({ ...childData });
    let idCounter = 0;
    hRoot.descendants().forEach((d) => {
      d.id = idCounter++;
    });

    let fileDepth = 3;
    hRoot.descendants().forEach((d) => {
      if (
        d.children &&
        d.children.some((c) => c.data.value !== undefined && !c.children)
      ) {
        fileDepth = Math.min(fileDepth, d.depth);
      }
    });
    hRoot.descendants().forEach((d) => {
      if (d.depth >= fileDepth && d.children) {
        d._children = d.children;
        d.children = null;
      }
    });

    const w = body.clientWidth || 800;
    const h = body.clientHeight || 600;
    const vb = layoutType === "linear" ? [0, 0, w, h] : [-w / 2, -h / 2, w, h];

    const svg = d3
      .select(body)
      .append("svg")
      .attr("width", w)
      .attr("height", h)
      .attr("viewBox", vb)
      .style("font", "11px Inter, system-ui, sans-serif");

    const g = svg.append("g");
    svg.call(
      d3
        .zoom()
        .scaleExtent([0.05, 4])
        .on("zoom", (e) => {
          g.attr("transform", e.transform);
        }),
    );

    drawMiniTree(g, hRoot, layoutType, w, h, true, getTreeLabelStyle());

    overlay
      .querySelector(".tree-detail-close")
      .addEventListener("click", () => overlay.remove());
  }

  function renderTree() {
    const container = $("tree-container");
    if (!container) return;
    const mode = $("tree-mode")?.value || "project";
    const data = getHierarchy(mode);
    const layoutType = getTreeLayout();
    const labelStyle = getTreeLabelStyle();

    container.innerHTML = "";
    const grid = document.createElement("div");
    grid.className = "mini-tree-grid";
    container.appendChild(grid);
    miniTreeRegistry = [];

    const children = data.children || [data];
    children.forEach((childData, idx) => {
      const hRoot = d3.hierarchy({ ...childData });
      let idCounter = idx * 10000;
      hRoot.descendants().forEach((d) => {
        d.id = idCounter++;
      });

      let fileDepth = 3;
      hRoot.descendants().forEach((d) => {
        if (
          d.children &&
          d.children.some((c) => c.data.value !== undefined && !c.children)
        ) {
          fileDepth = Math.min(fileDepth, d.depth);
        }
      });
      hRoot.descendants().forEach((d) => {
        if (d.depth >= fileDepth && d.children) {
          d._children = d.children;
          d.children = null;
        }
      });

      const card = document.createElement("div");
      card.className = "mini-tree";

      const title = document.createElement("div");
      title.className = "mini-tree-title";
      title.textContent = childData.name;
      card.appendChild(title);

      const svgWrap = document.createElement("div");
      svgWrap.className = "mini-tree-svg";
      card.appendChild(svgWrap);
      grid.appendChild(card);

      card.addEventListener("click", () => {
        showTreeDetail(childData, childData.name);
      });

      const vb =
        layoutType === "linear"
          ? [0, 0, MINI_TREE_SIZE, MINI_TREE_SIZE]
          : [
              -MINI_TREE_SIZE / 2,
              -MINI_TREE_SIZE / 2,
              MINI_TREE_SIZE,
              MINI_TREE_SIZE,
            ];

      const svg = d3
        .select(svgWrap)
        .append("svg")
        .attr("width", MINI_TREE_SIZE)
        .attr("height", MINI_TREE_SIZE)
        .attr("viewBox", vb)
        .style("font", "10px Inter, system-ui, sans-serif");

      const g = svg.append("g");
      svg.call(
        d3
          .zoom()
          .scaleExtent([0.1, 4])
          .on("zoom", (e) => {
            g.attr("transform", e.transform);
          }),
      );

      miniTreeRegistry.push({
        svgG: g,
        root: hRoot,
        layoutType,
        width: MINI_TREE_SIZE,
        height: MINI_TREE_SIZE,
        labelStyle,
      });
      drawMiniTree(
        g,
        hRoot,
        layoutType,
        MINI_TREE_SIZE,
        MINI_TREE_SIZE,
        false,
        labelStyle,
      );
    });
  }

  function expandAllTrees() {
    miniTreeRegistry.forEach(({ root }) => {
      function expand(d) {
        if (d._children) {
          d.children = d._children;
          d._children = null;
        }
        if (d.children) d.children.forEach(expand);
      }
      expand(root);
    });
    miniTreeRegistry.forEach(
      ({ svgG, root, layoutType, width, height, labelStyle }) =>
        drawMiniTree(svgG, root, layoutType, width, height, false, labelStyle),
    );
  }

  function collapseAllTrees() {
    miniTreeRegistry.forEach(({ root }) => {
      function collapse(d) {
        if (d.children) {
          d._children = d.children;
          d.children = null;
        }
        if (d._children) d._children.forEach(collapse);
      }
      collapse(root);
    });
    miniTreeRegistry.forEach(
      ({ svgG, root, layoutType, width, height, labelStyle }) =>
        drawMiniTree(svgG, root, layoutType, width, height, false, labelStyle),
    );
  }

  /* ---------- Event wiring ---------- */
  function onTabActive(tabName) {
    if (tabName === "sunburst") renderSunburst();
    if (tabName === "tree") renderTree();
    if (tabName === "circlepack") renderCirclePack();
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
    $("sunburst-size-auto")?.addEventListener("change", () => {
      const input = $("sunburst-size-input");
      if (input)
        input.style.display = $("sunburst-size-auto").checked
          ? "none"
          : "block";
      renderSunburst();
    });
    $("sunburst-size-input")?.addEventListener("change", () => {
      renderSunburst();
    });
    $("sunburst-node-search")?.addEventListener("input", () => {
      filterAndRenderSunburstNodeList();
    });
    $("sunburst-conn-min")?.addEventListener("input", () => {
      filterAndRenderSunburstNodeList();
    });
    $("sunburst-conn-max")?.addEventListener("input", () => {
      filterAndRenderSunburstNodeList();
    });

    $("circlepack-mode")?.addEventListener("change", () => {
      circlePackFocusNode = null;
      resetCache();
      renderCirclePack();
    });
    $("circlepack-reset")?.addEventListener("click", () => {
      circlePackFocusNode = null;
      resetCache();
      renderCirclePack();
    });

    $("tree-mode")?.addEventListener("change", () => {
      resetCache();
      renderTree();
    });
    $("tree-layout")?.addEventListener("change", () => {
      renderTree();
    });
    $("tree-label-style")?.addEventListener("change", () => {
      renderTree();
    });
    $("tree-reset")?.addEventListener("click", () => {
      resetCache();
      renderTree();
    });
    $("tree-expand")?.addEventListener("click", () => {
      expandAllTrees();
    });
    $("tree-collapse")?.addEventListener("click", () => {
      collapseAllTrees();
    });

    // Hook into existing tab buttons
    document.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        onTabActive(btn.dataset.tab);
      });
    });

    window.onTabActive = onTabActive;
  }

  bootstrap();
})();
