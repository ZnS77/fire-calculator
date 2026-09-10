/* 界面绑定。所有计算逻辑在 engine / pension / child / house，本文件只负责读写 DOM。 */
import * as E from './engine';
import * as P from './pension';
import * as CH from './child';
import * as HO from './house';
import * as C from './charts';
import { cny, cnyFull, parseAmount, pct } from './format';
import { METHOD_HTML } from './method';
import { Age, CashEvent, FireInput, SimResult, SolveResult, age, rate, real } from './types';

const STORE_KEY = 'fire-calc-v1';
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** 百分点显示。医疗溢价是「相对 CPI 的差」，写成 pp 而不是 %，免得和绝对值混起来。 */
const pp = (r: number): string => '+' + (r * 100).toFixed(1) + 'pp';

interface PensionCfg {
  on: boolean; joinAge: number; socialAvg: number; baseMode: P.BaseMode;
  monthlyIncome: number; socialGrowth: number; accountRate: number;
  claimAge: number; cola: number; keepPaying: boolean;
}

/** 生活模块与养老金一样，各自独立存配置，不往 input.events 里塞东西 ——
 * 用户手填的时间轴事件必须始终只有用户自己填的那几行。 */
interface State {
  input: FireInput; pension: PensionCfg;
  child: CH.ChildCfg; house: HO.HouseCfg;
  showReal: boolean;
}

const DEFAULT_PENSION: PensionCfg = {
  on: false, joinAge: 22, socialAvg: 12434, baseMode: 'income',
  monthlyIncome: 25000, socialGrowth: 0.04,
  accountRate: P.defaultAccountRate(0.04) as number,
  claimAge: 63, cola: P.COLA.neutral as number, keepPaying: false
};

const freshState = (): State => ({
  input: structuredClone(E.DEFAULTS),
  pension: { ...DEFAULT_PENSION },
  child: structuredClone(CH.DEFAULT_CHILD),
  house: { ...HO.DEFAULT_HOUSE },
  showReal: true
});

let st: State = freshState();

// ---- 持久化（读写都包 try/catch）----------------------------------------
function save(): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(st)); } catch { /* 忽略 */ }
}
function load(): void {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const p = JSON.parse(raw) as Partial<State>;
    if (p.input)   st.input   = migrate({ ...E.DEFAULTS, ...p.input });
    if (p.pension) st.pension = { ...DEFAULT_PENSION, ...p.pension };
    // 老存档没有这两个字段，浅合并后就是默认值（两个模块都 enabled: false，零影响）
    if (p.child)   st.child   = { ...CH.DEFAULT_CHILD, ...p.child };
    if (p.house)   st.house   = HO.migrateCfg(p.house);
    if (typeof p.showReal === 'boolean') st.showReal = p.showReal;
  } catch { /* 坏数据就用默认值 */ }
}

/** 老存档 / 老导出 JSON 的字段迁移。
 *
 * `medInflation`（医疗通胀绝对值）在 2026-09 改成了 `medPremium`（相对 CPI 的溢价）。
 * 展开式 `{ ...DEFAULTS, ...p.input }` 会把已经不存在的老字段原样带进来，
 * 而 medPremium 拿到新默认值 —— 存档里于是同时躺着两个字段，引擎只读新的。
 * 这里把老字段删掉，避免它一直跟着导出的 JSON 传播。
 *
 * 不把老值反解成 premium（`medInflation − cpi`）是故意的：老的 6% 本身就是错的
 * （依据用错了口径，见 docs/参数依据.md），反解只会把错误换个形式保留下来。
 * 让它回到新默认的 2.0pp 更好。 */
function migrate(i: FireInput): FireInput {
  delete (i as Partial<FireInput> & { medInflation?: unknown }).medInflation;
  return i;
}

/* 购房配置的字段迁移在 house.ts（`HO.migrateCfg`）：它要懂老的城市档位面积，
 * 是购房域的知识，放在那边才测得到。那次是**换算**不是丢弃，理由见函数注释。 */

// ---- 生活模块 → 现金流事件 -----------------------------------------------
/* 两个模块的外部参数刻意不复用 FireInput 的字段名，所以在这里做一次显式映射。
 * 注意 medPremium 是「相对 CPI 的溢价」，和这两个模块都无关，不要误传。 */
const childCtx = (i: FireInput): CH.ChildCtx =>
  ({ currentAge: i.currentAge, cpi: i.cpi, spendGrowth: i.personalInflation });

const houseCtx = (i: FireInput): HO.HouseCtx =>
  ({ currentAge: i.currentAge, deathAge: i.deathAge,
     cpi: i.cpi, spendInflation: i.personalInflation });

/** 把子女 / 购房事件并进一份 input。两个模块的事件是**静态**的（只依赖 input 本身，
 * 不依赖 FIRE 年龄），所以先注入、再交给要迭代求不动点的 solveWithPension。
 * 两个模块都关闭时返回原对象，对现有结果零影响。 */
function withModules(input: FireInput): FireInput {
  const evs = [
    ...CH.childEvents(st.child, childCtx(input)),
    ...HO.houseEvents(st.house, houseCtx(input))
  ];
  return evs.length === 0 ? input : { ...input, events: [...input.events, ...evs] };
}

// ---- 养老金 → 现金流事件 -------------------------------------------------
/** 养老金依赖 FIRE 年龄，而 FIRE 年龄又依赖养老金 —— 迭代两轮取不动点。
 * 实测两轮即收敛：第一轮用无养老金的解当停缴年龄，第二轮用它重算。 */
/** 返回 used：最终真正拿去求解的那份 input（已注入养老金事件）。
 * 结论区的二次求解必须用它，否则口径和展示出来的 FIRE 年龄对不上。 */
function solveWithPension(input0: FireInput, pc: PensionCfg): {
  res: SolveResult; pension: P.PensionResult | null; used: FireInput;
} {
  // 敏感性扫描会改 deathAge / reserve 再调进来，购房模块的事件区间依赖 deathAge，
  // 所以注入放在这里而不是调用方 —— 每一次扫描都用当时那份 input 重新生成事件。
  const input = withModules(input0);
  if (!pc.on) return { res: E.solve(input), pension: null, used: input };
  let stopAge: number = E.solve(input).fireAge ?? input.currentAge;
  let pr = projectPension(input, pc, stopAge);
  let used: FireInput = { ...input, events: [...input.events, ...pensionEvents(input, pc, pr, stopAge)] };
  let res = E.solve(used);
  for (let i = 0; i < 2; i++) {
    const next = res.fireAge ?? stopAge;
    if (next === stopAge) break;
    stopAge = next;
    pr = projectPension(input, pc, stopAge);
    used = { ...input, events: [...input.events, ...pensionEvents(input, pc, pr, stopAge)] };
    res = E.solve(used);
  }
  return { res, pension: pr, used };
}

function projectPension(input: FireInput, pc: PensionCfg, stopAge: number): P.PensionResult {
  return P.project({
    currentAge: input.currentAge, joinAge: pc.joinAge, stopAge,
    claimAge: pc.claimAge, keepPaying: pc.keepPaying,
    socialAvg: pc.socialAvg, socialGrowth: rate(pc.socialGrowth),
    monthlyIncome: pc.monthlyIncome, incomeGrowth: input.incomeGrowth,
    capIncomeGrowthAt: input.capIncomeGrowthAt,
    // 天花板按「税前月薪 / 税后年收入」的比例换算过来，沿用用户自己填的口径差
    monthlyIncomeCeiling: input.incomeCeiling !== null && input.annualIncome > 0
      ? pc.monthlyIncome * (input.incomeCeiling / input.annualIncome)
      : null,
    cpi: input.cpi,
    baseMode: pc.baseMode, accountRate: rate(pc.accountRate),
    currentYear: new Date().getFullYear()
  });
}

function pensionEvents(
  input: FireInput, pc: PensionCfg, pr: P.PensionResult, stopAge: number
): CashEvent[] {
  const evs = [P.toEvent(pr, {
    currentAge: input.currentAge, deathAge: input.deathAge, colaRate: rate(pc.cola)
  })];
  // 续缴的自付成本从实际停止工作那年起，缴到法定领取年龄为止
  if (pc.keepPaying) {
    evs.push(P.toSelfPayEvent(pr, {
      currentAge: input.currentAge, stopAge, socialGrowth: rate(pc.socialGrowth)
    }));
  }
  return evs;
}

// ---- 渲染 ---------------------------------------------------------------
const fmtY = (v: number): string => cny(v);

function render(): void {
  const { input, pension: pc } = st;
  const { res, pension: pr, used } = solveWithPension(input, pc);
  const d = E.derive(input, res);
  const sim = res.sim;

  renderVerdict(res, d, pr, used);
  renderPensionOut(pr);
  renderChildOut();
  renderHouseOut();

  C.assetPath($('c1'), $('t1'), {
    rows: sim.rows, showReal: st.showReal, fireAge: res.fireAge,
    target: st.showReal ? (sim.targetReal as number) : (sim.targetNominal as number),
    peakAge: d.peakAge, bankruptAge: sim.bankruptAge, fmtY
  });

  // 图 2：死亡年龄 → FIRE 年龄
  const deathPts: C.SensPoint[] = [];
  for (let da = 65; da <= 105; da++) {
    const r = solveWithPension({ ...input, deathAge: age(da) }, pc).res;
    deathPts.push({ x: da, fireAge: r.fireAge });
  }
  C.sensitivity($('c2'), $('t2'), {
    points: deathPts, currentX: input.deathAge as number,
    fmtX: v => Math.round(v) + '岁', fmtXFull: v => '活到 ' + Math.round(v) + ' 岁'
  });

  // 图 3：预留金 → FIRE 年龄
  const maxRes = Math.max(2_000_000, (input.reserve as number) * 2);
  const stepRes = maxRes / 30;
  const resPts: C.SensPoint[] = [];
  for (let i = 0; i <= 30; i++) {
    const v = Math.round(i * stepRes);
    const r = solveWithPension({ ...input, reserve: real(v) }, pc).res;
    resPts.push({ x: v, fireAge: r.fireAge });
  }
  C.sensitivity($('c3'), $('t3'), {
    points: resPts, currentX: null,
    fmtX: v => cny(v), fmtXFull: v => '留下 ' + cnyFull(v)
  });

  renderStress(res);
  renderTable(sim);
  renderSaveRate();
  renderRetireSpend();
  renderCeiling();
  renderCurveNote();
  renderBlockSummaries();
  save();
}

function renderVerdict(
  res: SolveResult, d: E.Derived, pr: P.PensionResult | null, used: FireInput
): void {
  const box = $('verdict');
  const { input } = st;
  const sim = res.sim;
  box.className = 'verdict' + (res.reason === 'never' ? ' never'
    : res.reason === 'already' ? ' already' : '');

  const reserveNominal = sim.targetNominal as number;
  const years = input.deathAge - input.currentAge;

  // 中文没有词边界，长句会在词中间断行 —— 拆成主句 + 副句，不靠 text-wrap 兜底
  let hero = '', sub = '', lines = '';
  if (res.reason === 'already') {
    hero = '你现在就可以退休';
    sub = `资产已经够撑到 ${input.deathAge} 岁，并留下应急金`;
  } else if (res.reason === 'never') {
    hero = '当前参数下无法 FIRE';
    // 失败有两种，成因和解法完全不同，不能共用一句「缺口」：
    //
    //   1. 期末不够 —— 一路没断过，只是撑到规划终止年龄时凑不齐应急金。
    //   2. 中途断供 —— 某一年资产被打成负数（典型是购房首付、或一笔大额事件
    //      落在资产还没攒起来的年份）。这种情况下曲线后来可能靠工资涨回来，
    //      期末余额甚至远高于应急金 —— 此时 targetNominal − endNominal 是个
    //      负数，把它当「缺口」显示出来就是一句胡话。
    //
    // 之前这里只写了第 1 种。没有大额一次性支出时几乎碰不到第 2 种，
    // 购房模块进来之后它变成了常见情形。
    const bankruptAge = sim.bankruptAge as number | null;
    if (bankruptAge !== null) {
      const low = sim.rows.reduce((m, r) =>
        (r.endNominal as number) < (m.endNominal as number) ? r : m, sim.rows[0]!);
      sub = `${bankruptAge} 岁那年资金链就断了`;
      lines += line('最低点', `<b>${cny(low.endNominal)}</b>出现在 ${low.age} 岁`, true);
      lines += line('这不是「攒不够」', '是中途某一年付不出来 —— 期末余额反而是 '
        + cny(sim.endNominal) + '。先把那笔支出往后挪或调小，再看退休年龄');
    } else {
      const gap = (sim.targetNominal as number) - (sim.endNominal as number);
      sub = `干到 ${input.deathAge} 岁仍有缺口`;
      lines += line('资金缺口', `<b>${cny(gap)}</b>`, true);
    }
    lines += line('可行的方向', '提高收入 · 压缩支出 · 降低预留金 · 调低预期收益');
  } else {
    hero = `你可以在 <em>${res.fireAge}</em> 岁退休`;
    sub = `还有 ${res.yearsToFire} 年`;
  }

  if (res.fireAge !== null) {
    lines += line('届时需要攒到',
      `<b>${cny(d.fireNominal)}</b>今日购买力 ${cny(d.fireReal)}`);
    lines += line(`${input.deathAge} 岁时留下`,
      `<b>${cny(sim.endNominal)}</b>今日购买力 ${cny(sim.endReal)}`);
    // 退休年龄按整年扫描，「刚好不够」和「够了」之间隔着一整年工资，跨过去必然
    // 剩下一大笔。不解释的话用户会以为是应急金没生效 —— 顺便给个可操作的数字。
    const surplus = (sim.endNominal as number) - (sim.targetNominal as number);
    if (surplus > Math.max((sim.targetNominal as number) * 0.02, 1)) {
      lines += line('为什么有剩余', res.reason === 'already'
        ? `当前资产已超过撑到 ${input.deathAge} 岁所需`
        : '退休年龄按整年取，最后一年工资全部变成了遗产');
      const room = E.solveSpend(used, res.fireAge);
      if (room !== null && room > (input.annualSpend as number) * 1.02) {
        lines += line('可以多花', `年支出提到 <b>${cny(room)}</b>才刚好花完`);
      }
    }
    if (d.swr !== null && d.swrBench !== null) {
      const okSwr = d.swr <= d.swrBench;
      lines += line('首年提取率',
        `<b>${pct(d.swr, 2)}</b>${input.deathAge - res.fireAge} 年期建议 ≤ ${pct(d.swrBench, 2)}` +
        (okSwr ? '' : '，偏高'), !okSwr);
    }
  }
  if ((input.reserve as number) > 0) {
    lines += line('应急金的真实代价',
      `<b>${cny(reserveNominal)}</b>今天的 ${cny(input.reserve)}，` +
      `${years} 年后按医疗通胀 ${pct(input.cpi + input.medPremium)}` +
      `（CPI ${pct(input.cpi)} + 溢价 ${pp(input.medPremium)}）滚成这个数`);
  }
  if (pr) {
    lines += pr.qualified
      ? line('基本养老金',
          `<b>${cnyFull(pr.monthly / Math.pow(1 + input.cpi, pr.claimAge - input.currentAge))}</b>` +
          `／月（今日购买力）· ${pr.claimAge} 岁起 · 已缴 ${pr.years} 年`)
      : line('基本养老金',
          `缴费仅 ${pr.years} 年，距最低要求 ${pr.requiredYears} 年还差 ` +
          `<b>${pr.shortfallYears}</b> 年，无法按月领取`, true);
  }
  box.innerHTML =
    `<div><p class="hero">${hero}</p>` +
    (sub ? `<p class="hero-sub">${sub}</p>` : '') + `</div>` +
    `<div class="verdict-lines">${lines}</div>`;
}

/** 结论区的一格 stat tile：标签用小型大写，数值用等宽制表 */
const line = (k: string, v: string, alert = false): string =>
  `<div class="vl${alert ? ' alert' : ''}"><div class="vl-k">${k}</div><div class="vl-v">${v}</div></div>`;

/** 储蓄率是判断 FIRE 可行性最直觉的单一指标，显示在支出输入框下方。 */
function renderSaveRate(): void {
  const inc = st.input.annualIncome as number;
  const sp = st.input.annualSpend as number;
  const box = $('h_saverate');
  if (inc <= 0) { box.textContent = ''; return; }
  const r = (inc - sp) / inc;
  box.innerHTML = `当前储蓄率 <b>${pct(r)}</b>` +
    (r <= 0 ? ' — 入不敷出，资产只会减少'
     : r < 0.2 ? ' — 偏低，FIRE 会很遥远'
     : r > 0.5 ? ' — 很高' : '');
}

/** 退休后支出系数的人话解释：直接把折算后的年支出打出来 */
/** 曲线模式下，把峰值那年的实际收入直接算给用户看 */
function renderCurveNote(): void {
  const box = document.getElementById('h_curveNote');
  if (!box) return;
  const m = st.input.incomeModel;
  if (m.kind !== 'curve') { box.innerHTML = ''; return; }
  const c = m.curve;
  const now = st.input.annualIncome as number;
  const shape = E.incomeCurveAt(c, c.peakAge) / E.incomeCurveAt(c, st.input.currentAge);
  const t = Math.max(0, c.peakAge - st.input.currentAge);
  const atPeak = now * shape * Math.pow(1 + st.input.realWageGrowth, t);
  box.innerHTML =
    `按这条曲线，你在 <b>${c.peakAge} 岁</b>达到收入峰值 ` +
    `<b>${cny(atPeak)}</b>（今日购买力），现在是 ${cny(now)}。` +
    `<br>曲线本身已剔除通胀与全社会工资增长 —— 它描述的是你相对同龄同行的位置。`;
}

/** 天花板是「今日购买力」，但逐年明细显示的是名义值 —— 两者对不上时
 * 用户会以为天花板没生效。这里把换算显式打出来。 */
function renderCeiling(): void {
  const box = document.getElementById('h_ceiling');
  if (!box) return;
  const c = st.input.incomeCeiling;
  if (c === null) {
    box.innerHTML = '未启用。没有天花板的复利在 20 年尺度上会给出荒谬的收入 —— ' +
      '年薪 30 万按 4% 涨 30 年是 97 万，按 6% 是 172 万。这是模型最容易失真的地方。';
    return;
  }
  if (st.input.incomeCeilingInflates) {
    const rows = [10, 20, 30].map(n => {
      const nom = (c as number) * Math.pow(1 + st.input.cpi, n);
      return `${st.input.currentAge + n} 岁 ${cny(nom)}`;
    }).join(' · ');
    box.innerHTML =
      `当前按<b>今日购买力</b>理解：职级对应的实际购买力不变，名义天花板逐年上移。<br>` +
      `所以「逐年明细」里的收入会停在这些<b>名义</b>值上：${rows}。<br>` +
      `<span style="color:var(--ink2)">看到比 ${cny(c)} 大不是没生效，是通胀。</span>`;
  } else {
    const n = 30;
    const realAt = (c as number) / Math.pow(1 + st.input.cpi, n);
    box.innerHTML =
      `当前是<b>固定名义值</b>：收入永远不超过 ${cny(c)} 这个数字本身，` +
      `实际购买力被通胀一年年吃掉 —— ${st.input.currentAge + n} 岁时它只相当于今天的 ` +
      `<b>${cny(realAt)}</b>。<br>` +
      `<span style="color:var(--ink2)">更悲观，但接近很多人的真实处境：` +
      `名义工资停涨之后，购买力是一直在退的。</span>`;
  }
}

function renderRetireSpend(): void {
  const box = document.getElementById('h_retireSpend');
  if (!box) return;
  const r = st.input.retireSpendRatio as number;
  const now = st.input.annualSpend as number;
  const after = now * r;
  const desc = r < 0.75 ? '通勤、房贷、育儿这些没了'
    : r < 0.95 ? '略低于现在'
    : r <= 1.05 ? '和现在差不多'
    : '比现在花得多（旅行、爱好）';
  box.innerHTML =
    `退休后每年花 <b>${cny(after)}</b>（今日购买力），现在是 ${cny(now)} —— ${desc}。` +
    `这是一次性的水平位移，与下方「支出微笑曲线」的逐年漂移独立、可叠加。`;
}

function renderPensionOut(pr: P.PensionResult | null): void {
  const box = $('pensionOut');
  if (!pr) { box.innerHTML = ''; return; }
  const spread = st.pension.socialGrowth - st.pension.accountRate;
  const t = pr.claimAge - st.input.currentAge;
  const defl = Math.pow(1 + st.input.cpi, t);        // 折成今日购买力
  const idxDrop = pr.indexLast < pr.indexFirst - 0.01;

  box.innerHTML =
    `<table><tbody>
      <tr><td>缴费年限</td><td>${pr.years.toFixed(0)} 年 · 要求 ${pr.requiredYears} 年
        <span class="pill ${pr.qualified ? 'ok' : 'bad'}">${pr.qualified ? '达标' : '不达标'}</span></td></tr>
      <tr><td>缴费指数</td><td>均 ${pr.avgIndex.toFixed(2)}
        ${idxDrop ? `· ${pr.indexFirst.toFixed(2)} → ${pr.indexLast.toFixed(2)}` : ''}
        ${pr.cappedAtCeiling ? '<span class="pill bad">已顶格</span>' : ''}</td></tr>
      <tr><td>个人账户储存额</td><td>${cny(pr.account)}</td></tr>
      <tr><td>基础养老金</td><td>${cnyFull(pr.basic)} / 月</td></tr>
      <tr><td>个人账户养老金</td><td>${cnyFull(pr.accountPension)} / 月 · 计发月数 ${pr.months}</td></tr>
      <tr><td><b>合计（名义）</b></td><td class="big">${cnyFull(pr.monthly)} / 月</td></tr>
      <tr><td><b>合计（今日购买力）</b></td><td class="big">${cnyFull(pr.monthly / defl)} / 月</td></tr>
      <tr><td>相对当年计发基数</td><td>${pct(pr.monthly / pr.payBase)}</td></tr>
      ${pr.selfPayAnnualFirst > 0
        ? `<tr><td>续缴首年成本</td><td>${cnyFull(pr.selfPayAnnualFirst)} / 年</td></tr>` : ''}
    </tbody></table>` +
    `<div class="hint" style="margin-top:8px">
      名义值是 ${new Date().getFullYear() + t} 年那时的金额，被 ${t} 年的社平增长放大过 ——
      判断够不够花请看「今日购买力」那一行。</div>` +
    // 弹性提前退休最多提前 3 年，且不得低于原法定退休年龄（男 60 / 女干部 55 / 女工人 50）
    (pr.claimAge < 60
      ? `<div class="hint"><span class="pill bad">超出法规</span>
         领取年龄设成了 ${pr.claimAge} 岁。延迟退休后男性法定为 63 岁，弹性提前最多 3 年
         且<b>不得低于原法定年龄</b>（男 60 / 女干部 55 / 女工人 50）。
         男性设到 60 以下、女干部设到 55 以下拿不到，这个测算只是假设值。</div>`
      : '') +
    (idxDrop
      ? `<div class="hint">工资封顶后社平仍在涨，缴费指数从 <b>${pr.indexFirst.toFixed(2)}</b>
         滑到 <b>${pr.indexLast.toFixed(2)}</b>，基础养老金随之被拉低。</div>`
      : '') +
    (pr.cappedAtCeiling
      ? `<div class="hint">收入已超过当地社平的 300%，缴费基数被<b>顶格</b>钳住 ——
         超出部分不计入养老金。</div>`
      : '') +
    (spread > 0
      ? `<div class="hint">记账利率比社平增长低 ${(spread * 100).toFixed(2)}pp，
         个人账户那部分待遇会被持续稀释 —— 这是结构性的，不是参数没调好。</div>`
      : '');
}

/** 子女模块的读数。
 *
 * 这里最重要的一个数是「本年因子女增加的支出」。用户看到它就能立刻判断离不离谱，
 * 从而发现自己是不是把孩子的开销算了两遍 —— 比在输入框旁边写任何提示都管用。
 * 它可能是负数（用户声明的当前花费大于所选档位的成本），那不是 bug，是「档选低了」，
 * 所以不 clamp 到 0，如实显示并解释。 */
function renderChildOut(): void {
  const box = document.getElementById('childOut');
  if (!box) return;
  const cfg = st.child;
  if (!cfg.enabled) { box.innerHTML = ''; return; }

  const ctx = childCtx(st.input);
  const delta = CH.childSpendThisYear(cfg, ctx);
  const evs = CH.childEvents(cfg, ctx);
  // 今日购买力口径的合计：金额 × 年数，不叠通胀、不贴现。
  // 与卡片上的「0—22 岁合计」同口径，只是把补贴与已计入部分的抵扣也算了进去。
  const netTotal = evs.reduce(
    (s, e) => s - (e.amount as number) * (e.endAge - e.startAge), 0);
  const lastAge = evs.reduce((m, e) => Math.max(m, e.endAge as number), st.input.currentAge as number);
  const hasBorn = cfg.children.some(c => c.kind === 'born');

  box.innerHTML =
    `<table><tbody>
      <tr><td><b>本年因子女增加的支出</b></td>
        <td class="big">${cny(delta)}</td></tr>
      <tr><td>今后净增合计（今日购买力）</td><td>${cny(netTotal)}</td></tr>
      <tr><td>最后一笔</td><td>${Math.round(lastAge - 1)} 岁</td></tr>
      <tr><td>生成的现金流条目</td><td>${evs.length} 项</td></tr>
    </tbody></table>` +
    (delta < 0
      ? `<div class="hint"><span class="pill bad">负数</span>
         你声明的当前花费高于所选档位的成本，净效果是<b>省钱</b> —— 多半是档选低了。</div>`
      : '') +
    (hasBorn
      ? `<div class="hint">已出生的孩子按「档位成本 − 你声明的当前花费」计增量，两边口径必须一致。</div>`
      : '');
}

/** 购房模块的读数。三个利率并排摆，不给「该买」或「该租」的结论，只摆数字。 */
function renderHouseOut(): void {
  const box = document.getElementById('houseOut');
  if (!box) return;
  const cfg = st.house;
  if (!cfg.enabled) { box.innerHTML = ''; return; }

  const r = HO.project(cfg, houseCtx(st.input));
  const cash = cfg.payMode === 'cash';
  const gapYears = cfg.buyAge - (st.input.currentAge as number);
  const total = HO.totalPrice(cfg);
  // 回报率旁边必须挂住这条：默认租金是全国均值换算来的，跟具体这套房没关系
  const yieldNote = cfg.marketMonthlyRent === HO.rentFor(cfg.areaSqm)
    ? `月租金还是全国均值换算来的默认值，与你这套房无关 ——
       这个回报率只是占位数，查到实际租金就改掉。`
    : '';

  box.innerHTML =
    `<div class="trio">
      <div class="trio-i"><div class="trio-k">租金回报率</div>
        <div class="trio-v">${pct(r.rentYield, 2)}</div></div>
      <div class="trio-i"><div class="trio-k">贷款利率${cash ? '' : '（本金加权）'}</div>
        <div class="trio-v">${cash ? '—' : pct(r.loanRate, 2)}</div></div>
      <div class="trio-i"><div class="trio-k">扣通胀后实际</div>
        <div class="trio-v">${cash ? '—' : pct(r.realLoanRate, 2)}</div></div>
     </div>` +
    (cash
      ? `<div class="hint">全款没有贷款利率。要比的是投资组合收益率 ${pct(st.input.rWork, 1)}
         与租金回报率 ${pct(r.rentYield, 2)}。</div>`
      : `<div class="hint">贷款利率按<b>商贷与公积金本金加权</b>（商贷 ${pct(cfg.comRate, 2)} /
         公积金 ${pct(cfg.hpfRate, 2)}）。${r.cashGap > 0
            ? `它比租金回报率高 ${((r.loanRate - r.rentYield) * 100).toFixed(2)}pp，
               对应每年约 <b>${cny(r.cashGap)}</b> 的现金流缺口。`
            : `它已低于租金回报率，按现金流口径每年反而多出约 <b>${cny(-r.cashGap)}</b>。`}</div>`) +
    (yieldNote ? `<div class="hint"><span class="pill bad">默认值</span> ${yieldNote}</div>` : '') +
    `<table><tbody>
      <tr><td>单价 × 面积</td><td>${Math.round(cfg.pricePerSqm).toLocaleString('zh-CN')} 元/㎡
        × ${cfg.areaSqm}㎡ = <b>${cny(total)}</b></td></tr>
      <tr><td>购房当年总价</td><td>${cny(r.priceAtBuy)}${
        gapYears > 0 && (cfg.priceGrowth as number) !== 0
          ? ` <span class="hint" style="margin:0;display:inline">${cfg.buyAge} 岁那年的名义价，
              今天是 ${cny(total)}</span>` : ''}</td></tr>
      <tr><td>首付</td><td class="big">${cny(r.downPayment)}</td></tr>
      <tr><td>税费（契税+中介）</td><td>${cny(r.buyCost)}</td></tr>
      ${cash ? '' : `<tr><td>贷款（商贷 / 公积金）</td>
        <td>${cny(r.comPrincipal)} / ${cny(r.hpfPrincipal)}</td></tr>
      <tr><td><b>月供合计（名义固定）</b></td><td class="big">${cnyFull(r.monthlyTotal)} / 月</td></tr>
      <tr><td>名义总利息</td><td>${cny(r.interestTotal)}</td></tr>`}
      <tr><td>年持有成本（物业+维修）</td><td>${cny(r.annualHoldCost)}</td></tr>
      <tr><td>每月住房净增</td><td>${cnyFull(r.netMonthlyDelta)} / 月</td></tr>
    </tbody></table>` +
    (r.hpfShortfall > 0
      ? `<div class="hint"><span class="pill bad">额度不足</span>
         超出额度的 <b>${cny(r.hpfShortfall)}</b> 自动进了首付，所以首付高于
         「首付比 × 总价」（${cny(r.priceAtBuy * (cfg.downRatio as number))}）。这不是算错。</div>`
      : '') +
    (cash ? '' :
      `<div class="hint">月供<b>名义固定</b>：按当前 CPI ${pct(st.input.cpi, 1)}，
         第 ${cfg.loanYears} 年那笔 ${cnyFull(r.monthlyTotal)} 只相当于今天的
         <b>${cnyFull(r.lastPaymentToday)}</b>，整个还款期的实际负担比名义总额低
         <b>${pct(r.inflationEatenRatio, 1)}</b>。</div>`) +
    (cfg.sellOn && cfg.sellAge > cfg.buyAge
      ? `<div class="hint">${cfg.sellAge} 岁卖出：名义毛价 ${cny(r.sellGross)}，
         扣卖出成本与剩余贷款 ${cny(r.sellDebt)} 后净得 <b>${cny(r.sellNet)}</b>，
         之后重新开始付房租。</div>`
      : '');
}

/** 压力测试。恒定收益率模型看不见序列收益风险，此表只测参数敏感度。 */
function renderStress(baseRes: SolveResult): void {
  const { input, pension: pc } = st;
  const scen: Array<{ name: string; over: Partial<FireInput> }> = [
    { name: '基准', over: {} },
    { name: '收益率 −1%', over: { rWork: rate(input.rWork - 0.01), rRetire: rate(input.rRetire - 0.01) } },
    { name: '通胀 +1%', over: { personalInflation: rate(input.personalInflation + 0.01) } },
    { name: '年支出 +10%', over: { annualSpend: real(input.annualSpend * 1.1) } },
    { name: '三者同时（悲观）', over: {
        rWork: rate(input.rWork - 0.01), rRetire: rate(input.rRetire - 0.01),
        personalInflation: rate(input.personalInflation + 0.01),
        annualSpend: real(input.annualSpend * 1.1) } }
  ];
  const rows = scen.map(s => {
    const r = s.name === '基准' ? baseRes : solveWithPension({ ...input, ...s.over }, pc).res;
    return { name: s.name, fireAge: r.fireAge, endReal: r.sim.endReal as number };
  });
  const baseAge = rows[0]!.fireAge;
  $('stressBody').innerHTML = rows.map(r => {
    const delta = (r.fireAge != null && baseAge != null) ? r.fireAge - baseAge : null;
    // 变化量用形状 + 颜色双编码，不只靠颜色区分
    let badge: string;
    if (r.name === '基准') badge = '<span class="delta same">基准</span>';
    else if (delta == null) badge = '<span class="delta none">无解</span>';
    else if (delta === 0) badge = '<span class="delta same">±0</span>';
    else if (delta > 0) badge = `<span class="delta worse">▲ 晚 ${delta} 年</span>`;
    else badge = `<span class="delta better">▼ 早 ${-delta} 年</span>`;
    return `<tr><td>${r.name}</td><td>${r.fireAge != null ? r.fireAge + ' 岁' : '—'}</td>` +
           `<td>${badge}</td><td>${cny(r.endReal)}</td></tr>`;
  }).join('');
}

function renderTable(sim: SimResult): void {
  $('tblBody').innerHTML = sim.rows.map(r =>
    `<tr><td>${r.age}</td><td>${cny(r.income)}</td><td>${cny(r.spend)}</td>` +
    `<td>${Math.abs(r.events) > 0.5 ? cny(r.events) : '—'}</td>` +
    `<td>${cny(r.ret)}</td><td>${cny(r.endNominal)}</td>` +
    `<td>${cny(r.endReal)}</td></tr>`
  ).join('');
}

/* ---- 可点击的说明气泡 ----
 * 原来用 title 属性，只在悬停时由浏览器渲染，触屏上完全点不出来。
 * 改成点击切换的气泡：Esc 关闭、点外部关闭、键盘可达。 */
function bindInfoTips(): void {
  let open: HTMLElement | null = null;
  const close = (): void => {
    if (!open) return;
    open.remove();
    document.querySelectorAll('.info[aria-expanded="true"]')
      .forEach(b => b.setAttribute('aria-expanded', 'false'));
    open = null;
  };
  document.addEventListener('click', ev => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('.info');
    if (!btn) { if (!(ev.target as HTMLElement).closest('.tipbox')) close(); return; }
    ev.preventDefault();
    ev.stopPropagation();
    const wasOpen = btn.getAttribute('aria-expanded') === 'true';
    close();
    if (wasOpen) return;

    const box = document.createElement('div');
    box.className = 'tipbox';
    box.innerHTML = `<button type="button" class="tipclose" aria-label="关闭">×</button>` +
      (btn.dataset['tip'] ?? '');
    document.body.appendChild(box);
    box.querySelector('.tipclose')?.addEventListener('click', close);

    const r = btn.getBoundingClientRect();
    const w = box.offsetWidth, h = box.offsetHeight;
    let left = r.left + window.scrollX - 8;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    // 下方放不下就翻到上方
    const below = r.bottom + window.scrollY + 8;
    const top = (r.bottom + h + 16 > window.innerHeight) && (r.top - h - 8 > 0)
      ? r.top + window.scrollY - h - 8
      : below;
    box.style.left = left + 'px';
    box.style.top = top + 'px';
    btn.setAttribute('aria-expanded', 'true');
    open = box;
  });
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape') close(); });
  window.addEventListener('resize', close);
}

/** 收入模型：预设卡片（各带一条迷你曲线）+ 展开后的细调参数 */
function bindIncomeModel(): void {
  const grid = $('incomePresets');
  const params = $('curveParams');
  const simpleParams = $('simpleParams');

  const cards: Array<{ key: string; name: string; who: string }> = [
    { key: 'simple', name: '简单增长', who: '固定年增长率 + 天花板，自己填' },
    ...E.INCOME_PRESETS.map(p => ({ key: p.key, name: p.name, who: p.who }))
  ];

  grid.innerHTML = cards.map(c =>
    `<button type="button" class="preset" data-k="${c.key}" aria-pressed="false">
       <span class="preset-spark" data-spark="${c.key}"></span>
       <span class="preset-txt"><span class="preset-n">${c.name}</span>
       <span class="preset-w">${c.who}</span></span>
     </button>`).join('');

  const activeKey = (): string =>
    st.input.incomeModel.kind === 'simple' ? 'simple' : st.input.incomeModel.preset;

  const drawSparks = (): void => {
    const cur = activeKey();
    for (const c of cards) {
      const host = grid.querySelector<HTMLElement>(`[data-spark="${c.key}"]`);
      if (!host) continue;
      const active = c.key === cur;
      if (c.key === 'simple') {
        // 简单模型没有曲线形状，画它自己的增长 + 天花板轨迹
        const g = st.input.incomeGrowth as number;
        const capAge = st.input.capIncomeGrowthAt;
        const ceil = st.input.incomeCeiling;
        const base = st.input.annualIncome as number;
        C.incomeSpark(host, a => {
          const t = Math.max(0, a - st.input.currentAge);
          const ct = capAge === null ? t : Math.min(t, Math.max(0, capAge - st.input.currentAge));
          let v = Math.pow(1 + g, ct);
          if (ceil !== null && base > 0) v = Math.min(v, ceil / base);
          return v;
        }, { peakAge: capAge ?? 60, currentAge: st.input.currentAge, active });
      } else {
        const preset = E.INCOME_PRESETS.find(p => p.key === c.key);
        if (!preset) continue;
        const cv = (st.input.incomeModel.kind === 'curve' && active)
          ? st.input.incomeModel.curve : preset.curve;
        C.incomeSpark(host, a => E.incomeCurveAt(cv, a),
          { peakAge: cv.peakAge, currentAge: st.input.currentAge, active });
      }
      grid.querySelector(`[data-k="${c.key}"]`)
        ?.setAttribute('aria-pressed', String(active));
    }
    // 两套参数互斥显示：简单增长用「增长率 + 封顶 + 天花板」，
    // 曲线用「峰值年龄 + 峰值倍数 + 峰后降幅 + 社会工资增长」。
    // 之前两套都摆在界面上，选了曲线还能调增长率，但那三个参数根本不参与计算。
    const isCurve = st.input.incomeModel.kind === 'curve';
    params.style.display = isCurve ? '' : 'none';
    simpleParams.style.display = isCurve ? 'none' : '';
  };

  grid.addEventListener('click', e => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.preset');
    const k = btn?.dataset['k'];
    if (!k) return;
    if (k === 'simple') {
      st.input.incomeModel = { kind: 'simple' };
    } else {
      const preset = E.INCOME_PRESETS.find(p => p.key === k);
      if (preset) st.input.incomeModel = { kind: 'curve', preset: k, curve: { ...preset.curve } };
    }
    syncCurveInputs();
    drawSparks();
    schedule();
  });

  // 细调滑块
  const curveNum = (
    id: string, get: () => number, set: (v: number) => void, fmt: (v: number) => string
  ): void => {
    const r = $<HTMLInputElement>('r_' + id);
    const v = $('v_' + id);
    const show = (): void => { r.value = String(get()); v.textContent = fmt(get()); };
    r.addEventListener('input', () => {
      set(parseFloat(r.value)); show(); drawSparks(); schedule();
    });
    show();
  };
  const cv = (): { peakAge: number; peakMult: number; declineRate: number } | null =>
    st.input.incomeModel.kind === 'curve'
      ? st.input.incomeModel.curve as unknown as
        { peakAge: number; peakMult: number; declineRate: number }
      : null;

  curveNum('peakAge', () => cv()?.peakAge ?? 45,
    v => { const c = cv(); if (c) c.peakAge = v; }, v => v + ' 岁');
  curveNum('peakMult', () => cv()?.peakMult ?? 2.5,
    v => { const c = cv(); if (c) c.peakMult = v; }, v => v.toFixed(1) + '×');
  curveNum('declineRate', () => (cv()?.declineRate ?? 0.01) * 100,
    v => { const c = cv(); if (c) c.declineRate = v / 100; }, v => v.toFixed(2) + '%');
  curveNum('realWageGrowth', () => (st.input.realWageGrowth as number) * 100,
    v => { (st.input.realWageGrowth as number) = v / 100; }, v => v.toFixed(2) + '%');

  function syncCurveInputs(): void {
    const c = cv();
    if (!c) return;
    $<HTMLInputElement>('r_peakAge').value = String(c.peakAge);
    $('v_peakAge').textContent = c.peakAge + ' 岁';
    $<HTMLInputElement>('r_peakMult').value = String(c.peakMult);
    $('v_peakMult').textContent = c.peakMult.toFixed(1) + '×';
    $<HTMLInputElement>('r_declineRate').value = String(c.declineRate * 100);
    $('v_declineRate').textContent = (c.declineRate * 100).toFixed(2) + '%';
  }

  syncCurveInputs();
  drawSparks();
  redrawSparks = drawSparks;
}

/** 由 bindIncomeModel 注入。迷你曲线的颜色取自 CSS 变量，
 * 换主题必须重绘 —— 否则会留着上一个主题的配色。 */
let redrawSparks: (() => void) | null = null;

/** 市场假设：三档情景预设卡 + 折叠的五个系数微调。
 *
 * 为什么做成卡：这五个系数不独立，真正决定结果的是实际收益率（名义 ÷ 通胀）。
 * 五个滑块并排摆着，用户很容易调出「低利率 + 高通胀」的滞胀组合而不自知，
 * 退休期实际收益变成负数，FIRE 年龄凭空多推 5 年（见 docs/参数依据.md）。
 * 所以卡片上直接把退休期**实际**收益率印出来 —— 那才是真正在起作用的量。
 */
function bindMarketPresets(): void {
  const grid = $('marketPresets');

  grid.innerHTML = E.MARKET_PRESETS.map(p => {
    const rr = E.realRate(p.rRetire, p.personalInflation);
    return `<button type="button" class="preset preset--nospark" data-k="${p.key}" aria-pressed="false">
       <span class="preset-txt"><span class="preset-n">${p.name}</span>
       <span class="preset-w">${p.who}</span>
       <span class="preset-k">收益 ${pct(p.rWork, 1)} / ${pct(p.rRetire, 1)} · 通胀 ${pct(p.personalInflation, 1)}
         · 退休期实际 ${rr >= 0 ? '+' : '−'}${pct(Math.abs(rr), 2)}</span></span>
     </button>`;
  }).join('');

  // 用户拖任一滑块后，反查五元组还落不落在某一档上；不落就全部取消选中。
  const sync = (): void => {
    const cur = E.matchMarketPreset(st.input)?.key ?? null;
    grid.querySelectorAll<HTMLElement>('.preset').forEach(b => {
      b.setAttribute('aria-pressed', String(b.dataset['k'] === cur));
    });
  };

  grid.addEventListener('click', e => {
    const k = (e.target as HTMLElement).closest<HTMLElement>('.preset')?.dataset['k'];
    const p = E.MARKET_PRESETS.find(x => x.key === k);
    if (!p) return;
    // 一次写入四个值：只改一部分就是那个滞胀陷阱本身。
    // 医疗通胀不在其中，但它是 cpi + medPremium，改了 cpi 就已经跟着变了。
    st.input.cpi = p.cpi;
    st.input.personalInflation = p.personalInflation;
    st.input.rWork = p.rWork;
    st.input.rRetire = p.rRetire;
    syncAllRanges();          // 滑块还停在旧位置，必须刷回去
    sync();
    schedule();
  });

  sync();
  syncMarketPresets = sync;
}

/** 由 bindMarketPresets 注入，供 bindRange 在用户拖动滑块后回查选中态。 */
let syncMarketPresets: (() => void) | null = null;

/** 折叠块收起时，在标题右侧显示当前值摘要，不用展开就能看见 */
function renderBlockSummaries(): void {
  const i = st.input, p = st.pension;
  const mkt = E.matchMarketPreset(i);
  const sums: Record<string, string> = {
    '我的基本情况': `${i.currentAge}岁 · ${cny(i.annualIncome)}/年 · 存 ${pct((i.annualIncome - i.annualSpend) / Math.max(1, i.annualIncome), 0)}`,
    '收入模型': i.incomeModel.kind === 'simple'
      ? `简单增长 ${pct(i.incomeGrowth, 1)}`
      : (E.INCOME_PRESETS.find(p => p.key === (i.incomeModel as {preset:string}).preset)?.name ?? '曲线'),
    '我打算活到几岁': `${i.deathAge} 岁`,
    '我要留多少应急金': cny(i.reserve),
    '市场假设': mkt ? mkt.name + '档'
      : `自定义 · ${pct(i.rWork, 1)} / ${pct(i.rRetire, 1)} · 通胀 ${pct(i.personalInflation, 1)}`,
    '退休后的支出曲线': i.smileOn ? '微笑曲线已开' : '恒定实际支出',
    '社保养老金': p.on ? `${p.claimAge} 岁起领` : '未计入',
    '子女教育': st.child.enabled
      ? `${st.child.children.length} 个 · ${CH.childPreset(st.child.tier).name}` : '未计入',
    '购房': st.house.enabled
      ? `${Math.round(st.house.pricePerSqm).toLocaleString('zh-CN')}/㎡ × ` +
        `${st.house.areaSqm}㎡ · ${cny(HO.totalPrice(st.house))}`
      : '未计入',
    '时间轴事件': i.events.filter(e => e.enabled).length
      ? `${i.events.filter(e => e.enabled).length} 项` : '无'
  };
  document.querySelectorAll<HTMLElement>('.blk-sum').forEach(el => {
    el.textContent = sums[el.dataset['blk'] ?? ''] ?? '';
  });
}

// ---- 控件绑定 -----------------------------------------------------------
let timer = 0;
function schedule(): void {
  clearTimeout(timer);
  timer = window.setTimeout(render, 120);   // 滑块拖动时防抖
}

type NumKey = 'currentAge' | 'deathAge' | 'incomeGrowth' | 'cpi' | 'personalInflation'
  | 'medPremium' | 'rWork' | 'rRetire' | 'retireSpendRatio';

/** 每个 bindRange 注册进来的「把 st.input 的当前值刷回滑块 DOM」。
 * 预设卡一次改多个参数，改完必须统一刷一遍，否则滑块还停在旧位置。 */
const rangeSyncers: Array<() => void> = [];
function syncAllRanges(): void { for (const f of rangeSyncers) f(); }

/** 滑块。isPct = 滑块以百分数计，写回 input 时除以 100。 */
function bindRange(key: NumKey, isPct: boolean, fmt?: (v: number) => string): void {
  const r = $<HTMLInputElement>('r_' + key);
  const v = $('v_' + key);
  const show = (): void => {
    const raw = st.input[key] as number;
    const disp = isPct ? raw * 100 : raw;
    r.value = String(disp);
    v.textContent = fmt ? fmt(disp) : (isPct ? disp.toFixed(2) + '%' : String(disp) + ' 岁');
  };
  r.addEventListener('input', () => {
    const n = parseFloat(r.value);
    (st.input[key] as number) = isPct ? n / 100 : n;
    // 刷全部而不只刷自己：医疗溢价旁边显示的换算绝对值（= CPI + 溢价）依赖 cpi，
    // 拖 CPI 滑块时那个数必须跟着走。刷一遍只是把 DOM 写成 st.input 的当前值，幂等。
    syncAllRanges();
    syncMarketPresets?.();   // 手动微调后预设卡应变成「都不选中」
    schedule();
  });
  rangeSyncers.push(show);
  show();
}

type AmtKey = 'assets' | 'annualIncome' | 'annualSpend' | 'reserve';

function bindAmount(key: AmtKey): void {
  const i = $<HTMLInputElement>('i_' + key);
  const show = (): void => { i.value = cnyFull(st.input[key] as number).replace('¥', ''); };
  i.addEventListener('change', () => {
    (st.input[key] as number) = parseAmount(i.value);
    show(); schedule();
  });
  i.addEventListener('focus', () => { i.value = String(Math.round(st.input[key] as number)); });
  show();
}

/** 返回「把选中态刷回 DOM」的函数：同一个值若还挂着别的控件（如首付比例的滑块），
 * 那个控件改完要能回来把 chips 的选中态刷一遍。 */
function chips(hostId: string, get: () => string | number,
               set: (v: string) => void): () => void {
  const host = $(hostId);
  const sync = (): void => {
    host.querySelectorAll<HTMLElement>('.chip').forEach(c => {
      c.setAttribute('aria-pressed', String(c.dataset['v'] === String(get())));
    });
  };
  host.addEventListener('click', e => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('.chip');
    if (!t?.dataset['v']) return;
    set(t.dataset['v']);
    sync(); schedule();
  });
  sync();
  return sync;
}

/** 通用滑块绑定。bindRange 只认 st.input 的字段，生活模块的值不在那上面，
 * 所以这里走 get/set 闭包。返回「把当前值刷回 DOM」的函数，供预设卡改完统一刷新。 */
function bindNum(
  id: string, get: () => number, set: (v: number) => void,
  fmt: (v: number) => string, after?: () => void
): () => void {
  const r = $<HTMLInputElement>('r_' + id);
  const v = $('v_' + id);
  const show = (): void => { r.value = String(get()); v.textContent = fmt(get()); };
  r.addEventListener('input', () => {
    set(parseFloat(r.value)); show(); after?.(); schedule();
  });
  show();
  return show;
}

/** 通用金额输入框绑定，同上。聚焦时显示裸数字，失焦后回到「50 万」这类可读写法。 */
function bindAmt(
  id: string, get: () => number, set: (v: number) => void, after?: () => void
): () => void {
  const i = $<HTMLInputElement>('i_' + id);
  const show = (): void => { i.value = cnyFull(get()).replace('¥', ''); };
  i.addEventListener('change', () => {
    set(parseAmount(i.value)); show(); after?.(); schedule();
  });
  i.addEventListener('focus', () => { i.value = String(Math.round(get())); });
  show();
  return show;
}

/** 子女教育：四档预设卡 + 每个孩子的现状 + 口径开关。 */
function bindChild(): void {
  const cfg = (): CH.ChildCfg => st.child;
  const box = $('childBox');
  const on = $<HTMLInputElement>('c_childOn');
  const syncOn = (): void => { box.style.display = cfg().enabled ? '' : 'none'; };
  on.checked = cfg().enabled;
  on.addEventListener('change', () => { cfg().enabled = on.checked; syncOn(); schedule(); });
  syncOn();

  const grid = $('childPresets');
  const intlField = $('intlField');

  const drawPresets = (): void => {
    grid.innerHTML = CH.CHILD_PRESETS.map(p => {
      // 合计随「是否扣居住」「转国际的年龄」变化，所以每次都现算，不缓存
      const total = CH.childLifetimeTotal(cfg(), p.key);
      return `<button type="button" class="preset preset--nospark" data-k="${p.key}"
         aria-pressed="${String(p.key === cfg().tier)}">
         <span class="preset-txt"><span class="preset-n">${p.name}</span>
         <span class="preset-w">${p.who}</span>
         <span class="preset-k">0—22 岁合计 ${cny(total)} · 教育通胀溢价 ${pp(p.premium)}</span>
         </span></button>`;
    }).join('');
    intlField.style.display = cfg().tier === 'international' ? '' : 'none';
  };

  const kids = $('childKids');
  /** 某个孩子按当前档位、当前年龄应有的年成本，用来预填「现在每年花多少」 */
  const suggest = (c: CH.ChildSpec, i: number): number =>
    c.kind === 'born' ? Math.round(CH.childAnnualCost(cfg(), c.age, i + 1)) : 0;

  const drawKids = (): void => {
    kids.innerHTML = '<table><tbody>' + cfg().children.map((c, i) => {
      const born = c.kind === 'born';
      return `<tr>
        <td style="padding-left:0"><select data-i="${i}" data-f="kind">
          <option value="born"${born ? ' selected' : ''}>已出生</option>
          <option value="planned"${born ? '' : ' selected'}>还没出生</option>
        </select></td>
        <td style="white-space:nowrap"><input type="number" data-i="${i}" data-f="n"
             min="0" max="${born ? 22 : 20}" step="1"
             value="${born ? c.age : c.yearsUntilBirth}" style="width:54px">
          ${born ? '岁' : '年后生'}</td>
        <td>${born
          ? `<input type="text" data-i="${i}" data-f="spend" value="${Math.round(c.currentSpend)}"
               style="min-width:76px">`
          : '—'}</td>
        <td style="padding-right:0"><button class="xbtn" data-del="${i}" title="删除">×</button></td>
      </tr>`;
    }).join('') + '</tbody></table>';

    kids.querySelectorAll<HTMLSelectElement>('select').forEach(sel => {
      sel.addEventListener('change', () => {
        const i = Number(sel.dataset['i']);
        const old = cfg().children[i];
        if (!old) return;
        // 换类型就整条重建：两种形态的字段完全不同，保留旧字段只会留下脏数据
        cfg().children[i] = sel.value === 'born'
          ? { kind: 'born', age: 0, currentSpend: 0 }
          : { kind: 'planned', yearsUntilBirth: 2 };
        const now = cfg().children[i];
        if (now && now.kind === 'born') now.currentSpend = suggest(now, i);
        drawKids(); schedule();
      });
    });
    kids.querySelectorAll<HTMLInputElement>('input').forEach(inp => {
      inp.addEventListener('change', () => {
        const i = Number(inp.dataset['i']);
        const c = cfg().children[i];
        if (!c) return;
        if (inp.dataset['f'] === 'n') {
          const n = Math.max(0, Math.round(Number(inp.value)));
          if (c.kind === 'born') c.age = n; else c.yearsUntilBirth = n;
        } else if (c.kind === 'born') {
          c.currentSpend = parseAmount(inp.value);
        }
        drawKids(); drawPresets(); schedule();
      });
    });
    kids.querySelectorAll<HTMLButtonElement>('[data-del]').forEach(b => {
      b.addEventListener('click', () => {
        if (cfg().children.length <= 1) return;   // 至少留一个，否则整个模块没有意义
        cfg().children.splice(Number(b.dataset['del']), 1);
        drawKids(); schedule();
      });
    });
  };

  $('addKid').addEventListener('click', () => {
    cfg().children.push({ kind: 'planned', yearsUntilBirth: 2 });
    drawKids(); schedule();
  });

  grid.addEventListener('click', e => {
    const k = (e.target as HTMLElement).closest<HTMLElement>('.preset')?.dataset['k'];
    if (!k) return;
    cfg().tier = k as CH.ChildTierKey;
    // 已出生的孩子若还没填过当前花费，按新档位预填一个 —— 填过的不动
    cfg().children.forEach((c, i) => {
      if (c.kind === 'born' && c.currentSpend === 0) c.currentSpend = suggest(c, i);
    });
    drawPresets(); drawKids(); premiumHint(); schedule();
  });

  bindNum('childIntlFrom', () => cfg().intlFromAge,
    v => { cfg().intlFromAge = v; }, v => v + ' 岁', drawPresets);

  const ck = (id: string, get: () => boolean, set: (v: boolean) => void,
              after?: () => void): void => {
    const c = $<HTMLInputElement>(id);
    c.checked = get();
    c.addEventListener('change', () => { set(c.checked); after?.(); schedule(); });
  };
  ck('c_childHousing', () => cfg().includeHousing,
     v => { cfg().includeHousing = v; }, drawPresets);
  ck('c_childSibling', () => cfg().siblingDiscount, v => { cfg().siblingDiscount = v; });
  ck('c_childSubsidy', () => cfg().subsidy, v => { cfg().subsidy = v; });

  // 教育通胀溢价：默认跟随档位，勾选后才允许覆盖
  const premBox = $('childPremiumBox');
  const premOn = $<HTMLInputElement>('c_childPremiumOn');
  const showPrem = bindNum('childPremium',
    () => ((cfg().premiumOverride ?? CH.childPreset(cfg().tier).premium) as number) * 100,
    v => { cfg().premiumOverride = rate(v / 100); },
    v => `+${v.toFixed(1)}pp（= ${pct(st.input.cpi + v / 100)}）`,
    () => premiumHint());
  function premiumHint(): void {
    const p = CH.childPreset(cfg().tier);
    const eff = (cfg().premiumOverride ?? p.premium) as number;
    premBox.style.display = cfg().premiumOverride === null ? 'none' : '';
    showPrem();
    $('h_childPremium').innerHTML = cfg().premiumOverride === null
      ? `当前跟随「${p.name}」档：${pp(p.premium)}，即年涨 ${pct(st.input.cpi + p.premium)}。`
      : `覆盖为 ${pp(eff)}，即年涨 ${pct(st.input.cpi + eff)}（档位默认是 ${pp(p.premium)}）。`;
  }
  premOn.checked = cfg().premiumOverride !== null;
  premOn.addEventListener('change', () => {
    cfg().premiumOverride = premOn.checked
      ? CH.childPreset(cfg().tier).premium : null;
    premiumHint(); schedule();
  });

  drawPresets();
  drawKids();
  premiumHint();
}

/** 购房：单价 × 面积 + 付款方式 + 微调 + 可选的退休后卖房。 */
function bindHouse(): void {
  const cfg = (): HO.HouseCfg => st.house;
  const box = $('houseBox');
  const on = $<HTMLInputElement>('c_houseOn');
  const syncOn = (): void => { box.style.display = cfg().enabled ? '' : 'none'; };
  on.checked = cfg().enabled;
  on.addEventListener('change', () => { cfg().enabled = on.checked; syncOn(); schedule(); });
  syncOn();

  const syncers: Array<() => void> = [];
  const refresh = (): void => { for (const f of syncers) f(); };

  /** 总价是派生显示，不是输入框 —— 有第三个可编辑的数，就会出现
   * 「单价 × 面积 ≠ 总价」的不自洽状态，而那时三个数里必然有一个是错的。
   * 为什么这么定、100㎡ 的来历、改面积会连带重算月租金，都在附录的「常见问题」里。 */
  const totalHint = (): void => {
    const c = cfg();
    $('h_houseTotal').innerHTML =
      `总价 = <b>${cny(HO.totalPrice(c))}</b>
       （${Math.round(c.pricePerSqm).toLocaleString('zh-CN')} 元/㎡ × ${c.areaSqm}㎡）`;
  };

  chips('payModeChips', () => cfg().payMode, v => { cfg().payMode = v as HO.PayMode; });
  chips('priceGrowthChips', () => cfg().priceGrowth as number,
        v => { cfg().priceGrowth = rate(Number(v)); });
  chips('loanYearsChips', () => cfg().loanYears,
        v => { cfg().loanYears = Number(v); });

  // 单价：滑块与输入框绑同一个值。滑块步进 1 万，低线城市的 5,000、1.3 万落不到刻度上，
  // 必须留一个能直接打字的入口 —— 两个控件互相同步由 refresh() 统一做。
  const afterUnit = (): void => { refresh(); totalHint(); };
  syncers.push(bindNum('houseUnit', () => cfg().pricePerSqm,
    v => { cfg().pricePerSqm = v; },
    v => Math.round(v).toLocaleString('zh-CN') + ' 元/㎡', afterUnit));
  syncers.push(bindAmt('houseUnit', () => cfg().pricePerSqm,
    v => { cfg().pricePerSqm = v; }, afterUnit));
  syncers.push(bindNum('houseArea', () => cfg().areaSqm,
    v => { st.house = HO.applyArea(cfg(), v); }, v => v + '㎡', afterUnit));

  syncers.push(bindAmt('houseRent', () => cfg().marketMonthlyRent,
    v => { cfg().marketMonthlyRent = v; }));
  syncers.push(bindAmt('houseHpfCap', () => cfg().hpfCap,
    v => { cfg().hpfCap = v; }));
  syncers.push(bindAmt('houseMonthly', () => cfg().currentMonthlyHousing,
    v => { cfg().currentMonthlyHousing = v; }));
  syncers.push(bindAmt('housePostRent', () => cfg().postSaleMonthlyRent,
    v => { cfg().postSaleMonthlyRent = v; }));

  // 首付比例：四档常见值 + 滑块微调，两个控件绑同一个值
  const syncDown = chips('downRatioChips', () => cfg().downRatio as number,
    v => { cfg().downRatio = rate(Number(v)); refresh(); });
  syncers.push(bindNum('houseDown', () => (cfg().downRatio as number) * 100,
    v => { cfg().downRatio = rate(v / 100); }, v => v.toFixed(0) + '%', syncDown));
  syncers.push(bindNum('houseComRate', () => (cfg().comRate as number) * 100,
    v => { cfg().comRate = rate(v / 100); }, v => v.toFixed(2) + '%'));
  syncers.push(bindNum('houseHpfRate', () => (cfg().hpfRate as number) * 100,
    v => { cfg().hpfRate = rate(v / 100); }, v => v.toFixed(2) + '%'));
  syncers.push(bindNum('houseBuyAge', () => cfg().buyAge,
    v => { cfg().buyAge = v; }, v => v + ' 岁'));
  syncers.push(bindNum('houseSellAge', () => cfg().sellAge,
    v => { cfg().sellAge = v; }, v => v + ' 岁'));
  syncers.push(bindNum('houseSellCost', () => (cfg().sellCostRate as number) * 100,
    v => { cfg().sellCostRate = rate(v / 100); }, v => v.toFixed(1) + '%'));

  const sellBox = $('houseSellBox');
  const sellOn = $<HTMLInputElement>('c_houseSell');
  const syncSell = (): void => { sellBox.style.display = cfg().sellOn ? '' : 'none'; };
  sellOn.checked = cfg().sellOn;
  sellOn.addEventListener('change', () => {
    cfg().sellOn = sellOn.checked; syncSell(); schedule();
  });
  syncSell();

  totalHint();
}

function bindPhases(): void {
  const box = $('phaseBox');
  const draw = (): void => {
    box.innerHTML = '<table><thead><tr><th>阶段</th><th>退休后第几年起</th>' +
      '<th>年实际变化率</th></tr></thead><tbody>' +
      st.input.phases.map((p, i) =>
        `<tr><td>${['活跃期', '平稳期', '医疗期'][i] ?? '第' + (i + 1) + '段'}</td>` +
        `<td><input type="number" data-i="${i}" data-f="startOffset" value="${p.startOffset}" step="1" min="0"></td>` +
        `<td><input type="number" data-i="${i}" data-f="drift" value="${(p.drift * 100).toFixed(1)}" step="0.1"></td></tr>`
      ).join('') + '</tbody></table>';
    box.querySelectorAll<HTMLInputElement>('input').forEach(inp => {
      inp.addEventListener('change', () => {
        const i = Number(inp.dataset['i']);
        const ph = st.input.phases[i];
        if (!ph) return;
        if (inp.dataset['f'] === 'startOffset') ph.startOffset = Number(inp.value);
        else ph.drift = rate(Number(inp.value) / 100);
        schedule();
      });
    });
  };
  draw();
}

function bindEvents(): void {
  const body = $('evBody');
  const draw = (): void => {
    body.innerHTML = st.input.events.map((e, i) =>
      `<tr>
        <td><input data-i="${i}" data-f="name" value="${e.name}" style="min-width:76px"></td>
        <td><input data-i="${i}" data-f="amount" value="${Math.round(e.amount)}" style="min-width:80px"></td>
        <td><input data-i="${i}" data-f="startAge" type="number" value="${e.startAge}" style="width:52px"></td>
        <td><input data-i="${i}" data-f="endAge" type="number" value="${e.endAge}" style="width:52px"></td>
        <td><input data-i="${i}" data-f="growth" type="number" step="0.1" value="${(e.growth * 100).toFixed(1)}" style="width:56px"></td>
        <td><input data-i="${i}" data-f="enabled" type="checkbox" ${e.enabled ? 'checked' : ''}></td>
        <td><button class="xbtn" data-del="${i}" title="删除">×</button></td>
      </tr>`).join('');
    body.querySelectorAll<HTMLInputElement>('input').forEach(inp => {
      inp.addEventListener('change', () => {
        const ev = st.input.events[Number(inp.dataset['i'])];
        if (!ev) return;
        const f = inp.dataset['f'];
        if (f === 'name') ev.name = inp.value;
        else if (f === 'amount') ev.amount = real(parseAmount(inp.value));
        else if (f === 'startAge') ev.startAge = age(Number(inp.value));
        else if (f === 'endAge') ev.endAge = age(Number(inp.value));
        else if (f === 'growth') ev.growth = rate(Number(inp.value) / 100);
        else if (f === 'enabled') ev.enabled = inp.checked;
        schedule();
      });
    });
    body.querySelectorAll<HTMLButtonElement>('[data-del]').forEach(b => {
      b.addEventListener('click', () => {
        st.input.events.splice(Number(b.dataset['del']), 1);
        draw(); schedule();
      });
    });
  };
  $('addEv').addEventListener('click', () => {
    st.input.events.push({ name: '新事件', amount: real(0),
      startAge: st.input.currentAge, endAge: age(st.input.currentAge + 1),
      growth: rate(0.02), enabled: true });
    draw(); schedule();
  });
  draw();
}

// ---- 启动 ---------------------------------------------------------------
function bindPension(): void {
  const box = $('pensionBox');
  const on = $<HTMLInputElement>('c_pensionOn');
  const sync = (): void => { box.style.display = st.pension.on ? '' : 'none'; };
  on.checked = st.pension.on;
  on.addEventListener('change', () => { st.pension.on = on.checked; sync(); schedule(); });
  sync();

  const num = (id: string, key: keyof PensionCfg, isPct: boolean,
               after?: () => void): void => {
    const r = $<HTMLInputElement>('r_' + id);
    const v = $('v_' + id);
    const show = (): void => {
      const raw = st.pension[key] as number;
      const disp = isPct ? raw * 100 : raw;
      r.value = String(disp);
      v.textContent = isPct ? disp.toFixed(2) + '%' : String(disp) + ' 岁';
    };
    r.addEventListener('input', () => {
      const n = parseFloat(r.value);
      (st.pension[key] as number) = isPct ? n / 100 : n;
      show(); after?.(); schedule();
    });
    show();
  };
  const spreadHint = (): void => {
    const s = st.pension.socialGrowth - st.pension.accountRate;
    $('h_spread').innerHTML = s > 0
      ? `比社平增长低 <b>${(s * 100).toFixed(2)}pp</b>。历年公布值 2016 年 8.31% → 2025 年 1.5%，
         默认取「社平 − 1.5pp」的联动值。`
      : `已不低于社平增长 —— 历史上 2023 年后未再出现，请谨慎。`;
  };
  num('joinAge', 'joinAge', false);
  num('socialGrowth', 'socialGrowth', true, spreadHint);
  num('accountRate', 'accountRate', true, spreadHint);
  num('claimAge', 'claimAge', false);
  num('cola', 'cola', true);
  spreadHint();

  const amt = (id: string, key: keyof PensionCfg): void => {
    const i = $<HTMLInputElement>('i_' + id);
    i.value = String(st.pension[key]);
    i.addEventListener('change', () => {
      (st.pension[key] as number) = parseAmount(i.value);
      schedule();
    });
  };
  amt('socialAvg', 'socialAvg');
  amt('monthlyIncome', 'monthlyIncome');

  chips('cityChips', () => st.pension.socialAvg, v => {
    st.pension.socialAvg = Number(v);
    $<HTMLInputElement>('i_socialAvg').value = v;
  });
  chips('baseModeChips', () => st.pension.baseMode,
        v => { st.pension.baseMode = v as P.BaseMode; });

  const keep = $<HTMLInputElement>('c_keepPaying');
  keep.checked = st.pension.keepPaying;
  keep.addEventListener('change', () => {
    st.pension.keepPaying = keep.checked; schedule();
  });
}

function boot(): void {
  load();
  bindRange('currentAge', false);
  bindRange('deathAge', false);
  bindRange('incomeGrowth', true);
  bindRange('cpi', true);
  bindRange('personalInflation', true);
  // 溢价滑块单独给一个 fmt：只显示「+2.0pp」用户看不出这到底意味着每年涨多少，
  // 所以把换算后的绝对值一起印出来（换算依赖 cpi，故读 st.input 而不是闭包捕获）。
  bindRange('medPremium', true,
    v => `+${v.toFixed(1)}pp（= ${pct(st.input.cpi + v / 100)}）`);
  bindRange('rWork', true);
  bindRange('rRetire', true);
  bindRange('retireSpendRatio', true, v => v.toFixed(0) + '%');
  bindAmount('assets');
  bindAmount('annualIncome');
  bindAmount('annualSpend');
  bindAmount('reserve');

  chips('reserveChips', () => st.input.reserve as number, v => {
    st.input.reserve = real(Number(v));
    $<HTMLInputElement>('i_reserve').value = cnyFull(Number(v)).replace('¥', '');
  });

  // 职业天花板：金额框 + 启用开关
  const ceilIn = $<HTMLInputElement>('i_incomeCeiling');
  const ceilOn = $<HTMLInputElement>('c_ceilingOn');
  const syncCeil = (): void => {
    const on = st.input.incomeCeiling !== null;
    ceilOn.checked = on;
    ceilIn.disabled = !on;
    ceilIn.style.opacity = on ? '1' : '.45';
    const inf = $<HTMLInputElement>('c_ceilingInflates');
    inf.checked = st.input.incomeCeilingInflates;
    inf.disabled = !on;
    (inf.parentElement as HTMLElement).style.opacity = on ? '1' : '.45';
    if (on) ceilIn.value = cnyFull(st.input.incomeCeiling as number).replace('¥', '');
  };
  ceilOn.addEventListener('change', () => {
    st.input.incomeCeiling = ceilOn.checked
      ? real(parseAmount(ceilIn.value) || st.input.annualIncome * 2)
      : null;
    syncCeil(); schedule();
  });
  ceilIn.addEventListener('change', () => {
    st.input.incomeCeiling = real(parseAmount(ceilIn.value));
    syncCeil(); schedule();
  });
  const ceilInf = $<HTMLInputElement>('c_ceilingInflates');
  ceilInf.addEventListener('change', () => {
    st.input.incomeCeilingInflates = ceilInf.checked;
    syncCeil(); schedule();
  });
  ceilIn.addEventListener('focus', () => {
    if (st.input.incomeCeiling !== null) ceilIn.value = String(Math.round(st.input.incomeCeiling));
  });
  syncCeil();

  const cap = $<HTMLInputElement>('c_capIncome');
  cap.checked = st.input.capIncomeGrowthAt !== null;
  cap.addEventListener('change', () => {
    st.input.capIncomeGrowthAt = cap.checked ? 45 : null; schedule();
  });
  const smile = $<HTMLInputElement>('c_smile');
  smile.checked = st.input.smileOn;
  smile.addEventListener('change', () => { st.input.smileOn = smile.checked; schedule(); });

  bindIncomeModel();
  bindMarketPresets();
  bindPhases();
  bindEvents();
  bindPension();
  bindChild();
  bindHouse();
  bindInfoTips();

  // 名义 / 今日购买力切换
  const syncMode = (): void => {
    $('mReal').setAttribute('aria-pressed', String(st.showReal));
    $('mNom').setAttribute('aria-pressed', String(!st.showReal));
  };
  $('mReal').addEventListener('click', () => { st.showReal = true; syncMode(); render(); });
  $('mNom').addEventListener('click', () => { st.showReal = false; syncMode(); render(); });
  syncMode();

  $('themeBtn').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : cur === 'light' ? '' : 'dark';
    if (next) document.documentElement.setAttribute('data-theme', next);
    else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('fire-theme', next); } catch { /* 忽略 */ }
    render();          // 三张主图重绘
    redrawSparks?.();  // 收入模型的迷你曲线也要重绘
  });
  try {
    const t = localStorage.getItem('fire-theme');
    if (t) document.documentElement.setAttribute('data-theme', t);
  } catch { /* 忽略 */ }

  $('btnReset').addEventListener('click', () => {
    st = freshState();
    try { localStorage.removeItem(STORE_KEY); } catch { /* 忽略 */ }
    location.reload();
  });
  $('btnExport').addEventListener('click', () => {
    const box = $<HTMLTextAreaElement>('ioBox');
    box.style.display = '';
    box.value = JSON.stringify(st, null, 2);
    box.select();
  });
  $('btnImport').addEventListener('click', () => {
    const box = $<HTMLTextAreaElement>('ioBox');
    if (box.style.display === 'none' || !box.value.trim()) {
      box.style.display = ''; box.placeholder = '把导出的 JSON 粘贴到这里，再点一次「导入配置」';
      return;
    }
    try {
      const p = JSON.parse(box.value) as Partial<State>;
      if (p.input) st.input = migrate({ ...E.DEFAULTS, ...p.input });
      if (p.pension) st.pension = { ...DEFAULT_PENSION, ...p.pension };
      if (p.child) st.child = { ...CH.DEFAULT_CHILD, ...p.child };
      if (p.house) st.house = HO.migrateCfg(p.house);
      save(); location.reload();
    } catch { box.value = '// JSON 解析失败，请检查格式\n' + box.value; }
  });

  $('method').innerHTML = METHOD_HTML;
  renderSelfTest();
  render();
}

/** 页脚自检：把核心不变式在浏览器里再跑一遍，模型改坏了当场能看见。 */
function renderSelfTest(): void {
  const checks: Array<[string, () => boolean]> = [
    ['t=0 支出不预乘通胀', () => {
      const s = E.simulate({ currentAge: age(30), deathAge: age(40),
        annualSpend: real(120000), personalInflation: rate(0.05), smileOn: false }, 35);
      return Math.abs(s.rows[0]!.spend - 120000) < 1e-6;
    }],
    ['零收益零通胀 → 净流直接相加', () => {
      const s = E.simulate({ currentAge: age(30), deathAge: age(32), assets: real(0),
        annualIncome: real(300000), incomeGrowth: rate(0), capIncomeGrowthAt: null,
        annualSpend: real(120000), cpi: rate(0), personalInflation: rate(0),
        rWork: rate(0), rRetire: rate(0), smileOn: false, events: [] }, 33);
      return Math.abs(s.endNominal - 3 * 180000) < 1e-6;
    }],
    ['实际收益率用除法', () => Math.abs(E.realRate(rate(0.07), rate(0.025)) - 0.0439024390) < 1e-9],
    ['预留金按医疗通胀（CPI + 溢价）', () => {
      const s = E.simulate({ currentAge: age(30), deathAge: age(40), reserve: real(100000),
        medPremium: rate(0.04), cpi: rate(0.02) }, 35);
      return Math.abs(s.targetNominal - 100000 * Math.pow(1.06, 11)) < 1e-6;
    }],
    ['SWR 随年数变化', () => E.swrBenchmark(30) === 0.035 && E.swrBenchmark(50) === 0.030],
    ['计发月数 63岁=117', () => P.monthsFor(63) === 117],
    ['最低年限 2039+ = 20 年', () => P.minContributionYears(2039) === 20],
    ['记账利率 = 社平 − 1.5pp', () => Math.abs(P.defaultAccountRate(0.04) - 0.025) < 1e-9]
  ];
  const bad = checks.filter(([, fn]) => { try { return !fn(); } catch { return true; } });
  $('selftest').innerHTML = bad.length === 0
    ? `<span class="st-ok">自检 ${checks.length}/${checks.length} 通过</span>`
    : `<span class="st-bad">自检失败：${bad.map(([n]) => n).join('、')}</span>`;
}

document.addEventListener('DOMContentLoaded', boot);
