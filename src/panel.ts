import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  applyProfileToWorkspace,
  getActiveProfile,
  getActiveProfileName,
  getProfiles,
  HarvesterProfile,
  saveProfiles,
  DEFAULT_PROFILES,
} from './profiles';
import { validateCommunities } from './commands/validateCommunities';
import { getMcpStatus, restartMcpServer, startMcpServer, stopMcpServer } from './mcpServer';
import { checkOllamaForProfile, ensurePythonEnvironment, OrchestratorEvent, runOrchestrator } from './pythonRunner';
import { openGraphView } from './graphView';
import { formatVersionLabel, loadBuildInfo } from './buildInfo';
import {
  actionLabel,
  formatDurationMs,
  getIndexRun,
  IndexRunHistory,
  IndexRunRecord,
  loadIndexRunHistory,
} from './indexRunHistory';
import {
  buildConfig,
  getHarvesterRoot,
  getProjectContextPath,
  getRepoPath,
  HarvesterConfig,
  resolveOutputFileName,
} from './settings';

export class ContextHarvesterPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'context-harvester.panel';

  private view?: vscode.WebviewView;
  private readonly output = vscode.window.createOutputChannel('Context Harvester');
  private lastOutputFile?: string;
  private lastJsonFile?: string;
  private lastTxtFile?: string;
  private running = false;
  private executionLogLines: string[] = [];
  private indexRunHistory: IndexRunHistory = { runs: [] };
  private selectedIndexRunId?: string;
  private indexActionStartMs?: number;

  constructor(private readonly context: vscode.ExtensionContext) {}

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
      await this.handleMessage(msg);
    });

    void this.refreshState();
  }

  postMessage(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  async refreshState(): Promise<void> {
    const repoPath = getRepoPath();
    const metaPath = path.join(repoPath, '.context-harvester', 'index_meta.json');
    let indexMeta: Record<string, unknown> | null = null;
    if (repoPath && fs.existsSync(metaPath)) {
      try {
        indexMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch { /* */ }
    }

    const profiles = await getProfiles(this.context);
    const activeName = await getActiveProfileName(this.context);
    const activeProfile = await getActiveProfile(this.context);
    const cfg = buildConfig();
    const ollama = await checkOllamaForProfile(activeProfile);

    const projectContextPath = repoPath ? getProjectContextPath(repoPath) : '';

    let graphMeta: Record<string, unknown> | null = null;
    const fmapPath = repoPath ? path.join(getHarvesterRoot(repoPath), 'functional_map.json') : '';
    if (fmapPath && fs.existsSync(fmapPath)) {
      try {
        const fmap = JSON.parse(fs.readFileSync(fmapPath, 'utf8'));
        const funcs = (fmap.functions as unknown[]) || [];
        const validated = funcs.filter(
          (f): f is { validated?: boolean } =>
            typeof f === 'object' && f !== null && Boolean((f as { validated?: boolean }).validated)
        ).length;
        graphMeta = {
          communities: funcs.length,
          validated,
          functionalMapReady: Boolean(fmap.functionalMapReady),
          hasGraph: fs.existsSync(path.join(getHarvesterRoot(repoPath), 'graph.json')),
        };
      } catch {
        graphMeta = null;
      }
    }

    const mcp = getMcpStatus();
    const buildInfo = loadBuildInfo(this.context);

    let analysisBadges: { circular?: number; deadCode?: number } = {};
    const analysisPath = repoPath ? path.join(getHarvesterRoot(repoPath), 'graph_analysis.json') : '';
    if (analysisPath && fs.existsSync(analysisPath)) {
      try {
        const a = JSON.parse(fs.readFileSync(analysisPath, 'utf8'));
        const c = a.counts || {};
        analysisBadges = {
          circular: c.circularDeps,
          deadCode: c.deadCode,
        };
      } catch {
        analysisBadges = {};
      }
    }

    if (repoPath) {
      this.indexRunHistory = loadIndexRunHistory(repoPath);
      if (
        this.selectedIndexRunId &&
        !this.indexRunHistory.runs.some((r) => r.id === this.selectedIndexRunId)
      ) {
        this.selectedIndexRunId = this.indexRunHistory.lastRunId ?? this.indexRunHistory.runs[0]?.id;
      }
      if (!this.selectedIndexRunId && this.indexRunHistory.runs.length) {
        this.selectedIndexRunId = this.indexRunHistory.lastRunId ?? this.indexRunHistory.runs[0]?.id;
      }
    } else {
      this.indexRunHistory = { runs: [] };
      this.selectedIndexRunId = undefined;
    }

    const selectedIndexRun = repoPath && this.selectedIndexRunId
      ? getIndexRun(repoPath, this.selectedIndexRunId)
      : undefined;
    const lastIndexRun = this.indexRunHistory.runs[0];

    this.postMessage({
      type: 'state',
      versionLabel: formatVersionLabel(buildInfo),
      buildInfo,
      repoPath,
      outputPath: cfg.outputPath,
      fileNameTemplate: cfg.fileNameTemplate,
      ollamaUrl: cfg.ollamaUrl,
      indexMeta,
      ollama,
      running: this.running,
      lastOutputFile: this.lastOutputFile,
      lastJsonFile: this.lastJsonFile,
      lastTxtFile: this.lastTxtFile,
      profiles: profiles.map((p) => ({ name: p.name, label: p.label })),
      activeProfile: activeName,
      enableConfidenceScore: cfg.enableConfidenceScore,
      projectContextPath,
      graphMeta,
      analysisBadges,
      mcp,
      enableFunctionalAnalysis: cfg.enableFunctionalAnalysis,
      enableMcpServer: cfg.enableMcpServer,
      executionLogLines: this.executionLogLines,
      indexRunHistory: this.indexRunHistory.runs.slice(0, 20),
      lastIndexRun,
      selectedIndexRunId: this.selectedIndexRunId,
      selectedIndexRun,
    });
  }

  /** Apre log inline nel pannello + canale Output. */
  showExecutionLog(): void {
    if (!this.executionLogLines.length) {
      this.appendExecutionLog(
        '[info] Nessuna esecuzione registrata in questa sessione. Esegui Rebuild Index o Genera contesto.'
      );
    }
    this.postMessage({
      type: 'executionLog',
      lines: this.executionLogLines,
      open: true,
    });
    this.output.show(true);
    void vscode.commands.executeCommand('workbench.action.output.toggle');
    vscode.window.showInformationMessage(
      'Log esecuzione aperto. Se non lo vedi: View → Output → Context Harvester, oppure scorri il riquadro Log nel pannello.'
    );
  }

  private appendExecutionLog(line: string): void {
    this.output.appendLine(line);
    this.executionLogLines.push(line);
    if (this.executionLogLines.length > 400) {
      this.executionLogLines = this.executionLogLines.slice(-400);
    }
    this.postMessage({ type: 'executionLog', lines: this.executionLogLines, open: false });
  }

  async resetIndex(): Promise<void> {
    await this.handleMessage({ type: 'resetIndex' });
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.refreshState();
        break;
      case 'selectProfile':
        await this.selectProfile(String(msg.name ?? ''));
        break;
      case 'saveProfile':
        await this.saveProfileFromDialog();
        break;
      case 'deleteProfile':
        await this.deleteProfile(String(msg.name ?? ''));
        break;
      case 'rebuildIndex':
        await this.runAction('rebuild_index', buildConfig());
        break;
      case 'incrementalIndex':
        await this.runAction('incremental_index', { ...buildConfig(), incremental: true });
        break;
      case 'selectIndexRun':
        this.selectedIndexRunId = String(msg.runId ?? '');
        await this.refreshState();
        break;
      case 'generateContext':
        await this.generateWithFingerprint({
          cardId: String(msg.cardId ?? ''),
          featureInput: String(msg.featureInput ?? ''),
          includeDocsInRetrieval: Boolean(msg.includeDocs),
          focusBackend: Boolean(msg.focusBackend ?? true),
          focusFrontend: Boolean(msg.focusFrontend ?? true),
          focusSql: Boolean(msg.focusSql ?? true),
          exportJson: Boolean(msg.exportJson),
          exportTxt: Boolean(msg.exportTxt),
          forceRegenerate: Boolean(msg.forceRegenerate),
        });
        break;
      case 'openContext':
        if (msg.path && typeof msg.path === 'string') {
          await this.openFile(msg.path);
        } else if (this.lastOutputFile) {
          await this.openFile(this.lastOutputFile);
        }
        break;
      case 'openProjectContext': {
        const repo = getRepoPath();
        if (!repo) {
          return;
        }
        const pcPath = getProjectContextPath(repo);
        if (!fs.existsSync(pcPath)) {
          fs.mkdirSync(path.dirname(pcPath), { recursive: true });
          fs.writeFileSync(pcPath, '# Project Context\n\n', 'utf8');
        }
        await this.openFile(pcPath);
        break;
      }
      case 'copyContext':
        if (this.lastOutputFile && fs.existsSync(this.lastOutputFile)) {
          const text = fs.readFileSync(this.lastOutputFile, 'utf8');
          await vscode.env.clipboard.writeText(text);
          vscode.window.showInformationMessage('Contesto copiato negli appunti.');
        }
        break;
      case 'exportJson':
        if (this.lastJsonFile) {
          await this.openFile(this.lastJsonFile);
        }
        break;
      case 'exportTxt':
        if (this.lastTxtFile) {
          await this.openFile(this.lastTxtFile);
        }
        break;
      case 'checkOllama':
        await this.refreshState();
        break;
      case 'resetIndex': {
        const repo = getRepoPath();
        const root = getHarvesterRoot(repo);
        if (fs.existsSync(root)) {
          const confirm = await vscode.window.showWarningMessage(
            'Eliminare l\'indice Context Harvester?',
            { modal: true },
            'Elimina'
          );
          if (confirm === 'Elimina') {
            fs.rmSync(root, { recursive: true, force: true });
            vscode.window.showInformationMessage('Indice resettato.');
            await this.refreshState();
          }
        }
        break;
      }
      case 'functionalAnalysis':
        await this.runAction('functional_analysis', buildConfig());
        break;
      case 'openGraphView':
        await openGraphView(this.context);
        break;
      case 'validateCommunities':
        await validateCommunities(this);
        break;
      case 'openGraphReport': {
        const repo = getRepoPath();
        if (!repo) {
          return;
        }
        const reportPath = path.join(getHarvesterRoot(repo), 'GRAPH_REPORT.md');
        if (fs.existsSync(reportPath)) {
          await this.openFile(reportPath);
        } else {
          vscode.window.showWarningMessage('GRAPH_REPORT.md non trovato. Esegui Functional Analysis.');
        }
        break;
      }
      case 'mcpStart': {
        try {
          const pythonPath = await ensurePythonEnvironment(this.context);
          await startMcpServer(this.context, pythonPath);
          vscode.window.showInformationMessage('MCP server avviato.');
          await this.refreshState();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`MCP: ${message}`);
        }
        break;
      }
      case 'mcpStop':
        await stopMcpServer();
        vscode.window.showInformationMessage('MCP server fermato.');
        await this.refreshState();
        break;
      case 'mcpRestart': {
        try {
          const pythonPath = await ensurePythonEnvironment(this.context);
          await restartMcpServer(this.context, pythonPath);
          vscode.window.showInformationMessage('MCP server riavviato.');
          await this.refreshState();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`MCP: ${message}`);
        }
        break;
      }
      case 'pickFiles': {
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: 'Seleziona file requisiti',
        });
        if (uris?.length) {
          const contents = uris.map((u) => {
            const text = fs.readFileSync(u.fsPath, 'utf8');
            return `# ${path.basename(u.fsPath)}\n\n${text}`;
          }).join('\n\n---\n\n');
          this.postMessage({ type: 'filesSelected', paths: uris.map((u) => u.fsPath), content: contents });
        }
        break;
      }
      case 'openExecutionLog':
        this.showExecutionLog();
        break;
      case 'clearExecutionLog':
        this.executionLogLines = [];
        this.postMessage({ type: 'executionLog', lines: [], open: true });
        break;
    }
  }

  private async openFile(filePath: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc);
  }

  private async selectProfile(name: string): Promise<void> {
    const profiles = await getProfiles(this.context);
    const profile = profiles.find((p) => p.name === name);
    if (!profile) {
      return;
    }
    await applyProfileToWorkspace(profile);
    await this.context.globalState.update('contextHarvester.activeProfile', name);
    await this.refreshState();
    vscode.window.showInformationMessage(`Profilo attivo: ${profile.label}`);
  }

  private async saveProfileFromDialog(): Promise<void> {
    const name = await vscode.window.showInputBox({
      prompt: 'Nome interno profilo (es. laptop-custom)',
      placeHolder: 'laptop-custom',
    });
    if (!name?.trim()) {
      return;
    }
    const label = await vscode.window.showInputBox({
      prompt: 'Etichetta visualizzata',
      placeHolder: 'Laptop — Custom',
    });
    if (!label?.trim()) {
      return;
    }
    const cfg = buildConfig();
    const profile: HarvesterProfile = {
      name: name.trim(),
      label: label.trim(),
      models: { ...cfg.ollama },
      settings: { enableConfidenceScore: cfg.enableConfidenceScore },
    };
    const profiles = await getProfiles(this.context);
    const idx = profiles.findIndex((p) => p.name === profile.name);
    if (idx >= 0) {
      profiles[idx] = profile;
    } else {
      profiles.push(profile);
    }
    await saveProfiles(this.context, profiles);
    await this.selectProfile(profile.name);
  }

  private async deleteProfile(name: string): Promise<void> {
    if (DEFAULT_PROFILES.some((p) => p.name === name)) {
      vscode.window.showWarningMessage('I profili predefiniti non possono essere eliminati.');
      return;
    }
    const profiles = (await getProfiles(this.context)).filter((p) => p.name !== name);
    await saveProfiles(this.context, profiles);
    const active = await getActiveProfileName(this.context);
    if (active === name && profiles.length) {
      await this.selectProfile(profiles[0].name);
    } else {
      await this.refreshState();
    }
  }

  private async generateWithFingerprint(
    overrides: Partial<HarvesterConfig> & { forceRegenerate?: boolean }
  ): Promise<void> {
    const config = buildConfig(overrides);
    if (!overrides.forceRegenerate && config.cardId) {
      try {
        const pythonPath = await ensurePythonEnvironment(this.context);
        let fingerprintStatus = 'new';
        await runOrchestrator(
          pythonPath,
          this.context.extensionPath,
          { ...config, cardId: config.cardId },
          'check_fingerprint',
          (ev) => {
            if (ev.event === 'fingerprint') {
              fingerprintStatus = ev.status;
            }
          }
        );
        if (fingerprintStatus === 'identical') {
          const choice = await vscode.window.showInformationMessage(
            'Contesto identico all\'ultima generazione (nessun file modificato).',
            'Rigenera comunque',
            'Usa esistente'
          );
          if (choice === 'Usa esistente' && this.lastOutputFile) {
            await this.openFile(this.lastOutputFile);
            return;
          }
          if (choice !== 'Rigenera comunque') {
            return;
          }
        }
      } catch {
        /* proceed with generation */
      }
    }
    await this.runAction('generate_context', config);
  }

  async runAction(
    action:
      | 'rebuild_index'
      | 'generate_context'
      | 'incremental_index'
      | 'functional_analysis'
      | 'refresh_graph_viz',
    config: HarvesterConfig
  ): Promise<void> {
    if (this.running) {
      return;
    }
    if (!config.repoPath) {
      vscode.window.showErrorMessage('Nessun workspace aperto e repoPath non configurato.');
      return;
    }

    this.running = true;
    this.postMessage({ type: 'running', running: true });
    this.appendExecutionLog('');
    this.appendExecutionLog(`=== ${new Date().toLocaleString('it-IT')} :: ${action} ===`);
    this.appendExecutionLog(`[repo] ${config.repoPath}`);

    const isIndexAction = action === 'rebuild_index' || action === 'incremental_index';
    if (isIndexAction) {
      this.indexActionStartMs = Date.now();
    }

    const onEvent = (ev: OrchestratorEvent) => {
      if (ev.event === 'progress') {
        const pct = ev.total != null ? ` (${ev.current ?? 0}/${ev.total})` : '';
        this.appendExecutionLog(`[progress] ${ev.phase}: ${ev.message}${pct}`);
        this.postMessage({ type: 'progress', ...ev });
      } else if (ev.event === 'done') {
        if (ev.outputFile) {
          this.lastOutputFile = ev.outputFile;
          void this.context.globalState.update('contextHarvester.lastOutput', ev.outputFile);
        }
        if (ev.jsonFile) {
          this.lastJsonFile = ev.jsonFile;
        }
        if (ev.txtFile) {
          this.lastTxtFile = ev.txtFile;
        }
        if (ev.indexRun) {
          const run = ev.indexRun;
          this.appendExecutionLog(
            `[done] ${actionLabel(run.action)} completato in ${formatDurationMs(run.durationMs)}`
          );
          this.selectedIndexRunId = run.id;
          this.postMessage({ type: 'indexRunComplete', indexRun: run });
        } else if (isIndexAction && this.indexActionStartMs) {
          const wallMs = Date.now() - this.indexActionStartMs;
          this.appendExecutionLog(`[done] Index completato in ~${formatDurationMs(wallMs)} (stima locale)`);
        }
        this.appendExecutionLog('[done] Orchestrator completato.');
        if (ev.outputFile) {
          this.appendExecutionLog(`[done] output=${ev.outputFile}`);
        }
        this.postMessage({ type: 'done', ...ev });
      } else if (ev.event === 'error') {
        this.appendExecutionLog(`[error] ${ev.message}`);
        this.postMessage({ type: 'error', message: ev.message });
      }
    };

    try {
      const pythonPath = await ensurePythonEnvironment(this.context);
      await runOrchestrator(
        pythonPath,
        this.context.extensionPath,
        config,
        action,
        onEvent,
        (line) => this.appendExecutionLog(line)
      );
      await this.refreshState();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.appendExecutionLog(`[exception] ${message}`);
      this.postMessage({ type: 'error', message });
      vscode.window.showErrorMessage(`Context Harvester: ${message}`);
    } finally {
      this.running = false;
      this.indexActionStartMs = undefined;
      this.postMessage({ type: 'running', running: false });
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const webviewPath = path.join(this.context.extensionPath, 'webview');
    const htmlPath = path.join(webviewPath, 'panel.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    const cssUri = webview.asWebviewUri(vscode.Uri.file(path.join(webviewPath, 'panel.css')));
    const jsUri = webview.asWebviewUri(vscode.Uri.file(path.join(webviewPath, 'panel.js')));
    const csp = webview.cspSource;
    html = html
      .replace(/\{\{CSP\}\}/g, csp)
      .replace('{{CSS_URI}}', cssUri.toString())
      .replace('{{JS_URI}}', jsUri.toString());
    return html;
  }
}

export function previewFileName(template: string, cardId: string): string {
  return resolveOutputFileName(template, cardId);
}
