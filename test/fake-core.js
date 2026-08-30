'use strict';

const http = require('http');

/**
 * A minimal stand-in for Core: records every heartbeat it receives and replies with
 * whatever commands the test has queued. Real HTTP, so the client's timeouts,
 * headers and redirect behaviour are exercised rather than mocked.
 */
class FakeCore {
  constructor() {
    this.beats = [];
    this.commands = new Map();
    this.healthStatus = 200;
    this.heartbeatStatus = 200;
    this.extraResponseFields = {};
    /** When set, the heartbeat answers 200 with this exact body instead of JSON. */
    this.rawHeartbeatBody = null;
    /** Milliseconds to hold a heartbeat before answering. Does not block the loop. */
    this.responseDelayMs = 0;
    /** Logs from beats that were actually accepted. A rejected beat stores nothing. */
    this.acceptedLogs = [];
    this.onBeat = null;
    this.server = null;
    // The client keeps sockets alive, so close() has to destroy them itself or it
    // waits for the keep-alive timeout and the test run hangs.
    this.sockets = new Set();
  }

  async listen() {
    const self = this;
    this.server = http.createServer(function (request, response) {
      if (request.url === '/api/health') {
        response.writeHead(self.healthStatus, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      let body = '';
      request.on('data', function (chunk) { body += chunk; });
      request.on('end', function () {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (_) { parsed = null; }
        self.beats.push({
          payload: parsed,
          authorization: request.headers.authorization || null
        });
        if (self.onBeat) {
          try { self.onBeat(parsed); } catch (_) { /* test helper */ }
        }

        function reply() {
          if (self.heartbeatStatus < 200 || self.heartbeatStatus >= 300) {
            // A rejected beat stores nothing, exactly as a real Core would not.
            response.writeHead(self.heartbeatStatus);
            response.end('nope');
            return;
          }

          if (parsed && Array.isArray(parsed.logs)) {
            for (const entry of parsed.logs) self.acceptedLogs.push(entry);
          }

          // A 2xx that is not a readable HeartbeatResponse: an empty body, a
          // truncated one, or an HTML error page from a proxy in between.
          if (self.rawHeartbeatBody !== null) {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(self.rawHeartbeatBody);
            return;
          }

          const processes = [];
          for (const entry of self.commands.values()) processes.push(entry);
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(
            Object.assign({ processes: processes }, self.extraResponseFields)
          ));
        }

        if (self.responseDelayMs > 0) setTimeout(reply, self.responseDelayMs);
        else reply();
      });
    });

    this.server.on('connection', function (socket) {
      self.sockets.add(socket);
      socket.on('close', function () { self.sockets.delete(socket); });
    });

    await new Promise(function (resolve) {
      self.server.listen(0, '127.0.0.1', resolve);
    });
    return this.url;
  }

  get url() {
    return 'http://127.0.0.1:' + this.server.address().port;
  }

  /** Queues the command Core will return for a process until it is changed. */
  command(name, desiredState, desiredToken, runId) {
    this.commands.set(name, {
      name: name,
      desiredState: desiredState,
      desiredToken: desiredToken,
      runId: runId === undefined ? null : runId
    });
  }

  clearCommands() {
    this.commands.clear();
  }

  /** Every log line received so far, across all beats, in order. */
  get logs() {
    const all = [];
    for (const beat of this.beats) {
      if (beat.payload && Array.isArray(beat.payload.logs)) {
        for (const entry of beat.payload.logs) all.push(entry);
      }
    }
    return all;
  }

  get lastBeat() {
    return this.beats.length === 0 ? null : this.beats[this.beats.length - 1].payload;
  }

  async close() {
    const self = this;
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) {
      try { socket.destroy(); } catch (_) { /* already gone */ }
    }
    this.sockets.clear();
    await new Promise(function (resolve) { server.close(function () { resolve(); }); });
  }
}

/** Polls a predicate until it holds, or the deadline passes. */
async function waitFor(predicate, description, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 3000);
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(function (resolve) { setTimeout(resolve, 10); });
  }
  throw new Error('Timed out waiting for: ' + description);
}

/** A logger that records rather than prints, so tests can assert on library output. */
function recordingLogger() {
  const lines = { debug: [], info: [], warn: [], error: [] };
  return {
    lines: lines,
    debug: function (m, e) { lines.debug.push({ message: m, error: e }); },
    info: function (m, e) { lines.info.push({ message: m, error: e }); },
    warn: function (m, e) { lines.warn.push({ message: m, error: e }); },
    error: function (m, e) { lines.error.push({ message: m, error: e }); },
    has: function (level, fragment) {
      return lines[level].some(function (entry) {
        return entry.message.indexOf(fragment) !== -1;
      });
    }
  };
}

module.exports = { FakeCore, waitFor, recordingLogger };
