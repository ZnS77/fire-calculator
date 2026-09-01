/* 手写 inline SVG 图表 —— 运行时零依赖。
 * 配色取自 dataviz 参考调色板，已过 CVD 校验：
 *   light #2a78d6 / #eb6834，dark #3987e5 / #d95926
 *   最差全对 ΔE：24.7（light）/ 26.8（dark），门槛 8。
 */
import { YearRow } from './types';

const NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(
  n: K, a: Record<string, string | number | null | undefined> = {}
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, n);
  for (const k in a) { const v = a[k]; if (v != null) e.setAttribute(k, String(v)); }
  return e;
}

/** 取 CSS 变量。拿不到时回退到字面值 —— 变量一旦为空，
 * stroke="" 会让整条线静默消失，非常难查，所以必须兜底。 */
const FALLBACK: Record<string, string> = {
  '--s1': '#2a78d6', '--s2': '#eb6834', '--crit': '#d03b3b',
  '--rule': '#dde3e9', '--rule-strong': '#c3ccd5', '--muted': '#7e8b98',
  '--surface': '#fcfcfb'
};
function cssv(name: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || FALLBACK[name] || '#888';
}

/** 「好看的」刻度步长：1 / 2 / 2.5 / 5 / 10 × 10^n */
function niceStep(range: number, target: number): number {
  const raw = range / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
  const n = raw / mag;
  const s = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return s * mag;
}

interface Frame { svg: SVGSVGElement; g: SVGGElement; L: number; T: number; W: number; H: number; }

function frame(host: HTMLElement, W: number, H: number,
               pad: { l: number; r: number; t: number; b: number }): Frame {
  host.innerHTML = '';
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  host.appendChild(svg);
  const g = el('g');
  svg.appendChild(g);
  return { svg, g, L: pad.l, T: pad.t, W: W - pad.l - pad.r, H: H - pad.t - pad.b };
}

interface AxesOpts {
  f: Frame; yMin: number; yMax: number; xMin: number; xMax: number;
  sx(v: number): number; sy(v: number): number;
  fmtY(v: number): string; fmtX(v: number): string;
  /** Y 轴是整数量纲（年龄）时置真：步长取整，避免 43.5 与 43.8 都渲染成「43岁」 */
  yInteger?: boolean;
}

function axes(o: AxesOpts): void {
  const { f } = o;
  const grid = cssv('--rule'), muted = cssv('--muted'), axis = cssv('--rule-strong');
  let step = niceStep(o.yMax - o.yMin, 4);
  if (o.yInteger) step = Math.max(1, Math.round(step));
  for (let v = Math.ceil(o.yMin / step) * step; v <= o.yMax + 1e-9; v += step) {
    const y = o.sy(v);
    f.g.appendChild(el('line', { x1: f.L, y1: y, x2: f.L + f.W, y2: y,
      stroke: Math.abs(v) < 1e-9 ? axis : grid, 'stroke-width': 1 }));
    const t = el('text', { x: f.L - 7, y: y + 3.5, 'text-anchor': 'end',
      'font-size': 10.5, fill: muted, 'font-variant-numeric': 'tabular-nums' });
    t.textContent = o.fmtY(v);
    f.g.appendChild(t);
  }
  const xs = niceStep(o.xMax - o.xMin, 6);
  for (let x = Math.ceil(o.xMin / xs) * xs; x <= o.xMax + 1e-9; x += xs) {
    const t = el('text', { x: o.sx(x), y: f.T + f.H + 15, 'text-anchor': 'middle',
      'font-size': 10.5, fill: muted, 'font-variant-numeric': 'tabular-nums' });
    t.textContent = o.fmtX(x);
    f.g.appendChild(t);
  }
  f.g.appendChild(el('line', { x1: f.L, y1: f.T + f.H, x2: f.L + f.W, y2: f.T + f.H,
    stroke: axis, 'stroke-width': 1 }));
}

function placeTip(tip: HTMLElement, box: DOMRect, px: number, W: number): void {
  tip.style.opacity = '1';
  const left = px / W * box.width;
  tip.style.left = Math.min(box.width - tip.offsetWidth - 6, Math.max(4, left + 12)) + 'px';
  tip.style.top = '10px';
}

export interface AssetChartOpts {
  rows: YearRow[];
  showReal: boolean;
  fireAge: number | null;
  target: number;
  peakAge: number | null;
  bankruptAge: number | null;
  fmtY(v: number): string;
}

/** 图 1 · 资产轨迹。积累期与提取期在 FIRE 点换色，附预留金水位与标注点。 */
export function assetPath(host: HTMLElement, tip: HTMLElement, o: AssetChartOpts): void {
  const { rows } = o;
  if (!rows.length) return;
  const W = 720, H = 300;
  const f = frame(host, W, H, { l: 56, r: 14, t: 12, b: 26 });
  const vals = rows.map(r => o.showReal ? (r.endReal as number) : (r.endNominal as number));
  const yMax = Math.max(...vals, o.target) * 1.08;
  const yMin = Math.min(0, Math.min(...vals) * 1.08);
  const xMin = rows[0]!.age as number, xMax = rows[rows.length - 1]!.age as number;
  const sx = (a: number): number => f.L + (a - xMin) / (xMax - xMin) * f.W;
  const sy = (v: number): number => f.T + f.H - (v - yMin) / (yMax - yMin) * f.H;

  axes({ f, yMin, yMax, xMin, xMax, sx, sy,
    fmtY: o.fmtY, fmtX: v => Math.round(v) + '岁' });

  const s1 = cssv('--s1'), s2 = cssv('--s2'), crit = cssv('--crit'), muted = cssv('--muted');
  const surface = cssv('--surface');

  function seg(from: number, to: number, color: string): void {
    let d = '', a = '';
    for (let i = from; i <= to; i++) {
      const px = sx(rows[i]!.age as number).toFixed(2), py = sy(vals[i]!).toFixed(2);
      const cmd = i === from ? 'M' : 'L';
      d += cmd + px + ' ' + py;
      a += cmd + px + ' ' + py;
    }
    a += `L${sx(rows[to]!.age as number).toFixed(2)} ${sy(0).toFixed(2)}` +
         `L${sx(rows[from]!.age as number).toFixed(2)} ${sy(0).toFixed(2)}Z`;
    f.g.appendChild(el('path', { d: a, fill: color, 'fill-opacity': 0.13 }));
    f.g.appendChild(el('path', { d, fill: 'none', stroke: color, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  }

  const cut = o.fireAge != null
    ? Math.max(0, Math.min(rows.length - 1, o.fireAge - xMin))
    : rows.length - 1;
  seg(0, cut, s1);
  if (cut < rows.length - 1) seg(cut, rows.length - 1, s2);

  if (o.target > 0) {
    const ty = sy(o.target);
    if (ty > f.T && ty < f.T + f.H) {
      f.g.appendChild(el('line', { x1: f.L, y1: ty, x2: f.L + f.W, y2: ty,
        stroke: muted, 'stroke-width': 1.5, 'stroke-dasharray': '5 4' }));
      const lt = el('text', { x: f.L + f.W, y: ty - 6, 'text-anchor': 'end',
        'font-size': 10.5, fill: muted });
      lt.textContent = '应急预留金 ' + o.fmtY(o.target);
      f.g.appendChild(lt);
    }
  }

  function dot(a: number, v: number, color: string, label: string, above: boolean): void {
    const px = sx(a), py = sy(v);
    f.g.appendChild(el('circle', { cx: px, cy: py, r: 5, fill: color,
      stroke: surface, 'stroke-width': 2 }));
    const t = el('text', { x: px, y: py + (above ? -11 : 17), 'text-anchor': 'middle',
      'font-size': 10.5, fill: color, 'font-weight': 600 });
    t.textContent = label;
    f.g.appendChild(t);
  }
  if (o.fireAge != null && cut > 0) dot(o.fireAge, vals[cut]!, s2, `FIRE ${o.fireAge}岁`, true);
  // 峰值离 FIRE 点太近时不标，否则两个标签会压在一起
  if (o.peakAge != null) {
    const pi = o.peakAge - xMin;
    const farEnough = o.fireAge == null || Math.abs(o.peakAge - o.fireAge) > 3;
    if (pi !== cut && farEnough && pi >= 0 && pi < vals.length) {
      dot(o.peakAge, vals[pi]!, muted, '峰值', true);
    }
  }
  if (o.bankruptAge != null) {
    const bi = o.bankruptAge - xMin;
    if (bi >= 0 && bi < vals.length) dot(o.bankruptAge, vals[bi]!, crit, `钱花光 ${o.bankruptAge}岁`, false);
  }

  const cross = el('line', { y1: f.T, y2: f.T + f.H, stroke: cssv('--rule-strong'),
    'stroke-width': 1, opacity: 0 });
  f.g.appendChild(cross);
  const hot = el('rect', { x: f.L, y: f.T, width: f.W, height: f.H, fill: 'transparent' });
  f.g.appendChild(hot);
  hot.addEventListener('mousemove', ev => {
    const box = f.svg.getBoundingClientRect();
    const cx = (ev.clientX - box.left) / box.width * W;
    let a = Math.round(xMin + (cx - f.L) / f.W * (xMax - xMin));
    a = Math.max(xMin, Math.min(xMax, a));
    const r = rows[a - xMin];
    if (!r) return;
    cross.setAttribute('x1', String(sx(a)));
    cross.setAttribute('x2', String(sx(a)));
    cross.setAttribute('opacity', '1');
    tip.innerHTML =
      `<b>${a} 岁</b>` +
      `<div class="tr"><span>年收入</span><span>${o.fmtY(r.income)}</span></div>` +
      `<div class="tr"><span>年支出</span><span>${o.fmtY(r.spend)}</span></div>` +
      (Math.abs(r.events) > 0.5
        ? `<div class="tr"><span>其他现金流</span><span>${o.fmtY(r.events)}</span></div>` : '') +
      `<div class="tr"><span>投资收益</span><span>${o.fmtY(r.ret)}</span></div>` +
      `<div class="tr"><span>期末${o.showReal ? '（今日购买力）' : ''}</span>` +
      `<span>${o.fmtY(o.showReal ? r.endReal : r.endNominal)}</span></div>`;
    placeTip(tip, box, sx(a), W);
  });
  hot.addEventListener('mouseleave', () => {
    tip.style.opacity = '0';
    cross.setAttribute('opacity', '0');
  });
}

/** 收入模型预设卡片上的迷你曲线。标出峰值点，横轴 20→65 岁。 */
export function incomeSpark(
  host: HTMLElement,
  f: (a: number) => number,
  o: { peakAge: number; currentAge: number; active: boolean }
): void {
  const W = 132, H = 42, pad = 3;
  host.innerHTML = '';
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}` });
  host.appendChild(svg);
  const A0 = 20, A1 = 65;
  const vals: number[] = [];
  for (let a = A0; a <= A1; a++) vals.push(f(a));
  const vMax = Math.max(...vals), vMin = 0;
  const sx = (a: number): number => pad + (a - A0) / (A1 - A0) * (W - pad * 2);
  const sy = (v: number): number => H - pad - (v - vMin) / (vMax - vMin || 1) * (H - pad * 2);

  const stroke = o.active ? cssv('--s1') : cssv('--muted');
  let d = '', area = '';
  vals.forEach((v, i) => {
    const px = sx(A0 + i).toFixed(1), py = sy(v).toFixed(1);
    d += (i ? 'L' : 'M') + px + ' ' + py;
    area += (i ? 'L' : 'M') + px + ' ' + py;
  });
  area += `L${sx(A1).toFixed(1)} ${H - pad}L${sx(A0).toFixed(1)} ${H - pad}Z`;
  svg.appendChild(el('path', { d: area, fill: stroke, 'fill-opacity': o.active ? 0.15 : 0.07 }));
  svg.appendChild(el('path', { d, fill: 'none', stroke, 'stroke-width': 1.6,
    'stroke-linejoin': 'round' }));
  // 峰值点
  svg.appendChild(el('circle', { cx: sx(o.peakAge), cy: sy(f(o.peakAge)), r: 2.6,
    fill: o.active ? cssv('--s2') : cssv('--muted') }));
  // 当前年龄的竖线，让用户看清自己站在曲线的哪一段
  if (o.currentAge > A0 && o.currentAge < A1) {
    svg.appendChild(el('line', { x1: sx(o.currentAge), y1: pad, x2: sx(o.currentAge), y2: H - pad,
      stroke: cssv('--rule-strong'), 'stroke-width': 1, 'stroke-dasharray': '2 2' }));
  }
}

export interface SensPoint { x: number; fireAge: number | null; }

export interface SensOpts {
  points: SensPoint[];
  currentX: number | null;
  fmtX(v: number): string;
  fmtXFull(v: number): string;
}

/** 图 2/3 · 敏感性曲线：横轴某参数，纵轴解出的 FIRE 年龄。
 * 无解区间画成阴影带，当前取值高亮。FIRE 年龄是整数，故用阶梯线而非平滑曲线。 */
export function sensitivity(host: HTMLElement, tip: HTMLElement, o: SensOpts): void {
  const pts = o.points;
  const W = 720, H = 210;
  const f = frame(host, W, H, { l: 56, r: 14, t: 12, b: 26 });
  const okPts = pts.filter(p => p.fireAge != null);
  if (!okPts.length || !pts.length) {
    const t = el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle',
      'font-size': 12, fill: cssv('--muted') });
    t.textContent = '当前参数下没有任何可行的退休年龄';
    f.g.appendChild(t);
    return;
  }
  const xMin = pts[0]!.x, xMax = pts[pts.length - 1]!.x;
  const ys = okPts.map(p => p.fireAge!);
  const yMin = Math.min(...ys) - 1, yMax = Math.max(...ys) + 1;
  const sx = (x: number): number => f.L + (x - xMin) / (xMax - xMin || 1) * f.W;
  const sy = (v: number): number => f.T + f.H - (v - yMin) / (yMax - yMin || 1) * f.H;

  axes({ f, yMin, yMax, xMin, xMax, sx, sy, yInteger: true,
    fmtY: v => Math.round(v) + '岁', fmtX: o.fmtX });

  const crit = cssv('--crit');
  pts.forEach((p, i) => {
    if (p.fireAge != null) return;
    const x0 = sx(p.x), x1 = sx(pts[Math.min(i + 1, pts.length - 1)]!.x);
    f.g.appendChild(el('rect', { x: x0, y: f.T, width: Math.max(1, x1 - x0),
      height: f.H, fill: crit, 'fill-opacity': 0.09 }));
  });

  let d = '', started = false;
  for (const p of pts) {
    if (p.fireAge == null) { started = false; continue; }
    const px = sx(p.x).toFixed(2), py = sy(p.fireAge).toFixed(2);
    if (!started) { d += `M${px} ${py}`; started = true; }
    else { d += `H${px}V${py}`; }
  }
  f.g.appendChild(el('path', { d, fill: 'none', stroke: cssv('--s1'),
    'stroke-width': 2, 'stroke-linejoin': 'round' }));

  if (o.currentX != null) {
    const cxp = sx(o.currentX);
    f.g.appendChild(el('line', { x1: cxp, y1: f.T, x2: cxp, y2: f.T + f.H,
      stroke: cssv('--s2'), 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }));
    const cur = pts.find(p => p.x === o.currentX);
    if (cur?.fireAge != null) {
      f.g.appendChild(el('circle', { cx: cxp, cy: sy(cur.fireAge), r: 5,
        fill: cssv('--s2'), stroke: cssv('--surface'), 'stroke-width': 2 }));
      const lb = el('text', { x: cxp, y: sy(cur.fireAge) - 11, 'text-anchor': 'middle',
        'font-size': 10.5, fill: cssv('--s2'), 'font-weight': 600 });
      lb.textContent = `现在：${cur.fireAge}岁`;
      f.g.appendChild(lb);
    }
  }

  const hot = el('rect', { x: f.L, y: f.T, width: f.W, height: f.H, fill: 'transparent' });
  f.g.appendChild(hot);
  hot.addEventListener('mousemove', ev => {
    const box = f.svg.getBoundingClientRect();
    const cx = (ev.clientX - box.left) / box.width * W;
    const xv = xMin + (cx - f.L) / f.W * (xMax - xMin);
    const best = pts.reduce((a, b) => Math.abs(b.x - xv) < Math.abs(a.x - xv) ? b : a);
    tip.innerHTML = `<b>${o.fmtXFull(best.x)}</b>` +
      `<div class="tr"><span>最早可退休</span><span>` +
      `${best.fireAge != null ? best.fireAge + ' 岁' : '无解'}</span></div>`;
    placeTip(tip, box, sx(best.x), W);
  });
  hot.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
}
