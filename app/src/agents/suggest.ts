/**
 * 动态问法：每次切换股票时，给中栏（长风）和右栏（鸿雁）各生成几条可点的问题。
 *
 * - ruleSuggestions：从分析数据直接拼，立刻可用，作为占位和兜底。
 * - Suggester：独立的轻量 Pi 会话（无工具、低思考），按当前数据生成问题，替换规则版。
 *   不进入两个对话会话，按"股票|日期|回放"缓存。
 */
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { factsForPrompt, type Analysis, type Facts } from "../citations.ts";
import { PROJECT_ROOT } from "../sources.ts";
import { assistantText, type Suggestion } from "./host.ts";
import { DEFAULT_SETTINGS } from "../settings.ts";
import { resolveModel, thinkingFor } from "./model.ts";
import { INTENTS } from "./tools.ts";
import { isPracticeLabel } from "../practice/blind.ts";

export interface SuggestionSet {
  analyst: Suggestion[];
  advisor: Suggestion[];
}

export function ruleSuggestions(a: Analysis, asof: string | null = null): SuggestionSet {
  const T = a.label;
  const line = (n: number) => a.lines.find((l) => l.period === n)!;
  const act =
    a.regime.transition === "空头结构反弹中" ? `${T} 这波反弹是真的吗，能追吗？` :
    a.regime.transition === "多头结构回撤中" ? `${T} 这次回调要不要卖？` :
    a.regime.type === "稳定上涨" ? `${T} 现在能加仓吗？` :
    a.regime.type === "加速上涨" ? `${T} 涨这么多还能追吗？` :
    a.regime.type === "稳定下跌" || a.regime.type === "加速下跌" ? `${T} 跌这么多能抄底吗？` :
    `${T} 什么条件下才值得出手？`;
  const s60 = line(60).slope;
  const analyst: Suggestion[] = [
    { text: `用双均线看看 ${T}`, intent: "看状态" },
    { text: act, intent: "要不要动手" },
    { text: `${T} 的 60 日线什么时候能拐${s60 < 0 ? "上来" : "下去"}？`, intent: "何时拐头" },
    isPracticeLabel(T)
      ? { text: "如果现在空仓，按计划该在哪里进场、止损放哪里？", intent: "回放练习" }
      : asof
      ? { text: `回放 ${T} ${asof} 之后 20 个交易日，当时的判断对吗？`, intent: "回放练习" }
      : { text: "回放 TSLA 2021-04-14，用双均线分析", intent: "回放练习" },
  ];

  const ma60 = line(60).ma, ma120 = line(120).ma;
  const advisor: Suggestion[] = [
    { text: `抵扣价怎么推演？用 ${T} 的 MA20 举个例子`, intent: "复习概念" },
    Math.abs(ma60 / ma120 - 1) < 0.01
      ? { text: "MA60 和 MA120 快交叉了，什么叫双交叉？", intent: "复习概念" }
      : { text: "什么叫双交叉？为什么只看一组不够？", intent: "复习概念" },
    { text: `「${a.regime.name}」是什么意思，该怎么做？`, intent: "复习概念" },
  ];
  const extreme = a.thresholds.EXTREME_PCTL.value;
  if (a.bias_pctl <= 1 - extreme || a.bias_pctl >= extreme) {
    advisor.push({ text: `乖离率在历史 ${Math.round(a.bias_pctl * 100)}% 分位说明什么？`, intent: "复习概念" });
  }
  return { analyst, advisor };
}

/** 从模型输出里取 JSON 并校验；不合格返回 null。 */
export function parseSuggestions(raw: string): SuggestionSet | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const data = JSON.parse(m[0]);
    const clean = (xs: unknown, intents: readonly string[]): Suggestion[] =>
      (Array.isArray(xs) ? xs : [])
        .filter((x: any) => typeof x?.text === "string" && x.text.trim() && x.text.length <= 60 && intents.includes(x.intent))
        .slice(0, 5)
        .map((x: any) => ({ text: x.text.trim(), intent: x.intent }));
    const set = { analyst: clean(data.analyst, INTENTS.filter((i) => i !== "复习概念")), advisor: clean(data.advisor, ["复习概念"]) };
    return set.analyst.length >= 2 && set.advisor.length >= 2 ? set : null;
  } catch {
    return null;
  }
}

const PROMPT = `你为"双均线工作台"生成可点击的问题按钮。只输出一个 JSON 对象，不要别的文字：
{"analyst":[{"text":"…","intent":"看状态|要不要动手|何时拐头|回放练习"}, …4 条],
 "advisor":[{"text":"…","intent":"复习概念"}, …3 条]}
要求：
- analyst 是问"长风"的：围绕这只股票当前最值得关心的点（例如即将发生的交叉、哪条均线快拐头、扣高值还是扣低值、能不能加仓/抄底），四种 intent 各一条，回放练习可以用这只股票的历史日期或视频案例 "回放 TSLA 2021-04-14"。
- advisor 是问"鸿雁"的概念题：从当前数据里挑出用户最可能看不懂的概念（例如抵扣价、双交叉、乖离分位、排列混乱），用当前数据举例。
- 每条不超过 30 个字，口语化，具体，不要重复，不要出现"投资建议"。`;

export class Suggester {
  private cache = new Map<string, Promise<SuggestionSet | null>>();

  constructor(private modelSpec: () => string = () => DEFAULT_SETTINGS.model) {}

  suggest(a: Analysis, facts: Facts, asof: string | null): Promise<SuggestionSet | null> {
    const key = `${a.label}|${a.date}|${asof ?? ""}|${this.modelSpec()}`;
    let hit = this.cache.get(key);
    if (!hit) {
      hit = this.generate(a, facts, asof).catch(() => null);
      hit.then((v) => v ?? this.cache.delete(key)); // 失败不缓存
      this.cache.set(key, hit);
    }
    return hit;
  }

  private async generate(a: Analysis, facts: Facts, asof: string | null): Promise<SuggestionSet | null> {
    const services = await createAgentSessionServices({
      cwd: PROJECT_ROOT, agentDir: getAgentDir(),
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        systemPrompt: PROMPT, appendSystemPrompt: [],
      },
    });
    const model = resolveModel(services.modelRuntime, this.modelSpec());
    const { session } = await createAgentSessionFromServices({
      services, sessionManager: SessionManager.inMemory(PROJECT_ROOT),
      model, thinkingLevel: thinkingFor(model, "low"), noTools: "all",
    });
    try {
      await session.prompt(
        `股票 ${a.label}${asof ? `（回放 ${asof}）` : ""}，类型 × 阶段：${a.regime.name}。\n数据：\n${factsForPrompt(facts)}`,
      );
      const last = [...session.messages].reverse().find((m: any) => m.role === "assistant");
      return last ? parseSuggestions(assistantText(last as any)) : null;
    } finally {
      session.dispose();
    }
  }
}
