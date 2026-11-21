"""评估用的纯函数：读门槛文件、超额收益、日期区块自助法、同在场时间的随机持有、MAR、每条主张的判定。

不联网、不读行情，全部可以用合成数据手算核对（tests/test_evaluate.py）。
"""
from __future__ import annotations

import math
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

import numpy as np
import pandas as pd


# ---------- 门槛文件 ----------

class ConfigError(ValueError):
    pass


NUM = (int, float)
STRS = "list[str]"
PAIRS = "list[[str, str]]"
NUMS = "list[number]"
SCHEMA: dict[str, dict[str, object]] = {
    "freeze": {"commit": str, "eval_files": STRS},
    "sample": {"snapshot": str, "data_from": str, "first_decision": str, "decision_every": int,
               "min_history_years": NUM, "cost": NUM, "halves": PAIRS, "slices": "dict[str, [str, str]]"},
    "universe": {"A": STRS, "B_seed": STRS, "B_sectors": STRS, "C_min_cap": NUM, "exchanges": STRS,
                 "min_dollar_volume": NUM, "share_class_prefer": STRS, "D_candidates": STRS, "D_since": str,
                 "D_min_drop": NUM, "too_short": STRS},
    "bootstrap": {"level": NUM, "reps": int, "block_days": int, "seed": int, "min_points": int, "min_blocks": int},
    "verdict": {"holdout_min_ratio": NUM},
    "fullplan": {"max_position": NUM},
    "H1": {"horizon": int, "bull": STRS, "bear": STRS, "min_meaningful": NUM, "aux_horizons": NUMS},
    "H2": {"horizon": int, "up_types": STRS, "down_types": STRS, "min_meaningful": NUM},
    "H3": {"hold_types": STRS, "random_reps": int, "mdd_pctl": NUM, "ticker_share": NUM, "naive_ma": NUMS, "seed": int,
           "min_tickers": int},
    "H4": {"buckets": NUMS, "min_rate": NUM, "min_gap": NUM, "min_meaningful": NUM, "min_events": int},
    "H5": {"breakout_pct": NUM, "max_wait": int, "merge_gap": int, "min_diff": NUM, "min_episodes": int,
           "min_meaningful": NUM},
    "H6": {"horizon": int, "transitions": STRS, "down_types": STRS, "stage": str, "min_meaningful": NUM},
}


def _check(where: str, value: object, want: object) -> None:
    def bad() -> ConfigError:
        return ConfigError(f"{where}：要 {want if isinstance(want, str) else getattr(want, '__name__', want)}，"
                           f"拿到 {value!r}")
    if want == STRS:
        if not (isinstance(value, list) and value and all(isinstance(x, str) for x in value)):
            raise bad()
    elif want == NUMS:
        if not (isinstance(value, list) and value and all(isinstance(x, NUM) and not isinstance(x, bool) for x in value)):
            raise bad()
    elif want == PAIRS:
        if not (isinstance(value, list) and value and all(isinstance(p, list) and len(p) == 2 for p in value)):
            raise bad()
    elif isinstance(want, str) and want.startswith("dict"):
        if not (isinstance(value, dict) and value and all(isinstance(p, list) and len(p) == 2 for p in value.values())):
            raise bad()
    elif want is NUM:
        if isinstance(value, bool) or not isinstance(value, NUM):
            raise bad()
    elif want is int:
        if isinstance(value, bool) or not isinstance(value, int):
            raise bad()
    elif not isinstance(value, want):  # type: ignore[arg-type]
        raise bad()


def load_config(path: Path) -> dict:
    """读 evaluation.toml。缺键、多键、类型不对、比例不在 (0, 1] 都直接报错，不带默认值。"""
    try:
        cfg = tomllib.loads(Path(path).read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as exc:
        raise ConfigError(f"{path}：TOML 语法错误：{exc}") from None
    for sec, keys in SCHEMA.items():
        if sec not in cfg:
            raise ConfigError(f"{path}：缺 [{sec}]")
        extra = set(cfg[sec]) - set(keys)
        if extra:
            raise ConfigError(f"{path}：[{sec}] 有不认识的键 {sorted(extra)}")
        for key, want in keys.items():
            if key not in cfg[sec]:
                raise ConfigError(f"{path}：[{sec}] 缺 {key}")
            _check(f"{path}：[{sec}].{key}", cfg[sec][key], want)
    extra = set(cfg) - set(SCHEMA)
    if extra:
        raise ConfigError(f"{path}：不认识的段 {sorted(extra)}")
    for where, v in (("bootstrap.level", cfg["bootstrap"]["level"]), ("H3.mdd_pctl", cfg["H3"]["mdd_pctl"]),
                     ("H3.ticker_share", cfg["H3"]["ticker_share"]), ("H4.min_rate", cfg["H4"]["min_rate"]),
                     ("verdict.holdout_min_ratio", cfg["verdict"]["holdout_min_ratio"]),
                     ("fullplan.max_position", cfg["fullplan"]["max_position"])):
        if not 0 < v <= 1:
            raise ConfigError(f"{path}：{where} 要在 (0, 1]，拿到 {v}")
    return cfg


# ---------- 超额收益、区块自助法 ----------

def excess(values: Sequence[float], keys: Sequence[str]) -> np.ndarray:
    """每个值减去同一个键（同一只票）所有值的平均：扣掉"这只票本来就一直涨"的部分。"""
    s = pd.Series(np.asarray(values, dtype=float))
    return (s - s.groupby(np.asarray(keys)).transform("mean")).to_numpy()


def block_ids(dates: Sequence[str], calendar: Sequence[str], block_days: int) -> np.ndarray:
    """日期在交易日历里的位置 // block_days：同一区块的点一起重抽。"""
    cal = np.asarray(calendar)
    pos = np.searchsorted(cal, np.asarray(dates))
    if len(dates) and (pos >= len(cal)).any():
        raise ValueError("有日期不在交易日历里")
    return pos // block_days


@dataclass(frozen=True)
class Est:
    point: float
    lo: float | None
    hi: float | None
    n: int
    blocks: int

    def excludes_zero(self, sign: int) -> bool:
        return self.lo is not None and (self.lo > 0 if sign > 0 else self.hi < 0)

    def crosses_zero(self) -> bool:
        return self.lo is None or self.lo <= 0 <= self.hi


def boot(groups: list[tuple[Sequence[float], Sequence[int]]], combine: Callable[..., np.ndarray],
         reps: int, level: float, seed: int) -> Est:
    """区块自助法：所有组共用同一次区块重抽（同一天的点一起进出），每组算均值，再用 combine 合成统计量。

    某次重抽里某组一个点都没有，那一次作废（不计入分位数）。
    """
    vals = [np.asarray(v, dtype=float) for v, _ in groups]
    blks = [np.asarray(b) for _, b in groups]
    n = sum(len(v) for v in vals)
    if any(len(v) == 0 for v in vals):
        return Est(float("nan"), None, None, n, 0)
    uniq = np.unique(np.concatenate(blks))
    point = float(combine(*[np.array([v.mean()]) for v in vals])[0])
    if len(uniq) < 2:
        return Est(point, None, None, n, len(uniq))
    w = np.random.default_rng(seed).multinomial(len(uniq), np.full(len(uniq), 1 / len(uniq)), size=reps)
    means = []
    for v, b in zip(vals, blks):
        idx = np.searchsorted(uniq, b)
        s = np.bincount(idx, weights=v, minlength=len(uniq))
        c = np.bincount(idx, minlength=len(uniq)).astype(float)
        with np.errstate(invalid="ignore", divide="ignore"):
            means.append((w @ s) / (w @ c))
    stat = combine(*means)
    stat = stat[np.isfinite(stat)]
    lo, hi = np.percentile(stat, [(1 - level) / 2 * 100, (1 + level) / 2 * 100])
    return Est(point, float(lo), float(hi), n, len(uniq))


def mean_est(values, blocks, bc: dict) -> Est:
    return boot([(values, blocks)], lambda m: m, bc["reps"], bc["level"], bc["seed"])


def diff_est(a, blocks_a, b, blocks_b, bc: dict) -> Est:
    return boot([(a, blocks_a), (b, blocks_b)], lambda x, y: x - y, bc["reps"], bc["level"], bc["seed"])


# ---------- 资金曲线：持仓掩码 ----------
# held[k] 对应第 start+1+k 根收盘时有没有仓位。决定在前一天收盘，成交在当天开盘（和 trades.simulate 一样）。

def held_from_trades(trades, start: int, end: int) -> np.ndarray:
    """trades.Trade 列表 → 掩码。离场日（开盘卖）收盘时没有仓位；未平仓的最后一根算有仓位。"""
    held = np.zeros(end - start, dtype=bool)
    for t in trades:
        last = t.exit_i if t.reason == "未平仓" else t.exit_i - 1
        held[t.entry_i - start - 1:last - start] = True
    return held


def equity(o: np.ndarray, c: np.ndarray, held: np.ndarray, start: int, cost: float) -> np.ndarray:
    """逐日盯市的资金曲线，从第 start 根收盘的 1 开始，等于 trades.curve（测试断言）。"""
    end = start + len(held)
    oo, cc, cp = o[start + 1:end + 1], c[start + 1:end + 1], c[start:end]
    prev = np.concatenate([[False], held[:-1]])
    entry = held & ~prev
    leave = ~held & prev
    r = np.zeros(len(held))
    r[held] = cc[held] / cp[held] - 1
    r[entry] = cc[entry] / (oo[entry] * (1 + cost)) - 1
    r[leave] = oo[leave] * (1 - cost) / cp[leave] - 1
    if len(held) and held[-1]:
        r[-1] = (1 + r[-1]) * (1 - cost) - 1        # 样本结束时还拿着：按最后收盘价卖，扣卖出成本
    return np.cumprod(1 + r)


def max_drawdown(eq: np.ndarray) -> float:
    """和 trades.max_drawdown 一样：峰值从 1 起算。"""
    if not len(eq):
        return 0.0
    peak = np.maximum(np.maximum.accumulate(eq), 1.0)
    return float((eq / peak - 1).min())


def mar(eq: np.ndarray, days_per_year: int = 252) -> float:
    """年化收益 / |最大回撤|。没有回撤（从没下过水）时为 nan。"""
    mdd = max_drawdown(eq)
    if not len(eq) or mdd == 0:
        return float("nan")
    cagr = eq[-1] ** (days_per_year / len(eq)) - 1
    return float(cagr / abs(mdd))


def random_held(held: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """同在场时间的随机持有：每段持仓的长度不变（打乱次序），随机放到别的位置，段与段之间至少空一天。

    在场天数和交易笔数都和原来一样，所以成本也一样，只有"在哪些天在场"是随机的。
    """
    n = len(held)
    edges = np.flatnonzero(np.diff(np.concatenate([[0], held.astype(int), [0]])))
    runs = edges[1::2] - edges[::2]
    k = len(runs)
    if k == 0:
        return np.zeros(n, dtype=bool)
    free = n - runs.sum() - (k - 1)
    bars = np.sort(rng.choice(free + k, k, replace=False))
    gaps = np.diff(np.concatenate([[-1], bars, [free + k]])) - 1
    gaps[1:-1] += 1
    lengths = np.empty(2 * k + 1, dtype=int)
    lengths[0::2], lengths[1::2] = gaps, rng.permutation(runs)
    flags = np.zeros(2 * k + 1, dtype=bool)
    flags[1::2] = True
    return np.repeat(flags, lengths)


@dataclass(frozen=True)
class HoldResult:
    mdd: float
    mar: float
    exposure: float
    pctl_better: float        # 随机持有里回撤比它深的比例（打平算一半）
    rand_mdd_median: float
    rand_mar_median: float
    passed: bool              # 回撤优于随机的 mdd_pctl 分位，且 MAR 高于随机中位数


def vs_random(o: np.ndarray, c: np.ndarray, held: np.ndarray, start: int, cost: float, reps: int, seed: int,
              mdd_pctl: float) -> HoldResult:
    eq = equity(o, c, held, start, cost)
    mdd, m = max_drawdown(eq), mar(eq)
    rng = np.random.default_rng(seed)
    rmdd, rmar = np.empty(reps), np.empty(reps)
    for k in range(reps):
        e = equity(o, c, random_held(held, rng), start, cost)
        rmdd[k], rmar[k] = max_drawdown(e), mar(e)
    better = float(((rmdd < mdd).sum() + 0.5 * (rmdd == mdd).sum()) / reps)
    med_mar = float(np.nanmedian(rmar)) if np.isfinite(rmar).any() else float("nan")
    passed = bool(better >= mdd_pctl and np.isfinite(m) and np.isfinite(med_mar) and m > med_mar)
    return HoldResult(mdd, m, float(held.mean()) if len(held) else 0.0, better, float(np.median(rmdd)), med_mar, passed)


# ---------- 判定 ----------
# 结论只有这几种。"开发集通过" 只在还没跑验证集时出现。

USEFUL, USELESS, UNSURE, FEW = "有用", "无用", "不确定", "样本不足"
DEV_PASSED = "开发集通过，待验证集"


def only_in(group: str) -> str:
    return f"只在 {group} 组成立"


def enough(e: Est, bc: dict) -> bool:
    return e.n >= bc["min_points"] and e.blocks >= bc["min_blocks"]


def verdict_effect(sign: int, dev: Est, halves: list[Est], a: Est, bc_group: Est, holdout: Est | None,
                   min_meaningful: float, holdout_ratio: float, extra_ok: bool = True, sample_ok: bool = True) -> str:
    """均值类主张（H1、H2、H4 的两档差、H5、H6）的统一判定，第 3 节的四件事：

    1. 开发集主指标 90% 区间不跨 0，方向和主张一致（extra_ok：各条另加的门槛，如 H4 的 90%）；
    2. 开发集前后两半方向一致；
    3. A 组和 B+C 组方向一致，只有一组对得上就是"只在 X 组成立"；
    4. 验证集方向一致，点估计至少是开发集的 holdout_ratio 倍。
    "无用"：开发集区间跨 0，且点估计小于有意义的最小值。其余都是"不确定"。
    """
    if not sample_ok:
        return FEW
    if not (dev.excludes_zero(sign) and extra_ok):
        return USELESS if dev.crosses_zero() and abs(dev.point) < min_meaningful else UNSURE
    if not all(math.isfinite(h.point) and h.point * sign > 0 for h in halves):
        return UNSURE
    ga, gb = a.point * sign > 0, bc_group.point * sign > 0
    if ga != gb:
        return only_in("A" if ga else "B+C")
    if not ga:
        return UNSURE
    if holdout is None:
        return DEV_PASSED
    ok = holdout.point * sign > 0 and abs(holdout.point) >= holdout_ratio * abs(dev.point)
    return USEFUL if ok else UNSURE


@dataclass(frozen=True)
class H3Summary:
    tickers: int
    share_passed: float       # 通过的品种占比（主指标）
    median_pctl: float        # 回撤优于随机持有的分位，品种中位数
    median_mar_edge: float    # MAR − 随机持有 MAR 中位数，品种中位数

    @property
    def direction(self) -> bool:
        """"方向一致"：一半以上的品种回撤比随机持有的中位数浅，MAR 也比随机持有高。"""
        return self.median_pctl > 0.5 and self.median_mar_edge > 0


def summarize_h3(results: list[HoldResult]) -> H3Summary:
    if not results:
        return H3Summary(0, float("nan"), float("nan"), float("nan"))
    edges = [r.mar - r.rand_mar_median for r in results if math.isfinite(r.mar) and math.isfinite(r.rand_mar_median)]
    return H3Summary(len(results), sum(r.passed for r in results) / len(results),
                     float(np.median([r.pctl_better for r in results])),
                     float(np.median(edges)) if edges else float("nan"))


def verdict_h3(dev: H3Summary, halves: list[H3Summary], a: H3Summary, bc_group: H3Summary,
               holdout: H3Summary | None, ticker_share: float, min_tickers: int) -> str:
    """H3：开发集至少 ticker_share 的品种通过；两半、两组、验证集都要"方向一致"（H3Summary.direction）。
    "无用"：开发集方向都不一致（随机持有的中位数就比它好）。"""
    if dev.tickers < min_tickers:
        return FEW
    if dev.share_passed < ticker_share:
        return USELESS if not dev.direction else UNSURE
    if not all(h.direction for h in halves if h.tickers):
        return UNSURE
    if a.direction != bc_group.direction:
        return only_in("A" if a.direction else "B+C")
    if not a.direction:
        return UNSURE
    if holdout is None:
        return DEV_PASSED
    return USEFUL if holdout.direction else UNSURE
