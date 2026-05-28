// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const $ = (id) => document.getElementById(id);

  const TRIGGER_LABELS = {
    reindex: 'Rebuild Index',
    incremental_index: 'Index incrementale',
    manual: 'Scan manuale',
  };

  let state = {
    selectedRunId: '',
    fileFilter: '',
  };

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDuration(ms) {
    if (!ms || ms < 0) return '—';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
  }

  function renderSummary(detail) {
    const el = $('summary-cards');
    if (!el) return;
    if (!detail?.summary) {
      el.innerHTML = '';
      return;
    }
    const s = detail.summary;
    const items = [
      ['File', s.fileCount],
      ['Classi', s.classCount],
      ['Metodi', s.methodCount],
      ['Endpoint', s.endpointCount],
      ['Controller', s.controllerCount],
    ];
    el.innerHTML = items
      .map(
        ([l, n]) =>
          `<div class="card"><div class="n">${n}</div><div class="l">${esc(l)}</div></div>`
      )
      .join('');
  }

  function renderFiles(detail) {
    const list = $('file-list');
    if (!list) return;
    if (!detail?.files?.length) {
      list.innerHTML = '<p class="muted">Nessun file C# nell\'analisi selezionata.</p>';
      return;
    }
    const q = state.fileFilter.toLowerCase();
    const files = detail.files.filter((f) => !q || (f.path || '').toLowerCase().includes(q));
    let html = '';
    if (detail.truncated) {
      html += `<p class="muted small">Mostrati ${files.length} file (lista troncata a 800).</p>`;
    }
    files.forEach((f) => {
      const path = f.path || '';
      const label = `${path} — ${f.classCount} classi, ${f.methodCount} metodi, ${f.endpointCount} ep`;
      html += `<details class="file-item"><summary>${esc(label)}</summary><div class="file-body">`;
      (f.classes || []).forEach((c) => {
        const line = c.line || 1;
        const kind = c.kind || 'class';
        const extra = c.isController ? '<span class="badge">Controller</span>' : '';
        html += `<div class="sym-row"><button type="button" class="link" data-path="${esc(path)}" data-line="${line}">${esc(c.name)}</button><span>${esc(kind)}${extra} :${line}</span></div>`;
      });
      (f.methods || []).forEach((m) => {
        const line = m.line || 1;
        const qn = m.qualifiedName || m.name;
        html += `<div class="sym-row"><button type="button" class="link" data-path="${esc(path)}" data-line="${line}">${esc(qn)}</button><span>metodo :${line}</span></div>`;
      });
      (f.endpoints || []).forEach((e) => {
        const line = e.line || 1;
        const lbl = `${e.method || 'GET'} ${e.action || ''}`;
        html += `<div class="sym-row"><button type="button" class="link" data-path="${esc(path)}" data-line="${line}">${esc(lbl)}</button><span>endpoint</span></div>`;
      });
      html += '</div></details>';
    });
    list.innerHTML = html;
    list.querySelectorAll('button.link').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        vscode.postMessage({
          type: 'openFile',
          path: btn.getAttribute('data-path'),
          line: parseInt(btn.getAttribute('data-line') || '1', 10),
        });
      });
    });
  }

  function renderHistory(msg) {
    const ul = $('history-list');
    if (!ul) return;
    const runs = msg.history || [];
    if (!runs.length) {
      ul.innerHTML = '<li class="muted">Nessuna voce nello storico.</li>';
      return;
    }
    ul.innerHTML = runs
      .map((r) => {
        const sel = r.id === msg.selectedRunId ? ' selected' : '';
        const tr = TRIGGER_LABELS[r.trigger] || r.trigger;
        const s = r.summary || {};
        const when = (r.finishedAt || r.startedAt || '').replace('T', ' ').slice(0, 19);
        return `<li><button type="button" class="hist-btn${sel}" data-id="${esc(r.id)}">
          <strong>${esc(tr)}</strong> · ${esc(when)}<br/>
          <span class="muted small">${s.fileCount || 0} file · ${s.classCount || 0} classi · ${s.methodCount || 0} metodi</span>
        </button></li>`;
      })
      .join('');
    ul.querySelectorAll('.hist-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'selectRun', runId: btn.getAttribute('data-id') });
      });
    });
  }

  function applyState(msg) {
    if ($('app-version')) $('app-version').textContent = msg.versionLabel || '—';
    if ($('repo-line')) {
      $('repo-line').textContent = msg.repoPath ? `Repo: ${msg.repoPath}` : 'Nessun workspace';
    }

    const banner = $('banner-dotnet');
    if (banner) {
      if (!msg.dotnetOk) {
        banner.textContent = '.NET SDK non trovato nel PATH — Roslyn non può essere eseguito.';
        banner.classList.remove('hidden');
      } else if (msg.useRoslyn === false) {
        banner.textContent = 'contextHarvester.useRoslyn è disattivato nelle impostazioni.';
        banner.classList.remove('hidden');
      } else {
        banner.classList.add('hidden');
      }
    }

    const empty = $('banner-empty');
    if (empty) {
      empty.classList.toggle('hidden', Boolean(msg.detail));
    }

    if ($('btn-scan')) $('btn-scan').disabled = Boolean(msg.running) || !msg.dotnetOk;

    if (msg.detail?.meta) {
      const m = msg.detail.meta;
      const tr = TRIGGER_LABELS[m.trigger] || m.trigger;
      $('detail-meta').textContent = `${tr} · ${(m.finishedAt || '').replace('T', ' ').slice(0, 19)} · ${formatDuration(m.durationMs)}`;
    } else {
      $('detail-meta').textContent = '';
    }

    renderSummary(msg.detail);
    renderFiles(msg.detail);
    renderHistory(msg);

    state.selectedRunId = msg.selectedRunId || '';
  }

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.getAttribute('data-tab');
      const panel = $('panel-' + tab);
      if (panel) panel.classList.add('active');
    });
  });

  $('btn-scan')?.addEventListener('click', () => vscode.postMessage({ type: 'runScan' }));
  $('file-filter')?.addEventListener('input', (e) => {
    state.fileFilter = e.target.value;
    window.dispatchEvent(new CustomEvent('ch-rerender'));
  });

  window.addEventListener('ch-rerender', () => {
    if (window._lastRoslynState) applyState(window._lastRoslynState);
  });

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg.type === 'state') {
      window._lastRoslynState = msg;
      applyState(msg);
    }
    if (msg.type === 'running') {
      $('scan-progress').textContent = msg.running ? msg.progress || 'In corso…' : '';
    }
    if (msg.type === 'progress') {
      $('scan-progress').textContent = msg.message || '';
    }
    if (msg.type === 'error') {
      $('scan-progress').textContent = msg.message || 'Errore';
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
