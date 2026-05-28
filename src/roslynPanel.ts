import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { formatVersionLabel, loadBuildInfo } from './buildInfo';
import { ensurePythonEnvironment, OrchestratorEvent, runOrchestrator } from './pythonRunner';
import {
  compactFilesForUi,
  loadRoslynCurrent,
  loadRoslynHistory,
  loadRoslynRunPayload,
  RoslynRunRecord,
} from './roslynHistory';
import { buildConfig, getRepoPath } from './settings';

export class RoslynPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'context-harvester.roslyn';

  private view?: vscode.WebviewView;
  private running = false;
  private selectedRunId?: string;
  private readonly output = vscode.window.createOutputChannel('Context Harvester Roslyn');

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
      await this.handleMessage(msg as Record<string, unknown>);
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.refreshState();
      }
    });

    void this.refreshState();
  }

  postMessage(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  async refreshState(): Promise<void> {
    const repoPath = getRepoPath();
    const buildInfo = loadBuildInfo(this.context);
    const cfg = buildConfig();

    let dotnetOk = false;
    try {
      const { execSync } = await import('child_process');
      execSync('dotnet --version', { stdio: 'ignore', timeout: 15000 });
      dotnetOk = true;
    } catch {
      dotnetOk = false;
    }

    const history = repoPath ? loadRoslynHistory(repoPath) : { runs: [] };
    if (
      this.selectedRunId &&
      !history.runs.some((r) => r.id === this.selectedRunId)
    ) {
      this.selectedRunId = history.lastRunId ?? history.runs[0]?.id;
    }
    if (!this.selectedRunId && history.runs.length) {
      this.selectedRunId = history.lastRunId ?? history.runs[0]?.id;
    }

    let detail: {
      meta: RoslynRunRecord;
      summary: RoslynRunRecord['summary'];
      files: ReturnType<typeof compactFilesForUi>;
      truncated: boolean;
    } | null = null;

    if (repoPath && this.selectedRunId) {
      const payload =
        loadRoslynRunPayload(repoPath, this.selectedRunId) ||
        (history.lastRunId === this.selectedRunId ? loadRoslynCurrent(repoPath) : undefined);
      if (payload) {
        const files = compactFilesForUi(payload.scan, 800);
        const totalFiles = ((payload.scan.files as unknown[]) || []).length;
        detail = {
          meta: payload.meta,
          summary: payload.meta.summary,
          files,
          truncated: totalFiles > files.length,
        };
      }
    }

    this.postMessage({
      type: 'state',
      versionLabel: formatVersionLabel(buildInfo),
      repoPath,
      dotnetOk,
      useRoslyn: cfg.useRoslyn !== false,
      running: this.running,
      history: history.runs.slice(0, 30),
      lastRunId: history.lastRunId,
      selectedRunId: this.selectedRunId,
      detail,
    });
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.refreshState();
        break;
      case 'selectRun':
        this.selectedRunId = String(msg.runId ?? '');
        await this.refreshState();
        break;
      case 'runScan':
        await this.runScan();
        break;
      case 'openFile': {
        const repo = getRepoPath();
        const rel = String(msg.path ?? '');
        const line = Number(msg.line ?? 1);
        if (!repo || !rel) {
          return;
        }
        const full = path.join(repo, rel.replace(/\//g, path.sep));
        if (!fs.existsSync(full)) {
          vscode.window.showWarningMessage(`File non trovato: ${rel}`);
          return;
        }
        const doc = await vscode.workspace.openTextDocument(full);
        const editor = await vscode.window.showTextDocument(doc);
        const ln = Math.max(0, line - 1);
        const pos = new vscode.Position(ln, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        break;
      }
      default:
        break;
    }
  }

  async runScan(): Promise<void> {
    if (this.running) {
      return;
    }
    const repo = getRepoPath();
    if (!repo) {
      vscode.window.showWarningMessage('Apri una cartella workspace per eseguire Roslyn.');
      return;
    }
    this.running = true;
    this.postMessage({ type: 'running', running: true, progress: 'Avvio RoslynHarvester…' });

    const config = { ...buildConfig(), roslynTrigger: 'manual' };
    const onEvent = (ev: OrchestratorEvent) => {
      if (ev.event === 'progress' && ev.phase === 'roslyn_scan') {
        this.postMessage({
          type: 'progress',
          message: ev.message || 'Roslyn…',
        });
      }
      if (ev.event === 'done') {
        const run = (ev as { roslynRun?: { id?: string } }).roslynRun;
        if (run?.id) {
          this.selectedRunId = run.id;
        }
      }
      if (ev.event === 'error') {
        this.postMessage({ type: 'error', message: ev.message });
      }
    };

    try {
      const pythonPath = await ensurePythonEnvironment(this.context);
      await runOrchestrator(
        pythonPath,
        this.context.extensionPath,
        config,
        'roslyn_scan',
        onEvent,
        (line) => this.output.appendLine(line)
      );
      vscode.window.showInformationMessage('Analisi Roslyn salvata nello storico.');
      await this.refreshState();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Roslyn: ${message}`);
      this.postMessage({ type: 'error', message });
    } finally {
      this.running = false;
      this.postMessage({ type: 'running', running: false });
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const webviewPath = path.join(this.context.extensionPath, 'webview');
    let html = fs.readFileSync(path.join(webviewPath, 'roslyn.html'), 'utf8');
    const cssUri = webview.asWebviewUri(vscode.Uri.file(path.join(webviewPath, 'roslyn.css')));
    const jsUri = webview.asWebviewUri(vscode.Uri.file(path.join(webviewPath, 'roslyn.js')));
    const csp = webview.cspSource;
    html = html
      .replace(/\{\{CSP\}\}/g, csp)
      .replace('{{CSS_URI}}', cssUri.toString())
      .replace('{{JS_URI}}', jsUri.toString());
    return html;
  }
}
