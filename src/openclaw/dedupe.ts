import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "fs";
import { createHash, randomUUID } from "crypto";
import { join } from "path";

import { atomicWriteJsonSync } from "../lib/atomic-write.js";
import { isProcessAlive } from "../platform/index.js";
import type { OpenClawContext, OpenClawHookEvent, OpenClawSignal } from "./types.js";

const STATE_DIR = [".omc", "state"];
const STATE_FILE = "openclaw-event-dedupe.json";
const LOCK_FILE = "openclaw-event-dedupe.lock";

const START_WINDOW_MS = 10_000;
const PROMPT_WINDOW_MS = 4_000;
const STOP_WINDOW_MS = 12_000;
const STATE_TTL_MS = 6 * 60 * 60 * 1000;
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 10_000;

const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

interface DedupeStateRecord {
  event: OpenClawHookEvent;
  routeKey: string;
  tmuxSession: string;
  lastSeenAt: string;
  count: number;
}

interface DedupeState {
  updatedAt: string;
  records: Record<string, DedupeStateRecord>;
}

interface DedupeDescriptor {
  key: string;
  windowMs: number;
}

interface LockFileSnapshot {
  raw: string;
  pid: number | null;
  token: string | null;
}

interface LockHandle {
  fd: number;
  token: string;
}

function sleepMs(ms: number): void {
  try {
    Atomics.wait(SLEEP_ARRAY, 0, 0, ms);
  } catch {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      // spin fallback for runtimes that reject Atomics.wait on main thread
    }
  }
}

function getStateDir(projectPath: string): string {
  return join(projectPath, ...STATE_DIR);
}

function getStatePath(projectPath: string): string {
  return join(getStateDir(projectPath), STATE_FILE);
}

function getLockPath(projectPath: string): string {
  return join(getStateDir(projectPath), LOCK_FILE);
}

function ensureStateDir(projectPath: string): void {
  mkdirSync(getStateDir(projectPath), { recursive: true, mode: 0o700 });
}

function readState(projectPath: string): DedupeState {
  const statePath = getStatePath(projectPath);
  if (!existsSync(statePath)) {
    return { updatedAt: new Date(0).toISOString(), records: {} };
  }

  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<DedupeState>;
    return {
      updatedAt:
        typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      records:
        parsed.records && typeof parsed.records === "object" ? parsed.records as Record<string, DedupeStateRecord> : {},
    };
  } catch {
    return { updatedAt: new Date(0).toISOString(), records: {} };
  }
}

function writeState(projectPath: string, state: DedupeState): void {
  ensureStateDir(projectPath);
  atomicWriteJsonSync(getStatePath(projectPath), state);
}

function readLockSnapshot(projectPath: string): LockFileSnapshot | null {
  try {
    const raw = readFileSync(getLockPath(projectPath), "utf-8");
    const trimmed = raw.trim();
    if (!trimmed) {
      return { raw, pid: null, token: null };
    }

    try {
      const parsed = JSON.parse(trimmed) as { pid?: unknown; token?: unknown };
      return {
        raw,
        pid: typeof parsed.pid === "number" && Number.isFinite(parsed.pid) ? parsed.pid : null,
        token: typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : null,
      };
    } catch {
      return { raw, pid: null, token: null };
    }
  } catch {
    return null;
  }
}

function removeLockIfUnchanged(projectPath: string, snapshot: LockFileSnapshot): boolean {
  try {
    const currentRaw = readFileSync(getLockPath(projectPath), "utf-8");
    if (currentRaw !== snapshot.raw) {
      return false;
    }
  } catch {
    return false;
  }

  try {
    unlinkSync(getLockPath(projectPath));
    return true;
  } catch {
    return false;
  }
}

function acquireLock(projectPath: string): LockHandle | null {
  ensureStateDir(projectPath);
  const started = Date.now();

  while (Date.now() - started < LOCK_TIMEOUT_MS) {
    try {
      const token = randomUUID();
      const fd = openSync(
        getLockPath(projectPath),
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      writeSync(fd, JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() }), null, "utf-8");
      return { fd, token };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        throw error;
      }

      try {
        const ageMs = Date.now() - statSync(getLockPath(projectPath)).mtimeMs;
        if (ageMs > LOCK_STALE_MS) {
          const snapshot = readLockSnapshot(projectPath);
          if (snapshot) {
            if (snapshot.pid !== null && isProcessAlive(snapshot.pid)) {
              sleepMs(LOCK_RETRY_MS);
              continue;
            }
            if (removeLockIfUnchanged(projectPath, snapshot)) {
              continue;
            }
          }
        }
      } catch {
        // best effort stale lock cleanup
      }

      sleepMs(LOCK_RETRY_MS);
    }
  }

  return null;
}

function releaseLock(projectPath: string, lock: LockHandle): void {
  try {
    closeSync(lock.fd);
  } catch {
    // ignore close failure
  }

  const snapshot = readLockSnapshot(projectPath);
  if (!snapshot || snapshot.token !== lock.token) {
    return;
  }
  removeLockIfUnchanged(projectPath, snapshot);
}

function withProjectLock<T>(projectPath: string, callback: () => T): T {
  const lock = acquireLock(projectPath);
  if (!lock) {
    return callback();
  }

  try {
    return callback();
  } finally {
    releaseLock(projectPath, lock);
  }
}

function normalizePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, 400);
}

function promptHash(prompt: string): string {
  return createHash("sha1").update(prompt).digest("hex").slice(0, 12);
}

function buildDescriptor(
  event: OpenClawHookEvent,
  signal: OpenClawSignal,
  context: OpenClawContext,
  tmuxSession: string,
  projectPath: string,
): DedupeDescriptor | null {
  const scope = `${projectPath}::${tmuxSession}`;

  switch (event) {
    case "session-start":
      return {
        key: `session.started::${scope}`,
        windowMs: START_WINDOW_MS,
      };
    case "keyword-detector": {
      const prompt = typeof context.prompt === "string" ? normalizePrompt(context.prompt) : "";
      if (!prompt) {
        return null;
      }
      return {
        key: `session.prompt-submitted::${scope}::${promptHash(prompt)}`,
        windowMs: PROMPT_WINDOW_MS,
      };
    }
    case "stop":
      return {
        key: `session.stopped::${scope}`,
        windowMs: STOP_WINDOW_MS,
      };
    case "session-end":
      return {
        key: `session.finished::${scope}`,
        windowMs: STOP_WINDOW_MS,
      };
    default:
      if (signal.routeKey === "pull-request.created" || signal.routeKey === "test.failed") {
        return null;
      }
      return null;
  }
}

function pruneState(state: DedupeState, nowMs: number): void {
  const cutoff = nowMs - STATE_TTL_MS;
  for (const [key, record] of Object.entries(state.records)) {
    const lastSeenMs = Date.parse(record.lastSeenAt);
    if (!Number.isFinite(lastSeenMs) || lastSeenMs < cutoff) {
      delete state.records[key];
    }
  }
}

export function shouldCollapseOpenClawBurst(
  event: OpenClawHookEvent,
  signal: OpenClawSignal,
  context: OpenClawContext,
  tmuxSession: string | undefined,
): boolean {
  const projectPath = context.projectPath;
  if (!projectPath || !tmuxSession) {
    return false;
  }

  const descriptor = buildDescriptor(event, signal, context, tmuxSession, projectPath);
  if (!descriptor) {
    return false;
  }

  return withProjectLock(projectPath, () => {
    const state = readState(projectPath);
    const nowMs = Date.now();
    pruneState(state, nowMs);

    const nowIso = new Date(nowMs).toISOString();
    const existing = state.records[descriptor.key];
    const lastSeenMs = existing ? Date.parse(existing.lastSeenAt) : Number.NaN;
    const shouldCollapse = Number.isFinite(lastSeenMs) && nowMs - lastSeenMs < descriptor.windowMs;

    state.records[descriptor.key] = {
      event,
      routeKey: signal.routeKey,
      tmuxSession,
      lastSeenAt: nowIso,
      count: (existing?.count ?? 0) + 1,
    };
    state.updatedAt = nowIso;
    writeState(projectPath, state);

    return shouldCollapse;
  });
}
