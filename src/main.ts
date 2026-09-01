/* 界面绑定。所有计算逻辑在 engine / pension，本文件只负责读写 DOM。 */
import * as E from './engine';
import * as P from './pension';
import * as C from './charts';
import { cny, cnyFull, parseAmount, pct } from './format';
import { METHOD_HTML } from './method';
import { Age, CashEvent, FireInput, SimResult, SolveResult, age, rate, real } from './types';

const STORE_KEY = 'fire-calc-v1';
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

interface PensionCfg {
  on: boolean; joinAge: number; socialAvg: number; baseMode: P.BaseMode;
  monthlyIncome: number; socialGrowth: number; accountRate: number;
  claimAge: number; cola: number; keepPaying: boolean;
}

interface State { input: FireInput; pension: PensionCfg; showReal: boolean; }

const DEFAULT_PENSION: PensionCfg = {
  on: false, joinAge: 22, socialAvg: 12434, baseMode: 'income',
  monthlyIncome: 25000, socialGrowth: 0.04,
  accountRate: P.defaultAccountRate(0.04) as number,
  claimAge: 63, cola: P.COLA.neutral as number, keepPaying: false
};

let st: State = {
  input: structuredClone(E.DEFAULTS),
  pension: { ...DEFAULT_PENSION },
  showReal: true
};

// ---- 持久化（读写都包 try/catch）----------------------------------------
function save(): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(st)); } catch { /* 忽略 */ }
}
function load(): void {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const p = JSON.parse(raw) as Partial<State>;
    if (p.input)   st.input   = { ...E.DEFAULTS, ...p.input };
    if (p.pension) st.pension = { ...DEFAULT_PENSION, ...p.pension };
    if (typeof p.showReal === 'boolean') st.showReal = p.showReal;
  } catch { /* 坏数据就用默认值 */ }
}

// ---- 养老金 → 现金流事件 -------------------------------------------------
/** 养老金依赖 FIRE 年龄，而 FIRE 年龄又依赖养老金 —— 迭代两轮取不动点。
 * 实测两轮即收敛：第一轮用无养老金的解当停缴年龄，第二轮用它重算。 */
/** 返回 used：最终真正拿去求解的那份 input（已注入养老金事件）。
 * 结论区的二次求解必须用它，否则口径和展示出来的 FIRE 年龄对不上。 */
function solveWithPension(input: FireInput, pc: PensionCfg): {
  res: SolveResult; pension: P.PensionResult | null; used: FireInput;
} {
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
    const gap = (sim.targetNominal as number) - (sim.endNominal as number);
    hero = '当前参数下无法 FIRE';
    sub = `干到 ${input.deathAge} 岁仍有缺口`;
    lines += line('资金缺口', `<b>${cny(gap)}</b>`, true);
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
      `${years} 年后按医疗通胀 ${pct(input.medInflation)} 滚成这个数`);
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

/** 折叠块收起时，在标题右侧显示当前值摘要，不用展开就能看见 */
function renderBlockSummaries(): void {
  const i = st.input, p = st.pension;
  const sums: Record<string, string> = {
    '我的基本情况': `${i.currentAge}岁 · ${cny(i.annualIncome)}/年 · 存 ${pct((i.annualIncome - i.annualSpend) / Math.max(1, i.annualIncome), 0)}`,
    '收入模型': i.incomeModel.kind === 'simple'
      ? `简单增长 ${pct(i.incomeGrowth, 1)}`
      : (E.INCOME_PRESETS.find(p => p.key === (i.incomeModel as {preset:string}).preset)?.name ?? '曲线'),
    '我打算活到几岁': `${i.deathAge} 岁`,
    '我要留多少应急金': cny(i.reserve),
    '市场假设': `${pct(i.rWork, 1)} / ${pct(i.rRetire, 1)} · 通胀 ${pct(i.personalInflation, 1)}`,
    '退休后的支出曲线': i.smileOn ? '微笑曲线已开' : '恒定实际支出',
    '社保养老金': p.on ? `${p.claimAge} 岁起领` : '未计入',
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
  | 'medInflation' | 'rWork' | 'rRetire' | 'retireSpendRatio';

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
    show(); schedule();
  });
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

function chips(hostId: string, get: () => string | number,
               set: (v: string) => void): void {
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
  bindRange('medInflation', true);
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
  bindPhases();
  bindEvents();
  bindPension();
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
    st = { input: structuredClone(E.DEFAULTS), pension: { ...DEFAULT_PENSION }, showReal: true };
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
      if (p.input) st.input = { ...E.DEFAULTS, ...p.input };
      if (p.pension) st.pension = { ...DEFAULT_PENSION, ...p.pension };
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
    ['预留金按医疗通胀', () => {
      const s = E.simulate({ currentAge: age(30), deathAge: age(40), reserve: real(100000),
        medInflation: rate(0.06), cpi: rate(0.02) }, 35);
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
