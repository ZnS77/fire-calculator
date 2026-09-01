/** 金额解析与格式化 */

/** 解析用户输入：支持 50w / 500k / 1.2m / 3亿 / 带千分位 */
export function parseAmount(s: string | number): number {
  if (typeof s === 'number') return s;
  if (!s) return 0;
  const t = String(s).trim().toLowerCase().replace(/[,，\s¥￥元]/g, '');
  const m = t.match(/^(-?\d*\.?\d+)\s*(w|万|k|千|m|百万|亿)?$/);
  if (!m || m[1] === undefined) { const n = parseFloat(t); return isNaN(n) ? 0 : n; }
  const v = parseFloat(m[1]);
  switch (m[2]) {
    case 'w': case '万':   return v * 1e4;
    case 'k': case '千':   return v * 1e3;
    case 'm': case '百万': return v * 1e6;
    case '亿':             return v * 1e8;
    default:               return v;
  }
}

/** 紧凑金额：大额自动用万/亿 */
export function cny(v: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (v == null || isNaN(v)) return '—';
  const neg = v < 0, a = Math.abs(v);
  let s: string;
  if (a >= 1e8)      s = (a / 1e8).toFixed(a >= 1e9 ? 1 : 2).replace(/\.?0+$/, '') + '亿';
  else if (a >= 1e4) s = (a / 1e4).toFixed(a >= 1e6 ? 0 : 1).replace(/\.0$/, '') + '万';
  else               s = Math.round(a).toLocaleString('zh-CN');
  return (neg ? '−' : (opts.sign ? '+' : '')) + '¥' + s;
}

/** 完整金额（带千分位），用于需要看清每一位的地方 */
export function cnyFull(v: number | null | undefined): string {
  if (v == null || isNaN(v)) return '—';
  return (v < 0 ? '−' : '') + '¥' + Math.round(Math.abs(v)).toLocaleString('zh-CN');
}

export function pct(v: number | null | undefined, digits = 1): string {
  if (v == null || isNaN(v)) return '—';
  return (v * 100).toFixed(digits) + '%';
}
