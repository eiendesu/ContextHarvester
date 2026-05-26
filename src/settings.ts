import * as path from 'path';
import * as vscode from 'vscode';

export interface HarvesterConfig {
  repoPath: string;
  outputPath: string;
  cardId: string;
  fileNameTemplate: string;
  ollamaUrl: string;
  embeddingModel: string;
  hydeModel: string;
  rerankModel: string;
  includeExtensions: string[];
  excludeExtensions: string[];
  excludeFolders: string[];
  docExtensions: string[];
  topK: number;
  topKBeforeRerank: number;
  chunkSize: number;
  chunkOverlap: number;
  multiQueryHyde: boolean;
  enableReranking: boolean;
  enableGrep: boolean;
  enableDependencyGraph: boolean;
  dependencyDepth: number;
  includeDocsInRetrieval: boolean;
  focusBackend: boolean;
  focusFrontend: boolean;
  focusSql: boolean;
  featureInput: string;
  incremental?: boolean;
}

function cfg<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('contextHarvester').get<T>(key, fallback);
}

export function getRepoPath(): string {
  const configured = cfg('repoPath', '').trim();
  if (configured) {
    return path.resolve(configured);
  }
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return path.resolve(folders[0].uri.fsPath);
  }
  return '';
}

export function getHarvesterRoot(repoPath: string): string {
  return path.join(repoPath, '.context-harvester');
}

export function getOutputPath(repoPath: string): string {
  const custom = cfg('outputPath', '').trim();
  if (custom) {
    return path.resolve(custom);
  }
  return path.join(getHarvesterRoot(repoPath), 'output');
}

export function getChromaPath(repoPath: string): string {
  return path.join(getHarvesterRoot(repoPath), 'chroma_db');
}

export function buildConfig(overrides: Partial<HarvesterConfig> = {}): HarvesterConfig {
  const repoPath = getRepoPath();
  return {
    repoPath,
    outputPath: getOutputPath(repoPath),
    cardId: '',
    fileNameTemplate: cfg('fileNameTemplate', '{CARD}_context'),
    ollamaUrl: cfg('ollamaUrl', 'http://localhost:11434'),
    embeddingModel: cfg('embeddingModel', 'nomic-embed-text'),
    hydeModel: cfg('hydeModel', 'qwen2.5:3b'),
    rerankModel: cfg('rerankModel', 'bge-reranker-base'),
    includeExtensions: cfg('includeExtensions', []),
    excludeExtensions: cfg('excludeExtensions', [
      '.md', '.txt', '.json', '.lock', '.yaml', '.yml', '.png', '.jpg', '.svg',
      '.pdf', '.exe', '.dll', '.zip', '.nupkg',
    ]),
    excludeFolders: cfg('excludeFolders', [
      'bin', 'obj', 'node_modules', '.git', 'dist', '.context-harvester',
      'packages', '.vs', 'TestResults',
    ]),
    docExtensions: cfg('docExtensions', ['.md']),
    topK: cfg('topK', 10),
    topKBeforeRerank: cfg('topKBeforeRerank', 20),
    chunkSize: cfg('chunkSize', 400),
    chunkOverlap: cfg('chunkOverlap', 50),
    multiQueryHyde: cfg('multiQueryHyde', true),
    enableReranking: cfg('enableReranking', true),
    enableGrep: cfg('enableGrep', true),
    enableDependencyGraph: cfg('enableDependencyGraph', true),
    dependencyDepth: cfg('dependencyDepth', 1),
    includeDocsInRetrieval: cfg('includeDocsInRetrieval', false),
    focusBackend: true,
    focusFrontend: true,
    focusSql: true,
    featureInput: '',
    ...overrides,
  };
}

export function resolveOutputFileName(template: string, cardId: string): string {
  const base = template.replace(/\{CARD\}/g, cardId || 'context');
  return base.endsWith('.md') ? base : `${base}.md`;
}

export function getAutoIndexSettings() {
  return {
    autoIndex: cfg('autoIndex', false),
    autoIndexOnSave: cfg('autoIndexOnSave', false),
    autoIndexIntervalMinutes: cfg('autoIndexIntervalMinutes', 60),
  };
}

export function isPathExcluded(filePath: string, repoPath: string): boolean {
  const rel = path.relative(repoPath, filePath).replace(/\\/g, '/');
  if (rel.startsWith('..')) {
    return true;
  }
  const excludeFolders = cfg('excludeFolders', [] as string[]);
  const parts = rel.split('/');
  return parts.some((p) => excludeFolders.includes(p));
}
