"""K 线的颜色从哪来：自带规则，或本机的着色插件。图表数据只从 bar_tones 拿颜色。

自带规则（builtin_tones）是 LEI 黑绿线指标第一个因子的简化版，只看 MA20 的破线和拐头。
想换一套自己的规则，写一个着色插件放在本机，不用改仓库里的代码。

着色插件是一个 Python 文件，暴露三样：

    NAME: str                                  # 图例里显示的名字
    LEGEND: list[str]                          # 图例的几行说明
    def tones(df: pd.DataFrame) -> pd.Series   # 每根 K 线的颜色

df 是算好均线的 K 线（日线图给日线，周线图给周线），至少有 Open High Low Close Volume，索引是日期。
tones 返回的 Series 索引要和 df.index 相同，值是 "bull"、"bear"、"mixed" 或空值，空值表示这根不上色。
df 是副本，插件改它不影响图表。

插件在哪，按这个顺序找，找到第一个为止：

1. 环境变量 DMA_TONE_PLUGIN。
2. 仓库根目录 .env 里的 DMA_TONE_PLUGIN。
3. 仓库根目录下的 private/tone_plugin.py，文件存在就用。

DMA_TONE_PLUGIN 的值是插件文件的路径，相对路径从仓库根目录算起；空字符串表示不用插件。

插件出错（文件不存在、导入抛异常、缺 NAME / LEGEND / tones、tones 抛异常、返回值对不上）时退回自带规则，
原因写在 ToneSource.warning 里，同时打到 stderr。分析不会因为着色插件失败。

练习、识别题和网页报告只用自带规则（builtin_only=True），不找插件：题目和答案在每台机器上一样。
"""
from __future__ import annotations

import importlib.util
import os
import sys
from dataclasses import dataclass, replace
from importlib.machinery import SourceFileLoader
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[4]
ENV_VAR = "DMA_TONE_PLUGIN"
DEFAULT_PLUGIN = Path("private/tone_plugin.py")
TONES = ("bull", "bear", "mixed")


@dataclass(frozen=True)
class ToneSource:
    """这份颜色是谁算的。"""
    key: str                      # "builtin" 或 "plugin"
    name: str                     # 图例里显示的名字
    legend: list[str]             # 图例的几行说明
    warning: str | None = None    # 插件出错退回自带规则时的原因


BUILTIN = ToneSource(key="builtin", name="破线拐头信号着色", legend=[
    "按 20 线有没有破线拐头给 K 线上色",
    "绿：收盘在 MA20 上方，且高于 20 日抵扣价（MA20 向上）",
    "黑：两样都不满足（MA20 向下）。第一根黑柱就是破线拐头信号",
    "灰：只满足一样，过渡状态",
    "这是 LEI 黑绿线指标第一个因子的简化版，只看 MA20 破线和拐头；不是他的黑绿线（他还看 60 线组、20/60 交叉和 MACD 强度，代码没公开）",
    "怎么读（视频 P）：多头排列里绿 = 持有 / 做多，黑 = 离场；空头排列里见绿也不做多；灰 = 不动",
    "三点钟方向的横盘里颜色会来回翻，别跟着翻来翻去地交易",
])


def builtin_tones(df: pd.DataFrame) -> pd.Series:
    """破线拐头着色：收盘 >= 20 日抵扣价（MA20 不降）且 >= MA20 为 bull，两样都不满足为 bear，只满足一样为 mixed。"""
    close = df["Close"]
    drop = close.shift(20)
    above_drop = close >= drop
    above_ma = close >= df["MA20"]
    tone = pd.Series("mixed", index=df.index, dtype=object)
    tone[above_drop & above_ma] = "bull"
    tone[~above_drop & ~above_ma] = "bear"
    return tone.where(drop.notna() & df["MA20"].notna())


class PluginError(Exception):
    """着色插件用不了的原因。"""


def _dotenv_value(path: Path, name: str) -> str | None:
    """.env 里 name 的值；文件不存在或没有这一行返回 None。"""
    if not path.is_file():
        return None
    for line in path.read_text(encoding="utf-8").splitlines():
        key, sep, value = line.strip().removeprefix("export ").partition("=")
        if sep and key.strip() == name:
            return value.strip().strip("'\"")
    return None


def plugin_path() -> Path | None:
    """本机配的着色插件文件（不保证存在）；没配返回 None。查找顺序见模块说明。"""
    value = os.environ.get(ENV_VAR)
    if value is None:
        value = _dotenv_value(ROOT / ".env", ENV_VAR)
    if value is None:
        default = ROOT / DEFAULT_PLUGIN
        return default if default.is_file() else None
    return ROOT / Path(value.strip()).expanduser() if value.strip() else None


def _plugin_tones(path: Path, df: pd.DataFrame) -> tuple[pd.Series, ToneSource]:
    if not path.is_file():
        raise PluginError("文件不存在")
    spec = importlib.util.spec_from_file_location("dma_tone_plugin", path, loader=SourceFileLoader("dma_tone_plugin", str(path)))
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as e:
        raise PluginError(f"导入出错（{type(e).__name__}: {e}）") from e
    name, legend, fn = (getattr(module, k, None) for k in ("NAME", "LEGEND", "tones"))
    if not isinstance(name, str) or not name:
        raise PluginError("缺少 NAME（图例里显示的名字，字符串）")
    if not isinstance(legend, list) or not all(isinstance(line, str) for line in legend):
        raise PluginError("缺少 LEGEND（图例的几行说明，字符串列表）")
    if not callable(fn):
        raise PluginError("缺少 tones(df) 函数")
    try:
        tone = fn(df.copy())
    except Exception as e:
        raise PluginError(f"tones() 出错（{type(e).__name__}: {e}）") from e
    if not isinstance(tone, pd.Series):
        raise PluginError(f"tones() 要返回 pandas.Series，实际是 {type(tone).__name__}")
    if not tone.index.equals(df.index):
        raise PluginError(f"tones() 返回的索引和 df.index 不一样（返回 {len(tone)} 行，K 线 {len(df)} 根）")
    unknown = sorted({repr(t) for t in tone[tone.notna()] if t not in TONES})
    if unknown:
        raise PluginError(f"tones() 的取值只能是 {' / '.join(TONES)} 或空值，实际有 {'、'.join(unknown[:5])}")
    return tone, ToneSource(key="plugin", name=name, legend=legend)


def bar_tones(df: pd.DataFrame, builtin_only: bool = False) -> tuple[pd.Series, ToneSource]:
    """每根 K 线的颜色（bull / bear / mixed，空值不上色）和它的来源。builtin_only：不找插件，只用自带规则。"""
    path = None if builtin_only else plugin_path()
    if path is None:
        return builtin_tones(df), BUILTIN
    try:
        return _plugin_tones(path, df)
    except PluginError as e:
        warning = f"着色插件 {path} 没用上，退回自带规则：{e}"
        print(warning, file=sys.stderr)
        return builtin_tones(df), replace(BUILTIN, warning=warning)
