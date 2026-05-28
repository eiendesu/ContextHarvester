/* Context Harvester Graph Web App v4 */
(function () {
  let graphData = { nodes: [], edges: [], groups: [] };
  let groupCatalog = [];
  let network = null;
  let selectedNodeId = null;
  let labelFirstNodes = new Set();
  let visNodes = null;
  let visEdges = null;

  const $ = (id) => document.getElementById(id);

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Tabs
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      $('panel-' + tab).classList.add('active');
      if (tab === 'graph' && network) {
        setTimeout(() => network.fit(), 100);
      }
      if (tab === 'analysis') loadAnalysis(false);
      if (tab === 'functions') loadFunctions();
      if (tab === 'symbols' && window.chSymbolsView?.load) window.chSymbolsView.load(false);
    });
  });

  async function api(path, opts, label) {
    if (window.chProgress?.fetchJson) {
      return window.chProgress.fetchJson(path, opts, label);
    }
    const res = await fetch(path, opts);
    return res.json();
  }

  async function loadStatus() {
    const st = await api('/api/status', undefined, 'Stato repository');
    $('status-line').textContent =
      `${st.functionsCount || 0} funzioni · ${st.graph?.nodes || 0} nodi · ${st.graph?.edges || 0} edge`;
    return st;
  }

  function populateGroupFilter(groups) {
    groupCatalog = groups || [];
    const sel = $('graph-group-filter');
    sel.innerHTML = '<option value="">Tutte le funzionalità</option>';
    const unassigned = document.createElement('option');
    unassigned.value = 'unassigned';
    unassigned.textContent = 'Non assegnati';
    sel.appendChild(unassigned);
    groupCatalog.forEach((g) => {
      const o = document.createElement('option');
      o.value = g.id;
      const src = g.source === 'label-first' ? ' · label' : g.source === 'leiden' ? ' · leiden' : '';
      const count = g.fileCount != null ? ` (${g.fileCount} file)` : '';
      o.textContent = `${g.name || g.id}${src}${count}`;
      sel.appendChild(o);
    });
  }

  async function loadGraph() {
    graphData = await api('/api/graph', undefined, 'Grafo funzionale');
    populateGroupFilter(graphData.groups);
    initNetwork();
  }

  function initNetwork() {
    const container = $('graph-network');
    const nodes = graphData.nodes || [];
    const edges = graphData.edges || [];

    visNodes = new vis.DataSet(
      nodes.map((n) => ({
        id: n.id,
        label: n.label || n.id,
        group: n.group || 'unassigned',
        title: `${n.label || ''}\n${n.fullPath || n.file || n.id}`,
        size: n.size || 10,
        font: { size: 12, color: '#eee' },
      }))
    );
    visEdges = new vis.DataSet(
      edges.map((e, i) => ({
        id: i,
        from: e.from,
        to: e.to,
        arrows: 'to',
        color: { color: '#666' },
      }))
    );

    network = new vis.Network(
      container,
      { nodes: visNodes, edges: visEdges },
      {
        physics: { stabilization: { iterations: 80 }, barnesHut: { gravitationalConstant: -8000 } },
        interaction: { hover: true, tooltipDelay: 100 },
        groups: {
          unassigned: { color: { background: '#555', border: '#888' } },
        },
      }
    );

    network.on('click', (params) => {
      if (params.nodes.length) {
        selectedNodeId = params.nodes[0];
        const n = visNodes.get(selectedNodeId);
        $('graph-selection').textContent = `Selezionato: ${n.label} (${selectedNodeId})`;
        if (labelFirstNodes.size) {
          toggleLfNode(selectedNodeId);
        }
      }
    });

    applyGraphFilter();
  }

  function applyGraphFilter() {
    if (!visNodes) return;
    const q = ($('graph-search').value || '').toLowerCase().trim();
    const grp = $('graph-group-filter').value;
    const updates = (graphData.nodes || []).map((n) => {
      const matchQ =
        !q ||
        (n.label || '').toLowerCase().includes(q) ||
        (n.id || '').toLowerCase().includes(q) ||
        (n.className || '').toLowerCase().includes(q);
      const matchG = !grp || n.group === grp;
      const inLf = labelFirstNodes.has(n.id);
      let opacity = matchQ && matchG ? 1 : 0.15;
      if (labelFirstNodes.size && !inLf) opacity = 0.2;
      if (inLf) opacity = 1;
      return {
        id: n.id,
        opacity,
        borderWidth: inLf ? 3 : 1,
        color: inLf ? { border: '#3794ff' } : undefined,
      };
    });
    visNodes.update(updates);
    return (graphData.nodes || []).filter((n) => {
      const matchQ =
        !q ||
        (n.label || '').toLowerCase().includes(q) ||
        (n.id || '').toLowerCase().includes(q) ||
        (n.className || '').toLowerCase().includes(q);
      return matchQ && (!grp || n.group === grp);
    });
  }

  function applyGraphFilterAndFocus() {
    const matching = applyGraphFilter();
    if (matching.length && network) {
      network.fit({ nodes: matching.map((n) => n.id), animation: { duration: 400 } });
      $('graph-selection').textContent = `${matching.length} nodi corrispondenti al filtro`;
    } else if (network) {
      $('graph-selection').textContent = 'Nessun nodo corrisponde al filtro';
    }
  }

  function resetGraphFilters() {
    $('graph-search').value = '';
    $('graph-group-filter').value = '';
    labelFirstNodes = new Set();
    $('graph-lf-status').textContent = '';
    applyGraphFilter();
    if (network) {
      network.fit({ animation: { duration: 300 } });
    }
    $('graph-selection').textContent = 'Filtri resettati';
  }

  $('graph-search-btn').addEventListener('click', applyGraphFilterAndFocus);
  $('graph-filter-reset').addEventListener('click', resetGraphFilters);
  $('graph-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyGraphFilterAndFocus();
    }
  });
  $('graph-group-filter').addEventListener('change', applyGraphFilterAndFocus);
  $('graph-fit').addEventListener('click', () => network && network.fit());

  // Impact (v1 file-level or v2 typed)
  $('impact-run').addEventListener('click', async () => {
    const node = $('impact-node').value.trim() || selectedNodeId;
    if (!node) return;
    const depth = $('impact-depth').value;
    const direction = $('impact-direction')?.value || 'downstream';
    const mode = $('impact-mode')?.value || 'transitive';
    const useV2 = $('impact-v2')?.checked;
    const crossLayer = $('impact-cross-layer')?.checked;
    const url = useV2
      ? `/api/graph/impact-v2/${encodeURIComponent(node)}?max_depth=${depth}&direction=${direction}&mode=${mode}&cross_layer=${crossLayer}`
      : `/api/graph/impact/${encodeURIComponent(node)}?max_depth=${depth}`;
    const data = await api(url, undefined, 'Analisi impatto');
    if (data.error) {
      $('impact-results').innerHTML = `<p>${escapeHtml(data.error)}</p>`;
      return;
    }
    let html = `<h3>Impatto ${useV2 ? 'v2' : 'file'} — <strong>${escapeHtml(data.label || data.node)}</strong> (${data.total} nodi)</h3>`;
    if (data.crossLayer) html += '<p class="muted">Modalità cross-layer (solo edge API/import)</p>';
    for (const [d, items] of Object.entries(data.impact || {})) {
      html += `<h4>Distanza ${d}</h4><ul>`;
      items.forEach((it) => {
        const typeBadge = it.type ? ` <span class="badge">${escapeHtml(it.type)}</span>` : '';
        html += `<li>${escapeHtml(it.label || it.id)}${typeBadge} <code>${escapeHtml(it.file || '')}</code></li>`;
      });
      html += '</ul>';
    }
    if (data.pathEdges?.length) {
      html += '<h4>Edge nel percorso</h4><ul>';
      data.pathEdges.slice(0, 30).forEach((e) => {
        html += `<li><code>${escapeHtml(e.from)}</code> → <code>${escapeHtml(e.to)}</code></li>`;
      });
      html += '</ul>';
    }
    $('impact-results').innerHTML = html;
  });

  const ANALYSIS_HELP = {
    deadCode: {
      title: 'Dead Code Candidates',
      body: `<p>File nel grafo che <strong>nessun altro file usa</strong> (nessun arco in entrata) e che non sono considerati <em>entry point</em> del progetto.</p>
<p>Pattern tipici esclusi: <code>Controller</code>, <code>Program.cs</code>, <code>App.tsx</code>, ecc. (configurabile in VS Code).</p>
<p><strong>Attenzione:</strong> possono essere falsi positivi (codice invocato via reflection, DI, routing non rilevato). Usa la lista come promemoria, non come verdetto automatico.</p>`,
    },
    circularDeps: {
      title: 'Dipendenze circolari',
      body: `<p>Cicli nel <strong>grafo diretto</strong> delle dipendenze file→file: A usa B, B usa C, … che torna ad A.</p>
<p>I cicli rendono più difficile capire l’ordine di modifica e spesso indicano accoppiamento forte tra moduli. Valuta refactor (interfacce, estrazione di servizi condivisi).</p>`,
    },
    hotspots: {
      title: 'Hotspot',
      body: `<p>File con <strong>alta centralità</strong> nel grafo (molti percorsi passano da lì) e, se disponibile, molti <strong>commit Git recenti</strong> (ultimi 90 giorni, default).</p>
<p>Lo score combina centralità e attività: sono i candidati più “sensibili” a regressioni quando li modifichi. Utile per priorità di test e code review.</p>`,
    },
    testGap: {
      title: 'Test Coverage Gap',
      body: `<p>Classi C# nel grafo con molte dipendenze in entrata ma <strong>nessun file di test</strong> associato nel repo (euristica sul nome <code>*Test*</code>).</p>
<p>Non sostituisce una metrica di coverage reale: segnala dove potrebbe mancare un test di integrazione/unità.</p>`,
    },
    similarFunctions: {
      title: 'Funzionalità simili',
      body: `<p>Coppie di funzionalità validate in <code>functional_map.json</code> con <strong>molti file in comune</strong> (similarità Jaccard sopra soglia, default 30%).</p>
<p>Può indicare overlap da clustering Leiden o confini poco chiari. Valuta unione, rinomina o split manuale (label-first).</p>`,
    },
    apiEdges: {
      title: 'Edge Frontend ↔ Backend',
      body: `<p>Collegamenti <strong>euristici</strong> tra chiamate HTTP nel frontend (<code>fetch</code>, <code>axios</code>) e file backend che potrebbero gestire la route.</p>
<p>Best-effort: non copre GraphQL, client HTTP custom o route dinamiche complesse. Utile per tracciare “chi chiama quale API”.</p>`,
    },
  };

  function showAnalysisHelp(helpId) {
    const help = ANALYSIS_HELP[helpId];
    if (!help) return;
    $('analysis-info-title').textContent = help.title;
    $('analysis-info-body').innerHTML = help.body;
    $('analysis-info-modal').classList.remove('hidden');
  }

  function closeAnalysisHelp() {
    $('analysis-info-modal').classList.add('hidden');
  }

  $('analysis-info-close').addEventListener('click', closeAnalysisHelp);
  $('analysis-info-backdrop').addEventListener('click', closeAnalysisHelp);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('analysis-info-modal').classList.contains('hidden')) {
      closeAnalysisHelp();
    }
  });

  // Analysis
  async function loadAnalysis(recalc) {
    const data = await api(
      `/api/graph/analysis${recalc ? '?recalculate=true' : ''}`,
      undefined,
      recalc ? 'Ricalcolo analisi' : 'Analisi grafo'
    );
    $('analysis-meta').textContent = data.analyzedAt ? `Ultima: ${data.analyzedAt}` : '';
    const sections = [
      { id: 'deadCode', title: '🔴 Dead Code', items: data.deadCode, fmt: (x) => `${escapeHtml(x.label)} — <code>${escapeHtml(x.file)}</code>` },
      {
        id: 'circularDeps',
        title: '🔵 Dipendenze circolari',
        items: data.circularDeps,
        fmt: (x) => escapeHtml(Array.isArray(x) ? x.join(' → ') : String(x)),
      },
      {
        id: 'hotspots',
        title: '🟡 Hotspot',
        items: data.hotspots,
        fmt: (x) => `${escapeHtml(x.label)} — score ${x.score} (${x.recentCommits} commit)`,
      },
      { id: 'testGap', title: '⚪ Test gap', items: data.testGap, fmt: (x) => escapeHtml(x.label) },
      {
        id: 'similarFunctions',
        title: '🟣 Funzioni simili',
        items: data.similarFunctions,
        fmt: (x) => `${escapeHtml(x.f1)} ↔ ${escapeHtml(x.f2)} (${x.shared} condivisi, ${x.similarity})`,
      },
      {
        id: 'apiEdges',
        title: '🔗 API frontend↔backend',
        items: data.apiEdges,
        fmt: (x) => `${escapeHtml(x.from)} → ${escapeHtml(x.to)} (${escapeHtml(x.api)})`,
      },
    ];
    let html = '';
    sections.forEach((sec) => {
      const list = sec.items || [];
      html += `<details class="analysis-section" open>
        <summary>
          <span class="analysis-summary-text">${sec.title} (${list.length})</span>
          <button type="button" class="analysis-info-btn" data-help="${sec.id}" title="Spiegazione sezione" aria-label="Informazioni su ${sec.title}">ⓘ</button>
        </summary>
        <div class="body"><ul>`;
      list.slice(0, 30).forEach((it) => {
        html += `<li>${sec.fmt(it)}</li>`;
      });
      if (!list.length) html += '<li class="muted">Nessuno</li>';
      html += '</ul></div></details>';
    });
    $('analysis-sections').innerHTML = html;

    $('analysis-sections').querySelectorAll('.analysis-info-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showAnalysisHelp(btn.getAttribute('data-help') || '');
      });
    });
  }
  $('analysis-recalc').addEventListener('click', () => loadAnalysis(true));

  // Functions list
  async function loadFunctions() {
    const fmap = await api('/api/functions', undefined, 'Elenco funzionalità');
    const filter = ($('fn-filter').value || '').toLowerCase();
    const funcs = (fmap.functions || [])
      .filter((f) => f.validated !== false)
      .filter(
        (f) => !filter || (f.name || '').toLowerCase().includes(filter) || (f.id || '').includes(filter)
      )
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'it'));
    $('fn-list').innerHTML = funcs.length
      ? funcs
          .map(
            (f) => `<div class="fn-row" data-id="${f.id}">
        <span><strong>${escapeHtml(f.name || f.id)}</strong>
          <span class="badge ${f.source === 'label-first' ? 'label' : 'leiden'}">${f.source || 'leiden'}</span></span>
        <span>${(f.files || []).length} file</span>
      </div>`
          )
          .join('')
      : '<p class="muted">Nessuna funzionalità validata</p>';
    document.querySelectorAll('.fn-row').forEach((row) => {
      row.addEventListener('click', () => {
        $('graph-group-filter').value = row.dataset.id;
        document.querySelector('.tab[data-tab="graph"]').click();
        applyGraphFilterAndFocus();
      });
    });
  }
  $('fn-refresh').addEventListener('click', loadFunctions);
  $('fn-filter').addEventListener('input', loadFunctions);

  // Label-first
  let lfResult = null;

  function renderLfNodes() {
    const ul = $('lf-nodes');
    ul.innerHTML = '';
    [...labelFirstNodes].forEach((id) => {
      const n = (graphData.nodes || []).find((x) => x.id === id);
      const li = document.createElement('li');
      li.innerHTML = `<span>${n?.label || id}</span><button type="button" data-id="${id}">Rimuovi</button>`;
      li.querySelector('button').addEventListener('click', () => {
        labelFirstNodes.delete(id);
        renderLfNodes();
        applyGraphFilter();
      });
      ul.appendChild(li);
    });
    $('lf-save').disabled = labelFirstNodes.size === 0;
  }

  function toggleLfNode(id) {
    if (labelFirstNodes.has(id)) labelFirstNodes.delete(id);
    else labelFirstNodes.add(id);
    renderLfNodes();
    applyGraphFilter();
  }

  $('lf-search').addEventListener('click', () => runLabelFirstSearch());
  $('graph-lf-search').addEventListener('click', () => runLabelFirstSearch('graph'));
  $('graph-lf-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runLabelFirstSearch('graph');
    }
  });
  $('lf-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runLabelFirstSearch();
    }
  });

  async function runLabelFirstSearch(source) {
    const fromGraph = source === 'graph';
    const inputEl = fromGraph ? $('graph-lf-input') : $('lf-input');
    const depthEl = fromGraph ? $('graph-lf-depth') : $('lf-depth');
    const statusEl = fromGraph ? $('graph-lf-status') : $('lf-status');
    const input = inputEl.value.trim();
    if (!input) {
      statusEl.textContent = 'Inserisci una descrizione (es. pagina lista contratti)';
      return;
    }
    if (!fromGraph) {
      $('lf-input').value = input;
    } else {
      $('lf-input').value = input;
    }
    const depth = parseInt(depthEl?.value || $('lf-depth')?.value || '2', 10);
    const maxNodes = parseInt($('lf-max')?.value || '100', 10);
    const lfProgress = window.chProgress?.begin('Label-first: ricerca…');

    const finish = (msg) => {
      if (lfProgress) lfProgress.end();
      if (msg.error) {
        statusEl.textContent = msg.error;
        return;
      }
      lfResult = msg;
      labelFirstNodes = new Set(msg.nodes || []);
      $('lf-name').value = input.charAt(0).toUpperCase() + input.slice(1);
      const doneMsg = `✅ Trovati ${msg.count} nodi`;
      statusEl.textContent = doneMsg;
      if (fromGraph) {
        $('lf-status').textContent = doneMsg;
      } else {
        $('graph-lf-status').textContent = doneMsg;
      }
      renderLfNodes();
      applyGraphFilterAndFocus();
      document.querySelector('.tab[data-tab="graph"]').click();
    };

    try {
      const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${wsProto}//${location.host}/ws/graph`);
      let settled = false;
      ws.onopen = () => {
        ws.send(JSON.stringify({ action: 'label_first', input, depth, maxNodes }));
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.stage === 'expansion_done') {
          statusEl.textContent = 'Espansione query...';
          lfProgress?.set(25, 'Label-first: espansione query');
        }
        if (msg.stage === 'seeds_done') {
          statusEl.textContent = `Seed trovati: ${(msg.seeds || []).length}`;
          lfProgress?.set(50, 'Label-first: seed trovati');
        }
        if (msg.stage === 'traverse') {
          statusEl.textContent = msg.message || 'Traversal grafo...';
          lfProgress?.set(70, msg.message || 'Label-first: traversal');
        }
        if (msg.stage === 'done') {
          settled = true;
          lfProgress?.set(100, 'Label-first completato');
          finish(msg);
          ws.close();
        }
        if (msg.stage === 'error') {
          settled = true;
          statusEl.textContent = msg.message || 'Errore';
          lfProgress?.end();
          ws.close();
        }
      };
      ws.onerror = () => {
        if (settled) return;
        api(
          '/api/graph/label-first',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input, depth, maxNodes }),
          },
          'Label-first'
        ).then(finish);
      };
      ws.onclose = () => {
        if (!settled && lfProgress) lfProgress.end();
      };
    } catch (e) {
      if (lfProgress) lfProgress.end();
      statusEl.textContent = String(e);
    }
  }

  $('lf-save').addEventListener('click', async () => {
    const res = await api(
      '/api/graph/label-first/save',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: $('lf-name').value.trim(),
          labelInput: $('lf-input').value.trim(),
          nodes: [...labelFirstNodes],
          traversalDepth: parseInt($('lf-depth').value, 10),
        }),
      },
      'Salvataggio funzionalità'
    );
    if (res.error) {
      $('lf-status').textContent = res.error;
      return;
    }
    $('lf-status').textContent = `Salvata: ${res.function?.name}`;
    labelFirstNodes = new Set();
    renderLfNodes();
    await loadGraph();
    await loadFunctions();
    await loadStatus();
  });

  async function init() {
    const boot = window.chProgress?.begin('Avvio Graph View');
    try {
      await loadStatus();
      await loadGraph();
      await loadFunctions();
      if (window.chSigmaView?.loadFileView) {
        await window.chSigmaView.loadFileView();
      }
      boot?.set(100, 'Pronto');
    } finally {
      boot?.end();
    }
  }

  init().catch((e) => {
    $('status-line').textContent = 'Errore: ' + e.message;
  });
})();
