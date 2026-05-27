import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface BuildInfo {
  version: string;
  buildUtc: string;
  buildIso: string;
  buildLocal: string;
}

export function getExtensionVersion(context: vscode.ExtensionContext): string {
  return context.extension.packageJSON.version as string;
}

export function loadBuildInfo(context: vscode.ExtensionContext): BuildInfo {
  const version = getExtensionVersion(context);
  const fallback: BuildInfo = {
    version,
    buildUtc: '',
    buildIso: '',
    buildLocal: '',
  };

  const infoPath = path.join(context.extensionPath, 'media', 'build-info.json');
  if (!fs.existsSync(infoPath)) {
    return fallback;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(infoPath, 'utf8')) as Partial<BuildInfo>;
    return {
      version: raw.version?.trim() || version,
      buildUtc: raw.buildUtc?.trim() || '',
      buildIso: raw.buildIso?.trim() || '',
      buildLocal: raw.buildLocal?.trim() || '',
    };
  } catch {
    return fallback;
  }
}

/** Label for webview title, e.g. "v0.3.0 · 27/05/2026 14:30" */
export function formatVersionLabel(info: BuildInfo): string {
  const ver = info.version.startsWith('v') ? info.version : `v${info.version}`;
  if (info.buildLocal) {
    return `${ver} · ${info.buildLocal}`;
  }
  if (info.buildUtc) {
    return `${ver} · build ${info.buildUtc}`;
  }
  return ver;
}
