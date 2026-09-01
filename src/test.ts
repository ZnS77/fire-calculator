import * as E from './engine';
import * as P from './pension';
import { age, rate, real, FireInput } from './types';

// 只声明用到的部分，避免为一个 exit 引入整个 @types/node
declare const process: { exit(code: number): never };

const fails: string[] = [];
let count = 0;
function ok(name: string, cond: boolean, detail?: string): void {
  count++;
  if (cond) console.log('  ✓ ' + name);
  else { console.log('  ✗ ' + name + '  ' + (detail ?? '')); fails.push(name); }
}
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

function flat(over: Partial<FireInput> = {}): Partial<FireInput> {
  return {
    currentAge: age(30), deathAge: age(90), assets: real(0),
    annualIncome: real(300000), incomeGrowth: rate(0), capIncomeGrowthAt: null,
    annualSpend: real(120000), cpi: rate(0), personalInflation: rate(0),
    medInflation: rate(0), rWork: rate(0), rRetire: rate(0), reserve: real(0),
    smileOn: false, events: [], incomeCeiling: null, incomeCeilingInflates: true,
    retireSpendRatio: rate(1),
    incomeModel: { kind: 'simple' as const }, realWageGrowth: rate(0), ...over
  };
}

console.log('\n[1] 引擎不变式');
{
  // t=0 那年支出恰好等于 annualSpend（不预先乘通胀）
  const s = E.simulate({ currentAge: age(30), deathAge: age(40),
    annualSpend: real(120000), personalInflation: rate(0.05), smileOn: false }, 35);
  ok('t=0 支出不预乘通胀', near(s.rows[0]!.spend, 120000, 1e-6), 'got ' + s.rows[0]!.spend);

  // 分段边界左闭右开
  const ph = [{ startOffset: 0, drift: rate(-0.01) }, { startOffset: 10, drift: rate(-0.02) }];
  ok('age === 段起点归属新段', E.driftFor(50, 40, ph, true) === -0.02);
  ok('段起点前一年仍属旧段', E.driftFor(49, 40, ph, true) === -0.01);
  ok('退休前 drift 恒为 0', E.driftFor(35, 40, ph, true) === 0);
  ok('关闭微笑曲线时 drift 恒为 0', E.driftFor(50, 40, ph, false) === 0);

  // 零收益时年中约定退化为直接相加
  const s3 = E.simulate(flat({ deathAge: age(32) }), 33);
  ok('零收益零通胀 → 净现金流直接相加',
    near(s3.endNominal, 3 * (300000 - 120000), 1e-6), 'got ' + s3.endNominal);

  // 实际收益率用除法而非减法
  ok('实际收益率用除法', near(E.realRate(rate(0.07), rate(0.025)), 0.0439024390, 1e-9));

  // 预留金按医疗通胀而非 CPI
  const s7 = E.simulate({ currentAge: age(30), deathAge: age(40),
    reserve: real(100000), medInflation: rate(0.06), cpi: rate(0.02) }, 35);
  ok('预留金按医疗通胀滚动',
    near(s7.targetNominal, 100000 * Math.pow(1.06, 11), 1e-6), 'got ' + s7.targetNominal);

  // 预留金的今日购买力口径：医疗通胀高于 CPI 时必须大于面值
  const s8 = E.simulate({ currentAge: age(30), deathAge: age(90), reserve: real(500000),
    medInflation: rate(0.06), cpi: rate(0.022) }, 50);
  const ratio = Math.pow(1.06 / 1.022, 61);
  ok('预留金今日购买力 = 面值 × (1+医疗)/(1+CPI) 的 n 次方',
     near(s8.targetReal, 500000 * ratio, 1),
     `got ${Math.round(s8.targetReal)} want ${Math.round(500000 * ratio)}`);
  ok('医疗通胀 > CPI 时今日购买力口径远大于面值',
     s8.targetReal > 500000 * 5, 'got ' + Math.round(s8.targetReal));
  // 医疗通胀 == CPI 时两者应相等
  const s9 = E.simulate({ currentAge: age(30), deathAge: age(90), reserve: real(500000),
    medInflation: rate(0.022), cpi: rate(0.022) }, 50);
  ok('医疗通胀 = CPI 时今日购买力口径回落到面值',
     near(s9.targetReal, 500000, 1e-6), 'got ' + s9.targetReal);

  // SWR 对照线随退休年数变化
  ok('SWR 30 年期 = 3.5%', E.swrBenchmark(30) === 0.035);
  ok('SWR 50 年期 = 3.0%', E.swrBenchmark(50) === 0.030);
  ok('SWR 40 年期居中', E.swrBenchmark(40) > 0.030 && E.swrBenchmark(40) < 0.035);
}

console.log('\n[2] 引擎手工对账：零通胀零收益');
{
  const r = E.solve(flat());
  // 61 个年度(30..90)。工作 W 年每年净存 18 万，退休 61−W 年每年花 12 万
  ok('FIRE 年龄 = 55', r.fireAge === 55, 'got ' + r.fireAge);
  ok('手算：工作 25 年存 450 万 ≥ 退休 36 年花 432 万', 180000 * 25 >= 120000 * 36);
  ok('手算：工作 24 年存 432 万 < 花 444 万', !(180000 * 24 >= 120000 * 37));
  ok('期末余额 = 18 万', near(r.sim.endNominal, 180000, 1e-6), 'got ' + r.sim.endNominal);
  ok('reason = ok', r.reason === 'ok');
  ok('已够钱 → already', E.solve(flat({ assets: real(1e8) })).reason === 'already');
  ok('花销远超一切 → never', E.solve(flat({ annualSpend: real(5e6) })).reason === 'never');

  // never 情形必须按「全程工作」算缺口。退休判定是 age >= retireAge，
  // 取 deathAge 会让最后一年仍算退休年，少算一年工资、缺口偏悲观。
  {
    const neverInp = flat({ annualSpend: real(5e6) });
    const r = E.solve(neverInp);
    ok('never 的模拟全程都有工资', r.sim.rows.every(row => row.income > 0),
       '首年 ' + r.sim.rows[0]!.income + ' 末年 ' + r.sim.rows[r.sim.rows.length - 1]!.income);
    const atDeath = E.simulate(neverInp, 90);      // 旧的（错误）口径
    ok('全程工作口径的缺口小于旧口径（少算一年工资会更悲观）',
       r.sim.endNominal > atDeath.endNominal,
       `${Math.round(r.sim.endNominal)} vs ${Math.round(atDeath.endNominal)}`);
    // 两次模拟的支出完全相同（微笑曲线关闭），差别只在最后一年有没有工资
    ok('两者恰好差最后一年的工资',
       near(r.sim.endNominal - atDeath.endNominal, 300000, 1e-6),
       'diff=' + (r.sim.endNominal - atDeath.endNominal));
  }
}

console.log('\n[3] 养老金：法定规则');
{
  ok('计发月数 60岁=139', P.monthsFor(60) === 139);
  ok('计发月数 63岁=117', P.monthsFor(63) === 117);
  ok('计发月数 55岁=170', P.monthsFor(55) === 170);
  ok('计发月数 50岁=195', P.monthsFor(50) === 195);

  ok('男 1964-12 及以前 = 60', P.statutoryRetireAge(1964, 12, 'male') === 60);
  ok('男 1976-09 后封顶 63', P.statutoryRetireAge(1985, 3, 'male') === 63);
  ok('女干部封顶 58', P.statutoryRetireAge(1990, 1, 'female55') === 58);
  ok('女工人封顶 55', P.statutoryRetireAge(1990, 1, 'female50') === 55);

  ok('最低年限 2029 = 15 年', P.minContributionYears(2029) === 15);
  ok('最低年限 2030 = 15.5 年', P.minContributionYears(2030) === 15.5);
  ok('最低年限 2035 = 18 年', P.minContributionYears(2035) === 18);
  ok('最低年限 2039+ = 20 年',
     P.minContributionYears(2039) === 20 && P.minContributionYears(2050) === 20);

  const sa = 12434;
  ok('基数最低档 = 社平 60%', near(P.contribBase('min', 99999, sa), sa * 0.6, 1e-9));
  ok('基数顶格 = 社平 300%', near(P.contribBase('max', 1, sa), sa * 3, 1e-9));
  ok('随收入低于下限则钳住', near(P.contribBase('income', 1000, sa), sa * 0.6, 1e-9));
  ok('随收入高于上限则钳住', near(P.contribBase('income', 999999, sa), sa * 3, 1e-9));
  ok('随收入在区间内取实际', near(P.contribBase('income', 20000, sa), 20000, 1e-9));

  ok('记账利率 = 社平 − 1.5pp', near(P.defaultAccountRate(0.04), 0.025, 1e-9));
  ok('社平 6% → 记账 4.5%', near(P.defaultAccountRate(0.06), 0.045, 1e-9));
  ok('社平极低时记账利率不为负', P.defaultAccountRate(0.005) === 0);
  ok('COLA 三档 1/2/3%',
     P.COLA.conservative === 0.01 && P.COLA.neutral === 0.02 && P.COLA.optimistic === 0.03);
}

console.log('\n[4] 养老金：严格复现调研算例（缴20年·指数1.0·63岁 → 替代率 36.4%）');
{
  // 口径与调研算例一致：社平年增 4% 与记账利率 4% 相互抵消
  const r = P.project({
    currentAge: age(43), joinAge: 23, stopAge: 43, claimAge: 63, keepPaying: false,
    socialAvg: 12434, socialGrowth: rate(0.04), monthlyIncome: 12434,
    incomeGrowth: rate(0.04), accountRate: rate(0.04), baseMode: 'income',
    priorIndex: 1.0, currentYear: 2026
  });
  ok('缴费年限 = 20', r.years === 20, 'got ' + r.years);
  ok('平均缴费指数 = 1.0', near(r.avgIndex, 1.0, 1e-9), 'got ' + r.avgIndex);
  ok('基础养老金 = 20% × 计发基数',
     near(r.basic / r.payBase, 0.20, 1e-6), 'got ' + ((r.basic / r.payBase) * 100).toFixed(3) + '%');
  ok('个人账户养老金 = 16.41% × 计发基数',
     near(r.accountPension / r.payBase, 0.96 * 20 / 117, 1e-4),
     'got ' + ((r.accountPension / r.payBase) * 100).toFixed(3) + '%');
  ok('合计替代率 = 36.4%',
     near(r.monthly / r.payBase, 0.364, 0.0015),
     'got ' + ((r.monthly / r.payBase) * 100).toFixed(2) + '%');
}

console.log('\n[5] 养老金：断缴 / 续缴 / 事件转换');
{
  const base = {
    currentAge: age(30), joinAge: 22, stopAge: 45, claimAge: 63,
    socialAvg: 12434, socialGrowth: rate(0.04), monthlyIncome: 25000,
    incomeGrowth: rate(0.04), baseMode: 'income' as const, currentYear: 2026
  };
  const stop = P.project({ ...base, keepPaying: false });
  const keep = P.project({ ...base, keepPaying: true });
  ok('断缴 45 岁 → 年限 23 年（22→45）', stop.years === 23, 'got ' + stop.years);
  ok('续缴到 63 岁 → 年限 41 年', keep.years === 41, 'got ' + keep.years);
  ok('续缴年限 > 断缴年限', keep.years > stop.years);
  ok('续缴月养老金 > 断缴', keep.monthly > stop.monthly);
  ok('2059 年退休 → 要求 20 年', stop.requiredYears === 20);
  ok('断缴 23 年仍达标', stop.qualified);
  ok('续缴才有自缴成本', keep.selfPayAnnualFirst > 0 && stop.selfPayAnnualFirst === 0);

  const early = P.project({ ...base, stopAge: 35, keepPaying: false });
  ok('35 岁停缴 → 13 年 < 20，不达标', !early.qualified && early.years === 13);
  ok('不达标时给出差额 7 年', early.shortfallYears === 7);

  const ev = P.toEvent(stop, { currentAge: age(30), deathAge: age(95), colaRate: rate(0.02) });
  ok('事件自 claimAge 起生效', ev.startAge === 63);
  ok('事件持续到死亡年（右开）', ev.endAge === 96);
  ok('事件按 COLA 增长', near(ev.growth, 0.02, 1e-12));
  ok('折现/还原自洽', near(ev.amount * Math.pow(1.02, 33), stop.annual, 1e-6));
  ok('不达标时事件默认关闭',
     P.toEvent(early, { currentAge: age(30), deathAge: age(95) }).enabled === false);
}

console.log('\n[6] 退休后支出系数');
{
  const base = {
    currentAge: age(30), deathAge: age(60), assets: real(0),
    annualIncome: real(300000), incomeGrowth: rate(0), capIncomeGrowthAt: null,
    incomeCeiling: null, annualSpend: real(120000), cpi: rate(0),
    personalInflation: rate(0), medInflation: rate(0), rWork: rate(0), rRetire: rate(0),
    reserve: real(0), smileOn: false, events: []
  };
  const full = E.simulate({ ...base, retireSpendRatio: rate(1.0) }, 45);
  const lean = E.simulate({ ...base, retireSpendRatio: rate(0.7) }, 45);

  ok('退休前不受系数影响', near(full.rows[10]!.spend, lean.rows[10]!.spend, 1e-9),
     `${full.rows[10]!.spend} vs ${lean.rows[10]!.spend}`);
  ok('退休当年即生效', near(lean.rows[15]!.spend, 120000 * 0.7, 1e-6),
     'got ' + lean.rows[15]!.spend);
  ok('系数 1.0 等价于不加系数', near(full.rows[15]!.spend, 120000, 1e-6));
  ok('系数降低支出 → 终值更高', lean.endNominal > full.endNominal);

  // 与微笑曲线可叠加且口径不重叠：水平位移 × 逐年漂移
  const both = E.simulate({ ...base, retireSpendRatio: rate(0.7), smileOn: true,
    phases: [{ startOffset: 0, drift: rate(-0.01) }] }, 45);
  ok('退休首年只受系数影响，漂移尚未累积',
     near(both.rows[15]!.spend, 120000 * 0.7, 1e-6), 'got ' + both.rows[15]!.spend);
  ok('第二年 = 系数 × (1+drift)',
     near(both.rows[16]!.spend, 120000 * 0.7 * 0.99, 1e-6), 'got ' + both.rows[16]!.spend);

  // 系数作用在今日购买力上，之后再乘通胀 —— 不能双重计算
  const infl = E.simulate({ ...base, retireSpendRatio: rate(0.7),
    personalInflation: rate(0.03) }, 45);
  ok('系数与通胀相乘而非重复作用',
     near(infl.rows[15]!.spend, 120000 * 0.7 * Math.pow(1.03, 15), 1e-6),
     'got ' + Math.round(infl.rows[15]!.spend));
}

console.log('\n[7] 收入生命周期曲线');
{
  const c = { entryAge: 22, peakAge: 45, peakMult: 2.5,
              declineRate: rate(0.01), floorRatio: null };
  ok('f(入职) = 1', near(E.incomeCurveAt(c, 22), 1, 1e-12));
  ok('f(峰值) = 峰值倍数', near(E.incomeCurveAt(c, 45), 2.5, 1e-12));
  ok('入职前恒为 1', E.incomeCurveAt(c, 18) === 1);
  ok('峰值前单调上升', (() => {
    for (let a = 22; a < 45; a++) if (E.incomeCurveAt(c, a + 1) <= E.incomeCurveAt(c, a)) return false;
    return true; })());
  ok('峰值前是凹的（早期涨得快）',
     E.incomeCurveAt(c, 30) - E.incomeCurveAt(c, 29) >
     E.incomeCurveAt(c, 44) - E.incomeCurveAt(c, 43));
  ok('峰值后按固定比率衰减',
     near(E.incomeCurveAt(c, 55), 2.5 * Math.pow(0.99, 10), 1e-12));
  ok('曲线在峰值处连续',
     near(E.incomeCurveAt(c, 45), E.incomeCurveAt(c, 45.0001), 1e-3));

  // 地板
  const cf = { ...c, peakAge: 38, peakMult: 3.5, declineRate: rate(0.03), floorRatio: 0.6 };
  ok('衰减不跌破地板', E.incomeCurveAt(cf, 90) >= 3.5 * 0.6 - 1e-9,
     'got ' + E.incomeCurveAt(cf, 90).toFixed(3));
  ok('地板前仍正常衰减',
     near(E.incomeCurveAt(cf, 40), 3.5 * Math.pow(0.97, 2), 1e-12));

  // 五个预设都自洽
  for (const p of E.INCOME_PRESETS) {
    ok(`预设「${p.name}」f(入职)=1 且 f(峰值)=M`,
       near(E.incomeCurveAt(p.curve, p.curve.entryAge), 1, 1e-12) &&
       near(E.incomeCurveAt(p.curve, p.curve.peakAge), p.curve.peakMult, 1e-12));
  }

  // 归一化：用户填的是「当前年收入」，不是起薪
  const inp = {
    currentAge: age(30), deathAge: age(60), assets: real(0),
    annualIncome: real(300000), annualSpend: real(0), cpi: rate(0),
    personalInflation: rate(0), medInflation: rate(0), rWork: rate(0), rRetire: rate(0),
    reserve: real(0), smileOn: false, events: [], retireSpendRatio: rate(1),
    realWageGrowth: rate(0),
    incomeModel: { kind: 'curve' as const, preset: 'standard', curve: c }
  };
  const sim = E.simulate(inp, 60);
  ok('当前年龄的收入恰好等于用户填的值',
     near(sim.rows[0]!.income, 300000, 1e-6), 'got ' + sim.rows[0]!.income);
  ok('45 岁收入 = 30 岁收入 × f(45)/f(30)',
     near(sim.rows[15]!.income, 300000 * E.incomeCurveAt(c, 45) / E.incomeCurveAt(c, 30), 1e-6),
     'got ' + Math.round(sim.rows[15]!.income));
  ok('曲线模式下收入先升后降',
     sim.rows[15]!.income > sim.rows[0]!.income &&
     sim.rows[25]!.income < sim.rows[15]!.income);

  // 三项相乘互不重叠
  const withBoth = E.simulate({ ...inp, realWageGrowth: rate(0.02), cpi: rate(0.03) }, 60);
  ok('曲线 × 实际工资增长 × 通胀，三项相乘不重复',
     near(withBoth.rows[15]!.income,
          300000 * (E.incomeCurveAt(c, 45) / E.incomeCurveAt(c, 30))
                 * Math.pow(1.02, 15) * Math.pow(1.03, 15), 1e-6),
     'got ' + Math.round(withBoth.rows[15]!.income));
  ok('simple 模式不受 realWageGrowth 影响',
     near(E.simulate({ ...inp, incomeModel: { kind: 'simple' },
            incomeGrowth: rate(0), capIncomeGrowthAt: null, incomeCeiling: null,
            realWageGrowth: rate(0.05) }, 60).rows[10]!.income, 300000, 1e-6));
}

console.log('\n[8] 职业天花板');
{
  const base = {
    currentAge: age(30), deathAge: age(90), assets: real(0),
    annualIncome: real(300000), incomeGrowth: rate(0.06), capIncomeGrowthAt: null,
    annualSpend: real(120000), cpi: rate(0), personalInflation: rate(0),
    medInflation: rate(0), rWork: rate(0), rRetire: rate(0), reserve: real(0),
    smileOn: false, events: []
  };
  const noCeil = E.simulate({ ...base, incomeCeiling: null }, 60);
  const ceil = E.simulate({ ...base, incomeCeiling: real(600000) }, 60);

  ok('无天花板时收入按 6% 一直涨',
     near(noCeil.rows[20]!.income, 300000 * Math.pow(1.06, 20), 1), 
     'got ' + Math.round(noCeil.rows[20]!.income));
  ok('有天花板时收入被钳在 60 万',
     near(ceil.rows[20]!.income, 600000, 1e-6), 'got ' + ceil.rows[20]!.income);
  ok('天花板未触及前两者一致',
     near(ceil.rows[5]!.income, noCeil.rows[5]!.income, 1e-6));
  ok('天花板显著降低终值', ceil.endNominal < noCeil.endNominal,
     `${Math.round(ceil.endNominal)} vs ${Math.round(noCeil.endNominal)}`);
  ok('天花板推迟 FIRE 年龄',
     (E.solve({ ...base, reserve: real(2000000), incomeCeiling: real(600000) }).fireAge ?? 99) >=
     (E.solve({ ...base, reserve: real(2000000), incomeCeiling: null }).fireAge ?? 99));

  // 天花板按今日购买力，随 CPI 保值 —— 天花板本身也在上移，
  // 所以它未必在早年就绑定。逐年校验 min() 语义而不是钉某一年的数。
  const infl = E.simulate({ ...base, cpi: rate(0.03), incomeCeiling: real(600000) }, 60);
  let minOk = true, bound = 0;
  for (let t = 0; t < 30; t++) {
    const raw = 300000 * Math.pow(1.06, t);
    const ceilNom = 600000 * Math.pow(1.03, t);
    const want = Math.min(raw, ceilNom);
    if (!near(infl.rows[t]!.income, want, 1)) minOk = false;
    if (ceilNom < raw) bound++;
  }
  ok('通胀下收入 = min(原始增长, 天花板×(1+CPI)^t)', minOk);
  ok('天花板确实在后期绑定过', bound > 0, `绑定 ${bound} 年`);
  ok('天花板名义值随 CPI 上移',
     near(600000 * Math.pow(1.03, 25), 600000 * Math.pow(1.03, 25), 1e-9) &&
     infl.rows[25]!.income < 300000 * Math.pow(1.06, 25),
     'got ' + Math.round(infl.rows[25]!.income));
  ok('退休后收入恒为 0', ceil.rows[35]!.income === 0);
}

console.log('\n[8b] 职业天花板对曲线模式同样生效（曾只在 simple 模式生效）');
{
  const c = { entryAge: 22, peakAge: 45, peakMult: 2.5,
              declineRate: rate(0.01), floorRatio: null };
  const base = {
    currentAge: age(30), deathAge: age(80), assets: real(0),
    annualIncome: real(300000), annualSpend: real(0), cpi: rate(0.015),
    personalInflation: rate(0.025), medInflation: rate(0), rWork: rate(0),
    rRetire: rate(0), reserve: real(0), smileOn: false, events: [],
    retireSpendRatio: rate(1), realWageGrowth: rate(0.015),
    incomeModel: { kind: 'curve' as const, preset: 'standard', curve: c }
  };
  const noCeil = E.simulate({ ...base, incomeCeiling: null }, 80);
  const ceil = E.simulate({ ...base, incomeCeiling: real(500000) }, 80);

  ok('曲线模式下天花板生效（曾完全不生效）',
     ceil.rows[30]!.income < noCeil.rows[30]!.income,
     `${Math.round(ceil.rows[30]!.income)} vs ${Math.round(noCeil.rows[30]!.income)}`);
  ok('曲线模式收入被钳在 天花板×(1+CPI)^t',
     near(ceil.rows[30]!.income, 500000 * Math.pow(1.015, 30), 1),
     'got ' + Math.round(ceil.rows[30]!.income));
  ok('未触及天花板时曲线不受影响',
     near(ceil.rows[2]!.income, noCeil.rows[2]!.income, 1e-6));

  // 没有天花板时，realWageGrowth + CPI 会压过峰后衰减，收入无限上涨
  const late = noCeil.rows.map(r => r.income as number);
  ok('无天花板时收入在个人峰值后仍持续上涨（这正是高估的来源）',
     late[45]! > late[15]!,
     `60岁 ${Math.round(late[45]!)} > 45岁 ${Math.round(late[15]!)}`);
  ok('加了天花板后不再无限上涨',
     near(ceil.rows[45]!.income / ceil.rows[35]!.income, Math.pow(1.015, 10), 1e-6));

  // simple 模式行为不变
  const sim = E.simulate({ ...base, incomeModel: { kind: 'simple' },
    incomeGrowth: rate(0.04), capIncomeGrowthAt: null, incomeCeiling: real(500000) }, 80);
  ok('simple 模式天花板照旧生效',
     near(sim.rows[30]!.income, 500000 * Math.pow(1.015, 30), 1));

  // 固定名义值口径：不随通胀上移
  const fixed = E.simulate({ ...base, incomeCeiling: real(500000),
    incomeCeilingInflates: false }, 80);
  ok('关闭「随通胀上移」后天花板是固定名义值',
     near(fixed.rows[30]!.income, 500000, 1e-6), 'got ' + Math.round(fixed.rows[30]!.income));
  ok('固定名义值比随通胀上移更严格', fixed.rows[30]!.income < ceil.rows[30]!.income);
  ok('固定名义值下收入触顶后不再变化',
     near(fixed.rows[30]!.income, fixed.rows[45]!.income, 1e-6));
  ok('两种口径在 t=0 相同',
     near(fixed.rows[0]!.income, ceil.rows[0]!.income, 1e-6));
  ok('固定名义值推迟 FIRE（实际购买力被通胀吃掉）',
     (E.solve({ ...base, reserve: real(3000000), incomeCeiling: real(500000),
        incomeCeilingInflates: false }).fireAge ?? 99) >=
     (E.solve({ ...base, reserve: real(3000000), incomeCeiling: real(500000),
        incomeCeilingInflates: true }).fireAge ?? 99));
}

console.log('\n[9] 养老金：工资封顶必须传进来（曾漏传，导致指数虚高）');
{
  const common = {
    currentAge: age(30), joinAge: 22, stopAge: 58, claimAge: 58, keepPaying: true,
    socialAvg: 12434, socialGrowth: rate(0.04), monthlyIncome: 25000,
    incomeGrowth: rate(0.04), accountRate: rate(0.025),
    baseMode: 'income' as const, currentYear: 2026
  };
  const noCap = P.project({ ...common, capIncomeGrowthAt: null });
  const cap45 = P.project({ ...common, capIncomeGrowthAt: 45 });

  ok('不封顶时指数恒定（收入与社平同为 4%）',
     near(noCap.indexFirst, noCap.indexLast, 1e-9),
     `${noCap.indexFirst.toFixed(3)} → ${noCap.indexLast.toFixed(3)}`);
  ok('封顶后指数逐年下滑', cap45.indexLast < cap45.indexFirst - 0.1,
     `${cap45.indexFirst.toFixed(3)} → ${cap45.indexLast.toFixed(3)}`);
  ok('封顶后平均缴费指数更低', cap45.avgIndex < noCap.avgIndex,
     `${cap45.avgIndex.toFixed(3)} vs ${noCap.avgIndex.toFixed(3)}`);
  ok('封顶后养老金更低（这正是漏传时被高估的部分）',
     cap45.monthly < noCap.monthly,
     `${Math.round(cap45.monthly)} vs ${Math.round(noCap.monthly)}`);
  ok('封顶不影响缴费年限', cap45.years === noCap.years);

  // 顶格阈值：收入远超社平 300% 时必须被钳住
  const rich = P.project({ ...common, monthlyIncome: 200000, capIncomeGrowthAt: null });
  ok('收入超社平 300% 时标记顶格', rich.cappedAtCeiling === true);
  ok('顶格后指数恰为 3.0', near(rich.indexLast, 3.0, 1e-9), 'got ' + rich.indexLast);
  ok('未超上限时不标记顶格', noCap.cappedAtCeiling === false,
     'indexLast=' + noCap.indexLast.toFixed(2));
  // 顶格封住了超额部分：收入翻倍不再提高待遇
  const richer = P.project({ ...common, monthlyIncome: 400000, capIncomeGrowthAt: null });
  ok('顶格后收入再翻倍，养老金不变',
     near(rich.monthly, richer.monthly, 1e-6),
     `${Math.round(rich.monthly)} vs ${Math.round(richer.monthly)}`);
}

console.log('\n[10] 养老金接入引擎');
{
  const inp: Partial<FireInput> = {
    currentAge: age(30), deathAge: age(95), assets: real(500000),
    annualIncome: real(300000), incomeGrowth: rate(0.04), capIncomeGrowthAt: 45,
    annualSpend: real(120000), cpi: rate(0.022), personalInflation: rate(0.032),
    medInflation: rate(0.06), rWork: rate(0.06), rRetire: rate(0.045),
    reserve: real(500000), smileOn: true, events: []
  };
  const noPension = E.solve(inp);
  const pr = P.project({
    currentAge: age(30), joinAge: 22, stopAge: noPension.fireAge ?? 45, claimAge: 63,
    keepPaying: false, socialAvg: 12434, socialGrowth: rate(0.04),
    monthlyIncome: 25000, incomeGrowth: rate(0.04), baseMode: 'income', currentYear: 2026
  });
  const withPension = E.solve({
    ...inp, events: [P.toEvent(pr, { currentAge: age(30), deathAge: age(95), colaRate: rate(0.02) })]
  });
  ok('两种情形都有解', noPension.fireAge !== null && withPension.fireAge !== null);
  ok('计入养老金后不晚于不计入', withPension.fireAge! <= noPension.fireAge!,
     'with=' + withPension.fireAge + ' no=' + noPension.fireAge);
  console.log('     [信息] 不计养老金 FIRE ' + noPension.fireAge +
              ' 岁，计入后 ' + withPension.fireAge + ' 岁');
}

console.log('\n[11] 反解「刚好花完」的年支出');
{
  // 整年扫描的 overshoot：收入越高，跨过那一年剩得越离谱
  const inp: Partial<FireInput> = {
    ...E.DEFAULTS, reserve: real(0), annualIncome: real(3000000)
  };
  const r = E.solve(inp);
  ok('高收入 + 零应急金有解', r.fireAge !== null, 'fireAge=' + r.fireAge);

  const room = E.solveSpend(inp, r.fireAge!);
  ok('反解出一个数', room !== null);
  ok('反解值高于当前年支出', room! > (inp.annualSpend as number),
     `${Math.round(room!)} vs ${inp.annualSpend}`);

  const s = E.simulate({ ...inp, annualSpend: real(room!) }, r.fireAge!);
  ok('用反解值重跑仍然可行', s.ok === true);
  // reserve = 0 时 targetNominal 也是 0，只能拿原来的剩余当分母：
  // 这条断言说的是「那笔 overshoot 被吃掉了 99.9% 以上」
  const surplus0 = (r.sim.endNominal as number) - (r.sim.targetNominal as number);
  ok('终值收敛到应急金水位（剩余被吃干净）',
     Math.abs(s.endNominal - s.targetNominal) / Math.max(1, surplus0) < 1e-3,
     `${Math.round(s.endNominal)} vs ${Math.round(s.targetNominal)}，原剩余 ${Math.round(surplus0)}`);

  // 应急金非零时可以直接看 |终值 − 水位| / 水位
  const inp2: Partial<FireInput> = { ...inp, reserve: real(500000) };
  const r2 = E.solve(inp2);
  const room2 = E.solveSpend(inp2, r2.fireAge!);
  const s2 = E.simulate({ ...inp2, annualSpend: real(room2!) }, r2.fireAge!);
  ok('留应急金时也能反解', room2 !== null && room2 > (inp2.annualSpend as number));
  ok('终值与应急金水位的相对差 < 1e-3',
     Math.abs(s2.endNominal - s2.targetNominal) / (s2.targetNominal as number) < 1e-3,
     `${Math.round(s2.endNominal)} vs ${Math.round(s2.targetNominal)}`);
  ok('反解值仍是可行解（取 lo 侧）', s2.ok === true);

  // 单调性的另一面：再多花一点点就不可行了
  const over = E.simulate({ ...inp2, annualSpend: real(room2! * 1.01) }, r2.fireAge!);
  ok('比反解值再多花 1% 就撑不住', over.ok === false);

  // 当前支出在该退休年龄下本就不可行 → 解不出
  ok('不可行的退休年龄返回 null',
     E.solveSpend(inp2, inp2.currentAge as number) === null);
}

console.log('\n========================================');
if (fails.length) {
  console.log('失败 ' + fails.length + ' / ' + count + ' 项：' + fails.join(', '));
  process.exit(1);
}
console.log('全部通过（' + count + ' 项）');
