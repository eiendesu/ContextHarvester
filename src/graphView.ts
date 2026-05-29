import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { ensurePythonEnvironment } from "./pythonRunner";
import { buildConfig, getHarvesterRoot, getRepoPath } from "./settings";
import { getMcpStatus, startMcpServer } from "./mcpServer";

/** Open Graph Web App in browser (v4 — FastAPI on MCP port). */
export async function openGraphView(
  context: vscode.ExtensionContext,
): Promise<void> {
  const repo = getRepoPath();
  if (!repo) {
    vscode.window.showErrorMessage(
      "Context Harvester: repoPath non configurato.",
    );
    return;
  }

  const graphJsonPath = path.join(getHarvesterRoot(repo), "graph.json");
  if (!fs.existsSync(graphJsonPath)) {
    const run = await vscode.window.showInformationMessage(
      "graph.json non trovato. Esegui Functional Analysis.",
      "Rigenera analisi",
    );
    if (run === "Rigenera analisi") {
      await vscode.commands.executeCommand(
        "context-harvester.functionalAnalysis",
      );
    }
    return;
  }

  const cfg = vscode.workspace.getConfiguration("contextHarvester");
  const port = cfg.get<number>("mcp.port", 3456);
  const autoOpen = cfg.get<boolean>("webapp.autoOpenBrowser", true);
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
        `Impossibile avviare il server grafo: ${message}. Avvia MCP dal pannello.`,
      );
      return;
    }
  }

  if (autoOpen) {
    await vscode.env.openExternal(vscode.Uri.parse(webappUrl));
    vscode.window.showInformationMessage(
      `Graph View aperto in browser: ${webappUrl}`,
    );
  } else {
    vscode.window.showInformationMessage(`Graph View: ${webappUrl}`);
  }
}

/** Legacy embedded webview (fallback if needed). */
export async function openGraphViewEmbedded(
  context: vscode.ExtensionContext,
): Promise<void> {
  const repo = getRepoPath();
  if (!repo) {
    return;
  }
  const harvesterRoot = getHarvesterRoot(repo);
  let graph: { nodes: unknown[]; edges: unknown[] } = { nodes: [], edges: [] };

  // Try to load graph.json (Functional Analysis)
  const graphJsonPath = path.join(harvesterRoot, "graph.json");
  if (fs.existsSync(graphJsonPath)) {
    try {
      graph = JSON.parse(fs.readFileSync(graphJsonPath, "utf8"));
    } catch {
      // continue with empty graph
    }
  }

  // Try to load Roslyn scan and merge into graph
  const roslynCurrentPath = path.join(harvesterRoot, "roslyn", "current.json");
  if (fs.existsSync(roslynCurrentPath)) {
    try {
      const roslynData = JSON.parse(
        fs.readFileSync(roslynCurrentPath, "utf8"),
      ) as {
        scan?: {
          files?: Array<{
            path?: string;
            classes?: Array<{
              name?: string;
              kind?: string;
              line?: number;
              isController?: boolean;
              route?: string | null;
            }>;
            methods?: Array<{
              className?: string;
              name?: string;
              line?: number;
              visibility?: string;
              qualifiedName?: string;
            }>;
            endpoints?: Array<{
              controller?: string;
              action?: string;
              method?: string;
              line?: number;
            }>;
          }>;
        };
      };
      if (roslynData.scan?.files) {
        mergeRoslynIntoGraph(graph, roslynData.scan.files);
      }
    } catch {
      // ignore roslyn merge error
    }
  }

  if (graph.nodes.length === 0 && graph.edges.length === 0) {
    vscode.window.showWarningMessage(
      "Nessun dato di grafo trovato. Esegui Functional Analysis o Roslyn Scan.",
    );
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "context-harvester.graph-view",
    "Knowledge Graph — Context Harvester",
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(context.extensionPath, "webview")),
      ],
    },
  );
  const webviewPath = path.join(context.extensionPath, "webview");
  // Use 3D Force Graph embedded webview
  let html = fs.readFileSync(
    path.join(webviewPath, "graph_view_3d.html"),
    "utf8",
  );
  const cssUri = panel.webview.asWebviewUri(
    vscode.Uri.file(path.join(webviewPath, "graph_view.css")),
  );
  const jsUri = panel.webview.asWebviewUri(
    vscode.Uri.file(path.join(webviewPath, "graph_view_3d.js")),
  );
  const threeModuleUri = panel.webview.asWebviewUri(
    vscode.Uri.file(
      path.join(webviewPath, "vendor", "force-graph", "three.module.min.js"),
    ),
  );
  const forceGraphUri = panel.webview.asWebviewUri(
    vscode.Uri.file(
      path.join(webviewPath, "vendor", "force-graph", "3d-force-graph.min.js"),
    ),
  );
  html = html
    .replace(/\{\{CSP\}\}/g, panel.webview.cspSource)
    .replace("{{CSS_URI}}", cssUri.toString())
    .replace("{{JS_URI}}", jsUri.toString())
    .replace("{{THREE_MODULE_URI}}", threeModuleUri.toString())
    .replace("{{FORCE_GRAPH_URI}}", forceGraphUri.toString());
  panel.webview.html = html;
  panel.webview.postMessage({ type: "init", graph });
}

function mergeRoslynIntoGraph(
  graph: { nodes: unknown[]; edges: unknown[] },
  files: Array<{
    path?: string;
    classes?: Array<{
      name?: string;
      kind?: string;
      line?: number;
      isController?: boolean;
      route?: string | null;
    }>;
    methods?: Array<{
      className?: string;
      name?: string;
      line?: number;
      visibility?: string;
      qualifiedName?: string;
    }>;
    endpoints?: Array<{
      controller?: string;
      action?: string;
      method?: string;
      line?: number;
    }>;
  }>,
): void {
  const nodes = (graph.nodes as Array<{ id?: string }>) || [];
  const edges = (graph.edges as Array<{ from?: string; to?: string }>) || [];
  const existingIds = new Set(nodes.map((n) => n.id));

  function makeId(prefix: string, name: string): string {
    const safe = (prefix + "-" + name)
      .replace(/[^a-zA-Z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .toLowerCase();
    return safe.substring(0, 180);
  }

  for (const file of files) {
    const filePath = file.path || "";
    const fileName = path.basename(filePath);
    const fileId = makeId("file", fileName);

    if (!existingIds.has(fileId)) {
      nodes.push({
        id: fileId,
        label: fileName,
        group: "file",
        file: filePath,
      } as never);
      existingIds.add(fileId);
    }

    for (const cls of file.classes || []) {
      const className = cls.name || "";
      const classId = makeId("class", className);
      if (!existingIds.has(classId)) {
        nodes.push({
          id: classId,
          label: className,
          group: cls.kind || "class",
          file: filePath,
        } as never);
        existingIds.add(classId);
        edges.push({
          from: fileId,
          to: classId,
          label: "contains",
        } as never);
      }

      for (const method of file.methods || []) {
        if (method.className !== className) continue;
        const methodName = method.name || "";
        const methodId = makeId("method", className + "-" + methodName);
        if (!existingIds.has(methodId)) {
          nodes.push({
            id: methodId,
            label: methodName,
            group: "method",
            file: filePath,
          } as never);
          existingIds.add(methodId);
          edges.push({
            from: classId,
            to: methodId,
            label: "contains",
          } as never);
        }
      }
    }
  }
}
