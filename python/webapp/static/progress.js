/* Barra di avanzamento globale — Context Harvester Graph View */
(function (global) {
  const stack = [];
  let idSeq = 0;

  function el(id) {
    return document.getElementById(id);
  }

  function friendlyPath(path) {
    const p = String(path || '').split('?')[0];
    const map = {
      '/api/status': 'Stato repository',
      '/api/graph': 'Grafo funzionale',
      '/api/graph/file': 'Vista file',
      '/api/graph/detail': 'Grafo dettagliato',
      '/api/graph/analysis': 'Analisi grafo',
      '/api/functions': 'Funzionalità',
      '/api/symbols': 'Catalogo simboli',
      '/api/graph/api-links': 'Collegamenti API',
    };
    if (map[p]) return map[p];
    if (p.includes('/api/graph/expand')) return 'Espansione file';
    if (p.includes('/api/graph/search')) return 'Ricerca nodi';
    if (p.includes('/api/graph/impact')) return 'Analisi impatto';
    if (p.includes('/api/graph/path')) return 'Percorso API';
    if (p.includes('/api/graph/label-first')) return 'Label-first';
    return p || 'Caricamento';
  }

  function render() {
    const root = el('ch-progress');
    const fill = el('ch-progress-bar');
    const lab = el('ch-progress-label');
    if (!root || !fill || !lab) return;

    if (!stack.length) {
      root.classList.add('hidden');
      root.setAttribute('aria-hidden', 'true');
      return;
    }

    const top = stack[stack.length - 1];
    root.classList.remove('hidden');
    root.setAttribute('aria-hidden', 'false');
    lab.textContent =
      stack.length > 1 ? `${top.label} (${stack.length} attività)` : top.label || 'Caricamento…';

    if (top.percent == null) {
      fill.classList.add('indeterminate');
      fill.style.width = '';
    } else {
      fill.classList.remove('indeterminate');
      const pct = Math.min(100, Math.max(0, top.percent));
      fill.style.width = `${pct}%`;
    }
  }

  function begin(label, percent) {
    const id = ++idSeq;
    stack.push({ id, label: label || 'Caricamento…', percent: percent ?? null });
    render();
    return {
      set(percent, label) {
        const t = stack.find((x) => x.id === id);
        if (!t) return;
        if (percent != null) t.percent = percent;
        if (label) t.label = label;
        render();
      },
      end() {
        const i = stack.findIndex((x) => x.id === id);
        if (i >= 0) stack.splice(i, 1);
        render();
      },
    };
  }

  async function track(label, fn) {
    const task = begin(label);
    try {
      return await fn((percent, msg) => task.set(percent, msg));
    } finally {
      task.end();
    }
  }

  async function fetchJson(path, opts, label) {
    const msg = label || friendlyPath(path);
    return track(msg, async (set) => {
      set(15, msg);
      const res = await fetch(path, opts);
      set(60, msg);
      if (!res.ok) {
        let errBody = {};
        try {
          errBody = await res.json();
        } catch (_) {}
        const err = new Error(errBody.error || res.statusText || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      set(100, msg);
      return data;
    });
  }

  global.chProgress = { begin, track, fetchJson, friendlyPath };
})(window);
