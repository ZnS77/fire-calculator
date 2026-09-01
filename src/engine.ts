import {
  Age, CashEvent, FireInput, IncomeCurve, NominalCNY, Rate, RealCNY, SimResult,
  SolveResult, SpendPhase, YearRow, age, nominal, rate, real
} from './types';

/** 收入模型预设。倍数以入职起薪为基准。
 * 依据见 docs/收入模型.md —— 中国的本土证据主要来自 Fang & Qiu (2023, JPE Macro)，
 * 用国家统计局城镇住户调查 1986–2012 微观数据估计。
 *
 * 重要：中国「35 岁是收入峰值」是**横截面**现象，主因是代际效应
 * （年轻一代人力资本涨得太快，压过了经验效应），**不等于**一个具体的人
 * 35 岁后就开始减收 —— 个人的生命周期曲线仍单调升到约 2.5 倍。
 * 本模型建的是后者。
 */
export interface IncomePreset {
  key: string;
  name: string;
  who: string;
  curve: IncomeCurve;
}

export const INCOME_PRESETS: readonly IncomePreset[] = [
  { key: 'standard', name: '标准职业曲线', who: '大多数白领、传统行业',
    curve: { entryAge: 22, peakAge: 45, peakMult: 2.5, declineRate: rate(0.01), floorRatio: null } },
  { key: 'steady', name: '稳中有升', who: '公务员、事业单位、国企、教师',
    curve: { entryAge: 22, peakAge: 52, peakMult: 2.2, declineRate: rate(0.005), floorRatio: null } },
  { key: 'early', name: '早熟高薪', who: '互联网、游戏、销售、主播',
    curve: { entryAge: 22, peakAge: 38, peakMult: 3.5, declineRate: rate(0.03), floorRatio: 0.6 } },
  { key: 'longslope', name: '长坡厚雪', who: '医生、律师、教授、金融、资深研发',
    curve: { entryAge: 23, peakAge: 52, peakMult: 4.0, declineRate: rate(0.01), floorRatio: null } },
  { key: 'flat', name: '平缓型', who: '蓝领、服务业、体力依赖岗位',
    curve: { entryAge: 19, peakAge: 40, peakMult: 1.6, declineRate: rate(0.02), floorRatio: 0.7 } }
];

/** 曲线在某年龄的相对值。f(entryAge)=1，f(peakAge)=peakMult。 */
export function incomeCurveAt(c: IncomeCurve, a: number): number {
  const xStar = Math.max(1e-9, c.peakAge - c.entryAge);
  if (a <= c.entryAge) return 1;
  if (a <= c.peakAge) {
    const gap = (c.peakAge - a) / xStar;           // 1 → 0
    return Math.pow(c.peakMult, 1 - gap * gap);
  }
  const decayed = c.peakMult * Math.pow(1 - c.declineRate, a - c.peakAge);
  const floor = c.floorRatio === null ? 0 : c.peakMult * c.floorRatio;
  return Math.max(decayed, floor);
}

export const DEFAULTS: FireInput = {
  currentAge: age(30),
  deathAge: age(95),
  assets: real(500000),
  annualIncome: real(300000),
  incomeGrowth: rate(0.04),
  capIncomeGrowthAt: 45,
  incomeCeiling: real(800000),
  incomeModel: { kind: 'simple' },
  realWageGrowth: rate(0.015),
  annualSpend: real(120000),
  retireSpendRatio: rate(1.0),
  cpi: rate(0.022),
  personalInflation: rate(0.032),
  medInflation: rate(0.06),
  rWork: rate(0.06),
  rRetire: rate(0.045),
  reserve: real(500000),
  smileOn: true,
  phases: [
    { startOffset: 0,  drift: rate(-0.01) },
    { startOffset: 10, drift: rate(-0.02) },
    { startOffset: 20, drift: rate(-0.01) }
  ],
  events: []
};

/** 实际收益率。必须用除法：r−i 的近似在 40 年尺度上有约 4.5% 的终值误差。 */
export function realRate(nominalRate: Rate, inflation: Rate): Rate {
  return rate((1 + nominalRate) / (1 + inflation) - 1);
}

/** 返回 age 所处支出段的 drift。段区间左闭右开，age === 段起点归属新段。 */
export function driftFor(
  a: number, retireAge: number, phases: SpendPhase[], smileOn: boolean
): Rate {
  if (!smileOn || phases.length === 0) return rate(0);
  const off = a - retireAge;
  if (off < 0) return rate(0);
  let d: Rate = rate(0);
  for (const p of phases) {
    if (off >= p.startOffset) d = p.drift; else break;
  }
  return d;
}

function eventFlow(events: CashEvent[], a: number, t: number): NominalCNY {
  let sum = 0;
  for (const e of events) {
    if (!e.enabled) continue;
    if (a >= e.startAge && a < e.endAge) sum += e.amount * Math.pow(1 + e.growth, t);
  }
  return nominal(sum);
}

/** 名义年收入。
 *
 * 两种模型：
 *
 * **simple** —— 固定年增长，叠加两道封顶：
 *   1. 年龄封顶：到 capIncomeGrowthAt 之后不再有实际增长
 *   2. 职业天花板：不超过 incomeCeiling（今日购买力，随 CPI 保值）
 *   没有天花板的复利在 20 年尺度上会给出荒谬的收入。
 *
 * **curve** —— 生命周期曲线，三项相乘且互不重叠：
 *   名义收入 = 当前年收入 × f(age)/f(currentAge) × (1+实际工资增长)^t × (1+CPI)^t
 *   - f 是个人相对同期同龄同行的位置（经验效应），已剔除通胀与全社会工资增长
 *   - realWageGrowth 是全社会实际工资增长（时间效应）
 *   - CPI 是价格水平
 *   归一化到 currentAge 是因为用户填的是「当前年收入」而不是起薪。
 */
function incomeAt(inp: FireInput, a: number, t: number, retireAge: number): NominalCNY {
  if (a >= retireAge) return nominal(0);

  if (inp.incomeModel.kind === 'curve') {
    const c = inp.incomeModel.curve;
    const base = incomeCurveAt(c, inp.currentAge);
    const shape = base > 0 ? incomeCurveAt(c, a) / base : 1;
    return nominal(inp.annualIncome * shape
      * Math.pow(1 + inp.realWageGrowth, t)
      * Math.pow(1 + inp.cpi, t));
  }

  const cap = inp.capIncomeGrowthAt === null
    ? t
    : Math.min(t, Math.max(0, inp.capIncomeGrowthAt - inp.currentAge));
  let v = inp.annualIncome * Math.pow(1 + inp.incomeGrowth, cap);
  if (inp.incomeCeiling !== null) {
    v = Math.min(v, inp.incomeCeiling * Math.pow(1 + inp.cpi, t));
  }
  return nominal(v);
}

function merge(input: Partial<FireInput> | undefined): FireInput {
  return { ...DEFAULTS, ...(input ?? {}) };
}

/**
 * 逐年名义模拟。
 *
 * 口径（三条与参考实现不同的关键约定）：
 *  1. 年中约定 —— `期末 = 期初×(1+r) + 净现金流×√(1+r)`。现金流按年中发生、吃半年收益，
 *     比「年初到位吃满全年」更贴近按月发薪/按月消费的现实，且不会系统性高估。
 *  2. t=0 那年的支出恰好等于 annualSpend，不预先乘一次通胀。
 *  3. 应急预留金按医疗通胀滚动，不是 CPI。
 *
 * @param returnSeq 若提供，则逐年覆盖收益率（供 bootstrap 注入随机序列）。
 */
export function simulate(
  input: Partial<FireInput> | undefined,
  retireAge: number,
  returnSeq?: readonly number[]
): SimResult {
  const inp = merge(input);
  const rows: YearRow[] = [];
  let begin = inp.assets as number;
  let realFactor = 1;                 // 支出的实际购买力倍数（微笑曲线累积）
  let bankruptAge: Age | null = null;
  const n = inp.deathAge - inp.currentAge;

  for (let a = inp.currentAge as number; a <= inp.deathAge; a++) {
    const t = a - inp.currentAge;
    const income = incomeAt(inp, a, t, retireAge);
    const ev = eventFlow(inp.events, a, t);
    // 退休后先做一次水平位移（retireSpendRatio），再叠加微笑曲线的逐年漂移
    // （realFactor），最后乘通胀。三者口径互不重叠。
    const levelShift = a >= retireAge ? (inp.retireSpendRatio as number) : 1;
    const spend = inp.annualSpend * levelShift * realFactor
                  * Math.pow(1 + inp.personalInflation, t);
    const net = income + ev - spend;

    const seq = returnSeq?.[t];
    const r = seq !== undefined ? seq : (a < retireAge ? inp.rWork : inp.rRetire);

    const growth = begin * r;
    const end = begin * (1 + r) + net * Math.sqrt(1 + r);

    if (end < 0 && bankruptAge === null) bankruptAge = age(a);

    rows.push({
      age: age(a), t,
      income, events: ev,
      spend: nominal(spend), ret: nominal(growth), net: nominal(net),
      beginNominal: nominal(begin),
      endNominal: nominal(end),
      endReal: real(end / Math.pow(1 + inp.cpi, t + 1))
    });

    begin = end;
    // 微笑曲线在退休后逐年累积；退休首年支出仍等于基准值
    if (a >= retireAge) realFactor *= (1 + driftFor(a, retireAge, inp.phases, inp.smileOn));
  }

  const targetNominal = inp.reserve * Math.pow(1 + inp.medInflation, n + 1);
  const last = rows[rows.length - 1];
  const endNominal = last ? (last.endNominal as number) : (inp.assets as number);

  return {
    rows,
    retireAge: age(retireAge),
    bankruptAge,
    endNominal: nominal(endNominal),
    endReal: real(endNominal / Math.pow(1 + inp.cpi, n + 1)),
    targetNominal: nominal(targetNominal),
    // 预留金按医疗通胀滚，而折现用 CPI —— 两者差值就是这笔钱的真实变贵速度。
    // 直接用 inp.reserve 会把水位线画在远低于真实约束的位置（曾经的 bug）。
    targetReal: real(targetNominal / Math.pow(1 + inp.cpi, n + 1)),
    ok: bankruptAge === null && endNominal >= targetNominal
  };
}

/**
 * 求解最早可行的退休年龄。
 * 必须线性扫描，不能二分 —— 时间轴事件（养老金、买房、教育支出）会破坏单调性。
 */
export function solve(input: Partial<FireInput> | undefined): SolveResult {
  const inp = merge(input);
  for (let ra = inp.currentAge as number; ra <= inp.deathAge; ra++) {
    const sim = simulate(inp, ra);
    if (sim.ok) {
      return {
        fireAge: age(ra),
        yearsToFire: ra - inp.currentAge,
        sim,
        reason: ra === inp.currentAge ? 'already' : 'ok'
      };
    }
  }
  return {
    fireAge: null,
    yearsToFire: null,
    // 干到死也不够时，用「全程工作」的模拟展示缺口。
    // 退休判定是 age >= retireAge，所以取 deathAge 会让最后一年仍算退休年，
    // 少算一年工资、缺口偏悲观；必须取 deathAge + 1。
    sim: simulate(inp, inp.deathAge + 1),
    reason: 'never'
  };
}

/**
 * 安全提取率对照线，按退休年数动态取。
 * 4% 法则的前提只有 30 年（Bengen 1994 / Trinity 1998，美国 20 世纪数据）；
 * 40 岁退休活到 90 岁是 50 年，用 4% 是错的。ERN: "3.5% is the new 4%"。
 */
export function swrBenchmark(years: number): Rate {
  if (years <= 30) return rate(0.035);
  if (years >= 50) return rate(0.030);
  if (years <= 40) return rate(0.035 + (years - 30) * (0.0325 - 0.035) / 10);
  return rate(0.0325 + (years - 40) * (0.030 - 0.0325) / 10);
}

export interface Derived {
  peakAge: Age | null;
  peakReal: RealCNY;
  fireNominal: NominalCNY | null;
  fireReal: RealCNY | null;
  swr: Rate | null;
  swrBench: Rate | null;
}

export function derive(input: Partial<FireInput> | undefined, res: SolveResult): Derived {
  const inp = merge(input);
  const rows = res.sim.rows;
  const out: Derived = {
    peakAge: null, peakReal: real(-Infinity),
    fireNominal: null, fireReal: null, swr: null, swrBench: null
  };
  for (const r of rows) {
    if (r.endReal > out.peakReal) { out.peakReal = r.endReal; out.peakAge = r.age; }
  }
  if (res.fireAge !== null) {
    const idx = res.fireAge - inp.currentAge;
    const prev = rows[idx - 1];
    const atFire = idx > 0 && prev ? (prev.endNominal as number) : (inp.assets as number);
    out.fireNominal = nominal(atFire);
    out.fireReal = real(atFire / Math.pow(1 + inp.cpi, Math.max(0, idx)));
    const firstSpend = rows[idx]?.spend ?? nominal(0);
    out.swr = atFire > 0 ? rate(firstSpend / atFire) : null;
    out.swrBench = swrBenchmark(inp.deathAge - res.fireAge);
  }
  return out;
}
