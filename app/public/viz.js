// 三步报告的可视化：表格 + 小图。数据来自服务端 report.visual。
// 规则（dataviz）：细线、≥8px 点、文字用文字色、颜色不单独表意（都配文字）、每个标记可悬停看数值。
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const f2 = (x) => Number(x).toFixed(2);
const pct = (x, d = 1) => `${x >= 0 ? "+" : ""}${Number(x).toFixed(d)}%`;
const tip = (t) => `data-tip="${esc(t)}"`;

// ---------- 钟表方向图标 ----------
/** "2 点钟（上行）" → 箭头角度：3 点 = 水平，每差 1 点转 30°。 */
export function clockGlyph(clock) {
  const h = Number(String(clock).match(/^(\d)/)?.[1] ?? 3);
  const deg = (3 - h) * 30; // 正数 = 向上
  return `<svg class="clock" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.5"/>
    <g transform="rotate(${-deg} 10 10)"><path d="M4 10h11"/><path d="M12 7l3 3-3 3"/></g></svg>`;
}

// ---------- 模糊判断：接下来几周对谁有利 ----------
const LEAN_SCALE = ["明显偏空", "偏空", "不明", "偏多", "明显偏多"];
/** 和服务端 report.ts 的 stanceOf 同一规则：跟脚本给的档位走。 */
export const stanceOf = (l) => (l.label.includes("偏多") ? "bullish" : l.label.includes("偏空") ? "bearish" : "neutral");
/** 规则编号按钮：点开 rules.md 里那一条（和回答里的 [[S:rules#P17]] 同一个弹窗）。 */
export const ruleBtn = (id) => `<button type="button" class="cite src rule-ref" data-kind="S" data-ref="rules#${esc(id)}" title="rules.md ${esc(id)}">${esc(id)}</button>`;
const STATUS_CLS = { 满足: "met", 不满足: "unmet", 需看图: "chart" };
export const leanName = (l) => l.label;
const ARROW = { 1: ["↗", "bullish", "向上"], 0: ["→", "neutral", "走平"], [-1]: ["↘", "bearish", "向下"] };
const REL = { 1: "在上", 0: "贴近", [-1]: "在下" };

/** 刻度条：−1…+1 分 5 档；实心针 = 现在，空心针 = 价格不变 N 天后。 */
function leanScale(l) {
  const at = (x) => 3 + ((Math.max(-1, Math.min(1, x)) + 1) / 2) * 94; // 两端留 3%，针不被裁掉
  const pos = (x) => `${at(x).toFixed(1)}%`;
  const zones = LEAN_SCALE.map((z) => `<span class="${z === l.label ? "on" : ""}">${z}</span>`).join("");
  const a = l.after;
  const same = Math.abs(at(a.score) - at(l.score)) < 12; // 两根针挨着时只写一个标签
  return `<div class="lean-scale" role="img" aria-label="模糊判断 ${l.label}，分数 ${l.score.toFixed(2)}；价格不变 ${a.days} 天后 ${a.label}">
      <div class="lean-track">
        <span class="pin after" style="left:${pos(a.score)}" ${tip(`价格不变 ${a.days} 天后：${leanName(a)}（${a.score >= 0 ? "+" : ""}${a.score.toFixed(2)}）`)}><i></i>${same ? "" : `<em>${a.days} 天后</em>`}</span>
        <span class="pin now" style="left:${pos(l.score)}" ${tip(`现在：${leanName(l)}（${l.score >= 0 ? "+" : ""}${l.score.toFixed(2)}）`)}><i></i><em>${same ? `现在 ≈ ${a.days} 天后` : "现在"}</em></span>
      </div>
      <div class="lean-zones">${zones}</div></div>`;
}

/** 方向证据：6 条线各自的箭头。 */
function leanArrows(l) {
  const keys = ["MA20", "EMA20", "MA60", "EMA60", "MA120", "EMA120"];
  return `<div class="lean-arrows">${keys.map((k) => {
    const [g, cls, word] = ARROW[l.dirs[k]];
    const n = k.replace(/\D/g, "");
    return `<span class="la" ${tip(`${k} ${word}`)}><i class="sw ${k.startsWith("E") ? "ema" : ""}" style="--c: var(--${k.toLowerCase()})"></i>${k.startsWith("E") ? "E" : ""}${n}<b class="${cls}">${g}</b></span>`;
  }).join("")}</div>`;
}

/** 排布证据：20 组 vs 60 组、60 组 vs 120 组，MA 和 EMA 各一行。 */
function leanPairs(l) {
  const rel = Object.fromEntries(l.pairs.map((p) => [p.pair, p.rel]));
  const cell = (k) => `<b class="${rel[k] > 0 ? "bullish" : rel[k] < 0 ? "bearish" : "neutral"}">${REL[rel[k]]}</b>`;
  return `<table class="lean-pairs"><thead><tr><th></th><th>MA</th><th>EMA</th></tr></thead><tbody>
      <tr><th>20 组对 60 组</th><td>${cell("MA20/MA60")}</td><td>${cell("EMA20/EMA60")}</td></tr>
      <tr><th>60 组对 120 组</th><td>${cell("MA60/MA120")}</td><td>${cell("EMA60/EMA120")}</td></tr></tbody></table>`;
}

/** 什么会改变判断：两个方向都列，现价上方的是"站上转多"，下方的是"跌破转空"；按 EMA 先拐、MA 后拐排。 */
function leanFlips(l, close) {
  const rows = l.flips.filter((f) => !f.line.endsWith("120")).map((f) => {
    const verb = f.toward === "多" ? "站上" : "跌破";
    const what = f.line.startsWith("EMA") ? f.line : `${f.line} 扣价`;
    const role = f.line.startsWith("EMA") ? `${f.line} 先拐（第 1 个动作），转${f.toward}` : `过了抵扣价，${f.line} 跟着拐（第 2 个动作），转${f.toward}`;
    const dist = (f.price / close - 1) * 100;
    return `<li class="${f.toward === "多" ? "bullish" : "bearish"}" ${tip(f.text)}>
        <span class="fv">${verb} ${what}</span>
        <span class="num">${f2(f.price)}</span>
        <span class="num fd">${pct(dist)}</span>
        <span class="fr">${role}</span></li>`;
  }).join("");
  return `<ul class="lean-flips">${rows}</ul>`;
}

/** 模糊判断的证据（做推演的依据里）：刻度条、6 条线的方向、排布、什么会改变判断。结论句在做推演的第一行。 */
export function leanCard(l, close, tie) {
  return `<div class="lean-top">${leanScale(l)}</div>
    <div class="lean-evidence">
      <div class="ev"><div class="ev-k">方向：6 条成本线往哪走 <span>${l.up} 上 · ${l.flat} 平 · ${l.down} 下</span></div>${leanArrows(l)}</div>
      <div class="ev"><div class="ev-k">排布：短期线组在上还是在下 <span>相差 &lt; ${tie}% 算贴近</span></div>${leanPairs(l)}</div>
      <div class="ev"><div class="ev-k">什么会改变判断 <span>距现价</span></div>${leanFlips(l, close)}</div>
    </div>
    <p class="lean-foot">模糊判断：看类型线 MA60、MA120 往哪走、收盘不变能保持几天（${l.basis.map((b) => `${b.line} ${b.direction} ${b.hold_days}/${b.days} 天`).join("，")}），不预测明天涨跌。价位过了门槛，才值得反应。</p>`;
}

// ---------- 1. 看大局 ----------
/** 价位梯子：一条价格轴上标出收盘价、3 条 MA（实心点）、3 条 EMA（空心圈）。看次序和间距。 */
export function ladder(v) {
  const W = 640, H = 92, padX = 28, axisY = 46;
  const pts = [
    ...v.lines.map((l) => ({ key: `MA${l.period}`, value: l.ma, color: `var(--ma${l.period})`, solid: true, row: -1 })),
    ...v.lines.map((l) => ({ key: `EMA${l.period}`, value: l.ema, color: `var(--ema${l.period})`, solid: false, row: 1 })),
  ];
  const all = [...pts.map((p) => p.value), v.close];
  let lo = Math.min(...all), hi = Math.max(...all);
  const pad = (hi - lo || 1) * 0.08;
  lo -= pad; hi += pad;
  const x = (val) => padX + ((val - lo) / (hi - lo)) * (W - 2 * padX);
  // 标签分层，避免重叠
  const placed = { "-1": [], "1": [] };
  const labelY = (p) => {
    const xs = placed[p.row];
    let lvl = 0;
    while (xs.some((o) => o.lvl === lvl && Math.abs(o.x - x(p.value)) < 52)) lvl++;
    xs.push({ x: x(p.value), lvl });
    return axisY + p.row * (16 + lvl * 13);
  };
  const marks = pts.sort((a, b) => a.value - b.value).map((p) => {
    const cx = x(p.value), ly = labelY(p);
    return `<g class="mk" ${tip(`${p.key} ${f2(p.value)}`)}>
      <circle cx="${cx}" cy="${axisY}" r="${p.solid ? 5 : 4.5}" style="${p.solid ? `fill:${p.color}` : `fill:var(--card);stroke:${p.color};stroke-width:2`}" class="ring"/>
      <text x="${cx}" y="${ly}" text-anchor="middle" class="lbl">${p.key}</text>
      <circle cx="${cx}" cy="${axisY}" r="11" class="hit"/></g>`;
  }).join("");
  const cx = x(v.close);
  return `<figure class="viz"><svg viewBox="0 0 ${W} ${H}" class="ladder" role="img" aria-label="价位梯子：收盘价与 6 条均线的位置">
      <line x1="${padX}" x2="${W - padX}" y1="${axisY}" y2="${axisY}" class="axis"/>
      <text x="${padX}" y="${H - 4}" class="tick">${f2(lo)}</text><text x="${W - padX}" y="${H - 4}" text-anchor="end" class="tick">${f2(hi)}</text>
      <g ${tip(`收盘 ${f2(v.close)}`)}><line x1="${cx}" x2="${cx}" y1="${axisY - 20}" y2="${axisY + 20}" class="close"/>
      <text x="${cx}" y="${axisY - 24}" text-anchor="middle" class="lbl strong">收盘 ${f2(v.close)}</text></g>
      ${marks}</svg>
    <figcaption>价位梯子：实心点是 MA，空心圈是 EMA，竖线是收盘价。左低右高。</figcaption></figure>`;
}

/** 乖离分位条：0–100%，两端（脚本的 EXTREME_PCTL）是"大幅乖离"区。 */
export function biasMeter(v) {
  const p = Math.max(0, Math.min(1, v.bias.pctl));
  const edge = Math.round((1 - v.bias.extreme) * 100);
  return `<figure class="viz meter" ${tip(`离 20 线 ${pct(v.bias.value)}，历史 ${Math.round(p * 100)}% 分位`)}>
      <div class="meter-track"><span class="zone lo"></span><span class="zone hi"></span>
        <span class="needle" style="left:${(p * 100).toFixed(1)}%"><b>${Math.round(p * 100)}%</b></span></div>
      <div class="meter-axis"><span>0% 最负</span><span>大幅乖离区：两端各 ${edge}%</span><span>100% 最正</span></div>
    <figcaption>离 20 线 ${pct(v.bias.value)}：在自身历史里排 ${Math.round(p * 100)}% 分位。</figcaption></figure>`;
}

/** 五个进度点（rules.md J15）：每对线组这一轮转折走到哪一步，每步带日期。 */
const STEP_NAMES = ["破线", "EMA 拐头", "MA 拐头", "第一个交叉", "双交叉"];
export function fiveSteps(v) {
  const rows = v.steps.map((p) => {
    const t = p.current;
    const cells = STEP_NAMES.map((n) => {
      const d = t?.steps.find((x) => x.step === n)?.date;
      return d ? `<td class="done" ${tip(`${p.pair} ${n} ${d}`)}>✓ <span class="num">${d.slice(5)}</span></td>` : `<td class="todo">—</td>`;
    }).join("");
    const last = p.completed?.steps.at(-1)?.date;
    return `<tr><th>${p.pair}<span class="sub">${esc(p.side ?? "未定")}${t ? ` → ${t.direction}` : ""}</span></th>${cells}
      <td class="num">${t?.progress ?? 0}/5${last ? `<span class="sub">上一轮 ${last}</span>` : ""}</td></tr>`;
  }).join("");
  return `<table class="vt steps5"><thead><tr><th>线组</th>${STEP_NAMES.map((n) => `<th>${n}</th>`).join("")}<th>进度</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="legend-note">每对线组现在站在哪边、这一轮往反方向走到第几个进度点 ${ruleBtn("J15")}。双交叉要同一对周期的 MA、EMA 都交叉 ${ruleBtn("J16")}。</p>`;
}

/** 周线、小时线的排列：大一级定方向（J11），小一级找进场点（P13）。 */
function frameText(name, f) {
  return f.available ? `${name} MA <b>${esc(f.arr_ma)}</b>、EMA <b>${esc(f.arr_ema)}</b>` : `${name}取不到（${esc(f.reason)}）`;
}

export function crossTable(v) {
  const cell = (c) => (c.kind ? `<span class="${c.kind === "金叉" ? "bullish" : "bearish"}">${c.kind}</span> <span class="num muted">${c.date}（${c.barsAgo} 根前）</span>` : "无");
  const rows = v.crosses.map((c) => `<tr><th>${c.pair}</th><td>${cell(c.ma)}</td><td>${cell(c.ema)}</td>
      <td><span class="verdict-tag ${c.verdict.startsWith("双") ? (c.verdict.includes("金") ? "bullish" : "bearish") : "neutral"}">${c.verdict.startsWith("双") ? "✓ " : "△ "}${c.verdict}</span></td></tr>`).join("");
  return `<table class="vt"><thead><tr><th>交叉</th><th>MA 最近</th><th>EMA 最近</th><th>判定</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ---------- 2. 定策略 ----------
export function trendTable(v) {
  const rows = v.trendTable.map((r) => `<tr class="${r.current ? "cur" : ""}">
      <th>${r.current ? "▶ " : ""}${esc(r.type)}</th><td>${esc(r.look)}</td><td>${esc(r.play)}</td><td class="num">${esc(r.rules)}</td></tr>`).join("");
  return `<table class="vt trend"><thead><tr><th>趋势类型</th><th>均线长什么样</th><th>打法</th><th>规则</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="legend-note">这张表在 SKILL.md 第 1 步，是唯一的一份。</p>`;
}

// ---------- 3. 看方向 ----------
/**
 * 抵扣价小多图：每条 MA 一张，横轴是未来第 1–10 天，纵轴价格（三张共用）。
 * 中线 = 现价；棒棒糖从现价伸到当天要扣的价格：在上方 = 扣高值（MA 往下拉），在下方 = 扣低值（MA 往上抬）。
 */
export function dropMultiples(v, opts = {}) {
  const drops = opts.periods ? v.drops.filter((d) => opts.periods.includes(d.period)) : v.drops;
  const all = [v.close, ...drops.flatMap((d) => d.path.map((p) => p.close))];
  let lo = Math.min(...all), hi = Math.max(...all);
  const pad = (hi - lo || 1) * 0.12;
  lo -= pad; hi += pad;
  const W = 230, H = 150, L = 8, R = 8, T = 10, B = 22;
  const y = (val) => T + (1 - (val - lo) / (hi - lo)) * (H - T - B);
  const charts = drops.map((d) => {
    const n = d.path.length;
    const x = (i) => L + 10 + (i * (W - L - R - 20)) / Math.max(1, n - 1);
    const cy = y(v.close);
    const sticks = d.path.map((p, i) => {
      const highSide = p.close > v.close;
      const cls = highSide ? "hi" : "lo";
      return `<g class="mk" ${tip(`第 ${i + 1} 天扣 ${p.date} 的 ${f2(p.close)}（${highSide ? "扣高值" : "扣低值"}）`)}>
        <line x1="${x(i)}" x2="${x(i)}" y1="${cy}" y2="${y(p.close)}" class="stick ${cls}"/>
        <circle cx="${x(i)}" cy="${y(p.close)}" r="4" class="dot ${cls}"/>
        <rect x="${x(i) - 9}" y="${T}" width="18" height="${H - T - B}" class="hit"/></g>`;
    }).join("");
    const high = n - d.below;
    return `<figure class="viz drop">
      <div class="drop-head"><b><i class="sw" style="--c: var(--ma${d.period})"></i>MA${d.period}</b>
        <span>扣高 <b class="bearish">${high}</b> · 扣低 <b class="bullish">${d.below}</b></span></div>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="MA${d.period} 未来 ${n} 天的抵扣价">
        <line x1="${L}" x2="${W - R}" y1="${cy}" y2="${cy}" class="mid"/>
        <text x="${L}" y="${d.below * 2 >= n ? cy - 4 : cy + 11}" class="tick">现价 ${f2(v.close)}</text>
        ${sticks}
        <text x="${x(0)}" y="${H - 6}" text-anchor="middle" class="tick">第1天</text>
        <text x="${x(n - 1)}" y="${H - 6}" text-anchor="middle" class="tick">第${n}天</text>
      </svg>
      <figcaption>价不变 ${n} 天：MA${d.period} ${pct(d.ma_flat_change_pct, 2)}</figcaption></figure>`;
  }).join("");
  return `<div class="drops">${charts}</div>
    <p class="legend-note"><span class="key hi"></span>在现价上方 = 扣高值，MA 往下拉　<span class="key lo"></span>在下方 = 扣低值，MA 往上抬　三张图纵轴相同</p>`;
}

/** 门槛路径（rules.md A2）：每条 MA 未来 K 天要扣的价格里最高、最低是多少，第几天。 */
export function hurdleTable(v) {
  const rows = v.hurdles.map((h) => {
    const where = v.close > h.max_price ? ["bullish", "现价在最高之上：收盘不变，天天上行"]
      : v.close < h.min_price ? ["bearish", "现价在最低之下：收盘不变，天天下行"] : ["neutral", "现价在两者之间：有涨有跌"];
    return `<tr><th><i class="sw" style="--c: var(--ma${h.period})"></i>MA${h.period}</th><td class="num">${h.days} 天</td>
      <td class="num">${f2(h.max_price)} <span class="sub">${pct((h.max_price / v.close - 1) * 100)} · 第 ${h.max_day} 天</span></td>
      <td class="num">${f2(h.min_price)} <span class="sub">${pct((h.min_price / v.close - 1) * 100)} · 第 ${h.min_day} 天</span></td>
      <td class="${where[0]}">${where[1]}</td></tr>`;
  }).join("");
  return `<table class="vt hurdles"><thead><tr><th>门槛路径</th><th>看几天</th><th>抵扣价最高</th><th>抵扣价最低</th><th>读法</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="legend-note">收盘守在最高值之上，这几天 MA 天天上行；在最低值之下，天天下行 ${ruleBtn("A2")}。</p>`;
}

/** 推演链：价格停在现价 N 天 → 每条线第几天转向、每对线第几天交叉 → 期末排列。来自脚本的持平情景。 */
export function scenarioFlow(v) {
  const sc = v.scenario;
  const WAY = { 上: ["↗", "bullish"], 下: ["↘", "bearish"], 平: ["→", "neutral"] };
  const turns = sc.turns.map((t) => `<li ${tip(`${t.line} 现在${t.now}${t.turn_day ? `，第 ${t.turn_day} 天转向` : `，${sc.days} 天内不转`}`)}>
      <span class="k">${t.line}</span><span class="ar ${WAY[t.now][1]}">${WAY[t.now][0]}</span>
      <span class="num">${t.turn_day ? `第 ${t.turn_day} 天转向` : "不转"}</span></li>`).join("");
  const crosses = sc.crosses.filter((c) => c.cross).map((c) =>
    `<li><span class="k">${c.kind} ${c.pair}</span> <b class="${c.cross === "金叉" ? "bullish" : "bearish"}">${c.cross}</b> · 第 ${c.cross_day} 天</li>`).join("")
    || "<li>期间没有交叉</li>";
  const arr = (b) => `<span class="arr ${b === "多头" ? "bullish" : b === "空头" ? "bearish" : "neutral"}">${b}</span>`;
  return `<div class="flow scenario">
      <div class="node"><div class="nk">① 假设</div><div class="nv">价格停在 <b class="num">${f2(sc.level)}</b><br>${sc.days} 个交易日</div></div>
      <div class="edge">→</div>
      <div class="node"><div class="nk">② 每条线</div><ul class="proj turns">${turns}</ul></div>
      <div class="edge">→</div>
      <div class="node"><div class="nk">③ 交叉</div><ul class="cross-list">${crosses}</ul></div>
      <div class="edge">→</div>
      <div class="node"><div class="nk">④ 期末排列</div><div class="nv">MA：${arr(sc.end_arr_ma)}<br>EMA：${arr(sc.end_arr_ema)}</div></div>
    </div>`;
}

/** 规则旁的小标签：rules.md 里标了评估结论的（例如"回测不支持（评估 2026-11-20，H6）"）。 */
const evidenceTag = (r) => (r.evidence ? `<span class="ev-tag">${esc(r.evidence)}</span>` : "");
/** 推演求解的评估结论，一行小字。 */
const evidenceNote = (text) => `<p class="ev-note">${esc(text)}</p>`;

/** 求解：K 天内让某件事发生（或不发生）要持平在什么价位。 */
export function solveList(solves) {
  const text = (s) => s.status !== "有临界价位" ? s.status
    : `持平在 <b class="num">${f2(s.level)}</b>（${pct(s.pct)}）${s.side}`;
  return `<ul class="solves">${solves.map((s) => `<li><span>${s.days} 天内${s.happen ? " " : "避免 "}${esc(s.event)}</span><span>${text(s)}</span></li>`).join("")}</ul>`;
}

/** 规则清单：打法用到的规则在前，每条的状态、依据；让位的写谁优先。全部规则折叠在下面。 */
function ruleRow(r) {
  const yields = r.yields_to ? `<span class="yield">让位：${ruleBtn(r.yields_to)} 优先</span>` : "";
  return `<li class="rule ${r.yields_to ? "yielded" : ""}" data-rule="${esc(r.id)}">${ruleBtn(r.id)}<b>${esc(r.name)}</b>
      <span class="rs ${STATUS_CLS[r.status]}">${esc(r.status)}</span>${yields}<span class="rb">${esc(r.basis)}</span>${evidenceTag(r)}</li>`;
}
/** 全部规则，按动作、判定、公理分组，折叠着（打法用到的那几条在找打法的清单里）。 */
export function allRules(v) {
  const groups = ["动作", "判定", "公理"].map((k) => {
    const rs = v.rules.filter((r) => r.kind === k);
    return `<h4>${k}（${rs.length}）</h4><ul class="rule-list all">${rs.map(ruleRow).join("")}</ul>`;
  }).join("");
  return `<details class="ref all-rules"><summary>全部 ${v.rules.length} 条规则（点编号看 rules.md 原文）</summary>${groups}</details>`;
}

// ---------- 悬停提示 ----------
export function installTips() {
  const box = document.getElementById("viz-tip");
  document.addEventListener("pointerover", (e) => {
    const el = e.target.closest("[data-tip]");
    if (!el) return;
    box.textContent = el.dataset.tip;
    box.hidden = false;
  });
  document.addEventListener("pointermove", (e) => {
    if (box.hidden) return;
    box.style.left = `${Math.min(e.clientX + 12, innerWidth - box.offsetWidth - 8)}px`;
    box.style.top = `${e.clientY + 14}px`;
  });
  document.addEventListener("pointerout", (e) => {
    if (e.target.closest("[data-tip]") && !e.relatedTarget?.closest?.("[data-tip]")) box.hidden = true;
  });
}

// ---------- 三步的结论 ----------
const POS = { flat: "空仓", holding: "持仓" };

/** 第 1 步：趋势类型 + 长什么样；六种类型的对照表折叠在下面。 */
export function trendAnswer(t) {
  return `<div class="answer"><span class="ak">结论</span><b class="big">${esc(t.type)}</b><span>${esc(t.look)}。下面都是证据。</span></div>`;
}

/**
 * 成本价输入 → 数字；认千分位逗号、全角数字和空格。没填、看不懂、≤ 0 都返回 null。
 * 逗号只当千分位（1,234.5）：133,5 这种可能是欧式小数，宁可说看不懂，也不悄悄变成 1335。
 */
export function parseCost(raw) {
  const t = String(raw ?? "").replace(/[０-９．]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/，/g, ",").replace(/\s/g, "");
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(t)) return null;
  const c = Number(t.replace(/,/g, ""));
  return c > 0 ? c : null;
}

/** 现价和成本差不到 0.005%（两位小数显示出来一样）：算持平。 */
const isEven = (cost, close) => Math.abs((close / cost - 1) * 100) < 0.005;

export function pnlText(cost, close) {
  if (!String(cost ?? "").trim()) return "填了成本价，持仓这一行和计划就按浮盈 / 浮亏给建议。";
  const c = parseCost(cost);
  if (c === null) return '<b class="bad">成本价看不懂：请填数字，例如 133.5</b>';
  const d = (close / c - 1) * 100;
  if (isEven(c, close)) return `现价 ${f2(close)} / 成本 ${f2(c)}：持平`;
  return `现价 ${f2(close)} / 成本 ${f2(c)}：浮${d >= 0 ? "盈" : "亏"} <b class="${d >= 0 ? "bullish" : "bearish"}">${pct(d)}</b>`;
}

/**
 * 处境：空仓；持仓没填成本或持平；持仓且价格高于成本（浮盈）；低于成本（浮亏）。
 * 和服务端 plan.ts 的 Situation 一一对应。
 */
export function situationOf(p, close) {
  if (p.pos !== "holding") return "flat";
  const c = parseCost(p.cost);
  if (c === null || isEven(c, close)) return "holding";
  return close > c ? "profit" : "loss";
}
const SITUATION_LABEL = { flat: "空仓", holding: "持仓", profit: "持仓 · 浮盈", loss: "持仓 · 浮亏" };

// ---------- 结论：空仓、持仓各一行，带触发价、止损、目标、盈亏比、股数；回测记录 ----------

/**
 * 一个价位标签：是什么、价位、离现价多远。item 给测试和读屏定位（trigger / stop / target）。
 * note 换掉"离现价多远"那一格；compact 时不写价位的说明（悬停看），五样放得下一行。
 * 是个按钮：点一下，图上那条线亮几秒（app.js 接到 chart.flashLevel；cls 就是价位线的种类 trigger / stop / target）。
 */
function priceChip(key, lv, close, cls, { item = cls, note = pct((lv?.price / close - 1) * 100), compact = false, more = "" } = {}) {
  if (!lv) return "";
  return `<button type="button" class="pchip ${cls}" data-item="${item}" data-kind="${cls}" data-price="${lv.price}" data-title="${key}" ${
    tip(`${key}：${lv.label} ${f2(lv.price)}${more ? `。${more}` : ""}（点一下，图上亮出这条线）`)}><span class="ck">${key}</span>${compact ? "" : esc(lv.label)}
    <b class="num">${f2(lv.price)}</b>${note ? `<span class="num muted">${note}</span>` : ""}</button>`;
}

const RR_CLASS = { 不做: "bad", 可做: "ok", 理想: "good" };

/** 盈亏比标签：几比几、哪一档（不到 3:1 不做，5:1 以上理想，P24）。悬停看差多少。 */
function rrChip(t) {
  if (t.rr === null) return "";
  if (t.entry?.far) { // 触发价离现价还远（docs/adr/0026.md）：按明天算的数只放悬停里
    return `<span class="pchip rr far" data-item="rr" ${tip(`触发价离现价还远，到时重算：按明天的触发价 ${f2(t.entry.price)} 算是 ${t.rr.toFixed(2)}:1（P24）`)}>
    <span class="ck">盈亏比</span>到时重算</span>`;
  }
  const gap = t.rr_gap ? `：要 3:1，目标得到 ${f2(t.rr_gap.target_for_min)}，或止损收紧到 ${f2(t.rr_gap.stop_for_min)}` : "";
  return `<span class="pchip rr ${RR_CLASS[t.rr_verdict]}" data-item="rr" ${tip(`盈亏比 ${t.rr.toFixed(2)}:1，${t.rr_verdict}（P24）${gap}`)}>
    <span class="ck">盈亏比</span><b class="num">${t.rr.toFixed(2)}:1</b>${esc(t.rr_verdict)}</span>`;
}

/** 股数标签：填了账户给股数；没填给每 1 万元风险对应多少股（A6）。触发价离现价还远时和盈亏比一样到时重算。 */
function sizeChip(t) {
  const z = t.size;
  if (!z) return "";
  if (t.entry?.far) {
    return `<span class="pchip size far" data-item="size" ${tip(`触发价离现价还远，到时重算：按明天的触发价 ${f2(t.entry.price)} 算：${z.basis}（A6）`)}>
    <span class="ck">股数</span>到时重算</span>`;
  }
  if (z.shares === null) {
    return `<span class="pchip size" data-item="size" ${tip(`${z.basis}。在设置里填账户规模，就按每笔可承受亏损给股数`)}>
      <span class="ck">股数</span><b class="num">${z.per_10k}</b>/万元</span>`;
  }
  return `<span class="pchip size" data-item="size" ${tip(z.basis)}><span class="ck">股数</span><b class="num">${z.shares}</b>${z.capped ? "（账户封顶）" : ""}</span>`;
}

/** 目标位标签：脚本给的目标 1、2（P25）；解读的、到第一目标怎么办（at_target）在悬停里说。 */
const targetChips = (t, close, compact) => t.targets.map((x, i) =>
  priceChip(`目标${t.targets.length > 1 ? i + 1 : ""}`, { label: x.source === "解读" ? `${x.kind}（解读）` : x.kind, price: x.price }, close, "target",
    { compact, note: compact ? "" : undefined, more: i === 0 ? t.at_target ?? "" : "" })).join("");

/**
 * 一行结论。buys：这套打法空仓会不会买（交易计划有进场），不买时空仓的价位叫「先看」，不叫触发。
 * 持仓浮盈 / 浮亏时计划里有「盈亏」一条（plan.ts 的 PNL），放在做法下面。
 */
function conclusionRow(name, plan, close, flat, buys, cost) {
  const fill = (t) => esc(t).replaceAll("{cost}", cost === null ? "成本" : f2(cost));
  const risk = plan.risk === null ? ""
    : plan.risk < 0.05 ? `<span class="pchip risk">止损就在${flat ? "进场价" : "现价"}：再破就走</span>`
    : `<span class="pchip risk"><span class="ck">${flat ? "风险" : "距止损"}</span><b class="num">${plan.risk.toFixed(1)}%</b></span>`;
  const t = plan.trade;
  // 空仓会买：五样排一行（触发、止损带风险、目标、盈亏比、股数），价位的说明放悬停里
  const five = flat && buys;
  const chips = five
    ? priceChip("触发", plan.trigger, close, "trigger", { compact: true, note: "" })
      + priceChip("止损", plan.stop, close, "stop", { compact: true, note: plan.risk === null ? "" : `-${plan.risk.toFixed(1)}%` })
      + targetChips(t, close, true) + rrChip(t) + sizeChip(t)
    : priceChip(flat ? "先看" : "盯住", plan.trigger, close, "trigger") + priceChip(flat ? "进场后止损" : "止损", plan.stop, close, "stop") + risk
      + (flat ? "" : targetChips(t, close, true));
  const pnl = plan.items.find((i) => i.label === "盈亏");
  return `<div class="concl-row" data-situation="${flat ? "flat" : "holding"}">
      <span class="who">${name}</span>
      <div class="what"><b>${fill(plan.action)}</b>${pnl ? `<p class="pnl-advice">${fill(pnl.text)}</p>` : ""}</div>
      <div class="chips-row${five ? " five" : ""}">${chips}</div></div>`;
}

/** 结论卡片的持仓那一行：按成本价分浮盈 / 浮亏（没填就是持仓）。输入成本时只重画这一行。 */
export function holdingRow(r, close, p) {
  const k = situationOf({ pos: "holding", cost: p.cost }, close);
  const cost = k === "profit" || k === "loss" ? parseCost(p.cost) : null;
  return conclusionRow(SITUATION_LABEL[k], r.plans[k], close, false, true, cost);
}

const NOW_TIP = "看大局的结论：现在是哪种趋势（类型·阶段），按 6 条均线今天的排列、方向和乖离判的。证据在下面「看大局」。";
const LEAN_TIP = "做推演的结论（模糊判断）：不预测明天涨跌，只判断接下来几周均线（市场的持仓成本）往哪走、对多头还是空头有利。"
  + "依据在下面「做推演」：第一句把它翻成动作，挨着写什么价位推翻它、历史评估靠不靠得住。";

/** 结论卡片。标题分「现在」和「往后」两段；整套方法的评估不在卡片上，页面上固定写一次（#method-note，ADR 0028）。 */
export function conclusionCard(r, close, p) {
  const buys = r.plans.flat.trade.entry !== null;
  return `<div class="concl-head"><span class="eyebrow">结论</span>
      <span class="concl-now" ${tip(NOW_TIP)}><span class="ck">现在</span><b class="concl-trend">${esc(r.trend.type)}</b></span>
      <span class="concl-lean" ${tip(LEAN_TIP)}><span class="ck">模糊判断 · 接下来几周</span><span class="lean-label ${stanceOf(r.visual.lean)}">${esc(r.visual.lean.label)}</span></span>
      <button type="button" id="journal-add" class="journal-add" title="把此刻的计划记进交易日志，之后对照结果">记入日志</button>
      <button type="button" class="ask-card" data-ask-card="verdict" aria-haspopup="menu">问鸿雁</button></div>
    ${conclusionRow("空仓", r.plans.flat, close, true, buys, null)}
    <div class="holding-row">${holdingRow(r, close, p)}</div>
    <div class="pos-cost"><label for="pos-cost">持仓成本</label><input id="pos-cost" inputmode="decimal" placeholder="可不填" value="${esc(p.cost ?? "")}"><span class="pnl">${pnlText(p.cost, close)}</span></div>
    ${naiveLine(r.naive)}
    ${bwlLine(r)}
    ${earningsLine(r, p)}
    ${recordLine(r.record)}`;
}

/** 本打法的回测记录一行；空仓不买、一笔没进场的打法没有记录，不显示。 */
function recordLine(rec) {
  return rec.card ? `<p class="record" ${tip(rec.card.tip)}><span class="pl">本打法回测</span>${esc(rec.card.line)}</p>` : "";
}

/**
 * 财报提醒一行：下次财报在提醒窗口内才有（report.earnings）。只是信息，不改打法。
 * 止损价按找打法里选的处境（空仓：进场后止损；持仓：止损），这一处没有就用另一处的。
 */
export function earningsLine(r, p) {
  const e = r.earnings;
  if (!e) return "";
  const [mine, other] = p.pos === "holding" ? [r.plans.holding, r.plans.flat] : [r.plans.flat, r.plans.holding];
  const stop = mine.stop ?? other.stop;
  const risk = stop ? `跳空可能越过止损价 <b class="num">${f2(stop.price)}</b>` : "跳空可能一下走很远";
  return `<p class="earnings-warn" data-item="earnings" ${tip(`下次财报 ${e.next}。财报后常跳空开盘，止损单按开盘价成交，可能比止损价差很多。只是提醒，不改打法`)}>`
    + `<span class="pl">财报</span>${e.days} 天后财报（${esc(e.next)}）：${risk}</p>`;
}

/**
 * 黑绿线一行：配了着色插件、类型适用时才有（report.bwl）。只是读数，交易计划没用它。
 * 借对照那一行的单行样式（class naive），窄屏截掉的部分悬停看整句。
 */
export function bwlLine(r) {
  const b = r.bwl;
  if (!b) return "";
  return `<p class="naive bwl-line" data-item="bwl" ${tip(`黑绿线（${b.source}）：${b.text}。只是读数，交易计划没用它（ADR 0022）`)}>`
    + `<span class="pl">黑绿线 · 仅参考</span>（${esc(b.source)}）：${esc(b.text)}。交易计划没用它</p>`;
}

/** 对照一句：MA200 规则怎么说｜双均线怎么说｜一不一致（不一致标出来）；离 MA200 多远、评估的数在悬停的整句里。 */
function naiveLine(n) {
  if (n.agrees === null) return `<p class="naive" ${tip(n.text)}><span class="pl">对照</span>${esc(n.rule)}</p>`;
  const agree = n.agrees ? ["same", "一致"] : ["differ", "不一致"];
  return `<p class="naive ${agree[0]}" ${tip(n.text)}><span class="pl">对照</span>MA200 规则：<b>${esc(n.ma200)}</b><span class="sep">｜</span>`
    + `双均线：<b>${esc(n.dual)}</b><span class="sep">｜</span><b class="naive-agree">${agree[1]}</b></p>`;
}

/** K 线图上的虚线：当前处境（找打法里选的空仓 / 持仓）的触发价、止损、目标位，加上推翻判断的价位。 */
export function chartLevels(r, p, close) {
  const k = situationOf(p, close);
  const plan = r.plans[k];
  const flat = k === "flat";
  const buys = r.plans.flat.trade.entry !== null;
  const inv = r.forecast.invalid.level;
  const targets = flat && !buys ? [] : plan.trade.targets;
  const lines = [
    plan.trigger && { kind: "trigger", price: plan.trigger.price, title: flat ? (buys ? "触发" : "先看") : "盯住" },
    plan.stop && { kind: "stop", price: plan.stop.price, title: flat ? "进场后止损" : "止损" },
    ...targets.map((t, i) => ({ kind: "target", price: t.price, title: `目标${targets.length > 1 ? i + 1 : ""}` })),
  ].filter(Boolean);
  // 同一个价位只画一条（例如空头结构反弹中：先看的就是推翻判断的理顺价位）
  const same = inv && lines.find((l) => Math.abs(l.price - inv.price) < 0.005);
  if (same) same.title += " · 判断失效";
  else if (inv) lines.push({ kind: "invalid", price: inv.price, title: "判断失效" });
  return lines;
}

// ---------- 找打法：哪套打法、条件清单、还差什么 ----------
const MARK = { 满足: ["✓", "met"], 不满足: ["✗", "unmet"], 需看图: ["需看图", "chart"] };

/** 打法用到的规则逐条：✓ 满足、✗ 不满足、需看图；没满足的写还差什么。 */
export function checklist(checks) {
  return `<ul class="checklist">${checks.map((c) => {
    const [mark, cls] = MARK[c.status];
    return `<li class="${cls}" data-rule="${esc(c.id)}"><span class="mark ${cls}" aria-label="${esc(c.status)}">${mark}</span>${ruleBtn(c.id)}<b>${esc(c.name)}</b>
      <span class="rb">${esc(c.basis)}</span>${c.need ? `<span class="need">还差：${esc(c.need)}</span>` : ""}${
      c.yieldsTo ? `<span class="yield">让位：${ruleBtn(c.yieldsTo)} 优先，不按它做</span>` : ""}${evidenceTag(c)}</li>`;
  }).join("")}</ul>`;
}

// ---------- 找打法：计划排成固定的格子（docs/adr/0029.md） ----------

/** 一个价位一句：叫什么、是什么、价位、离现价多远。 */
const priceLine = (key, lv, close, more = "") => (lv
  ? `<p class="pc-price"><span class="ck">${key}</span>${esc(lv.label)} <b class="num">${f2(lv.price)}</b> <span class="num muted">${pct((lv.price / close - 1) * 100)}</span>${more}</p>` : "");

/** 第一格的一个词配颜色：能做、拿着偏多；等、减仓居中；不做、离场偏空。 */
const VERDICT_CLS = { 做: "bullish", 拿着: "bullish", 等: "neutral", 减仓: "neutral", 不做: "bearish", 离场: "bearish" };
/** 做法本来就以这个词开头（"不做：盈亏比……"）时不再写一遍。 */
const verdictLine = (c) => {
  const { verdict: v, action } = c.plan;
  const rest = action.startsWith(`${v}：`) ? action.slice(v.length + 1) : action;
  return `<p class="pc-verdict"><b class="verdict-word ${VERDICT_CLS[v]}">${esc(v)}</b><b>${c.fill(rest)}</b></p>`;
};

/** 还差什么：会买的打法列没满足的条件（P14 是"上面几条都满足"，不列）。 */
function missingLine(c) {
  const left = c.r.checklist.filter((x) => x.status !== "满足" && x.need && x.id !== "P14");
  const body = left.length ? left.map((x) => `${ruleBtn(x.id)} ${esc(x.need)}`).join("；") + "。" : "条件都齐了。";
  return `<p class="missing"><span class="pl">还差</span>${body}</p>`;
}

/** 财报提醒（report.earnings）：止损那一格的依据。只是信息，不改打法。 */
const earningsNote = (c) => {
  const e = c.r.earnings;
  return e ? `<p class="pc-note" data-item="earnings">财报：${e.days} 天后（${esc(e.next)}）。财报后常跳空开盘，止损单按开盘价成交，可能比止损价差很多。只是提醒，不改打法。</p>` : "";
};
const checklistNote = (c) => checklist(c.r.checklist);
const riskNote = (c) => (c.plan.risk === null ? "" : `<span class="num muted">（${c.flat ? "风险" : "距止损"} ${c.plan.risk.toFixed(1)}%）</span>`);

/**
 * 找打法的格子，按交易者做决定的顺序（docs/adr/0029.md）。每格收计划里哪几条（plan.ts 条目的 label）：
 * main 是正文，basis 是依据，折叠在格子下面，规则编号跟着条目走。每条只进一格，表里没有的 label 直接报错（单元测试把每套打法都过一遍）。
 * lead：条目之前写的（结论、价位）；notes：依据里另加的（条件清单、财报）；empty：一条正文都没有时为什么没有，格子不消失。
 */
const CELLS = {
  flat: [
    { key: "go", title: "能不能做", main: ["进场门槛", "为什么", "小心"], lead: verdictLine },
    { key: "signal", title: "等什么信号", main: ["等什么", "再等", "位置", "失效"], basis: ["方向", "等多久"], notes: ["条件清单", checklistNote],
      lead: (c) => (c.buys ? missingLine(c) : "") },
    { key: "entry", title: "进场价", main: ["怎么进"], basis: ["触发价"],
      lead: (c) => priceLine(c.buys ? "触发价" : "先看", c.plan.trigger, c.close, c.buys ? "" : "（不是买点）"), empty: () => "这套打法空仓不买，没有进场价。" },
    { key: "stop", title: "止损", main: ["进场后止损"], basis: ["推演"], notes: ["财报", earningsNote],
      lead: (c) => priceLine("止损价", c.plan.stop, c.close, riskNote(c)), empty: () => "不进场，没有止损。" },
    { key: "target", title: "目标和盈亏比", main: ["目标", "到目标", "盈亏比"], basis: ["参考"],
      empty: (c) => (c.buys ? `算不了：${c.plan.trade.notes.join("；") || "目标位算不出"}。` : "不进场，不算目标和盈亏比。") },
    { key: "size", title: "仓位", main: ["股数"],
      empty: (c) => (c.buys ? `算不了：${c.plan.trade.notes.join("；") || "没有止损价"}。` : "不进场，不算股数。") },
  ],
  holding: [
    { key: "go", title: "拿着还是走", main: ["为什么", "别指望"], lead: verdictLine },
    { key: "signal", title: "盯什么信号", main: ["加仓", "减仓位", "软规则", "构造", "失效"], notes: ["条件清单", checklistNote],
      lead: (c) => priceLine("盯住", c.plan.trigger, c.close) },
    { key: "stop", title: "止损 / 离场价", main: ["止损"], basis: ["推演"], notes: ["财报", earningsNote],
      lead: (c) => priceLine("止损价", c.plan.stop, c.close, riskNote(c)), empty: () => "没有止损价。" },
    { key: "target", title: "目标", main: ["目标", "到目标"], basis: ["参考"],
      empty: (c) => `${c.plan.trade.notes.find((n) => n.includes("目标")) ?? "上方没有目标位"}。` },
    { key: "pnl", title: "浮盈 / 浮亏怎么办", main: ["盈亏", "仓位"],
      lead: (c) => (c.k === "holding" ? `<p class="pc-note">没填成本：在结论卡片的「持仓成本」填上，就按浮盈 / 浮亏给建议。</p>` : "") },
  ],
};
const NUMS = "①②③④⑤⑥";

/** 计划的一条：标签、正文、规则编号；推演求解给的标「辅助」，附评估结论。 */
const itemLi = (i, fill) => `<li${i.evidence ? ` class="aux"` : ""}><span class="pl">${i.evidence ? "辅助 · " : ""}${esc(i.label)}</span>${fill(i.text)}${
  i.rules?.length ? `<span class="plan-rules">${i.rules.map(ruleBtn).join("")}</span>` : ""}${i.evidence ? evidenceNote(i.evidence) : ""}</li>`;

/** 计划正文：按处境排成固定的格子；成本占位 {cost} 填上用户输入的成本。输入成本时只重画这一块。 */
export function planBody(r, p, close) {
  const k = situationOf(p, close);
  const flat = k === "flat";
  const plan = r.plans[k];
  const fill = (t) => esc(t).replaceAll("{cost}", k === "profit" || k === "loss" ? f2(parseCost(p.cost)) : "成本");
  const c = { r, k, flat, plan, close, fill, buys: r.plans.flat.trade.entry !== null };
  const cells = CELLS[flat ? "flat" : "holding"];
  const known = new Set(cells.flatMap((x) => [...x.main, ...(x.basis ?? [])]));
  const stray = plan.items.find((i) => !known.has(i.label));
  if (stray) throw new Error(`找打法的格子表里没有「${stray.label}」这一条（viz.js CELLS）`);
  const of = (labels = []) => plan.items.filter((i) => labels.includes(i.label));
  return `<ol class="plan-cells" data-plan="${flat ? "flat" : "holding"}">${cells.map((x, n) => {
    const main = of(x.main), basis = of(x.basis);
    const lead = x.lead?.(c) ?? "";
    const note = x.notes ? x.notes[1](c) : "";
    const names = [...basis.map((i) => i.label), ...(note ? [x.notes[0]] : [])];
    const body = lead || main.length ? lead + (main.length ? `<ul class="plan-items">${main.map((i) => itemLi(i, fill)).join("")}</ul>` : "")
      : `<p class="pc-empty">— ${esc(x.empty(c))}</p>`;
    const more = names.length ? `<details class="basis"><summary>依据 · ${esc(names.join("、"))}</summary>${
      basis.length ? `<ul class="plan-items">${basis.map((i) => itemLi(i, fill)).join("")}</ul>` : ""}${note}</details>` : "";
    return `<li class="pcell" data-cell="${x.key}"><div class="pc-head"><span class="pc-n">${NUMS[n]}</span><b class="pc-title">${x.title}</b></div><div class="pc-main">${body}</div>${more}</li>`;
  }).join("")}</ol>`;
}

/** 第 2 步：哪套打法（脚本原话折叠）；下面是按处境排好的格子（空仓 / 持仓切换）。 */
export function playAnswer(r, p, close) {
  const seg = Object.entries(POS).map(([k, label]) =>
    `<button type="button" data-pos="${k}" aria-pressed="${k === p.pos}">${label}</button>`).join("");
  return `<div class="answer play">
      <span class="ak">打法</span><b class="big">${esc(r.visual.trend)}：按「${esc(r.playKey)}」的打法</b>
      <details class="basis play-why"><summary>这套打法怎么说（脚本原话，带出处）</summary><p class="play-text"></p></details>
      <div class="pos-row"><span class="ak">具体做法</span><div class="pos-seg" role="group" aria-label="有没有仓位">${seg}</div></div>
      <div class="plan-body">${planBody(r, p, close)}</div>
    </div>`;
}

// ---------- 做推演：先给结论，再给推翻条件和关键变化；数据折叠在依据里（docs/adr/0030.md） ----------
const AUX_TAG = `<span class="aux-tag">辅助 · 推演求解</span>`;
const GROUP_CLS = { 向上: "bullish", 向下: "bearish" };

/**
 * 做推演的回答：① 模糊判断翻成的一句动作（大字），旁边是历史评估（H1）的小标签；② 推翻条件；③ 20、60 线组最近的关键变化。
 * 推演求解给的那几句标「辅助」，末尾一行 H4 的评估结论。
 */
export function forecastAnswer(r) {
  const f = r.forecast, l = r.visual.lean;
  const groups = f.groups.map((g) => `<li data-group="${g.group}"><b class="fc-g">${g.group} 线组</b><b class="fc-dir ${GROUP_CLS[g.now] ?? "neutral"}">${esc(g.now)}</b>`
    + `<span class="fc-gt">${esc(g.text)}</span>${g.aux ? `<span class="fc-aux">${esc(g.aux)}${AUX_TAG}</span>` : ""}</li>`).join("");
  const anyAux = f.aux.includes("invalid") || f.groups.some((g) => g.aux);
  return `<div class="answer forecast">
      <div class="fc-call ${stanceOf(l)}" data-part="call">
        <div class="fc-eyebrow"><span class="ak">模糊判断 · 接下来几周</span><b class="fc-label">${esc(l.label)}</b>`
    + `<span class="ev-tag fc-h1" tabindex="0" ${tip(f.leanEvidence.tip)}>${esc(f.leanEvidence.tag)}</span></div>
        <p class="fc-headline">${esc(f.headline)}</p>
        <p class="fc-basis">依据（只看 ${f.days} 天，不预测明天涨跌）：${esc(f.hold)}</p>
      </div>
      <p class="fc-invalid" data-part="invalid"><span class="pl">推翻条件</span>${esc(f.invalid.text)}${f.aux.includes("invalid") ? AUX_TAG : ""}</p>
      <div class="fc-changes" data-part="changes"><span class="pl">最近的关键变化</span><ul>${groups}</ul></div>
      ${anyAux ? evidenceNote(f.evidence) : ""}
    </div>`;
}

/**
 * 看大局的证据：按脚本的判断顺序排成四问（rules.md J1–J7）。
 * ① 60/120 线组次序和方向 → 有没有类型；② 60 线几点钟 → 稳定还是横盘；③ 钟表或乖离 → 是不是加速；④ 20 线组走到哪一步 → 阶段。
 */
function bigPictureEvidence(v) {
  const r = v.regime;
  const pctl = Math.round(v.bias.pctl * 100);
  const SIDE = { 1: "多头", 0: "不一致", [-1]: "空头" };
  const WAY = { 1: "向上", 0: "不一致", [-1]: "向下" };
  const check = (n, q, judge, body = "") =>
    `<section class="check"><h3>${n} ${q}</h3><p class="judge">${judge}</p>${body}</section>`;
  return `<p class="evidence-title">证据：类型 × 阶段是按下面的顺序判出来的</p>`
    + check("①", "60/120 线组排好了吗？", `次序${SIDE[r.order]}，60 线组${WAY[r.dir60]}、120 线组${WAY[r.dir120]} → <b>${r.type ? "有类型" : "定不出类型，按 20/60 的结构命名"}</b>`,
      ladder(v))
    + check("②", "60 线几点钟？", `MA60 ${r.clock60.angle >= 0 ? "+" : ""}${r.clock60.angle.toFixed(0)}°，${esc(r.clock60.hour)}（2 点半到 3 点半算走平，1 点钟以上算加速）；6 条线相差 ${v.spread.toFixed(1)}% → <b>${r.type === "横盘" ? "横盘" : r.type ? "有斜率" : "不看"}</b>`)
    + check("③", "是不是加速？", `离 20 线 ${pct(v.bias.value)}，在自身历史排 ${pctl}% 分位（两端各 ${Math.round((1 - v.bias.extreme) * 100)}% 算大幅乖离）→ <b>${r.accel ? `加速出现在${{ 起点: "趋势刚开始", 末端: "趋势即将结束" }[r.accel.phase] ?? esc(r.accel.phase)}` : "不是加速"}</b>`,
      biasMeter(v))
    + check("④", "20 线组走到哪一步？", `${r.stage ? `${esc(r.stage)}${r.depth ? `（${esc(r.depth)}）` : ""}` : esc(r.name)}：破线、拐头算回撤，交叉了算转折。`,
      fiveSteps(v) + crossTable(v))
    + check("⑤", "周线、小时线怎么排？", `${frameText("周线", v.weekly)} ${ruleBtn("J11")}；${frameText("小时线", v.hourly)} ${ruleBtn("P13")}`)
    + `<p class="check-sum">所以是 <b>${esc(v.trend)}</b>。</p>`
    + `<details class="ref"><summary>趋势类型对照（现在是哪一种）</summary>${trendTable(v)}</details>`;
}

/** 每一步的证据（结论在 step-answer 里）。做推演的数据全部折叠在「依据」里，默认收起；f 是做推演的回答（跨度、条件最早哪天、求解的评估结论）。 */
export function stepVisuals(key, v, f) {
  const days = f.days;
  if (key === "big_picture") return bigPictureEvidence(v);
  if (key === "play") return allRules(v);
  if (key === "forecast") {
    const long = { ...v, hurdles: v.hurdles.filter((h) => h.days === days) };
    return `<details class="ref more fc-data"><summary>依据：打法的条件、门槛路径、模糊判断的证据、抵扣价、持平情景、全部求解</summary>`
      + `<p class="fc-earliest"><span class="pl">打法的条件最早哪天齐</span>${esc(f.earliest)}${f.aux.includes("earliest") ? AUX_TAG : ""}</p>`
      + (f.solves.length ? `<p class="evidence-title">和这套打法有关的求解（${days} 天，辅助）</p>${solveList(f.solves)}` : "")
      + `<p class="evidence-title">MA60、MA120 未来 ${days} 天要扣掉的价格里最高、最低是多少</p>` + hurdleTable(long)
      + `<div class="lean-box">${leanCard(v.lean, v.close, v.tie)}</div>`
      + dropMultiples(v) + hurdleTable(v) + scenarioFlow(v) + solveList(v.solves) + evidenceNote(f.evidence) + `</details>`;
  }
  return "";
}
