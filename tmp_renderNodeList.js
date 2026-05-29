(function(){
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
      return '<button class="node-list-item" data-node-id="' + escapeHtml(n.id) + '">' +
        '<span class="nl-dot" style="background-color:' + dotColor + '"></span>' +
        '<span class="nl-name">' + name + '</span>' +
        '<span class="nl-conn">' + (n.deg || 0) + '</span>' +
      '</button>';
    }

    function headerHtml(label, count) {
      return '<div class="node-list-header" data-group="' + escapeHtml(label) + '" style="padding:6px 4px 2px;border-top:1px solid var(--border);margin-top:2px;cursor:pointer;">' +
        '<span class="sb-section-title" style="padding:0;border:none;">' + escapeHtml(label) + '</span>' +
        '<span style="margin-left:auto;font-size:10px;opacity:.6">' + count + '</span>' +
      '</div>';
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
        const visible = q ? arr.filter((n) => (n.fullLabel || n.name || n.id).toLowerCase().includes(q)) : arr;
        if (!visible.length) return;
        html += headerHtml(g, arr.length);
        visible.forEach((n) => { html += itemHtml(n); total++; });
      });
    } else {
      const arr = filtered.sort((a, b) => {
        const na = (a.fullLabel || a.name || a.id).toLowerCase();
        const nb = (b.fullLabel || b.name || b.id).toLowerCase();
        return na.localeCompare(nb);
      });
      const visible = q ? arr.filter((n) => (n.fullLabel || n.name || n.id).toLowerCase().includes(q)) : arr;
      visible.forEach((n) => { html += itemHtml(n); total++; });
    }

    listEl.innerHTML = html;
    countEl.textContent = total + " nodi";

    listEl.querySelectorAll(".node-list-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const nid = btn.dataset.nodeId;
        if (!nid) return;
        document.querySelectorAll(".node-list-item.active").forEach((el) => el.classList.remove("active"));
        btn.classList.add("active");
        const n = filtered.find((x) => x.id === nid);
        if (n) {
          showNodeDetail(n.raw || { id: n.id });
          highlightNodeInGraph(n.id);
          if (graph3d && typeof n.x === "number") {
            graph3d.cameraPosition(
              { x: n.x, y: n.y, z: n.z + 300 },
              { x: n.x, y: n.y, z: n.z },
              1200
            );
          }
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
    const groupNodes = gData.nodes.filter((n) => !n.isAnchor && (n.group || "other") === groupName);
    if (!groupNodes.length) return;
    const groupColor = nodeColorForDisplay(groupNodes[0]);
    highlightState.clear();
    groupNodes.forEach((n) => {
      highlightState.set(n.id, {
        color: groupColor,
        val: (n.val || 3) + 4,
        opacity: 1,
      });
    });
    gData.nodes.forEach((n) => {
      if (!n.isAnchor && !highlightState.has(n.id)) {
        highlightState.set(n.id, { opacity: 0.25 });
      }
    });
    gData.links.forEach((l) => {
      if (!highlightState.has(l.id)) {
        highlightState.set(l.id, { opacity: 0.05 });
      }
    });
    graph3d.refresh();
  }

  const NODE_HI_COLOR = "#ff6b6b";
  function highlightNodeInGraph(nodeId) {
    if (!graph3d) return;
    const gData = graph3d.graphData();
    if (!gData) return;
    highlightState.clear();
    highlightState.set(nodeId, {
      color: NODE_HI_COLOR,
      val: (gData.nodes.find((n) => n.id === nodeId)?.val || 3) + 6,
      opacity: 1,
    });
    gData.links.forEach((l) => {
      const src = typeof l.source === "object" ? l.source.id : l.source;
      const tgt = typeof l.target === "object" ? l.target.id : l.target;
      if (src === nodeId || tgt === nodeId) {
        highlightState.set(l.id, { color: NODE_HI_COLOR, opacity: 0.8, width: 2 });
        const nid = src === nodeId ? tgt : src;
        if (!highlightState.has(nid)) {
          const neighbor = gData.nodes.find((n) => n.id === nid);
          highlightState.set(nid, {
            color: "#ffd93d",
            val: (neighbor?.val || 3) + 2,
            opacity: 0.95,
          });
        }
      }
    });
    gData.nodes.forEach((n) => {
      if (!highlightState.has(n.id)) {
        highlightState.set(n.id, { opacity: 0.25 });
      }
    });
    gData.links.forEach((l) => {
      if (!highlightState.has(l.id)) {
        highlightState.set(l.id, { opacity: 0.05 });
      }
    });
    graph3d.refresh();
  }
})();
