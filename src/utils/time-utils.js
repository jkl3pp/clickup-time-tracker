/**
 * Shared time utilities for computing and formatting totals
 * Keep logic consistent between Personal and Team views.
 */

/**
 * Compute total minutes for a list of events.
 * If a date is provided, only events whose start date matches are included.
 *
 * @param {Array<{start: Date|string|number, end: Date|string|number}>} events
 * @param {Date} [date]
 * @returns {number}
 */
export function computeTotalMinutes(events, date) {
  if (!Array.isArray(events) || events.length === 0) return 0;

  const sameDay = (d1, d2) => new Date(d1).getDate() === new Date(d2).getDate()
    && new Date(d1).getMonth() === new Date(d2).getMonth()
    && new Date(d1).getFullYear() === new Date(d2).getFullYear();

  const filtered = typeof date === 'undefined'
    ? events
    : events.filter(e => sameDay(e.start, date));

  return filtered.reduce((carry, event) => {
    const startTimestamp = new Date(event.start).getTime();
    const endTimestamp = new Date(event.end).getTime();
    const durationMinutes = Math.max(0, (endTimestamp - startTimestamp) / 60000);
    return carry + durationMinutes;
  }, 0);
}

/**
 * Format total minutes as HH:mm. Returns undefined when total is 0
 * to allow conditional display like in Personal view.
 *
 * @param {number} totalMinutes
 * @returns {string|undefined}
 */
export function formatHHmm(totalMinutes) {
  if (!totalMinutes) return undefined;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = Math.floor(totalMinutes % 60);
  return `${hours}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Equivalent API to the Personal view helper: totalHoursOnDate(events, date?)
 * Returns a string HH:mm or undefined when 0.
 *
 * @param {Array} events
 * @param {Date} [date]
 * @returns {string|undefined}
 */
export function totalHoursOnDate(events, date) {
  return formatHHmm(computeTotalMinutes(events, date));
}

/**
 * Format a duration in milliseconds as "HHhMMm".
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours >= 1 ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}m`;
}

/**
 * Check if there is at least one event tracked on a given date
 *
 * @param {Date} date
 * @param {Array} events
 * @returns {boolean}
 */
export function hasTimeTrackedOn(date, events) {
  if (!Array.isArray(events)) return false;
  const d = new Date(date);
  return Boolean(events.find(event => {
    const s = new Date(event.start);
    return s.getDate() === d.getDate() && s.getMonth() === d.getMonth() && s.getFullYear() === d.getFullYear();
  }));
}
