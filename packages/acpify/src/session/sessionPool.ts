/**
 * `SessionPool` — persistent per-`(adapter.id, cwd)` pool of ACP
 * sessions, keyed by `SessionKey`.
 *
 * The pool owns the lifecycle of `CliAcpClient` instances but does NOT
 * run the ACP handshake itself. When a new `(adapter.id, cwd)` tuple
 * is observed, the pool instantiates a `CliAcpClient` from
 * `clientFactory`, wraps it in an `AcpSession`, and lets the caller
 * drive the per-session handshake (`initialize` + `session/new`) via
 * `session.ensureStarted(connectFn)`. PR 09 (the registry) wires the
 * real `connectFn`; for this PR the extension supplies one that
 * throws immediately so the contract that "wiring is `done` before
 * use" is preserved.
 *
 * Idle sessions are evicted after `SessionPoolOptions.idleEvictMs`
 * (default 30 minutes; tests override to 5 seconds). On eviction, the
 * pool calls `AcpSession.disconnect()` and removes the session from
 * its map. `shutdownAll()` force-disconnects every session.
 *
 * Per the architecture decision in `docs/architecture.md`, this module
 * must NOT import `vscode`. It lives in `packages/acpify/src/session/`
 * which is the agent-agnostic layer.
 */

import type { CliAcpClient } from "../client/cliClient.js";
import { AcpSession } from "./acpSession.js";

export interface SessionKey {
  readonly agentId: string;
  readonly cwd: string;
}

export interface SessionPoolOptions {
  /**
   * Idle eviction timeout in milliseconds. Default: 30 minutes.
   * Production wires this from configuration; tests override to 5 s.
   */
  idleEvictMs?: number;
  /**
   * Called after a session is evicted. The payload is the session's
   * `SessionKey` (not its `sessionId`) because eviction can happen
   * before the handshake resolves — `sessionId` would not yet exist.
   */
  onSessionEvicted?: (key: SessionKey, reason: "idle" | "error") => void;
}

const DEFAULT_IDLE_MS = 30 * 60_000;

/**
 * Pool of `AcpSession`s keyed by `SessionKey`. Single-process,
 * in-memory; persistence and cross-process sharing are out of scope
 * for PR 02.
 */
export class SessionPool {
  private readonly clientFactory: () => CliAcpClient;
  private readonly idleEvictMs: number;
  private readonly onSessionEvicted?: (key: SessionKey, reason: "idle" | "error") => void;

  private readonly sessions = new Map<string, AcpSession>();
  private readonly inflightCreate = new Map<string, Promise<AcpSession>>();
  private idleTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    clientFactory: () => CliAcpClient,
    options: SessionPoolOptions = {},
  ) {
    this.clientFactory = clientFactory;
    this.idleEvictMs = options.idleEvictMs ?? DEFAULT_IDLE_MS;
    if (options.onSessionEvicted !== undefined) {
      this.onSessionEvicted = options.onSessionEvicted;
    }
    this.scheduleIdleSweep();
  }

  /**
   * Get or create the `AcpSession` for `key`. Concurrent calls with the
   * same key share a single in-flight create promise (so two concurrent
   * `getOrCreate` calls produce one client, not two).
   *
   * Disposed sessions are dropped from the cache so the next caller
   * gets a fresh one instead of inheriting a dead session.
   */
  async getOrCreate(key: SessionKey): Promise<AcpSession> {
    if (this.disposed) {
      throw new Error("SessionPool is disposed");
    }
    const mapKey = this.keyToString(key);
    const existing = this.sessions.get(mapKey);
    if (existing && !existing.isDisposed) {
      existing.touch();
      return existing;
    }
    if (existing) {
      this.sessions.delete(mapKey);
    }
    const inflight = this.inflightCreate.get(mapKey);
    if (inflight) return inflight;

    const promise = this.createSession(mapKey, key);
    this.inflightCreate.set(mapKey, promise);
    try {
      return await promise;
    } finally {
      this.inflightCreate.delete(mapKey);
    }
  }

  /** All currently-alive sessions (a snapshot). */
  list(): AcpSession[] {
    return Array.from(this.sessions.values());
  }

  /** Force-disconnect every session and stop the idle sweep. */
  async shutdownAll(): Promise<void> {
    this.disposed = true;
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    const all = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.allSettled(all.map((s) => s.disconnect()));
  }

  /* ─────────────────────── private ─────────────────────── */

  private async createSession(mapKey: string, key: SessionKey): Promise<AcpSession> {
    const client = this.clientFactory();
    const session = new AcpSession(key, client);
    this.sessions.set(mapKey, session);
    return session;
  }

  /**
   * Sweep idle sessions on an interval. The interval is `idleEvictMs /
   * 2` so eviction happens within roughly `idleEvictMs` of the session
   * going idle, but never more than twice per timeout.
   */
  private scheduleIdleSweep(): void {
    if (this.idleTimer) return;
    const period = Math.max(1, Math.floor(this.idleEvictMs / 2));
    this.idleTimer = setInterval(() => {
      void this.sweepIdle();
    }, period);
    this.idleTimer.unref?.();
  }

  private async sweepIdle(): Promise<void> {
    const now = Date.now();
    const toEvict: Array<{ mapKey: string; session: AcpSession }> = [];
    for (const [mapKey, session] of this.sessions.entries()) {
      // Skip sessions that are actively dispatching or have queued
      // work — evicting a long-running prompt mid-flight would
      // destroy the in-flight `PromptHandle`'s settlement. Sessions
      // receive `handleSessionUpdate` for streamed chunks which
      // touches `lastUsed`, so an active prompt will not actually
      // cross the idle threshold.
      if (session.isDispatching || session.queueLength > 0) continue;
      if (now - session.lastUsed >= this.idleEvictMs) {
        toEvict.push({ mapKey, session });
      }
    }
    for (const { mapKey, session } of toEvict) {
      this.sessions.delete(mapKey);
      try {
        await session.disconnect();
      } catch (err) {
        this.onSessionEvicted?.(session.key, "error");
        if (process.env["ACP_DEBUG"] === "1") {
          console.error("[SessionPool] disconnect error:", err);
        }
        continue;
      }
      this.onSessionEvicted?.(session.key, "idle");
    }
  }

  private keyToString(key: SessionKey): string {
    return `${key.agentId}\u0000${key.cwd}`;
  }
}