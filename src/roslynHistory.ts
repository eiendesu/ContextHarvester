import * as fs from 'fs';
import * as path from 'path';
import { getHarvesterRoot } from './settings';

export interface RoslynRunSummary {
  fileCount: number;
  classCount: number;
  methodCount: number;
  endpointCount: number;
  controllerCount: number;
}

export interface RoslynRunRecord {
  id: string;
  trigger: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  success: boolean;
  summary: RoslynRunSummary;
  storagePath?: string;
  error?: string | null;
}

export interface RoslynHistoryFile {
  runs: RoslynRunRecord[];
  lastRunId?: string | null;
}

export interface RoslynFileCompact {
  path: string;
  classCount: number;
  methodCount: number;
  endpointCount: number;
  classes: Array<Record<string, unknown>>;
  methods: Array<Record<string, unknown>>;
  endpoints: Array<Record<string, unknown>>;
}

const HISTORY_FILE = 'roslyn_history.json';

export function loadRoslynHistory(repoPath: string): RoslynHistoryFile {
  const filePath = path.join(getHarvesterRoot(repoPath), HISTORY_FILE);
  if (!fs.existsSync(filePath)) {
    return { runs: [] };
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as RoslynHistoryFile;
    if (Array.isArray(data.runs)) {
      return data;
    }
  } catch {
    /* ignore */
  }
  return { runs: [] };
}

export function loadRoslynRunPayload(
  repoPath: string,
  runId: string
): { meta: RoslynRunRecord; scan: Record<string, unknown> } | undefined {
  const p = path.join(getHarvesterRoot(repoPath), 'roslyn', 'history', `${runId}.json`);
  if (!fs.existsSync(p)) {
    return undefined;
  }
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      meta?: RoslynRunRecord;
      scan?: Record<string, unknown>;
    };
    if (data.meta && data.scan) {
      return { meta: data.meta, scan: data.scan };
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

export function loadRoslynCurrent(
  repoPath: string
): { meta: RoslynRunRecord; scan: Record<string, unknown> } | undefined {
  const p = path.join(getHarvesterRoot(repoPath), 'roslyn', 'current.json');
  if (!fs.existsSync(p)) {
    return undefined;
  }
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      meta?: RoslynRunRecord;
      scan?: Record<string, unknown>;
    };
    if (data.meta && data.scan) {
      return { meta: data.meta, scan: data.scan };
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

export function compactFilesForUi(
  scan: Record<string, unknown>,
  limit = 800
): RoslynFileCompact[] {
  const files = (scan.files as Record<string, unknown>[]) || [];
  const out: RoslynFileCompact[] = [];
  for (const fe of files.slice(0, limit)) {
    const classes = (fe.classes as Record<string, unknown>[]) || [];
    const methods = (fe.methods as Record<string, unknown>[]) || [];
    const endpoints = (fe.endpoints as Record<string, unknown>[]) || [];
    out.push({
      path: String(fe.path || ''),
      classCount: classes.length,
      methodCount: methods.length,
      endpointCount: endpoints.length,
      classes: classes.slice(0, 80) as Array<Record<string, unknown>>,
      methods: methods.slice(0, 120) as Array<Record<string, unknown>>,
      endpoints: endpoints.slice(0, 40) as Array<Record<string, unknown>>,
    });
  }
  return out;
}

export function triggerLabel(trigger: string): string {
  if (trigger === 'reindex') {
    return 'Rebuild Index';
  }
  if (trigger === 'incremental_index') {
    return 'Index incrementale';
  }
  if (trigger === 'manual') {
    return 'Scan manuale';
  }
  return trigger;
}

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '—';
  }
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) {
    return `${totalSec}s`;
  }
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}
