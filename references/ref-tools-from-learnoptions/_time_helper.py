"""Shared "today" anchor for DTE / option-expiry windows in theta Python sidecars.

期权到期日是美东(ET)日历日。用 UTC 日期当「今天」会在 ET 20:00–24:00(夏令时;
冬令时 19:00–24:00)之间提前翻到次日 → DTE 少算 1、expiration_date.gte/lte 窗口整体前移。
只给 DTE 与到期窗口用;as_of、缓存键等其它日期字段保持各脚本原有 UTC 惯例(不改口径)。
"""

from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")


def et_today(now: datetime | None = None) -> date:
    """ET 日历上的「今天」。now 为 tz-aware 时刻(selftest 注入用);缺省取当前时刻。"""
    if now is None:
        now = datetime.now(timezone.utc)
    if now.tzinfo is None:
        raise ValueError("et_today: now must be timezone-aware")
    return now.astimezone(ET).date()
