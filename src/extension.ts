import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { generateContext } from './commands/generateContext';
import { openLastContext } from './commands/openContext';
import { rebuildIndex } from './commands/rebuildIndex';
import { ContextHarvesterPanel } from './panel';
import { checkOllama, ensurePythonEnvironment } from './pythonRunner';
import { buildConfig, getAutoIndexSettings, getRepoPath, isPathExcluded } from './settings';

let panelProvider: ContextHarvesterPanel;
let autoIndexTimer: ReturnType<typeof setInterval> | undefined;
let saveDebounceTimer: ReturnType<typeof setTimeout> | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  panelProvider = new ContextHarvesterPanel(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ContextHarvesterPanel.viewType, panelProvider)
  );

  try {
    await ensurePythonEnvironment(context);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showWarningMessage(`Context Harvester: ${msg}`);
  }

  await ensureGitignoreEntry();

  context.subscriptions.push(
    vscode.commands.registerCommand('context-harvester.openPanel', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.context-harvester');
    }),
    vscode.commands.registerCommand('context-harvester.rebuildIndex', () => rebuildIndex(panelProvider)),
    vscode.commands.registerCommand('context-harvester.generateContext', () => generateContext(panelProvider)),
    vscode.commands.registerCommand('context-harvester.openLastContext', () => openLastContext(context)),
    vscode.commands.registerCommand('context-harvester.checkOllama', async () => {
      const cfg = buildConfig();
      const result = await checkOllama(cfg.ollamaUrl);
      if (!result.reachable) {
        vscode.window.showErrorMessage(`Ollama non raggiungibile su ${cfg.ollamaUrl}`);
      } else if (result.missingModels.length) {
        vscode.window.showWarningMessage(
          `Modelli mancanti: ${result.missingModels.join(', ')} — esegui: ollama pull ${result.missingModels[0]}`
        );
      } else {
        vscode.window.showInformationMessage('Ollama OK — modelli richiesti presenti.');
      }
      await panelProvider.refreshState();
    }),
    vscode.commands.registerCommand('context-harvester.resetIndex', () => panelProvider.resetIndex())
  );

  setupAutoIndex(context);
}

function setupAutoIndex(context: vscode.ExtensionContext): void {
  const triggerIncremental = () => {
    const repo = getRepoPath();
    if (!repo) {
      return;
    }
    void panelProvider.runAction('incremental_index', { ...buildConfig(), incremental: true });
  };

  const debouncedSave = () => {
    if (saveDebounceTimer) {
      clearTimeout(saveDebounceTimer);
    }
    saveDebounceTimer = setTimeout(triggerIncremental, 2000);
  };

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const { autoIndexOnSave } = getAutoIndexSettings();
      if (!autoIndexOnSave) {
        return;
      }
      const repo = getRepoPath();
      if (!repo || !doc.uri.fsPath.startsWith(repo) || isPathExcluded(doc.uri.fsPath, repo)) {
        return;
      }
      debouncedSave();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('contextHarvester.autoIndex')) {
        setupAutoIndexInterval();
      }
    })
  );

  setupAutoIndexInterval();

  function setupAutoIndexInterval() {
    if (autoIndexTimer) {
      clearInterval(autoIndexTimer);
      autoIndexTimer = undefined;
    }
    const { autoIndex, autoIndexIntervalMinutes } = getAutoIndexSettings();
    if (autoIndex) {
      autoIndexTimer = setInterval(triggerIncremental, autoIndexIntervalMinutes * 60 * 1000);
    }
  }
}

async function ensureGitignoreEntry(): Promise<void> {
  const repo = getRepoPath();
  if (!repo) {
    return;
  }
  const gitignorePath = path.join(repo, '.gitignore');
  const marker = '.context-harvester/';
  let content = '';
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, 'utf8');
    if (content.includes('.context-harvester')) {
      return;
    }
    if (!content.endsWith('\n')) {
      content += '\n';
    }
    content += `\n# Context Harvester\n${marker}\n`;
  } else {
    content = `# Context Harvester\n${marker}\n`;
  }
  fs.writeFileSync(gitignorePath, content, 'utf8');
}

export function deactivate(): void {
  if (autoIndexTimer) {
    clearInterval(autoIndexTimer);
  }
  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer);
  }
}
