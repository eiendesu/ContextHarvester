(function () {
  const vscode = acquireVsCodeApi();

  const els = {
    appVersion: document.getElementById('app-version'),
    appBuildMeta: document.getElementById('app-build-meta'),
    repoPath: document.getElementById('repoPath'),
    indexStatus: document.getElementById('indexStatus'),
    cacheStatus: document.getElementById('cacheStatus'),
    cardId: document.getElementById('cardId'),
    featureInput: document.getElementById('featureInput'),
    includeDocs: document.getElementById('includeDocs'),
    enableConfidence: document.getElementById('enableConfidence'),
    enableFunctionalAnalysis: document.getElementById('enableFunctionalAnalysis'),
    focusBackend: document.getElementById('focusBackend'),
    focusFrontend: document.getElementById('focusFrontend'),
    focusSql: document.getElementById('focusSql'),
    incremental: document.getElementById('incremental'),
    phaseGroups: document.getElementById('phaseGroups'),
    artifacts: document.getElementById('artifacts'),
    log: document.getElementById('log'),
    overlay: document.getElementById('overlay'),
  };

  let running = false;

  function payload() {
    return {
      cardId: els.cardId.value.trim(),
      featureInput: els.featureInput.value.trim(),
      includeDocs: els.includeDocs.checked,
      enableConfidence: els.enableConfidence.checked,
      enableFunctionalAnalysis: els.enableFunctionalAnalysis.checked,
      focusBackend: els.focusBackend.checked,
      focusFrontend: els.focusFrontend.checked,
      focusSql: els.focusSql.checked,
      incremental: els.incremental.checked,
    };
  }

  function setRunning(value) {
    running = value;
    els.overlay.classList.toggle('hidden', !value);
    document.querySelectorAll('button').forEach((b) => {
      b.disabled = value;
    });
  }

  function renderPhases(phases) {
    if (!phases || !phases.length) return;
    const byGroup = {};
    phases.forEach((p) => {
      if (!byGroup[p.group]) byGroup[p.group] = [];
      byGroup[p.group].push(p);
    });
    els.phaseGroups.innerHTML = '';
    Object.keys(byGroup).forEach((group) => {
      const wrap = document.createElement('div');
      wrap.className = 'phase-group';
      const title = document.createElement('div');
      title.className = 'phase-group-title';
      title.textContent = group;
      const grid = document.createElement('div');
      grid.className = 'phase-grid';
      byGroup[group].forEach((p) => {
        const btn = document.createElement('button');
        btn.className = 'btn';
        btn.textContent = p.label;
        btn.dataset.phase = p.id;
        btn.addEventListener('click', () => {
          vscode.postMessage({ type: 'runPhase', phase: p.id, ...payload() });
        });
        grid.appendChild(btn);
      });
      wrap.appendChild(title);
      wrap.appendChild(grid);
      els.phaseGroups.appendChild(wrap);
    });
  }

  function renderArtifacts(artifacts) {
    els.artifacts.innerHTML = '';
    (artifacts || []).forEach((a) => {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'dot ' + (a.exists ? 'ok' : 'missing');
      const name = document.createElement('span');
      name.textContent = a.name + (a.exists ? '' : ' (mancante)');
      li.appendChild(dot);
      li.appendChild(name);
      if (a.exists) {
        li.addEventListener('click', () => {
          vscode.postMessage({ type: 'openArtifact', path: a.path });
        });
      }
      els.artifacts.appendChild(li);
    });
  }

  function renderLog(lines) {
    els.log.textContent = (lines && lines.length) ? lines.join('\n') : '(nessun log)';
    els.log.scrollTop = els.log.scrollHeight;
  }

  document.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      if (action === 'check_fingerprint') {
        vscode.postMessage({ type: 'checkFingerprint', ...payload() });
      } else {
        vscode.postMessage({ type: 'orchestratorAction', action, ...payload() });
      }
    });
  });

  document.getElementById('btnCheckOllama').addEventListener('click', () => {
    vscode.postMessage({ type: 'checkOllama' });
  });
  document.getElementById('btnOpenFolder').addEventListener('click', () => {
    vscode.postMessage({ type: 'openHarvesterFolder' });
  });
  document.getElementById('btnResetIndex').addEventListener('click', () => {
    vscode.postMessage({ type: 'resetIndex' });
  });
  document.getElementById('btnGraphView').addEventListener('click', () => {
    vscode.postMessage({ type: 'openGraphView' });
  });
  document.getElementById('btnValidate').addEventListener('click', () => {
    vscode.postMessage({ type: 'validateCommunities' });
  });
  document.getElementById('btnGraphReport').addEventListener('click', () => {
    vscode.postMessage({ type: 'openGraphReport' });
  });
  document.getElementById('btnMcpStart').addEventListener('click', () => {
    vscode.postMessage({ type: 'mcpStart' });
  });
  document.getElementById('btnMcpStop').addEventListener('click', () => {
    vscode.postMessage({ type: 'mcpStop' });
  });
  document.getElementById('btnMcpRestart').addEventListener('click', () => {
    vscode.postMessage({ type: 'mcpRestart' });
  });
  document.getElementById('btnClearLog').addEventListener('click', () => {
    vscode.postMessage({ type: 'clearLog' });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'state':
        if (els.appVersion && msg.versionLabel) {
          els.appVersion.textContent = msg.versionLabel;
        }
        if (els.appBuildMeta) {
          const b = msg.buildInfo || {};
          if (b.buildLocal || b.buildUtc || b.version) {
            const local = b.buildLocal ? `Locale ${b.buildLocal}` : '';
            const utc = b.buildUtc ? `UTC ${b.buildUtc}` : '';
            const parts = [b.version ? `Versione ${b.version}` : '', local, utc].filter(Boolean);
            els.appBuildMeta.textContent = `Build: ${parts.join(' · ')}`;
          } else {
            els.appBuildMeta.textContent = 'Build: non disponibile';
          }
        }
        els.repoPath.textContent = msg.repoPath || '(nessun repo)';
        if (msg.indexMeta) {
          const m = msg.indexMeta;
          els.indexStatus.textContent =
            `Indice: ${m.totalFiles ?? '?'} file, ultimo: ${m.lastIndexed ?? '?'}`;
        } else {
          els.indexStatus.textContent = 'Indice: non presente';
        }
        if (msg.cacheSummary) {
          const c = msg.cacheSummary;
          els.cacheStatus.textContent =
            `Cache lab: chunks=${c.chunksCount ?? 0}, hyde=${c.hydeCount ?? 0}, ultima fase=${c.lastPhase ?? '—'}`;
        } else {
          els.cacheStatus.textContent = 'Cache lab: vuota';
        }
        if (msg.enableConfidenceScore != null) {
          els.enableConfidence.checked = Boolean(msg.enableConfidenceScore);
        }
        if (msg.enableFunctionalAnalysis != null) {
          els.enableFunctionalAnalysis.checked = Boolean(msg.enableFunctionalAnalysis);
        }
        renderPhases(msg.phases);
        renderArtifacts(msg.artifacts);
        if (msg.logLines) renderLog(msg.logLines);
        setRunning(Boolean(msg.running));
        break;
      case 'running':
        setRunning(Boolean(msg.running));
        break;
      case 'log':
        renderLog(msg.lines);
        break;
      case 'progress':
        break;
      case 'done':
      case 'error':
      case 'fingerprint':
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
