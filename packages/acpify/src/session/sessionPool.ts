/**
 * `SessionPool` — persistent per-`(adapter.id, cwd)` pool of ACP
 * sessions, keyed by `SessionKey`.
 *
 * The pool owns the lifecycle of `CliAcpClient` instances: it does NOT
 * spawn the CLI itself (that's the responsibility of whoever
 * constructs the pool, typically a future PR that knows the adapter +
 * command). For testability, two factories are injectable:
 *
 *   - `clientFactory: () => CliAcpClient` produces a fresh client.
 *   - `connectFn:     (client, key) => Promise<string>` is responsible
 *     for running the `initialize` + `session/new` handshake on the
 *     client and returning the new session id. The pool treats the
 *     returned id as opaque.
 *
 * Idle sessions are evicted after `SessionPoolOptions.idleEvictMs`
 * (default 30 minutes; tests override to 5 seconds). On eviction, the
 * pool calls `CliAcpClient.disconnect()` and removes the session from
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
  onSessionCreated?: (sessionId: string) => void;
  onSessionEvicted?: (sessionId: string, reason: "idle" | "error") => void;
}

const DEFAULT_IDLE_MS = 30 * 60_000;

/**
 * Pool of `AcpSession`s keyed by `SessionKey`. Single-process,
 * in-memory; persistence and cross-process sharing are out of scope
 * for PR 02.
 */
export class SessionPool {
  private readonly clientFactory: () => CliAcpClient;
  private readonly connectFn: (client: CliAcpClient, key: SessionKey) => Promise<string>;
  private readonly idleEvictMs: number;
  private readonly onSessionCreated?: (sessionId: string) => void;
  private readonly onSessionEvicted?: (sessionId: string, reason: "idle" | "error") => void;

  private readonly sessions = new Map<string, AcpSession>();
  private readonly inflightCreate = new Map<string, Promise<AcpSession>>();
  private idleTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    clientFactory: () => CliAcpClient,
    connectFn: (client: CliAcpClient, key: SessionKey) => Promise<string>,
    options: SessionPoolOptions = {},
  ) {
    this.clientFactory = clientFactory;
    this.connectFn = connectFn;
    this.idleEvictMs = options.idleEvictMs ?? DEFAULT_IDLE_MS;
    if (options.onSessionCreated !== undefined) {
      this.onSessionCreated = options.onSessionCreated;
    }
    if (options.onSessionEvicted !== undefined) {
      this.onSessionEvicted = options.onSessionEvicted;
    }
    this.scheduleIdleSweep();
  }

  /**
   * Get or create the `AcpSession` for `key`. Concurrent calls with the
   * same key share a single in-flight create promise (so two concurrent
   * `getOrCreate` calls produce one client, not two).
   */
  async getOrCreate(key: SessionKey): Promise<AcpSession> {
    if (this.disposed) {
      throw new Error("SessionPool is disposed");
    }
    const mapKey = this.keyToString(key);
    const existing = this.sessions.get(mapKey);
    if (existing) {
      existing.touch();
      return existing;
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
    const sessionId = await this.connectFn(client, key);
    const session = new AcpSession(key, sessionId, client);
    this.sessions.set(mapKey, session);
    this.onSessionCreated?.(sessionId);
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
    // `unref` so the timer does not keep the process alive on its own.
    this.idleTimer.unref?.();
  }

  private async sweepIdle(): Promise<void> {
    const now = Date.now();
    const toEvict: Array<{ mapKey: string; session: AcpSession }> = [];
    for (const [mapKey, session] of this.sessions.entries()) {
      if (now - session.lastUsed >= this.idleEvictMs) {
        toEvict.push({ mapKey, session });
      }
    }
    for (const { mapKey, session } of toEvict) {
      this.sessions.delete(mapKey);
      this.onSessionEvicted?.(session.sessionId, "idle");
      await session.disconnect();
    }
  }

  private keyToString(key: SessionKey): string {
    return `${key.agentId}\u0000${key.cwd}`;
  }
}