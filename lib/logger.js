'use strict';

const { PREFIX } = require('./errors');
const streams = require('./streams');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const LEVEL_NAMES = Object.keys(LEVELS);

/**
 * Node has no ambient logging framework, so the specification's rule of logging
 * through the application's own framework is satisfied by accepting one: pass
 * `logger: pino()` (or winston, or bunyan, or console) and every line goes there.
 * The built-in default writes prefixed lines to the real console streams.
 */
function createLogger(options) {
  const threshold = LEVELS[options.logLevel];
  const delegate = options.logger;

  function emit(level, message, error) {
    if (LEVELS[level] < threshold) return;
    // A user-supplied logger that throws must never reach the heartbeat loop or a
    // process runner. Logging is never load-bearing.
    try {
      if (delegate) {
        const fn = delegate[level];
        if (typeof fn === 'function') {
          if (error === undefined) fn.call(delegate, PREFIX + message);
          else fn.call(delegate, PREFIX + message, error);
        }
        return;
      }
      streams.raw(
        level === 'error' || level === 'warn' ? 'stderr' : 'stdout',
        format(level, message, error)
      );
    } catch (_) {
      // Deliberately empty.
    }
  }

  return {
    debug: function (message, error) { emit('debug', message, error); },
    info: function (message, error) { emit('info', message, error); },
    warn: function (message, error) { emit('warn', message, error); },
    error: function (message, error) { emit('error', message, error); }
  };
}

function format(level, message, error) {
  let line = PREFIX + level.toUpperCase() + ' ' + message;
  if (error) {
    // Always log the cause: 'Failed to contact Core' with no exception gives the
    // user no way to tell DNS from TLS from a timeout.
    const detail = error && error.stack ? error.stack : String(error);
    line += '\n' + indent(detail);
  }
  return line + '\n';
}

function indent(text) {
  return String(text).split('\n').map(function (line) { return '    ' + line; }).join('\n');
}

module.exports = { createLogger, LEVELS, LEVEL_NAMES };
