'use strict';

const { SynapsysConfigError } = require('./errors');
const { resolveConfig, validateForStartup, rejectUnknownKeys } = require('./config');
const { createLogger } = require('./logger');
const { formatDuration } = require('./duration');
const { LogCapture } = require('./log-capture');
const { HttpClient } = require('./http-client');
const { HeartbeatLoop } = require('./heartbeat');
const { EndlessProcess, ProgressiveProcess } = require('./process');

const PROCESS_OPTION_KEYS = ['onStop'];

/**
 * A Synapsys worker.
 *
 * Registration is explicit and takes any function reference — a named declaration,
 * an arrow, a method, a function imported from a file that knows nothing about
 * Synapsys. There is no file globbing and no directory convention, because both
 * break under esbuild, webpack and ncc, which is what production deployments use.
 */
class Synapsys {
  constructor(options) {
    // Runs before anything else, and regardless of `enabled`: a mistyped key is
    // exactly the mistake that would otherwise hide inside a disabled test run.
    this._config = resolveConfig(options);
    this._logger = createLogger(this._config);
    this._processes = new Map();

    this._capture = null;
    this._client = null;
    this._loop = null;
    this._started = false;
    this._stopping = false;
  }

  /** The resolved configuration, with the token omitted. */
  get config() {
    const visible = Object.assign({}, this._config);
    delete visible.coreToken;
    delete visible.logger;
    return visible;
  }

  /** Registered processes, in registration order. */
  get processes() {
    return Array.from(this._processes.values());
  }

  /**
   * Registers a process that runs until stopped.
   *
   *   synapsys.endless('invoice-poller', async (stop) => {
   *     while (!stop.requested) {
   *       await pollInvoices();
   *       await stop.sleep('30s');
   *     }
   *   });
   *
   * The name may be omitted when the function has one of its own.
   */
  endless(name, body, options) {
    return this._register(EndlessProcess, 'endless', name, body, options);
  }

  /**
   * Registers a process that runs to completion, returning itself to idle by
   * finishing.
   *
   *   synapsys.progressive('monthly-report', buildMonthlyReport);
   */
  progressive(name, body, options) {
    return this._register(ProgressiveProcess, 'progressive', name, body, options);
  }

  /**
   * Validates, probes Core once, installs console capture and starts the loop.
   *
   * Plain Node has no lifecycle container to hook, so this call is unavoidable —
   * it is the one line beyond registration that the library costs. It is safe to
   * leave unawaited; awaiting it only matters with `failFast`, which reports an
   * unreachable Core by rejecting.
   */
  async start() {
    // A complete no-op: no timer, no network call, no stream interception, and no
    // requirement to configure Core at all. This is what makes the dependency
    // invisible to a test suite.
    if (!this._config.enabled) {
      this._logger.debug('Disabled | no heartbeat, no console capture, no network calls');
      return this;
    }
    if (this._started) return this;

    const warnings = validateForStartup(this._config);
    for (const warning of warnings) this._logger.warn(warning);

    this._client = new HttpClient(this._config);
    this._loop = new HeartbeatLoop({
      config: this._config,
      processes: this.processes,
      capture: null,
      logger: this._logger,
      client: this._client
    });

    const reachable = await this._loop.checkHealth();
    if (!reachable) {
      if (this._config.failFast) {
        // Leave nothing behind: this failure is meant to stop the application, and
        // a half-installed library would be worse than none.
        this._teardown();
        throw new SynapsysConfigError(
          'Core is unreachable at startup: ' + this._config.coreUrl
        );
      }
      this._logger.warn(
        'Core is unreachable at ' + this._config.coreUrl +
        ' | heartbeat retries will continue'
      );
    }

    if (this._config.captureConsole) {
      this._capture = new LogCapture({ logger: this._logger });
      this._capture.install();
      this._loop._capture = this._capture;
      for (const process of this._processes.values()) process._capture = this._capture;
    }

    this._started = true;

    // Echoing the resolved configuration once turns "why is nothing appearing in
    // the console" into a five-second diagnosis.
    this._logger.info(
      "Worker '" + this._config.workerName + "' registered " + this._processes.size +
      ' process(es) | core=' + this._config.coreUrl +
      ' host=' + (this._config.host === null ? '<unset>' : this._config.host) +
      ' heartbeat=' + formatDuration(this._config.heartbeatInterval)
    );

    this._loop.start();
    return this;
  }

  /**
   * Stops the loop, restores the console streams and asks every running process to
   * stop. Idempotent and non-throwing: it runs during teardown, where an exception
   * is at best noise and at worst masks the real cause.
   */
  async stop() {
    if (!this._started || this._stopping) {
      this._teardown();
      return this;
    }
    this._stopping = true;

    try {
      for (const process of this._processes.values()) {
        try {
          process.handleStop();
        } catch (_) {
          // Deliberately empty.
        }
        process.cancel();
      }
      this._teardown();
      this._logger.info('Worker stopped');
    } catch (error) {
      try {
        this._logger.debug('Error during shutdown', error);
      } catch (_) {
        // Deliberately empty.
      }
    }

    this._started = false;
    this._stopping = false;
    return this;
  }

  _teardown() {
    // Capture is uninstalled first, so nothing written during shutdown is queued
    // against a loop that is about to stop draining it.
    if (this._capture) {
      try { this._capture.uninstall(); } catch (_) { /* non-throwing */ }
      this._capture = null;
    }
    if (this._loop) {
      try { this._loop.stop(); } catch (_) { /* non-throwing */ }
      this._loop = null;
    }
    if (this._client) {
      try { this._client.close(); } catch (_) { /* non-throwing */ }
      this._client = null;
    }
  }

  _register(Type, kind, name, body, options) {
    // Allow `synapsys.endless(pollInvoices)` — the function's own name is a stable,
    // derivable default.
    if (typeof name === 'function') {
      options = body;
      body = name;
      name = body.name;
    }

    if (typeof body !== 'function') {
      throw new SynapsysConfigError(
        'synapsys.' + kind + '() needs a function to run. Got ' +
        (body === undefined ? 'nothing' : typeof body) + '.'
      );
    }
    if (typeof name !== 'string' || name.trim() === '') {
      throw new SynapsysConfigError(
        'synapsys.' + kind + '() needs a process name. Pass one as the first ' +
        'argument, or register a named function so the name can be derived.'
      );
    }

    const settings = options === undefined || options === null ? {} : options;
    if (typeof settings !== 'object' || Array.isArray(settings)) {
      throw new SynapsysConfigError(
        'synapsys.' + kind + '() options must be an object. Got ' + typeof settings + '.'
      );
    }
    rejectUnknownKeys(settings, PROCESS_OPTION_KEYS, "options for process '" + name + "'");

    if (settings.onStop !== undefined && typeof settings.onStop !== 'function') {
      throw new SynapsysConfigError(
        "'onStop' for process '" + name + "' must be a function. Got " +
        typeof settings.onStop + '.'
      );
    }

    const processName = name.trim();

    // Names are unique per worker. Core addresses processes by name within a
    // worker, so a duplicate silently misroutes commands — a startup failure, not
    // a warning.
    if (this._processes.has(processName)) {
      throw new SynapsysConfigError(
        "Duplicate process name '" + processName + "' in this worker. Names must be " +
        'unique, because Core addresses a process by its name within a worker.'
      );
    }
    if (this._started) {
      throw new SynapsysConfigError(
        "Process '" + processName + "' was registered after start(). Register every " +
        'process before starting the worker.'
      );
    }

    const process = new Type({
      name: processName,
      body: body,
      onStop: settings.onStop,
      logger: this._logger,
      // Replaced with the real capture at start(); this no-op keeps the runners
      // free of null checks when capture is disabled.
      capture: this._capture || NO_CAPTURE
    });

    this._processes.set(processName, process);
    this._logger.debug("Registered " + kind + " process '" + processName + "'");
    return this;
  }
}

/** Stands in when captureConsole is false, or before start() has run. */
const NO_CAPTURE = {
  runInScope: function (processName, runId, body) { return body(); },
  captureError: function () {},
  drain: function () { return []; },
  requeueFront: function () {},
  install: function () {},
  uninstall: function () {}
};

module.exports = { Synapsys, NO_CAPTURE };
