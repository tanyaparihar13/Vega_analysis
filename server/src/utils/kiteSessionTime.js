/**
 * Kite access tokens are invalidated daily at ~07:30 IST, regardless of when
 * they were issued. 07:30 IST == 02:00 UTC.
 *
 * Everything here works in UTC deliberately. The previous implementation mixed
 * three timezone assumptions in one comparison:
 *   - MySQL CURDATE()      -> MySQL server timezone
 *   - + INTERVAL 7.5 HOUR  -> assumed IST
 *   - new Date("...")      -> Node process timezone (dateStrings: true)
 * Any of those differing by a few hours produced a row that claimed the session
 * was live long after Kite had killed it.
 */

const KITE_EXPIRY_UTC_HOUR = 2; // 07:30 IST
const KITE_EXPIRY_UTC_MINUTE = 0;

/**
 * The next moment Kite will invalidate a token issued at `now`.
 * If it is currently 07:00 IST, that is 30 minutes away — NOT tomorrow.
 */
function nextTokenExpiry(now = new Date()) {
  const expiry = new Date(now);
  expiry.setUTCHours(KITE_EXPIRY_UTC_HOUR, KITE_EXPIRY_UTC_MINUTE, 0, 0);
  if (expiry <= now) {
    expiry.setUTCDate(expiry.getUTCDate() + 1);
  }
  return expiry;
}

/** Formats a Date as a MySQL DATETIME string in UTC. */
function toMysqlUtc(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Parses a MySQL DATETIME string that we wrote in UTC.
 * `new Date("2026-07-24 07:30:00")` parses as process-local; appending 'Z'
 * forces UTC so the comparison is correct wherever Node happens to be running.
 */
function parseMysqlUtc(value) {
  if (value instanceof Date) return value;
  return new Date(`${String(value).replace(' ', 'T')}Z`);
}

/** True if a stored expiry has already passed. */
function isExpired(storedExpiry, now = new Date()) {
  return parseMysqlUtc(storedExpiry) <= now;
}

module.exports = { nextTokenExpiry, toMysqlUtc, parseMysqlUtc, isExpired };