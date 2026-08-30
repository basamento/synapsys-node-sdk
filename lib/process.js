'use strict';

const { StopSignal } = require('./stop-signal');
const { toRunId } = require('./json');

const STATE = {
  IDLE: 'idle',
  RUNNING: 'running',
  STOPPING: 'stopping',
  FAILED: 'failed'
};

/** Desired states Core is allowed to command. `failed` is observable only. */
const COMMANDABLE = [STATE.IDLE, STATE.RUNNING, STATE.STOPPING];

/**
 * What a command handler did with the command.
 *
 * `deferred` means the command was understood but cannot be applied yet — a start
 * arriving while the previous execution is still stopping. The caller must leave
 * the token unacknowledged so Core redelivers it on a later beat; acknowledging a
 * deferred start as a no-op loses that run forever.
 */
const OUTCOME = { HANDLED: 'handled', DEFERRED: 'deferred' };

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
    this._cleanupPromise = null;

    // True from the moment a run is accepted until its body has fully returned and
    // its cleanup hook has settled. `currentState` alone is not enough: a body that
    // ignores cancellation stays alive after the state has already gone back to
    // idle, and a replacement execution must not overlap it.
    this._inFlight = false;
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
      this.syncRunId(runId);
      return { command: 'none', token: this.ackToken, runId: null };
    }

    // Only strictly greater means new. Equal or lower is a duplicate.
    if (desiredToken <= this.ackToken) {
      // runId describes the active execution, not just a new command, so it is
      // tracked even when the token has already been acknowledged.
      this.syncRunId(runId);
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
      this.syncRunId(runId);
      this.desiredToken = desiredToken;
      return { command: 'none', token: desiredToken, runId: null };
    }

    this.desiredState = desiredState;
    this.desiredToken = desiredToken;

    // `idle` means no outstanding command. Reading it as an instruction would shut
    // down everything this worker owns on the first quiet beat.
    if (desiredState === STATE.RUNNING) {
      // The new run id is deliberately *not* stored here. A start that arrives
      // while the previous execution is still stopping is deferred, and replacing
      // the active run's id would attach the old run's remaining output to an
      // execution that has not begun. handleStart() adopts it on acceptance.
      return { command: 'start', token: desiredToken, runId: toRunId(runId) };
    }
    if (desiredState === STATE.STOPPING) {
      this.syncRunId(runId);
      return { command: 'stop', token: desiredToken, runId: null };
    }
    this.syncRunId(runId);
    return { command: 'none', token: desiredToken, runId: null };
  }

  /**
   * Tracks the run id Core reports for the active execution.
   *
   * Kept as an exact decimal string. Core's runId is an int64 from the wall clock
   * in nanoseconds, which a JS number cannot hold without rounding.
   */
  syncRunId(runId) {
    if (runId !== undefined) this.runId = toRunId(runId);
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

  /** True while a body or its cleanup hook has not yet returned. */
  get inFlight() {
    return this._inFlight;
  }

  /** Waits for any in-flight run and its cleanup hook. Used by shutdown and tests. */
  async settle() {
    for (const pending of [this._runPromise, this._cleanupPromise]) {
      if (!pending) continue;
      try {
        await pending;
      } catch (_) {
        // Both are already absorbed at their source; this is belt and braces.
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

  /**
   * Returns `handled` when the desired running state has been reached or already
   * held, and `deferred` when the previous execution has not finished yet.
   */
  handleStart(runId) {
    // A duplicate start for the execution already running is an idempotent no-op.
    if (this.currentState === STATE.RUNNING) return OUTCOME.HANDLED;

    // A start arriving while the previous run is still stopping - or while a body
    // that ignored cancellation is still alive - is deferred, not swallowed. The
    // token stays unacknowledged and Core redelivers it once this run is terminal.
    if (this.currentState === STATE.STOPPING || this._inFlight) return OUTCOME.DEFERRED;

    const stop = new StopSignal(this.name);
    this._stop = stop;
    this._cleanupPromise = null;
    this._inFlight = true;
    this.runId = runId;

    // RUNNING is set here, synchronously, before the body is invoked. Setting it
    // inside the async body would leave a window in which a second start command
    // observes `idle` and spawns a duplicate.
    this.currentState = STATE.RUNNING;

    this._detach(this._run(runId, stop));
    return OUTCOME.HANDLED;
  }

  async _run(runId, stop) {
    const self = this;
    let failed = false;

    try {
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
      // The cleanup hook is awaited here, inside the run, so that the process stays
      // in flight until it settles and a replacement execution cannot overlap it.
      if (this._cleanupPromise) await this._cleanupPromise;
    } finally {
      if (!failed) this.currentState = STATE.IDLE;
      if (this._stop === stop) this._stop = null;
      this._inFlight = false;
    }
  }

  /** A stop for a process that is not running is an idempotent handled no-op. */
  handleStop() {
    if (this.currentState !== STATE.RUNNING) return OUTCOME.HANDLED;

    this.currentState = STATE.STOPPING;
    if (this._stop) this._stop._abort();

    // onStop is detached rather than awaited: handleStop runs on the heartbeat
    // path, and a slow cleanup hook must not delay the other processes' commands
    // on the same beat. _run awaits it before the process becomes startable again.
    this._detachCleanup();
    return OUTCOME.HANDLED;
  }

  _detachCleanup() {
    if (this._cleanupPromise) return; // at most once per run
    const self = this;
    this._cleanupPromise = Promise.resolve()
      .then(function () { return self._invokeOnStop(); })
      .catch(function (error) {
        try {
          self._logger.error("onStop() failed for process '" + self.name + "'", error);
        } catch (_) {
          // Deliberately empty.
        }
      });
  }
}

/** Runs to completion, returning to idle by finishing. */
class ProgressiveProcess extends ManagedProcess {
  constructor(options) {
    super(Object.assign({}, options, { type: 'progressive' }));
  }

  handleStart(runId) {
    if (this.currentState === STATE.RUNNING) return OUTCOME.HANDLED;
    if (this.currentState === STATE.STOPPING || this._inFlight) return OUTCOME.DEFERRED;

    const stop = new StopSignal(this.name);
    this._stop = stop;
    this._inFlight = true;
    this.runId = runId;

    // Set before the body is invoked, so a second start cannot observe `idle` and
    // queue a duplicate run.
    this.currentState = STATE.RUNNING;

    this._detach(this._run(runId, stop));
    return OUTCOME.HANDLED;
  }

  async _run(runId, stop) {
    const self = this;
    let failed = false;
    let cancelled = false;

    try {
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
    } finally {
      if (!failed) this.currentState = STATE.IDLE;
      if (this._stop === stop) this._stop = null;
      this._inFlight = false;
    }
  }

  handleStop() {
    if (!this._inFlight) return OUTCOME.HANDLED;
    if (this.currentState === STATE.STOPPING) return OUTCOME.HANDLED;
    this.currentState = STATE.STOPPING;
    if (this._stop) this._stop._abort();
    return OUTCOME.HANDLED;
  }
}

module.exports = { ManagedProcess, EndlessProcess, ProgressiveProcess, STATE, OUTCOME };
