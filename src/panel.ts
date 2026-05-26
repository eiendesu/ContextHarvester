import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { checkOllama, ensurePythonEnvironment, OrchestratorEvent, runOrchestrator } from './pythonRunner';
import {
  buildConfig,
  getHarvesterRoot,
  getRepoPath,
  HarvesterConfig,
  resolveOutputFileName,
} from './settings';

export class ContextHarvesterPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'context-harvester.panel';

  private view?: vscode.WebviewView;
  private lastOutputFile?: string;
  private running = false;

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

    const cfg = buildConfig();
    const ollama = await checkOllama(cfg.ollamaUrl);

    this.postMessage({
      type: 'state',
      repoPath,
      outputPath: cfg.outputPath,
      fileNameTemplate: cfg.fileNameTemplate,
      ollamaUrl: cfg.ollamaUrl,
      indexMeta,
      ollama,
      running: this.running,
      lastOutputFile: this.lastOutputFile,
    });
  }

  async resetIndex(): Promise<void> {
    await this.handleMessage({ type: 'resetIndex' });
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.refreshState();
        break;
      case 'rebuildIndex':
        await this.runAction('rebuild_index', buildConfig());
        break;
      case 'generateContext':
        await this.runAction('generate_context', buildConfig({
          cardId: String(msg.cardId ?? ''),
          featureInput: String(msg.featureInput ?? ''),
          includeDocsInRetrieval: Boolean(msg.includeDocs),
          focusBackend: Boolean(msg.focusBackend ?? true),
          focusFrontend: Boolean(msg.focusFrontend ?? true),
          focusSql: Boolean(msg.focusSql ?? true),
        }));
        break;
      case 'openContext':
        if (msg.path && typeof msg.path === 'string') {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(msg.path));
          await vscode.window.showTextDocument(doc);
        } else if (this.lastOutputFile) {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.lastOutputFile));
          await vscode.window.showTextDocument(doc);
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
    }
  }

  async runAction(
    action: 'rebuild_index' | 'generate_context' | 'incremental_index',
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

    const onEvent = (ev: OrchestratorEvent) => {
      if (ev.event === 'progress') {
        this.postMessage({ type: 'progress', ...ev });
      } else if (ev.event === 'done') {
        if (ev.outputFile) {
          this.lastOutputFile = ev.outputFile;
          void this.context.globalState.update('contextHarvester.lastOutput', ev.outputFile);
        }
        this.postMessage({ type: 'done', ...ev });
      } else if (ev.event === 'error') {
        this.postMessage({ type: 'error', message: ev.message });
      }
    };

    try {
      const pythonPath = await ensurePythonEnvironment(this.context);
      await runOrchestrator(pythonPath, this.context.extensionPath, config, action, onEvent);
      await this.refreshState();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.postMessage({ type: 'error', message });
      vscode.window.showErrorMessage(`Context Harvester: ${message}`);
    } finally {
      this.running = false;
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
