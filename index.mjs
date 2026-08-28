// ESM wrapper over the CommonJS implementation.
//
// The library is written in CommonJS and re-exported here rather than built twice.
// A fifteen-year-old CommonJS application can require() it with no build step, a
// modern one can import it, and because both entry points resolve to the same
// module instance there is no dual-package hazard: one copy of the state, one set
// of patched streams, one heartbeat.
import module from './index.js';

export const Synapsys = module.Synapsys;
export const StopSignal = module.StopSignal;
export const SynapsysConfigError = module.SynapsysConfigError;
export const SynapsysError = module.SynapsysError;
export const StopRequested = module.StopRequested;

export default module;
