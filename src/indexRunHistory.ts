import * as fs from 'fs';
import * as path from 'path';
import { getHarvesterRoot } from './settings';

export interface IndexRunFolderTiming {
  folder: string;
  durationMs: number;
  filesProcessed: number;
  filesIndexed: number;
  filesSkippedUnchanged: number;
}

export interface IndexRunRecord {
  id: string;
  action: 'rebuild_index' | 'incremental_index';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  success: boolean;
  error?: string | null;
  stats?: Record<string, unknown>;
  phasesMs?: Record<string, number>;
  folders: IndexRunFolderTiming[];
}

export interface IndexRunHistoryFile {
  runs: IndexRunRecord[];
  lastRunId?: string;
}

export type IndexRunHistory = IndexRunHistoryFile;

const HISTORY_FILE = 'index_run_history.json';

export function loadIndexRunHistory(repoPath: string): IndexRunHistory {
  const filePath = path.join(getHarvesterRoot(repoPath), HISTORY_FILE);
  if (!fs.existsSync(filePath)) {
    return { runs: [] };
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as IndexRunHistory;
    if (Array.isArray(data.runs)) {
      return data;
    }
  } catch {
    /* ignore */
  }
  return { runs: [] };
}

export function getIndexRun(repoPath: string, runId: string): IndexRunRecord | undefined {
  return loadIndexRunHistory(repoPath).runs.find((r) => r.id === runId);
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
  if (min < 60) {
    return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  }
  const hr = Math.floor(min / 60);
  const rm = min % 60;
  return rm > 0 ? `${hr}h ${rm}m` : `${hr}h`;
}

export function actionLabel(action: string): string {
  if (action === 'incremental_index') {
    return 'Reindex incrementale';
  }
  if (action === 'rebuild_index') {
    return 'Rebuild index';
  }
  return action;
}
