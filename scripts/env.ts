// Loads <project root>/.env into process.env for operational scripts. Variables that are
// already set in the real environment always win; the file never overrides them.
// Import this first in every script: `import './env.js';`
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory holding package.json, whether running from scripts/ (tsx) or dist/scripts/. */
function findRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

export const PROJECT_ROOT = findRoot();

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!;
    const q = value[0];
    if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) {
      value = value.slice(1, -1);
      if (q === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      // Unquoted: strip a trailing inline comment (" # ...").
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trimEnd();
    }
    out[m[1]!] = value;
  }
  return out;
}

export function loadDotEnv(file = path.join(PROJECT_ROOT, '.env')): boolean {
  if (!fs.existsSync(file)) return false;
  const parsed = parseEnvFile(fs.readFileSync(file, 'utf8'));
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return true;
}

loadDotEnv();
