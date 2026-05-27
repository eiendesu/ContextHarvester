import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ContextHarvesterPanel } from '../panel';
import { buildConfig, getHarvesterRoot, getRepoPath } from '../settings';

interface FunctionalFunction {
  id: string;
  name: string;
  validated: boolean;
  excluded?: boolean;
  manuallyEdited?: boolean;
  godNodes?: string[];
  files?: string[];
  terms?: Record<string, unknown>;
  nodes?: unknown[];
  edges?: unknown[];
}

interface FunctionalMap {
  version: string;
  lastUpdated?: string;
  functionalMapReady: boolean;
  functions: FunctionalFunction[];
}

export async function validateCommunities(panel: ContextHarvesterPanel): Promise<void> {
  const repo = getRepoPath();
  if (!repo) {
    vscode.window.showErrorMessage('Nessun workspace aperto.');
    return;
  }

  const fmapPath = path.join(getHarvesterRoot(repo), 'functional_map.json');
  if (!fs.existsSync(fmapPath)) {
    const run = await vscode.window.showInformationMessage(
      'Esegui prima Functional Analysis.',
      'Rigenera analisi'
    );
    if (run === 'Rigenera analisi') {
      await panel.runAction('functional_analysis', buildConfig());
    }
    return;
  }

  let fmap: FunctionalMap;
  try {
    fmap = JSON.parse(fs.readFileSync(fmapPath, 'utf8'));
  } catch {
    vscode.window.showErrorMessage('functional_map.json non valido.');
    return;
  }

  const pending = (fmap.functions || []).filter((f) => !f.excluded && !f.validated);
  if (!pending.length) {
    fmap.functionalMapReady = fmap.functions.some((f) => f.validated && !f.excluded);
    fs.writeFileSync(fmapPath, JSON.stringify(fmap, null, 2), 'utf8');
    vscode.window.showInformationMessage('Tutte le community sono già validate.');
    await panel.refreshState();
    return;
  }

  let idx = 0;
  for (const fn of pending) {
    idx++;
    const god = (fn.godNodes || []).slice(0, 3).join(', ');
    const filesPreview = (fn.files || []).slice(0, 5).map((f) => path.basename(f)).join(', ');
    const choice = await vscode.window.showQuickPick(
      [
        { label: '✅ Approva', value: 'approve' },
        { label: '✏️ Rinomina', value: 'rename' },
        { label: '🗑 Escludi', value: 'exclude' },
        { label: '⏭ Salta', value: 'skip' },
        { label: '⏹ Termina validazione', value: 'stop' },
      ],
      {
        title: `Community ${idx}/${pending.length}: ${fn.name}`,
        placeHolder: `${fn.files?.length ?? 0} file — ${god}`,
        ignoreFocusOut: true,
      }
    );

    if (!choice || choice.value === 'stop') {
      break;
    }

    if (choice.value === 'approve') {
      fn.validated = true;
      fn.manuallyEdited = false;
    } else if (choice.value === 'rename') {
      const newName = await vscode.window.showInputBox({
        prompt: 'Nome funzionalità',
        value: fn.name,
        validateInput: (v) => (v.trim() ? undefined : 'Nome obbligatorio'),
      });
      if (newName?.trim()) {
        fn.name = newName.trim();
        fn.validated = true;
        fn.manuallyEdited = true;
      }
    } else if (choice.value === 'exclude') {
      fn.excluded = true;
      fn.validated = false;
    }
  }

  const validatedCount = fmap.functions.filter((f) => f.validated && !f.excluded).length;
  fmap.functionalMapReady = validatedCount > 0;
  fmap.functions = fmap.functions.filter((f) => !f.excluded);
  fs.writeFileSync(fmapPath, JSON.stringify(fmap, null, 2), 'utf8');

  await panel.runAction('refresh_graph_viz', buildConfig());
  vscode.window.showInformationMessage(
    `Validazione completata: ${validatedCount} funzionalità attive.`
  );
  await panel.refreshState();
}
