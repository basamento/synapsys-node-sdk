/**
 * Type definitions for @synapsys-io/sdk.
 *
 * Types ship for TypeScript users, but plain JavaScript is a first-class path:
 * nothing here is required to use the library, and there is no build step.
 */

/**
 * A duration with a unit — `'30s'`, `'5m'`, `'250ms'`, `'2h'`.
 *
 * A plain number is accepted as milliseconds, but the documented form carries a
 * unit, because `30` reads as seconds to about half the people who write it.
 */
export type Duration = string | number;

/** The four states a process reports. `failed` is observable only, never commanded. */
export type ProcessState = 'idle' | 'running' | 'stopping' | 'failed';

/** The two process types, mirroring the wire protocol. */
export type ProcessType = 'endless' | 'progressive';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

/**
 * Any logger with these four methods: pino, winston, bunyan and `console` all
 * satisfy it as they are.
 */
export interface Logger {
  debug(message: string, error?: unknown): void;
  info(message: string, error?: unknown): void;
  warn(message: string, error?: unknown): void;
  error(message: string, error?: unknown): void;
}

/**
 * The cooperative stop signal handed to every process body.
 *
 * Node has no thread interrupt, so nothing can pull a running function out from
 * under itself. This object is the whole of the cooperation contract.
 */
export interface StopSignal {
  /**
   * The underlying AbortSignal. Hand it to `fetch`, a database driver or a stream
   * so in-flight I/O aborts with the stop rather than holding the process in
   * `stopping` until it completes.
   */
  readonly signal: AbortSignal;

  /** True once Core has commanded a stop. */
  readonly requested: boolean;

  /** Alias for `requested`, matching the name used across every Synapsys library. */
  isStopRequested(): boolean;

  /** Throws if a stop has been requested. The cancellation point for a long loop. */
  throwIfCancelled(): void;

  /** Alias for `throwIfCancelled()`. */
  throwIfStopped(): void;

  /**
   * Waits, returning early the moment a stop arrives.
   *
   * Resolves rather than rejects on a stop, so the canonical loop needs no
   * try/catch. Resolves `true` if the full duration elapsed, `false` if a stop cut
   * it short.
   */
  sleep(duration: Duration): Promise<boolean>;
}

/** The body of an endless process: runs until the stop signal is set. */
export type EndlessBody = (stop: StopSignal) => void | Promise<void>;

/** The body of a progressive process: runs to completion. */
export type ProgressiveBody = (ctx: StopSignal) => void | Promise<void>;

export interface ProcessOptions {
  /** Optional cleanup hook, run after a stop. Its failure never aborts the stop. */
  onStop?: () => void | Promise<void>;
}

export interface SynapsysOptions {
  /**
   * `false` is a complete no-op: no timer, no network call, no stream
   * interception. Default `true`. Env: `SYNAPSYS_ENABLED`.
   */
  enabled?: boolean;

  /** Base URL of Core. Required unless disabled. Env: `SYNAPSYS_CORE_URL`. */
  coreUrl?: string;

  /**
   * Bearer token. Not required by the library, but Core rejects heartbeats without
   * it. Env: `SYNAPSYS_CORE_TOKEN`.
   */
  coreToken?: string;

  /**
   * This worker's identity across restarts. Required unless disabled.
   * Env: `SYNAPSYS_WORKER_NAME`.
   */
  workerName?: string;

  /**
   * Host reported to Core. Defaults to the machine hostname; Core falls back to
   * the connection's remote address when unset. Env: `SYNAPSYS_HOST`.
   */
  host?: string;

  /**
   * Interval between beats. Must be a positive whole number of seconds — the wire
   * format has no other representation. Default `'5s'`.
   * Env: `SYNAPSYS_HEARTBEAT_INTERVAL`.
   */
  heartbeatInterval?: Duration;

  /**
   * Reject `start()` when Core is unreachable at startup. Default `false`.
   * Env: `SYNAPSYS_FAIL_FAST`.
   */
  failFast?: boolean;

  /** TCP connect timeout. Default `'2s'`. Env: `SYNAPSYS_CONNECT_TIMEOUT`. */
  connectTimeout?: Duration;

  /** Whole-request timeout. Default `'5s'`. Env: `SYNAPSYS_REQUEST_TIMEOUT`. */
  requestTimeout?: Duration;

  /**
   * Stream process console output to Core. Default `true`. Setting it to `false`
   * leaves `process.stdout.write` untouched. Env: `SYNAPSYS_CAPTURE_CONSOLE`.
   */
  captureConsole?: boolean;

  /** Minimum level the library logs at. Default `'info'`. Env: `SYNAPSYS_LOG_LEVEL`. */
  logLevel?: LogLevel;

  /** Send the library's own log lines to your logger instead of the console. */
  logger?: Logger;
}

/** One registered process, as reported to Core. */
export interface RegisteredProcess {
  readonly name: string;
  readonly type: ProcessType;
  readonly currentState: ProcessState;
  readonly ackToken: number;
  readonly runId: number | null;
}

/**
 * A Synapsys worker.
 *
 * Register processes, call `start()`, and Core can start and stop them remotely.
 * Deleting those lines leaves a working application.
 */
export class Synapsys {
  constructor(options?: SynapsysOptions);

  /** The resolved configuration, with the token omitted. */
  readonly config: Omit<Required<SynapsysOptions>, 'coreToken' | 'logger'>;

  /** Registered processes, in registration order. */
  readonly processes: readonly RegisteredProcess[];

  /** Registers a process that runs until stopped. */
  endless(name: string, body: EndlessBody, options?: ProcessOptions): this;
  endless(body: EndlessBody, options?: ProcessOptions): this;

  /** Registers a process that runs to completion. */
  progressive(name: string, body: ProgressiveBody, options?: ProcessOptions): this;
  progressive(body: ProgressiveBody, options?: ProcessOptions): this;

  /**
   * Starts the worker. Safe to leave unawaited; awaiting matters only with
   * `failFast`, which reports an unreachable Core by rejecting.
   */
  start(): Promise<this>;

  /** Stops the loop, restores the console streams, asks processes to stop. */
  stop(): Promise<this>;
}

/** Thrown for a malformed or missing option, including an unrecognised one. */
export class SynapsysConfigError extends Error {
  readonly name: 'SynapsysConfigError';
}

/** Thrown for a library fault that is not the user's configuration. */
export class SynapsysError extends Error {
  readonly name: 'SynapsysError';
}

/** The abort reason handed to a run when Core commands a stop. */
export class StopRequested extends Error {
  readonly name: 'StopRequested';
}
