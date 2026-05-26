// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const els = {
    bannerOllama: document.getElementById('banner-ollama'),
    bannerIndex: document.getElementById('banner-index'),
    indexStatus: document.getElementById('index-status'),
    indexFiles: document.getElementById('index-files'),
    btnRebuild: document.getElementById('btn-rebuild'),
    btnReset: document.getElementById('btn-reset'),
    progressIndex: document.getElementById('progress-index'),
    progressFill: document.getElementById('progress-fill'),
    progressText: document.getElementById('progress-text'),
    featureInput: document.getElementById('feature-input'),
    cardId: document.getElementById('card-id'),
    filePreview: document.getElementById('file-preview'),
    outputPath: document.getElementById('output-path'),
    btnGenerate: document.getElementById('btn-generate'),
    progressGen: document.getElementById('progress-gen'),
    progressGenText: document.getElementById('progress-gen-text'),
    resultSection: document.getElementById('result-section'),
    resultTitle: document.getElementById('result-title'),
    resultMeta: document.getElementById('result-meta'),
    btnOpen: document.getElementById('btn-open'),
    srcDocs: document.getElementById('src-docs'),
    focusBackend: document.getElementById('focus-backend'),
    focusFrontend: document.getElementById('focus-frontend'),
    focusSql: document.getElementById('focus-sql'),
    filePicker: document.getElementById('file-picker'),
    btnPickFiles: document.getElementById('btn-pick-files'),
    fileList: document.getElementById('file-list'),
  };

  /** @type {{ hasIndex: boolean; ollamaOk: boolean; lastOutput?: string; template: string }} */
  let state = { hasIndex: false, ollamaOk: false, running: false, template: '{CARD}_context' };

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

  els.btnRebuild?.addEventListener('click', () => vscode.postMessage({ type: 'rebuildIndex' }));
  els.btnReset?.addEventListener('click', () => vscode.postMessage({ type: 'resetIndex' }));
  els.btnPickFiles?.addEventListener('click', () => vscode.postMessage({ type: 'pickFiles' }));
  els.btnOpen?.addEventListener('click', () => vscode.postMessage({ type: 'openContext', path: state.lastOutput }));

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
        els.btnRebuild.disabled = msg.running;
        break;
      case 'done':
        hideProgress();
        if (msg.outputFile) {
          state.lastOutput = msg.outputFile;
          els.resultSection?.classList.remove('hidden');
          if (els.resultTitle) {
            els.resultTitle.textContent = `✅ ${msg.outputFile.split(/[/\\]/).pop()}`;
          }
          if (els.resultMeta) {
            els.resultMeta.textContent = `${msg.chunksCount ?? 0} chunk • ${msg.depsCount ?? 0} file dipendenti`;
          }
        }
        break;
      case 'error':
        hideProgress();
        if (els.bannerOllama) {
          els.bannerOllama.textContent = `❌ ${msg.message}`;
          els.bannerOllama.classList.remove('hidden');
        }
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
    state.template = msg.fileNameTemplate || '{CARD}_context';
    state.hasIndex = Boolean(msg.indexMeta?.lastIndexed);
    state.ollamaOk = Boolean(msg.ollama?.reachable && !(msg.ollama?.missingModels?.length));

    if (els.outputPath) {
      els.outputPath.textContent = `Path: ${msg.outputPath || '—'}`;
    }

    if (msg.indexMeta?.lastIndexed) {
      const d = new Date(msg.indexMeta.lastIndexed);
      if (els.indexStatus) {
        els.indexStatus.textContent = `Ultimo index: ${d.toLocaleString('it-IT')}`;
      }
      if (els.indexFiles) {
        els.indexFiles.textContent = `File indicizzati: ${msg.indexMeta.totalFiles ?? '—'}`;
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
        els.bannerOllama.textContent = `❌ Ollama non raggiungibile su ${msg.ollamaUrl || 'localhost:11434'}`;
        els.bannerOllama.classList.remove('hidden');
      } else if (msg.ollama?.missingModels?.length) {
        const m = msg.ollama.missingModels[0];
        els.bannerOllama.textContent = `⚠️ Modello ${m} non trovato — esegui: ollama pull ${m}`;
        els.bannerOllama.classList.remove('hidden');
      } else {
        els.bannerOllama.classList.add('hidden');
      }
    }

    updatePreview();
  }

  function showProgress(msg) {
    const isIndex = ['phase0', 'phase1'].includes(msg.phase);
    const box = isIndex ? els.progressIndex : els.progressGen;
    const text = isIndex ? els.progressText : els.progressGenText;
    box?.classList.remove('hidden');
    if (text) {
      const pct = msg.total ? ` (${msg.current}/${msg.total})` : '';
      text.textContent = `${msg.message || msg.phase}${pct}`;
    }
    if (isIndex && els.progressFill && msg.total) {
      els.progressFill.style.width = `${Math.round((msg.current / msg.total) * 100)}%`;
    }
  }

  function hideProgress() {
    els.progressIndex?.classList.add('hidden');
    els.progressGen?.classList.add('hidden');
  }

  vscode.postMessage({ type: 'ready' });
})();
