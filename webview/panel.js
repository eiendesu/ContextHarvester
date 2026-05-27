// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const PHASE_LABELS = {
    query_understanding: 'Query Understanding',
    symbol_search: 'Symbol Search',
    phase2: 'HyDE',
    phase3: 'Retrieval vettoriale',
    iterative: 'Retrieval iterativo',
    grep: 'Grep parallelo',
    phase3b: 'Re-ranking',
    tests: 'Test associati',
    structure: 'Struttura logica',
    negative: 'Negative Context',
    deps: 'Dependency graph',
    confidence: 'Confidence score',
    phase0: 'Vocabulary',
    phase1: 'Indexing',
    symbol_index: 'Symbol index',
    phase_graph: 'Functional Analysis',
    graph_report: 'Graph Report',
  };

  const els = {
    appVersion: document.getElementById('app-version'),
    appBuildMeta: document.getElementById('app-build-meta'),
    bannerOllama: document.getElementById('banner-ollama'),
    bannerIndex: document.getElementById('banner-index'),
    bannerFingerprint: document.getElementById('banner-fingerprint'),
    profileSelect: document.getElementById('profile-select'),
    btnProfileNew: document.getElementById('btn-profile-new'),
    btnProfileDelete: document.getElementById('btn-profile-delete'),
    indexStatus: document.getElementById('index-status'),
    indexLastRun: document.getElementById('index-last-run'),
    indexFiles: document.getElementById('index-files'),
    indexSymbols: document.getElementById('index-symbols'),
    btnRebuild: document.getElementById('btn-rebuild'),
    btnIncremental: document.getElementById('btn-incremental'),
    btnReset: document.getElementById('btn-reset'),
    indexTimingSection: document.getElementById('index-timing-section'),
    indexRunList: document.getElementById('index-run-list'),
    indexRunDetail: document.getElementById('index-run-detail'),
    indexRunDetailTitle: document.getElementById('index-run-detail-title'),
    indexRunDetailMeta: document.getElementById('index-run-detail-meta'),
    indexFolderTbody: document.getElementById('index-folder-tbody'),
    btnExecLog: document.getElementById('btn-exec-log'),
    btnExecLogClear: document.getElementById('btn-exec-log-clear'),
    executionLogSection: document.getElementById('execution-log-section'),
    executionLog: document.getElementById('execution-log'),
    progressIndex: document.getElementById('progress-index'),
    progressFill: document.getElementById('progress-fill'),
    progressText: document.getElementById('progress-text'),
    featureInput: document.getElementById('feature-input'),
    cardId: document.getElementById('card-id'),
    filePreview: document.getElementById('file-preview'),
    outputPath: document.getElementById('output-path'),
    exportJson: document.getElementById('export-json'),
    exportTxt: document.getElementById('export-txt'),
    btnGenerate: document.getElementById('btn-generate'),
    progressGen: document.getElementById('progress-gen'),
    progressGenText: document.getElementById('progress-gen-text'),
    resultSection: document.getElementById('result-section'),
    resultTitle: document.getElementById('result-title'),
    resultMeta: document.getElementById('result-meta'),
    btnOpen: document.getElementById('btn-open'),
    btnCopy: document.getElementById('btn-copy'),
    btnJson: document.getElementById('btn-json'),
    btnTxt: document.getElementById('btn-txt'),
    btnProjectContext: document.getElementById('btn-project-context'),
    srcDocs: document.getElementById('src-docs'),
    focusBackend: document.getElementById('focus-backend'),
    focusFrontend: document.getElementById('focus-frontend'),
    focusSql: document.getElementById('focus-sql'),
    filePicker: document.getElementById('file-picker'),
    btnPickFiles: document.getElementById('btn-pick-files'),
    fileList: document.getElementById('file-list'),
    functionalStatus: document.getElementById('functional-status'),
    functionalBadges: document.getElementById('functional-badges'),
    btnFunctional: document.getElementById('btn-functional'),
    btnGraphView: document.getElementById('btn-graph-view'),
    btnValidate: document.getElementById('btn-validate'),
    btnGraphReport: document.getElementById('btn-graph-report'),
    progressFunctional: document.getElementById('progress-functional'),
    progressFunctionalText: document.getElementById('progress-functional-text'),
    mcpStatus: document.getElementById('mcp-status'),
    mcpLast: document.getElementById('mcp-last'),
    btnMcpStart: document.getElementById('btn-mcp-start'),
    btnMcpStop: document.getElementById('btn-mcp-stop'),
    btnMcpRestart: document.getElementById('btn-mcp-restart'),
  };

  /** @type {{ hasIndex: boolean; ollamaOk: boolean; running: boolean; template: string; lastJson?: string; lastTxt?: string; selectedIndexRunId?: string }} */
  let state = { hasIndex: false, ollamaOk: false, running: false, template: '{CARD}_context' };

  const ACTION_LABELS = {
    rebuild_index: 'Rebuild index',
    incremental_index: 'Reindex incrementale',
  };

  function formatDurationMs(ms) {
    if (!Number.isFinite(ms) || ms < 0) {
      return '—';
    }
    if (ms < 1000) {
      return `${Math.round(ms)} ms`;
    }
    const totalSec = Math.floor(ms / 1000);
    if (totalSec < 60) {
      return `${totalSec}s`;
    }
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  }

  function formatDateTime(iso) {
    if (!iso) {
      return '—';
    }
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('it-IT');
  }

  document.querySelectorAll('.section-header').forEach((header) => {
    header.addEventListener('click', () => {
      header.parentElement?.classList.toggle('collapsed');
    });
  });

  document.querySelectorAll('input[name="inputMode"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      const mode = /** @type {HTMLInputElement} */ (e.target).value;
      els.filePicker?.classList.toggle('hidden', mode !== 'file');
    });
  });

  els.profileSelect?.addEventListener('change', () => {
    const name = /** @type {HTMLSelectElement} */ (els.profileSelect).value;
    vscode.postMessage({ type: 'selectProfile', name });
  });

  els.btnProfileNew?.addEventListener('click', () => vscode.postMessage({ type: 'saveProfile' }));
  els.btnProfileDelete?.addEventListener('click', () => {
    const name = /** @type {HTMLSelectElement} */ (els.profileSelect)?.value;
    if (name) {
      vscode.postMessage({ type: 'deleteProfile', name });
    }
  });

  els.btnRebuild?.addEventListener('click', () => vscode.postMessage({ type: 'rebuildIndex' }));
  els.btnIncremental?.addEventListener('click', () => vscode.postMessage({ type: 'incrementalIndex' }));
  els.btnReset?.addEventListener('click', () => vscode.postMessage({ type: 'resetIndex' }));
  els.btnExecLog?.addEventListener('click', () => vscode.postMessage({ type: 'openExecutionLog' }));
  els.btnExecLogClear?.addEventListener('click', () => vscode.postMessage({ type: 'clearExecutionLog' }));

  function renderExecutionLog(lines, open) {
    if (!els.executionLog) {
      return;
    }
    const text = lines && lines.length ? lines.join('\n') : '(nessun log)';
    els.executionLog.textContent = text;
    els.executionLog.scrollTop = els.executionLog.scrollHeight;
    if (open && els.executionLogSection) {
      els.executionLogSection.classList.remove('hidden');
      els.executionLogSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
  els.btnPickFiles?.addEventListener('click', () => vscode.postMessage({ type: 'pickFiles' }));
  els.btnOpen?.addEventListener('click', () => vscode.postMessage({ type: 'openContext' }));
  els.btnCopy?.addEventListener('click', () => vscode.postMessage({ type: 'copyContext' }));
  els.btnJson?.addEventListener('click', () => vscode.postMessage({ type: 'exportJson' }));
  els.btnTxt?.addEventListener('click', () => vscode.postMessage({ type: 'exportTxt' }));
  els.btnProjectContext?.addEventListener('click', () => vscode.postMessage({ type: 'openProjectContext' }));
  els.btnFunctional?.addEventListener('click', () => vscode.postMessage({ type: 'functionalAnalysis' }));
  els.btnGraphView?.addEventListener('click', () => vscode.postMessage({ type: 'openGraphView' }));
  els.btnValidate?.addEventListener('click', () => vscode.postMessage({ type: 'validateCommunities' }));
  els.btnGraphReport?.addEventListener('click', () => vscode.postMessage({ type: 'openGraphReport' }));
  els.btnMcpStart?.addEventListener('click', () => vscode.postMessage({ type: 'mcpStart' }));
  els.btnMcpStop?.addEventListener('click', () => vscode.postMessage({ type: 'mcpStop' }));
  els.btnMcpRestart?.addEventListener('click', () => vscode.postMessage({ type: 'mcpRestart' }));

  const updatePreview = () => {
    const card = /** @type {HTMLInputElement} */ (els.cardId).value.trim() || 'context';
    const name = state.template.replace(/\{CARD\}/g, card);
    if (els.filePreview) {
      els.filePreview.textContent = `→ ${name.endsWith('.md') ? name : name + '.md'}`;
    }
    updateGenerateButton();
  };

  const updateGenerateButton = () => {
    const card = /** @type {HTMLInputElement} */ (els.cardId).value.trim();
    const text = /** @type {HTMLTextAreaElement} */ (els.featureInput).value.trim();
    if (els.btnGenerate) {
      els.btnGenerate.disabled = !state.hasIndex || !state.ollamaOk || !card || !text || state.running;
    }
  };

  els.cardId?.addEventListener('input', updatePreview);
  els.featureInput?.addEventListener('input', updateGenerateButton);

  els.btnGenerate?.addEventListener('click', () => {
    vscode.postMessage({
      type: 'generateContext',
      cardId: /** @type {HTMLInputElement} */ (els.cardId).value.trim(),
      featureInput: /** @type {HTMLTextAreaElement} */ (els.featureInput).value.trim(),
      includeDocs: /** @type {HTMLInputElement} */ (els.srcDocs).checked,
      focusBackend: /** @type {HTMLInputElement} */ (els.focusBackend).checked,
      focusFrontend: /** @type {HTMLInputElement} */ (els.focusFrontend).checked,
      focusSql: /** @type {HTMLInputElement} */ (els.focusSql).checked,
      exportJson: /** @type {HTMLInputElement} */ (els.exportJson)?.checked,
      exportTxt: /** @type {HTMLInputElement} */ (els.exportTxt)?.checked,
    });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'state':
        applyState(msg);
        break;
      case 'progress':
        showProgress(msg);
        break;
      case 'running':
        state.running = msg.running;
        updateGenerateButton();
        if (els.btnRebuild) {
          els.btnRebuild.disabled = msg.running;
        }
        if (els.btnIncremental) {
          els.btnIncremental.disabled = msg.running;
        }
        break;
      case 'indexRunComplete':
        if (msg.indexRun) {
          renderIndexTiming(msg.indexRun, state.selectedIndexRunId);
        }
        break;
      case 'done':
        hideProgress();
        if (msg.outputFile) {
          state.lastOutput = msg.outputFile;
          state.lastJson = msg.jsonFile;
          state.lastTxt = msg.txtFile;
          els.resultSection?.classList.remove('hidden');
          if (els.resultTitle) {
            els.resultTitle.textContent = `✅ ${msg.outputFile.split(/[/\\]/).pop()}`;
          }
          if (els.resultMeta) {
            const score = msg.confidenceScore != null ? ` • score: ${msg.confidenceScore}/10` : '';
            els.resultMeta.textContent =
              `${msg.chunksCount ?? 0} chunk • ${msg.depsCount ?? 0} dep • ${msg.testsCount ?? 0} test${score}`;
          }
          els.btnJson?.classList.toggle('hidden', !msg.jsonFile);
          els.btnTxt?.classList.toggle('hidden', !msg.txtFile);
        }
        break;
      case 'error':
        hideProgress();
        if (els.bannerOllama) {
          els.bannerOllama.textContent = `❌ ${msg.message}`;
          els.bannerOllama.classList.remove('hidden');
        }
        break;
      case 'executionLog':
        renderExecutionLog(msg.lines, Boolean(msg.open));
        break;
      case 'filesSelected':
        if (msg.content && els.featureInput) {
          /** @type {HTMLTextAreaElement} */ (els.featureInput).value = msg.content;
        }
        if (els.fileList && msg.paths) {
          els.fileList.innerHTML = msg.paths.map((p) => `<li><span>${p.split(/[/\\]/).pop()}</span></li>`).join('');
        }
        updateGenerateButton();
        break;
    }
  });

  function applyState(msg) {
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
    state.template = msg.fileNameTemplate || '{CARD}_context';
    state.hasIndex = Boolean(msg.indexMeta?.lastIndexed);
    state.ollamaOk = Boolean(msg.ollama?.reachable && !(msg.ollama?.missingModels?.length));

    if (els.profileSelect && msg.profiles) {
      const select = /** @type {HTMLSelectElement} */ (els.profileSelect);
      select.innerHTML = msg.profiles
        .map((p) => `<option value="${p.name}" ${p.name === msg.activeProfile ? 'selected' : ''}>${p.label}</option>`)
        .join('');
    }

    if (els.outputPath) {
      els.outputPath.textContent = `Path: ${msg.outputPath || '—'}`;
    }

    state.selectedIndexRunId = msg.selectedIndexRunId;

    if (msg.indexMeta?.lastIndexed) {
      const d = new Date(msg.indexMeta.lastIndexed);
      if (els.indexStatus) {
        els.indexStatus.textContent = `Ultimo index: ${d.toLocaleString('it-IT')}`;
      }
      if (els.indexFiles) {
        els.indexFiles.textContent = `File: ${msg.indexMeta.totalFiles ?? '—'}`;
      }
      if (els.indexSymbols) {
        const sym = msg.indexMeta.symbolsIndexed;
        if (sym != null) {
          els.indexSymbols.textContent = `Simboli: ${sym} • Usages: ${msg.indexMeta.usagesIndexed ?? 0}`;
        }
      }
      els.bannerIndex?.classList.add('hidden');
    } else {
      if (els.indexStatus) {
        els.indexStatus.textContent = 'Nessun index';
      }
      if (els.bannerIndex) {
        els.bannerIndex.textContent = '⚠️ Index non costruito — esegui Rebuild Index';
        els.bannerIndex.classList.remove('hidden');
      }
    }

    if (els.bannerOllama) {
      if (!msg.ollama?.reachable) {
        const urls = msg.ollama?.urls?.join(', ') || msg.ollamaUrl || 'localhost:11434';
        els.bannerOllama.textContent = `❌ Ollama non raggiungibile su ${urls}`;
        els.bannerOllama.classList.remove('hidden');
      } else if (msg.ollama?.missingModels?.length) {
        const m = msg.ollama.missingModels[0];
        els.bannerOllama.textContent = `⚠️ Modello ${m} non trovato — esegui: ollama pull ${m}`;
        els.bannerOllama.classList.remove('hidden');
      } else {
        els.bannerOllama.classList.add('hidden');
      }
    }

    if (msg.graphMeta) {
      const g = msg.graphMeta;
      if (els.functionalStatus) {
        if (g.communities > 0) {
          els.functionalStatus.textContent = `Community: ${g.communities} (${g.validated ?? 0} validate)${
            g.functionalMapReady ? ' — pronto' : ' — validazione richiesta'
          }`;
        } else {
          els.functionalStatus.textContent = 'Nessuna analisi — esegui Rigenera analisi';
        }
      }
      const hasGraph = Boolean(g.hasGraph);
      if (els.btnGraphView) {
        els.btnGraphView.disabled = !hasGraph;
      }
      if (els.btnValidate) {
        els.btnValidate.disabled = !g.communities;
      }
      if (els.btnGraphReport) {
        els.btnGraphReport.disabled = !hasGraph;
      }
    }

    if (msg.analysisBadges && els.functionalBadges) {
      const circ = msg.analysisBadges.circular;
      const dead = msg.analysisBadges.deadCode;
      if (circ || dead) {
        const parts = [];
        if (circ) parts.push(`${circ} dipendenze circolari`);
        if (dead) parts.push(`${dead} dead code candidates`);
        els.functionalBadges.textContent = `⚠️ ${parts.join('  •  ')}`;
        els.functionalBadges.classList.remove('hidden');
      } else {
        els.functionalBadges.classList.add('hidden');
      }
    }

    if (msg.mcp && els.mcpStatus) {
      if (msg.mcp.running) {
        els.mcpStatus.textContent = `● Attivo su :${msg.mcp.port}`;
        els.mcpStatus.classList.add('mcp-on');
      } else {
        els.mcpStatus.textContent = '● Non attivo';
        els.mcpStatus.classList.remove('mcp-on');
      }
      if (els.mcpLast && msg.mcp.lastCall?.tool) {
        els.mcpLast.textContent = `Ultima: ${msg.mcp.lastCall.tool} (${msg.mcp.lastCall.duration_s ?? '?'}s)`;
      }
      if (els.btnMcpStart) {
        els.btnMcpStart.disabled = Boolean(msg.mcp.running);
      }
      if (els.btnMcpStop) {
        els.btnMcpStop.disabled = !msg.mcp.running;
      }
      if (els.btnMcpRestart) {
        els.btnMcpRestart.disabled = !msg.mcp.running;
      }
    }

    if (msg.executionLogLines) {
      renderExecutionLog(msg.executionLogLines, false);
    }

    renderIndexTimingSummary(msg.lastIndexRun);
    renderIndexRunHistory(msg.indexRunHistory || [], msg.selectedIndexRunId, msg.selectedIndexRun);

    updatePreview();
  }

  function renderIndexTimingSummary(lastRun) {
    if (!els.indexLastRun) {
      return;
    }
    if (!lastRun) {
      els.indexLastRun.textContent = 'Ultima esecuzione index: nessun dato tempi';
      return;
    }
    const label = ACTION_LABELS[lastRun.action] || lastRun.action;
    const ok = lastRun.success !== false ? '✅' : '❌';
    const when = formatDateTime(lastRun.finishedAt || lastRun.startedAt);
    els.indexLastRun.textContent = `Ultima esecuzione: ${label} — ${formatDurationMs(lastRun.durationMs)} ${ok} (${when})`;
  }

  function renderIndexRunHistory(runs, selectedId, selectedRun) {
    if (!els.indexTimingSection || !els.indexRunList) {
      return;
    }
    if (!runs.length) {
      els.indexTimingSection.classList.add('hidden');
      els.indexRunDetail?.classList.add('hidden');
      return;
    }
    els.indexTimingSection.classList.remove('hidden');
    els.indexRunList.innerHTML = runs
      .map((run) => {
        const label = ACTION_LABELS[run.action] || run.action;
        const when = formatDateTime(run.finishedAt || run.startedAt);
        const dur = formatDurationMs(run.durationMs);
        const fail = run.success === false ? ' run-failed' : '';
        const sel = run.id === selectedId ? ' selected' : '';
        return `<li><button type="button" class="index-run-item${fail}${sel}" data-run-id="${run.id}">
          <strong>${label}</strong> — ${dur}<br/><span class="muted">${when}</span>
        </button></li>`;
      })
      .join('');

    els.indexRunList.querySelectorAll('.index-run-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const runId = btn.getAttribute('data-run-id');
        if (runId) {
          vscode.postMessage({ type: 'selectIndexRun', runId });
        }
      });
    });

    if (selectedRun) {
      renderIndexRunDetail(selectedRun);
    } else {
      els.indexRunDetail?.classList.add('hidden');
    }
  }

  function renderIndexRunDetail(run) {
    if (!els.indexRunDetail || !run) {
      return;
    }
    els.indexRunDetail.classList.remove('hidden');
    const label = ACTION_LABELS[run.action] || run.action;
    if (els.indexRunDetailTitle) {
      els.indexRunDetailTitle.textContent = `${label} — ${formatDurationMs(run.durationMs)}`;
    }
    if (els.indexRunDetailMeta) {
      const phases = run.phasesMs
        ? Object.entries(run.phasesMs)
            .map(([k, v]) => `${k}: ${formatDurationMs(Number(v))}`)
            .join(' • ')
        : '';
      const stats = run.stats || {};
      const statLine = [
        stats.totalFiles != null ? `file ${stats.totalFiles}` : '',
        stats.symbolsIndexed != null ? `simboli ${stats.symbolsIndexed}` : '',
      ]
        .filter(Boolean)
        .join(' • ');
      const status = run.success === false ? `❌ ${run.error || 'errore'}` : '✅ completato';
      els.indexRunDetailMeta.textContent = [
        `${formatDateTime(run.startedAt)} → ${formatDateTime(run.finishedAt)}`,
        status,
        statLine,
        phases,
      ]
        .filter(Boolean)
        .join(' | ');
    }
    if (els.indexFolderTbody) {
      const folders = Array.isArray(run.folders) ? run.folders : [];
      if (!folders.length) {
        els.indexFolderTbody.innerHTML =
          '<tr><td colspan="5" class="muted">Nessun dato per cartella</td></tr>';
      } else {
        els.indexFolderTbody.innerHTML = folders
          .map(
            (f) => `<tr>
            <td>${escapeHtml(f.folder)}</td>
            <td class="num">${formatDurationMs(f.durationMs)}</td>
            <td class="num">${f.filesProcessed ?? 0}</td>
            <td class="num">${f.filesIndexed ?? 0}</td>
            <td class="num">${f.filesSkippedUnchanged ?? 0}</td>
          </tr>`
          )
          .join('');
      }
    }
  }

  function renderIndexTiming(indexRun, selectedId) {
    renderIndexTimingSummary(indexRun);
    state.selectedIndexRunId = indexRun?.id || selectedId;
    if (indexRun) {
      renderIndexRunDetail(indexRun);
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showProgress(msg) {
    const isFunctional = ['phase_graph', 'graph_report'].includes(msg.phase);
    const isIndex = ['phase0', 'phase1', 'symbol_index'].includes(msg.phase);
    const box = isFunctional ? els.progressFunctional : isIndex ? els.progressIndex : els.progressGen;
    const text = isFunctional ? els.progressFunctionalText : isIndex ? els.progressText : els.progressGenText;
    box?.classList.remove('hidden');
    if (text) {
      const label = PHASE_LABELS[msg.phase] || msg.phase;
      const pct = msg.total ? ` (${msg.current}/${msg.total})` : '';
      text.innerHTML = `<span class="spinner"></span> ${label}: ${msg.message || ''}${pct}`;
    }
    if (isIndex && els.progressFill && msg.total) {
      els.progressFill.style.width = `${Math.round((msg.current / msg.total) * 100)}%`;
    }
  }

  function hideProgress() {
    els.progressIndex?.classList.add('hidden');
    els.progressGen?.classList.add('hidden');
    els.progressFunctional?.classList.add('hidden');
  }

  vscode.postMessage({ type: 'ready' });
})();
