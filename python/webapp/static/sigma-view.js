/* Context Harvester — Sigma.js viewer (v5) */
(function () {
  const $ = (id) => document.getElementById(id);
  let sigmaRenderer = null;
  let sigmaGraph = null;
  let fileViewData = { nodes: [], edges: [] };
  let expandedFile = null;

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

  function edgeColor(e) {
    if (e.type === 'http_calls' || e.confidence >= 0.9) return '#2ec4b6';
    if (e.type === 'http_calls_inferred' || (e.confidence && e.confidence < 0.9)) return '#e67e22';
    return '#555';
  }

  async function api(path) {
    const res = await fetch(path);
    return res.json();
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
      if ($('sigma-status')) {
        $('sigma-status').textContent = 'Sigma.js non caricato (verifica connessione CDN).';
      }
      return;
    }
    sigmaGraph = new graphology.Graph();
    const nodes = data.nodes || [];
    const edges = data.edges || [];
    nodes.forEach((n) => {
      const id = n.id;
      const label = n[labelKey] || n.label || id;
      const size = n.type === 'file' ? 12 : 6;
      sigmaGraph.addNode(id, {
        label: String(label).slice(0, 40),
        size,
        color: TYPE_COLORS[n.type] || TYPE_COLORS.default,
        x: Math.random(),
        y: Math.random(),
        raw: n,
      });
    });
    let ei = 0;
    edges.forEach((e) => {
      const from = e.from || e.source;
      const to = e.to || e.target;
      if (!from || !to || !sigmaGraph.hasNode(from) || !sigmaGraph.hasNode(to)) return;
      try {
        sigmaGraph.addEdge(`e${ei++}`, from, to, {
          size: Math.min(3, 0.5 + (e.weight || 1) * 0.3),
          color: edgeColor(e),
        });
      } catch (_) {
        /* parallel edge */
      }
    });
    sigmaRenderer = new sigma.Sigma(sigmaGraph, container, {
      renderEdgeLabels: false,
      labelDensity: 0.07,
      labelGridCellSize: 60,
    });
    sigmaRenderer.on('clickNode', ({ node }) => {
      const attrs = sigmaGraph.getNodeAttributes(node);
      showNodeDetail(attrs.raw || { id: node });
      if (!expandedFile && attrs.raw && attrs.raw.type === 'file') {
        expandFile(attrs.raw.id || attrs.raw.fullPath || attrs.raw.filePath);
      }
    });
    if ($('sigma-status')) {
      $('sigma-status').textContent = `${nodes.length} nodi · ${edges.length} edge`;
    }
  }

  function showNodeDetail(n) {
    const panel = $('sigma-detail');
    const body = $('sigma-detail-body');
    if (!panel || !body) return;
    panel.classList.remove('hidden');
    $('sigma-detail-title').textContent = n.label || n.id || 'Nodo';
    body.textContent = JSON.stringify(n, null, 2);
  }

  async function loadFileView() {
    expandedFile = null;
    if ($('sigma-collapse')) $('sigma-collapse').disabled = true;
    const data = await api('/api/graph/file');
    if (data.error) {
      $('sigma-status').textContent = data.error;
      return;
    }
    fileViewData = data;
    renderGraph(
      {
        nodes: (data.nodes || []).map((n) => ({ ...n, type: 'file' })),
        edges: data.edges || [],
      },
      'label'
    );
  }

  async function expandFile(filePath) {
    expandedFile = filePath;
    if ($('sigma-collapse')) $('sigma-collapse').disabled = false;
    $('sigma-status').textContent = `Espansione: ${filePath}...`;
    const data = await api(`/api/graph/expand?file=${encodeURIComponent(filePath)}`);
    if (data.error) {
      $('sigma-status').textContent = data.error;
      return;
    }
    const extIds = new Set((data.nodes || []).map((n) => n.id));
    const fileNodes = (fileViewData.nodes || []).filter((n) => n.id !== filePath);
    const relatedFiles = new Set();
    (data.edges || []).forEach((e) => {
      const other = extIds.has(e.source) ? e.target : e.source;
      const fn = fileViewData.nodes.find((x) => x.detailNodeId === other || x.id === other);
      if (fn) relatedFiles.add(fn.id);
    });
    const outer = fileNodes
      .filter((n) => relatedFiles.has(n.id) || n.id === filePath)
      .map((n) => ({ ...n, type: 'file' }));
    renderGraph({ nodes: [...outer, ...(data.nodes || [])], edges: data.edges || [] }, 'label');
    $('sigma-status').textContent = `Expanded: ${filePath} — ${(data.nodes || []).length} nodi interni`;
  }

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab === 'sigma') {
        loadFileView();
      }
    });
  });

  $('sigma-fit')?.addEventListener('click', () => {
    if (sigmaRenderer) sigmaRenderer.getCamera().animatedReset({ duration: 300 });
  });
  $('sigma-collapse')?.addEventListener('click', () => loadFileView());
  $('sigma-search')?.addEventListener('input', (e) => {
    const q = (e.target.value || '').toLowerCase();
    if (!sigmaGraph) return;
    sigmaGraph.forEachNode((node, attrs) => {
      const match = !q || String(attrs.label || '').toLowerCase().includes(q);
      sigmaGraph.setNodeAttribute(node, 'hidden', !match);
    });
    sigmaRenderer?.refresh();
  });

  window.chSigmaView = { loadFileView, expandFile };
})();
