/* 子女养育与教育成本。
 *
 * 目标是让用户「先选一个大概的档位，再微调」，而不是自己往裸事件表里填名称和金额。
 * 模块只负责算出现金流并转成 CashEvent，注入方式与 pension.ts 一致。
 *
 * 三条必须先说清楚的口径：
 *
 * 一、这里的数字是**全口径养育成本**，不是「教育支出」。它包含饮食、居住分摊、
 *     教育、医疗、交通、衣着等一个孩子在家庭账上引起的全部开销。育娲的报告就是
 *     这个口径，直接拿它当「学费+补习费」用会低估，当「额外开销」用会高估。
 *
 * 二、育娲口径**含居住分摊、不含购房本金**。计算器另有购房/租房模块，直接相加
 *     会把居住那部分算两遍。因此本模块默认按 0.8 系数扣除居住（大学段住宿费已
 *     单列，不扣），includeHousing 打开才用原始全口径。见 HOUSING_FACTOR。
 *
 * 三、**只算现金支出，不含机会成本**。育娲两版报告都把母亲误工、职业中断作为
 *     「延伸生育成本」单列，未计入经济成本；本模块同样不计。2024 版的量化是：
 *     女性照料 0—4 岁孩子减少工作 2106 小时（按 30 元/小时约 6.3 万），每生一孩
 *     女性工资率下降 12%—17%。这属于收入侧建模，不该塞进支出模块，但对 FIRE
 *     年份的影响可能大于养育支出本身，界面上应有一句提示。
 *
 * 数据来源与推算过程见 docs/ 下的调研记录；每个预设数字的出处标在下面的注释里。
 * 两版育娲报告的关系：2026 版（2026-05-29）全国 0—17 岁 58.00 万、月均 2543.84 元，
 * 2024 版（2024-02-21）53.8 万，名义 +7.8%。但两版**不可比**——2024 版基于
 * 《2023 中国统计年鉴》宏观推算，2026 版换成北大 CFPS 微观追踪 + 分层混合效应模型。
 * 分年龄段明细只有 2024 版有，所以这里用 2024 版的年龄结构做骨架、2026 版的总额
 * 做等比缩放（城镇 ×1.325 / 农村 ×0.729 / 全国 ×1.078）。
 */
import { Age, CashEvent, Rate, age, rate, real } from './types';

export type ChildTierKey = 'frugal' | 'modestPublic' | 'eduHeavy' | 'international';
export type ChildStageKey = 'preschool' | 'compulsory' | 'highschool' | 'university';

export interface ChildStage {
  key: ChildStageKey;
  name: string;
  /** 孩子年龄，左闭 */
  start: number;
  /** 孩子年龄，右开 */
  end: number;
}

/** 学段划分。0—22 岁，四段无缝衔接，22 岁后视为经济独立、不再计入。 */
export const CHILD_STAGES: readonly ChildStage[] = [
  { key: 'preschool',  name: '学前',     start: 0,  end: 6 },
  { key: 'compulsory', name: '义务教育', start: 6,  end: 15 },
  { key: 'highschool', name: '高中',     start: 15, end: 18 },
  { key: 'university', name: '大学',     start: 18, end: 22 }
];

export const CHILD_END_AGE = 22;

/** 居住分摊的扣除系数。
 * 育娲 2026 版的分项结构：0—2 岁「饮食、居住、医疗各约 25%」，3—14 岁「居住约 20%」，
 * 15—17 岁教育升至 35%、其他分项被挤压（居住约 15%，此为推算，未证实）。
 * 逐段扣不同比例更准，但差异在 ±5% 以内，不值得为此增加一张表——统一取 0.8。
 * 代价：高中段略低估、婴幼儿段略高估。大学段不适用（住宿费已单列在大学口径里）。 */
export const HOUSING_FACTOR = 0.8;

export interface ChildPreset {
  key: ChildTierKey;
  name: string;
  who: string;
  /** 各学段年支出，元/年，**今日购买力、全口径（含居住分摊）**。
   * 扣居住后的值由 HOUSING_FACTOR 现算，不另存一张表，避免两份数字对不上。 */
  stages: Readonly<Record<ChildStageKey, number>>;
  /** 教育支出增长相对 CPI 的溢价（不是绝对增长率） */
  premium: Rate;
  /** 大学段单独的溢价；不给则用 premium */
  premiumUniversity?: Rate;
  note: string;
}

/* 四档年支出。全口径、今日购买力（2024—2026 年现价）。
 *
 * 档 1 / 档 2 是把育娲 2024 版分年龄段表（0—2 岁 24538、3—5 岁 36538、
 * 6—14 岁 27007、15—17 岁 29007、大学 35500 元/年）缩放到 2026 版的农村列 / 城镇列
 * 后取整，两条独立的线交叉验证过：
 *   档 1：学前+义务+高中 = 37.2 万，育娲 2026 版农村 0—18 岁累计 39.2 万（含孕产段），差额吻合；
 *         另有 2026 版「全国必要成本」月均 1732.96 元 = 年 2.08 万佐证。
 *   档 2：0—18 岁 = 68.4 万，育娲 2026 版城镇累计 71.3 万（含孕产段），吻合。
 *         大学段 3.5 万 = 学费 7000（2023 年多省调价后）+ 住宿 1500 + 生活费 20928
 *         （麦可思 2025，2783 样本，月均 1744 元）+ 交通证书等约 5000，与育娲 2024 版
 *         独立给出的 35500 完全一致。
 *
 * 档 3 是档 2 加课外支出。**这是本次调研最弱的一环，必须如实说**：
 * 校外培训的参与率有权威时序（北大 CIEFR-HS：2016—17 学年 34.3% → 2021—22 学年 15.1%
 * → 2022—23 学年 13.5%，双减后腰斩），但「参与的人每年花多少钱」没有任何公开调查。
 * 政府指导价（浙江金华 30—45 元/课时、试点上限 80 元/课时）对应的是合规机构大班课，
 * 与「城市中产系统性补习」不是同一个市场——双减后这块转入一对一与非学科的隐形市场，
 * 无价格统计。这里用的 200 元/课时 × 3 科 × 每周 2 课时 × 40 周 = 4.8 万/年 是**设定值**，
 * 不是实证。唯一的交叉验证是总额：档 3 的 0—18 岁 145.5 万，育娲 2024 版收入最高 20%
 * 家庭 131.5 万缩放到 2026 版水平约 141.8 万——说明档 3 落在高收入组上半部，量级合理，
 * 但不能证明结构正确，也说明不宜再往上抬。
 *
 * 档 4 是自下而上搭的，没有整体实证。学费部分证据较强（2026 学年国际学校汇总：
 * 主流 IB 民办 15—20 万、外籍人员子女学校 25—36 万），生活与课外部分是设定值。
 */
export const CHILD_PRESETS: readonly ChildPreset[] = [
  {
    key: 'frugal',
    name: '穷养',
    who: '只保基本生活与义务教育，不补课不兴趣班；农村或低线城市',
    // 育娲 2026 版农村列（月均分摊 1719.34 元 / 0—18 岁累计 39.2 万）
    stages: { preschool: 21000, compulsory: 20000, highschool: 22000, university: 22000 },
    // 大学段 2.2 万 = 档 2 的 3.5 万把生活费下调到约 1200 元/月
    premium: rate(0.005),
    note: '公立路线的成本几乎完全由生活成本决定，不由学校决定'
  },
  {
    key: 'modestPublic',
    name: '小康公立',
    who: '城镇公立校，不系统补课，少量兴趣班',
    // 育娲 2026 版城镇列（月均分摊 3127.24 元 / 0—18 岁累计 71.3 万）
    stages: { preschool: 40000, compulsory: 36000, highschool: 40000, university: 35000 },
    premium: rate(0.005),
    // 义务教育段 3.6 万里，教育部分只有约 5000—7000 元（CIEFR-HS 2022—23 学年家庭生均
    // 教育支出：小学 4651、初中 6891、普高 13346、大学 29135 元），其余全是饮食、
    // 居住分摊、医疗、衣着。这解释了档 1 与档 2 的差距为什么主要不来自学校。
    note: '育娲 2026 版城镇均值。注意这是「平均」不是「必需」：同报告的净增成本中位数'
        + '只有 647.90 元/月，比平均数低 41.61%，一半家庭的实际边际支出低于平均数的六成'
  },
  {
    key: 'eduHeavy',
    name: '注重教育',
    who: '城市中产，系统性课外补习 + 多个兴趣班，义务教育段可能读民办',
    // 城镇基线 + 补习 + 兴趣班，详见上方长注释。补习单价与课时量为设定值，未证实。
    stages: { preschool: 60000, compulsory: 90000, highschool: 95000, university: 50000 },
    // 大学段 5.0 万（生活费上调 + 游学/竞赛/考研班）同样是设定值，无分组数据支撑，未证实。
    premium: rate(0.015),  // 部分未证实：校外培训无价格统计，此为建模惯例
    note: '若同时读民办义务教育学校，另加学费 3—8 万/年，本档未含'
  },
  {
    key: 'international',
    name: '国际路线',
    who: '国际 / 双语学校，本科海外',
    // 学前 = 国际幼儿园 15—20 万 + 生活 3—4 万
    // 义务教育 = 双语/国际小初 22—28 万 + 生活 4 万 + 课外 3 万
    // 高中 = 国际高中 28—36 万 + 生活 4 万 + 标化/竞赛/申请 3—5 万
    // 大学 = 海外本科 45 万（美国公立州外 $31,880 + 生活约 $20,000，按 1 USD≈7.1 折算；
    //        区间 25—80 万。汇率为估算值，实现时应按最新汇率复核）
    stages: { preschool: 200000, compulsory: 280000, highschool: 380000, university: 450000 },
    premium: rate(0.025),            // 部分未证实：唯一支撑是 2026 年上海区域普涨 20% 的自媒体报道，证据弱
    premiumUniversity: rate(0.015),  // 海外本科：College Board 2025-26 公布学费涨幅 +2.9%/+3.4%/+4.0%，比美国通胀高约 1—1.5pp
    note: '全程国际（0—22 岁 666 万）不是主流。常见的是公立读到初中、高中转国际、本科出国，'
        + '用 intlFromAge 表达；默认 15 岁转轨约 350 万，义务教育段走档 3 则约 400 万'
  }
];

export function childPreset(key: ChildTierKey): ChildPreset {
  const p = CHILD_PRESETS.find(x => x.key === key);
  // 找不到就退回小康公立：这是一个 UI 传参错误，不该让整条曲线崩掉
  return p ?? (CHILD_PRESETS[1] as ChildPreset);
}

/* 多孩边际折扣。育娲 2026 版首次量化了生育的规模经济（衣物玩具复用、住房共享）：
 *   第一孩 100% · 第二孩 71.50% · 第三孩 60.95% · 第四孩及以上 37.10%
 * 2024 版用另一口径（分孩次的家庭平均成本）佐证：城镇二孩/一孩 78.7%、三孩/一孩 59.8%。
 *
 * 口径提示：2024 版那组是「二孩家庭中每个孩子的平均成本」，2026 版是「第二个孩子的
 * 边际成本」，两者不是同一个量、不能互换。计算器要回答的是「再生一个多花多少钱」，
 * 所以用 2026 版的边际口径。 */
export const SIBLING_COEF_FULL: readonly number[] = [1, 0.7150, 0.6095, 0.3710];

/* 已扣除居住成本时的孩次系数。**未证实**——这是把上面的实证值上调后的建模惯例值。
 * 理由：住房共享是折扣的重要来源，扣除居住后它已被移出分母，剩余部分的折扣理论上
 * 应当更浅。育娲只公布了总折扣，没有拆出住房、耐用品、教育各占多少，所以这个上调
 * 幅度没有数据支撑，只是方向可靠。 */
export const SIBLING_COEF_EX_HOUSING: readonly number[] = [1, 0.80, 0.70, 0.45];

export function siblingCoef(rank: number, includeHousing: boolean): number {
  const table = includeHousing ? SIBLING_COEF_FULL : SIBLING_COEF_EX_HOUSING;
  const i = Math.max(1, Math.round(rank)) - 1;
  return table[Math.min(i, table.length - 1)] ?? 1;
}

/** 国家育儿补贴：3600 元/年/孩，3 周岁以下，2025-01-01 起（中办国办《育儿补贴制度
 * 实施方案》2025-07-28）。一孩二孩三孩**同等**、免征个税——这是唯一不跟着成本
 * 打折的现金流，按孩数线性计入。名义定额，方案未规定随物价上调，故 growth 取 0。 */
export const CHILDCARE_ALLOWANCE = 3600;

/** 一个孩子的现状。已出生用 born，还没出生用 planned（「还有几年生」）。 */
export type ChildSpec =
  | {
      kind: 'born';
      /** 当前周岁 */
      age: number;
      /** 用户声明「现在每年在这个孩子身上大约花多少」，今日购买力。
       * 这是防重复计算的关键：家庭年支出里已经含了这笔钱，模块只能加**增量**。
       * 填 0 表示用户填的年支出本身就不含这个孩子（少见，但接口上要能表达）。 */
      currentSpend: number;
    }
  | {
      kind: 'planned';
      /** 还有几年出生。0 = 今年 */
      yearsUntilBirth: number;
    };

export interface ChildCfg {
  enabled: boolean;
  tier: ChildTierKey;
  /** 几岁转国际路线。只在 tier === 'international' 时生效，此前按 preIntlTier 走。
   * 做成参数而不是只给「全程国际」一个档，是因为全程国际（666 万）现实中不是主流，
   * 而且这个转轨点是路径依赖的——一旦进国际体系很难回头（课程不衔接、无法高考）。 */
  intlFromAge: number;
  /** 转国际之前走哪一档 */
  preIntlTier: ChildTierKey;
  children: ChildSpec[];
  /** true = 用育娲原始全口径（含居住分摊）。默认 false，即扣除居住，可与购房模块安全叠加。 */
  includeHousing: boolean;
  /** 是否启用多孩边际折扣 */
  siblingDiscount: boolean;
  /** 是否计入育儿补贴 */
  subsidy: boolean;
  /** 公办园学前一年保教费减免，元/年，作用于 5—6 岁。
   * 2025 年秋季学期起免除公办园学前一年保教费（民办参照同类型公办园减免水平）。
   * 默认 0：各地保教费标准差异很大，没有一个能追溯到来源的全国数额，宁可不预填。 */
  preschoolWaiver: number;
  /** 覆盖档位默认的教育通胀溢价；null = 用档位默认值。
   *
   * 为什么默认值只有 0.5—2.5pp：流行的「教育通胀很高」在数据上站不住。
   * 教育服务 CPI 2001—2023 年均 +2.5%，同期总体 CPI 年均约 +2.1%—2.3%，超额只有
   * 0.2—0.4pp；2025 年教育服务 +1.0%，超额约 1.0—1.4pp。常被引用的「2025 年人均
   * 教育文化娱乐支出 +9.4%」是**消费量增加，不是通胀**，把它当涨价率是最常见的错误。
   * 真正的缺口在于教育服务 CPI 只覆盖受管制的学费，不覆盖双减后转入隐形市场的校外
   * 培训、国际学校学费、海外留学费用，以及每 10—15 年一次的公办高校台阶式调价
   * （2023 年多省上调 20%—40%）。所以档位溢价里约一半是建模惯例而非实证。 */
  premiumOverride: Rate | null;
}

/** 默认关闭，且不影响任何现有结果。 */
export const DEFAULT_CHILD: ChildCfg = {
  enabled: false,
  tier: 'modestPublic',
  intlFromAge: 15,
  preIntlTier: 'modestPublic',
  // 默认给一个「还没出生」的孩子：这条路径的口径天然正确（用户填的年支出本来就
  // 不含孩子），不需要用户再拆一个「不含孩子的年支出」出来。
  children: [{ kind: 'planned', yearsUntilBirth: 2 }],
  includeHousing: false,
  siblingDiscount: true,
  subsidy: true,
  preschoolWaiver: 0,
  premiumOverride: null
};

/** 外部参数。刻意不直接依赖 FireInput 的字段名——那边的字段会改。 */
export interface ChildCtx {
  currentAge: Age;
  /** 基础 CPI。教育支出增长率 = cpi + 档位溢价 */
  cpi: Rate;
  /** 家庭年支出的增长轨道（engine 里的 personalInflation）。
   * 只用于「已计入年支出的部分」这一项扣除——它跟着家庭支出走，不跟教育通胀走。 */
  spendGrowth: Rate;
}

export function stageOf(childAge: number): ChildStage | null {
  for (const s of CHILD_STAGES) if (childAge >= s.start && childAge < s.end) return s;
  return null;
}

/** 某岁走哪一档。只有国际路线有转轨，其余档位全程同档。 */
function tierAt(cfg: ChildCfg, tier: ChildTierKey, childAge: number): ChildTierKey {
  if (tier !== 'international') return tier;
  if (childAge >= cfg.intlFromAge) return 'international';
  return cfg.preIntlTier === 'international' ? 'international' : cfg.preIntlTier;
}

/** 一个孩子在 childAge 岁的年支出，今日购买力。已含口径处理与多孩折扣，不含补贴与扣除项。 */
export function childAnnualCost(
  cfg: ChildCfg, childAge: number, rank: number, tier: ChildTierKey = cfg.tier
): number {
  const stage = stageOf(childAge);
  if (stage === null) return 0;
  const t = tierAt(cfg, tier, childAge);
  const full = childPreset(t).stages[stage.key];
  // 大学段不扣居住：那 3.5 万里的住宿费是单列的，家庭居住分摊本就不在其中
  const housing = cfg.includeHousing || stage.key === 'university' ? 1 : HOUSING_FACTOR;
  const sib = cfg.siblingDiscount ? siblingCoef(rank, cfg.includeHousing) : 1;
  return full * housing * sib;
}

/** 该年的教育支出名义增长率 = cpi + 溢价。 */
function growthAt(cfg: ChildCfg, ctx: ChildCtx, childAge: number, tier: ChildTierKey): number {
  const stage = stageOf(childAge);
  const p = childPreset(tierAt(cfg, tier, childAge));
  const base = stage !== null && stage.key === 'university' && p.premiumUniversity !== undefined
    ? p.premiumUniversity
    : p.premium;
  const premium = (cfg.premiumOverride ?? base) as number;
  return (ctx.cpi as number) + premium;
}

/** 单个孩子 0—22 岁的合计支出，今日购买力、不贴现、不含通胀、不含补贴。
 * 给界面显示「这一档大概要花多少」用，也是对表校验的入口。 */
export function childLifetimeTotal(
  cfg: ChildCfg, tier: ChildTierKey = cfg.tier, rank = 1
): number {
  let s = 0;
  for (let k = 0; k < CHILD_END_AGE; k++) s += childAnnualCost(cfg, k, rank, tier);
  return s;
}

/** 孩子出生那年的家长年龄。已出生的孩子可能为负（家长当年还没到 currentAge），无妨。 */
function birthParentAge(c: ChildSpec, currentAge: number): number {
  return c.kind === 'born' ? currentAge - c.age : currentAge + c.yearsUntilBirth;
}

/** 按孩次（出生先后）排序，返回 [规格, 孩次] 对。孩次决定多孩折扣。 */
function ranked(cfg: ChildCfg, currentAge: number): { spec: ChildSpec; rank: number }[] {
  return cfg.children
    .map(spec => ({ spec, born: birthParentAge(spec, currentAge) }))
    .sort((a, b) => a.born - b.born)
    .map((x, i) => ({ spec: x.spec, rank: i + 1 }));
}

function push(
  out: CashEvent[], name: string, amount: number, startAge: number, endAge: number, growth: number
): void {
  if (endAge <= startAge || amount === 0) return;
  out.push({
    name,
    amount: real(amount),
    startAge: age(startAge),
    endAge: age(endAge),
    growth: rate(growth),
    enabled: true
  });
}

/**
 * 转成 engine 的事件。engine 口径：a 是**家长**的年龄，金额 = amount × (1+growth)^t，
 * t = a − currentAge，amount 按今日购买力填写。所以这里要把孩子年龄换算成家长年龄。
 *
 * 每个孩子最多产生：各学段的支出事件（负）、育儿补贴（正）、学前一年保教费减免（正）、
 * 以及「已计入年支出的部分」的扣除（正）。支出与扣除分成两个事件而不是相减，是因为
 * 两者的增长率不同——支出跟教育通胀，扣除跟家庭支出通胀，合并会算错其中一个。
 */
export function childEvents(cfg: ChildCfg, ctx: ChildCtx): CashEvent[] {
  if (!cfg.enabled) return [];
  const now = ctx.currentAge as number;
  const out: CashEvent[] = [];

  for (const { spec, rank } of ranked(cfg, now)) {
    const born = birthParentAge(spec, now);
    const label = `子女${rank}`;
    // 孩子 k 岁 → 家长 born + k 岁
    const pAge = (k: number): number => born + k;

    // 支出：逐岁算出金额与增长率，再把「同一学段内金额和增长率都相同」的连续年份并成
    // 一个事件。这样国际路线在学段中途转轨（比如 12 岁转）也能自然切成两段。
    let runFrom = -1, runCost = 0, runGrowth = 0, runStage = '';
    const flush = (k: number): void => {
      if (runFrom < 0) return;
      const from = Math.max(now, pAge(runFrom));
      push(out, `${label}·${runStage}`, -runCost, from, pAge(k), runGrowth);
      runFrom = -1;
    };
    for (let k = 0; k < CHILD_END_AGE; k++) {
      const stage = stageOf(k);
      if (stage === null) continue;
      if (pAge(k + 1) <= now) continue;            // 这一岁已经过去了
      const cost = childAnnualCost(cfg, k, rank);
      const g = growthAt(cfg, ctx, k, cfg.tier);
      if (runFrom >= 0 && (cost !== runCost || g !== runGrowth || stage.name !== runStage)) flush(k);
      if (runFrom < 0) { runFrom = k; runCost = cost; runGrowth = g; runStage = stage.name; }
    }
    flush(CHILD_END_AGE);

    // 育儿补贴：0—3 岁，名义定额，不打折、不随孩次递减
    if (cfg.subsidy) {
      push(out, `${label}·育儿补贴`,
        CHILDCARE_ALLOWANCE, Math.max(now, pAge(0)), pAge(3), 0);
    }

    // 学前最后一年保教费减免（5—6 岁）
    if (cfg.preschoolWaiver > 0) {
      push(out, `${label}·学前一年保教费减免`,
        cfg.preschoolWaiver, Math.max(now, pAge(5)), pAge(6),
        growthAt(cfg, ctx, 5, cfg.tier));
    }

    // 防重复计算：已出生的孩子，其开销已经躺在用户填的家庭年支出里，
    // 必须把这部分加回来，模块净加的才是**增量**（档位成本 − 用户声明的 X）。
    // 扣除只做到孩子 22 岁为止：22 岁以后本模块不再产生支出，家庭年支出是不是也该
    // 同步下调是另一个问题（那是 retireSpendRatio 的活），这里不替用户凭空省钱。
    if (spec.kind === 'born' && spec.currentSpend > 0) {
      push(out, `${label}·已计入年支出的部分`,
        spec.currentSpend, now, Math.max(now, pAge(CHILD_END_AGE)), ctx.spendGrowth as number);
    }
  }

  return out;
}

/**
 * 本年因子女增加的支出，今日购买力、正数表示多花。
 *
 * 这个数必须显示在界面上。用户看到「今年因为孩子多花 8.4 万」时能立刻判断离不离谱，
 * 从而发现自己是不是把孩子的开销算了两遍——这比在输入框旁边写任何提示都管用。
 * 已经把补贴和「已计入年支出的部分」都扣掉了，所以它可能是负数（用户声明的 X 大于
 * 档位成本），那说明用户选低了档，也是有意义的信号。
 */
export function childSpendThisYear(cfg: ChildCfg, ctx: ChildCtx): number {
  const a = ctx.currentAge as number;
  let s = 0;
  for (const e of childEvents(cfg, ctx)) {
    if (!e.enabled) continue;
    if (a >= e.startAge && a < e.endAge) s -= e.amount as number;   // 流出为负，取反得「支出」
  }
  return s;
}
