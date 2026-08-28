'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { LogCapture } = require('../lib/log-capture');

/**
 * A stand-in for a console stream that records what reaches it.
 *
 * The capture is pointed at these rather than at the real process.stdout, because a
 * test that patched the real stream would swallow the test runner's own output —
 * the exact global-monkey-patch leak this class exists to avoid.
 */
function fakeStream() {
  const written = [];
  return {
    written: written,
    write: function (chunk) { written.push(String(chunk)); return true; },
    get text() { return written.join(''); }
  };
}

/** Builds an installed capture over fake streams, and always uninstalls it. */
async function withCapture(options, body) {
  const out = fakeStream();
  const err = fakeStream();
  const capture = new LogCapture(
    Object.assign({ stdout: out, stderr: err }, options || {})
  );
  capture.install();
  try {
    return await body(capture, out, err);
  } finally {
    capture.uninstall();
  }
}

test('console capture restores the original streams on uninstall', function () {
  // This one uses the real streams: restoring them is the property under test.
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;

  const capture = new LogCapture();
  capture.install();
  assert.notStrictEqual(process.stdout.write, originalOut, 'install should patch stdout');
  assert.notStrictEqual(process.stderr.write, originalErr, 'install should patch stderr');

  capture.uninstall();
  assert.strictEqual(process.stdout.write, originalOut);
  assert.strictEqual(process.stderr.write, originalErr);
});

test('uninstall leaves a stream alone when something else patched on top', async function () {
  await withCapture(null, function (capture, out) {
    const foreign = function () { return true; };
    out.write = foreign;
    capture.uninstall();
    assert.strictEqual(out.write, foreign, 'must not clobber a later patch');
  });
});

test('the application console is unaffected: everything still reaches the real stream', async function () {
  await withCapture(null, function (capture, out) {
    capture.runInScope('p', 1, function () {
      out.write('through the tee\n');
    });
    assert.deepStrictEqual(out.written, ['through the tee\n']);
  });
});

test('output is captured only inside a scope', async function () {
  await withCapture(null, function (capture, out) {
    out.write('application output, not a process\n');
    assert.strictEqual(capture.size, 0, 'unscoped output is not our business');

    capture.runInScope('poller', 42, function () {
      out.write('inside the process\n');
    });
    assert.strictEqual(capture.size, 1);
    assert.strictEqual(capture.queue[0].processName, 'poller');
    // Carried as an exact decimal string; Core's runId is an int64.
    assert.strictEqual(capture.queue[0].runId, '42');

    // Both lines still reached the real stream, in order.
    assert.strictEqual(out.written.length, 2);
  });
});

test('binding survives await, so async continuations stay attributed', async function () {
  await withCapture(null, async function (capture, out) {
    await capture.runInScope('async-proc', 7, async function () {
      out.write('before await\n');
      await new Promise(function (resolve) { setTimeout(resolve, 5); });
      out.write('after await\n');
    });

    assert.deepStrictEqual(
      capture.queue.map(function (e) { return e.message; }),
      ['before await', 'after await']
    );
    assert.deepStrictEqual(capture.queue.map(function (e) { return e.sequence; }), [1, 2]);
  });
});

test('two concurrent processes do not interleave their captured lines', async function () {
  await withCapture(null, async function (capture, out) {
    async function body(name) {
      await capture.runInScope(name, name === 'alpha' ? 1 : 2, async function () {
        out.write(name + '-1\n');
        await new Promise(function (resolve) { setTimeout(resolve, 5); });
        out.write(name + '-2\n');
      });
    }
    await Promise.all([body('alpha'), body('beta')]);

    const alpha = capture.queue.filter(function (e) { return e.processName === 'alpha'; });
    const beta = capture.queue.filter(function (e) { return e.processName === 'beta'; });

    assert.deepStrictEqual(alpha.map(function (e) { return e.message; }), ['alpha-1', 'alpha-2']);
    assert.deepStrictEqual(beta.map(function (e) { return e.message; }), ['beta-1', 'beta-2']);
    assert.deepStrictEqual(alpha.map(function (e) { return e.runId; }), ['1', '1']);
    // Sequence is monotonic per run, not global.
    assert.deepStrictEqual(beta.map(function (e) { return e.sequence; }), [1, 2]);
  });
});

test('a partial line is buffered per run and flushed when the scope closes', async function () {
  await withCapture(null, async function (capture, out) {
    await capture.runInScope('a', 1, async function () {
      out.write('half ');
      await new Promise(function (r) { setTimeout(r, 1); });
      out.write('a line');
    });
    assert.strictEqual(capture.size, 1);
    assert.strictEqual(capture.queue[0].message, 'half a line');
  });
});

test('concurrent partial lines are not spliced together', async function () {
  await withCapture(null, async function (capture, out) {
    async function body(name, runId) {
      await capture.runInScope(name, runId, async function () {
        out.write(name + ' says ');
        await new Promise(function (r) { setTimeout(r, 5); });
        out.write('hello\n');
      });
    }
    await Promise.all([body('alpha', 1), body('beta', 2)]);

    const messages = capture.queue
      .map(function (e) { return e.processName + ': ' + e.message; })
      .sort();
    assert.deepStrictEqual(messages, ['alpha: alpha says hello', 'beta: beta says hello']);
  });
});

test('a multi-byte character split across two writes is decoded correctly', async function () {
  await withCapture(null, function (capture, out) {
    const full = Buffer.from('héllo wörld\n', 'utf8');
    capture.runInScope('a', 1, function () {
      // Split mid-character: the second byte of the é lands in the next write.
      out.write(full.slice(0, 2));
      out.write(full.slice(2));
    });
    assert.strictEqual(capture.queue[0].message, 'héllo wörld');
  });
});

test('stderr is captured as error, stdout as info', async function () {
  await withCapture(null, function (capture, out, err) {
    capture.runInScope('a', 1, function () {
      out.write('normal\n');
      err.write('bad\n');
    });
    assert.deepStrictEqual(
      capture.queue.map(function (e) { return [e.source, e.level]; }),
      [['stdout', 'info'], ['stderr', 'error']]
    );
  });
});

test('blank and whitespace-only lines are dropped, because Core rejects the whole beat for one', async function () {
  await withCapture(null, function (capture, out) {
    capture.runInScope('a', 1, function () {
      out.write('\n');
      out.write('   \n');
      out.write('\t\n');
      out.write('real\n');
    });
    assert.strictEqual(capture.size, 1);
    assert.strictEqual(capture.queue[0].message, 'real');
  });
});

test('carriage returns are stripped, so CRLF output does not carry one to Core', async function () {
  await withCapture(null, function (capture, out) {
    capture.runInScope('a', 1, function () { out.write('windows\r\n'); });
    assert.strictEqual(capture.queue[0].message, 'windows');
  });
});

test('nothing is captured when the run has no runId, since Core would discard it', async function () {
  await withCapture(null, function (capture, out) {
    capture.runInScope('a', null, function () { out.write('orphan line\n'); });
    assert.strictEqual(capture.size, 0);
  });
});

test('long lines are truncated to the character limit', async function () {
  await withCapture({ maxLineChars: 10 }, function (capture, out) {
    capture.runInScope('a', 1, function () { out.write('0123456789ABCDEF\n'); });
    assert.strictEqual(capture.queue[0].message, '0123456789…');
  });
});

test('the queue is bounded, dropping oldest on overflow', async function () {
  await withCapture({ maxQueueEntries: 3 }, function (capture, out) {
    capture.runInScope('a', 1, function () {
      for (let i = 1; i <= 6; i++) out.write('line' + i + '\n');
    });
    assert.strictEqual(capture.size, 3);
    assert.deepStrictEqual(
      capture.queue.map(function (e) { return e.message; }),
      ['line4', 'line5', 'line6']
    );
  });
});

test('log batching respects the byte budget with multi-byte characters', async function () {
  await withCapture(null, function (capture, out) {
    // Each line is 10 characters but 30 UTF-8 bytes. A character-based budget
    // would take three; a byte-based budget takes two.
    capture.runInScope('a', 1, function () {
      for (let i = 0; i < 5; i++) out.write('日本語日本語日本語日\n');
    });

    const batch = capture.drain(100, 70);
    assert.strictEqual(batch.length, 2, 'two lines of 30 bytes fit inside 70');
    const bytes = batch.reduce(function (total, entry) {
      return total + Buffer.byteLength(entry.message, 'utf8');
    }, 0);
    assert.ok(bytes <= 70, 'the batch stays inside the byte budget');
    assert.strictEqual(capture.size, 3, 'the rest stay queued');
  });
});

test('a single oversized line is still drained, rather than wedging the queue', async function () {
  await withCapture(null, function (capture, out) {
    capture.runInScope('a', 1, function () {
      out.write(new Array(200).join('x') + '\n');
    });
    const batch = capture.drain(100, 10);
    assert.strictEqual(batch.length, 1);
    assert.strictEqual(capture.size, 0);
  });
});

test('drained logs are requeued at the front, in order', async function () {
  await withCapture(null, function (capture, out) {
    capture.runInScope('a', 1, function () { out.write('one\ntwo\nthree\n'); });

    const batch = capture.drain(2, 100000);
    assert.deepStrictEqual(batch.map(function (e) { return e.message; }), ['one', 'two']);

    capture.requeueFront(batch);
    assert.deepStrictEqual(
      capture.queue.map(function (e) { return e.message; }),
      ['one', 'two', 'three']
    );
  });
});

test('an exception is captured as stderr lines carrying the stack', async function () {
  await withCapture(null, function (capture) {
    capture.runInScope('a', 1, function () {
      capture.captureError(new Error('boom'));
    });
    assert.ok(capture.size > 0);
    assert.strictEqual(capture.queue[0].source, 'stderr');
    assert.match(capture.queue[0].message, /boom/);
  });
});

test('a throw inside the scope still flushes the partial line', async function () {
  await withCapture(null, async function (capture, out) {
    await assert.rejects(function () {
      return capture.runInScope('a', 1, async function () {
        out.write('unterminated');
        throw new Error('boom');
      });
    });
    assert.strictEqual(capture.queue[0].message, 'unterminated');
  });
});
