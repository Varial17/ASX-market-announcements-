/**
 * Everything is stored as ISO 8601 UTC. Market hours, and only market hours,
 * are reckoned in Australia/Sydney — which is why this module exists rather
 * than a hardcoded +10/+11 offset. Sydney observes DST.
 */

export const MARKET_TZ = 'Australia/Sydney';

/** 07:00 inclusive. */
export const MARKET_OPEN_HOUR = 7;
/** 20:00 exclusive — the last poll of the day starts at 19:59. */
export const MARKET_CLOSE_HOUR = 20;

export interface SydneyParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday ... 6 = Saturday. */
  weekday: number;
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: MARKET_TZ,
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  // h23 rather than hour12:false — the latter renders midnight as "24" under
  // some ICU builds, which would silently break the open/close comparison.
  hourCycle: 'h23',
});

export function sydneyParts(at: Date): SydneyParts {
  const parts = partsFormatter.formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find((p) => p.type === type);
    if (!found) throw new Error(`Intl did not return a "${type}" part`);
    return found.value;
  };
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: WEEKDAYS[get('weekday')] ?? -1,
  };
}

/**
 * Mon-Fri, 07:00-20:00 Australia/Sydney. Be a good citizen: the poller does
 * nothing outside this window, so we never hit the source overnight or on
 * weekends.
 *
 * Note this does not know about ASX public holidays. Polling on Australia Day
 * costs one wasted request a minute and returns the previous day's list, which
 * dedupes to zero inserts — not worth a holiday calendar in v1.
 */
export function isMarketWindow(at: Date): boolean {
  const { weekday, hour } = sydneyParts(at);
  if (weekday < 1 || weekday > 5) return false;
  return hour >= MARKET_OPEN_HOUR && hour < MARKET_CLOSE_HOUR;
}

/** "12 Aug, 3:14pm" in Sydney time — the format the feed rows use. */
const listFormatter = new Intl.DateTimeFormat('en-AU', {
  timeZone: MARKET_TZ,
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

export function formatSydney(iso: string): string {
  return listFormatter.format(new Date(iso));
}
