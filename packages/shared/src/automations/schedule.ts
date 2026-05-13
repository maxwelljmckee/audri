// Schedule utilities for recurring_agent_tasks.
//
// Two public entry points:
//   - `computeNextRunAt(...)` — given a schedule definition + a "from"
//     timestamp, returns the next UTC time the automation should fire
//     (or null if the schedule never fires from `from`).
//   - `stableJitterOffsetMs(...)` — deterministic per-(user+automation)
//     offset within the jitter window, so load spreads across the
//     service.
//
// Schedule semantics:
//   - times: array of "HH:MM" strings in `timezone`-local time.
//   - daysOfWeek: array of integers 0-6 (postgres extract(dow), 0=Sun).
//     Empty → every day.
//   - jitter: stable per-(user_id, recurring_task_id) offset within
//     `jitterMinutes` window. So user A's "5am daily" fires at e.g.
//     05:17 every time; user B's at 05:42 every time.
//
// Pure functions — no DB, no Date.now() side effects beyond what's
// passed in. Easy to test.

export interface ScheduleSpec {
  daysOfWeek: number[]; // 0-6 (Sun-Sat). Empty = every day.
  times: string[]; // "HH:MM" strings
  timezone: string; // IANA tz, e.g. 'America/New_York'
  jitterMinutes: number;
}

export interface JitterIdentity {
  userId: string;
  recurringTaskId: string;
}

const HHMM = /^(\d{2}):(\d{2})$/;

function parseHHMM(s: string): { h: number; m: number } | null {
  const match = HHMM.exec(s);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

// djb2 — small stable hash. Used for jitter offset; cryptographic
// quality not needed. Same (userId, recurringTaskId) input always
// produces the same offset, so a given automation always fires at
// the same jittered time, while different automations spread out.
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  // Force non-negative.
  return h >>> 0;
}

export function stableJitterOffsetMs(
  identity: JitterIdentity,
  jitterMinutes: number,
): number {
  if (jitterMinutes <= 0) return 0;
  const hash = djb2(`${identity.userId}|${identity.recurringTaskId}`);
  const offsetMinutes = hash % jitterMinutes;
  return offsetMinutes * 60 * 1000;
}

// Given a YYYY-MM-DD date string + HH:MM time + IANA timezone, return
// the corresponding UTC Date. We construct an ISO string in the target
// timezone, then use the JS Date constructor with an offset-style
// trick: parse using Intl.DateTimeFormat to compute the timezone's
// offset for that local time, then adjust.
function utcFromLocal(
  dateYmd: string,
  timeHm: string,
  timezone: string,
): Date {
  // Approach: construct a UTC date with the local Y-M-D-H-M components,
  // then ask Intl what UTC time corresponds to that local time in tz.
  // We iterate up to twice to handle DST boundary cases.
  const naiveIso = `${dateYmd}T${timeHm}:00.000Z`;
  let utc = new Date(naiveIso);
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(utc);
    const tzY = parts.find((p) => p.type === 'year')?.value;
    const tzMo = parts.find((p) => p.type === 'month')?.value;
    const tzD = parts.find((p) => p.type === 'day')?.value;
    let tzH = parts.find((p) => p.type === 'hour')?.value;
    const tzMi = parts.find((p) => p.type === 'minute')?.value;
    // Intl returns '24' for midnight under some locales; normalize.
    if (tzH === '24') tzH = '00';
    const tzAsIso = `${tzY}-${tzMo}-${tzD}T${tzH}:${tzMi}:00.000Z`;
    const tzDate = new Date(tzAsIso);
    const drift = utc.getTime() - tzDate.getTime();
    if (drift === 0) break;
    utc = new Date(utc.getTime() + drift);
  }
  return utc;
}

function ymdFromDate(d: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const dd = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${dd}`;
}

function dowFromDate(d: Date, timezone: string): number {
  // 0=Sun .. 6=Sat. Intl.DateTimeFormat 'weekday' returns text; faster
  // to round-trip via the date's local date string then Date.getUTCDay
  // on a same-day UTC anchor.
  const ymd = ymdFromDate(d, timezone);
  return new Date(`${ymd}T12:00:00Z`).getUTCDay();
}

// Find the next time the schedule fires after `from`, returning a UTC
// Date or null. Walks day-by-day up to 14 days ahead (handles weekly
// cadences cleanly; if no fire found in 14 days, schedule is
// effectively dead — return null and let the caller decide).
//
// **Jitter direction: subtract, not add.** The user's mental model when
// configuring "5am Daily Brief" is "I want the brief by 5am" — not
// "start at 5am." Subtracting jitter means the actual fire window is
// [nominal - jitterMinutes, nominal], so the work has completed (or is
// in flight) by the nominal time. This is a stronger UX promise than
// add-jitter and applies cleanly to every kind in scope (briefs:
// ready-by-time; reminders: fired-by-time; dreams: overnight,
// direction doesn't matter perceptibly).
//
// Past-jittered-time clamp: if T_nominal is still in the future but
// T_jittered (= T_nominal - jitterOffset) is already < from (we're
// inside the jitter window), return `from` itself so the dispatcher
// fires ASAP rather than skipping the slot. Net effect: actual fire
// is in [max(T_nominal - jitterMinutes, from), T_nominal].
//
// "Past-deadline" handling: if T_nominal <= from, the slot is fully
// in the past — skip to the next valid (day, time). Dispatcher won't
// fire stale missed slots; user just misses that period.
export function computeNextRunAt(
  spec: ScheduleSpec,
  identity: JitterIdentity,
  from: Date = new Date(),
): Date | null {
  if (spec.times.length === 0) return null;

  const parsedTimes = spec.times.map(parseHHMM).filter((t): t is { h: number; m: number } => !!t);
  if (parsedTimes.length === 0) return null;

  const validDays = spec.daysOfWeek.length === 0 ? [0, 1, 2, 3, 4, 5, 6] : spec.daysOfWeek;

  const jitterMs = stableJitterOffsetMs(identity, spec.jitterMinutes);

  // Walk up to 14 days forward looking for the next valid (day, time)
  // whose nominal time is still in the future.
  for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
    const candidate = new Date(from.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const dow = dowFromDate(candidate, spec.timezone);
    if (!validDays.includes(dow)) continue;
    const ymd = ymdFromDate(candidate, spec.timezone);
    // Collect every nominal time on this day whose actual fire-window
    // hasn't fully passed. Sort by nominal, return earliest's jittered
    // (clamped to `from`).
    const fires: { nominal: Date; actual: Date }[] = [];
    for (const t of parsedTimes) {
      const hm = `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}`;
      const nominal = utcFromLocal(ymd, hm, spec.timezone);
      if (nominal.getTime() <= from.getTime()) continue; // fully past — skip
      const jitteredStart = new Date(nominal.getTime() - jitterMs);
      const actual = jitteredStart.getTime() < from.getTime() ? from : jitteredStart;
      fires.push({ nominal, actual });
    }
    if (fires.length > 0) {
      fires.sort((a, b) => a.nominal.getTime() - b.nominal.getTime());
      return fires[0]?.actual ?? null;
    }
  }
  return null;
}
