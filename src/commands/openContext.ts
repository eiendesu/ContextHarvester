import * as fs from 'fs';
import * as vscode from 'vscode';

export async function openLastContext(context: vscode.ExtensionContext): Promise<void> {
  const last = context.globalState.get<string>('contextHarvester.lastOutput');
  if (!last || !fs.existsSync(last)) {
    vscode.window.showWarningMessage('Nessun file context generato di recente.');
    return;
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(last));
  await vscode.window.showTextDocument(doc);
}
