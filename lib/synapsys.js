'use strict';

const { SynapsysConfigError } = require('./errors');
const { resolveConfig, validateForStartup, rejectUnknownKeys } = require('./config');
const { createLogger } = require('./logger');
const { formatDuration, parseDuration } = require('./duration');
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
    this._stopPromise = null;
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
   * Shuts the worker down, cooperatively and within a bounded budget.
   *
   *   1. stop the heartbeat loop, and prevent another beat from starting;
   *   2. request a cooperative stop for every running process;
   *   3. wait up to `shutdownTimeout` for them to become terminal;
   *   4. send one best-effort final heartbeat carrying the final states and
   *      whatever logs are still queued, ignoring the commands in its response;
   *   5. uninstall console capture and release the sockets.
   *
   * Business logic that ignores cancellation may still be alive when the budget
   * runs out. The library cannot safely kill it, so it says so and leaves it
   * running: the application owns the decision to wait longer or exit. Such a
   * process is still tracked, and a replacement execution cannot overlap it.
   *
   * Idempotent and non-throwing. Concurrent callers share one shutdown; a second
   * call awaits the first rather than starting a second teardown.
   *
   * @param {{timeout?: string|number}} [options] overrides the configured budget.
   */
  async stop(options) {
    if (this._stopPromise) return this._stopPromise;
    const self = this;
    this._stopPromise = this._runStop(options).then(
      function () { self._stopPromise = null; return self; },
      function () { self._stopPromise = null; return self; }
    );
    return this._stopPromise;
  }

  async _runStop(options) {
    if (!this._started) {
      // Never started, or already stopped: still release anything half-installed.
      this._teardown();
      return this;
    }

    let budget = this._config.shutdownTimeout;
    if (options && options.timeout !== undefined) {
      budget = parseDuration(options.timeout, 'stop() timeout');
    }
    const deadline = Date.now() + budget;

    // 1. No further beats. Done first, so the loop cannot race the final one.
    if (this._loop) {
      try { this._loop.stop(); } catch (_) { /* non-throwing */ }
    }

    // 2. Ask every process to stop. One that throws must not skip the others.
    for (const process of this._processes.values()) {
      try {
        process.handleStop();
      } catch (error) {
        try {
          this._logger.error(
            "Could not stop process '" + process.name + "' during shutdown", error
          );
        } catch (_) {
          // Deliberately empty.
        }
      }
      try { process.cancel(); } catch (_) { /* non-throwing */ }
    }

    // 3. Wait, but never past the caller's deadline.
    await this._settleProcesses(deadline);

    // 4. One bounded, best-effort final snapshot. Its response is not applied and
    //    its failure is diagnostic only: shutdown never fails for it.
    if (this._loop) {
      try {
        await this._loop.finalTick(deadline - Date.now());
      } catch (error) {
        try { this._logger.debug('Final heartbeat failed', error); } catch (_) { /* noop */ }
      }
    }

    // 5. Only now is capture uninstalled: everything printed during the stop
    //    sequence had a chance to reach Core on the final beat.
    this._teardown();
    this._started = false;
    try { this._logger.info('Worker stopped'); } catch (_) { /* non-throwing */ }
    return this;
  }

  /** Waits for every process to become terminal, or for the deadline to pass. */
  async _settleProcesses(deadline) {
    const processes = Array.from(this._processes.values());
    const settled = Promise.all(processes.map(function (process) {
      return process.settle();
    }));

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      this._reportUnsettled(processes);
      return;
    }

    let timer = null;
    const expiry = new Promise(function (resolve) {
      timer = setTimeout(resolve, remaining);
      if (typeof timer.unref === 'function') timer.unref();
    });
    try {
      await Promise.race([settled, expiry]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    this._reportUnsettled(processes);
  }

  _reportUnsettled(processes) {
    for (const process of processes) {
      if (!process.inFlight) continue;
      try {
        this._logger.warn(
          "Process '" + process.name + "' did not stop before the shutdown timeout | " +
          'it is still running and will not be replaced by a new execution'
        );
      } catch (_) {
        // Deliberately empty.
      }
    }
  }

  _teardown() {
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
