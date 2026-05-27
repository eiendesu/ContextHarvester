(() => {
  const vscode = acquireVsCodeApi();

  /** @type {{nodes: any[], edges: any[]}} */
  let graph = { nodes: [], edges: [] };
  let network = null;
  let selectedNodeId = null;

  const $container = document.getElementById('graph-container');
  const $subtitle = document.getElementById('graph-subtitle');
  const $statNodes = document.getElementById('stat-nodes');
  const $statEdges = document.getElementById('stat-edges');
  const $search = document.getElementById('search');
  const $filterGroup = document.getElementById('filter-group');
  const $details = document.getElementById('node-details');
  const $btnOpen = document.getElementById('btn-open');
  const $btnSeed = document.getElementById('btn-seed');

  const palette = [
    '#60a5fa', '#34d399', '#fbbf24', '#f472b6', '#a78bfa',
    '#fb7185', '#22c55e', '#38bdf8', '#f97316', '#2dd4bf',
  ];

  function colorForGroup(group) {
    const g = String(group ?? 'unassigned');
    let hash = 0;
    for (let i = 0; i < g.length; i++) hash = (hash * 31 + g.charCodeAt(i)) >>> 0;
    return palette[hash % palette.length];
  }

  function buildVisData(filterQ, groupFilter) {
    const q = (filterQ || '').toLowerCase();
    const nodes = graph.nodes.filter((n) => {
      if (groupFilter && String(n.group) !== groupFilter) return false;
      if (!q) return true;
      return (
        String(n.label || '').toLowerCase().includes(q) ||
        String(n.id || '').toLowerCase().includes(q) ||
        String(n.file || '').toLowerCase().includes(q)
      );
    });
    const ids = new Set(nodes.map((n) => n.id));
    const edges = graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to));

    const visNodes = nodes.map((n) => ({
      id: n.id,
      label: n.label || n.id,
      value: Math.max(1, Number(n.size || 1)),
      color: colorForGroup(n.group),
      title: `${n.label}\n${n.file || n.id}\nGroup: ${n.group || '-'}`,
      file: n.file || n.id,
      group: n.group,
    }));

    const visEdges = edges.map((e) => ({
      from: e.from,
      to: e.to,
      label: e.label || '',
      arrows: 'to',
      color: { color: e.confidence === 'INFERRED' ? '#9ca3af' : '#6b7280' },
    }));

    return { nodes: visNodes, edges: visEdges };
  }

  function populateGroupFilter() {
    if (!$filterGroup) return;
    const groups = [...new Set(graph.nodes.map((n) => String(n.group || 'unassigned')))].sort();
    $filterGroup.innerHTML =
      '<option value="">Tutte</option>' +
      groups.map((g) => `<option value="${escapeAttr(g)}">${escapeHtml(g)}</option>`).join('');
  }

  function render() {
    if (!$container || typeof vis === 'undefined') {
      if ($subtitle) $subtitle.textContent = 'vis-network non caricato';
      return;
    }

    const q = $search?.value || '';
    const gf = $filterGroup?.value || '';
    const data = buildVisData(q, gf);

    if (network) {
      network.destroy();
      network = null;
    }

    const options = {
      nodes: { shape: 'dot', font: { size: 12, color: '#e5e7eb' } },
      edges: { smooth: { type: 'continuous' }, font: { size: 10, align: 'middle' } },
      physics: {
        stabilization: { iterations: 120 },
        barnesHut: { gravitationalConstant: -8000, springLength: 120 },
      },
      interaction: { hover: true, tooltipDelay: 100 },
    };

    network = new vis.Network($container, data, options);

    network.on('click', (params) => {
      if (!params.nodes.length) {
        selectedNodeId = null;
        updateSelection(null);
        return;
      }
      const nid = params.nodes[0];
      selectedNodeId = nid;
      const node = data.nodes.find((n) => n.id === nid);
      updateSelection(node);
    });

    network.on('doubleClick', (params) => {
      if (!params.nodes.length) return;
      const node = data.nodes.find((n) => n.id === params.nodes[0]);
      if (node?.file) {
        vscode.postMessage({ type: 'openFile', path: node.file });
      }
    });

    if ($subtitle) {
      $subtitle.textContent = gf ? `Gruppo: ${gf}` : q ? `Ricerca: ${q}` : 'Tutti i nodi';
    }
    if ($statNodes) $statNodes.textContent = String(data.nodes.length);
    if ($statEdges) $statEdges.textContent = String(data.edges.length);
  }

  function updateSelection(node) {
    if (!node) {
      if ($details) $details.textContent = 'Seleziona un nodo';
      if ($btnOpen) $btnOpen.disabled = true;
      if ($btnSeed) $btnSeed.disabled = true;
      return;
    }
    if ($details) {
      $details.innerHTML = `<b>${escapeHtml(node.label)}</b><br/>File: ${escapeHtml(node.file)}<br/>Group: ${escapeHtml(node.group || '-')}`;
    }
    if ($btnOpen) $btnOpen.disabled = false;
    if ($btnSeed) $btnSeed.disabled = false;
  }

  $search?.addEventListener('input', () => render());
  $filterGroup?.addEventListener('change', () => render());

  $btnOpen?.addEventListener('click', () => {
    if (!selectedNodeId) return;
    const n = graph.nodes.find((x) => x.id === selectedNodeId);
    if (n) vscode.postMessage({ type: 'openFile', path: n.file || n.id });
  });

  $btnSeed?.addEventListener('click', () => {
    if (!selectedNodeId) return;
    const n = graph.nodes.find((x) => x.id === selectedNodeId);
    const seed = pathBasename(n?.file || n?.label || selectedNodeId);
    vscode.postMessage({ type: 'seedRetrieval', symbol: seed });
  });

  function pathBasename(p) {
    const parts = String(p).split(/[/\\]/);
    const name = parts[parts.length - 1] || p;
    return name.replace(/\.[^.]+$/, '');
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }

  function escapeAttr(s) {
    return escapeHtml(s).replaceAll('"', '&quot;');
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'init' || msg.type === 'refresh') {
      graph = msg.graph ?? { nodes: [], edges: [] };
      populateGroupFilter();
      render();
    }
  });
})();
