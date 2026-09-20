/**
 * SVG card rendering.
 *
 * Everything here is shaped by what GitHub's camo image proxy allows. Its
 * response carries `content-security-policy: default-src 'none'; img-src data:;
 * style-src 'unsafe-inline'`, which means:
 *   - no JavaScript, ever;
 *   - no external fonts or images, so type is system fonts only;
 *   - inline <style> IS allowed, so CSS @keyframes animation works.
 */

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace";

export const THEMES = {
  dark: {
    bg: '#0d1117', border: '#30363d', title: '#e6edf3',
    text: '#7d8590', accent: '#d68a5c', accentSoft: '#8a5a3c', track: '#21262d',
  },
  light: {
    bg: '#ffffff', border: '#d0d7de', title: '#1f2328',
    text: '#59636e', accent: '#bc4c00', accentSoft: '#e5b494', track: '#eaeef2',
  },
  claude: {
    bg: '#1a1614', border: '#3a2f28', title: '#f5f0eb',
    text: '#a89684', accent: '#d97757', accentSoft: '#8a4a33', track: '#2a221d',
  },
};

/** Escape the five XML metacharacters. Usernames reach the document as text. */
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

const fmt = (n) => n.toLocaleString('en-US');

/** Thousands become "12.3k" so the hero number never outgrows its box. */
function compact(n) {
  if (n < 10000) return fmt(n);
  if (n < 1000000) return `${(n / 1000).toFixed(n < 100000 ? 1 : 0)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
}

const MONTH_INITIALS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

/**
 * Monthly history as stacked bars: total commits in the muted track colour,
 * with the co-authored portion filled from the bottom in the accent.
 *
 * Stacking rather than plotting the co-authored count alone keeps the ratio
 * legible month to month — a busy month at 40% and a quiet month at 90% are
 * told apart by the fill, which a single-series chart cannot show.
 *
 * Heights are scaled against the busiest month, so a modest history reads as
 * clearly as a prolific one.
 */
function bars(series, { x, y, width, height, theme, animate }) {
  if (!series.length) return '';
  const peak = Math.max(...series.map((m) => m.total), 1);
  const slot = width / series.length;
  const barW = Math.max(3, Math.min(13, slot * 0.6));

  return series
    .map((m, i) => {
      const bx = x + slot * i + (slot - barW) / 2;
      const totalH = (m.total / peak) * height;
      const coH = (m.coauthored / peak) * height;
      const delay = (i * 0.05).toFixed(2);
      const label = MONTH_INITIALS[Number(m.month.slice(5, 7)) - 1];
      const pct = m.total > 0 ? Math.round((m.coauthored / m.total) * 100) : 0;

      // Final geometry lives in the attributes and animation only supplies a
      // `from`, so a renderer that ignores SMIL — a static rasterizer or a
      // social preview generator — still draws finished bars.
      const grow = (h, yy) =>
        animate
          ? `<animate attributeName="height" from="0" to="${h.toFixed(1)}" dur="0.6s" begin="${delay}s" fill="freeze"/>` +
            `<animate attributeName="y" from="${(y + height).toFixed(1)}" to="${yy.toFixed(1)}" dur="0.6s" begin="${delay}s" fill="freeze"/>`
          : '';

      const track =
        `<rect x="${bx.toFixed(1)}" y="${(y + height - totalH).toFixed(1)}" width="${barW.toFixed(1)}" ` +
        `height="${totalH.toFixed(1)}" rx="2" fill="${theme.track}">` +
        `<title>${esc(m.month)}: ${fmt(m.coauthored)} of ${fmt(m.total)} commits (${pct}%)</title>` +
        `${grow(totalH, y + height - totalH)}</rect>`;

      const filled = coH > 0
        ? `<rect x="${bx.toFixed(1)}" y="${(y + height - coH).toFixed(1)}" width="${barW.toFixed(1)}" ` +
          `height="${coH.toFixed(1)}" rx="2" fill="${theme.accent}" pointer-events="none">` +
          `${grow(coH, y + height - coH)}</rect>`
        : '';

      return (
        track + filled +
        `<text x="${(bx + barW / 2).toFixed(1)}" y="${y + height + 13}" fill="${theme.text}" ` +
        `font-family="${FONT}" font-size="9" text-anchor="middle">${label}</text>`
      );
    })
    .join('');
}

export function renderCard(data, { theme: themeName = 'dark', animate = true, title } = {}) {
  const theme = THEMES[themeName] ?? THEMES.dark;
  const W = 460;
  const H = 190;
  const pct = (data.share * 100).toFixed(data.share >= 0.1 ? 0 : 1);
  const heading = title ?? `Built with ${data.agentLabel}`;

  // A stroked arc drawn as a partial circle: dasharray carries the share, so
  // no path math is needed and the ring animates by dashoffset alone.
  const R = 26;
  const C = 2 * Math.PI * R;
  const ringCx = W - 66;
  const ringCy = 62;

  // Both keyframes animate *from* a hidden state to the element's natural
  // one, and neither sets a `to`. Renderers that drop CSS animation keep the
  // finished appearance instead of a blank card.
  const style = animate
    ? `<style>@keyframes ring{from{stroke-dashoffset:${C.toFixed(1)}}}` +
      `@keyframes fade{from{opacity:0}}` +
      `.ring{animation:ring 1s ease-out}` +
      `.fade{animation:fade .8s ease-out}</style>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(heading)}: ${fmt(data.coauthored)} of ${fmt(data.total)} commits co-authored, ${pct} percent">
<title>${esc(heading)} — ${fmt(data.coauthored)} of ${fmt(data.total)} commits (${pct}%)</title>
${style}
<rect width="${W}" height="${H}" rx="8" fill="${theme.bg}" stroke="${theme.border}"/>

<text x="22" y="32" fill="${theme.title}" font-family="${FONT}" font-size="15" font-weight="600">${esc(heading)}</text>
<text x="22" y="50" fill="${theme.text}" font-family="${FONT}" font-size="11">@${esc(data.user)}${data.visibility === 'public' ? ' · public repos' : ''}</text>

<text x="22" y="92" fill="${theme.accent}" font-family="${MONO}" font-size="32" font-weight="600" class="${animate ? 'fade' : ''}">${compact(data.coauthored)}</text>
<text x="22" y="110" fill="${theme.text}" font-family="${FONT}" font-size="11">co-authored commits</text>
<text x="22" y="126" fill="${theme.text}" font-family="${FONT}" font-size="11">of ${fmt(data.total)} total</text>

<circle cx="${ringCx}" cy="${ringCy}" r="${R}" fill="none" stroke="${theme.track}" stroke-width="7"/>
<circle cx="${ringCx}" cy="${ringCy}" r="${R}" fill="none" stroke="${theme.accent}" stroke-width="7"
  stroke-linecap="round" stroke-dasharray="${(C * data.share).toFixed(1)} ${C.toFixed(1)}"
  transform="rotate(-90 ${ringCx} ${ringCy})"${animate ? ` class="ring" stroke-dashoffset="0"` : ''}/>
<text x="${ringCx}" y="${ringCy + 5}" fill="${theme.title}" font-family="${MONO}" font-size="15" font-weight="600" text-anchor="middle">${pct}%</text>

<line x1="22" y1="140" x2="${W - 22}" y2="140" stroke="${theme.border}"/>
<text x="${W - 22}" y="153" fill="${theme.text}" font-family="${FONT}" font-size="9" text-anchor="end">last ${data.series.length} months</text>
${bars(data.series, { x: 22, y: 150, width: W - 120, height: 24, theme, animate })}
</svg>`;
}
