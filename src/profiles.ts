import * as vscode from 'vscode';

export type ModelPhase =
  | 'embedding'
  | 'hyde'
  | 'rerank'
  | 'classifier'
  | 'structurer'
  | 'confidence';

export interface PhaseModelConfig {
  url: string;
  model: string;
}

export interface HarvesterProfile {
  name: string;
  label: string;
  models: Record<ModelPhase, PhaseModelConfig>;
  settings?: {
    enableConfidenceScore?: boolean;
  };
}

const DEFAULT_OLLAMA = 'http://localhost:11434';
const MINISFORUM_OLLAMA = 'http://192.168.1.100:11434';

export const DEFAULT_PROFILES: HarvesterProfile[] = [
  {
    name: 'laptop-speed',
    label: 'Laptop — Speed',
    models: {
      embedding: { url: DEFAULT_OLLAMA, model: 'nomic-embed-text' },
      hyde: { url: DEFAULT_OLLAMA, model: 'qwen3:4b' },
      rerank: { url: DEFAULT_OLLAMA, model: 'qwen3:4b' },
      classifier: { url: DEFAULT_OLLAMA, model: 'qwen3:4b' },
      structurer: { url: DEFAULT_OLLAMA, model: 'qwen3:4b' },
      confidence: { url: DEFAULT_OLLAMA, model: '' },
    },
    settings: { enableConfidenceScore: false },
  },
  {
    name: 'laptop-balanced',
    label: 'Laptop — Balanced (raccomandato)',
    models: {
      embedding: { url: DEFAULT_OLLAMA, model: 'nomic-embed-text' },
      hyde: { url: DEFAULT_OLLAMA, model: 'qwen3:8b' },
      rerank: { url: DEFAULT_OLLAMA, model: 'qwen3:8b' },
      classifier: { url: DEFAULT_OLLAMA, model: 'qwen3:8b' },
      structurer: { url: DEFAULT_OLLAMA, model: 'qwen3:8b' },
      confidence: { url: DEFAULT_OLLAMA, model: 'qwen3:8b' },
    },
    settings: { enableConfidenceScore: true },
  },
  {
    name: 'laptop-quality',
    label: 'Laptop — Quality',
    models: {
      embedding: { url: DEFAULT_OLLAMA, model: 'nomic-embed-text' },
      hyde: { url: DEFAULT_OLLAMA, model: 'qwen3:14b' },
      rerank: { url: DEFAULT_OLLAMA, model: 'qwen3:14b' },
      classifier: { url: DEFAULT_OLLAMA, model: 'qwen3:14b' },
      structurer: { url: DEFAULT_OLLAMA, model: 'qwen3:14b' },
      confidence: { url: DEFAULT_OLLAMA, model: 'qwen3:14b' },
    },
    settings: { enableConfidenceScore: true },
  },
  {
    name: 'minisforum-balanced',
    label: 'MINISFORUM 3090 — Balanced',
    models: {
      embedding: { url: MINISFORUM_OLLAMA, model: 'nomic-embed-text' },
      hyde: { url: MINISFORUM_OLLAMA, model: 'qwen3:14b' },
      rerank: { url: MINISFORUM_OLLAMA, model: 'qwen3:14b' },
      classifier: { url: MINISFORUM_OLLAMA, model: 'qwen3:14b' },
      structurer: { url: MINISFORUM_OLLAMA, model: 'qwen3:14b' },
      confidence: { url: MINISFORUM_OLLAMA, model: 'qwen3:14b' },
    },
    settings: { enableConfidenceScore: true },
  },
  {
    name: 'minisforum-quality',
    label: 'MINISFORUM 3090 — Quality (MoE)',
    models: {
      embedding: { url: MINISFORUM_OLLAMA, model: 'nomic-embed-text' },
      hyde: { url: MINISFORUM_OLLAMA, model: 'qwen3:30b-a3b' },
      rerank: { url: MINISFORUM_OLLAMA, model: 'qwen3:30b-a3b' },
      classifier: { url: MINISFORUM_OLLAMA, model: 'qwen3:30b-a3b' },
      structurer: { url: MINISFORUM_OLLAMA, model: 'qwen3:30b-a3b' },
      confidence: { url: MINISFORUM_OLLAMA, model: 'qwen3:30b-a3b' },
    },
    settings: { enableConfidenceScore: true },
  },
  {
    name: 'minisforum-max',
    label: 'MINISFORUM 3090 — Max (Coder MoE)',
    models: {
      embedding: { url: MINISFORUM_OLLAMA, model: 'nomic-embed-text' },
      hyde: { url: MINISFORUM_OLLAMA, model: 'qwen3-coder:30b-a3b' },
      rerank: { url: MINISFORUM_OLLAMA, model: 'qwen3-coder:30b-a3b' },
      classifier: { url: MINISFORUM_OLLAMA, model: 'qwen3-coder:30b-a3b' },
      structurer: { url: MINISFORUM_OLLAMA, model: 'qwen3-coder:30b-a3b' },
      confidence: { url: MINISFORUM_OLLAMA, model: 'qwen3-coder:30b-a3b' },
    },
    settings: { enableConfidenceScore: true },
  },
];

const PROFILES_STATE_KEY = 'contextHarvester.profiles';
const ACTIVE_PROFILE_KEY = 'contextHarvester.activeProfile';

function usesLegacyRerankModel(profile: HarvesterProfile): boolean {
  const model = profile.models.rerank.model.toLowerCase();
  return model.includes('bge-reranker');
}

/** Sostituisce profili salvati con modelli v2 (bge-reranker) con i default v3. */
async function migrateLegacyProfiles(
  context: vscode.ExtensionContext,
  stored: HarvesterProfile[]
): Promise<HarvesterProfile[]> {
  let changed = false;
  const migrated = stored.map((profile) => {
    if (!usesLegacyRerankModel(profile)) {
      return profile;
    }
    const replacement = DEFAULT_PROFILES.find((p) => p.name === profile.name);
    if (!replacement) {
      return profile;
    }
    changed = true;
    return { ...replacement, label: profile.label };
  });
  if (changed) {
    await saveProfiles(context, migrated);
  }
  return migrated;
}

export async function getProfiles(context: vscode.ExtensionContext): Promise<HarvesterProfile[]> {
  const stored = context.globalState.get<HarvesterProfile[]>(PROFILES_STATE_KEY);
  if (stored?.length) {
    return migrateLegacyProfiles(context, stored);
  }
  await context.globalState.update(PROFILES_STATE_KEY, DEFAULT_PROFILES);
  return DEFAULT_PROFILES;
}

export async function saveProfiles(
  context: vscode.ExtensionContext,
  profiles: HarvesterProfile[]
): Promise<void> {
  await context.globalState.update(PROFILES_STATE_KEY, profiles);
}

export async function getActiveProfileName(context: vscode.ExtensionContext): Promise<string> {
  return (
    context.globalState.get<string>(ACTIVE_PROFILE_KEY) ??
    vscode.workspace.getConfiguration('contextHarvester').get('activeProfile', 'laptop-balanced')
  );
}

export async function setActiveProfileName(
  context: vscode.ExtensionContext,
  name: string
): Promise<void> {
  await context.globalState.update(ACTIVE_PROFILE_KEY, name);
}

export async function getActiveProfile(
  context: vscode.ExtensionContext
): Promise<HarvesterProfile | undefined> {
  const profiles = await getProfiles(context);
  const name = await getActiveProfileName(context);
  return profiles.find((p) => p.name === name) ?? profiles[0];
}

export function applyProfileToWorkspace(profile: HarvesterProfile): Thenable<void> {
  const cfg = vscode.workspace.getConfiguration('contextHarvester');
  const updates: [string, string | boolean][] = [
    ['ollama.embedding.url', profile.models.embedding.url],
    ['ollama.embedding.model', profile.models.embedding.model],
    ['ollama.hyde.url', profile.models.hyde.url],
    ['ollama.hyde.model', profile.models.hyde.model],
    ['ollama.rerank.url', profile.models.rerank.url],
    ['ollama.rerank.model', profile.models.rerank.model],
    ['ollama.classifier.url', profile.models.classifier.url],
    ['ollama.classifier.model', profile.models.classifier.model],
    ['ollama.structurer.url', profile.models.structurer.url],
    ['ollama.structurer.model', profile.models.structurer.model],
    ['ollama.confidence.url', profile.models.confidence.url],
    ['ollama.confidence.model', profile.models.confidence.model],
    ['activeProfile', profile.name],
  ];
  if (profile.settings?.enableConfidenceScore !== undefined) {
    updates.push(['enableConfidenceScore', profile.settings.enableConfidenceScore]);
  }
  return Promise.all(updates.map(([k, v]) => cfg.update(k, v, vscode.ConfigurationTarget.Global))).then(
    () => undefined
  );
}

export function profileModelsForCheck(profile: HarvesterProfile): { url: string; model: string }[] {
  const seen = new Set<string>();
  const out: { url: string; model: string }[] = [];
  for (const phase of Object.values(profile.models)) {
    if (!phase.model?.trim()) {
      continue;
    }
    const key = `${phase.url}::${phase.model}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(phase);
    }
  }
  return out;
}
