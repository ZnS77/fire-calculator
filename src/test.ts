import * as E from './engine';
import * as P from './pension';
import * as CH from './child';
import * as HO from './house';
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
    medPremium: rate(0), rWork: rate(0), rRetire: rate(0), reserve: real(0),
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

  // 预留金按医疗通胀（= CPI + 溢价）而非 CPI 滚动
  const s7 = E.simulate({ currentAge: age(30), deathAge: age(40),
    reserve: real(100000), medPremium: rate(0.04), cpi: rate(0.02) }, 35);
  ok('预留金按医疗通胀滚动（CPI 2% + 溢价 4pp = 6%）',
    near(s7.targetNominal, 100000 * Math.pow(1.06, 11), 1e-6), 'got ' + s7.targetNominal);

  // 溢价口径的核心不变式：CPI 一变，医疗通胀必须跟着变。
  // 这正是旧实现（绝对值）做不到的事 —— 那时改 CPI 只会改折现，水位线纹丝不动。
  const medLo = E.simulate({ currentAge: age(30), deathAge: age(40),
    reserve: real(100000), medPremium: rate(0.02), cpi: rate(0.01) }, 35);
  const medHi = E.simulate({ currentAge: age(30), deathAge: age(40),
    reserve: real(100000), medPremium: rate(0.02), cpi: rate(0.03) }, 35);
  ok('溢价不变、CPI 高 2pp → 名义水位线跟着抬高',
     medHi.targetNominal > medLo.targetNominal * 1.2,
     `${Math.round(medLo.targetNominal)} → ${Math.round(medHi.targetNominal)}`);
  ok('CPI 1% + 溢价 2pp 恰好等于 3% 的绝对值',
     near(medLo.targetNominal, 100000 * Math.pow(1.03, 11), 1e-6),
     'got ' + medLo.targetNominal);

  // 预留金的今日购买力口径：医疗通胀高于 CPI 时必须大于面值
  const s8 = E.simulate({ currentAge: age(30), deathAge: age(90), reserve: real(500000),
    medPremium: rate(0.038), cpi: rate(0.022) }, 50);
  const ratio = Math.pow(1.06 / 1.022, 61);
  ok('预留金今日购买力 = 面值 × (1+医疗)/(1+CPI) 的 n 次方',
     near(s8.targetReal, 500000 * ratio, 1),
     `got ${Math.round(s8.targetReal)} want ${Math.round(500000 * ratio)}`);
  ok('医疗通胀 > CPI 时今日购买力口径远大于面值',
     s8.targetReal > 500000 * 5, 'got ' + Math.round(s8.targetReal));
  // 医疗通胀 == CPI 时两者应相等
  const s9 = E.simulate({ currentAge: age(30), deathAge: age(90), reserve: real(500000),
    medPremium: rate(0), cpi: rate(0.022) }, 50);
  ok('溢价为 0（医疗通胀 = CPI）时今日购买力口径回落到面值',
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
    personalInflation: rate(0), medPremium: rate(0), rWork: rate(0), rRetire: rate(0),
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
    personalInflation: rate(0), medPremium: rate(0), rWork: rate(0), rRetire: rate(0),
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
    medPremium: rate(0), rWork: rate(0), rRetire: rate(0), reserve: real(0),
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
    personalInflation: rate(0.025), medPremium: rate(0), rWork: rate(0),
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
    medPremium: rate(0.02), rWork: rate(0.06), rRetire: rate(0.045),
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

console.log('\n[12] 市场假设情景预设');
{
  const byKey = (k: string): E.MarketPreset =>
    E.MARKET_PRESETS.find(p => p.key === k)!;
  const neutral = byKey('neutral');

  // 中性档必须与 DEFAULTS 逐位相同，否则默认状态下那张卡根本选不中
  ok('中性档 = DEFAULTS 的四元组',
     neutral.cpi === E.DEFAULTS.cpi
     && neutral.personalInflation === E.DEFAULTS.personalInflation
     && neutral.rWork === E.DEFAULTS.rWork
     && neutral.rRetire === E.DEFAULTS.rRetire);
  ok('DEFAULTS 反查到中性档', E.matchMarketPreset(E.DEFAULTS)?.key === 'neutral');

  // 只要动过任意一个，就该落到「自定义」
  for (const k of ['cpi', 'personalInflation', 'rWork', 'rRetire'] as const) {
    const tweaked: FireInput = { ...E.DEFAULTS, [k]: rate((E.DEFAULTS[k] as number) + 0.005) };
    ok('改动 ' + k + ' 后不再匹配任何档', E.matchMarketPreset(tweaked) === null);
  }

  // medPremium 是另一根轴（医疗体系与照护成本），不属于市场假设这四元组。
  // 单独调它不该把已选中的档位打散 —— 这与上面那组断言方向相反，是故意的。
  ok('单独调 medPremium 仍匹配中性档',
     E.matchMarketPreset({ ...E.DEFAULTS, medPremium: rate(0.03) })?.key === 'neutral');

  // 三档自洽的不变式：真正起作用的是退休期**实际**收益率。
  // 只要它不是单调递增，就说明某一档把收益率和通胀配反了 ——
  // 那正是「只降收益率不降通胀」的滞胀陷阱，卡片必须先在这里被挡住。
  const rr = E.MARKET_PRESETS.map(p => E.realRate(p.rRetire, p.personalInflation) as number);
  ok('退休期实际收益率按 保守 < 中性 < 乐观 单调递增',
     rr.every((v, idx) => idx === 0 || v > rr[idx - 1]!),
     rr.map(v => (v * 100).toFixed(2) + '%').join(' → '));
  ok('保守档退休期实际收益为负（本金逐年缩水）', rr[0]! < 0, (rr[0]! * 100).toFixed(2) + '%');

  // 每档都能跑出结果，且越乐观越早退休 —— 卡片选下去不会给出反直觉的排序
  const fire = E.MARKET_PRESETS.map(p => E.solve({
    ...E.DEFAULTS, cpi: p.cpi, personalInflation: p.personalInflation,
    rWork: p.rWork, rRetire: p.rRetire
  }).fireAge);
  ok('三档都解得出 FIRE 年龄', fire.every(f => f !== null), String(fire));
  ok('越乐观退休越早', fire.every((f, idx) => idx === 0 || f! <= fire[idx - 1]!), String(fire));
  console.log('     [信息] 保守/中性/乐观 FIRE 年龄 ' + fire.join(' / '));

  // 医疗溢价不进预设，但医疗通胀本身会跟着档位走：三档 CPI 各加 2.0pp。
  // 旧实现三档同为 6%，改档位时水位线纹丝不动，那是被证伪的「脱钩」假设的产物。
  const med = E.MARKET_PRESETS.map(p => (p.cpi as number) + (E.DEFAULTS.medPremium as number));
  ok('三档实际医疗通胀 = 4.5% / 3.5% / 3.0%',
     near(med[0]!, 0.045, 1e-9) && near(med[1]!, 0.035, 1e-9) && near(med[2]!, 0.030, 1e-9),
     med.map(v => (v * 100).toFixed(1) + '%').join(' / '));
  ok('三档的医疗溢价同为 2.0pp（它不在利率环境这根轴上）',
     near(E.DEFAULTS.medPremium, 0.02, 1e-9));
  ok('保守档的医疗水位线高于乐观档（CPI 一变它就跟着变）',
     E.solve({ ...E.DEFAULTS, cpi: byKey('conservative').cpi }).sim.targetNominal
       > E.solve({ ...E.DEFAULTS, cpi: byKey('optimistic').cpi }).sim.targetNominal);
}

console.log('\n[13] 老存档迁移：medInflation → medPremium');
{
  // 老存档里存的是 { medInflation: 0.06 }，新字段不存在。
  // main.ts 的 load() 走 `{ ...DEFAULTS, ...p.input }` 再过一遍 migrate()：
  // 老字段被删掉，medPremium 拿新默认值。这里复刻那两步，验证引擎读到的是新默认。
  const legacy = { medInflation: 0.06, cpi: 0.015 } as unknown as Partial<FireInput>;
  const merged = { ...E.DEFAULTS, ...legacy } as FireInput
    & { medInflation?: number };
  delete merged.medInflation;

  ok('迁移后老字段已被删掉', !('medInflation' in merged));
  ok('迁移后 medPremium 回到新默认 2.0pp',
     near(merged.medPremium, 0.02, 1e-12), String(merged.medPremium));
  // 关键：不把老的 6% 反解成溢价（6% − 1.5% = 4.5pp）。老值本身口径就是错的，
  // 反解只会把错误换个形式保留下来，让它回到新默认更好。
  ok('老值没有被反解成 4.5pp 的溢价', !near(merged.medPremium, 0.045, 1e-12));

  const before = 500000 * Math.pow(1.06, 66);          // 老默认：绝对值 6%
  const after = E.solve(merged).sim.targetNominal;      // 新默认：1.5% + 2.0pp
  ok('迁移后水位线大幅下降（老 6% 的复利是数量级错误）',
     after < before / 4, `${Math.round(before)} → ${Math.round(after)}`);
}

console.log('\n[14] 生活模块：零影响回归');
{
  // 这一组是整个模块最重要的断言。两个模块默认关闭，接进来之后默认结果必须**逐位不变**，
  // 否则老用户刷新一下存档，FIRE 年龄就变了。
  const cc: CH.ChildCtx = {
    currentAge: E.DEFAULTS.currentAge, cpi: E.DEFAULTS.cpi,
    spendGrowth: E.DEFAULTS.personalInflation
  };
  const hc: HO.HouseCtx = {
    currentAge: E.DEFAULTS.currentAge, deathAge: E.DEFAULTS.deathAge,
    cpi: E.DEFAULTS.cpi, spendInflation: E.DEFAULTS.personalInflation
  };

  ok('默认 child 未启用', CH.DEFAULT_CHILD.enabled === false);
  ok('默认 house 未启用', HO.DEFAULT_HOUSE.enabled === false);
  // DEFAULT_HOUSE 的租金三项都是「34 元/㎡·月 × 默认面积」换算出来的。
  // 它们与 areaSqm 是各自独立的字段，改默认面积时极容易只改一半 ——
  // 城市档位时代实际发生过：默认城市换档时 postSaleMonthlyRent 漏改，留着上一档的值。
  {
    ok('默认单价 2 万/㎡ × 面积 100㎡ = 200 万',
       HO.DEFAULT_HOUSE.pricePerSqm === 20000 && HO.DEFAULT_HOUSE.areaSqm === 100
       && HO.totalPrice(HO.DEFAULT_HOUSE) === 2000000,
       `${HO.DEFAULT_HOUSE.pricePerSqm} × ${HO.DEFAULT_HOUSE.areaSqm}`);
    ok('默认贷款年限 30 年，且在 40 年上限内',
       HO.DEFAULT_HOUSE.loanYears === 30
       && HO.DEFAULT_HOUSE.loanYears <= HO.POLICY.maxLoanYears);
    const rent = HO.rentFor(HO.DEFAULT_HOUSE.areaSqm);
    ok('34 元/㎡·月 × 100㎡ = 3,400', rent === 3400, 'got ' + rent);
    ok('默认市场月租 = 34 × 默认面积',
       HO.DEFAULT_HOUSE.marketMonthlyRent === rent,
       `${HO.DEFAULT_HOUSE.marketMonthlyRent} vs ${rent}`);
    ok('默认当前住房支出 = 34 × 默认面积（抵扣法的起点）',
       HO.DEFAULT_HOUSE.currentMonthlyHousing === rent,
       `${HO.DEFAULT_HOUSE.currentMonthlyHousing} vs ${rent}`);
    // 卖房后要重新付房租，这笔最容易漏
    ok('默认卖房后月租 = 34 × 默认面积',
       HO.DEFAULT_HOUSE.postSaleMonthlyRent === rent,
       `${HO.DEFAULT_HOUSE.postSaleMonthlyRent} vs ${rent}`);
    ok('默认公积金上限 100 万（通用默认，各城市差异极大）',
       HO.DEFAULT_HOUSE.hpfCap === 1000000, 'got ' + HO.DEFAULT_HOUSE.hpfCap);
  }
  ok('未启用时 childEvents 为空', CH.childEvents(CH.DEFAULT_CHILD, cc).length === 0);
  ok('未启用时 houseEvents 为空', HO.houseEvents(HO.DEFAULT_HOUSE, hc).length === 0);

  const bare = E.solve(E.DEFAULTS);
  const wired = E.solve({ ...E.DEFAULTS, events: [
    ...E.DEFAULTS.events,
    ...CH.childEvents(CH.DEFAULT_CHILD, cc),
    ...HO.houseEvents(HO.DEFAULT_HOUSE, hc)
  ] });
  ok('默认参数下 FIRE 年龄仍是 47 岁', bare.fireAge === 47, 'got ' + bare.fireAge);
  ok('接入两个模块后 FIRE 年龄不变', wired.fireAge === bare.fireAge,
     `${wired.fireAge} vs ${bare.fireAge}`);
  ok('接入两个模块后终值逐位不变',
     wired.sim.endNominal === bare.sim.endNominal,
     `${wired.sim.endNominal} vs ${bare.sim.endNominal}`);

  // 老存档没有 child / house 字段，load() 的浅合并要落到默认值上
  const legacy = JSON.parse('{"input":{"cpi":0.015},"pension":{"on":true}}') as
    { child?: Partial<CH.ChildCfg>; house?: HO.LegacyHouseCfg };
  const mc = { ...CH.DEFAULT_CHILD, ...legacy.child };
  const mh = HO.migrateCfg(legacy.house ?? {});
  ok('老存档合并后 child 拿到默认值且未启用', mc.enabled === false && mc.tier === 'modestPublic');
  ok('老存档合并后 house 拿到默认值且未启用',
     mh.enabled === false && HO.totalPrice(mh) === 2000000);
  ok('老存档合并后两个模块仍不产生任何事件',
     CH.childEvents(mc, cc).length === 0 && HO.houseEvents(mh, hc).length === 0);
}

console.log('\n[15] 子女模块：事件生成与口径');
{
  // 零通胀零溢价，事件金额就是今日购买力本身，可以手算对账
  const ctx: CH.ChildCtx = { currentAge: age(30), cpi: rate(0), spendGrowth: rate(0) };
  const base: CH.ChildCfg = {
    ...CH.DEFAULT_CHILD, enabled: true, tier: 'modestPublic',
    children: [{ kind: 'planned', yearsUntilBirth: 0 }],
    subsidy: false, premiumOverride: rate(0)
  };
  const evs = CH.childEvents(base, ctx);
  ok('一个今年出生的孩子 → 四个学段四条事件', evs.length === 4, 'got ' + evs.length);
  ok('学段事件按家长年龄铺开 30→52',
     evs[0]!.startAge === 30 && evs[evs.length - 1]!.endAge === 52,
     `${evs[0]!.startAge} → ${evs[evs.length - 1]!.endAge}`);
  // 小康公立学前 4.0 万，扣居住系数 0.8 → 3.2 万/年，流出为负
  ok('学前段金额 = 4.0 万 × 0.8', near(evs[0]!.amount, -32000, 1e-6), 'got ' + evs[0]!.amount);
  // 大学段住宿费已单列，不扣居住
  ok('大学段不扣居住，仍是 3.5 万',
     near(evs[3]!.amount, -35000, 1e-6), 'got ' + evs[3]!.amount);
  ok('溢价为 0、CPI 为 0 时事件增长率为 0', evs.every(e => e.growth === 0));

  const sum = evs.reduce((s, e) => s - (e.amount as number) * (e.endAge - e.startAge), 0);
  ok('四段金额 × 年数 = childLifetimeTotal',
     near(sum, CH.childLifetimeTotal(base), 1e-6),
     `${Math.round(sum)} vs ${Math.round(CH.childLifetimeTotal(base))}`);

  // 育儿补贴：0—3 岁，名义定额，正流、不打折、growth 恒为 0
  const withSub = CH.childEvents({ ...base, subsidy: true }, ctx);
  const sub = withSub.find(e => e.name.includes('育儿补贴'));
  ok('开启补贴多出一条事件', withSub.length === evs.length + 1);
  ok('补贴 3600 元/年、0—3 岁、名义定额',
     sub !== undefined && sub.amount === 3600 && sub.endAge - sub.startAge === 3 && sub.growth === 0);

  // 含居住口径应当整体更贵，且大学段不受影响
  const full = CH.childEvents({ ...base, includeHousing: true }, ctx);
  ok('含居住口径的学前段 = 4.0 万', near(full[0]!.amount, -40000, 1e-6));
  ok('含居住口径的大学段不变', near(full[3]!.amount, evs[3]!.amount, 1e-6));

  // 已出生的孩子：多一条「已计入年支出的部分」的正流，且随家庭支出通胀走
  const born: CH.ChildCfg = {
    ...base, children: [{ kind: 'born', age: 8, currentSpend: 20000 }]
  };
  const bornCtx: CH.ChildCtx = { currentAge: age(30), cpi: rate(0), spendGrowth: rate(0.025) };
  const bevs = CH.childEvents(born, bornCtx);
  const off = bevs.find(e => e.name.includes('已计入年支出'));
  ok('已出生的孩子有一条抵扣事件', off !== undefined);
  ok('抵扣是正流、金额等于声明值', off !== undefined && off.amount === 20000);
  ok('抵扣按家庭支出通胀增长，不按教育通胀',
     off !== undefined && near(off.growth, 0.025, 1e-12), 'got ' + off?.growth);
  ok('抵扣做到孩子 22 岁为止（家长 44 岁）',
     off !== undefined && off.endAge === 44, 'got ' + off?.endAge);
  ok('孩子 8 岁 → 学段事件不再包含已经过去的年份',
     bevs.every(e => e.endAge > 30));

  // childSpendThisYear：可以是负数，那是「档选低了」的有效信号，不能 clamp 到 0
  ok('本年增量 = 档位成本 − 声明值',
     near(CH.childSpendThisYear(born, bornCtx), 28800 - 20000, 1e-6),
     'got ' + CH.childSpendThisYear(born, bornCtx));
  const overstated = { ...born, children: [{ kind: 'born' as const, age: 8, currentSpend: 100000 }] };
  ok('声明值高于档位成本时本年增量为负',
     CH.childSpendThisYear(overstated, bornCtx) < 0,
     'got ' + Math.round(CH.childSpendThisYear(overstated, bornCtx)));

  // 多孩折扣：第二个孩子按边际口径打折
  const two: CH.ChildCfg = { ...base, children: [
    { kind: 'planned', yearsUntilBirth: 0 }, { kind: 'planned', yearsUntilBirth: 3 }
  ] };
  const t2 = CH.childEvents(two, ctx);
  const second = t2.filter(e => e.name.startsWith('子女2'));
  ok('第二个孩子的学前段 = 第一个 × 0.80（扣居住口径）',
     second.length > 0 && near(second[0]!.amount, -32000 * 0.80, 1e-6),
     'got ' + second[0]?.amount);
  ok('关闭多孩折扣后两个孩子同价',
     near(CH.childEvents({ ...two, siblingDiscount: false }, ctx)
       .filter(e => e.name.startsWith('子女2'))[0]!.amount, -32000, 1e-6));

  // 国际路线的转轨点：15 岁前走 preIntlTier，之后才是国际
  const intl: CH.ChildCfg = { ...base, tier: 'international', intlFromAge: 15 };
  ok('15 岁转国际：0—22 岁合计明显低于全程国际',
     CH.childLifetimeTotal(intl) < CH.childLifetimeTotal({ ...intl, intlFromAge: 0 }) * 0.7,
     `${Math.round(CH.childLifetimeTotal(intl))} vs ${Math.round(CH.childLifetimeTotal({ ...intl, intlFromAge: 0 }))}`);
}

console.log('\n[16] 购房模块：月供名义固定与抵扣法');
{
  // 调研给的对账用例：200 万 / 3.05% / 30 年 = 8,486.11 元
  ok('等额本息 200万/3.05%/30年 = 8486.11',
     near(HO.monthlyPayment(2000000, 0.0305, 30), 8486.11, 0.01),
     'got ' + HO.monthlyPayment(2000000, 0.0305, 30).toFixed(2));
  ok('同一笔 40 年 = 7217.44',
     near(HO.monthlyPayment(2000000, 0.0305, 40), 7217.44, 0.01),
     'got ' + HO.monthlyPayment(2000000, 0.0305, 40).toFixed(2));
  ok('未还款时剩余本金 = 本金',
     near(HO.remainingPrincipal(2000000, 0.0305, 30, 0), 2000000, 1e-6));
  ok('还满期数后剩余本金 = 0',
     near(HO.remainingPrincipal(2000000, 0.0305, 30, 360), 0, 1e-6));

  const ctx: HO.HouseCtx = {
    currentAge: age(30), deathAge: age(95), cpi: rate(0.015), spendInflation: rate(0.025)
  };
  // 显式给一组「一线量级」的参数（5.5 万/㎡ × 85㎡ = 467.5 万）：这组断言要的是
  // 「组合贷两条月供」和「纯公积金额度不足」，都依赖总价远高于公积金上限。
  // 别依赖 DEFAULT_HOUSE 的量级 —— 它是会变的。
  const cfg: HO.HouseCfg = {
    ...HO.DEFAULT_HOUSE, enabled: true, buyAge: 32,
    pricePerSqm: 55000, areaSqm: 85,
    marketMonthlyRent: 6900, currentMonthlyHousing: 6900, postSaleMonthlyRent: 6900
  };
  const r = HO.project(cfg, ctx);
  const evs = HO.houseEvents(cfg, ctx);

  // 本模块最关键的一条：等额本息月供在还款期内名义金额一分不变
  const pay = evs.filter(e => e.name.startsWith('房贷月供'));
  ok('组合贷生成两条月供事件（商贷 + 公积金）', pay.length === 2, 'got ' + pay.length);
  ok('月供事件的 growth 全为 0（名义固定）', pay.every(e => e.growth === 0));
  ok('月供事件金额 = 月供 × 12',
     near(-pay.reduce((s, e) => s + (e.amount as number), 0), r.monthlyTotal * 12, 1e-6));
  ok('月供起止 = 买房年 → 买房年 + 贷款年限',
     pay.every(e => e.startAge === 32 && e.endAge === 32 + cfg.loanYears));

  // 持有成本性质相反：随 CPI 涨
  const hold = evs.find(e => e.name.startsWith('房屋持有成本'));
  ok('持有成本随 CPI 增长（与名义固定的月供性质相反）',
     hold !== undefined && near(hold.growth, 0.015, 1e-12));

  // 首付是资产转移，走一次性事件；纯公积金额度不足时缺口自动进首付
  const down = evs.find(e => e.name === '购房首付');
  ok('首付是一次性负流', down !== undefined && (down.amount as number) < 0
     && down.endAge - down.startAge === 1);
  ok('组合贷下首付 = 总价 − 商贷 − 公积金',
     near(r.downPayment, r.priceAtBuy - r.comPrincipal - r.hpfPrincipal, 1e-6));
  ok('组合贷下没有公积金缺口', near(r.hpfShortfall, 0, 1e-6));
  const hpfOnly = HO.project({ ...cfg, payMode: 'hpf' }, ctx);
  ok('纯公积金额度不足 → 缺口 > 0', hpfOnly.hpfShortfall > 0,
     'got ' + Math.round(hpfOnly.hpfShortfall));
  ok('缺口自动进首付，首付高于「首付比 × 总价」',
     hpfOnly.downPayment > hpfOnly.priceAtBuy * (cfg.downRatio as number) + 1,
     `${Math.round(hpfOnly.downPayment)} vs ${Math.round(hpfOnly.priceAtBuy * (cfg.downRatio as number))}`);

  // 贷款利率按本金加权：组合贷不等于商贷利率
  ok('组合贷的贷款利率按本金加权，低于商贷利率',
     r.loanRate < (cfg.comRate as number) && r.loanRate > (cfg.hpfRate as number),
     (r.loanRate * 100).toFixed(2) + '%');
  ok('全款时贷款利率为 0（文案必须绕开这一项）',
     HO.project({ ...cfg, payMode: 'cash' }, ctx).loanRate === 0);
  ok('实际利率用费雪公式（除法）',
     near(r.realLoanRate, (1 + r.loanRate) / 1.015 - 1, 1e-12));

  // 抵扣法：当前住房支出恰好等于新的月供 + 持有成本时，首年净增为 0
  const offsetCfg: HO.HouseCfg = {
    ...cfg, currentMonthlyHousing: r.monthlyTotal + r.annualHoldCost / 12
  };
  ok('当前住房支出 = 新月供 + 持有成本 → 首年净增为 0',
     near(HO.project(offsetCfg, ctx).netMonthlyDelta, 0, 1e-6),
     'got ' + HO.project(offsetCfg, ctx).netMonthlyDelta);
  const off = evs.find(e => e.name.startsWith('抵扣原住房支出'));
  ok('抵扣事件是正流、金额 = 当前月住房支出 × 12',
     off !== undefined && near(off.amount, cfg.currentMonthlyHousing * 12, 1e-6));
  ok('抵扣按 spendInflation 增长（那笔房租长在这条轨道上）',
     off !== undefined && near(off.growth, 0.025, 1e-12));
  ok('抵扣一路开到寿终', off !== undefined && off.endAge === 96);
  ok('当前住房支出填 0 时不生成抵扣事件',
     HO.houseEvents({ ...cfg, currentMonthlyHousing: 0 }, ctx)
       .every(e => !e.name.startsWith('抵扣原住房支出')));

  // 卖房：净得 + 重新付房租，两条都要有
  const sell: HO.HouseCfg = { ...cfg, sellOn: true, sellAge: 70 };
  const sevs = HO.houseEvents(sell, ctx);
  ok('卖房后有「卖房净得」事件',
     sevs.some(e => e.name === '卖房净得' && (e.amount as number) > 0));
  ok('卖房后有重新付房租的事件（漏掉它卖房就成了免费变现）',
     sevs.some(e => e.name === '卖房后房租' && (e.amount as number) < 0));
  const postRent = sevs.find(e => e.name === '卖房后房租')!;
  ok('卖房后房租自卖出年起、到寿终为止、随通胀涨',
     postRent.startAge === 70 && postRent.endAge === 96
     && near(postRent.growth, 0.025, 1e-12));
  ok('卖房后不再有持有成本', sevs.find(e => e.name.startsWith('房屋持有成本'))!.endAge === 70);
  const sr = HO.project(sell, ctx);
  ok('卖房净得 = 毛价 × (1 − 成本率) − 剩余本金',
     near(sr.sellNet, sr.sellGross * (1 - (sell.sellCostRate as number)) - sr.sellDebt, 1e-6));
  ok('持有 38 年后贷款早已还清，剩余本金为 0', near(sr.sellDebt, 0, 1e-6));

  // 通胀帮你还房贷
  ok('2% 通胀下 30 年实际负担约 74.7%',
     near(HO.project({ ...cfg, loanYears: 30 },
       { ...ctx, cpi: rate(0.02) }).realBurdenRatio, 0.747, 0.002));
  ok('通胀吃掉的比例 = 1 − 实际负担比',
     near(r.inflationEatenRatio, 1 - r.realBurdenRatio, 1e-12));
  ok('最后一笔月供折成今日购买力后显著更小',
     r.lastPaymentToday < r.monthlyTotal * 0.7,
     `${Math.round(r.lastPaymentToday)} vs ${Math.round(r.monthlyTotal)}`);

  // ---- 单价 × 面积：总价是派生量 -------------------------------------------
  {
    ok('总价 = 单价 × 面积', HO.totalPrice(cfg) === 4675000, 'got ' + HO.totalPrice(cfg));
    const dearer = { ...cfg, pricePerSqm: 60000 };
    const bigger = { ...cfg, areaSqm: 120 };
    ok('改单价 → 总价跟着变', HO.totalPrice(dearer) === 60000 * 85);
    ok('改面积 → 总价跟着变', HO.totalPrice(bigger) === 55000 * 120);
    // 总价是五处计算的共同基数（买入名义价、持有成本、租金回报率、现金流缺口、卖出毛价），
    // 派生量若没接对，这几处会静默地停在老值上
    const rd = HO.project(dearer, ctx), r0 = HO.project(cfg, ctx);
    ok('单价涨了，买入名义价与年持有成本跟着涨',
       rd.priceAtBuy > r0.priceAtBuy && rd.annualHoldCost > r0.annualHoldCost);
    ok('单价涨了而租金没动 → 租金回报率被压低',
       rd.rentYield < r0.rentYield);
  }

  // ---- 改面积时租金三项跟着重算，用户手改过的不覆盖 --------------------------
  {
    const base = HO.DEFAULT_HOUSE;           // 三项都还是 34 × 100 = 3,400
    const a120 = HO.applyArea(base, 120);
    ok('面积 100 → 120，房子自身的两项租金按 34 元/㎡·月 重算成 4,080',
       a120.marketMonthlyRent === 4080 && a120.postSaleMonthlyRent === 4080,
       `${a120.marketMonthlyRent} / ${a120.postSaleMonthlyRent}`);
    // currentMonthlyHousing 是「你现在付多少」，与要买多大的房子无关。
    // 早先它也跟着面积走，结果是把目标面积调大就能「比不买房还早退休」——
    // 抵扣项凭空变大。那是耦合造出来的假象，不是模型结论。
    ok('当前住房支出不跟着目标面积走（它描述的是你现在住的地方）',
       a120.currentMonthlyHousing === base.currentMonthlyHousing,
       `${a120.currentMonthlyHousing} vs ${base.currentMonthlyHousing}`);
    ok('applyArea 只动面积与租金，单价、公积金额度、首付比一概不动',
       a120.pricePerSqm === base.pricePerSqm && a120.hpfCap === base.hpfCap
       && a120.downRatio === base.downRatio && a120.areaSqm === 120);

    // 「改过没有」的判据是「等不等于旧面积的换算值」，不额外存标志位
    const edited = { ...base, marketMonthlyRent: 8000 };
    const e120 = HO.applyArea(edited, 120);
    ok('用户手改过的市场月租不再被覆盖', e120.marketMonthlyRent === 8000,
       'got ' + e120.marketMonthlyRent);
    ok('同一次里没手改过的卖后房租照常重算', e120.postSaleMonthlyRent === 4080,
       'got ' + e120.postSaleMonthlyRent);
    ok('连续改两次面积仍然跟得住（判据用的是上一次的换算值，不是原始默认值）',
       HO.applyArea(a120, 80).marketMonthlyRent === HO.rentFor(80),
       'got ' + HO.applyArea(a120, 80).marketMonthlyRent);
  }

  // ---- 老存档迁移：city / location 丢弃，totalPrice 换算 ---------------------
  {
    const saved = JSON.parse(
      '{"enabled":true,"city":"t1core","location":"urban","totalPrice":4675000}'
    ) as HO.LegacyHouseCfg;
    const m = HO.migrateCfg(saved);
    ok('老存档反解出单价 55,000 元/㎡（467.5 万 ÷ 老一线档的 85㎡）',
       m.pricePerSqm === 55000 && m.areaSqm === 85, `${m.pricePerSqm} × ${m.areaSqm}`);
    ok('迁移后总价一分不差', HO.totalPrice(m) === 4675000, 'got ' + HO.totalPrice(m));
    ok('已删除的三个字段不再跟着存档传播',
       !('city' in m) && !('location' in m) && !('totalPrice' in m));
    ok('其余字段照常保留', m.enabled === true && m.payMode === 'combo');

    // 非一线的老档位面积是 90㎡
    const m2 = HO.migrateCfg(JSON.parse('{"city":"t2plain","totalPrice":1170000}'));
    ok('普通二线老存档：117 万 ÷ 90㎡ = 13,000 元/㎡',
       m2.pricePerSqm === 13000 && m2.areaSqm === 90, `${m2.pricePerSqm} × ${m2.areaSqm}`);

    // 用户手改过总价的老存档同样保得住（这才是这条迁移真正要救的东西）
    const m3 = HO.migrateCfg(JSON.parse('{"city":"t1core","totalPrice":8000000}'));
    ok('用户手改过的老总价 800 万原样保住', HO.totalPrice(m3) === 8000000);

    // 反解不出来（没有 totalPrice）就回到新默认
    const m4 = HO.migrateCfg(JSON.parse('{"enabled":true,"buyAge":35}'));
    ok('老存档没有这些字段 → 回到新默认 2 万 × 100㎡',
       m4.pricePerSqm === 20000 && m4.areaSqm === 100 && m4.buyAge === 35);
    ok('迁移不会误伤新格式存档',
       HO.migrateCfg(JSON.parse('{"pricePerSqm":30000,"areaSqm":70}')).pricePerSqm === 30000);
  }
}

console.log('\n[17] 生活模块接入引擎：方向与量级');
{
  const cc: CH.ChildCtx = {
    currentAge: E.DEFAULTS.currentAge, cpi: E.DEFAULTS.cpi,
    spendGrowth: E.DEFAULTS.personalInflation
  };
  const hc: HO.HouseCtx = {
    currentAge: E.DEFAULTS.currentAge, deathAge: E.DEFAULTS.deathAge,
    cpi: E.DEFAULTS.cpi, spendInflation: E.DEFAULTS.personalInflation
  };
  const bare = E.solve(E.DEFAULTS).fireAge;

  const kid = E.solve({ ...E.DEFAULTS, events: [
    ...CH.childEvents({ ...CH.DEFAULT_CHILD, enabled: true }, cc)] }).fireAge;
  ok('开启子女模块后 FIRE 不会更早', kid !== null && bare !== null && kid >= bare,
     `child=${kid} base=${bare}`);

  // 一线量级（5.5 万/㎡ × 85㎡ = 467.5 万）配年收入 30 万的默认人设根本买不起 ——
  // 模型如实给出「无解」，这本身就是有效信息，不是 bug。
  const tier1Cfg: HO.HouseCfg = {
    ...HO.DEFAULT_HOUSE, enabled: true, pricePerSqm: 55000, areaSqm: 85,
    marketMonthlyRent: 6900, currentMonthlyHousing: 6900, postSaleMonthlyRent: 6900
  };
  const t1 = E.solve({ ...E.DEFAULTS,
    events: [...HO.houseEvents(tier1Cfg, hc)] }).fireAge;
  ok('年收入 30 万 + 467.5 万的房 → 无解（模型不替用户圆场）', t1 === null, 'got ' + t1);

  // 默认配置 200 万（2 万/㎡ × 100㎡），有解，才能检验方向
  const houseCfg: HO.HouseCfg = { ...HO.DEFAULT_HOUSE, enabled: true };
  const hs = E.solve({ ...E.DEFAULTS, events: [...HO.houseEvents(houseCfg, hc)] }).fireAge;
  ok('开启购房模块（默认 200 万）后 FIRE 不会更早',
     hs !== null && bare !== null && hs >= bare, `house=${hs} base=${bare}`);

  const both = E.solve({ ...E.DEFAULTS, events: [
    ...CH.childEvents({ ...CH.DEFAULT_CHILD, enabled: true }, cc),
    ...HO.houseEvents(houseCfg, hc)] }).fireAge;
  ok('两个都开时不早于只开一个',
     both !== null && kid !== null && hs !== null && both >= Math.max(kid, hs),
     `both=${both} child=${kid} house=${hs}`);
  console.log(`     [信息] 默认 ${bare} 岁 · 加子女 ${kid} 岁 · 加购房（200 万）${hs} 岁 · 两个都加 ${both} 岁`);

  // 月供若被误当成随通胀增长的实际固定支出，后期负担会被显著高估 ——
  // 这条断言把那个错误钉死在测试里
  const evs = HO.houseEvents(houseCfg, hc);
  const wrong = evs.map(e => e.name.startsWith('房贷月供')
    ? { ...e, growth: E.DEFAULTS.cpi } : e);
  const right = E.solve({ ...E.DEFAULTS, events: evs }).fireAge;
  const bad = E.solve({ ...E.DEFAULTS, events: wrong }).fireAge;
  ok('把名义固定的月供当成随通胀增长会推迟 FIRE（这正是最容易犯的数值错误）',
     bad !== null && right !== null && bad > right, `错=${bad} 对=${right}`);

  // ---- 失败有两种，不能共用一句「缺口」 ----------------------------------
  // 买一线主城的房（467.5 万）配默认人设（50 万资产 / 30 万年收入）：首付那年资产被
  // 打成负数，但曲线后来靠工资涨回来，期末余额反而远高于应急金。
  // 此时 targetNominal − endNominal 是**负数** —— 结论区若把它当「资金缺口」
  // 显示出来就是一句胡话。这条断言钉住这个组合确实会出现，
  // 从而保证 renderVerdict 里那个分支不会因为「碰不到」而被顺手删掉。
  const tier1 = HO.houseEvents(tier1Cfg, hc);
  const r1 = E.solve({ ...E.DEFAULTS, events: tier1 });
  ok('一线购房：默认人设下无解', r1.fireAge === null && r1.reason === 'never');
  ok('失败成因是中途断供，不是期末不够', r1.sim.bankruptAge !== null,
     `bankruptAge=${r1.sim.bankruptAge}`);
  ok('此时期末余额高于应急金（所以「缺口」会算出负数）',
     (r1.sim.endNominal as number) > (r1.sim.targetNominal as number),
     `end=${Math.round(r1.sim.endNominal)} target=${Math.round(r1.sim.targetNominal)}`);
}

console.log('\n========================================');
if (fails.length) {
  console.log('失败 ' + fails.length + ' / ' + count + ' 项：' + fails.join(', '));
  process.exit(1);
}
console.log('全部通过（' + count + ' 项）');
