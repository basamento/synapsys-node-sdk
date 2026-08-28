'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const streams = require('./streams');
const { toRunId } = require('./json');

const MAX_QUEUE_ENTRIES = 10000;
const MAX_LINE_CHARS = 16000;

/**
 * A process that never emits a newline must not accumulate an unbounded partial
 * line. Four bytes per character is the worst case for UTF-8.
 */
const MAX_PARTIAL_BYTES = MAX_LINE_CHARS * 4;

/**
 * Which capture owns the patched write methods. Patching process.stdout.write is
 * process-global, exactly as System.setOut is in the Spring starter, so ownership
 * has to be tracked in module scope rather than per instance.
 */
let active = null;
let installed = null;

/**
 * Binds console output to the process that produced it.
 *
 * Node has no threads, so the Spring starter's ThreadLocal has no equivalent.
 * AsyncLocalStorage is the direct analogue: a store entered with `run()` is
 * inherited by every continuation scheduled inside it, which means it survives
 * `await` and reaches callbacks the user code never sees. That is what makes
 * attribution correct when two processes interleave on the one event loop.
 */
const storage = new AsyncLocalStorage();

class LogCapture {
  constructor(options) {
    const settings = options || {};
    this.queue = [];
    this.maxQueueEntries = settings.maxQueueEntries || MAX_QUEUE_ENTRIES;
    this.maxLineChars = settings.maxLineChars || MAX_LINE_CHARS;
    this.logger = settings.logger || null;

    // The streams to tee. Injectable so the capture can be exercised against a
    // pair of fakes: a test that patched the real process.stdout would swallow the
    // test runner's own output, which is precisely the leak this class exists to
    // prevent.
    this._out = settings.stdout || process.stdout;
    this._err = settings.stderr || process.stderr;
  }

  /**
   * Replaces the two write methods with tees. The stream objects themselves are
   * left alone: anything holding a reference to process.stdout — a pino
   * destination, a pipe target — keeps working, and restoring is one assignment.
   */
  install() {
    if (active === this) return;
    if (active === null) {
      const out = this._out;
      const err = this._err;
      const originals = {
        out: out.write,
        err: err.write,
        // Whether the method was an own property before we touched it, so
        // uninstall can put the object back into exactly the shape it was in.
        outOwn: Object.prototype.hasOwnProperty.call(out, 'write'),
        errOwn: Object.prototype.hasOwnProperty.call(err, 'write'),
        outStream: out,
        errStream: err
      };
      // Only the real console streams back the library's own logging bypass.
      if (out === process.stdout && err === process.stderr) {
        streams.save(originals.out, originals.err);
      }
      const patched = {
        out: makeTee('stdout', originals.out, out),
        err: makeTee('stderr', originals.err, err)
      };
      out.write = patched.out;
      err.write = patched.err;
      installed = { originals: originals, patched: patched };
    }
    active = this;
  }

  /**
   * Restores the original streams, but only if they are still ours.
   *
   * A global monkey patch that outlives the process leaks across test files, and
   * blindly reassigning would clobber anything that patched on top of us.
   */
  uninstall() {
    if (active !== this) return;
    active = null;

    if (installed) {
      restore(installed.originals.outStream, 'out', installed);
      restore(installed.originals.errStream, 'err', installed);
      installed = null;
    }
    streams.clear();
  }

  /** True while this capture owns the console streams. Used by the tests. */
  get isInstalled() {
    return active === this;
  }

  /**
   * Runs `body` with console output attributed to this process and run.
   *
   * Any partial line left unterminated when the body settles is flushed, so a
   * process whose last write has no trailing newline does not lose it.
   */
  runInScope(processName, runId, body) {
    const store = {
      capture: this,
      processName: processName,
      runId: toRunId(runId),
      sequence: 0,
      // The partial-line buffer lives on the store, not in module scope. Were it
      // global, two processes each writing half a line would splice their
      // fragments into one corrupt record.
      partial: { stdout: null, stderr: null }
    };

    const self = this;
    return storage.run(store, function () {
      let result;
      try {
        result = body();
      } catch (error) {
        self._flushPartials(store);
        throw error;
      }
      if (result && typeof result.then === 'function') {
        return result.then(
          function (value) { self._flushPartials(store); return value; },
          function (error) { self._flushPartials(store); throw error; }
        );
      }
      self._flushPartials(store);
      return result;
    });
  }

  /**
   * Records a stack trace as stderr lines, so an uncaught process exception
   * reaches the console in Core rather than only the application's own log.
   * Must be called from inside the run's scope.
   */
  captureError(error) {
    if (!error) return;
    const text = error && error.stack ? error.stack : String(error);
    const store = storage.getStore();
    if (!store || store.capture !== this) return;
    const lines = text.split(/\r?\n/);
    for (const line of lines) this._enqueue(store, 'stderr', line);
  }

  /**
   * Takes up to `maxEntries` lines, and stops once the batch would exceed
   * `maxBytes` of UTF-8. The budget is measured in bytes rather than characters
   * because a character count under-measures by up to 4x on non-Latin scripts,
   * and the limit that matters is the one on the wire.
   */
  drain(maxEntries, maxBytes) {
    const batch = [];
    let bytes = 0;
    while (this.queue.length > 0 && batch.length < maxEntries) {
      const next = this.queue[0];
      const nextBytes = Buffer.byteLength(next.message, 'utf8');
      // Always take at least one entry, or a single oversized line would wedge
      // the queue permanently.
      if (batch.length > 0 && bytes + nextBytes > maxBytes) break;
      batch.push(this.queue.shift());
      bytes += nextBytes;
    }
    return batch;
  }

  /**
   * Puts a drained batch back at the head of the queue, in order. Dropping these
   * on a transient network error would lose exactly the output the user needs.
   */
  requeueFront(entries) {
    if (!entries || entries.length === 0) return;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (this.queue.length >= this.maxQueueEntries) this.queue.pop();
      this.queue.unshift(entries[i]);
    }
  }

  get size() {
    return this.queue.length;
  }

  /** Called by the tee, already guarded against throwing. */
  _absorb(store, source, chunk, encoding) {
    const incoming = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');

    let pending = store.partial[source];
    let start = 0;

    for (let i = 0; i < incoming.length; i++) {
      if (incoming[i] !== 0x0a) continue;
      const slice = incoming.slice(start, i);
      const line = pending ? Buffer.concat([pending, slice]) : slice;
      pending = null;
      // Decoding happens at the newline, never per write: a multi-byte character
      // can straddle two calls to write().
      this._enqueue(store, source, line.toString('utf8'));
      start = i + 1;
    }

    const remainder = incoming.slice(start);
    if (remainder.length > 0) {
      pending = pending ? Buffer.concat([pending, remainder]) : Buffer.from(remainder);
      if (pending.length > MAX_PARTIAL_BYTES) {
        this._enqueue(store, source, pending.toString('utf8'));
        pending = null;
      }
    }
    store.partial[source] = pending;
  }

  _flushPartials(store) {
    for (const source of ['stdout', 'stderr']) {
      const pending = store.partial[source];
      if (pending && pending.length > 0) {
        this._enqueue(store, source, pending.toString('utf8'));
      }
      store.partial[source] = null;
    }
  }

  _enqueue(store, source, rawLine) {
    if (store.runId === null) return;

    const line = rawLine.replace(/\r$/, '');
    // Core rejects the entire heartbeat, not just the entry, when any log line has
    // a blank message. A whitespace-only line therefore has to be dropped here
    // rather than sent and refused.
    if (line.trim() === '') return;

    const message = line.length > this.maxLineChars
      ? line.slice(0, this.maxLineChars) + '…'
      : line;

    if (this.queue.length >= this.maxQueueEntries) this.queue.shift();

    this.queue.push({
      processName: store.processName,
      runId: store.runId,
      // Sequence orders lines that share a timestamp. Core rejects anything below
      // 1, so it is pre-incremented.
      sequence: ++store.sequence,
      timestamp: new Date().toISOString(),
      source: source,
      level: source === 'stderr' ? 'error' : 'info',
      message: message
    });
  }
}

function makeTee(source, original, stream) {
  function synapsysTee(chunk, encoding, callback) {
    // The application's console is written through first and unconditionally, in
    // order, with the original return value and callback semantics preserved. A
    // fault in capture can never cost the user a line they printed.
    const result = original.call(stream, chunk, encoding, callback);
    try {
      const capture = active;
      if (capture !== null) {
        const store = storage.getStore();
        // Output from application code that is not running a process is not
        // Synapsys's business, and neither is output belonging to a capture that
        // has since been replaced.
        if (store && store.capture === capture) {
          capture._absorb(store, source, chunk, encoding);
        }
      }
    } catch (_) {
      // Deliberately empty: console capture is never allowed to break console output.
    }
    return result;
  }
  return synapsysTee;
}

function restore(stream, key, state) {
  if (stream.write !== state.patched[key]) return; // someone patched on top of us
  if (state.originals[key + 'Own']) {
    stream.write = state.originals[key];
  } else {
    delete stream.write; // put the prototype method back in charge
  }
}

module.exports = { LogCapture, MAX_QUEUE_ENTRIES, MAX_LINE_CHARS };
