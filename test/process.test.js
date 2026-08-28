'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { EndlessProcess, ProgressiveProcess } = require('../lib/process');
const { NO_CAPTURE } = require('../lib/synapsys');
const { recordingLogger } = require('./fake-core');

function build(Type, body, options) {
  const logger = recordingLogger();
  const process = new Type(Object.assign({
    name: 'p',
    body: body,
    logger: logger,
    capture: NO_CAPTURE
  }, options || {}));
  return { process: process, logger: logger };
}

function tick() {
  return new Promise(function (resolve) { setTimeout(resolve, 10); });
}

test('a second start while running does not create a second execution', async function () {
  let starts = 0;
  const built = build(EndlessProcess, async function (stop) {
    starts++;
    while (!stop.requested) await stop.sleep('10ms');
  });

  built.process.handleStart(1);
  built.process.handleStart(2); // arrives before the body has even been scheduled
  built.process.handleStart(3);

  await tick();
  assert.strictEqual(starts, 1);
  assert.strictEqual(built.process.currentState, 'running');

  built.process.handleStop();
  await built.process.settle();
});

test('running is set synchronously, closing the duplicate-start window', function () {
  const built = build(EndlessProcess, async function (stop) {
    while (!stop.requested) await stop.sleep('10ms');
  });
  built.process.handleStart(1);
  // Not after an await: the state must already be running when handleStart returns.
  assert.strictEqual(built.process.currentState, 'running');
  built.process.handleStop();
  return built.process.settle();
});

test('a process whose body throws ends in failed, and the throw does not escape', async function () {
  const built = build(EndlessProcess, async function () {
    throw new Error('body exploded');
  });

  built.process.handleStart(1);
  await built.process.settle();

  assert.strictEqual(built.process.currentState, 'failed');
  assert.ok(built.logger.has('error', "Endless process 'p' failed"));
  assert.match(built.logger.lines.error[0].error.message, /body exploded/);
});

test('a synchronous throw in the body is caught the same way', async function () {
  const built = build(ProgressiveProcess, function () {
    throw new Error('sync boom');
  });

  built.process.handleStart(1);
  await built.process.settle();

  assert.strictEqual(built.process.currentState, 'failed');
  assert.ok(built.logger.has('error', "Progressive process 'p' failed"));
});

test('a progressive process reaches idle by finishing', async function () {
  const built = build(ProgressiveProcess, async function () {
    await tick();
  });

  built.process.handleStart(1);
  assert.strictEqual(built.process.currentState, 'running');
  await built.process.settle();
  assert.strictEqual(built.process.currentState, 'idle');
});

test('a failed process can be started again', async function () {
  let attempt = 0;
  const built = build(ProgressiveProcess, async function () {
    attempt++;
    if (attempt === 1) throw new Error('first attempt fails');
  });

  built.process.handleStart(1);
  await built.process.settle();
  assert.strictEqual(built.process.currentState, 'failed');

  built.process.handleStart(2);
  await built.process.settle();
  assert.strictEqual(built.process.currentState, 'idle');
  assert.strictEqual(attempt, 2);
});

test('stop.sleep resolves immediately when a stop arrives, not after the delay', async function () {
  let sleptFully = null;
  const built = build(EndlessProcess, async function (stop) {
    sleptFully = await stop.sleep('30s');
  });

  built.process.handleStart(1);
  await tick();

  const started = Date.now();
  built.process.handleStop();
  await built.process.settle();
  const elapsed = Date.now() - started;

  assert.strictEqual(sleptFully, false, 'sleep reports that it was cut short');
  assert.ok(elapsed < 1000, 'stop returned in ' + elapsed + 'ms, not after 30s');
  assert.strictEqual(built.process.currentState, 'idle');
});

test('stop.sleep resolves true when it runs to completion', async function () {
  const built = build(EndlessProcess, async function (stop) {
    const full = await stop.sleep('5ms');
    assert.strictEqual(full, true);
  });
  built.process.handleStart(1);
  await built.process.settle();
});

test('an endless body returning after a stop lands in idle, not failed', async function () {
  const built = build(EndlessProcess, async function (stop) {
    while (!stop.requested) await stop.sleep('5ms');
  });

  built.process.handleStart(1);
  await tick();
  built.process.handleStop();
  assert.strictEqual(built.process.currentState, 'stopping');

  await built.process.settle();
  assert.strictEqual(built.process.currentState, 'idle');
});

test('throwIfCancelled ends a progressive run as cancelled, not failed', async function () {
  const built = build(ProgressiveProcess, async function (ctx) {
    for (let i = 0; i < 1000; i++) {
      ctx.throwIfCancelled();
      await tick();
    }
  });

  built.process.handleStart(1);
  await tick();
  built.process.handleStop();
  await built.process.settle();

  assert.strictEqual(built.process.currentState, 'idle');
  assert.strictEqual(built.logger.lines.error.length, 0, 'a stop is not a failure');
});

test('an AbortError from aborted I/O is a stop, not a failure', async function () {
  const built = build(ProgressiveProcess, async function (ctx) {
    // Stands in for fetch(url, { signal }) being aborted mid-flight.
    await new Promise(function (resolve, reject) {
      ctx.signal.addEventListener('abort', function () {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  });

  built.process.handleStart(1);
  await tick();
  built.process.handleStop();
  await built.process.settle();

  assert.strictEqual(built.process.currentState, 'idle');
  assert.strictEqual(built.logger.lines.error.length, 0);
});

test('an AbortError with no stop outstanding is a genuine failure', async function () {
  const built = build(ProgressiveProcess, async function () {
    // An unrelated request timeout, while nobody asked this process to stop.
    const error = new Error('request timed out');
    error.name = 'AbortError';
    throw error;
  });

  built.process.handleStart(1);
  await built.process.settle();

  assert.strictEqual(built.process.currentState, 'failed', 'must not be mistaken for a stop');
  assert.ok(built.logger.has('error', "Progressive process 'p' failed"));
});

test('onStop runs on a stop', async function () {
  let cleaned = 0;
  const built = build(
    EndlessProcess,
    async function (stop) { while (!stop.requested) await stop.sleep('5ms'); },
    { onStop: function () { cleaned++; } }
  );

  built.process.handleStart(1);
  await tick();
  built.process.handleStop();
  await built.process.settle();
  await tick();

  assert.strictEqual(cleaned, 1);
});

test('a process whose onStop throws still stops', async function () {
  const built = build(
    EndlessProcess,
    async function (stop) { while (!stop.requested) await stop.sleep('5ms'); },
    { onStop: function () { throw new Error('cleanup exploded'); } }
  );

  built.process.handleStart(1);
  await tick();
  built.process.handleStop();
  await built.process.settle();
  await tick();

  assert.strictEqual(built.process.currentState, 'idle', 'the stop completed regardless');
  assert.ok(built.logger.has('error', "onStop() failed for process 'p'"));
});

test('a progressive onStop that throws does not mask the run result', async function () {
  const built = build(
    ProgressiveProcess,
    async function (ctx) { while (!ctx.requested) await tick(); },
    { onStop: async function () { throw new Error('cleanup exploded'); } }
  );

  built.process.handleStart(1);
  await tick();
  built.process.handleStop();
  await built.process.settle();

  assert.strictEqual(built.process.currentState, 'idle');
  assert.ok(built.logger.has('error', "onStop() failed for process 'p'"));
});

test('stopping a process that is not running is a no-op', function () {
  const built = build(EndlessProcess, async function () {});
  built.process.handleStop();
  assert.strictEqual(built.process.currentState, 'idle');
});

test('token gating: only a strictly greater token is a new command', function () {
  const built = build(EndlessProcess, async function () {});
  const process = built.process;

  assert.strictEqual(process.acceptCommand('running', 5, 1).command, 'start');
  process.acknowledge(5);

  assert.strictEqual(process.acceptCommand('running', 5, 1).command, 'none', 'duplicate');
  assert.strictEqual(process.acceptCommand('running', 3, 1).command, 'none', 'stale');
  assert.strictEqual(process.acceptCommand('stopping', 6, null).command, 'stop');
});

test('idle as a desired state is no command, never a stop', function () {
  const built = build(EndlessProcess, async function () {});
  const decision = built.process.acceptCommand('idle', 9, null);
  assert.strictEqual(decision.command, 'none');
});

test('failed is refused as a desired state, but acknowledged so it is not redelivered', function () {
  const built = build(EndlessProcess, async function () {});
  const decision = built.process.acceptCommand('failed', 4, null);
  assert.strictEqual(decision.command, 'none');
  assert.strictEqual(decision.token, 4);
  assert.ok(built.logger.has('debug', 'Ignoring unsupported desired state'));
});

test('runId is tracked even when the token is already acknowledged', function () {
  const built = build(EndlessProcess, async function () {});
  built.process.acceptCommand('running', 2, 111);
  built.process.acknowledge(2);

  built.process.acceptCommand('running', 2, 222); // same token, new run id
  assert.strictEqual(built.process.runId, 222);
});

test('a missing desiredToken is treated as no command', function () {
  const built = build(EndlessProcess, async function () {});
  assert.strictEqual(built.process.acceptCommand('running', undefined, null).command, 'none');
  assert.strictEqual(built.process.acceptCommand('running', null, null).command, 'none');
});

test('the heartbeat entry carries exactly what the protocol requires', function () {
  const built = build(ProgressiveProcess, async function () {});
  built.process.acceptCommand('running', 3, 99);
  built.process.acknowledge(3);

  assert.deepStrictEqual(built.process.toHeartbeatEntry(), {
    name: 'p',
    type: 'progressive',
    currentState: 'idle',
    ackToken: 3,
    runId: 99
  });
});
