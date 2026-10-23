// Minimal structured logger. Every line passes through redaction so provider keys and the
// Discord token cannot be printed even when they appear inside an error message.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

let threshold: number = LEVELS.info;
let secrets: string[] = [];

export function configureLog(level: string, secretValues: string[]): void {
  threshold = LEVELS[(level as Level) in LEVELS ? (level as Level) : 'info'];
  secrets = secretValues.filter((s) => s.length >= 8);
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('[redacted]');
  // Generic shapes, in case a secret arrived from somewhere other than configuration.
  out = out.replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-[redacted]');
  out = out.replace(/[MN][A-Za-z\d_-]{23,25}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}/g, '[redacted-discord-token]');
  return out;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  let line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}`;
  if (fields && Object.keys(fields).length) {
    let json: string;
    try {
      json = JSON.stringify(fields, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message } : v));
    } catch {
      json = '[unserializable]';
    }
    line += ` ${json}`;
  }
  const safe = redact(line);
  if (level === 'error' || level === 'warn') console.error(safe);
  else console.log(safe);
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => emit('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => emit('error', m, f),
};
