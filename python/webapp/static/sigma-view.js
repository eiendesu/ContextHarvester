/* Context Harvester — Sigma.js viewer v5 (file / expanded / full detail) */
(function () {
  const $ = (id) => document.getElementById(id);
  let sigmaRenderer = null;
  let sigmaGraph = null;
  let fileViewData = { nodes: [], edges: [] };
  let fileViewLoaded = false;
  let expandedGraphCache = null;
  let detailCache = null;
  let viewMode = 'file'; // file | expanded | full
  let expandedFile = null;
  let focusNodeId = null;
  let sigmaReady = false;
  let dragSession = null;
  let suppressNodeClick = false;

  const TYPE_COLORS = {
    file: '#4a9eff',
    class: '#7eb6ff',
    method: '#a8d4ff',
    dto: '#c9b8ff',
    api_client_file: '#ffb347',
    api_client_method: '#ff9f1c',
    api_endpoint: '#2ec4b6',
    default: '#888',
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

  /** 0 = nessun limite; altrimenti 1 … 100000 */
  const SIGMA_MAX_NODES_CAP = 100000;

  function parseMaxNodes() {
    const raw = parseInt($('sigma-max-nodes')?.value ?? '0', 10);
    if (!Number.isFinite(raw) || raw <= 0) return Infinity;
    return Math.min(raw, SIGMA_MAX_NODES_CAP);
  }

  function normPath(id) {
    return String(id || '').replace(/\\/g, '/');
  }

  /** Dimensione nodi in pixel: con migliaia di nodi restano piccoli così si vedono archi e spazio. */
  function nodePixelSize(nodeCount, isFileView) {
    if (nodeCount <= 80) return isFileView ? 12 : 14;
    if (nodeCount <= 400) return isFileView ? 7 : 9;
    if (nodeCount <= 1500) return isFileView ? 4 : 6;
    if (nodeCount <= 4000) return 3;
    return 2;
  }

  function edgePixelSize(nodeCount) {
    if (nodeCount <= 400) return 2;
    if (nodeCount <= 2000) return 1.5;
    return 1.2;
  }

  /** Layout circolare + spring leggero lungo gli archi (evita il "quadrato" senza collegamenti visibili). */
  function computeNodePositions(nodeList, edgeList, mode) {
    const pos = new Map();
    const n = nodeList.length;
    if (!n) return pos;

    const isFileView = mode === 'file';
    const R = Math.max(200, Math.sqrt(n) * (isFileView ? 32 : 14));
    nodeList.forEach((node, i) => {
      const nid = normPath(node.id);
      const angle = (2 * Math.PI * i) / n;
      pos.set(nid, { x: R * Math.cos(angle), y: R * Math.sin(angle) });
    });

    if (edgeList.length > 0 && n <= 8000) {
      const steps = isFileView ? 50 : 25;
      const ideal = isFileView ? 55 : 30;
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
          const force = (dist - ideal) * 0.04;
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
    const density = showLabels ? Math.max(0.03, 1.2 / Math.sqrt(Math.max(nodeCount, 1))) : 0;
    return {
      renderLabels: showLabels,
      renderEdgeLabels: false,
      labelDensity: density,
      labelGridCellSize: 56,
      labelSize: 11,
      labelColor: '#e8e8e8',
      labelWeight: '500',
      labelRenderedSizeThreshold: 0,
      defaultEdgeColor: '#6eb5ff',
      defaultEdgeType: 'line',
      minEdgeSize: showEdges ? 0.8 : 0,
      maxEdgeSize: 3,
      zIndex: true,
      hideEdgesOnMove: false,
      hideEdgesOnZoom: false,
      hideLabelsOnMove: false,
      stagePadding: 24,
      allowInvalidContainer: true,
    };
  }

  function edgeColor(e) {
    const t = e.type || e.label;
    if (t === 'http_calls' || (e.confidence && e.confidence >= 0.9)) return '#3dd6c8';
    if (t === 'http_calls_inferred' || (e.confidence && e.confidence < 0.9)) return '#ffb347';
    if (t === 'imports') return '#b88cff';
    return '#6eb5ff';
  }

  async function api(path, opts, label) {
    if (window.chProgress?.fetchJson) {
      return window.chProgress.fetchJson(path, opts, label);
    }
    const res = await fetch(path, opts);
    return res.json();
  }

  function getFilters() {
    const types = {};
    document.querySelectorAll('[data-sigma-type]').forEach((cb) => {
      types[cb.dataset.sigmaType] = cb.checked;
    });
    return {
      query: ($('sigma-search')?.value || '').toLowerCase().trim(),
      minWeight: parseFloat($('sigma-min-weight')?.value || '0'),
      maxNodes: parseMaxNodes(),
      types,
      hidePrivate: $('sigma-hide-private')?.checked ?? true,
      showLabels: $('sigma-show-labels')?.checked ?? true,
      showEdges: $('sigma-show-edges')?.checked ?? true,
    };
  }

  function nodePasses(n, f) {
    const t = n.type || 'file';
    if (f.types[t] === false) return false;
    if (f.hidePrivate && n.visibility === 'private' && t === 'method') return false;
    if (!f.query) return true;
    const hay = `${n.label || ''} ${n.qualifiedName || ''} ${n.filePath || ''} ${n.id || ''}`.toLowerCase();
    return hay.includes(f.query);
  }

  function destroySigma() {
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

    renderer.on('downNode', (e) => {
      if (typeof e.preventSigmaDefault === 'function') e.preventSigmaDefault();
      const x = sigmaGraph.getNodeAttribute(e.node, 'x');
      const y = sigmaGraph.getNodeAttribute(e.node, 'y');
      dragSession = { node: e.node, moved: false, startX: x, startY: y };
      renderer.getCamera().disable();
    });

    renderer.getMouseCaptor().on('mousemovebody', (e) => {
      if (!dragSession || !sigmaGraph.hasNode(dragSession.node)) return;
      const pos = renderer.viewportToGraph(e);
      const dx = pos.x - dragSession.startX;
      const dy = pos.y - dragSession.startY;
      if (!dragSession.moved && dx * dx + dy * dy > 9) dragSession.moved = true;
      if (dragSession.moved) {
        sigmaGraph.setNodeAttribute(dragSession.node, 'x', pos.x);
        sigmaGraph.setNodeAttribute(dragSession.node, 'y', pos.y);
      }
    });

    const endDrag = () => {
      if (!dragSession) return;
      suppressNodeClick = dragSession.moved;
      dragSession = null;
      renderer.getCamera().enable();
    };

    renderer.getMouseCaptor().on('mouseup', endDrag);
    renderer.getMouseCaptor().on('mouseleave', endDrag);
  }

  async function renderGraph(data, labelKey) {
    destroySigma();
    const container = $('sigma-container');
    if (!container) return;
    const GraphLib = typeof graphology !== 'undefined' ? graphology : window.graphology;
    const SigmaLib = typeof sigma !== 'undefined' ? sigma : window.Sigma;
    if (!GraphLib || !GraphLib.Graph || !SigmaLib) {
      if ($('sigma-status')) {
        $('sigma-status').textContent =
          'Sigma.js non caricato. Esegui scripts\\download-sigma.bat e ricompila il VSIX, oppure verifica /vendor/sigma/.';
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

    const showLabels = f.showLabels;
    const showEdges = f.showEdges;
    const nodeBatch = 8000;
    const edgeBatch = 20000;
    const totalSteps = Math.max(1, nodes.length + edges.length);
    let doneSteps = 0;
    const buildTask =
      nodes.length > 500 || edges.length > 2000
        ? window.chProgress?.begin('Rendering grafo Sigma…', 0)
        : null;

    function reportBuild(extraLabel) {
      if (!buildTask) return;
      const pct = Math.min(95, Math.round((doneSteps / totalSteps) * 90));
      buildTask.set(pct, extraLabel || `Rendering grafo… ${doneSteps}/${totalSteps}`);
    }

    const isFileView = viewMode === 'file';
    const positions = computeNodePositions(nodes, edges, viewMode);
    const nodeSizePx = nodePixelSize(nodes.length, isFileView);
    const edgeSizePx = showEdges ? edgePixelSize(nodes.length) : 0;

    sigmaGraph = new GraphLib.Graph({ multi: false, type: 'directed' });

    for (let i = 0; i < nodes.length; i += nodeBatch) {
      const chunk = nodes.slice(i, i + nodeBatch);
      chunk.forEach((n) => {
        const id = normPath(n.id);
        const label = n[labelKey] || n.label || id;
        const shortLabel = String(label).split(/[/\\]/).pop() || label;
        const highlighted = focusNodeId && normPath(focusNodeId) === id;
        const p = positions.get(id) || positions.get(n.id) || { x: 0, y: 0 };
        sigmaGraph.addNode(id, {
          label: showLabels ? String(shortLabel).slice(0, 40) : '',
          size: highlighted ? nodeSizePx + 4 : nodeSizePx,
          color: highlighted ? '#ffeb3b' : TYPE_COLORS[n.type] || TYPE_COLORS.default,
          x: p.x,
          y: p.y,
          raw: n,
        });
      });
      doneSteps += chunk.length;
      if (nodes.length > nodeBatch && i + nodeBatch < nodes.length) {
        const msg = `Nodi ${Math.min(i + nodeBatch, nodes.length)}/${nodes.length}`;
        $('sigma-status').textContent = `Costruzione grafo… ${msg}`;
        reportBuild(`Rendering nodi… ${msg}`);
        await new Promise((r) => requestAnimationFrame(r));
      } else if (buildTask && nodes.length > 500) {
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
          sigmaGraph.addEdge(`e${ei++}`, from, to, {
            size: edgeSizePx * Math.min(2, 0.6 + (e.weight || 1) * 0.2),
            color: edgeColor(e),
            type: 'line',
          });
          edgesAdded++;
        } catch (_) {}
      });
      doneSteps += chunk.length;
      if (edges.length > edgeBatch && i + edgeBatch < edges.length) {
        const msg = `Archi ${Math.min(i + edgeBatch, edges.length)}/${edges.length}`;
        reportBuild(`Rendering archi… ${msg}`);
        await new Promise((r) => requestAnimationFrame(r));
      } else if (buildTask && edges.length > 2000) {
        reportBuild();
      }
    }

    buildTask?.set(98, 'Avvio Sigma.js…');
    let hoverNodeId = null;
    const sigmaSettings = sigmaSettingsForCount(nodes.length, isFileView, showLabels, showEdges);
    sigmaSettings.nodeReducer = (node, attrs) => {
      const out = { ...attrs };
      if (node === hoverNodeId) {
        out.color = '#ffeb3b';
        out.size = (attrs.size || 4) + 3;
        out.zIndex = 2;
      }
      return out;
    };
    sigmaSettings.edgeReducer = (edge, attrs) => {
      const out = { ...attrs };
      if (!showEdges) {
        out.hidden = true;
        return out;
      }
      out.size = Math.max(attrs.size || 1, edgeSizePx);
      out.color = attrs.color || '#6eb5ff';
      out.zIndex = 0;
      return out;
    };
    try {
      sigmaRenderer = new SigmaLib(sigmaGraph, container, sigmaSettings);
    } finally {
      buildTask?.end();
    }

    bindNodeDrag(sigmaRenderer);

    sigmaRenderer.on('enterNode', ({ node }) => {
      hoverNodeId = node;
      const attrs = sigmaGraph.getNodeAttributes(node);
      const lbl = attrs.label || attrs.raw?.label || node;
      const st = $('sigma-status');
      if (st && lbl) {
        st.textContent = `${lbl} — zoom per etichette · trascina per spostare`;
      }
      sigmaRenderer.refresh();
    });
    sigmaRenderer.on('leaveNode', () => {
      hoverNodeId = null;
      sigmaRenderer.refresh();
    });

    sigmaRenderer.on('clickNode', ({ node }) => {
      if (suppressNodeClick) {
        suppressNodeClick = false;
        return;
      }
      const attrs = sigmaGraph.getNodeAttributes(node);
      showNodeDetail(attrs.raw || { id: node });
      if (viewMode === 'file' && attrs.raw?.type === 'file') {
        expandFile(attrs.raw.id || attrs.raw.fullPath || attrs.raw.filePath);
      } else {
        focusNodeId = node;
        runImpactPreview(node);
      }
    });

    if (isFileView && sigmaRenderer.getCamera) {
      setTimeout(() => sigmaRenderer.getCamera().animatedReset({ duration: 500 }), 80);
    }

    if (truncated) {
      $('sigma-status').textContent = `Mostrati ${nodes.length} di ${totalFiltered} nodi. Affina i filtri o alza Max nodi (max ${SIGMA_MAX_NODES_CAP}).`;
    } else {
      const layoutHint = isFileView ? ' · vista file' : '';
      const edgeNote =
        edgesAdded < edges.length ? ` (${edgesAdded} disegnati)` : showEdges ? '' : ' (archi nascosti)';
      $('sigma-status').textContent =
        `${viewMode}: ${nodes.length} nodi · ${edges.length} archi${edgeNote}${layoutHint} · zoom · passa col mouse per nome · trascina nodi`;
    }
  }

  async function showNodeDetail(n) {
    const panel = $('sigma-detail');
    if (!panel) return;
    panel.classList.remove('hidden');
    $('sigma-detail-title').textContent = `${n.label || n.id} (${n.type || '?'})`;
    const links = await api('/api/graph/api-links', undefined, 'Collegamenti API').catch(() => ({ links: [] }));
    const related = (links.links || []).filter(
      (l) =>
        l.clientFile === n.filePath ||
        l.backendFile === n.filePath ||
        l.clientFunction === n.label
    );
    $('sigma-detail-body').textContent = JSON.stringify({ node: n, apiLinks: related.slice(0, 10) }, null, 2);
  }

  async function runImpactPreview(nodeId) {
    const depth = $('sigma-impact-depth')?.value || 2;
    const dir = $('sigma-impact-dir')?.value || 'downstream';
    const cross = $('sigma-cross-layer')?.checked ? 'true' : 'false';
    const data = await api(
      `/api/graph/impact-v2/${encodeURIComponent(nodeId)}?max_depth=${depth}&direction=${dir}&mode=transitive&cross_layer=${cross}`,
      undefined,
      'Anteprima impatto'
    );
    const el = $('sigma-impact-preview');
    if (!el) return;
    let html = `<strong>Impact ${dir}</strong> (${data.total} nodi)<ul>`;
    for (const [d, items] of Object.entries(data.impact || {})) {
      html += `<li>Distanza ${d}: ${items.map((x) => escapeHtml(x.label)).join(', ')}</li>`;
    }
    html += '</ul>';
    el.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function fileViewGraphPayload() {
    return {
      nodes: (fileViewData.nodes || []).map((n) => ({ ...n, type: 'file' })),
      edges: fileViewData.edges || [],
    };
  }

  async function renderFileView() {
    if (!fileViewLoaded) {
      return loadFileView(true);
    }
    viewMode = 'file';
    expandedFile = null;
    expandedGraphCache = null;
    if ($('sigma-collapse')) $('sigma-collapse').disabled = true;
    await renderGraph(fileViewGraphPayload(), 'label');
    sigmaReady = true;
  }

  async function loadFileView(force) {
    viewMode = 'file';
    expandedFile = null;
    expandedGraphCache = null;
    focusNodeId = null;
    if ($('sigma-collapse')) $('sigma-collapse').disabled = true;
    if ($('sigma-full-detail')) $('sigma-full-detail').disabled = false;
    if (!fileViewLoaded || force) {
      const data = await api('/api/graph/file', undefined, 'Vista file');
      if (data.error) {
        $('sigma-status').textContent = data.error;
        return;
      }
      fileViewData = data;
      fileViewLoaded = true;
    }
    await renderGraph(fileViewGraphPayload(), 'label');
    sigmaReady = true;
  }

  function clearSigmaFilters() {
    if ($('sigma-search')) $('sigma-search').value = '';
    if ($('sigma-min-weight')) $('sigma-min-weight').value = '0';
    if ($('sigma-max-nodes')) $('sigma-max-nodes').value = '0';
    if ($('sigma-hide-private')) $('sigma-hide-private').checked = true;
    document.querySelectorAll('[data-sigma-type]').forEach((cb) => {
      cb.checked = true;
    });
    if ($('sigma-path-from')) $('sigma-path-from').value = '';
    if ($('sigma-path-to')) $('sigma-path-to').value = '';
    if ($('sigma-path-result')) $('sigma-path-result').textContent = '';
    $('sigma-detail')?.classList.add('hidden');
    const impact = $('sigma-impact-preview');
    if (impact) impact.innerHTML = '';
  }

  async function resetSigmaView() {
    clearSigmaFilters();
    focusNodeId = null;
    detailCache = null;
    await loadFileView(true);
  }

  async function rerenderCurrentView() {
    if (viewMode === 'file') {
      await renderFileView();
    } else if (viewMode === 'expanded' && expandedGraphCache) {
      await renderGraph(
        { nodes: expandedGraphCache.nodes, edges: expandedGraphCache.edges },
        'label'
      );
    } else if (viewMode === 'full' && detailCache) {
      await renderGraph(detailCache, 'label');
    }
  }

  function onSigmaTabShown() {
    if (!sigmaReady) {
      loadFileView(false);
      return;
    }
    if (sigmaRenderer) {
      try {
        sigmaRenderer.refresh();
      } catch (_) {}
    }
  }

  async function expandFile(filePath) {
    viewMode = 'expanded';
    expandedFile = filePath;
    if ($('sigma-collapse')) $('sigma-collapse').disabled = false;
    const data = await api(`/api/graph/expand?file=${encodeURIComponent(filePath)}`, undefined, 'Espansione file');
    if (data.error) {
      $('sigma-status').textContent = data.error;
      return;
    }
    const inner = data.nodes || [];
    const innerIds = new Set(inner.map((n) => n.id));
    const crossEdges = (data.edges || []).filter(
      (e) => !innerIds.has(e.source) || !innerIds.has(e.target)
    );
    const fileNode = fileViewData.nodes.find((n) => n.id === filePath) || {
      id: filePath,
      label: filePath.split('/').pop(),
      type: 'file',
      filePath,
    };
    const graphPayload = { nodes: [fileNode, ...inner], edges: data.edges || [] };
    expandedGraphCache = { filePath, nodes: graphPayload.nodes, edges: graphPayload.edges };
    await renderGraph(graphPayload, 'label');
    sigmaReady = true;
    $('sigma-status').textContent = `Expanded: ${filePath} — ${inner.length} nodi interni`;
  }

  async function loadFullDetail() {
    const q = ($('sigma-search')?.value || '').trim();
    if (!q || q.length < 2) {
      $('sigma-status').textContent = 'Full detail: inserisci almeno 2 caratteri nella ricerca.';
      return;
    }
    viewMode = 'full';
    expandedFile = null;
    if ($('sigma-collapse')) $('sigma-collapse').disabled = false;
    if (!detailCache) {
      detailCache = await api('/api/graph/detail', undefined, 'Grafo dettagliato');
    }
    if (detailCache.error) {
      $('sigma-status').textContent = detailCache.error;
      return;
    }
    await renderGraph(detailCache, 'label');
    sigmaReady = true;
  }

  async function searchAndFocus() {
    const q = ($('sigma-search')?.value || '').trim();
    if (!q) return;
    const res = await api(`/api/graph/search?q=${encodeURIComponent(q)}&limit=20`, undefined, 'Ricerca nodi');
    const first = (res.results || [])[0];
    if (!first) {
      $('sigma-status').textContent = 'Nessun nodo trovato.';
      return;
    }
    focusNodeId = first.id;
    if (first.type === 'file' || first.filePath) {
      await expandFile(first.filePath || first.id);
    } else if (!detailCache) {
      detailCache = await api('/api/graph/detail', undefined, 'Grafo dettagliato');
      await renderGraph(detailCache, 'label');
    }
    $('sigma-status').textContent = `Focus: ${first.label} (${first.type})`;
  }

  async function tracePath() {
    const src = ($('sigma-path-from')?.value || '').trim();
    const tgt = ($('sigma-path-to')?.value || '').trim();
    if (!src || !tgt) return;
    const cross = $('sigma-cross-layer')?.checked ? 'true' : 'false';
    const data = await api(
      `/api/graph/path?source=${encodeURIComponent(src)}&target=${encodeURIComponent(tgt)}&cross_layer=${cross}`,
      undefined,
      'Percorso API'
    );
    const el = $('sigma-path-result');
    if (!el) return;
    if (!data.found) {
      el.textContent = 'Percorso non trovato.';
      return;
    }
    el.innerHTML = data.path.map((p) => `<span class="path-hop">${escapeHtml(p.label)}</span>`).join(' → ');
    focusNodeId = data.path[0]?.id;
  }

  function bindFilters() {
    document.querySelectorAll(
      '[data-sigma-type], #sigma-hide-private, #sigma-min-weight, #sigma-max-nodes, #sigma-show-labels, #sigma-show-edges'
    ).forEach((el) => {
      el.addEventListener('change', () => {
        rerenderCurrentView();
      });
    });
  }

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab === 'sigma') onSigmaTabShown();
    });
  });

  $('sigma-fit')?.addEventListener('click', () => sigmaRenderer?.getCamera().animatedReset({ duration: 300 }));
  $('sigma-reset')?.addEventListener('click', () => resetSigmaView());
  $('sigma-collapse')?.addEventListener('click', () => renderFileView());
  $('sigma-full-detail')?.addEventListener('click', () => loadFullDetail());
  $('sigma-search-btn')?.addEventListener('click', searchAndFocus);
  $('sigma-path-btn')?.addEventListener('click', tracePath);
  $('sigma-search')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchAndFocus();
  });

  bindFilters();
  window.chSigmaView = {
    loadFileView,
    renderFileView,
    resetSigmaView,
    expandFile,
    loadFullDetail,
    searchAndFocus,
    onSigmaTabShown,
  };
})();
