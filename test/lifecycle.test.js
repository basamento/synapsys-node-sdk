'use strict';

/**
 * The lifecycle rules that are shared with every other Synapsys client library:
 * deferred starts, token acknowledgement, cancellation versus failure, and the
 * bounded cooperative shutdown that ends with one final heartbeat.
 */

const test = require('node:test');
const assert = require('node:assert');

const { Synapsys } = require('../index.js');
const { EndlessProcess, ProgressiveProcess, OUTCOME } = require('../lib/process');
const { NO_CAPTURE } = require('../lib/synapsys');
const { FakeCore, waitFor, recordingLogger } = require('./fake-core');

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

function tick(times) {
  const rounds = times || 1;
  let chain = Promise.resolve();
  for (let i = 0; i < rounds; i++) {
    chain = chain.then(function () {
      return new Promise(function (resolve) { setTimeout(resolve, 10); });
    });
  }
  return chain;
}

/** Builds a worker pointed at a fake Core. The caller owns shutdown. */
async function worker(options) {
  const core = new FakeCore();
  await core.listen();
  const logger = recordingLogger();
  const synapsys = new Synapsys(Object.assign({
    coreUrl: core.url,
    coreToken: 'test-token',
    workerName: 'test-worker',
    heartbeatInterval: '1s',
    captureConsole: false,
    logger: logger
  }, options || {}));
  return { core: core, synapsys: synapsys, logger: logger };
}

// ---------------------------------------------------------------------------
// Deferred start
// ---------------------------------------------------------------------------

test('a start received while stopping is deferred, not acknowledged', async function () {
  let bodies = 0;
  let release = null;
  const held = new Promise(function (resolve) { release = resolve; });

  const built = build(EndlessProcess, async function (stop) {
    bodies++;
    // Deliberately ignores the stop signal until the test releases it, which is
    // exactly the case the deferral rule exists for.
    await held;
    void stop;
  });

  assert.strictEqual(built.process.handleStart('100'), OUTCOME.HANDLED);
  await tick();

  assert.strictEqual(built.process.handleStop(), OUTCOME.HANDLED);
  assert.strictEqual(built.process.currentState, 'stopping');

  // The redelivered start, arriving while the old run refuses to die.
  assert.strictEqual(built.process.handleStart('200'), OUTCOME.DEFERRED);
  assert.strictEqual(bodies, 1, 'no overlapping execution');
  assert.strictEqual(built.process.runId, '100', 'the active run id is preserved');

  release();
  await tick(2);
  assert.strictEqual(built.process.currentState, 'idle');

  // Once the old run is terminal, the redelivered start is accepted.
  assert.strictEqual(built.process.handleStart('200'), OUTCOME.HANDLED);
  await tick();
  assert.strictEqual(bodies, 2);
  assert.strictEqual(built.process.runId, '200');

  release = null;
  built.process.handleStop();
  await built.process.settle();
});

test('a deferred start leaves ackToken behind so Core redelivers it', async function () {
  const ctx = await worker();
  try {
    let release = null;
    const held = new Promise(function (resolve) { release = resolve; });
    ctx.synapsys.endless('stubborn', async function () { await held; });

    await ctx.synapsys.start();
    ctx.core.command('stubborn', 'running', 1, 111);
    await waitFor(function () {
      return ctx.synapsys.processes[0].currentState === 'running';
    }, 'first run');

    ctx.core.command('stubborn', 'stopping', 2, 111);
    await waitFor(function () {
      return ctx.synapsys.processes[0].ackToken === 2;
    }, 'stop acknowledged');

    // Core now asks for a new run while the old one is still stopping.
    ctx.core.command('stubborn', 'running', 3, 222);
    await tick(3);

    const process = ctx.synapsys.processes[0];
    assert.strictEqual(process.ackToken, 2, 'the start is not acknowledged');
    assert.strictEqual(process.runId, '111', 'the old run id is not replaced');
    assert.strictEqual(process.currentState, 'stopping');

    // The old run finally exits; the same command is redelivered and applied.
    release();
    await waitFor(function () {
      return ctx.synapsys.processes[0].ackToken === 3;
    }, 'redelivered start acknowledged', 6000);
    assert.strictEqual(ctx.synapsys.processes[0].runId, '222');
  } finally {
    await ctx.synapsys.stop({ timeout: '2s' });
    await ctx.core.close();
  }
});

test('a stop for an inactive process is an idempotent handled no-op', function () {
  const built = build(EndlessProcess, async function () {});
  assert.strictEqual(built.process.handleStop(), OUTCOME.HANDLED);
  assert.strictEqual(built.process.currentState, 'idle');
  assert.strictEqual(built.process.handleStop(), OUTCOME.HANDLED);
});

test('a duplicate start for the running execution is a handled no-op', async function () {
  let bodies = 0;
  const built = build(EndlessProcess, async function (stop) {
    bodies++;
    while (!stop.requested) await stop.sleep('10ms');
  });

  assert.strictEqual(built.process.handleStart('7'), OUTCOME.HANDLED);
  await tick();
  assert.strictEqual(built.process.handleStart('8'), OUTCOME.HANDLED);
  assert.strictEqual(bodies, 1);
  // A duplicate start must not silently reassign the active execution's run id.
  assert.strictEqual(built.process.runId, '7');

  built.process.handleStop();
  await built.process.settle();
});

test('a progressive start while the previous run is in flight is deferred', async function () {
  let release = null;
  const held = new Promise(function (resolve) { release = resolve; });
  let bodies = 0;
  const built = build(ProgressiveProcess, async function () {
    bodies++;
    await held;
  });

  assert.strictEqual(built.process.handleStart('1'), OUTCOME.HANDLED);
  await tick();
  built.process.handleStop();
  assert.strictEqual(built.process.handleStart('2'), OUTCOME.DEFERRED);
  assert.strictEqual(bodies, 1);

  release();
  await built.process.settle();
  assert.strictEqual(built.process.handleStart('2'), OUTCOME.HANDLED);
  await built.process.settle();
  assert.strictEqual(bodies, 2);
});

// ---------------------------------------------------------------------------
// Cancellation versus failure
// ---------------------------------------------------------------------------

test('a cooperative stop is not a process failure', async function () {
  const built = build(ProgressiveProcess, async function (stop) {
    await stop.sleep('5s');
    stop.throwIfCancelled();
  });

  built.process.handleStart('1');
  await tick();
  built.process.handleStop();
  await built.process.settle();

  assert.strictEqual(built.process.currentState, 'idle');
  assert.strictEqual(built.logger.lines.error.length, 0);
});

test('a body that throws ends failed and never rethrows into the host', async function () {
  const built = build(ProgressiveProcess, async function () {
    throw new Error('business exploded');
  });

  built.process.handleStart('1');
  await built.process.settle();

  assert.strictEqual(built.process.currentState, 'failed');
  assert.ok(built.logger.has('error', "Progressive process 'p' failed"));
});

test('a failed process can be started again by a later command', async function () {
  let attempts = 0;
  const built = build(ProgressiveProcess, async function () {
    attempts++;
    if (attempts === 1) throw new Error('first attempt fails');
  });

  built.process.handleStart('1');
  await built.process.settle();
  assert.strictEqual(built.process.currentState, 'failed');

  assert.strictEqual(built.process.handleStart('2'), OUTCOME.HANDLED);
  await built.process.settle();
  assert.strictEqual(built.process.currentState, 'idle');
  assert.strictEqual(attempts, 2);
});

test('a throwing onStop still stops the process', async function () {
  const built = build(EndlessProcess, async function (stop) {
    while (!stop.requested) await stop.sleep('10ms');
  }, {
    onStop: function () { throw new Error('cleanup exploded'); }
  });

  built.process.handleStart('1');
  await tick();
  assert.strictEqual(built.process.handleStop(), OUTCOME.HANDLED);
  await built.process.settle();

  assert.strictEqual(built.process.currentState, 'idle');
  assert.ok(built.logger.has('error', "onStop() failed for process 'p'"));
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

test('shutdown stops processes and sends one final heartbeat', async function () {
  const ctx = await worker();
  try {
    ctx.synapsys.endless('poller', async function (stop) {
      while (!stop.requested) await stop.sleep('20ms');
    });
    await ctx.synapsys.start();
    ctx.core.command('poller', 'running', 1, 900);
    await waitFor(function () {
      return ctx.synapsys.processes[0].currentState === 'running';
    }, 'running');

    const before = ctx.core.beats.length;
    await ctx.synapsys.stop();

    assert.ok(ctx.core.beats.length > before, 'a final heartbeat was sent');
    const final = ctx.core.lastBeat;
    assert.strictEqual(final.processes[0].currentState, 'idle');
    assert.ok(ctx.logger.has('info', 'Worker stopped'));
  } finally {
    await ctx.core.close();
  }
});

test('the final heartbeat response never starts new work', async function () {
  const ctx = await worker();
  try {
    let bodies = 0;
    ctx.synapsys.endless('poller', async function (stop) {
      bodies++;
      while (!stop.requested) await stop.sleep('20ms');
    });
    await ctx.synapsys.start();
    await waitFor(function () { return ctx.core.beats.length > 0; }, 'first beat');

    // Core answers the final beat with a fresh start command. Shutdown must ignore it.
    ctx.core.command('poller', 'running', 5, 555);
    await ctx.synapsys.stop();
    await tick(2);

    assert.strictEqual(bodies, 0, 'no process was started by the final response');
    assert.strictEqual(ctx.synapsys.processes[0].ackToken, 0);
  } finally {
    await ctx.core.close();
  }
});

test('a failing final heartbeat does not fail shutdown', async function () {
  const ctx = await worker();
  try {
    ctx.synapsys.endless('poller', async function (stop) {
      while (!stop.requested) await stop.sleep('20ms');
    });
    await ctx.synapsys.start();
    await waitFor(function () { return ctx.core.beats.length > 0; }, 'first beat');

    await ctx.core.close(); // Core disappears mid-shutdown
    await ctx.synapsys.stop();
    assert.ok(ctx.logger.has('info', 'Worker stopped'));
  } finally {
    await ctx.core.close();
  }
});

test('a slow final heartbeat cannot outlast the shutdown budget', async function () {
  const ctx = await worker({ requestTimeout: '5s' });
  try {
    ctx.synapsys.endless('poller', async function (stop) {
      while (!stop.requested) await stop.sleep('20ms');
    });
    await ctx.synapsys.start();
    await waitFor(function () { return ctx.core.beats.length > 0; }, 'first beat');

    ctx.core.responseDelayMs = 4000;
    const started = Date.now();
    await ctx.synapsys.stop({ timeout: '600ms' });
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 3000, 'shutdown returned in ' + elapsed + 'ms');
    assert.ok(ctx.logger.has('info', 'Worker stopped'));
  } finally {
    await ctx.core.close();
  }
});

test('business code that ignores cancellation is reported, not killed', async function () {
  const ctx = await worker();
  let release = null;
  const held = new Promise(function (resolve) { release = resolve; });
  try {
    ctx.synapsys.endless('stubborn', async function () { await held; });
    await ctx.synapsys.start();
    ctx.core.command('stubborn', 'running', 1, 42);
    await waitFor(function () {
      return ctx.synapsys.processes[0].currentState === 'running';
    }, 'running');

    await ctx.synapsys.stop({ timeout: '300ms' });
    assert.ok(ctx.logger.has('warn', 'did not stop before the shutdown timeout'));
    assert.ok(ctx.synapsys.processes[0].inFlight, 'still observed');
  } finally {
    if (release) release();
    await ctx.core.close();
  }
});

test('stop is idempotent and safe to call concurrently', async function () {
  const ctx = await worker();
  try {
    ctx.synapsys.endless('poller', async function (stop) {
      while (!stop.requested) await stop.sleep('20ms');
    });
    await ctx.synapsys.start();
    await waitFor(function () { return ctx.core.beats.length > 0; }, 'first beat');

    const before = ctx.core.beats.length;
    await Promise.all([ctx.synapsys.stop(), ctx.synapsys.stop(), ctx.synapsys.stop()]);
    await ctx.synapsys.stop();

    const finals = ctx.core.beats.length - before;
    assert.strictEqual(finals, 1, 'exactly one final heartbeat, got ' + finals);
  } finally {
    await ctx.core.close();
  }
});

test('stop before start is a no-op', async function () {
  const ctx = await worker();
  try {
    await ctx.synapsys.stop();
    assert.strictEqual(ctx.core.beats.length, 0);
  } finally {
    await ctx.core.close();
  }
});

test('a cleanup hook that throws does not break shutdown', async function () {
  const ctx = await worker();
  try {
    ctx.synapsys.endless('poller', async function (stop) {
      while (!stop.requested) await stop.sleep('20ms');
    }, {
      onStop: function () { throw new Error('cleanup exploded'); }
    });
    await ctx.synapsys.start();
    ctx.core.command('poller', 'running', 1, 7);
    await waitFor(function () {
      return ctx.synapsys.processes[0].currentState === 'running';
    }, 'running');

    await ctx.synapsys.stop();
    assert.ok(ctx.logger.has('info', 'Worker stopped'));
  } finally {
    await ctx.core.close();
  }
});
