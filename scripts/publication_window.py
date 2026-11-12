"""Publication-date bounds for PubMed queries.

The upper bound is the calendar date in Asia/Shanghai. Between 00:00 and 08:00
Beijing time the UTC date is still the previous day; using that date as the
upper bound drops papers published on the Beijing date.
"""
import datetime

BEIJING = datetime.timezone(datetime.timedelta(hours=8))


def beijing_date(now):
    if now.tzinfo is None:
        raise ValueError('publication window requires a timezone')
    return now.astimezone(BEIJING).date()


def publication_bounds(now, days):
    """Return PubMed ``YYYY/MM/DD`` start and end. End is the Beijing calendar date."""
    if not isinstance(days, int) or isinstance(days, bool) or days < 0:
        raise ValueError('publication window days must be a non-negative int')
    end = beijing_date(now)
    start = end - datetime.timedelta(days=days)
    return start.strftime('%Y/%m/%d'), end.strftime('%Y/%m/%d')
