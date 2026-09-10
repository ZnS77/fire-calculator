/* 购房与房贷模块。
 *
 * 定位与 pension.ts 一样：一组独立配置 → 算出结果 → 转成若干 CashEvent 注入主引擎。
 * 不碰 FireInput，外部参数一律走 HouseCtx 传入。
 *
 * 这个模块最容易出错的不是公式，是口径。四条写在前面：
 *
 * 1. 等额本息月供在整个还款期内**名义金额一分不变**。所以月供事件必须 growth = 0
 *    （engine 的 eventFlow 算的是 amount × (1+growth)^t，growth=0 就是逐年名义恒定）。
 *    若当成「随通胀增长的实际固定支出」处理，会高估后期负担 25%–35%（2%–3% 通胀下），
 *    足以改变 FIRE 年龄的结论。这是本模块最容易出的数值错误。
 * 2. 首付是**资产转移**不是支出：它把流动金融资产换成不动产，砍的是本金和之后所有复利，
 *    但不能进「年支出」基数（否则会被 25 倍法则之类的规则再放大一遍）。
 *    这里把它做成一次性负现金流事件，正好只影响资产端，不影响 annualSpend。
 *    契税、中介费才是真正的一次性支出，同样走一次性事件。
 * 3. 防双重计算：用户填的「当前年支出」几乎必然已经含了房租或已有月供。
 *    买房后那笔要抵扣掉，只把差额加进去。注意两者性质不同 ——
 *    被抵扣的房租随通胀涨，月供名义固定，实现时不能混。
 * 4. 卖房后要重新开始付房租（且随通胀涨）。漏掉它，「退休后卖房」会变成无成本的免费变现。
 *
 * 还有一条模型边界要说清楚：主引擎的资产只有金融资产，房子在卖出前不计入净值。
 * 所以买房当年净值会掉一大块，之后靠卖房事件再回来。这是刻意的 ——
 * 自住房不产生可支取现金流，把它按市值计入 FIRE 资产会让「够不够退休」的判断失真。
 *
 * 数字出处见 docs 与本文件各处注释；标「未证实」的一律保留标注，不要在文档里写成实证。
 */
import { Age, CashEvent, Rate, age, rate, real } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// 一、单价、面积与租金
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **为什么这里没有「城市档位」**（2026-09 撤除，先读这段）。
 *
 * 本模块曾经有 6 个城市档位卡（一线核心 / 强二线 / 三四线……），每档带一个默认单价，
 * 再叠一个「核心区 / 主城 / 近郊」的区位倍数。现在全部删掉，改成用户直接填单价与面积。
 *
 * 撤除的理由不是数字算错了，是**证据强度不均**而界面看不出来：
 * 一线有分区数据交叉验证；强二线只核查了南京，天津 / 苏州 / 宁波未核；
 * 弱二线与三四线完全未核查；公积金额度里杭州、南京未证实，弱二线以下纯推算。
 * 这些标注写在注释和文档里了，但用户看不见 —— 界面上它就是一张写着具体数字的卡片，
 * 和证据充分的那几档长得一模一样。把推算当实证呈现，是本项目明令禁止的事。
 *
 * 更根本的一条：默认给出「城市 → 价格」的标签本身就在误导。用户能判断自己所在城市的
 * 数字对不对，但对其他城市没有感觉 —— 一个他无法证伪的默认值，比没有默认值更糟。
 *
 * **区位维度也随之删除**：它解决的问题（「一个城市档没法同时代表内环和近郊」）
 * 是城市档位自己制造的。用户直接填单价之后，区位没有存在意义。
 *
 * 原来那 6 档的数字、来源与证据强度判定移进了 docs/生活模块.md 的附录 ——
 * 作为参考资料保留，不再作为程序默认值。
 */

/** 单价默认 20,000 元/㎡。这是一个**中性起点**，不代表任何具体城市：
 * 全国基准参照百城二手住宅均价 12,527 元/㎡（中指研究院 2026-08），
 * 一线主城则在 5 万以上 —— 2 万落在两者之间，谁看了都知道要按自己的情况改。
 * 界面上单价既有滑块也有输入框，就是为了让「改」这件事零成本。 */
export const DEFAULT_PRICE_PER_SQM = 20000;

/** 面积默认 100㎡。城市家庭里典型的三居，也是个好算的整数 ——
 * 单价 × 面积在脑子里就能对账，用户一眼能看出总价对不对。
 * 二手成交面积段没有全国性的公开数据（唯一能追到的是新房口径，不可跨产品类型套用），
 * 所以这里不假装它有依据，就是个通用默认值。 */
export const DEFAULT_AREA_SQM = 100;

/**
 * 每平米月租金 34 元。
 *
 * 来源：中指研究院 50 城住宅平均租金 2026-07 为 **34.01 元/㎡·月**，
 * 这是本模块唯一一个有来源的**全国**租金数，所以拿它当默认值的换算基准。
 * 分层实测差异极大（北上深 81–83 元/㎡·月，2026-05），所以它只是起点不是结论 ——
 * 界面上必须写明「换算出的租金回报率以你自己查到的实际租金为准」。
 */
export const RENT_PER_SQM = 34;

/** 该面积按 34 元/㎡·月折算的月租金，元。 */
export function rentFor(areaSqm: number): number {
  return Math.round(RENT_PER_SQM * areaSqm);
}

/**
 * 公积金可贷上限。
 *
 * **没有城市概念之后，这里只能给一个通用默认值**：额度是逐城市的政策，
 * 差异极大，任何单值都不代表任何具体城市。已核到的几个（家庭双缴存口径）：
 *   北京   首套 240 万 / 二套 200 万（截至 2026-08，来源为知乎政策整理，
 *          未取到北京住房公积金管理中心原文，证据强度弱于沪深蓉）
 *   上海   首套 200 万 / 二套 160 万，个人 100 万 / 80 万（上海市住建委，2026-02-26 起施行）
 *   深圳   基础 130 万，首套上浮 60% 后 208 万；单人 70 万 → 112 万（深圳市住建局，2026-04-30 起）
 *   武汉   150 万（媒体整理，未取到武汉公积金中心原文，中等强度）
 *   成都   120 万（新房再上浮 20% 至 144 万）；单人 80 万（新华网，2026-03-25 起）
 * 100 万是这个区间的下沿，取它当默认值是为了不高估可贷额 —— 高估会让首付显得偏低。
 * 界面上必须把上面这串差异摆出来，并要求用户按当地公积金中心公布的数填。
 *
 * 关键提示：城市上限只是三个约束中的一个。
 *   实际可贷额 = min(城市上限, 账户余额倍数上限, 月缴存额对应的还款能力上限)
 * 本模块只取城市上限，界面上必须提示「实际额度可能更低」。
 */
export const DEFAULT_HPF_CAP = 1000000;

// ─────────────────────────────────────────────────────────────────────────────
// 二、房贷参数与政策常量
// ─────────────────────────────────────────────────────────────────────────────

/** 付款方式。组合贷是中国购房常态：公积金部分按额度封顶，超出部分走商贷。 */
export type PayMode =
  /** 全款 */
  | 'cash'
  /** 纯商贷 */
  | 'commercial'
  /** 纯公积金（额度不足的部分只能加首付补齐） */
  | 'hpf'
  /** 组合贷 */
  | 'combo';

/**
 * 政策常量。都是法规数字，写死即可，改动时把时点一起改。
 *
 * LPR 5 年期以上 3.5%（2025-05 下调 10BP 后未再调整，2026-07-20 报价仍为 3.5%）。
 * 商贷执行利率默认 3.05%：多个地方页面口径一致；另有「一线首套 3.2%–3.45%」的说法
 * （融360 转载），与「北京 3.05%」直接冲突，两处均为聚合站，**未证实**。
 * 界面上标「各行各城差异 ±0.3pct」。
 */
export const POLICY = {
  /** 商贷首套主流执行利率，2026 年各地银行 */
  comRate: rate(0.0305),
  /** 公积金 5 年以上首套，中国人民银行 2025-05-08 起新发放执行（存量 2026-01-01 起） */
  hpfRate: rate(0.026),
  /** 公积金 5 年以上二套 3.075%；5 年以下首套 2.1% / 二套 2.525%。本模块只用首套长期档 */
  hpfRateSecond: rate(0.03075),
  /** 全国最低首付下限。2024-09-24 央行、金融监管总局：不再区分首套二套，统一不低于 15% */
  minDownRatio: 0.15,
  /** 贷款期限上限。2026-08-28 央行、金融监管总局《关于改革完善房地产信贷管理、
   * 促进房地产发展新模式加快构建的意见》把上限从 30 年提到 40 年。
   * 注意：文件只给上限不是强制标准，30 年仍是主流；且受银行内控「年龄 + 年限 ≤ 70 岁」
   * 约束（建行等可放宽至 75、最高 80，属内控非监管硬规定）。 */
  maxLoanYears: 40,
  /** 主流选择，也是本模块默认 */
  defaultLoanYears: 30
} as const;

/**
 * 首付比例参考（2026 年，商贷首套 / 二套 / 公积金首套 / 二套）：
 *   北京 15% / 20% / 20% / 25%
 *   上海 15% / 25% / 15% / 15%
 *   深圳 15% / 20% / 20% / 20%
 *   广州 15% / 15% /  —  /  —
 * 全国下限 15% 是硬的（2024-09-24 起）；城市加码部分来自本地宝/新浪整理，
 * 未逐条回溯到各市住建局原文，**中等强度**，界面上标「以当地最新政策为准」。
 * 二套定价：2024-09-24 新政后多数城市已不再区分首套二套，故本模块不做首套/二套开关。
 */
export const DOWN_RATIO_NOTE = '全国下限 15%（2024-09-24 起，不再区分首套二套）。部分城市二套仍加码，以当地最新政策为准。';

/**
 * 房价年增长率三档。
 *
 * **默认 0%，绝不能默认正增长。** 证据：70 城二手住宅连续 26 个月全部同比下降，
 * 2026-02 当月 70 城平均 −6.31%（国家统计局）；百城二手住宅均价 2026 年前 8 月累计
 * −3.76%（中指）；十大城市二手住宅 2026-07 同比 −7.26%（中指）；
 * 自 2021 年高点累计约 −22%（媒体测算与中指均价序列互证的**推算**，
 * 起点 16,000 元/㎡ 未取到中指原始发布，不可当官方数据用）。
 *
 * 注意「乐观」档只是房价跟上通胀、实际保值，已经比过去五年好很多。
 * 用户手填超过 +3% 时建议给一行提示：该假设高于过去五年实际表现约 6 个百分点/年。
 */
export const PRICE_GROWTH = {
  /** 延续过去五年趋势的减速版；三四线用这档 */
  pessimistic: rate(-0.02),
  /** 名义横盘，实际购买力缓慢缩水 */
  neutral: rate(0),
  /** 房价跟上通胀，实际零增长 */
  optimistic: rate(0.02)
} as const;

/**
 * 买入一次性成本默认 2%（总价）。
 *   契税：≤140㎡ 家庭唯一住房与第二套均 1%；>140㎡ 首套 1.5% / 二套 2%
 *        （财政部、税务总局、住建部，2024-12-01 起。分界线由 90㎡ 上移到 140㎡，
 *         意味着绝大多数普通住宅现在都适用 1%，含第二套）
 *   中介费：二手房 2%，买卖双方各承担 1%（北京链家 2023-09 起由 2.7% 下调至 2%）
 * 所以二手房买方口径 = 1% + 1% = 2%；若中介费全由买方承担则为 3%。
 * 新房口径约 1.5% = 契税 1% + 住宅专项维修资金约 0.5%（维修资金为建安造价的 5%–8%，
 * 建设部财政部 165 号令；建安造价 1,500–2,500 元/㎡ 属经验值，**未证实**，
 * 折算后 90㎡ 约 0.7–1.8 万元，占一线总价不到 0.4%，占三四线可达 1%–2%）。
 * 登记费、评估费、贷款服务费合计数百至数千元，可忽略。
 *
 * 468 万的房子 2% 约 9.4 万元，117 万的房子约 2.3 万元 —— 这笔钱在首付之外，很多人做预算会漏。
 */
export const BUY_COST = {
  /** 二手房：契税 1% + 中介费买方承担 1% */
  resale: rate(0.02),
  /** 新房：契税 1% + 维修资金约 0.5% */
  newBuild: rate(0.015),
  /** 中介费全由买方承担 */
  resaleFullAgent: rate(0.03)
} as const;

/**
 * 卖出成本默认 1%（中介费卖方承担部分；2% 全担则取 2%）。
 * 税费：满五唯一免增值税与个税；满二不满五免增值税、个税 1%。
 * FIRE 场景持有期必然远超五年，**卖出端税费通常为零**，只剩中介费。
 * （「2026 年起不满二增值税由 5.33% 降至 3%」仅见于自媒体，**未证实**，
 *  且对本模型无实质影响，不实现。）
 */
export const SELL_COST = { normal: rate(0.01), fullAgent: rate(0.02) } as const;

/**
 * 持有成本默认 0.5%/年（按总价计），作为**随通胀增长**的支出项 ——
 * 与名义固定的月供形成对比，两者不能混。
 *
 * 构成：物业费 + 维修计提。物业费实测（中指研究院 2026-06，20 城）：
 *   20 城均价 2.75 元/㎡·月；北京 4.02 / 深圳 4.00 / 上海 3.55 / 杭州 3.00 /
 *   广州 2.88 / 天津 2.79 / 宁波 2.62 / 武汉 2.62 / 成都无锡苏州青岛 2.0–2.5。
 * 90㎡ 对应一线约 320–360 元/月（年 4,000 元上下，占 468 万总价约 0.09%），
 * 二线约 200–250 元/月（年 2,500 元上下）。
 * 剩余部分是维修与更新计提 —— **这部分无实证来源，是工程经验取值，属未证实的推算**。
 * 北方另有取暖费（按面积计费，量级每年数千元），未单列。
 *
 * 房产税默认 0：目前个人自住房产在上海、重庆以外的城市不征收。2021 年全国人大授权
 * 国务院开展试点，授权期五年至 2026 年末，除沪渝原有试点外未新增任何试点城市；
 * 房地产税未列入十四届全国人大常委会《立法规划（2023—2027）》，也未列入 2025 年
 * 国务院立法工作计划。保留 propertyTax 输入项而不是假装它不存在 —— 授权期正好在
 * 2026 年末到期，这是真实存在的政策不确定性。
 */
export const HOLD_COST_RATE = rate(0.005);

// ─────────────────────────────────────────────────────────────────────────────
// 三、配置
// ─────────────────────────────────────────────────────────────────────────────

export interface HouseCfg {
  enabled: boolean;
  /** 单价，元/㎡，今日价。**一级输入**：用户直接填自己要买的那套房的单价，
   * 模块不替他猜。界面上滑块（步进 1 万）与输入框并存，低线城市的 5,000、
   * 1.3 万这类落不到刻度上的数走输入框。 */
  pricePerSqm: number;
  /** 面积，㎡。同样是一级输入。改它会按 34 元/㎡·月重算租金三项（见 applyArea） */
  areaSqm: number;
  /** 该房产的市场月租金，元，今日价。只用于算租金回报率与卖房后的默认房租，不参与买房现金流 */
  marketMonthlyRent: number;
  /** 购房年龄（取整；engine 按整数年龄迭代） */
  buyAge: number;

  payMode: PayMode;
  /** 首付比例，0.15 = 15% */
  downRatio: Rate;
  /** 贷款年限。上限 40（2026-08-28 新政），主流 30 */
  loanYears: number;
  comRate: Rate;
  hpfRate: Rate;
  /** 公积金可贷上限，元。通用默认 100 万，各城市差异极大，详见页面底部「常见问题」 */
  hpfCap: number;

  /** 一次性买入成本率（契税 + 中介 / 维修资金），见 BUY_COST */
  buyCostRate: Rate;
  /** 年持有成本率（物业 + 维修计提），按总价计，随通胀涨，见 HOLD_COST_RATE */
  holdCostRate: Rate;
  /** 房产税率，按总价近似评估值计。默认 0，理由见 HOLD_COST_RATE 注释 */
  propertyTaxRate: Rate;

  /** 当前每月住房支出（房租，或已有房贷月供），元。
   * 这是防双重计算的关键输入：用户填的「当前年支出」几乎必然已含这笔钱，
   * 买房后要把它抵扣掉。自有房无月供就填 0。
   *
   * 默认值只是个起点（34 元/㎡·月 × 默认面积），**改面积时不会跟着变** ——
   * 它描述的是你现在住的地方，不是你要买的那套。见 applyArea 的注释。 */
  currentMonthlyHousing: number;

  /** 退休后卖房 */
  sellOn: boolean;
  sellAge: number;
  /** 房价年名义增长率。默认 0，见 PRICE_GROWTH */
  priceGrowth: Rate;
  sellCostRate: Rate;
  /** 卖房后的月租金，元，今日价。默认取 marketMonthlyRent。
   * 漏掉这笔会让「退休后卖房」变成无成本的免费变现 */
  postSaleMonthlyRent: number;
}

/** 默认关闭，不影响现有默认结果。
 *
 * 默认 2 万/㎡ × 100㎡ = 200 万。这个组合是**中性起点**不是推荐值：
 * 它既不代表哪个城市，也不试图代表「全国平均」—— 它的作用是给用户一个
 * 好对账的量级，让他一眼看出要往上还是往下改。
 * 租金三项一律 34 元/㎡·月 × 100㎡ = 3,400 元（见 RENT_PER_SQM）。
 * 公积金上限 100 万是通用默认，各城市差异极大，详见页面底部「常见问题」。 */
export const DEFAULT_HOUSE: HouseCfg = {
  enabled: false,
  pricePerSqm: DEFAULT_PRICE_PER_SQM,
  areaSqm: DEFAULT_AREA_SQM,
  marketMonthlyRent: rentFor(DEFAULT_AREA_SQM),
  buyAge: 32,
  payMode: 'combo',
  downRatio: rate(0.30),   // 下限 15% 但多数人拿不出那么低的杠杆意愿，30% 是常见实际选择
  loanYears: POLICY.defaultLoanYears,
  comRate: POLICY.comRate,
  hpfRate: POLICY.hpfRate,
  hpfCap: DEFAULT_HPF_CAP,
  buyCostRate: BUY_COST.resale,
  holdCostRate: HOLD_COST_RATE,
  propertyTaxRate: rate(0),
  currentMonthlyHousing: rentFor(DEFAULT_AREA_SQM),
  sellOn: false,
  sellAge: 70,
  priceGrowth: PRICE_GROWTH.neutral,
  sellCostRate: SELL_COST.normal,
  postSaleMonthlyRent: rentFor(DEFAULT_AREA_SQM)
};

/** 总价是**派生量**：单价 × 面积。没有独立的 totalPrice 字段 ——
 * 有了它就会出现「单价 × 面积 ≠ 总价」的不自洽状态，而三个数里必然有一个是错的。 */
export function totalPrice(cfg: Pick<HouseCfg, 'pricePerSqm' | 'areaSqm'>): number {
  return cfg.pricePerSqm * cfg.areaSqm;
}

/**
 * 改面积：租金三项跟着按 34 元/㎡·月 重算，但**用户手改过的不覆盖**。
 *
 * 「改过没有」不额外存一个标志位，而是直接看当前值等不等于旧面积的换算值：
 * 相等就说明它还是模块自己填的，可以更新；不等就是用户填的，不动。
 * 这样做的好处是没有状态要维护（老存档、导入的 JSON 都天然正确），
 * 唯一的边界情形是用户手填的数恰好等于换算值 —— 那时覆盖与否结果一样，无所谓。
 */
export function applyArea(cfg: HouseCfg, areaSqm: number): HouseCfg {
  const was = rentFor(cfg.areaSqm);
  const now = rentFor(areaSqm);
  const upd = (v: number): number => (v === was ? now : v);
  return {
    ...cfg,
    areaSqm,
    // 这两项是**这套房子**的属性，跟着面积走是对的
    marketMonthlyRent: upd(cfg.marketMonthlyRent),
    postSaleMonthlyRent: upd(cfg.postSaleMonthlyRent)
    // currentMonthlyHousing 故意不跟着走 —— 它是「你现在每月付多少」，
    // 是用户当下生活的属性，与他打算买多大的房子没有任何关系。
    // 绑在一起会造出一个假象：把目标面积调大 → 抵扣项跟着变大 →
    // 「买 120㎡ 比不买房还早退休」。那不是模型结论，是耦合出来的。
  };
}

/** 老存档 / 老导出 JSON 里的购房配置。三个字段在 2026-09 随城市档位一起删掉了。 */
export type LegacyHouseCfg = Partial<HouseCfg> &
  { city?: unknown; location?: unknown; totalPrice?: unknown };

/**
 * 老存档的字段迁移。
 *
 * `city` 与 `location` 直接丢弃：它们承载的是「选了哪一档」，而档位这个概念本身没了。
 *
 * `totalPrice` 反过来 —— **换算而不是丢弃**。它是用户自己认可过的一个数：
 * 可能是档位默认值，也可能是他照着链家改出来的。用它和老的面积反解出单价，
 * 老用户刷新后总价一分不差。老存档里没有 areaSqm 字段（面积当年长在城市档位上），
 * 所以按老档位取：一线核心 85㎡，其余 90㎡。
 *
 * 与 main.ts 里 medInflation → medPremium 的处理方向相反，那次是丢弃：
 * 老的 6% 医疗通胀本身就是个用错口径的错值，反解只会把错误换个形式保留下来。
 * 老的 totalPrice 没有这个毛病，它只是换了一种表达方式。
 */
export function migrateCfg(saved: LegacyHouseCfg): HouseCfg {
  const cfg = { ...DEFAULT_HOUSE, ...saved } as HouseCfg & LegacyHouseCfg;
  const old = saved.totalPrice;
  // 已经是新格式（带 pricePerSqm）就不动；反解不出来就回到新默认
  if (typeof old === 'number' && old > 0 && saved.pricePerSqm === undefined) {
    const area = typeof saved.areaSqm === 'number' && saved.areaSqm > 0
      ? saved.areaSqm
      : saved.city === 't1core' ? 85 : 90;
    cfg.areaSqm = area;
    // 不取整：取整会让老总价漂几十块。界面显示单价时再四舍五入，存的是精确值
    cfg.pricePerSqm = old / area;
  }
  // 删掉已经不存在的字段，免得它们跟着导出的 JSON 一直传播下去
  delete cfg.city;
  delete cfg.location;
  delete cfg.totalPrice;
  return cfg;
}

/** 外部参数。刻意不依赖 FireInput 的字段名，避免主输入改名把这里带崩。 */
export interface HouseCtx {
  currentAge: Age;
  deathAge: Age;
  /** 基础 CPI。用于：一次性事件的名义 ↔ 今日购买力折算、持有成本增长、实际利率 */
  cpi: Rate;
  /** 年支出增长轨道（主模型的 personalInflation）。
   * 抵扣项必须与它同轨 —— 被抵扣的那笔房租就长在这条轨道上，用别的率扣不干净 */
  spendInflation: Rate;
}

// ─────────────────────────────────────────────────────────────────────────────
// 四、等额本息
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 等额本息月供。i = r/12，n = Y×12：
 *
 *   M = P × i × (1+i)^n / [(1+i)^n − 1]
 *
 * 校验：P = 200 万、r = 3.05%、Y = 30 → M = 8,486.11 元；Y = 40 → M = 7,217.44 元。
 * 这两个数与 8·28 新政后央视、新浪的测算一致。
 *
 * 只实现等额本息：它是中国市场绝对主流，且「名义固定」这一性质正是本模块的关键洞察。
 * 等额本金月供逐月递减（首月 P/n + P×i），总利息更低，但会让早期年份现金流压力显著偏高，
 * 且会削弱「通胀帮你还房贷」这个效应的可见度。
 */
export function monthlyPayment(principal: number, annualRate: number, years: number): number {
  if (principal <= 0 || years <= 0) return 0;
  const n = years * 12;
  const i = annualRate / 12;
  if (Math.abs(i) < 1e-12) return principal / n;   // 零利率退化成等额本金
  const f = Math.pow(1 + i, n);
  return principal * i * f / (f - 1);
}

/**
 * 已还 monthsPaid 期后的剩余本金：
 *
 *   B_t = P × [(1+i)^n − (1+i)^t] / [(1+i)^n − 1]
 *
 * 卖房场景必须有 —— 卖房净得要从毛收入里扣掉它。
 */
export function remainingPrincipal(
  principal: number, annualRate: number, years: number, monthsPaid: number
): number {
  if (principal <= 0 || years <= 0) return 0;
  const n = years * 12;
  const t = Math.min(Math.max(monthsPaid, 0), n);
  const i = annualRate / 12;
  if (Math.abs(i) < 1e-12) return principal * (1 - t / n);
  const f = Math.pow(1 + i, n);
  return principal * (f - Math.pow(1 + i, t)) / (f - 1);
}

/** 还款期内付出的名义总利息 = M × n − P。 */
export function totalInterest(principal: number, annualRate: number, years: number): number {
  if (principal <= 0 || years <= 0) return 0;
  return monthlyPayment(principal, annualRate, years) * years * 12 - principal;
}

// ─────────────────────────────────────────────────────────────────────────────
// 五、测算
// ─────────────────────────────────────────────────────────────────────────────

export interface HouseResult {
  /** 购房当年的名义总价 = totalPrice × (1+priceGrowth)^(buyAge−currentAge) */
  priceAtBuy: number;
  comPrincipal: number;
  hpfPrincipal: number;
  /** 实际首付现金。注意纯公积金档位下额度不足的缺口只能加首付补齐，会高于 downRatio × 总价 */
  downPayment: number;
  /** 公积金额度不足、被迫转成现金的缺口。> 0 时界面要提示 */
  hpfShortfall: number;
  /** 一次性买入税费（契税 + 中介 / 维修资金） */
  buyCost: number;

  monthlyCom: number;
  monthlyHpf: number;
  /** 月供合计，名义固定 */
  monthlyTotal: number;
  /** 名义总利息 */
  interestTotal: number;

  /** 年持有成本（物业 + 维修计提 + 房产税），今日购买力，随通胀涨 */
  annualHoldCost: number;
  /** 买房后每月住房净增支出 = 月供 + 持有成本/12 − 当前月住房支出。
   * 注意这只是购房首年的口径：月供名义固定而后两项随通胀涨，之后年份的差额会变化 */
  netMonthlyDelta: number;

  // ── 供界面并排展示的三个数（报告 3.3 节），只摆数字不给「该买/该租」的结论 ──
  /** 租金回报率 = 市场月租 × 12 / 总价 */
  rentYield: number;
  /** 贷款名义利率（按本金加权；全款为 0） */
  loanRate: number;
  /** 扣通胀后的实际利率 = (1+r)/(1+π) − 1 */
  realLoanRate: number;
  /** 年现金流缺口 = (贷款利率 − 租金回报率) × 总价。
   * 一线约 1.2pp × 468 万 ≈ 5.6 万/年，要靠房价上涨或居住价值来补 */
  cashGap: number;

  // ── 「通胀帮你还房贷」（报告 4.1 节），很多人对此没有直觉 ──
  /** 最后一年那笔月供折成今日购买力。8,486 元在 2% 通胀下第 30 年只相当于今天的 4,686 元 */
  lastPaymentToday: number;
  /** 实际负担 / 名义负担 = 年金现值系数 ÷ 年限。2% 通胀 30 年 = 74.7% */
  realBurdenRatio: number;
  /** 通胀「吃掉」的比例 = 1 − realBurdenRatio。1%/2%/3% 通胀分别约 14.0% / 25.3% / 34.7% */
  inflationEatenRatio: number;

  // ── 卖房 ──
  /** 卖出年的名义毛价 */
  sellGross: number;
  /** 卖出时的剩余贷款本金 */
  sellDebt: number;
  /** 卖房净现金 = 总价 × (1+g)^t × (1 − 卖出成本率) − 剩余贷款本金（卖出年名义值） */
  sellNet: number;
}

const clampAge = (a: number) => Math.round(a);

export function project(cfg: HouseCfg, ctx: HouseCtx): HouseResult {
  const cur = ctx.currentAge as number;
  const buyAge = clampAge(cfg.buyAge);
  const g = cfg.priceGrowth as number;
  const pi = ctx.cpi as number;

  // 总价是派生量，算一次拿在手上 —— 下面五处（买入名义价、持有成本、租金回报率、
  // 现金流缺口、卖出毛价）都用今日总价当基数
  const total = totalPrice(cfg);

  const tBuy = Math.max(0, buyAge - cur);
  const priceAtBuy = total * Math.pow(1 + g, tBuy);

  // 贷款拆分。组合贷是常态：公积金按额度封顶，超出部分走商贷，两笔分别算月供再相加。
  const loanWanted = cfg.payMode === 'cash'
    ? 0
    : priceAtBuy * (1 - (cfg.downRatio as number));

  let comPrincipal = 0, hpfPrincipal = 0, hpfShortfall = 0;
  if (cfg.payMode === 'commercial') {
    comPrincipal = loanWanted;
  } else if (cfg.payMode === 'hpf') {
    hpfPrincipal = Math.min(loanWanted, cfg.hpfCap);
    // 纯公积金档位下额度不足的缺口没有别的来源，只能自己掏 —— 落到首付里
    hpfShortfall = loanWanted - hpfPrincipal;
  } else if (cfg.payMode === 'combo') {
    hpfPrincipal = Math.min(loanWanted, cfg.hpfCap);
    comPrincipal = loanWanted - hpfPrincipal;
  }

  // 首付 = 总价 − 实际贷到的钱。这样纯公积金额度不足时自动体现为首付变高
  const downPayment = priceAtBuy - comPrincipal - hpfPrincipal;
  const buyCost = priceAtBuy * (cfg.buyCostRate as number);

  const monthlyCom = monthlyPayment(comPrincipal, cfg.comRate as number, cfg.loanYears);
  const monthlyHpf = monthlyPayment(hpfPrincipal, cfg.hpfRate as number, cfg.loanYears);
  const monthlyTotal = monthlyCom + monthlyHpf;
  const interestTotal =
    totalInterest(comPrincipal, cfg.comRate as number, cfg.loanYears) +
    totalInterest(hpfPrincipal, cfg.hpfRate as number, cfg.loanYears);

  // 持有成本按今日总价计（不按买入年名义价），因为它作为「今日购买力」金额进事件，
  // 由 engine 再乘通胀。用名义价会把房价增长重复算一次。
  const annualHoldCost =
    total * ((cfg.holdCostRate as number) + (cfg.propertyTaxRate as number));

  const netMonthlyDelta = monthlyTotal + annualHoldCost / 12 - cfg.currentMonthlyHousing;

  // 三个并排展示的数
  const rentYield = total > 0 ? cfg.marketMonthlyRent * 12 / total : 0;
  const loanTotal = comPrincipal + hpfPrincipal;
  const loanRate = loanTotal > 0
    ? ((cfg.comRate as number) * comPrincipal + (cfg.hpfRate as number) * hpfPrincipal) / loanTotal
    : 0;
  const realLoanRate = (1 + loanRate) / (1 + pi) - 1;
  const cashGap = (loanRate - rentYield) * total;

  // 通胀效应。年金现值系数 (1 − (1+π)^−Y) / π，除以 Y 得「实际负担 / 名义负担」
  const Y = cfg.loanYears;
  const annuityFactor = Math.abs(pi) < 1e-12 ? Y : (1 - Math.pow(1 + pi, -Y)) / pi;
  const realBurdenRatio = Y > 0 ? annuityFactor / Y : 1;
  const lastPaymentToday = monthlyTotal / Math.pow(1 + pi, Y);

  // 卖房
  const sellAge = clampAge(cfg.sellAge);
  const tSell = Math.max(0, sellAge - cur);
  const monthsPaid = Math.max(0, (sellAge - buyAge) * 12);
  const sellGross = cfg.sellOn ? total * Math.pow(1 + g, tSell) : 0;
  const sellDebt = cfg.sellOn
    ? remainingPrincipal(comPrincipal, cfg.comRate as number, cfg.loanYears, monthsPaid) +
      remainingPrincipal(hpfPrincipal, cfg.hpfRate as number, cfg.loanYears, monthsPaid)
    : 0;
  const sellNet = cfg.sellOn
    ? sellGross * (1 - (cfg.sellCostRate as number)) - sellDebt
    : 0;

  return {
    priceAtBuy, comPrincipal, hpfPrincipal, downPayment, hpfShortfall, buyCost,
    monthlyCom, monthlyHpf, monthlyTotal, interestTotal,
    annualHoldCost, netMonthlyDelta,
    rentYield, loanRate, realLoanRate, cashGap,
    lastPaymentToday, realBurdenRatio, inflationEatenRatio: 1 - realBurdenRatio,
    sellGross, sellDebt, sellNet
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 六、转成引擎事件
// ─────────────────────────────────────────────────────────────────────────────

/** 一次性事件。engine 口径是 amount × (1+growth)^t，
 * 所以把「发生年份的名义值」折回 t=0 的等价额，growth 用 cpi 把它顶回去 ——
 * 与 pension.ts 的 toEvent 是同一个手法，好处是 amount 始终是诚实的今日购买力。 */
function oneShot(
  name: string, nominalAtAge: number, atAge: number, ctx: HouseCtx
): CashEvent {
  const t = Math.max(0, atAge - (ctx.currentAge as number));
  return {
    name,
    amount: real(nominalAtAge / Math.pow(1 + (ctx.cpi as number), t)),
    startAge: age(atAge),
    endAge: age(atAge + 1),
    growth: ctx.cpi,
    enabled: Math.abs(nominalAtAge) > 0.5
  };
}

/**
 * 生成注入 engine 的现金流事件。
 *
 * 事件清单与各自的口径：
 *
 *   购房首付           一次性负流，资产转移不是支出 —— 走事件正好只砍资产端本金
 *   购房税费           一次性负流，这才是真正的一次性支出
 *   房贷月供（商贷）    growth = 0，名义固定。**本模块最关键的一条**
 *   房贷月供（公积金）  同上
 *   房屋持有成本        随 cpi 涨（物业费是服务价格），与名义固定的月供性质相反
 *   抵扣原住房支出      正流，随 spendInflation 涨。把 annualSpend 里内嵌的那笔房租扣掉
 *   卖房净得           一次性正流
 *   卖房后房租          负流，随 spendInflation 涨
 *
 * 抵扣的做法：「抵扣原住房支出」一路开到寿终，把 annualSpend 里内嵌的住房那一块
 * 从买房当年起彻底移除；卖房后再用「卖房后房租」单独加回一笔明确的租金。
 * 这样三个阶段都对：买房前付原房租，持有期付月供 + 持有成本，卖出后付新房租。
 * 若卖房后房租正好等于原住房支出，两笔互相抵消，净效果为零 —— 符合直觉。
 *
 * 未启用时返回空数组，对现有默认结果零影响。
 */
export function houseEvents(cfg: HouseCfg, ctx: HouseCtx): CashEvent[] {
  if (!cfg.enabled) return [];

  const r = project(cfg, ctx);
  const cur = ctx.currentAge as number;
  const end = (ctx.deathAge as number) + 1;
  const buyAge = clampAge(cfg.buyAge);
  const sellAge = clampAge(cfg.sellAge);
  const sells = cfg.sellOn && sellAge > buyAge && sellAge < end;

  // 持有期终点：卖了就到卖出年为止，没卖就一直到寿终
  const ownEnd = sells ? sellAge : end;
  // 还贷终点：贷款正常到期与卖房提前结清取先到的那个
  const loanEnd = Math.min(buyAge + cfg.loanYears, ownEnd);

  const out: CashEvent[] = [];

  out.push(oneShot('购房首付', -r.downPayment, buyAge, ctx));
  out.push(oneShot('购房税费（契税+中介）', -r.buyCost, buyAge, ctx));

  // 月供：growth 必须是 0。等额本息在还款期内名义金额一分不变，
  // 当成随通胀增长的实际支出会高估后期负担 25%–35%（2%–3% 通胀）。
  // amount 这里放的就是名义年供 —— growth=0 时 engine 原样输出，两个口径重合。
  if (r.monthlyCom > 0 && loanEnd > buyAge) {
    out.push({
      name: '房贷月供（商贷）',
      amount: real(-r.monthlyCom * 12),
      startAge: age(buyAge),
      endAge: age(loanEnd),
      growth: rate(0),
      enabled: true
    });
  }
  if (r.monthlyHpf > 0 && loanEnd > buyAge) {
    out.push({
      name: '房贷月供（公积金）',
      amount: real(-r.monthlyHpf * 12),
      startAge: age(buyAge),
      endAge: age(loanEnd),
      growth: rate(0),
      enabled: true
    });
  }

  // 持有成本：随通胀涨。和上面的名义固定月供并排放着，正好把两者的性质差异摆给用户看
  if (r.annualHoldCost > 0 && ownEnd > buyAge) {
    out.push({
      name: '房屋持有成本（物业+维修）',
      amount: real(-r.annualHoldCost),
      startAge: age(buyAge),
      endAge: age(ownEnd),
      growth: ctx.cpi,
      enabled: true
    });
  }

  // 防双重计算：把 annualSpend 里内嵌的住房支出从买房当年起扣掉。
  // growth 必须用 spendInflation —— 那笔钱就长在这条轨道上，用 cpi 扣会有残差。
  if (cfg.currentMonthlyHousing > 0 && end > buyAge) {
    out.push({
      name: '抵扣原住房支出（房租/已有月供）',
      amount: real(cfg.currentMonthlyHousing * 12),
      startAge: age(buyAge),
      endAge: age(end),
      growth: ctx.spendInflation,
      enabled: true
    });
  }

  if (sells) {
    out.push(oneShot('卖房净得', r.sellNet, sellAge, ctx));
    // 卖房后重新开始付房租。漏掉它，「退休后卖房」会变成无成本的免费变现
    if (cfg.postSaleMonthlyRent > 0) {
      out.push({
        name: '卖房后房租',
        amount: real(-cfg.postSaleMonthlyRent * 12),
        startAge: age(sellAge),
        endAge: age(end),
        growth: ctx.spendInflation,
        enabled: true
      });
    }
  }

  return out.filter(e => e.enabled && e.endAge > e.startAge && e.endAge > cur);
}
