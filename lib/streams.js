'use strict';

/**
 * Pristine handles on the real console streams.
 *
 * The library's own logger writes through these rather than through
 * process.stdout.write, for two reasons. Console capture patches that method, so a
 * library log line emitted from inside a running process's async context would
 * otherwise be captured and shipped to Core as if the user had printed it. And a
 * logger that wrote through its own tee could recurse.
 */
let saved = null;

function save(out, err) {
  if (saved === null) saved = { out: out, err: err };
}

function clear() {
  saved = null;
}

/** Writes straight to the real stream, bypassing any capture that is installed. */
function raw(source, text) {
  const stream = source === 'stderr' ? process.stderr : process.stdout;
  const write = saved
    ? (source === 'stderr' ? saved.err : saved.out)
    : stream.write;
  try {
    write.call(stream, text);
  } catch (_) {
    // A closed or broken stdout must never take the application down with it.
  }
}

module.exports = { save, clear, raw };
