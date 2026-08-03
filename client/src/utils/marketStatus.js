// NSE regular trading session: Mon–Fri, 09:15–15:30 IST.
// (Doesn't account for exchange holidays — that needs a holiday calendar,
// which is a natural addition to the future-ready `features/` scanner/alerts work.)
const MARKET_OPEN_MINUTES = 9 * 60 + 15;
const MARKET_CLOSE_MINUTES = 15 * 60 + 30;

/**
 * Returns the current time-of-day in IST, independent of the browser's
 * local timezone, using Intl so it works correctly for any visitor.
 */
function getIstParts() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const hour = Number(map.hour) % 24;
  const minute = Number(map.minute);
  return { weekday: map.weekday, minutesSinceMidnight: hour * 60 + minute };
}

export function getMarketStatus() {
  const { weekday, minutesSinceMidnight } = getIstParts();
  const isWeekday = !['Sat', 'Sun'].includes(weekday);
  const isWithinSession = minutesSinceMidnight >= MARKET_OPEN_MINUTES && minutesSinceMidnight < MARKET_CLOSE_MINUTES;

  return {
    isOpen: isWeekday && isWithinSession,
    label: isWeekday && isWithinSession ? 'Market Open' : 'Market Closed',
  };
}
