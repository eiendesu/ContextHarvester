import * as vscode from 'vscode';
import { ContextHarvesterPanel } from '../panel';
import { buildConfig } from '../settings';

export async function generateContext(
  panel: ContextHarvesterPanel,
  overrides: { cardId?: string; featureInput?: string } = {}
): Promise<void> {
  const cardId = overrides.cardId ?? (await promptCardId());
  if (!cardId) {
    return;
  }
  const featureInput = overrides.featureInput ?? (await promptFeatureInput());
  if (!featureInput?.trim()) {
    return;
  }
  await panel.runAction('generate_context', buildConfig({ cardId, featureInput }));
}

async function promptCardId(): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: 'CARD ID (es. NED-123)',
    placeHolder: 'NED-123',
    validateInput: (v) => (v.trim() ? undefined : 'CARD ID obbligatorio'),
  });
}

async function promptFeatureInput(): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: 'Descrizione feature (breve)',
    placeHolder: 'Implementa validazione contratto...',
    validateInput: (v) => (v.trim() ? undefined : 'Descrizione obbligatoria'),
  });
}
