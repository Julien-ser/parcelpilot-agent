/**
 * Time handling for the ParcelPilot agent.
 *
 * Every timestamp in the supplied workbook is a naive wall-clock string in the
 * dataset's timezone (Asia/Kolkata, per the README sheet). Because they all share
 * one timezone, we parse them as UTC and do arithmetic in that frame: differences
 * are exact, and we re-label as IST on the way out. This avoids pulling in a
 * timezone library for a dataset that never crosses a zone.
 *
 * The business calendar matters more than it looks. The dataset snapshot
 * (2026-08-16 11:00) falls on a SUNDAY, and the LumenWorks agreement states
 * "No weekend or after-hours support coverage" - so a business-hours SLA clock
 * has not started at all for that account, while a 24x7 clock has been running
 * the whole time.
 */

/** Business calendar assumptions. Stated explicitly so they can be audited. */
export const CALENDAR = {
  /** 1 = Monday ... 5 = Friday. Saturday/Sunday are non-working. */
  workdays: [1, 2, 3, 4, 5],
  /** Working day runs 09:00-18:00 local time (9 hours). */
  startHour: 9,
  endHour: 18,
  /** Public holidays are not modelled - see the architecture note. */
  holidays: [] as string[],
} as const;

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

/** Parse "2026-08-16 11:00" or ISO-ish variants into epoch ms (IST frame). */
export function parseIst(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = String(value)
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, s ? +s : 0);
}

/** Render epoch ms back as an IST wall-clock string. */
export function formatIst(ms: number, withTz = true): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const base =
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return withTz ? `${base} IST` : base;
}

/** Human-readable duration, e.g. "2h 30m" or "45m". */
export function humanDuration(ms: number): string {
  const abs = Math.abs(ms);
  const totalMinutes = Math.round(abs / MINUTE);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(" ");
}

function dayOfWeek(ms: number): number {
  return new Date(ms).getUTCDay(); // 0 = Sunday
}

function dateKey(ms: number): string {
  return formatIst(ms, false).slice(0, 10);
}

export function isWorkingDay(ms: number): boolean {
  const dow = dayOfWeek(ms);
  if (!(CALENDAR.workdays as readonly number[]).includes(dow)) return false;
  return !CALENDAR.holidays.includes(dateKey(ms));
}

export function isWeekend(ms: number): boolean {
  const dow = dayOfWeek(ms);
  return dow === 0 || dow === 6;
}

function startOfDay(ms: number, hour: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, 0, 0);
}

/** Move to the next instant that is inside working hours (or stay put if already inside). */
export function nextWorkingInstant(ms: number): number {
  let cursor = ms;
  for (let guard = 0; guard < 400; guard++) {
    if (!isWorkingDay(cursor)) {
      cursor = startOfDay(cursor + 24 * HOUR, CALENDAR.startHour);
      continue;
    }
    const open = startOfDay(cursor, CALENDAR.startHour);
    const close = startOfDay(cursor, CALENDAR.endHour);
    if (cursor < open) return open;
    if (cursor >= close) {
      cursor = startOfDay(cursor + 24 * HOUR, CALENDAR.startHour);
      continue;
    }
    return cursor;
  }
  return cursor;
}

/** Business milliseconds elapsed between two instants (working days/hours only). */
export function businessMsBetween(from: number, to: number): number {
  if (to <= from) return 0;
  let total = 0;
  let cursor = from;
  for (let guard = 0; guard < 400 && cursor < to; guard++) {
    if (!isWorkingDay(cursor)) {
      cursor = startOfDay(cursor + 24 * HOUR, CALENDAR.startHour);
      continue;
    }
    const open = startOfDay(cursor, CALENDAR.startHour);
    const close = startOfDay(cursor, CALENDAR.endHour);
    const segStart = Math.max(cursor, open);
    const segEnd = Math.min(to, close);
    if (segEnd > segStart) total += segEnd - segStart;
    cursor = startOfDay(cursor + 24 * HOUR, CALENDAR.startHour);
  }
  return total;
}

/** Add business milliseconds to an instant, skipping nights and weekends. */
export function addBusinessMs(from: number, amount: number): number {
  let remaining = amount;
  let cursor = nextWorkingInstant(from);
  for (let guard = 0; guard < 400 && remaining > 0; guard++) {
    const close = startOfDay(cursor, CALENDAR.endHour);
    const available = close - cursor;
    if (available >= remaining) return cursor + remaining;
    remaining -= available;
    cursor = nextWorkingInstant(startOfDay(cursor + 24 * HOUR, CALENDAR.startHour));
  }
  return cursor;
}

/**
 * Add N business days. "1 business day" is treated as the end of the next
 * working day, which is the reading that matches how support teams quote it.
 */
export function addBusinessDays(from: number, days: number): number {
  let cursor = from;
  let remaining = days;
  for (let guard = 0; guard < 400 && remaining > 0; guard++) {
    cursor = startOfDay(cursor + 24 * HOUR, CALENDAR.startHour);
    if (isWorkingDay(cursor)) remaining -= 1;
  }
  return startOfDay(cursor, CALENDAR.endHour);
}
