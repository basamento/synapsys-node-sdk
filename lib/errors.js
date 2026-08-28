'use strict';

/**
 * Every message the library produces starts with this, including the messages of
 * exceptions it raises. It is what lets a user grep Synapsys out of their logs.
 */
const PREFIX = '[Synapsys] ';

/** Raised for a malformed or missing option. Always thrown, never logged and swallowed. */
class SynapsysConfigError extends Error {
  constructor(message) {
    super(PREFIX + message);
    this.name = 'SynapsysConfigError';
  }
}

/** Raised for a library fault that is not the user's configuration. */
class SynapsysError extends Error {
  constructor(message) {
    super(PREFIX + message);
    this.name = 'SynapsysError';
  }
}

/**
 * The abort reason handed to a run when Core commands a stop.
 *
 * Node has no Thread.interrupt(), so a stop is an AbortController abort and this is
 * the reason object. The runner compares thrown values against the exact instance it
 * created for that run: an AbortError from an unrelated timeout is a genuine failure,
 * not a cancellation, and must not be mistaken for one.
 */
class StopRequested extends Error {
  constructor(processName) {
    super(PREFIX + "Process '" + processName + "' was asked to stop");
    this.name = 'StopRequested';
  }
}

module.exports = { PREFIX, SynapsysConfigError, SynapsysError, StopRequested };
