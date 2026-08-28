'use strict';

const { StopSignal } = require('./stop-signal');

const STATE = {
  IDLE: 'idle',
  RUNNING: 'running',
  STOPPING: 'stopping',
  FAILED: 'failed'
};

/** Desired states Core is allowed to command. `failed` is observable only. */
const COMMANDABLE = [STATE.IDLE, STATE.RUNNING, STATE.STOPPING];

/**
 * One registered process, and the token-gated command handling it shares with every
 * other Synapsys client.
 */
class ManagedProcess {
  constructor(options) {
    this.name = options.name;
    this.type = options.type;

    this.currentState = STATE.IDLE;
    this.desiredState = STATE.IDLE;
    this.desiredToken = 0;
    this.ackToken = 0;
    this.runId = null;

    this._body = options.body;
    this._onStop = options.onStop || null;
    this._logger = options.logger;
    this._capture = options.capture;

    this._stop = null;
    this._runPromise = null;
  }

  /**
   * Decides what a heartbeat response means for this process, without acting on it.
   *
   * The caller acknowledges only after the local handler has returned, so a handler
   * that throws leaves the token unacknowledged and Core redelivers on the next
   * beat. Acknowledging first and then crashing loses the command silently.
   */
  acceptCommand(desiredState, desiredToken, runId) {
    if (typeof desiredToken !== 'number' || !Number.isFinite(desiredToken)) {
      return { command: 'none', token: this.ackToken, runId: null };
    }

    // runId describes the active execution, not just a new command, so it is
    // tracked even when the token has already been acknowledged.
    if (runId !== undefined) {
      this.runId = typeof runId === 'number' && runId > 0 ? runId : null;
    }

    // Only strictly greater means new. Equal or lower is a duplicate.
    if (desiredToken <= this.ackToken) {
      return { command: 'none', token: this.ackToken, runId: null };
    }

    if (COMMANDABLE.indexOf(desiredState) === -1) {
      // Core never sends `failed` as a desired state, and a future Core may send a
      // state this version has never heard of. Acknowledge it so it is not
      // redelivered forever, but act on nothing.
      this._logger.debug(
        "Ignoring unsupported desired state '" + desiredState + "' for process '" +
        this.name + "'"
      );
      this.desiredToken = desiredToken;
      return { command: 'none', token: desiredToken, runId: null };
    }

    this.desiredState = desiredState;
    this.desiredToken = desiredToken;

    // `idle` means no outstanding command. Reading it as an instruction would shut
    // down everything this worker owns on the first quiet beat.
    if (desiredState === STATE.RUNNING) {
      return { command: 'start', token: desiredToken, runId: this.runId };
    }
    if (desiredState === STATE.STOPPING) {
      return { command: 'stop', token: desiredToken, runId: null };
    }
    return { command: 'none', token: desiredToken, runId: null };
  }

  /** Records a command only after the local handler has accepted it. */
  acknowledge(token) {
    if (typeof token === 'number' && token > this.ackToken) this.ackToken = token;
  }

  /** The snapshot sent to Core on every beat, for every process, always. */
  toHeartbeatEntry() {
    return {
      name: this.name,
      type: this.type,
      currentState: this.currentState,
      ackToken: this.ackToken,
      runId: this.runId
    };
  }

  /**
   * Starts the body without ever letting it reject into the caller.
   *
   * Node terminates the application on an unhandled rejection by default, so a
   * detached promise from user code is a live hazard to the host: the catch here is
   * what keeps a failing process from taking the application down with it.
   */
  _detach(promise) {
    const self = this;
    this._runPromise = promise.catch(function (error) {
      try {
        self.currentState = STATE.FAILED;
        self._logger.error(
          "Internal failure while running process '" + self.name + "'", error
        );
      } catch (_) {
        // Deliberately empty.
      }
    });
    return this._runPromise;
  }

  async _invokeOnStop() {
    if (!this._onStop) return;
    try {
      await this._onStop();
    } catch (error) {
      // A failing cleanup hook must not abort the stop sequence.
      this._logger.error(
        "onStop() failed for process '" + this.name + "'", error
      );
      this._capture.captureError(error);
    }
  }

  /** Waits for any in-flight run. Used by shutdown and by the tests. */
  async settle() {
    if (this._runPromise) {
      try {
        await this._runPromise;
      } catch (_) {
        // _detach already absorbed it.
      }
    }
  }

  /** Aborts any in-flight run without waiting. Used on shutdown. */
  cancel() {
    if (this._stop) this._stop._abort();
  }
}

/** Runs until told to stop, polling the stop signal cooperatively. */
class EndlessProcess extends ManagedProcess {
  constructor(options) {
    super(Object.assign({}, options, { type: 'endless' }));
  }

  handleStart(runId) {
    if (this.currentState === STATE.RUNNING || this.currentState === STATE.STOPPING) return;

    const stop = new StopSignal(this.name);
    this._stop = stop;

    // RUNNING is set here, synchronously, before the body is invoked. Setting it
    // inside the async body would leave a window in which a second start command
    // observes `idle` and spawns a duplicate.
    this.currentState = STATE.RUNNING;

    this._detach(this._run(runId, stop));
  }

  async _run(runId, stop) {
    const self = this;
    let failed = false;

    await this._capture.runInScope(this.name, runId, async function () {
      try {
        await self._body(stop);
      } catch (error) {
        if (stop._isCancellation(error)) return; // a clean stop, not a failure
        failed = true;
        self.currentState = STATE.FAILED;
        self._capture.captureError(error);
        // Reported, never rethrown: a raw stack trace from a task the user did not
        // create is the worst possible failure presentation.
        self._logger.error("Endless process '" + self.name + "' failed", error);
      }
    });

    if (!failed) this.currentState = STATE.IDLE;
    if (this._stop === stop) this._stop = null;
  }

  handleStop() {
    if (this.currentState !== STATE.RUNNING) return;

    this.currentState = STATE.STOPPING;
    if (this._stop) this._stop._abort();

    // onStop is detached rather than awaited: handleStop runs on the heartbeat
    // path, and a slow cleanup hook must not delay the other processes' commands
    // on the same beat.
    this._detachCleanup();
  }

  _detachCleanup() {
    const self = this;
    const promise = this._invokeOnStop();
    if (promise && typeof promise.catch === 'function') {
      promise.catch(function (error) {
        try {
          self._logger.error("onStop() failed for process '" + self.name + "'", error);
        } catch (_) {
          // Deliberately empty.
        }
      });
    }
  }
}

/** Runs to completion, returning to idle by finishing. */
class ProgressiveProcess extends ManagedProcess {
  constructor(options) {
    super(Object.assign({}, options, { type: 'progressive' }));
    this._inFlight = false;
  }

  handleStart(runId) {
    if (this.currentState !== STATE.IDLE && this.currentState !== STATE.FAILED) return;
    if (this._inFlight) return;

    const stop = new StopSignal(this.name);
    this._stop = stop;
    this._inFlight = true;

    // Set before the body is invoked, so a second start cannot observe `idle` and
    // queue a duplicate run.
    this.currentState = STATE.RUNNING;

    this._detach(this._run(runId, stop));
  }

  async _run(runId, stop) {
    const self = this;
    let failed = false;
    let cancelled = false;

    await this._capture.runInScope(this.name, runId, async function () {
      try {
        await self._body(stop);
      } catch (error) {
        if (stop._isCancellation(error)) {
          cancelled = true;
        } else {
          failed = true;
          self.currentState = STATE.FAILED;
          self._capture.captureError(error);
          // Reported, never rethrown: an exception here would vanish into a
          // detached promise that nothing inspects.
          self._logger.error("Progressive process '" + self.name + "' failed", error);
        }
      }

      // Cleanup runs inside the capture scope, so anything it prints reaches the
      // console in Core against this run.
      if (cancelled || stop.requested) await self._invokeOnStop();
    });

    if (!failed) this.currentState = STATE.IDLE;
    this._inFlight = false;
    if (this._stop === stop) this._stop = null;
  }

  handleStop() {
    if (!this._inFlight) return;
    this.currentState = STATE.STOPPING;
    if (this._stop) this._stop._abort();
  }
}

module.exports = { ManagedProcess, EndlessProcess, ProgressiveProcess, STATE };
