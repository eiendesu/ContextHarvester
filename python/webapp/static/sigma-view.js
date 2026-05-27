/* Context Harvester — Sigma.js viewer v5 (file / expanded / full detail) */
(function () {
  const $ = (id) => document.getElementById(id);
  let sigmaRenderer = null;
  let sigmaGraph = null;
  let fileViewData = { nodes: [], edges: [] };
  let detailCache = null;
  let viewMode = 'file'; // file | expanded | full
  let expandedFile = null;
  let focusNodeId = null;

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

  function edgeColor(e) {
    const t = e.type || e.label;
    if (t === 'http_calls' || (e.confidence && e.confidence >= 0.9)) return '#2ec4b6';
    if (t === 'http_calls_inferred' || (e.confidence && e.confidence < 0.9)) return '#e67e22';
    if (t === 'imports') return '#9b59b6';
    return '#555';
  }

  async function api(path, opts) {
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
      maxNodes: parseInt($('sigma-max-nodes')?.value || '400', 10),
      types,
      hidePrivate: $('sigma-hide-private')?.checked ?? true,
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
    if (sigmaRenderer) {
      sigmaRenderer.kill();
      sigmaRenderer = null;
    }
    sigmaGraph = null;
  }

  function renderGraph(data, labelKey) {
    destroySigma();
    const container = $('sigma-container');
    if (!container || typeof graphology === 'undefined' || typeof sigma === 'undefined') {
      if ($('sigma-status')) $('sigma-status').textContent = 'Sigma.js non caricato (CDN).';
      return;
    }

    const f = getFilters();
    let nodes = (data.nodes || []).filter((n) => nodePasses(n, f));
    if (nodes.length > f.maxNodes) {
      nodes = nodes.slice(0, f.maxNodes);
      $('sigma-status').textContent = `Mostrati ${f.maxNodes} nodi (limite). Affina i filtri.`;
    }
    const idSet = new Set(nodes.map((n) => n.id));
    const edges = (data.edges || []).filter((e) => {
      const from = e.from || e.source;
      const to = e.to || e.target;
      if (!idSet.has(from) || !idSet.has(to)) return false;
      return (e.weight || 1) >= f.minWeight;
    });

    sigmaGraph = new graphology.Graph();
    nodes.forEach((n) => {
      const id = n.id;
      const label = n[labelKey] || n.label || id;
      const highlighted = focusNodeId && (id === focusNodeId);
      sigmaGraph.addNode(id, {
        label: String(label).slice(0, 48),
        size: highlighted ? 14 : n.type === 'file' ? 12 : 7,
        color: highlighted ? '#ffeb3b' : TYPE_COLORS[n.type] || TYPE_COLORS.default,
        x: Math.random() * 100,
        y: Math.random() * 100,
        raw: n,
      });
    });
    let ei = 0;
    edges.forEach((e) => {
      const from = e.from || e.source;
      const to = e.to || e.target;
      if (!from || !to) return;
      try {
        sigmaGraph.addEdge(`e${ei++}`, from, to, {
          size: Math.min(3, 0.5 + (e.weight || 1) * 0.3),
          color: edgeColor(e),
        });
      } catch (_) {}
    });

    sigmaRenderer = new sigma.Sigma(sigmaGraph, container, {
      renderEdgeLabels: false,
      labelDensity: 0.08,
      labelGridCellSize: 60,
    });

    sigmaRenderer.on('clickNode', ({ node }) => {
      const attrs = sigmaGraph.getNodeAttributes(node);
      showNodeDetail(attrs.raw || { id: node });
      if (viewMode === 'file' && attrs.raw?.type === 'file') {
        expandFile(attrs.raw.id || attrs.raw.fullPath || attrs.raw.filePath);
      } else {
        focusNodeId = node;
        runImpactPreview(node);
      }
    });

    if (!$('sigma-status').textContent.includes('limite')) {
      $('sigma-status').textContent = `${viewMode}: ${nodes.length} nodi · ${edges.length} edge`;
    }
  }

  async function showNodeDetail(n) {
    const panel = $('sigma-detail');
    if (!panel) return;
    panel.classList.remove('hidden');
    $('sigma-detail-title').textContent = `${n.label || n.id} (${n.type || '?'})`;
    const links = await api('/api/graph/api-links').catch(() => ({ links: [] }));
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
      `/api/graph/impact-v2/${encodeURIComponent(nodeId)}?max_depth=${depth}&direction=${dir}&mode=transitive&cross_layer=${cross}`
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

  async function loadFileView() {
    viewMode = 'file';
    expandedFile = null;
    focusNodeId = null;
    if ($('sigma-collapse')) $('sigma-collapse').disabled = true;
    if ($('sigma-full-detail')) $('sigma-full-detail').disabled = false;
    const data = await api('/api/graph/file');
    if (data.error) {
      $('sigma-status').textContent = data.error;
      return;
    }
    fileViewData = data;
    renderGraph(
      { nodes: (data.nodes || []).map((n) => ({ ...n, type: 'file' })), edges: data.edges || [] },
      'label'
    );
  }

  async function expandFile(filePath) {
    viewMode = 'expanded';
    expandedFile = filePath;
    if ($('sigma-collapse')) $('sigma-collapse').disabled = false;
    $('sigma-status').textContent = `Espansione: ${filePath}...`;
    const data = await api(`/api/graph/expand?file=${encodeURIComponent(filePath)}`);
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
    renderGraph({ nodes: [fileNode, ...inner], edges: data.edges || [] }, 'label');
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
      $('sigma-status').textContent = 'Caricamento graph_detail...';
      detailCache = await api('/api/graph/detail');
    }
    if (detailCache.error) {
      $('sigma-status').textContent = detailCache.error;
      return;
    }
    renderGraph(detailCache, 'label');
  }

  async function searchAndFocus() {
    const q = ($('sigma-search')?.value || '').trim();
    if (!q) return;
    const res = await api(`/api/graph/search?q=${encodeURIComponent(q)}&limit=20`);
    const first = (res.results || [])[0];
    if (!first) {
      $('sigma-status').textContent = 'Nessun nodo trovato.';
      return;
    }
    focusNodeId = first.id;
    if (first.type === 'file' || first.filePath) {
      await expandFile(first.filePath || first.id);
    } else if (!detailCache) {
      detailCache = await api('/api/graph/detail');
      renderGraph(detailCache, 'label');
    }
    $('sigma-status').textContent = `Focus: ${first.label} (${first.type})`;
  }

  async function tracePath() {
    const src = ($('sigma-path-from')?.value || '').trim();
    const tgt = ($('sigma-path-to')?.value || '').trim();
    if (!src || !tgt) return;
    const cross = $('sigma-cross-layer')?.checked ? 'true' : 'false';
    const data = await api(
      `/api/graph/path?source=${encodeURIComponent(src)}&target=${encodeURIComponent(tgt)}&cross_layer=${cross}`
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
    document.querySelectorAll('[data-sigma-type], #sigma-hide-private, #sigma-min-weight').forEach((el) => {
      el.addEventListener('change', () => {
        if (viewMode === 'file') loadFileView();
        else if (viewMode === 'expanded' && expandedFile) expandFile(expandedFile);
        else if (viewMode === 'full') loadFullDetail();
      });
    });
  }

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab === 'sigma') loadFileView();
    });
  });

  $('sigma-fit')?.addEventListener('click', () => sigmaRenderer?.getCamera().animatedReset({ duration: 300 }));
  $('sigma-collapse')?.addEventListener('click', () => loadFileView());
  $('sigma-full-detail')?.addEventListener('click', () => loadFullDetail());
  $('sigma-search-btn')?.addEventListener('click', searchAndFocus);
  $('sigma-path-btn')?.addEventListener('click', tracePath);
  $('sigma-search')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchAndFocus();
  });

  bindFilters();
  window.chSigmaView = { loadFileView, expandFile, loadFullDetail, searchAndFocus };
})();
