import * as path from 'path';
import * as vscode from 'vscode';

export interface PhaseModelConfig {
  url: string;
  model: string;
}

export interface OllamaPhaseConfig {
  embedding: PhaseModelConfig;
  hyde: PhaseModelConfig;
  rerank: PhaseModelConfig;
  classifier: PhaseModelConfig;
  structurer: PhaseModelConfig;
  confidence: PhaseModelConfig;
}

export interface HarvesterConfig {
  repoPath: string;
  outputPath: string;
  cardId: string;
  fileNameTemplate: string;
  ollamaUrl: string;
  embeddingModel: string;
  hydeModel: string;
  rerankModel: string;
  ollama: OllamaPhaseConfig;
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
  enableConfidenceScore: boolean;
  exportJson: boolean;
  exportTxt: boolean;
  focusBackend: boolean;
  focusFrontend: boolean;
  focusSql: boolean;
  featureInput: string;
  activeProfile: string;
  incremental?: boolean;
  fingerprintStatus?: string;
  fingerprintFiles?: string[];
  forceRegenerate?: boolean;

  enableFunctionalAnalysis?: boolean;
  enableGraphView?: boolean;
  enableMcpServer?: boolean;
  mcpPort?: number;
  mcpAutoStart?: boolean;
  graphMinCommunitySize?: number;
  graphMaxCommunitySize?: number;
  graphAutoValidate?: boolean;
  graphNormalizeNodeNames?: boolean;
  graphReassignUnassigned?: boolean;
  graphMinDegreeForReassign?: number;
  labelFirstTraversalDepth?: number;
  labelFirstMaxNodes?: number;
  labelExpansionUrl?: string;
  labelExpansionModel?: string;
  webappAutoOpenBrowser?: boolean;
  analysisGitLogDays?: number;
  analysisFunctionSimilarityThreshold?: number;
  analysisEntryPointPatterns?: string[];
  analysisApiEdgePatterns?: string[];

  /** Dev Lab — single phase id (see python/dev_phases.py). */
  devPhase?: string;
}

function cfg<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('contextHarvester').get<T>(key, fallback);
}

/** Cartelle sempre escluse; unite a contextHarvester.excludeFolders del workspace. */
export const DEFAULT_EXCLUDE_FOLDERS = [
  'bin',
  'obj',
  'node_modules',
  '.git',
  'dist',
  'build',
  '.context-harvester',
  'packages',
  '.vs',
  'TestResults',
];

export function getExcludeFolders(): string[] {
  const custom = cfg('excludeFolders', [] as string[]);
  return [...new Set([...DEFAULT_EXCLUDE_FOLDERS, ...custom])];
}

function phaseCfg(phase: keyof OllamaPhaseConfig): PhaseModelConfig {
  const baseUrl = cfg('ollamaUrl', 'http://localhost:11434');
  const defaults: Record<keyof OllamaPhaseConfig, string> = {
    embedding: cfg('embeddingModel', 'nomic-embed-text'),
    hyde: cfg('hydeModel', 'qwen3:8b'),
    rerank: cfg('rerankModel', 'qwen3:8b'),
    classifier: cfg('ollama.classifier.model', cfg('hydeModel', 'qwen3:8b')),
    structurer: cfg('ollama.structurer.model', cfg('hydeModel', 'qwen3:8b')),
    confidence: cfg('ollama.confidence.model', 'qwen3:8b'),
  };
  return {
    url: cfg(`ollama.${phase}.url`, baseUrl),
    model: cfg(`ollama.${phase}.model`, defaults[phase]),
  };
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

export function getProjectContextPath(repoPath: string): string {
  return path.join(getHarvesterRoot(repoPath), 'project_context.md');
}

export function buildConfig(overrides: Partial<HarvesterConfig> = {}): HarvesterConfig {
  const repoPath = getRepoPath();
  const ollama: OllamaPhaseConfig = {
    embedding: phaseCfg('embedding'),
    hyde: phaseCfg('hyde'),
    rerank: phaseCfg('rerank'),
    classifier: phaseCfg('classifier'),
    structurer: phaseCfg('structurer'),
    confidence: phaseCfg('confidence'),
  };
  return {
    repoPath,
    outputPath: getOutputPath(repoPath),
    cardId: '',
    fileNameTemplate: cfg('fileNameTemplate', '{CARD}_context'),
    ollamaUrl: ollama.embedding.url,
    embeddingModel: ollama.embedding.model,
    hydeModel: ollama.hyde.model,
    rerankModel: ollama.rerank.model,
    ollama,
    includeExtensions: cfg('includeExtensions', []),
    excludeExtensions: cfg('excludeExtensions', [
      '.md', '.txt', '.json', '.lock', '.yaml', '.yml', '.png', '.jpg', '.svg',
      '.pdf', '.exe', '.dll', '.zip', '.nupkg',
    ]),
    excludeFolders: getExcludeFolders(),
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
    enableConfidenceScore: cfg('enableConfidenceScore', false),
    exportJson: cfg('exportJson', false),
    exportTxt: cfg('exportTxt', false),
    focusBackend: true,
    focusFrontend: true,
    focusSql: true,
    featureInput: '',
    activeProfile: cfg('activeProfile', 'laptop-balanced'),
    enableFunctionalAnalysis: cfg('enableFunctionalAnalysis', false),
    enableGraphView: cfg('enableGraphView', false),
    enableMcpServer: cfg('enableMcpServer', false),
    mcpPort: cfg('mcp.port', 3456),
    mcpAutoStart: cfg('mcp.autoStart', false),
    graphMinCommunitySize: cfg('graph.minCommunitySize', 3),
    graphMaxCommunitySize: cfg('graph.maxCommunitySize', 50),
    graphAutoValidate: cfg('graph.autoValidate', false),
    graphNormalizeNodeNames: cfg('graph.normalizeNodeNames', true),
    graphReassignUnassigned: cfg('graph.reassignUnassigned', true),
    graphMinDegreeForReassign: cfg('graph.minDegreeForReassign', 1),
    labelFirstTraversalDepth: cfg('graph.labelFirst.traversalDepth', 2),
    labelFirstMaxNodes: cfg('graph.labelFirst.maxNodes', 100),
    labelExpansionUrl: cfg('ollama.labelExpansion.url', cfg('ollamaUrl', 'http://localhost:11434')),
    labelExpansionModel: cfg('ollama.labelExpansion.model', 'qwen3:4b'),
    webappAutoOpenBrowser: cfg('webapp.autoOpenBrowser', true),
    analysisGitLogDays: cfg('analysis.gitLogDays', 90),
    analysisFunctionSimilarityThreshold: cfg('analysis.functionSimilarityThreshold', 0.3),
    analysisEntryPointPatterns: cfg('analysis.entryPointPatterns', [
      'Controller', 'Program.cs', 'Startup.cs', 'Page.tsx', 'App.tsx', 'index.ts',
    ]),
    analysisApiEdgePatterns: cfg('analysis.apiEdgePatterns', ['fetch', 'axios']),
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
  const excludeFolders = getExcludeFolders().map((f) => f.toLowerCase());
  const relLower = rel.toLowerCase();
  const parts = relLower.split('/');
  for (const exc of excludeFolders) {
    const norm = exc.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (norm.includes('/')) {
      if (relLower === norm || relLower.startsWith(`${norm}/`)) {
        return true;
      }
    } else if (parts.includes(norm)) {
      return true;
    }
  }
  return false;
}
