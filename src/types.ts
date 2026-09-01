/* 领域类型。
 * 这个模型里几乎每个量都是 number，但单位彼此不兼容：
 * 名义 vs 实际、月度 vs 年度、比率 0.04 vs 百分数 4、今日购买力 vs 发生年份名义值。
 * 用 branded type 把这些区分出来，让编译器挡住单位串用。
 */

declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

/** 比率，小数形式（0.04 = 4%），不是百分数 */
export type Rate = Brand<number, 'Rate'>;
/** 金额，以「今日购买力」计价的人民币元 */
export type RealCNY = Brand<number, 'RealCNY'>;
/** 金额，以「发生年份名义值」计价的人民币元 */
export type NominalCNY = Brand<number, 'NominalCNY'>;
/** 年龄（周岁） */
export type Age = Brand<number, 'Age'>;

export const rate = (n: number): Rate => n as Rate;
export const real = (n: number): RealCNY => n as RealCNY;
export const nominal = (n: number): NominalCNY => n as NominalCNY;
export const age = (n: number): Age => n as Age;

/** 把百分数输入（4）转成比率（0.04）。UI 滑块一律用百分数，引擎一律用比率。 */
export const pctToRate = (p: number): Rate => (p / 100) as Rate;
export const rateToPct = (r: Rate): number => (r as number) * 100;

/** 退休后支出分段。startOffset = 退休后第几年起生效。 */
export interface SpendPhase {
  /** 退休后第几年起生效（0 = 退休当年） */
  startOffset: number;
  /** 年实际支出变化率。Blanchett (2014)：−1% / −2% / −1% */
  drift: Rate;
}

/** 时间轴现金流事件。amount 按今日购买力填写，模拟时按 growth 折算到发生年份。 */
export interface CashEvent {
  name: string;
  /** 年金额，今日购买力。正 = 流入，负 = 流出 */
  amount: RealCNY;
  startAge: Age;
  /** 右开区间：startAge <= age < endAge */
  endAge: Age;
  growth: Rate;
  enabled: boolean;
}

/** 收入生命周期曲线。
 *
 * 形状取自 Mincer (1974) 的二次式重参数化：峰值前是凹的倒 U 左半支，
 * 峰值后改用固定年化衰减 —— 若峰后继续用二次式，60 岁以后会加速跳水，不合理。
 *
 *   x  = age − entryAge          工作年限
 *   x* = peakAge − entryAge
 *   f(age) = M ^ (1 − ((x*−x)/x*)²)        age ≤ peakAge
 *   f(age) = M × (1 − d)^(age − peakAge)   age >  peakAge
 *
 * f(entryAge) = 1，f(peakAge) = M。
 *
 * 口径：这条曲线是**实际购买力**形状，已剔除通胀，也已剔除全社会实际工资增长
 * （Fang & Qiu 2023 把「经验效应」与「时间效应」分开估计）。
 * 所以它要和 realWageGrowth、通胀分别相乘，三者互不重叠。
 */
export interface IncomeCurve {
  entryAge: number;
  peakAge: number;
  /** 峰值相对**入职起薪**的倍数 */
  peakMult: number;
  /** 峰值后的年化实际衰减率 */
  declineRate: Rate;
  /** 衰减地板：不低于峰值的这个比例。null = 无地板 */
  floorRatio: number | null;
}

export type IncomeModel =
  /** 固定年增长 + 年龄封顶 + 天花板（简单模型） */
  | { kind: 'simple' }
  /** 生命周期曲线 */
  | { kind: 'curve'; preset: string; curve: IncomeCurve };

export interface FireInput {
  currentAge: Age;
  deathAge: Age;
  assets: RealCNY;
  annualIncome: RealCNY;
  incomeGrowth: Rate;
  /** 该年龄后工资不再增长；null = 不封顶 */
  capIncomeGrowthAt: number | null;
  /** 职业天花板：年收入的上限，按**今日购买力**填写。
   * 模拟时按基础通胀保值（天花板本身也会随物价上移，但不再有实际增长）。
   * null = 无上限。没有天花板的复利在 20 年尺度上会给出荒谬的收入。 */
  incomeCeiling: RealCNY | null;
  /** 天花板是否随通胀上移。
   * true  = 天花板按今日购买力理解，名义值逐年上移（职级对应的实际购买力不变）
   * false = 天花板是一个固定的名义数字（「我这辈子最多赚到 80 万」的字面意思），
   *         实际购买力会被通胀一年年吃掉 —— 更悲观，但也更接近很多人的真实处境 */
  incomeCeilingInflates: boolean;
  /** 收入模型。'simple' 用 incomeGrowth + capIncomeGrowthAt + incomeCeiling；
   * 'curve' 用生命周期曲线，此时上面三个参数不参与形状，只有 realWageGrowth 叠加。 */
  incomeModel: IncomeModel;
  /** 全社会**实际**工资增长（时间效应），与个人曲线相乘。
   *
   * 中国 1986→2012 人力资本租金价格涨 3.5 倍 ≈ 年均 4.9% 实际增速
   * （Fang & Qiu 2023）。那是高速追赶期的数值，**不可外推** ——
   * 人口下行、收敛效应，发达经济体长期实际工资增长通常只有 0.5%–1.5%。
   *
   * 保守 0.5% / 中性 1.5% / 乐观 2.5%。
   *
   * 最常见的错误是把「社会平均工资年涨 5%」塞进曲线 f 的斜率里 —— 那会双重计算。
   * f 只管**你相对同龄人**的位置，realWageGrowth 管全社会水平上移。 */
  realWageGrowth: Rate;
  annualSpend: RealCNY;
  /** 退休后支出相对当前支出的系数。1.0 = 和现在花一样多；
   * 0.7 = 只花现在的 70%（通勤、房贷、育儿等消失）；
   * 1.2 = 花得更多（旅行、爱好）。
   * 这是一次性的**水平位移**，与微笑曲线（逐年漂移）相互独立、可叠加。
   * 系数作用在今日购买力上，之后再乘通胀 —— 不要与 drift 混淆。 */
  retireSpendRatio: Rate;
  /** 基础 CPI，仅用于折现展示 */
  cpi: Rate;
  /** 年支出增长轨道 = CPI + 个人溢价 */
  personalInflation: Rate;
  /** 应急预留金增长轨道（医疗通胀） */
  medInflation: Rate;
  rWork: Rate;
  rRetire: Rate;
  reserve: RealCNY;
  smileOn: boolean;
  phases: SpendPhase[];
  events: CashEvent[];
}

export interface YearRow {
  age: Age;
  t: number;
  income: NominalCNY;
  events: NominalCNY;
  spend: NominalCNY;
  ret: NominalCNY;
  net: NominalCNY;
  beginNominal: NominalCNY;
  endNominal: NominalCNY;
  endReal: RealCNY;
}

export interface SimResult {
  rows: YearRow[];
  retireAge: Age;
  bankruptAge: Age | null;
  endNominal: NominalCNY;
  endReal: RealCNY;
  targetNominal: NominalCNY;
  targetReal: RealCNY;
  ok: boolean;
}

export type SolveReason = 'ok' | 'already' | 'never';

export interface SolveResult {
  fireAge: Age | null;
  yearsToFire: number | null;
  sim: SimResult;
  reason: SolveReason;
}
