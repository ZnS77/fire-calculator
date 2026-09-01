/* 中国城镇职工基本养老保险测算。
 * 法规依据逐条标在函数上方，完整版见 docs/养老金规则.md。
 */
import { Age, CashEvent, NominalCNY, Rate, RealCNY, age, nominal, rate, real } from './types';

/** 计发月数表（国发〔2005〕38 号 附件，现行有效）。
 * 注：人社部曾表态要配合弹性退休修订此表，截至 2026-09 未见正式新表发布。 */
export const MONTHS_TABLE: Readonly<Record<number, number>> = {
  50:195, 51:190, 52:185, 53:180, 54:175, 55:170, 56:164, 57:158, 58:152,
  59:145, 60:139, 61:132, 62:125, 63:117, 64:109, 65:101, 66:93, 67:84,
  68:75, 69:65, 70:56
};

export function monthsFor(a: number): number {
  const k = Math.round(a);
  const v = MONTHS_TABLE[k];
  if (v !== undefined) return v;
  if (k < 50) return 195;
  if (k > 70) return 56;
  return 139;
}

export type RetireCategory = 'male' | 'female55' | 'female50';

/**
 * 法定退休年龄。《国务院关于渐进式延迟法定退休年龄的办法》
 * （2024-09-13 十四届全国人大常委会第十一次会议批准，2025-01-01 施行）：
 *   男 60→63，每 4 个月延 1 个月，1965-01 起算；
 *   女干部 55→58，每 4 个月延 1 个月，1970-01 起算；
 *   女工人 50→55，每 2 个月延 1 个月，1975-01 起算。
 * 封顶：1976-09 后出生男性一律 63；1981-09 后女干部 58；1984-11 后女工人 55。
 */
export function statutoryRetireAge(
  birthYear: number, birthMonth: number, category: RetireCategory = 'male'
): number {
  const m = birthYear * 12 + (birthMonth - 1);
  const spec = {
    male:     { base: 1964 * 12 + 11, step: 4, maxAdd: 36, from: 60 },
    female55: { base: 1969 * 12 + 11, step: 4, maxAdd: 36, from: 55 },
    female50: { base: 1974 * 12 + 11, step: 2, maxAdd: 60, from: 50 }
  }[category];
  const n = m - spec.base;
  if (n <= 0) return spec.from;
  return spec.from + Math.min(Math.ceil(n / spec.step), spec.maxAdd) / 12;
}

/** 最低缴费年限。同一《办法》第二条：2030-01-01 起由 15 年每年提高 6 个月至 20 年。
 * 2025–2029 均为 15 年；2039 及以后为 20 年。 */
export function minContributionYears(retireYear: number): number {
  if (retireYear <= 2029) return 15;
  if (retireYear >= 2039) return 20;
  return 15 + (retireYear - 2029) * 0.5;
}

export type BaseMode = 'min' | 'income' | 'max';

/** 缴费基数钳在当地社平的 60%–300%（全国统一原则）。 */
export function contribBase(mode: BaseMode, monthlyIncome: number, socialAvg: number): number {
  const lo = socialAvg * 0.6, hi = socialAvg * 3.0;
  if (mode === 'min') return lo;
  if (mode === 'max') return hi;
  return Math.min(hi, Math.max(lo, monthlyIncome));
}

/**
 * 个人账户记账利率默认值：与社平增长率联动，取 socialGrowth − 1.5pp。
 * 历年公布值（人社部统一公布）：
 *   2016 8.31% · 2017 7.12% · 2018 8.29% · 2019 7.61% · 2020 6.04%
 *   2021 6.69% · 2022 6.12% · 2023 3.97% · 2024 2.62% · 2025 1.50%
 * 2016–2022 的 6%–8% 是与社平增长挂钩的政策性定价，2023 年起已转向市场利率锚。
 * 长期利率低于工资增长是结构性的 —— 这正是「个人账户待遇被持续稀释」的机制来源。
 * 用联动参数而非固定值，用户调高社平增长时能自动看到稀释加剧。
 */
export function defaultAccountRate(socialGrowth: number): Rate {
  return rate(Math.max(0, socialGrowth - 0.015));
}

/**
 * 养老金年上调率。《社会保险法》第十八条只把「职工平均工资增长、物价上涨」列为参考
 * 因素，与 CPI 无公式挂钩；实际调整由基金收支压力驱动。
 * 2016–2025 单调下滑：6.5 / 5.5 / 5.0 / 5.0 / 5.0 / 4.5 / 4.0 / 3.8 / 3.0 / 2.0（%）。
 * 不可用十年均值 4.5% 外推 —— 那是已结束的补涨期。
 */
export const COLA = {
  conservative: rate(0.01),
  neutral: rate(0.02),
  optimistic: rate(0.03)
} as const;

export interface PensionInput {
  currentAge: Age;
  /** 参保起始年龄 */
  joinAge: number;
  /** 停止工作的年龄（= 求解出的 FIRE 年龄） */
  stopAge: number;
  /** 法定领取年龄 */
  claimAge: number;
  /** 停工后是否以灵活就业身份续缴至法定退休年龄 */
  keepPaying: boolean;
  /** 当地月计发基数 = 上年度全口径城镇单位就业人员月均工资 */
  socialAvg: number;
  socialGrowth: Rate;
  /** 当前税前月收入（'income' 模式定基数用） */
  monthlyIncome: number;
  incomeGrowth: Rate;
  /** 该年龄后本人工资不再增长（与主模型的 capIncomeGrowthAt 一致）；null = 不封顶。
   * 必须传：封顶后社平仍在涨，缴费指数会逐年下滑，直接影响基础养老金。 */
  capIncomeGrowthAt?: number | null;
  /** 职业天花板：税前月薪上限，按今日购买力计，随 cpi 保值。null / 省略 = 无上限。
   * 与主模型的 incomeCeiling 同源 —— 缴费基数也必须受它约束。 */
  monthlyIncomeCeiling?: number | null;
  /** 天花板保值用的通胀率（基础 CPI） */
  cpi?: Rate;
  baseMode: BaseMode;
  /** 不给则走 defaultAccountRate(socialGrowth) */
  accountRate?: Rate;
  /** 已缴年限；不给则由 currentAge − joinAge 推算 */
  priorYears?: number;
  /** 已有个人账户余额；给了就跳过历史回溯直接采用 */
  priorAccount?: number;
  /** 历史平均缴费指数，默认 1.0 */
  priorIndex?: number;
  currentYear?: number;
}

export interface PensionResult {
  years: number;
  /** 缴费指数的起止值，用于让用户看见「工资封顶后指数下滑」 */
  indexFirst: number;
  indexLast: number;
  /** 是否有年份撞上 300% 顶格上限 */
  cappedAtCeiling: boolean;
  contribYearsFuture: number;
  avgIndex: number;
  account: number;
  payBase: number;
  basic: number;
  accountPension: number;
  monthly: number;
  annual: number;
  requiredYears: number;
  qualified: boolean;
  shortfallYears: number;
  claimAge: number;
  months: number;
  /** 灵活就业续缴的首年成本（名义值，停工当年口径） */
  selfPayAnnualFirst: number;
}

/**
 * 养老金测算。
 *   基础养老金   = 计发基数 × (1 + 本人平均缴费指数) ÷ 2 × 缴费年限 × 1%
 *   个人账户养老金 = 个人账户储存额 ÷ 计发月数
 * 过渡性养老金仅对有视同缴费年限者（一般 1996 年前参加工作）适用，1996 年后
 * 首次参保为 0，本模型不计 —— FIRE 目标用户基本落在此列。
 */
export function project(o: PensionInput): PensionResult {
  const claimAge = o.claimAge;
  const payUntil = o.keepPaying ? claimAge : o.stopAge;
  const g = o.socialGrowth as number;
  const ig = o.incomeGrowth as number;
  const accRate = (o.accountRate ?? defaultAccountRate(g)) as number;
  const priorIndex = o.priorIndex ?? 1.0;

  let years = 0, idxSum = 0, account = o.priorAccount ?? 0;

  // 历史段：用已缴年限概括，避免虚构历史工资序列
  const pastYears = o.priorYears ?? Math.max(0, o.currentAge - o.joinAge);
  if (pastYears > 0) {
    years += pastYears;
    idxSum += pastYears * priorIndex;
    // 个人账户回溯：按当前基数除以社平增长折回当年，从最久远的一年开始累计，
    // 保证越早的缴费复利越久（顺序写反会显著高估账户余额）。
    if (o.priorAccount === undefined) {
      const b0 = contribBase(o.baseMode, o.monthlyIncome, o.socialAvg);
      for (let j = pastYears; j >= 1; j--) {
        account = (account + (b0 / Math.pow(1 + g, j)) * 0.08 * 12) * (1 + accRate);
      }
    }
  }

  // 未来段：currentAge → payUntil。停工后自缴费率 20%，个人账户仍为 8%。
  let contribYearsFuture = 0;
  let indexFirst = 0, indexLast = 0, cappedAtCeiling = false;
  const capAge = o.capIncomeGrowthAt ?? null;
  for (let a = o.currentAge as number; a < payUntil; a++) {
    const t = a - o.currentAge;
    const sa = o.socialAvg * Math.pow(1 + g, t);
    // 工资封顶后本人收入不再增长，而社平继续涨 —— 缴费指数会逐年下滑
    const growT = capAge === null ? t : Math.min(t, Math.max(0, capAge - o.currentAge));
    let inc = o.monthlyIncome * Math.pow(1 + ig, growT);
    const ceil = o.monthlyIncomeCeiling ?? null;
    if (ceil !== null) inc = Math.min(inc, ceil * Math.pow(1 + (o.cpi ?? 0.022), t));
    const base = contribBase(o.baseMode, inc, sa);
    if (base >= sa * 3 - 1e-6) cappedAtCeiling = true;
    account = (account + base * 0.08 * 12) * (1 + accRate);
    const idx = base / sa;
    if (contribYearsFuture === 0) indexFirst = idx;
    indexLast = idx;
    idxSum += idx;
    years += 1;
    contribYearsFuture += 1;
  }

  // 停缴后至领取前，个人账户继续记息
  for (let a = payUntil; a < claimAge; a++) account *= (1 + accRate);

  const avgIndex = years > 0 ? idxSum / years : 0;
  const claimT = claimAge - o.currentAge;
  const payBase = o.socialAvg * Math.pow(1 + g, claimT);

  const basic = payBase * (1 + avgIndex) / 2 * years * 0.01;
  const accountPension = account / monthsFor(claimAge);

  const retireYear = (o.currentYear ?? new Date().getFullYear()) + claimT;
  const requiredYears = minContributionYears(retireYear);

  const selfPayAnnualFirst = o.keepPaying && o.stopAge < claimAge
    ? contribBase(
        o.baseMode,
        o.monthlyIncome * Math.pow(1 + ig,
          capAge === null ? Math.max(0, o.stopAge - o.currentAge)
                          : Math.min(Math.max(0, o.stopAge - o.currentAge),
                                     Math.max(0, capAge - o.currentAge))),
        o.socialAvg * Math.pow(1 + g, Math.max(0, o.stopAge - o.currentAge))
      ) * 0.20 * 12
    : 0;

  return {
    years, contribYearsFuture, avgIndex, account, payBase,
    indexFirst, indexLast, cappedAtCeiling,
    basic, accountPension,
    monthly: basic + accountPension,
    annual: (basic + accountPension) * 12,
    requiredYears,
    qualified: years >= requiredYears,
    shortfallYears: Math.max(0, requiredYears - years),
    claimAge, months: monthsFor(claimAge),
    selfPayAnnualFirst
  };
}

/** 转成 engine 的事件。engine 口径：amount × (1+growth)^t（t 自 currentAge 起算），
 * 而 project() 给出的是 claimAge 当年的名义年金，故需折回 t=0 的等价额。 */
export function toEvent(
  res: PensionResult, opts: { currentAge: Age; deathAge: Age; colaRate?: Rate }
): CashEvent {
  const cola = (opts.colaRate ?? COLA.neutral) as number;
  const t = res.claimAge - opts.currentAge;
  return {
    name: '基本养老金',
    amount: real(res.annual / Math.pow(1 + cola, t)),
    startAge: age(res.claimAge),
    endAge: age(opts.deathAge + 1),
    growth: rate(cola),
    enabled: res.qualified
  };
}

/** 灵活就业续缴的年成本，转成 engine 的支出事件（负值）。 */
export function toSelfPayEvent(
  res: PensionResult, opts: { currentAge: Age; stopAge: number; socialGrowth: Rate }
): CashEvent {
  const g = opts.socialGrowth as number;
  const t = Math.max(0, opts.stopAge - opts.currentAge);
  return {
    name: '灵活就业续缴（养老 20%）',
    amount: real(-res.selfPayAnnualFirst / Math.pow(1 + g, t)),
    startAge: age(opts.stopAge),
    endAge: age(res.claimAge),
    growth: rate(g),
    enabled: res.selfPayAnnualFirst > 0
  };
}
