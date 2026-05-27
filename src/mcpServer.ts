import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildConfig, getRepoPath, HarvesterConfig } from './settings';

let mcpProcess: ChildProcess | undefined;
let mcpPort = 3456;
let mcpLastCall: { tool?: string; duration_s?: number; card_id?: string } = {};

export function getMcpStatus(): {
  running: boolean;
  port: number;
  url: string;
  webappUrl: string;
  lastCall?: typeof mcpLastCall;
} {
  const running = Boolean(mcpProcess && !mcpProcess.killed);
  return {
    running,
    port: mcpPort,
    url: `http://127.0.0.1:${mcpPort}/mcp`,
    webappUrl: `http://127.0.0.1:${mcpPort}/`,
    lastCall: mcpLastCall,
  };
}

export async function startMcpServer(
  context: vscode.ExtensionContext,
  pythonPath: string,
  config?: HarvesterConfig
): Promise<void> {
  if (mcpProcess && !mcpProcess.killed) {
    return;
  }

  const cfg = vscode.workspace.getConfiguration('contextHarvester');
  mcpPort = cfg.get<number>('mcp.port', 3456);
  const host = '127.0.0.1';

  const harvesterCfg = config ?? buildConfig();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-mcp-'));
  const configPath = path.join(tmpDir, 'mcp-config.json');
  fs.writeFileSync(configPath, JSON.stringify(harvesterCfg, null, 2), 'utf8');

  const script = path.join(context.extensionPath, 'python', 'mcp_server.py');
  mcpProcess = spawn(
    pythonPath,
    [script, '--config', configPath, '--port', String(mcpPort), '--host', host],
    {
      cwd: path.join(context.extensionPath, 'python'),
      shell: process.platform === 'win32',
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    }
  );

  mcpProcess.stdout?.on('data', (d) => {
    const text = d.toString();
    try {
      const line = text.trim().split('\n').find((l: string) => l.startsWith('{'));
      if (line) {
        const ev = JSON.parse(line);
        if (ev.event === 'mcp_started') {
          console.log('[ContextHarvester MCP]', ev.url);
        }
      }
    } catch {
      /* log line */
    }
    console.log('[ContextHarvester MCP]', text.trim());
  });

  mcpProcess.stderr?.on('data', (d) => {
    console.error('[ContextHarvester MCP]', d.toString().trim());
  });

  mcpProcess.on('exit', () => {
    mcpProcess = undefined;
  });

  await ensureMcpJson(host, mcpPort);
  await waitForMcp(host, mcpPort, 15000);
}

export async function stopMcpServer(): Promise<void> {
  if (mcpProcess && !mcpProcess.killed) {
    mcpProcess.kill();
  }
  mcpProcess = undefined;
}

export async function restartMcpServer(
  context: vscode.ExtensionContext,
  pythonPath: string
): Promise<void> {
  await stopMcpServer();
  await startMcpServer(context, pythonPath);
}

async function waitForMcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${host}:${port}/mcp`, { method: 'GET' });
      if (res.status < 500) {
        return true;
      }
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function ensureMcpJson(host: string, port: number): Promise<void> {
  const repo = getRepoPath();
  if (!repo) {
    return;
  }
  const vscodeDir = path.join(repo, '.vscode');
  const mcpPath = path.join(vscodeDir, 'mcp.json');
  fs.mkdirSync(vscodeDir, { recursive: true });

  const content = {
    servers: {
      'context-harvester': {
        type: 'http',
        url: `http://${host}:${port}/mcp`,
        description: 'Context Harvester — semantic codebase retrieval',
      },
    },
  };
  fs.writeFileSync(mcpPath, JSON.stringify(content, null, 2), 'utf8');

  const gitignorePath = path.join(repo, '.gitignore');
  const marker = '.vscode/mcp.json';
  let gi = '';
  if (fs.existsSync(gitignorePath)) {
    gi = fs.readFileSync(gitignorePath, 'utf8');
    if (gi.includes('mcp.json')) {
      return;
    }
    if (!gi.endsWith('\n')) {
      gi += '\n';
    }
    gi += `\n# Context Harvester MCP (local)\n${marker}\n`;
  } else {
    gi = `# Context Harvester MCP (local)\n${marker}\n`;
  }
  fs.writeFileSync(gitignorePath, gi, 'utf8');
}

export function setMcpLastCall(info: typeof mcpLastCall): void {
  mcpLastCall = info;
}
