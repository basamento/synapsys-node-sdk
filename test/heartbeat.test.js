'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { Synapsys, SynapsysConfigError } = require('../index.js');
const { FakeCore, waitFor, recordingLogger } = require('./fake-core');

/** Builds a worker pointed at a fake Core, and always shuts it down. */
async function withWorker(options, body) {
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

  try {
    return await body({ core: core, synapsys: synapsys, logger: logger });
  } finally {
    await synapsys.stop();
    await core.close();
  }
}

test('the heartbeat carries the identity Core needs', async function () {
  await withWorker(null, async function (ctx) {
    ctx.synapsys.endless('poller', async function (stop) {
      while (!stop.requested) await stop.sleep('50ms');
    });
    await ctx.synapsys.start();
    await waitFor(function () { return ctx.core.beats.length > 0; }, 'first beat');

    const beat = ctx.core.lastBeat;
    assert.strictEqual(beat.workerName, 'test-worker');
    // Core coerces anything outside its enum to `unknown`, and `nodejs` is the
    // value it recognises for this runtime.
    assert.strictEqual(beat.framework, 'nodejs');
    assert.strictEqual(beat.heartbeatInterval, 1, 'whole seconds, as an integer');
    assert.ok(typeof beat.host === 'string' || beat.host === null);
    assert.deepStrictEqual(beat.processes, [
      { name: 'poller', type: 'endless', currentState: 'idle', ackToken: 0, runId: null }
    ]);
  });
});

test('the token is sent as a bearer header and never in the URL', async function () {
  await withWorker(null, async function (ctx) {
    ctx.synapsys.endless('p', async function () {});
    await ctx.synapsys.start();
    await waitFor(function () { return ctx.core.beats.length > 0; }, 'first beat');

    assert.strictEqual(ctx.core.beats[0].authorization, 'Bearer test-token');
  });
});

test('the token never appears in any log line', async function () {
  await withWorker({ logLevel: 'debug' }, async function (ctx) {
    ctx.synapsys.endless('p', async function () {});
    await ctx.synapsys.start();
    await waitFor(function () { return ctx.core.beats.length > 0; }, 'first beat');

    const everything = JSON.stringify(ctx.logger.lines);
    assert.strictEqual(everything.indexOf('test-token'), -1);
  });
});

test('every process is sent on every beat, including idle ones', async function () {
  await withWorker(null, async function (ctx) {
    ctx.synapsys.endless('a', async function () {});
    ctx.synapsys.progressive('b', async function () {});
    await ctx.synapsys.start();
    await waitFor(function () { return ctx.core.beats.length >= 2; }, 'two beats');

    for (const beat of ctx.core.beats) {
      assert.strictEqual(beat.payload.processes.length, 2);
    }
  });
});

test('a start command runs the process and advances the ack token', async function () {
  await withWorker(null, async function (ctx) {
    let running = false;
    ctx.synapsys.endless('poller', async function (stop) {
      running = true;
      while (!stop.requested) await stop.sleep('20ms');
      running = false;
    });

    await ctx.synapsys.start();
    ctx.core.command('poller', 'running', 1, 555);

    await waitFor(function () { return running; }, 'the process to start');
    await waitFor(
      function () {
        const beat = ctx.core.lastBeat;
        return beat && beat.processes[0].ackToken === 1;
      },
      'the ack token to be reported back'
    );

    const reported = ctx.core.lastBeat.processes[0];
    assert.strictEqual(reported.currentState, 'running');
    assert.strictEqual(reported.runId, 555, 'runId is carried back unchanged');
  });
});

test('the same command twice acts once', async function () {
  await withWorker(null, async function (ctx) {
    let starts = 0;
    ctx.synapsys.endless('poller', async function (stop) {
      starts++;
      while (!stop.requested) await stop.sleep('20ms');
    });

    await ctx.synapsys.start();
    ctx.core.command('poller', 'running', 1, 1);

    // The command stays queued, so it is redelivered on every beat.
    await waitFor(function () { return ctx.core.beats.length >= 4; }, 'several beats', 8000);
    assert.strictEqual(starts, 1);
  });
});

test('desiredState idle does not stop a running process', async function () {
  await withWorker(null, async function (ctx) {
    let stopped = false;
    ctx.synapsys.endless('poller', async function (stop) {
      while (!stop.requested) await stop.sleep('20ms');
      stopped = true;
    });

    await ctx.synapsys.start();
    ctx.core.command('poller', 'running', 1, 1);
    await waitFor(
      function () { return ctx.synapsys.processes[0].currentState === 'running'; },
      'the process to start'
    );

    // Core resets desiredState to idle once a command is acknowledged. Reading it
    // as an instruction would shut everything down on the first quiet beat.
    ctx.core.command('poller', 'idle', 2, 1);
    await waitFor(function () { return ctx.core.beats.length >= 4; }, 'more beats', 8000);

    assert.strictEqual(stopped, false);
    assert.strictEqual(ctx.synapsys.processes[0].currentState, 'running');
  });
});

test('a stop command returns the process to idle', async function () {
  await withWorker(null, async function (ctx) {
    ctx.synapsys.endless('poller', async function (stop) {
      while (!stop.requested) await stop.sleep('1h'); // long sleep, cut short by the stop
    });

    await ctx.synapsys.start();
    ctx.core.command('poller', 'running', 1, 1);
    await waitFor(
      function () { return ctx.synapsys.processes[0].currentState === 'running'; },
      'start'
    );

    ctx.core.command('poller', 'stopping', 2, 1);
    await waitFor(
      function () { return ctx.synapsys.processes[0].currentState === 'idle'; },
      'the process to reach idle'
    );
    assert.strictEqual(ctx.synapsys.processes[0].ackToken, 2);
  });
});

test('a response with unknown fields parses successfully', async function () {
  await withWorker(null, async function (ctx) {
    ctx.synapsys.endless('poller', async function (stop) {
      while (!stop.requested) await stop.sleep('20ms');
    });

    // A newer Core adding fields must never break a client built against an
    // older contract.
    ctx.core.extraResponseFields = {
      serverVersion: '9.9.9',
      newTopLevelThing: { nested: [1, 2, 3] }
    };
    ctx.core.commands.set('poller', {
      name: 'poller',
      desiredState: 'running',
      desiredToken: 1,
      runId: 42,
      somethingNew: 'ignore me',
      anotherNewField: { deeply: { nested: true } }
    });

    await ctx.synapsys.start();
    await waitFor(
      function () { return ctx.synapsys.processes[0].currentState === 'running'; },
      'the command to be applied despite the unknown fields'
    );
  });
});

test('a command for an unknown process is ignored, not fatal', async function () {
  await withWorker(null, async function (ctx) {
    ctx.synapsys.endless('known', async function (stop) {
      while (!stop.requested) await stop.sleep('20ms');
    });

    ctx.core.command('ghost', 'running', 1, 1);
    ctx.core.command('known', 'running', 1, 1);

    await ctx.synapsys.start();
    await waitFor(
      function () { return ctx.synapsys.processes[0].currentState === 'running'; },
      'the known process to start anyway'
    );
    assert.ok(ctx.logger.has('warn', "unknown process 'ghost'"));
  });
});

test('one failing command handler does not stop the others on the same beat', async function () {
  await withWorker(null, async function (ctx) {
    ctx.synapsys.endless('healthy', async function (stop) {
      while (!stop.requested) await stop.sleep('20ms');
    });
    ctx.synapsys.endless('broken', async function () {});

    await ctx.synapsys.start();

    // Make the first process's start handler throw.
    const broken = ctx.synapsys.processes[1];
    broken.handleStart = function () { throw new Error('handler exploded'); };

    ctx.core.command('broken', 'running', 1, 1);
    ctx.core.command('healthy', 'running', 1, 2);

    await waitFor(
      function () { return ctx.synapsys.processes[0].currentState === 'running'; },
      'the healthy process to start regardless'
    );
    assert.strictEqual(broken.currentState, 'failed');
    // The token stays unacknowledged so Core redelivers.
    assert.strictEqual(broken.ackToken, 0);
    assert.ok(ctx.logger.has('error', "Command handling failed for process 'broken'"));
  });
});

test('the loop survives a failing command handler and keeps beating', async function () {
  await withWorker(null, async function (ctx) {
    ctx.synapsys.endless('broken', async function () {});
    await ctx.synapsys.start();

    ctx.synapsys.processes[0].handleStart = function () { throw new Error('always throws'); };
    ctx.core.command('broken', 'running', 1, 1);

    const before = ctx.core.beats.length;
    await waitFor(
      function () { return ctx.core.beats.length >= before + 3; },
      'the loop to keep beating through repeated handler failures'
    );
  });
});

test('drained logs are not lost when the heartbeat fails', async function () {
  await withWorker({ captureConsole: true }, async function (ctx) {
    ctx.synapsys.endless('noisy', async function (stop) {
      console.log('a line from the process');
      while (!stop.requested) await stop.sleep('20ms');
    });

    await ctx.synapsys.start();
    ctx.core.command('noisy', 'running', 1, 77);
    await waitFor(
      function () { return ctx.synapsys.processes[0].currentState === 'running'; },
      'start'
    );

    // Break Core before the line can be delivered.
    ctx.core.heartbeatStatus = 500;
    await waitFor(function () { return ctx.core.beats.length >= 3; }, 'a failed beat', 8000);

    ctx.core.heartbeatStatus = 200;
    await waitFor(
      function () {
        return ctx.core.acceptedLogs.some(function (entry) {
          return entry.message === 'a line from the process';
        });
      },
      'the requeued line to arrive once Core recovers',
      8000
    );

    const delivered = ctx.core.acceptedLogs.filter(function (entry) {
      return entry.message === 'a line from the process';
    });
    assert.strictEqual(delivered.length, 1, 'delivered once, not duplicated');
    assert.strictEqual(delivered[0].runId, 77);
    assert.strictEqual(delivered[0].sequence, 1);
    assert.strictEqual(delivered[0].source, 'stdout');
    assert.strictEqual(delivered[0].level, 'info');
  });
});

test('Core going down does not stop a running process', async function () {
  await withWorker(null, async function (ctx) {
    let ticks = 0;
    ctx.synapsys.endless('poller', async function (stop) {
      while (!stop.requested) { ticks++; await stop.sleep('20ms'); }
    });

    await ctx.synapsys.start();
    ctx.core.command('poller', 'running', 1, 1);
    await waitFor(
      function () { return ctx.synapsys.processes[0].currentState === 'running'; },
      'start'
    );

    await ctx.core.close();
    const before = ticks;
    await new Promise(function (resolve) { setTimeout(resolve, 300); });

    assert.ok(ticks > before, 'the process kept working while Core was unreachable');
    assert.strictEqual(ctx.synapsys.processes[0].currentState, 'running');
  });
});

test('Core unavailability warns once, then drops to debug, then logs the recovery', async function () {
  await withWorker(null, async function (ctx) {
    ctx.synapsys.endless('p', async function () {});
    await ctx.synapsys.start();
    await waitFor(function () { return ctx.core.beats.length >= 1; }, 'first beat');

    ctx.core.heartbeatStatus = 503;
    await waitFor(
      function () { return ctx.core.beats.length >= 4; }, 'several failed beats', 8000
    );

    const warnings = ctx.logger.lines.warn.filter(function (entry) {
      return /rejected by Core/.test(entry.message);
    });
    assert.strictEqual(warnings.length, 1, 'log transitions, not states');

    ctx.core.heartbeatStatus = 200;
    await waitFor(
      function () { return ctx.logger.has('info', 'Core connection restored'); },
      'the recovery to be logged'
    );
  });
});

test('a healthy worker is silent at INFO in a steady state', async function () {
  await withWorker(null, async function (ctx) {
    ctx.synapsys.endless('p', async function () {});
    await ctx.synapsys.start();

    const afterStartup = ctx.logger.lines.info.length;
    await waitFor(function () { return ctx.core.beats.length >= 4; }, 'several beats', 8000);

    assert.strictEqual(
      ctx.logger.lines.info.length, afterStartup,
      'nothing at INFO on a per-heartbeat cadence'
    );
  });
});

test('startup with Core down succeeds', async function () {
  const logger = recordingLogger();
  const synapsys = new Synapsys({
    coreUrl: 'http://127.0.0.1:1',
    coreToken: 't',
    workerName: 'w',
    heartbeatInterval: '1s',
    connectTimeout: '200ms',
    requestTimeout: '400ms',
    captureConsole: false,
    logger: logger
  });
  synapsys.endless('p', async function () {});

  await synapsys.start();
  assert.ok(logger.has('warn', 'Core is unreachable at'));
  await synapsys.stop();
});

test('startup with Core down and failFast rejects, leaving nothing installed', async function () {
  const originalWrite = process.stdout.write;
  const synapsys = new Synapsys({
    coreUrl: 'http://127.0.0.1:1',
    coreToken: 't',
    workerName: 'w',
    failFast: true,
    connectTimeout: '200ms',
    requestTimeout: '400ms',
    logger: recordingLogger()
  });
  synapsys.endless('p', async function () {});

  await assert.rejects(
    function () { return synapsys.start(); },
    function (error) {
      assert.ok(error instanceof SynapsysConfigError);
      assert.match(error.message, /Core is unreachable at startup/);
      return true;
    }
  );
  assert.strictEqual(process.stdout.write, originalWrite, 'streams left untouched');
});

test('enabled false produces zero network calls and unmodified streams', async function () {
  const core = new FakeCore();
  await core.listen();
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;

  const synapsys = new Synapsys({
    enabled: false,
    coreUrl: core.url,
    coreToken: 't',
    workerName: 'w',
    heartbeatInterval: '1s'
  });
  synapsys.endless('p', async function () {});

  await synapsys.start();
  await new Promise(function (resolve) { setTimeout(resolve, 300); });

  assert.strictEqual(core.beats.length, 0, 'no heartbeats');
  assert.strictEqual(process.stdout.write, originalOut, 'stdout untouched');
  assert.strictEqual(process.stderr.write, originalErr, 'stderr untouched');

  await synapsys.stop();
  await core.close();
});

test('enabled false needs no Core configuration at all', async function () {
  const synapsys = new Synapsys({ enabled: false });
  synapsys.endless('p', async function () {});
  await synapsys.start(); // no coreUrl, no workerName, and no complaint
  await synapsys.stop();
});

test('stop is idempotent and restores the streams', async function () {
  const core = new FakeCore();
  await core.listen();
  const originalOut = process.stdout.write;

  const synapsys = new Synapsys({
    coreUrl: core.url,
    coreToken: 't',
    workerName: 'w',
    heartbeatInterval: '1s',
    logger: recordingLogger()
  });
  synapsys.endless('p', async function () {});

  await synapsys.start();
  assert.notStrictEqual(process.stdout.write, originalOut, 'capture installed while running');

  await synapsys.stop();
  await synapsys.stop();
  await synapsys.stop();

  assert.strictEqual(process.stdout.write, originalOut);
  await core.close();
});

test('stop asks running processes to stop', async function () {
  await withWorker(null, async function (ctx) {
    let finished = false;
    ctx.synapsys.endless('poller', async function (stop) {
      while (!stop.requested) await stop.sleep('1h');
      finished = true;
    });

    await ctx.synapsys.start();
    ctx.core.command('poller', 'running', 1, 1);
    await waitFor(
      function () { return ctx.synapsys.processes[0].currentState === 'running'; },
      'start'
    );

    await ctx.synapsys.stop();
    await ctx.synapsys.processes[0].settle();
    assert.strictEqual(finished, true, 'the long sleep was cut short by shutdown');
  });
});

test('the startup summary echoes the resolved configuration once', async function () {
  await withWorker(null, async function (ctx) {
    ctx.synapsys.endless('a', async function () {});
    ctx.synapsys.progressive('b', async function () {});
    await ctx.synapsys.start();

    const summary = ctx.logger.lines.info.filter(function (entry) {
      return /registered 2 process\(es\)/.test(entry.message);
    });
    assert.strictEqual(summary.length, 1);
    assert.match(summary[0].message, /heartbeat=1s/);
  });
});

test('a slow Core does not stack beats on top of each other', async function () {
  const core = new FakeCore();
  await core.listen();
  const logger = recordingLogger();

  // One beat per second, but Core takes 1.5s to answer each one, so the second
  // beat comes due while the first is still in flight. The delay is a timer rather
  // than a busy-wait: the fake Core shares this process's event loop, and blocking
  // it would stall the very timer under test.
  core.responseDelayMs = 1500;

  const synapsys = new Synapsys({
    coreUrl: core.url,
    coreToken: 't',
    workerName: 'w',
    heartbeatInterval: '1s',
    requestTimeout: '10s',
    captureConsole: false,
    logLevel: 'debug',
    logger: logger
  });
  synapsys.endless('p', async function () {});

  await synapsys.start();
  await waitFor(function () { return core.beats.length >= 2; }, 'a couple of slow beats', 15000);
  await synapsys.stop();
  await core.close();

  assert.ok(
    logger.has('debug', 'still in flight'),
    'an overlapping beat is skipped rather than queued'
  );
});
