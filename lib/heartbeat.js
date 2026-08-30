'use strict';

const { OUTCOME } = require('./process');

/** The identifier Core stores for this client. Core coerces anything else to `unknown`. */
const FRAMEWORK = 'nodejs';

const HEARTBEAT_PATH = 'api/v1/workers/heartbeat';
const HEALTH_PATH = 'api/health';

const MAX_LOG_ENTRIES_PER_BEAT = 100;
const MAX_LOG_BYTES_PER_BEAT = 96000;

/**
 * The heartbeat loop: one outbound POST on a fixed interval, carrying every process
 * this worker owns, and carrying commands back on the response.
 */
class HeartbeatLoop {
  constructor(options) {
    this._config = options.config;
    this._processes = options.processes;
    this._capture = options.capture;
    this._logger = options.logger;
    this._client = options.client;

    this._timer = null;
    this._inFlight = false;
    this._coreAvailable = true;
    this._stopped = false;
  }

  /**
   * Schedules beats at a fixed *delay*, not a fixed rate.
   *
   * setInterval fires on a fixed rate, so a Core that answers slower than one
   * interval leaves a queue of callbacks that all fire the moment it recovers - a
   * catch-up burst against a service that has just come back. Re-arming a timer
   * after each tick settles cannot burst, and cannot overlap either.
   */
  start() {
    if (this._timer !== null || this._stopped) return;
    this._beat(); // beat immediately, rather than after one interval of silence
  }

  _beat() {
    if (this._stopped) return;
    const self = this;
    this._timer = null;
    this._safeTick(function () {
      if (self._stopped) return;
      // Deliberately not unref'd: the heartbeat timer keeps the event loop alive,
      // which is what a worker wants and what this SDK has always documented.
      self._timer = setTimeout(function () { self._beat(); }, self._config.heartbeatInterval);
    });
  }

  stop() {
    this._stopped = true;
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /** Probes Core once at startup. Never throws; the result drives fail-fast. */
  async checkHealth() {
    const url = joinUrl(this._config.coreUrl, HEALTH_PATH);
    this._logger.debug('Testing Core connection via ' + url);
    try {
      const response = await this._client.request('GET', url, null, false);
      if (response.status < 200 || response.status >= 300) {
        this._logger.debug('Core health check returned status ' + response.status);
        return false;
      }
      return true;
    } catch (error) {
      this._logger.debug('Core health check failed at ' + url, error);
      return false;
    }
  }

  /**
   * Nothing escapes this method.
   *
   * A rejection from setInterval's callback becomes an unhandled rejection, which
   * on Node terminates the application by default — the loop would not merely go
   * silent, it would take the host down. The catch is unconditional and the loop
   * always continues.
   */
  _safeTick(onSettled) {
    const done = typeof onSettled === 'function' ? onSettled : function () {};
    if (this._stopped) {
      done();
      return;
    }

    // A Core slower than one interval must not stack beats on top of each other.
    // The request timeout guarantees every tick settles, so this can never wedge.
    if (this._inFlight) {
      this._logger.debug('Previous heartbeat still in flight | skipping this beat');
      done();
      return;
    }

    this._inFlight = true;
    const self = this;
    this._tick(true).then(
      function () { self._inFlight = false; done(); },
      function (error) {
        self._inFlight = false;
        try {
          self._logger.error(
            'Unexpected heartbeat failure | heartbeat retries will continue', error
          );
        } catch (_) {
          // Deliberately empty.
        }
        done();
      }
    );
  }

  /**
   * One last snapshot at shutdown: final states and whatever logs are still queued.
   *
   * The response is deliberately not applied - shutdown must never start new work -
   * and a failure is diagnostic only. It never throws, and never extends shutdown
   * beyond the caller's remaining budget.
   */
  async finalTick(budgetMs) {
    if (this._inFlight) {
      // A beat that is already on the wire carries the state we would have sent.
      this._logger.debug('A heartbeat was still in flight | skipping the final beat');
      return false;
    }
    const bounded = Math.min(
      typeof budgetMs === 'number' ? budgetMs : this._config.requestTimeout,
      this._config.requestTimeout
    );
    if (bounded <= 0) {
      this._logger.debug('Shutdown budget exhausted | skipping the final heartbeat');
      return false;
    }
    this._inFlight = true;
    try {
      await withTimeout(this._tick(false), bounded);
      return true;
    } catch (error) {
      this._logger.debug('Final heartbeat failed', error);
      return false;
    } finally {
      this._inFlight = false;
    }
  }

  async _tick(applyCommands) {
    const logs = this._capture
      ? this._capture.drain(MAX_LOG_ENTRIES_PER_BEAT, MAX_LOG_BYTES_PER_BEAT)
      : [];

    const payload = {
      workerName: this._config.workerName,
      framework: FRAMEWORK,
      host: this._config.host,
      heartbeatInterval: Math.round(this._config.heartbeatInterval / 1000),
      // Every process on every beat, including idle ones. Silence is how Core
      // decides a worker is gone.
      processes: this._processes.map(function (process) {
        return process.toHeartbeatEntry();
      })
    };
    if (logs.length > 0) payload.logs = logs;

    const url = joinUrl(this._config.coreUrl, HEARTBEAT_PATH);
    let response;
    try {
      response = await this._client.request('POST', url, payload);
    } catch (error) {
      this._requeue(logs);
      this._markCoreUnavailable('Failed to contact Core', error);
      return;
    }

    if (response.status < 200 || response.status >= 300) {
      this._requeue(logs);
      this._markCoreUnavailable(
        'Heartbeat rejected by Core with status ' + response.status, null
      );
      return;
    }

    // A 2xx whose body is not a readable HeartbeatResponse is a protocol failure,
    // not a quiet success: Core's contract makes `processes` required, so an empty
    // or unparseable body means the commands for this beat were never delivered.
    // Treating it as success would acknowledge nothing and silently discard the
    // drained logs.
    if (!isHeartbeatResponse(response.body)) {
      this._requeue(logs);
      this._markCoreUnavailable(
        'Core returned a malformed heartbeat response', response.parseError || null
      );
      return;
    }

    this._markCoreAvailable();
    if (applyCommands) this._applyCommands(response.body);
  }

  _requeue(logs) {
    // Dropping these on a transient network error loses exactly the output the
    // user needs to understand what went wrong.
    if (this._capture) this._capture.requeueFront(logs);
  }

  /**
   * Reads the response leniently. Unknown fields are ignored rather than rejected:
   * Core is versioned independently, and a client that breaks on a new field breaks
   * in the field, at a moment the user cannot fix, for a reason they cannot see.
   */
  _applyCommands(body) {
    if (!body || !Array.isArray(body.processes)) return;

    for (const update of body.processes) {
      if (!update || typeof update.name !== 'string') continue;

      const process = this._findProcess(update.name);
      if (!process) continue;

      try {
        this._apply(process, update);
      } catch (error) {
        // One misbehaving process must not stop commands reaching the others on
        // this beat, nor end the loop. The token stays unacknowledged, so Core
        // redelivers.
        this._logger.error(
          "Command handling failed for process '" + process.name + "'", error
        );
        process.currentState = 'failed';
      }
    }
  }

  _apply(process, update) {
    const decision = process.acceptCommand(
      update.desiredState,
      update.desiredToken,
      update.runId
    );

    let outcome = OUTCOME.HANDLED;
    if (decision.command === 'start') {
      this._logger.info(
        "Starting process '" + process.name + "' (type=" + process.type +
        ', token=' + decision.token + ', runId=' + decision.runId + ')'
      );
      if (decision.runId === null) {
        this._logger.warn(
          "Core started process '" + process.name + "' without a run id | its console " +
          'output cannot be attached to this run'
        );
      }
      outcome = process.handleStart(decision.runId);
    } else if (decision.command === 'stop') {
      this._logger.info(
        "Stopping process '" + process.name + "' (type=" + process.type +
        ', token=' + decision.token + ')'
      );
      outcome = process.handleStop();
    }

    if (outcome === OUTCOME.DEFERRED) {
      // The previous execution has not finished. Leaving the token unacknowledged
      // is the whole mechanism: Core redelivers the same command on a later beat,
      // and it is applied once this run is terminal. Acknowledging it here as a
      // no-op would lose the requested run forever.
      this._logger.debug(
        "Deferring command for process '" + process.name + "' (token=" + decision.token +
        ') until the current execution finishes'
      );
      return;
    }

    // Reached only when the handler returned normally. If it threw, the caller
    // records the failure and leaves the token unacknowledged.
    process.acknowledge(decision.token);
  }

  _findProcess(name) {
    for (const process of this._processes) {
      if (process.name === name) return process;
    }
    // Core naming a process this worker does not declare, after a rename for
    // instance, is never fatal: the worker could not act on it either way.
    this._logger.warn("Core sent a command for unknown process '" + name + "' | ignoring");
    return null;
  }

  _markCoreUnavailable(message, cause) {
    if (this._coreAvailable) {
      this._coreAvailable = false;
      // Transitions are logged, not states. Repeated failures drop to DEBUG so a
      // worker beating every five seconds against a dead Core stays quiet.
      this._logger.warn(message + ' | heartbeat retries will continue', cause);
    } else {
      this._logger.debug(message, cause);
    }
  }

  _markCoreAvailable() {
    if (!this._coreAvailable) {
      this._coreAvailable = true;
      this._logger.info('Core connection restored');
    }
  }
}

function joinUrl(base, path) {
  return String(base).replace(/\/+$/, '') + '/' + String(path).replace(/^\/+/, '');
}

/**
 * Whether a parsed 2xx body is a heartbeat response Core could have produced.
 *
 * Unknown *fields* are ignored, as forward compatibility requires. A missing
 * `processes` array is a different thing: it is the one member the response
 * contract makes required, and without it no command was delivered.
 */
function isHeartbeatResponse(body) {
  return Boolean(body) && typeof body === 'object' && Array.isArray(body.processes);
}

/** Bounds a promise without leaving a timer holding the event loop open. */
function withTimeout(promise, milliseconds) {
  let timer = null;
  const bound = new Promise(function (_resolve, reject) {
    timer = setTimeout(function () {
      reject(new Error('Timed out after ' + milliseconds + 'ms'));
    }, milliseconds);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, bound]).finally(function () {
    if (timer !== null) clearTimeout(timer);
  });
}

module.exports = {
  HeartbeatLoop,
  FRAMEWORK,
  joinUrl,
  MAX_LOG_ENTRIES_PER_BEAT,
  MAX_LOG_BYTES_PER_BEAT
};
