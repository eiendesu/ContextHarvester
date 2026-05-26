import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { HarvesterConfig } from './settings';

export type OrchestratorEvent =
  | { event: 'progress'; phase: string; message: string; current?: number; total?: number }
  | { event: 'done'; outputFile?: string; chunksCount?: number; depsCount?: number }
  | { event: 'error'; message: string };

export type EventHandler = (ev: OrchestratorEvent) => void;

const PYTHON_STATE_KEY = 'contextHarvester.pythonPath';

export async function ensurePythonEnvironment(context: vscode.ExtensionContext): Promise<string> {
  const saved = context.globalState.get<string>(PYTHON_STATE_KEY);
  if (saved && fs.existsSync(saved)) {
    return saved;
  }

  const extPath = context.extensionPath;
  const pythonDir = path.join(extPath, 'python');
  const venvDir = path.join(pythonDir, '.venv');
  const isWin = process.platform === 'win32';
  const venvPython = path.join(venvDir, isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');

  const systemPython = await findSystemPython();
  if (!systemPython) {
    throw new Error('Python 3.10+ non trovato nel PATH. Installa Python e riavvia VS Code.');
  }

  if (!fs.existsSync(venvPython)) {
    await runProcess(systemPython, ['-m', 'venv', venvDir], pythonDir);
  }

  const requirements = path.join(pythonDir, 'requirements.txt');
  if (fs.existsSync(requirements)) {
    await runProcess(venvPython, ['-m', 'pip', 'install', '-r', requirements], pythonDir);
  }

  await context.globalState.update(PYTHON_STATE_KEY, venvPython);
  return venvPython;
}

async function findSystemPython(): Promise<string | undefined> {
  for (const cmd of ['python3', 'python']) {
    try {
      const out = await runProcess(cmd, ['--version'], process.cwd(), true);
      if (/Python 3\.(1[0-9]|[2-9][0-9])/.test(out) || /Python 3\.1[0-9]/.test(out)) {
        return cmd;
      }
    } catch {
      /* try next */
    }
  }
  return undefined;
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  capture = false
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      shell: process.platform === 'win32',
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || stdout || `Exit code ${code}`));
      }
    });
  });
}

export async function runOrchestrator(
  pythonPath: string,
  extensionPath: string,
  config: HarvesterConfig,
  action: 'rebuild_index' | 'generate_context' | 'incremental_index',
  onEvent: EventHandler
): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-config-'));
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

  const orchestrator = path.join(extensionPath, 'python', 'orchestrator.py');

  return new Promise((resolve, reject) => {
    const proc = spawn(
      pythonPath,
      [orchestrator, '--config', configPath, '--action', action],
      {
        cwd: path.join(extensionPath, 'python'),
        shell: process.platform === 'win32',
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      }
    );

    let buffer = '';
    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      try {
        const ev = JSON.parse(trimmed) as OrchestratorEvent;
        onEvent(ev);
        if (ev.event === 'error') {
          reject(new Error(ev.message));
        }
      } catch {
        /* non-JSON log line */
      }
    };

    proc.stdout?.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      lines.forEach(handleLine);
    });

    proc.stderr?.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        console.error('[ContextHarvester]', text);
      }
    });

    proc.on('error', (err) => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
      reject(err);
    });

    proc.on('close', (code) => {
      if (buffer.trim()) {
        handleLine(buffer);
      }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
      if (code === 0) {
        resolve();
      } else if (code !== null) {
        reject(new Error(`Orchestrator terminato con codice ${code}`));
      }
    });
  });
}

export async function checkOllama(url: string): Promise<{
  reachable: boolean;
  models: string[];
  missingModels: string[];
  required: string[];
}> {
  const required = [
    vscode.workspace.getConfiguration('contextHarvester').get('embeddingModel', 'nomic-embed-text'),
    vscode.workspace.getConfiguration('contextHarvester').get('hydeModel', 'qwen2.5:3b'),
  ] as string[];

  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/tags`);
    if (!res.ok) {
      return { reachable: false, models: [], missingModels: required, required };
    }
    const data = (await res.json()) as { models?: { name: string }[] };
    const models = (data.models ?? []).map((m) => m.name.split(':')[0] === m.name ? m.name : m.name);
    const names = (data.models ?? []).map((m) => m.name);
    const missingModels = required.filter(
      (r) => !names.some((n) => n === r || n.startsWith(`${r}:`) || n.startsWith(r))
    );
    return { reachable: true, models: names, missingModels, required };
  } catch {
    return { reachable: false, models: [], missingModels: required, required };
  }
}
