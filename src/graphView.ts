import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ensurePythonEnvironment } from './pythonRunner';
import { buildConfig, getHarvesterRoot, getRepoPath } from './settings';
import { getMcpStatus, startMcpServer } from './mcpServer';

/** Open Graph Web App in browser (v4 — FastAPI on MCP port). */
export async function openGraphView(context: vscode.ExtensionContext): Promise<void> {
  const repo = getRepoPath();
  if (!repo) {
    vscode.window.showErrorMessage('Context Harvester: repoPath non configurato.');
    return;
  }

  const graphJsonPath = path.join(getHarvesterRoot(repo), 'graph.json');
  if (!fs.existsSync(graphJsonPath)) {
    const run = await vscode.window.showInformationMessage(
      'graph.json non trovato. Esegui Functional Analysis.',
      'Rigenera analisi'
    );
    if (run === 'Rigenera analisi') {
      await vscode.commands.executeCommand('context-harvester.functionalAnalysis');
    }
    return;
  }

  const cfg = vscode.workspace.getConfiguration('contextHarvester');
  const port = cfg.get<number>('mcp.port', 3456);
  const autoOpen = cfg.get<boolean>('webapp.autoOpenBrowser', true);
  const webappUrl = `http://127.0.0.1:${port}/`;

  let status = getMcpStatus();
  if (!status.running) {
    try {
      const pythonPath = await ensurePythonEnvironment(context);
      await startMcpServer(context, pythonPath, buildConfig());
      await new Promise((r) => setTimeout(r, 800));
      status = getMcpStatus();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(
        `Impossibile avviare il server grafo: ${message}. Avvia MCP dal pannello.`
      );
      return;
    }
  }

  if (autoOpen) {
    await vscode.env.openExternal(vscode.Uri.parse(webappUrl));
    vscode.window.showInformationMessage(`Graph View aperto in browser: ${webappUrl}`);
  } else {
    vscode.window.showInformationMessage(`Graph View: ${webappUrl}`);
  }
}

/** Legacy embedded webview (fallback if needed). */
export async function openGraphViewEmbedded(context: vscode.ExtensionContext): Promise<void> {
  const repo = getRepoPath();
  if (!repo) {
    return;
  }
  const graphJsonPath = path.join(getHarvesterRoot(repo), 'graph.json');
  if (!fs.existsSync(graphJsonPath)) {
    return;
  }
  let graph: { nodes: unknown[]; edges: unknown[] } = { nodes: [], edges: [] };
  try {
    graph = JSON.parse(fs.readFileSync(graphJsonPath, 'utf8'));
  } catch {
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    'context-harvester.graph-view',
    'Knowledge Graph — Context Harvester',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'webview'))],
    }
  );
  const webviewPath = path.join(context.extensionPath, 'webview');
  let html = fs.readFileSync(path.join(webviewPath, 'graph_view.html'), 'utf8');
  const cssUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(webviewPath, 'graph_view.css')));
  const jsUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(webviewPath, 'graph_view.js')));
  const visJs = panel.webview.asWebviewUri(
    vscode.Uri.file(path.join(webviewPath, 'vendor', 'vis-network', 'vis-network.min.js'))
  );
  const visCss = panel.webview.asWebviewUri(
    vscode.Uri.file(path.join(webviewPath, 'vendor', 'vis-network', 'vis-network.min.css'))
  );
  html = html
    .replace(/\{\{CSP\}\}/g, panel.webview.cspSource)
    .replace('{{CSS_URI}}', cssUri.toString())
    .replace('{{JS_URI}}', jsUri.toString())
    .replace('{{VIS_JS}}', visJs.toString())
    .replace('{{VIS_CSS}}', visCss.toString());
  panel.webview.html = html;
  panel.webview.postMessage({ type: 'init', graph });
}
