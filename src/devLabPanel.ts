import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { formatVersionLabel, loadBuildInfo } from './buildInfo';
import { validateCommunities } from './commands/validateCommunities';
import { ContextHarvesterPanel } from './panel';
import { getMcpStatus, restartMcpServer, startMcpServer, stopMcpServer } from './mcpServer';
import { openGraphView } from './graphView';
import { getActiveProfile, getProfiles } from './profiles';
import { checkOllamaForProfile, ensurePythonEnvironment, OrchestratorEvent, runOrchestrator } from './pythonRunner';
import {
  buildConfig,
  getHarvesterRoot,
  getRepoPath,
  HarvesterConfig,
} from './settings';

const DEV_PHASES: { id: string; label: string; group: string }[] = [
  { id: 'phase0', label: '0 — Vocabulary', group: 'Indice' },
  { id: 'phase1', label: '1 — Vector index', group: 'Indice' },
  { id: 'symbol_index', label: 'Symbol index', group: 'Indice' },
  { id: 'query_understanding', label: 'Query understanding', group: 'Retrieval' },
  { id: 'hyde', label: 'HyDE', group: 'Retrieval' },
  { id: 'retrieval', label: 'Vector retrieval', group: 'Retrieval' },
  { id: 'symbol_search', label: 'Symbol search', group: 'Retrieval' },
  { id: 'iterative', label: 'Iterative', group: 'Retrieval' },
  { id: 'grep', label: 'Grep', group: 'Retrieval' },
  { id: 'rerank', label: 'Re-rank', group: 'Retrieval' },
  { id: 'tests', label: 'Tests', group: 'Post-retrieval' },
  { id: 'structure', label: 'Structure', group: 'Post-retrieval' },
  { id: 'negative', label: 'Negative', group: 'Post-retrieval' },
  { id: 'deps', label: 'Dependencies', group: 'Post-retrieval' },
  { id: 'confidence', label: 'Confidence', group: 'Post-retrieval' },
  { id: 'assembler', label: 'Assembler → MD', group: 'Output' },
  { id: 'fingerprint', label: 'Fingerprint', group: 'Output' },
  { id: 'graph', label: 'Functional graph', group: 'Layer 2' },
  { id: 'graph_report', label: 'Graph report', group: 'Layer 2' },
  { id: 'refresh_graph_viz', label: 'Refresh graph.json', group: 'Layer 2' },
  { id: 'pipeline_retrieval', label: 'Pipeline completa (no index)', group: 'Pipeline' },
  { id: 'clear_cache', label: 'Cancella cache lab', group: 'Pipeline' },
];

export class DevLabPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'context-harvester.dev-lab';

  private view?: vscode.WebviewView;
  private running = false;
  private logLines: string[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly mainPanel: ContextHarvesterPanel
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'webview'))],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      await this.handleMessage(msg as Record<string, unknown>);
    });

    void this.refreshState();
  }

  postMessage(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private appendLog(line: string): void {
    const ts = new Date().toLocaleTimeString();
    this.logLines.push(`[${ts}] ${line}`);
    if (this.logLines.length > 200) {
      this.logLines = this.logLines.slice(-200);
    }
    this.postMessage({ type: 'log', lines: this.logLines });
  }

  async refreshState(): Promise<void> {
    const repoPath = getRepoPath();
    const metaPath = repoPath ? path.join(getHarvesterRoot(repoPath), 'index_meta.json') : '';
    let indexMeta: Record<string, unknown> | null = null;
    if (metaPath && fs.existsSync(metaPath)) {
      try {
        indexMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch { /* */ }
    }

    let cacheSummary: Record<string, unknown> | null = null;
    const cachePath = repoPath ? path.join(getHarvesterRoot(repoPath), 'dev_lab_cache.json') : '';
    if (cachePath && fs.existsSync(cachePath)) {
      try {
        const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as Record<string, unknown>;
        const chunks = cache.chunks;
        cacheSummary = {
          hasQueryAnalysis: Boolean(cache.query_analysis),
          hydeCount: Array.isArray(cache.hyde) ? cache.hyde.length : 0,
          chunksCount: Array.isArray(chunks) ? chunks.length : 0,
          depsCount: Array.isArray(cache.deps) ? cache.deps.length : 0,
          lastPhase: cache.last_phase,
        };
      } catch {
        cacheSummary = null;
      }
    }

    let graphMeta: Record<string, unknown> | null = null;
    const fmapPath = repoPath ? path.join(getHarvesterRoot(repoPath), 'functional_map.json') : '';
    if (fmapPath && fs.existsSync(fmapPath)) {
      try {
        const fmap = JSON.parse(fs.readFileSync(fmapPath, 'utf8'));
        const funcs = (fmap.functions as unknown[]) || [];
        graphMeta = {
          communities: funcs.length,
          functionalMapReady: Boolean(fmap.functionalMapReady),
          hasGraph: fs.existsSync(path.join(getHarvesterRoot(repoPath), 'graph.json')),
        };
      } catch {
        graphMeta = null;
      }
    }

    const cfg = buildConfig();
    const activeProfile = await getActiveProfile(this.context);
    const ollama = await checkOllamaForProfile(activeProfile);
    const profiles = await getProfiles(this.context);
    const mcp = getMcpStatus();

    const artifacts = repoPath ? this.listArtifacts(repoPath) : [];
    const buildInfo = loadBuildInfo(this.context);

    this.postMessage({
      type: 'state',
      versionLabel: formatVersionLabel(buildInfo),
      buildInfo,
      repoPath,
      indexMeta,
      cacheSummary,
      graphMeta,
      ollama,
      mcp,
      running: this.running,
      phases: DEV_PHASES,
      profiles: profiles.map((p) => ({ name: p.name, label: p.label })),
      activeProfile: cfg.activeProfile,
      enableConfidenceScore: cfg.enableConfidenceScore,
      enableFunctionalAnalysis: cfg.enableFunctionalAnalysis,
      artifacts,
      logLines: this.logLines,
    });
  }

  private listArtifacts(repoPath: string): { name: string; path: string; exists: boolean }[] {
    const root = getHarvesterRoot(repoPath);
    const names = [
      'index_meta.json',
      'symbol_index.json',
      'functional_map.json',
      'graph.json',
      'GRAPH_REPORT.md',
      'communities_raw.json',
      'dev_lab_cache.json',
      'chroma_db',
    ];
    return names.map((name) => {
      const p = path.join(root, name);
      return { name, path: p, exists: fs.existsSync(p) };
    });
  }

  private buildConfigFromMsg(msg: Record<string, unknown>): HarvesterConfig {
    return buildConfig({
      cardId: String(msg.cardId ?? ''),
      featureInput: String(msg.featureInput ?? ''),
      includeDocsInRetrieval: Boolean(msg.includeDocs),
      enableConfidenceScore: Boolean(msg.enableConfidence),
      enableFunctionalAnalysis: Boolean(msg.enableFunctionalAnalysis),
      focusBackend: msg.focusBackend !== false,
      focusFrontend: msg.focusFrontend !== false,
      focusSql: msg.focusSql !== false,
      incremental: Boolean(msg.incremental),
    });
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.refreshState();
        break;
      case 'orchestratorAction': {
        const action = String(msg.action ?? '') as
          | 'rebuild_index'
          | 'incremental_index'
          | 'generate_context'
          | 'functional_analysis'
          | 'refresh_graph_viz';
        const config = this.buildConfigFromMsg(msg);
        if (action === 'generate_context' && !config.cardId.trim()) {
          vscode.window.showWarningMessage('Inserisci un Card ID per generare il contesto.');
          return;
        }
        await this.runOrchestratorAction(action, config);
        break;
      }
      case 'runPhase': {
        const phase = String(msg.phase ?? '');
        const config = this.buildConfigFromMsg(msg);
        config.devPhase = phase;
        await this.runOrchestratorAction('dev_run_phase', config, phase);
        break;
      }
      case 'checkFingerprint': {
        const config = this.buildConfigFromMsg(msg);
        if (!config.cardId.trim()) {
          vscode.window.showWarningMessage('Card ID richiesto per il fingerprint check.');
          return;
        }
        await this.runOrchestratorAction('check_fingerprint', config);
        break;
      }
      case 'checkOllama':
        await vscode.commands.executeCommand('context-harvester.checkOllama');
        await this.refreshState();
        break;
      case 'resetIndex':
        await this.mainPanel.resetIndex();
        await this.refreshState();
        break;
      case 'openHarvesterFolder': {
        const repo = getRepoPath();
        if (!repo) {
          return;
        }
        const root = getHarvesterRoot(repo);
        if (!fs.existsSync(root)) {
          fs.mkdirSync(root, { recursive: true });
        }
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(root));
        break;
      }
      case 'openArtifact': {
        const filePath = String(msg.path ?? '');
        if (filePath && fs.existsSync(filePath)) {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
          await vscode.window.showTextDocument(doc);
        }
        break;
      }
      case 'openGraphView':
        await openGraphView(this.context);
        break;
      case 'validateCommunities':
        await validateCommunities(this.mainPanel);
        await this.refreshState();
        break;
      case 'openGraphReport': {
        const repo = getRepoPath();
        if (!repo) {
          return;
        }
        const reportPath = path.join(getHarvesterRoot(repo), 'GRAPH_REPORT.md');
        if (fs.existsSync(reportPath)) {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(reportPath));
          await vscode.window.showTextDocument(doc);
        } else {
          vscode.window.showWarningMessage('GRAPH_REPORT.md non trovato.');
        }
        break;
      }
      case 'mcpStart': {
        try {
          const pythonPath = await ensurePythonEnvironment(this.context);
          await startMcpServer(this.context, pythonPath);
          this.appendLog('MCP server avviato.');
          await this.refreshState();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.appendLog(`ERRORE MCP: ${message}`);
        }
        break;
      }
      case 'mcpStop':
        await stopMcpServer();
        this.appendLog('MCP server fermato.');
        await this.refreshState();
        break;
      case 'mcpRestart': {
        try {
          const pythonPath = await ensurePythonEnvironment(this.context);
          await restartMcpServer(this.context, pythonPath);
          this.appendLog('MCP server riavviato.');
          await this.refreshState();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.appendLog(`ERRORE MCP: ${message}`);
        }
        break;
      }
      case 'clearLog':
        this.logLines = [];
        this.postMessage({ type: 'log', lines: [] });
        break;
    }
  }

  private async runOrchestratorAction(
    action:
      | 'rebuild_index'
      | 'generate_context'
      | 'incremental_index'
      | 'check_fingerprint'
      | 'functional_analysis'
      | 'refresh_graph_viz'
      | 'dev_run_phase',
    config: HarvesterConfig,
    phaseLabel?: string
  ): Promise<void> {
    if (this.running) {
      return;
    }
    if (!config.repoPath) {
      vscode.window.showErrorMessage('Nessun workspace aperto.');
      return;
    }

    const label = phaseLabel || action;
    this.running = true;
    this.appendLog(`▶ ${label} …`);
    this.postMessage({ type: 'running', running: true });

    const onEvent = (ev: OrchestratorEvent) => {
      if (ev.event === 'progress') {
        const msg = ev.total != null ? `${ev.message} (${ev.current}/${ev.total})` : ev.message;
        this.appendLog(`  [${ev.phase}] ${msg}`);
      } else if (ev.event === 'done') {
        const parts: string[] = [`✓ ${label} completato.`];
        if (ev.chunksCount != null) {
          parts.push(`chunks=${ev.chunksCount}`);
        }
        if (ev.depsCount != null) {
          parts.push(`deps=${ev.depsCount}`);
        }
        if (ev.outputFile) {
          parts.push(`→ ${ev.outputFile}`);
        }
        if (ev.cacheSummary) {
          const cs = ev.cacheSummary;
          parts.push(
            `cache: chunks=${cs.chunksCount ?? 0}, hyde=${cs.hydeCount ?? 0}`
          );
        }
        if (ev.message) {
          parts.push(ev.message);
        }
        this.appendLog(parts.join(' '));
        this.postMessage({ type: 'done', ...ev });
      } else if (ev.event === 'fingerprint') {
        this.appendLog(`  fingerprint: ${ev.status}`);
        this.postMessage({ type: 'fingerprint', status: ev.status });
      } else if (ev.event === 'error') {
        this.appendLog(`✗ ERRORE: ${ev.message}`);
        this.postMessage({ type: 'error', message: ev.message });
      }
    };

    try {
      const pythonPath = await ensurePythonEnvironment(this.context);
      await runOrchestrator(pythonPath, this.context.extensionPath, config, action, onEvent);
      await this.refreshState();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.appendLog(`✗ ${message}`);
      this.postMessage({ type: 'error', message });
    } finally {
      this.running = false;
      this.postMessage({ type: 'running', running: false });
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const webviewPath = path.join(this.context.extensionPath, 'webview');
    const htmlPath = path.join(webviewPath, 'dev_lab.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    const cssUri = webview.asWebviewUri(vscode.Uri.file(path.join(webviewPath, 'dev_lab.css')));
    const jsUri = webview.asWebviewUri(vscode.Uri.file(path.join(webviewPath, 'dev_lab.js')));
    const csp = webview.cspSource;
    html = html
      .replace(/\{\{CSP\}\}/g, csp)
      .replace('{{CSS_URI}}', cssUri.toString())
      .replace('{{JS_URI}}', jsUri.toString());
    return html;
  }
}
