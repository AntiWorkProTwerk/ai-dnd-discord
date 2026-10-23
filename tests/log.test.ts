// The on-disk log receives every line, redacted exactly like the console.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureLog, configureLogFile, log } from '../src/log.js';

describe('log file', () => {
  it('appends redacted lines to a daily file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpg-log-'));
    const secret = 'sk-live-SECRETSECRETSECRET1234';
    configureLog('info', [secret]);
    configureLogFile(dir);
    log.info('turn', { error: `provider said ${secret}`, input: 'I open the door' });
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^bot-\d{4}-\d{2}-\d{2}\.log$/);
    const text = fs.readFileSync(path.join(dir, files[0]!), 'utf8');
    expect(text).toContain('I open the door');
    expect(text).not.toContain(secret);
    expect(text).toContain('[redacted]');
    configureLogFile(path.join(dir, 'unused'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
