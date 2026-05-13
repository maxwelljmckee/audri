// Automations primitive utilities. Shared between server (when
// inserting/updating recurring rows) and worker (when dispatching
// due rows + recomputing next_run_at after each fire).

export {
  computeNextRunAt,
  stableJitterOffsetMs,
  type JitterIdentity,
  type ScheduleSpec,
} from './schedule.js';
