'use strict';

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

  start() {
    if (this._timer !== null) return;
    const self = this;
    this._timer = setInterval(function () { self._safeTick(); }, this._config.heartbeatInterval);
    this._safeTick(); // beat immediately, rather than after one interval of silence
  }

  stop() {
    this._stopped = true;
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /** Probes Core once at startup. Never throws; the result drives fail-fast. */
  async checkHealth() {
    const url = joinUrl(this._config.coreUrl, HEALTH_PATH);
    this._logger.debug('Testing Core connection via ' + url);
    try {
      const response = await this._client.request('GET', url, null);
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
  _safeTick() {
    if (this._stopped) return;

    // A Core slower than one interval must not stack beats on top of each other.
    // The request timeout guarantees every tick settles, so this can never wedge.
    if (this._inFlight) {
      this._logger.debug('Previous heartbeat still in flight | skipping this beat');
      return;
    }

    this._inFlight = true;
    const self = this;
    this._tick().then(
      function () { self._inFlight = false; },
      function (error) {
        self._inFlight = false;
        try {
          self._logger.error(
            'Unexpected heartbeat failure | heartbeat retries will continue', error
          );
        } catch (_) {
          // Deliberately empty.
        }
      }
    );
  }

  async _tick() {
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

    this._markCoreAvailable();
    this._applyCommands(response.body);
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

    if (decision.command === 'start') {
      this._logger.info(
        "Starting process '" + process.name + "' (type=" + process.type +
        ', token=' + decision.token + ', runId=' + decision.runId + ')'
      );
      process.handleStart(decision.runId);
    } else if (decision.command === 'stop') {
      this._logger.info(
        "Stopping process '" + process.name + "' (type=" + process.type +
        ', token=' + decision.token + ')'
      );
      process.handleStop();
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

module.exports = {
  HeartbeatLoop,
  FRAMEWORK,
  joinUrl,
  MAX_LOG_ENTRIES_PER_BEAT,
  MAX_LOG_BYTES_PER_BEAT
};
