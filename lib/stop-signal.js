'use strict';

const { StopRequested } = require('./errors');
const { parseDuration } = require('./duration');

/**
 * The cooperative stop signal handed to every process body.
 *
 * Node has no Thread.interrupt(), so there is nothing that can pull a running
 * function out from under itself. Cancellation is cooperative, and this object is
 * the whole of the cooperation contract: poll `requested`, hand `signal` to any
 * I/O that accepts one, and wait with `sleep()` rather than a bare timer.
 *
 * Endless and progressive processes receive the same object. The aliases exist so a
 * user never has to remember which name belongs to which type.
 */
class StopSignal {
  constructor(processName) {
    this._processName = processName;
    this._controller = new AbortController();
    this._reason = null;
  }

  /**
   * The underlying AbortSignal. This is how in-flight I/O composes: pass it to
   * fetch, to a database driver, to a stream, and the request aborts with the stop
   * instead of holding the process in `stopping` until it completes.
   */
  get signal() {
    return this._controller.signal;
  }

  /** True once Core has commanded a stop. The cooperative poll. */
  get requested() {
    return this._controller.signal.aborted;
  }

  /** Alias, keeping the name the specification uses across every client library. */
  isStopRequested() {
    return this.requested;
  }

  /**
   * Throws if a stop has been requested. The library-provided cancellation point
   * for progressive processes; `throwIfStopped` is the same method under the name
   * that reads better in an endless loop.
   */
  throwIfCancelled() {
    if (this.requested) throw this._reason;
  }

  throwIfStopped() {
    this.throwIfCancelled();
  }

  /**
   * Waits, and returns early the moment a stop arrives.
   *
   * This is a correctness primitive, not sugar. A plain setTimeout leaves the
   * process sitting in `stopping` for the full delay, which reads as a hung worker
   * in the Core console — this is the Node equivalent of interrupting a sleeping
   * thread.
   *
   * It resolves rather than rejects on a stop, so that the canonical loop
   *
   *     while (!stop.requested) { await work(); await stop.sleep('30s'); }
   *
   * needs no try/catch: the `while` condition ends the run on the next pass. Call
   * `throwIfCancelled()` afterwards if the throwing form is wanted.
   *
   * Resolves true if the full duration elapsed, false if a stop cut it short.
   */
  sleep(duration) {
    const milliseconds = parseDuration(duration, 'stop.sleep()');
    if (this.requested) return Promise.resolve(false);

    const signal = this._controller.signal;
    return new Promise(function (resolve) {
      let timer = null;
      function onAbort() {
        if (timer !== null) clearTimeout(timer);
        resolve(false);
      }
      timer = setTimeout(function () {
        // Both sides always tear down the other, so a long-lived endless process
        // accumulates neither timers nor abort listeners.
        signal.removeEventListener('abort', onAbort);
        resolve(true);
      }, milliseconds);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Internal: commands the stop. The reason instance identifies this run. */
  _abort() {
    if (this.requested) return;
    this._reason = new StopRequested(this._processName);
    // The reason argument is ignored on Node 16, which is why the instance is also
    // held here rather than read back from signal.reason.
    this._controller.abort(this._reason);
  }

  /**
   * Whether a thrown value represents this run's stop rather than a real failure.
   *
   * The `requested` guard matters: an AbortError raised by an unrelated request
   * timeout, while no stop is outstanding, is a genuine failure and must land the
   * process in `failed`.
   */
  _isCancellation(error) {
    if (error === undefined || error === null) return false;
    if (this._reason !== null && error === this._reason) return true;
    if (!this.requested) return false;
    return error.name === 'StopRequested' ||
      error.name === 'AbortError' ||
      error.code === 'ABORT_ERR';
  }
}

module.exports = { StopSignal };
