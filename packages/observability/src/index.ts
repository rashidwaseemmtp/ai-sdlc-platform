/**
 * @sdlc/observability — structured logging with mandatory secret redaction.
 *
 * Redaction is not optional and not opt-in. Every log line and every audit write passes through
 * `redact()`, because the failure mode we are guarding against (an API key in a log file, a token
 * in an agent's tool arguments) is silent and permanent.
 */

import { pino, type Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

const SECRET_KEY_PATTERN =
  /^(.*(api[-_]?key|apikey|token|secret|password|passwd|credential|authorization|auth|cookie|session|private[-_]?key|master[-_]?key).*)$/i;

/** Shapes that look like credentials regardless of the field name they arrive under. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI / Anthropic style
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, // GitHub
  /\bfigd_[A-Za-z0-9_-]{16,}\b/g, // Figma
  /\bAIza[0-9A-Za-z_-]{20,}\b/g, // Google
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export const REDACTED = '[REDACTED]';

/** Registered at boot from the resolved secret values, so exact matches are caught too. */
const knownSecrets = new Set<string>();

export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 8) knownSecrets.add(value);
}

export function clearRegisteredSecrets(): void {
  knownSecrets.clear();
}

function redactString(input: string): string {
  let out = input;
  for (const secret of knownSecrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Deep-redact any value. Keys that look secret are replaced wholesale; string values are scanned
 * for credential shapes and for exact matches of registered secrets.
 */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 12) return value;
  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1)) as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redact(val, depth + 1);
  }
  return out as unknown as T;
}

let rootLogger: Logger | undefined;

export function getLogger(bindings: Record<string, unknown> = {}): Logger {
  if (!rootLogger) {
    const level = process.env.LOG_LEVEL ?? 'info';
    const pretty = process.env.NODE_ENV !== 'production' && process.env.LOG_PRETTY !== 'false';
    rootLogger = pino({
      level,
      // Every log object is redacted before serialisation — no caller can opt out.
      formatters: {
        level: (label) => ({ level: label }),
        log: (obj) => redact(obj) as Record<string, unknown>,
      },
      ...(pretty
        ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } } }
        : {}),
    });
  }
  return Object.keys(bindings).length ? rootLogger.child(bindings) : rootLogger;
}

export interface Timer {
  stop(): number;
}

export function startTimer(): Timer {
  const started = Date.now();
  return { stop: () => Date.now() - started };
}

/** Lightweight in-process counters; the API exposes them at /metrics. */
class Metrics {
  private counters = new Map<string, number>();
  private histograms = new Map<string, number[]>();

  increment(name: string, by = 1, labels: Record<string, string> = {}): void {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  observe(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.key(name, labels);
    const bucket = this.histograms.get(key) ?? [];
    bucket.push(value);
    if (bucket.length > 1000) bucket.shift();
    this.histograms.set(key, bucket);
  }

  snapshot(): { counters: Record<string, number>; histograms: Record<string, unknown> } {
    const histograms: Record<string, unknown> = {};
    for (const [key, values] of this.histograms) {
      const sorted = [...values].sort((a, b) => a - b);
      histograms[key] = {
        count: sorted.length,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
      };
    }
    return { counters: Object.fromEntries(this.counters), histograms };
  }

  private key(name: string, labels: Record<string, string>): string {
    const suffix = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    return suffix ? `${name}{${suffix}}` : name;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[index] ?? 0;
}

export const metrics = new Metrics();
