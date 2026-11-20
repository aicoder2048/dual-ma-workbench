/**
 * 规则版报告：完全由脚本的分析结果生成，不经过 LLM。
 *
 * 两部分：
 * - visual：给前端画图用的结构化数据（均线状态、价位梯子、乖离分位、五步进度、周线和小时线、类型总表、
 *   门槛路径、持平情景和求解、规则清单）。都是脚本的输出，这里不重算。
 * - steps[].items：按 ASD-STE100 简明中文写的短句，一句一事，每句带引用。
 *
 * 类型总表读 SKILL.md 第 1 步那一张（唯一的一份），不在这里另写。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Analysis, HurdlePath, Lean, PairProgress, RuleResult, Scenario, Solve } from "./citations.ts";
import { buildOutlook, buildPlans, type Outlook, type Plan, type Situation } from "./plan.ts";
import { PROJECT_ROOT } from "./sources.ts";

export type Stance = "bullish" | "bearish" | "neutral";

export interface CrossInfo {
  kind: "金叉" | "死叉" | null;
  date: string | null;
  barsAgo: number | null;
}

export interface TypeRow { type: string; look: string; play: string; rules: string }

export interface ReportVisual {
  close: number;
  lean: Lean;
  trend: string;
  regime: Analysis["regime"];
  spread: number;
  lines: Analysis["lines"];
  bias: { value: number; pctl: number; extreme: number };
  crosses: { pair: string; ma: CrossInfo; ema: CrossInfo; verdict: string }[];
  steps: PairProgress[];
  weekly: Analysis["weekly"];
  hourly: Analysis["hourly"];
  trendTable: (TypeRow & { current: boolean })[];
  drops: Analysis["drops"];
  hurdles: HurdlePath[];
  scenario: Scenario;
  solves: Solve[];
  rules: RuleResult[];
  playRules: string[];
}

export interface ReportStep {
  key: "big_picture" | "strategy" | "direction" | "rules";
  title: string;
  subtitle: string;
  items: string[];
}

export interface Report {
  headline: string;
  stance: Stance;
  /** 第 1 步的结论：趋势类型和它长什么样。 */
  trend: { type: string; look: string };
  /** 第 2 步的输出：空仓、持仓（没填成本）、浮盈、浮亏各一份计划。 */
  plans: Record<Situation, Plan>;
  /** 第 3 步的输出：方向结论、最早何时会变、对你意味着什么。 */
  outlook: Outlook;
  steps: ReportStep[];
  visual: ReportVisual;
}

/** 立场跟模糊判断的档位走（档位是脚本按 LEAN_SOME 分的）。 */
export const stanceOf = (lean: Pick<Lean, "label">): Stance =>
  lean.label.includes("偏多") ? "bullish" : lean.label.includes("偏空") ? "bearish" : "neutral";

const SKILL_MD = resolve(PROJECT_ROOT, ".agents/skills/dual-moving-averages/SKILL.md");
const TYPE_HEADER = /^\|\s*趋势类型\s*\|/;

/** SKILL.md 第 1 步的类型总表。第一列以脚本的 play.key 开头（"过渡（顶部 / 底部转折中、失序）"）。 */
export function parseTypeTable(md: string): TypeRow[] {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => TYPE_HEADER.test(l));
  if (start < 0) throw new Error("SKILL.md 里没有类型总表（表头以「| 趋势类型 |」开头）");
  const rows: TypeRow[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    const [type, look, play, rules] = line.split("|").slice(1, -1).map((c) => c.trim());
    rows.push({ type, look, play, rules });
  }
  return rows;
}

export const TYPE_TABLE = parseTypeTable(readFileSync(SKILL_MD, "utf8"));

export function typeRow(key: string, table = TYPE_TABLE): TypeRow {
  const row = table.find((r) => r.type.startsWith(key));
  if (!row) throw new Error(`SKILL.md 的类型总表里没有「${key}」`);
  return row;
}

export function parseCross(text: string): CrossInfo {
  const m = text.match(/^(金叉|死叉) (\d{4}-\d{2}-\d{2})（(\d+) 根前）/);
  return m ? { kind: m[1] as "金叉" | "死叉", date: m[2], barsAgo: Number(m[3]) } : { kind: null, date: null, barsAgo: null };
}

export function crossVerdict(ma: CrossInfo, ema: CrossInfo): string {
  if (!ma.kind || !ema.kind) return "数据不足";
  if (ma.kind === ema.kind) return `双${ma.kind}`;
  return "不一致";
}

const pct = (x: number, d = 1) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}%`;
const f2 = (x: number) => x.toFixed(2);

function directionSentence(a: Analysis): string {
  const flat = a.thresholds.FLAT_SLOPE_PCT.value;
  const dir = (s: number) => (Math.abs(s) < flat ? "走平" : s > 0 ? "向上" : "向下");
  const groups = new Map<string, number[]>();
  for (const ln of a.lines) groups.set(dir(ln.slope), [...(groups.get(dir(ln.slope)) ?? []), ln.period]);
  const cites = a.lines.map((ln) => `[[D:MA${ln.period}.方向]]`).join(" ");
  if (groups.size === 1) return `三条 MA 都${[...groups.keys()][0]} ${cites}。`;
  const parts = [...groups.entries()].map(([k, ns]) => `MA${ns.join("、MA")} ${k}`);
  return `${parts.join("；")} ${cites}。`;
}

function positionSentence(a: Analysis): string {
  const above = a.lines.filter((l) => l.above).map((l) => l.period);
  if (above.length === 3) return "价格在三条 MA 上方 [[D:MA20.位置]]。";
  if (above.length === 0) return "价格在三条 MA 下方 [[D:MA20.位置]]。";
  const below = a.lines.filter((l) => !l.above).map((l) => l.period);
  return `价格在 ${above.join("、")} 线上方，在 ${below.join("、")} 线下方 [[D:MA20.位置]]。`;
}

function frameSentence(name: "周线" | "小时线", f: Analysis["weekly"] | Analysis["hourly"], rule: string): string {
  if (!f.available) return `${name}取不到 [[D:${name}.排列]]，${rule === "P13" ? "小时线那条要看图" : "周线那条算不了"} [[S:rules#${rule}]]。`;
  return `${name}：MA ${f.arr_ma}，EMA ${f.arr_ema} [[D:${name}.排列]] [[S:rules#${rule}]]。`;
}

function turnSentence(sc: Scenario, line: string): string | null {
  const t = sc.turns.find((x) => x.line === line);
  if (!t) return null;
  const way = { 上: "向上", 下: "向下", 平: "走平" }[t.now];
  return t.turn_day ? `${line} 现在${way}，第 ${t.turn_day} 天转向 [[D:推演.${line}]]。` : `${line} 现在${way}，${sc.days} 天内不转向 [[D:推演.${line}]]。`;
}

function ruleLine(r: RuleResult): string {
  const yields = r.yields_to ? `，${r.yields_to} 优先 [[S:rules#${r.yields_to}]]` : "";
  return `${r.id} ${r.name}：${r.status}${yields} [[S:rules#${r.id}]] [[D:规则.${r.id}]]。`;
}

export function buildReport(a: Analysis): Report {
  const crosses = a.crosses.map((c) => {
    const ma = parseCross(c.ma);
    const ema = parseCross(c.ema);
    return { pair: c.pair, ma, ema, verdict: crossVerdict(ma, ema) };
  });
  const trend = a.regime.name;
  const row = typeRow(a.play.key);
  const extreme = a.thresholds.EXTREME_PCTL.value;
  const sc = a.projection.scenarios[0];
  const ln = a.lean;

  // ---------- 1. 看大局：先结论（趋势类型），下面都是证据 ----------
  const big: string[] = [
    `趋势类型：${trend} [[D:趋势初判]]。${row.look} [[S:skill#第1步]]。`,
    `${directionSentence(a)}均线方向是最小阻力方向 [[S:article#1]]。`,
    `MA 排列：${a.arr_ma} [[D:排列.MA]]。EMA 排列：${a.arr_ema} [[D:排列.EMA]]。`,
    positionSentence(a),
    `价格离 20 线 ${pct(a.bias20)} [[D:乖离20]]。这在历史上排 ${Math.round(a.bias_pctl * 100)}% 分位 [[D:乖离分位]]。`,
  ];
  if (a.bias_pctl <= 1 - extreme || a.bias_pctl >= extreme) big.push("大幅乖离是趋势的最后一步 [[S:article#3.2]]。");
  for (const p of a.steps) {
    if (p.current?.progress) big.push(`${p.pair} 正在${p.current.direction}转折，走到第 ${p.current.progress} 步 [[D:五步.${p.pair}]] [[S:rules#J15]]。`);
  }
  for (const c of crosses) {
    if (c.verdict.startsWith("双")) big.push(`${c.pair}：${c.verdict} [[D:交叉.${c.pair}]]。同一对周期的 MA、EMA 都交叉，才算确认 [[S:rules#J16]]。`);
    else if (c.verdict === "不一致") big.push(`${c.pair}：MA ${c.ma.kind}，EMA ${c.ema.kind} [[D:交叉.${c.pair}]]。只有一组交叉，不算确认 [[S:rules#J16]]。`);
  }
  big.push(frameSentence("周线", a.weekly, "J11"), frameSentence("小时线", a.hourly, "P13"));
  if (a.volume) {
    big.push(`今日量是 50 日均量的 ${a.volume.ratio.toFixed(1)} 倍 [[D:量比]]。`);
    if (a.volume.spikes.length) big.push(`近 20 日有 ${a.volume.spikes.length} 天大量 [[D:放量日]]。大量是标志性动作 [[S:article#2.7]]。`);
  }
  big.push("类型是规则判的，边界情况要看图复核 [[S:skill#第1步]]。");

  // ---------- 2. 定策略：结论在 plans（按有没有仓位），这里是依据 ----------
  const strategy = [
    `打法按「${trend}」定 [[D:趋势初判]] [[S:skill#第2步]]：${a.play.text} [[D:打法]]`,
    `用到的规则：${a.play.rules.map((id) => `${id} [[S:rules#${id}]]`).join("、")}。`,
    "有没有仓位，做法不同 [[S:skill#第2步]]。",
    "价位来自 EMA20 和 MA20 抵扣价 [[D:改变判断.EMA20]] [[D:改变判断.MA20]]。",
    "仓位以心态稳得住为准 [[S:article#7.3]]。",
  ];

  // ---------- 3. 看方向 ----------
  const direction = a.projection.hurdles.map((h) =>
    `MA${h.period}：${h.days} 天内收盘在 ${f2(h.max_price)} 之上，天天上行；在 ${f2(h.min_price)} 之下，天天下行 [[D:门槛.MA${h.period}]] [[S:rules#A2]]。`);
  direction.push(
    ...["MA20", "MA60", "MA120"].map((k) => turnSentence(sc, k)).filter((x): x is string => x !== null),
    `价格不变 ${sc.days} 天后：MA 排列 ${sc.end_arr_ma} [[D:推演.排列.MA]]，EMA 排列 ${sc.end_arr_ema} [[D:推演.排列.EMA]]。`,
    `价格不变 ${ln.after.days} 天后，模糊判断是${ln.after.label} [[D:模糊判断.10天后]]。`,
    "收盘价高于抵扣价，MA 就上升 [[S:article#2.3]]。推演链：抵扣价 → 方向 → 排列 [[S:skill#第3步]]。",
  );

  // ---------- 4. 规则清单：打法用到的规则在前 ----------
  const byId = new Map(a.rules.map((r) => [r.id, r]));
  const rules = a.play.rules.map((id) => byId.get(id)).filter((r): r is RuleResult => Boolean(r)).map(ruleLine);
  for (const r of a.rules) if (r.yields_to && !a.play.rules.includes(r.id)) rules.push(ruleLine(r));

  return {
    headline: `${a.label} · ${ln.label} · ${trend}`,
    stance: stanceOf(ln),
    trend: { type: trend, look: row.look },
    plans: buildPlans(a),
    outlook: buildOutlook(a),
    steps: [
      { key: "big_picture", title: "看大局", subtitle: "现在是什么趋势", items: big },
      { key: "strategy", title: "定策略", subtitle: "你该怎么做", items: strategy },
      { key: "direction", title: "看方向", subtitle: "接下来会不会变", items: direction },
      { key: "rules", title: "规则清单", subtitle: "每条规则今天满不满足", items: rules },
    ],
    visual: {
      close: a.close,
      lean: ln,
      trend,
      regime: a.regime,
      spread: a.spread_pct,
      lines: a.lines,
      bias: { value: a.bias20, pctl: a.bias_pctl, extreme },
      crosses,
      steps: a.steps,
      weekly: a.weekly,
      hourly: a.hourly,
      trendTable: TYPE_TABLE.map((r) => ({ ...r, current: r === row })),
      drops: a.drops,
      hurdles: a.projection.hurdles,
      scenario: sc,
      solves: a.projection.solves,
      rules: a.rules,
      playRules: a.play.rules,
    },
  };
}
