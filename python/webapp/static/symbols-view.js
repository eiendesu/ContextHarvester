/* Tab Simboli — catalogo metodi, classi, DTO, endpoint */
(function () {
  const $ = (id) => document.getElementById(id);
  let catalog = [];
  let catalogSource = "";
  let loaded = false;
  let renderGen = 0;
  const ROW_BATCH = 400;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function fetchCatalog() {
    const IS_MOCK = new URLSearchParams(location.search).get("mock") === "1";
    if (IS_MOCK) {
      const res = await fetch("/static/mock/symbols.json");
      return res.json();
    }
    const fetchJson = window.chProgress?.fetchJson;
    if (fetchJson) {
      return fetchJson("/api/symbols?limit=0", undefined, "Catalogo simboli");
    }
    const res = await fetch("/api/symbols?limit=0");
    return res.json();
  }

  function getFiltered() {
    const q = ($("sym-search")?.value || "").toLowerCase().trim();
    const type = $("sym-type-filter")?.value || "";
    return catalog.filter((s) => {
      if (type && s.type !== type) return false;
      if (!q) return true;
      const hay =
        `${s.label} ${s.qualifiedName} ${s.filePath} ${s.type} ${s.typeLabel || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }

  function updateMeta(filtered) {
    const el = $("sym-meta");
    if (!el) return;
    if (!catalog.length) {
      el.textContent = "Nessun simbolo in indice.";
      return;
    }
    const src = catalogSource ? ` · fonte: ${catalogSource}` : "";
    const counts = {};
    catalog.forEach((s) => {
      counts[s.type] = (counts[s.type] || 0) + 1;
    });
    const parts = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([t, n]) => `${t}: ${n}`);
    const q = ($("sym-search")?.value || "").trim();
    const type = $("sym-type-filter")?.value || "";
    const suffix = !q && !type ? " (lista completa)" : " (filtrati)";
    const files =
      window._symFileCount != null
        ? ` · ${window._symFileCount} file indicizzati`
        : "";
    el.textContent = `Catalogo: ${catalog.length} simboli${files}${src} · mostrati ${filtered.length}${suffix} — ${parts.join(", ")}`;
  }

  async function renderRows() {
    const gen = ++renderGen;
    const tbody = $("sym-tbody");
    const empty = $("sym-empty");
    const table = $("sym-table");
    if (!tbody) return;

    const filtered = getFiltered();
    updateMeta(filtered);

    if (!filtered.length) {
      tbody.innerHTML = "";
      empty?.classList.remove("hidden");
      table?.classList.add("hidden");
      return;
    }
    empty?.classList.add("hidden");
    table?.classList.remove("hidden");
    tbody.innerHTML = "";

    for (let i = 0; i < filtered.length; i += ROW_BATCH) {
      if (gen !== renderGen) return;
      const chunk = filtered.slice(i, i + ROW_BATCH);
      const frag = document.createDocumentFragment();
      chunk.forEach((s) => {
        const tr = document.createElement("tr");
        tr.dataset.symId = s.id || "";
        tr.innerHTML = `
          <td><span class="badge sym-type-${escapeHtml(s.type)}">${escapeHtml(s.typeLabel || s.type)}</span></td>
          <td class="sym-name" title="${escapeHtml(s.qualifiedName || s.label)}">${escapeHtml(s.label)}</td>
          <td class="sym-file" title="${escapeHtml(s.filePath)}"><code>${escapeHtml(shortFile(s.filePath))}</code></td>
          <td class="sym-line">${s.lineStart || ""}</td>
          <td><button type="button" class="sym-open-btn" title="Apri nel grafo">◈</button></td>`;
        tr.querySelector(".sym-open-btn")?.addEventListener("click", (e) => {
          e.stopPropagation();
          openInGraph(s);
        });
        tr.addEventListener("click", () => openInGraph(s));
        frag.appendChild(tr);
      });
      tbody.appendChild(frag);
      if (filtered.length > ROW_BATCH) {
        const meta = $("sym-meta");
        if (meta) {
          meta.textContent = `Rendering… ${Math.min(i + ROW_BATCH, filtered.length)}/${filtered.length}`;
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
    }
    updateMeta(filtered);
  }

  function shortFile(fp) {
    if (!fp) return "";
    const parts = fp.replace(/\\/g, "/").split("/");
    return parts.length > 2 ? "…/" + parts.slice(-2).join("/") : fp;
  }

  async function openInGraph(sym) {
    const search = sym.label || sym.qualifiedName || "";
    document.querySelector('.tab[data-tab="sigma"]')?.click();
    const input = $("sigma-search");
    if (input) input.value = search;
    if (window.chSigmaView?.searchAndFocus) {
      await window.chSigmaView.searchAndFocus();
    } else if (sym.filePath && window.chSigmaView?.expandFile) {
      await window.chSigmaView.expandFile(sym.filePath);
    }
  }

  async function load(force) {
    if (loaded && !force) {
      await renderRows();
      return;
    }
    const meta = $("sym-meta");
    if (meta) meta.textContent = "Caricamento catalogo simboli…";
    try {
      const data = await fetchCatalog();
      if (data.error && !data.symbols?.length) {
        catalog = [];
        if (meta) meta.textContent = data.error;
        $("sym-empty")?.classList.remove("hidden");
        $("sym-table")?.classList.add("hidden");
        return;
      }
      catalog = data.symbols || [];
      catalogSource = data.source || "";
      window._symFileCount = data.fileCount ?? null;
      loaded = true;
      await renderRows();
    } catch (e) {
      if (meta) meta.textContent = "Errore: " + e.message;
    }
  }

  function bind() {
    $("sym-search")?.addEventListener("input", () => {
      renderRows();
    });
    $("sym-type-filter")?.addEventListener("change", () => {
      renderRows();
    });
    $("sym-refresh")?.addEventListener("click", () => {
      loaded = false;
      load(true);
    });
    document.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.tab === "symbols") load(false);
      });
    });
  }

  bind();
  window.chSymbolsView = { load, renderRows };
})();
