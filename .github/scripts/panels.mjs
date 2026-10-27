// Renders the four pixel-world profile panels into metrics/:
//   profile.svg   player card       (account, XP from contributions, equipped tools)
//   calendar.svg  island            (last 26 weeks of contributions as building plots)
//   languages.svg inventory         (language share across accessible repositories)
//   habits.svg    skyline           (commits per hour of day)
// Counts include private and organisation repositories the token's owner can access.
// Usage: GITHUB_TOKEN=... node .github/scripts/panels.mjs [output dir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TOKEN = process.env.GITHUB_TOKEN;
const OUT_DIR = process.argv[2] ?? 'metrics';
const UTC_OFFSET_HOURS = 3; // Europe/Istanbul, no DST
const SINCE = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
const DISPLAY_NAME = 'Kubilay Can';
const CLASS = 'Frontend Engineer';
const EQUIPPED = [['React', '#61dafb'], ['TypeScript', '#3178c6'], ['three.js', '#e8ecf5'], ['Unity', '#9aa4b8'], ['Node.js', '#5fa04e'], ['Blender', '#f5792a']];
// Unity serialises assets in files GitHub detects as these, so they would drown out real code
const IGNORED_LANGUAGES = new Set(['ShaderLab', 'Mathematica', 'Wolfram Language']);

if (!TOKEN) throw new Error('GITHUB_TOKEN is not set');

async function gql(query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

/* ------------------------------------------------------------------ data */

async function collect() {
  const { viewer } = await gql(`{ viewer { id login name company location createdAt followers { totalCount }
    contributionsCollection { contributionCalendar { totalContributions
      weeks { contributionDays { date weekday contributionCount contributionLevel } } } } } }`);

  const repos = [];
  let after = null;
  do {
    const data = await gql(
      `query($after: String) { viewer { repositories(first: 100, after: $after, isFork: false,
        affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER],
        ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]) {
          pageInfo { hasNextPage endCursor }
          nodes { owner { login } name stargazerCount
            languages(first: 20) { edges { size node { name color } } } }
      } } }`,
      { after },
    );
    const page = data.viewer.repositories;
    repos.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);

  const dates = [];
  for (const { owner, name } of repos) {
    let cursor = null;
    do {
      const data = await gql(
        `query($owner: String!, $name: String!, $since: GitTimestamp!, $author: ID!, $cursor: String) {
          repository(owner: $owner, name: $name) { defaultBranchRef { target { ... on Commit {
            history(first: 100, after: $cursor, since: $since, author: {id: $author}) {
              pageInfo { hasNextPage endCursor } nodes { authoredDate } } } } } }
        }`,
        { owner: owner.login, name, since: SINCE, author: viewer.id, cursor },
      );
      const history = data.repository?.defaultBranchRef?.target?.history;
      if (!history) break;
      dates.push(...history.nodes.map((n) => new Date(n.authoredDate)));
      cursor = history.pageInfo.hasNextPage ? history.pageInfo.endCursor : null;
    } while (cursor);
  }

  const languages = new Map();
  for (const repo of repos)
    for (const { size, node } of repo.languages.edges) {
      if (IGNORED_LANGUAGES.has(node.name)) continue;
      const entry = languages.get(node.name) ?? { name: node.name, color: node.color ?? '#8b97b8', size: 0 };
      entry.size += size;
      languages.set(node.name, entry);
    }

  const calendar = viewer.contributionsCollection.contributionCalendar;
  console.log(`panels: ${dates.length} commits, ${calendar.totalContributions} contributions, ${repos.length} repositories`);
  return {
    viewer,
    calendar,
    dates,
    repoCount: repos.length,
    stars: repos.filter((r) => r.owner.login === viewer.login).reduce((s, r) => s + r.stargazerCount, 0),
    languages: [...languages.values()].sort((a, b) => b.size - a.size),
  };
}

/* ------------------------------------------------------------ shared ui */

const FONT_CSS = `text{font-family:ui-monospace,'SF Mono','Cascadia Mono',Consolas,'Courier New',monospace;font-weight:700}
.title{font-size:10px;fill:#e8ecf5;letter-spacing:1.5px}.sub{font-size:9px;fill:#8b97b8;letter-spacing:1px}
.t{font-size:9px;fill:#8b97b8}.f{font-size:9.5px;fill:#c3cbe0;letter-spacing:.5px}.fa{fill:#ff6a2b}`;

// Pixel window chrome shared by every panel: notched border, title tab with an orange marker
function frame(W, H, title) {
  return `<path d="M4 0H${W - 4}V2H${W - 2}V4H${W}V${H - 4}H${W - 2}V${H - 2}H${W - 4}V${H}H4V${H - 2}H2V${H - 4}H0V4H2V2H4Z" fill="#2c3550"/>
<path d="M6 2H${W - 6}V4H${W - 4}V${H - 4}H${W - 6}V${H - 2}H6V${H - 4}H4V4H6Z" fill="#141a2b"/>
<rect x="6" y="5" width="${8 + title.length * 7.6}" height="15" fill="#2c3550"/>
<rect x="9" y="10" width="4" height="4" fill="#ff6a2b"/>
<text x="18" y="16" class="title">${title}</text>`;
}

const svgOpen = (W, H, label, css) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">
<style>
${FONT_CSS}
${css}
</style>`;

// Draws a bitmap (array of strings) as crisp rects; palette maps characters to fills
function bitmap(rows, palette, x0 = 0, y0 = 0, p = 1) {
  let out = '';
  rows.forEach((row, y) => [...row].forEach((c, x) => {
    if (palette[c]) out += `<rect x="${x0 + x * p}" y="${y0 + y * p}" width="${p}" height="${p}" fill="${palette[c]}"/>`;
  }));
  return out;
}

const GEM = ['...x...', '..xhx..', '.xhxxx.', 'xxxxxxx', '.xxxxd.', '..xxd..', '...d...'];
const gem = (color, x, y, p) => bitmap(GEM, { x: color, h: '#ffffff', d: '#00000055' }, x, y, p);
const pad2 = (n) => String(n).padStart(2, '0');

/* --------------------------------------------------------- island panel */

// The last 26 weeks as an island of building plots, drawn in oblique projection.
// Each day's contribution level is a stage of building a UI: sketch, lo-fi, built, launched.
function renderCalendar({ calendar }) {
  const W = 480, H = 210;
  const weeks = calendar.weeks.slice(-26);
  const CW = 13, DX = 6, DY = 9; // cell width, per-row depth offset
  const OX = 50, OY = 160; // front-left corner of the grid
  const LEVEL = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };
  const HEIGHT = [0, 8, 9, 14, 22];

  const pt = (x, y) => `${x},${y}`;
  const poly = (pts, fill, extra = '') => `<polygon points="${pts.map(([x, y]) => pt(x, y)).join(' ')}" fill="${fill}"${extra}/>`;
  const base = (c, r) => [OX + c * CW + r * DX, OY - r * DY];

  // Sand rim and cliff under the grid
  const cols = weeks.length;
  const fl = [OX - 7, OY + 4], fr = [OX + cols * CW + 7, OY + 4];
  const br = [OX + cols * CW + 7 * DX + 7, OY - 7 * DY - 4], bl = [OX + 7 * DX - 7, OY - 7 * DY - 4];
  let art = poly([[fl[0], fl[1]], [fr[0], fr[1]], [fr[0], fr[1] + 9], [fl[0], fl[1] + 9]], '#6b4a2b')
    + poly([[fr[0], fr[1]], [br[0], br[1]], [br[0], br[1] + 9], [fr[0], fr[1] + 9]], '#5a3d22')
    + poly([fl, fr, br, bl], '#e6c98a')
    + poly([[fl[0] + 4, fl[1] - 2], [fr[0] - 4, fr[1] - 2], [br[0] - 4, br[1] + 2], [bl[0] + 4, bl[1] + 2]], '#d9b877');

  const block = (c, r, h, top, front, side, extra = '') => {
    const [x, y] = base(c, r);
    return poly([[x, y - h], [x + CW, y - h], [x + CW + DX, y - DY - h], [x + DX, y - DY - h]], top)
      + `<rect x="${x}" y="${y - h}" width="${CW}" height="${h}" fill="${front}"/>`
      + poly([[x + CW, y], [x + CW + DX, y - DY], [x + CW + DX, y - DY - h], [x + CW, y - h]], side) + extra;
  };

  const today = weeks.at(-1).contributionDays.at(-1).date;
  let total = 0;
  for (let r = 6; r >= 0; r--) {
    weeks.forEach((week, c) => {
      const day = week.contributionDays.find((d) => d.weekday === r);
      if (!day) return;
      total += day.contributionCount;
      const lvl = LEVEL[day.contributionLevel] ?? 0;
      const [x, y] = base(c, r);
      // grass tile
      art += poly([[x, y], [x + CW, y], [x + CW + DX, y - DY], [x + DX, y - DY]], (c + r) % 2 ? '#4caf50' : '#46a24a');
      if (lvl === 1) {
        // sketch: dashed wireframe cube
        const h = HEIGHT[1], s = ' fill="none" stroke="#e8f0ff" stroke-width="1" stroke-dasharray="2 2"';
        art += `<polyline points="${[[x, y], [x, y - h], [x + CW, y - h], [x + CW, y], [x, y]].map(([a, b]) => pt(a, b)).join(' ')}"${s}/>`
          + `<polyline points="${[[x, y - h], [x + DX, y - DY - h], [x + CW + DX, y - DY - h], [x + CW, y - h]].map(([a, b]) => pt(a, b)).join(' ')}"${s}/>`
          + `<polyline points="${[[x + CW + DX, y - DY - h], [x + CW + DX, y - DY], [x + CW, y]].map(([a, b]) => pt(a, b)).join(' ')}"${s}/>`;
      } else if (lvl === 2) {
        art += block(c, r, HEIGHT[2], '#c4cad8', '#9098ad', '#747c93');
      } else if (lvl === 3) {
        art += block(c, r, HEIGHT[3], '#9be9a8', '#40c463', '#2f9a4a');
      } else if (lvl === 4) {
        const h = HEIGHT[4];
        let windows = '';
        for (let wy = y - h + 4; wy < y - 2; wy += 4)
          for (const wx of [x + 3, x + 8]) windows += `<rect x="${wx}" y="${wy}" width="2" height="2" fill="#ffd36b"/>`;
        art += block(c, r, h, '#2c3652', '#3d4a6b', '#28304a', windows)
          + poly([[x, y - h], [x + CW, y - h], [x + CW + DX, y - DY - h], [x + DX, y - DY - h]], '#ff6a2b', ' opacity=".9"');
      }
      if (day.date === today) {
        const fx = x + DX + 3, fy = y - DY - HEIGHT[lvl] - 1;
        art += `<rect x="${fx}" y="${fy - 16}" width="1" height="16" fill="#e8ecf5"/><polygon points="${pt(fx + 1, fy - 16)} ${pt(fx + 9, fy - 13)} ${pt(fx + 1, fy - 10)}" fill="#ff6a2b"/>`;
      }
    });
  }

  // Month labels along the front edge
  let months = '', last = '', lastX = -Infinity;
  weeks.forEach((week, c) => {
    const m = new Date(week.contributionDays[0].date).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase();
    const x = OX + c * CW;
    if (m !== last && c < cols - 1 && x - lastX >= 32) {
      months += `<text x="${x}" y="${OY + 23}" class="t">${m}</text>`;
      lastX = x;
    }
    last = m;
  });

  // Streaks over the whole year calendar
  const days = calendar.weeks.flatMap((w) => w.contributionDays);
  let best = 0, run = 0;
  for (const d of days) { run = d.contributionCount ? run + 1 : 0; best = Math.max(best, run); }
  let current = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].contributionCount) current++;
    else if (i !== days.length - 1) break; // a quiet today doesn't break the streak yet
  }

  // Water shimmer: short light dashes that drift and fade
  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let shimmer = '';
  for (let i = 0; i < 46; i++) {
    const x = Math.floor(rand() * 470), y = 62 + Math.floor(rand() * 128);
    shimmer += `<rect x="${x}" y="${y}" width="${4 + Math.floor(rand() * 6)}" height="1" fill="#bfe3ff" style="animation-delay:${(-rand() * 4).toFixed(2)}s"/>`;
  }

  // Legend: the four build stages
  const legend = [
    ['SKETCH', `<rect x="0" y="0" width="7" height="7" fill="none" stroke="#e8f0ff" stroke-dasharray="2 2"/>`],
    ['LO-FI', `<rect x="0" y="0" width="7" height="7" fill="#9098ad"/>`],
    ['BUILT', `<rect x="0" y="0" width="7" height="7" fill="#40c463"/>`],
    ['LAUNCHED', `<rect x="0" y="0" width="7" height="7" fill="#3d4a6b"/><rect x="0" y="0" width="7" height="2" fill="#ff6a2b"/>`],
  ];
  let lx = 472, legendSvg = '';
  for (const [name, icon] of [...legend].reverse()) {
    const w = name.length * 6.2;
    lx -= w;
    legendSvg += `<text x="${lx}" y="16" class="sub">${name}</text><g transform="translate(${lx - 11} 9)">${icon}</g>`;
    lx -= 22;
  }

  return `${svgOpen(W, H, `Contributions island: ${total} contributions over the last 26 weeks, current streak ${current} days`, `.sh rect{animation:sh 4s linear infinite}
@keyframes sh{0%{transform:translateX(0);opacity:0}50%{opacity:.55}100%{transform:translateX(14px);opacity:0}}
@media (prefers-reduced-motion:reduce){.sh rect{animation:none;opacity:.3}}`)}
<defs>
  <linearGradient id="isky" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#141a45"/><stop offset=".55" stop-color="#5e3a70"/><stop offset="1" stop-color="#e9955a"/></linearGradient>
  <linearGradient id="sea" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#1f5d95"/><stop offset="1" stop-color="#123a66"/></linearGradient>
  <clipPath id="iscene"><rect x="8" y="24" width="464" height="162"/></clipPath>
</defs>
${frame(W, H, 'CONTRIBUTIONS')}
${legendSvg}
<g clip-path="url(#iscene)">
  <rect x="8" y="24" width="464" height="38" fill="url(#isky)"/>
  <rect x="8" y="62" width="464" height="124" fill="url(#sea)"/>
  <rect x="8" y="62" width="464" height="1" fill="#ffd9a8" opacity=".6"/>
  <g class="sh">${shimmer}</g>
  ${art}
  ${months}
</g>
<rect x="7" y="23" width="466" height="164" fill="none" stroke="#0a0d16" stroke-width="2"/>
<text x="12" y="202" class="f">${total.toLocaleString('en-US')} CONTRIBUTIONS · LAST 26 WEEKS</text>
<text x="468" y="202" class="f" text-anchor="end">STREAK <tspan class="fa">${current}D</tspan> · BEST ${best}D</text>
</svg>
`;
}

/* --------------------------------------------------------- player panel */

const KC = [
  'x...x.0.xxx.',
  'x..x..0x...x',
  'x.x...0x....',
  'xx....0x....',
  'x.x...0x....',
  'x..x..0x...x',
  'x...x.0.xxx.',
];

function renderProfile({ viewer, calendar, repoCount, stars }) {
  const W = 480, H = 210;
  const joined = new Date(viewer.createdAt);
  const level = Math.floor((Date.now() - joined.getTime()) / (365.25 * 24 * 3600 * 1000));
  const xp = calendar.totalContributions;
  const xpMax = Math.max(100, Math.ceil((xp + 1) / 250) * 250);
  const name = (viewer.name || DISPLAY_NAME).toUpperCase();

  // Emblem: KC monogram with a drop shadow in a 72px slot
  const P = 4, ex = 14, ey = 30;
  const mono = KC.map((row) => row.replace(/0/g, '.'));
  const emblem = `<rect x="${ex}" y="${ey}" width="72" height="72" fill="#0b0d14"/><rect x="${ex + 2}" y="${ey + 2}" width="68" height="68" fill="#1e2440"/>`
    + `<rect x="${ex + 2}" y="${ey + 2}" width="68" height="3" fill="#2c3550"/>`
    + bitmap(mono, { x: '#0b0d14' }, ex + 13, ey + 23, P)
    + bitmap(mono, { x: '#ff6a2b' }, ex + 12, ey + 21, P);

  const info = [['CLASS', CLASS], ['GUILD', viewer.company || '—'], ['BASE', viewer.location || '—']]
    .map(([k, v], i) => `<text x="100" y="${70 + i * 16}" class="t">${k}</text><text x="150" y="${70 + i * 16}" class="v">${v}</text>`).join('');

  const statRows = [['REPOS', repoCount], ['STARS', stars], ['FOLLOWERS', viewer.followers.totalCount]]
    .map(([k, v], i) => `<text x="468" y="${54 + i * 16}" class="t" text-anchor="end">${k}</text><text x="408" y="${54 + i * 16}" class="n" text-anchor="end">${v}</text>`).join('');

  // XP bar: 46 segments
  const SEG = 46, sw = 6, sg = 2, bx0 = 100, by = 124;
  const filled = Math.round((xp / xpMax) * SEG);
  let bar = `<rect x="${bx0 - 2}" y="${by - 2}" width="${SEG * (sw + sg) + 2}" height="14" fill="#0b0d14"/>`;
  for (let i = 0; i < SEG; i++) bar += `<rect x="${bx0 + i * (sw + sg)}" y="${by}" width="${sw}" height="10" fill="${i < filled ? (i % 2 ? '#40c463' : '#4cd06f') : '#232a42'}"/>`;
  bar += `<rect class="xs" x="${bx0}" y="${by}" width="18" height="10" fill="#ffffff" opacity=".35"/>`;
  const shimmerEnd = filled * (sw + sg) - 18;

  // Equipped tools as gem slots
  const slots = EQUIPPED.map(([label, color], i) => {
    const x = 100 + i * 58, y = 156;
    return `<rect x="${x}" y="${y}" width="52" height="42" fill="#0b0d14"/><rect x="${x + 2}" y="${y + 2}" width="48" height="38" fill="#1e2440"/>`
      + gem(color, x + 16, y + 6, 3) + `<text x="${x + 26}" y="${y + 36}" class="s" text-anchor="middle">${label}</text>`;
  }).join('');

  return `${svgOpen(W, H, `Player card: ${name}, ${CLASS}, level ${level}, ${xp} contributions this year`, `.v{font-size:11px;fill:#e8ecf5}.n{font-size:12px;fill:#ff6a2b}.s{font-size:8px;fill:#c3cbe0}
.big{font-size:20px;fill:#ffffff;letter-spacing:1px}.lv{font-size:10px;fill:#0b0d14}
.xs{animation:xs 3.5s ease-in-out infinite}
@keyframes xs{0%{transform:translateX(0);opacity:0}15%{opacity:.35}85%{opacity:.35}100%{transform:translateX(${Math.max(0, shimmerEnd)}px);opacity:0}}
@media (prefers-reduced-motion:reduce){.xs{animation:none;opacity:0}}`)}
${frame(W, H, 'PLAYER')}
<text x="472" y="16" class="sub" text-anchor="end">JOINED ${joined.getUTCFullYear()}</text>
${emblem}
<rect x="14" y="108" width="72" height="16" fill="#ff6a2b"/>
<text x="50" y="120" class="lv" text-anchor="middle">LV ${level}</text>
<text x="100" y="48" class="big">${name}</text>
${info}
${statRows}
<text x="100" y="117" class="t">XP</text>
<text x="${bx0 + SEG * (sw + sg) - 2}" y="117" class="t" text-anchor="end"><tspan class="fa">${xp}</tspan> / ${xpMax} · CONTRIBUTIONS THIS YEAR</text>
${bar}
<text x="100" y="150" class="t">EQUIPPED</text>
${slots}
<text x="50" y="150" class="t" text-anchor="middle">GITHUB</text>
<text x="50" y="164" class="s" text-anchor="middle">@${viewer.login}</text>
</svg>
`;
}

/* ------------------------------------------------------ inventory panel */

function renderLanguages({ languages, repoCount }) {
  const W = 480, H = 166;
  const total = languages.reduce((s, l) => s + l.size, 0) || 1;
  const top = languages.slice(0, 8);
  const RARITY = (i) => (i === 0 ? ['LEGENDARY', '#ff6a2b'] : i < 3 ? ['EPIC', '#a371f7'] : i < 5 ? ['RARE', '#3fa9f5'] : ['COMMON', '#6b7590']);

  const sw = 110, sh = 44, gx = 6, gy = 6, x0 = 12, y0 = 28;
  const slots = top.map((l, i) => {
    const x = x0 + (i % 4) * (sw + gx), y = y0 + Math.floor(i / 4) * (sh + gy);
    const [rarity, rc] = RARITY(i);
    const pct = (l.size / total) * 100;
    return `<rect x="${x}" y="${y}" width="${sw}" height="${sh}" fill="${rc}"/>`
      + `<rect x="${x + 2}" y="${y + 2}" width="${sw - 4}" height="${sh - 4}" fill="${i === 0 ? '#262c4a' : '#1b2236'}"/>`
      + `<rect x="${x + 6}" y="${y + 7}" width="30" height="30" fill="#0f1322"/>`
      + gem(l.color, x + 7.5, y + 8.5, 3.85)
      + `<text x="${x + 42}" y="${y + 17}" class="v">${l.name.length > 10 ? l.name.slice(0, 9) + '.' : l.name}</text>`
      + `<text x="${x + 42}" y="${y + 29}" class="p">${pct < 1 ? pct.toFixed(1) : Math.round(pct)}%</text>`
      + `<text x="${x + 42}" y="${y + 38}" class="r" fill="${rc}">${rarity}</text>`;
  }).join('');

  // Capacity bar: every language's share, segmented
  let bx = 12, cap = '';
  const width = 456;
  for (const l of languages) {
    const w = (l.size / total) * width;
    if (w < 0.5) continue;
    cap += `<rect x="${bx.toFixed(1)}" y="132" width="${Math.max(0.5, w - 1).toFixed(1)}" height="8" fill="${l.color}"/>`;
    bx += w;
  }

  return `${svgOpen(W, H, `Inventory: most used languages, led by ${top[0]?.name}`, `.v{font-size:11px;fill:#e8ecf5}.p{font-size:10px;fill:#c3cbe0}.r{font-size:7.5px;letter-spacing:1px}`)}
${frame(W, H, 'INVENTORY')}
<text x="472" y="16" class="sub" text-anchor="end">LANGUAGES BY CODE SIZE</text>
<g shape-rendering="crispEdges">${slots}</g>
<rect x="10" y="130" width="460" height="12" fill="#0b0d14"/>
${cap}
<text x="12" y="158" class="f">${languages.length} LANGUAGES · ${repoCount} REPOS</text>
<text x="468" y="158" class="f" text-anchor="end">TOP <tspan class="fa">${(top[0]?.name ?? '').toUpperCase()}</tspan></text>
</svg>
`;
}

/* -------------------------------------------------------- skyline panel */

// Pixel-art skyline: one building per hour of day, height = commits in that hour.
// The sky runs from night to day to night across the hours; a looping cursor "hovers" the busiest hour.
function renderHabits(dates) {
  const hours = Array(24).fill(0);
  const days = Array(7).fill(0); // Monday first
  for (const d of dates) {
    const local = new Date(d.getTime() + UTC_OFFSET_HOURS * 3600 * 1000);
    hours[local.getUTCHours()]++;
    days[(local.getUTCDay() + 6) % 7]++;
  }

  const W = 480, H = 166;
  const P = 2; // one art pixel = 2 svg units
  const SX = 8, SY = 24; // scene origin
  const SW = 232, SH = 53; // scene size in art pixels (464 x 106)
  const GROUND = 48; // art-pixel row where buildings stand
  const MAX_H = 38, MIN_H = 3;
  const bx = (i) => 9 + i * 9; // building left edge, 7 art pixels wide with 2 gap
  const isNight = (h) => h < 6 || h >= 20;

  // Deterministic pseudo-random so the art doesn't change between runs with the same data
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  const max = Math.max(1, ...hours);
  const peak = hours.indexOf(max);
  const px = [];
  const r = (x, y, w, h, fill, extra = '') => px.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${extra}/>`);

  // Stars over the night hours
  for (let i = 0; i < 70; i++) {
    const x = Math.floor(rand() * SW), y = Math.floor(rand() * 30);
    const h = Math.floor((x - 9) / 9);
    if (isNight(Math.max(0, Math.min(23, h)))) r(x, y, 1, 1, '#ffffff', ` opacity="${(0.35 + rand() * 0.6).toFixed(2)}"`);
  }
  // Moon around 02:00, sun around 12:00
  const moonX = bx(2) + 1, sunX = bx(12) + 1;
  [[1, 0, 3], [0, 1, 5], [0, 2, 5], [0, 3, 5], [1, 4, 3]].forEach(([dx, dy, w]) => r(moonX + dx, 6 + dy, w, 1, '#f4f1dc'));
  [[2, 1, 2], [1, 2, 3]].forEach(([dx, dy, w]) => r(moonX + dx, 6 + dy, w, 1, '#c9c5a8'));
  [[2, 0, 5], [1, 1, 7], [0, 2, 9], [0, 3, 9], [0, 4, 9], [1, 5, 7], [2, 6, 5]].forEach(([dx, dy, w]) => r(sunX + dx, 3 + dy, w, 1, '#ffe08a'));
  [[3, 1, 3], [2, 2, 2]].forEach(([dx, dy, w]) => r(sunX + dx, 3 + dy, w, 1, '#fff4c4'));
  // Two clouds in the daytime sky
  for (const [cx, cy] of [[bx(9), 9], [bx(15) - 3, 5]]) {
    r(cx + 2, cy, 6, 1, '#ffffff', ' opacity=".9"'); r(cx, cy + 1, 11, 2, '#ffffff', ' opacity=".9"'); r(cx + 1, cy + 3, 9, 1, '#e3f1fb', ' opacity=".9"');
  }
  // Distant hills
  for (let x = 0; x < SW; x += 2) {
    const h = Math.round(7 + Math.sin(x / 13) * 3 + Math.sin(x / 5.3) * 1.5);
    r(x, GROUND - h, 2, h, '#000000', ' opacity=".18"');
  }

  // Buildings
  hours.forEach((v, i) => {
    const h = v ? Math.round(MIN_H + (MAX_H - MIN_H) * (v / max)) : 2;
    const x = bx(i), top = GROUND - h, night = isNight(i);
    if (!v) { r(x, top, 7, h, night ? '#262c47' : '#4a5677'); return; }
    r(x, top, 7, h, night ? '#1e2440' : '#3d4a6b');
    r(x, top, 1, h, night ? '#2e3760' : '#5a6a92'); // lit edge
    r(x, top, 7, 1, night ? '#141930' : '#2c3652'); // roof
    const lit = v / max;
    for (let y = top + 2; y < GROUND - 1; y += 2)
      for (const cx of [x + 2, x + 4])
        r(cx, y, 1, 1, rand() < 0.25 + lit * 0.7 ? (night ? '#ffd36b' : '#d8efff') : (night ? '#2a3152' : '#2f3a57'));
  });
  // Ground: grass row, then dirt
  r(0, GROUND, SW, 1, '#4caf50'); r(0, GROUND + 1, SW, 1, '#3b8a3e'); r(0, GROUND + 2, SW, SH - GROUND - 2, '#6b4a2b');
  for (let x = 1; x < SW; x += 6) r(x, GROUND + 3 + (x % 3), 2, 1, '#5a3d22');

  // Peak building hover state (part of the cursor loop)
  const pTop = GROUND - Math.round(MIN_H + (MAX_H - MIN_H));
  const hover = `<g class="hv"><rect x="${bx(peak) - 1}" y="${pTop - 1}" width="9" height="${GROUND - pTop + 1}" fill="none" stroke="#ff6a2b" stroke-width="1"/><rect x="${bx(peak)}" y="${pTop}" width="7" height="1" fill="#ff6a2b"/></g>`;

  // Cursor, drawn in art pixels: 1 = outline, 2 = fill
  const CURSOR = ['1', '11', '121', '1221', '12221', '122221', '1222221', '12222221', '1222211', '121121', '11 121', '    121', '     11'];
  let cursor = '';
  CURSOR.forEach((row, y) => [...row].forEach((c, x) => {
    if (c !== ' ') cursor += `<rect x="${x}" y="${y}" width="1" height="1" fill="${c === '1' ? '#0b0d14' : '#ffffff'}"/>`;
  }));

  // Positions in svg units
  const tipX = SX + (bx(peak) + 3.5) * P, tipY = SY + pTop * P + 4;
  const label = `${String(peak).padStart(2, '0')}:00 · ${max} commits`;
  const tw = label.length * 6.6 + 16, th = 20;
  const left = SX + (bx(peak) - 1) * P - 8 - tw;
  const tx = left >= 12 ? left : SX + (bx(peak) + 8) * P + 8;
  const ty = Math.max(SY + 2, tipY - 6);

  const DAY = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const peakDay = DAY[days.indexOf(Math.max(...days))];
  const ticks = [0, 6, 12, 18, 23].map((h) => `<text x="${SX + (bx(h) + 3.5) * P}" y="142" class="t" text-anchor="middle">${String(h).padStart(2, '0')}</text>`).join('');

  const skyStops = [[0, '#0b1030'], [4.5, '#151b47'], [6, '#5e3a70'], [7.2, '#e9955a'], [9, '#86c4ec'], [15, '#79bde8'], [17.8, '#f0a05a'], [19.3, '#76406f'], [21, '#1b1d4a'], [24, '#0b1030']]
    .map(([h, c]) => `<stop offset="${(SX + (9 + h * 9) * P - SX) / (SW * P)}" stop-color="${c}"/>`).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Coding habits: a pixel skyline with one building per hour of the day, tallest at ${label}">
<style>
text{font-family:ui-monospace,'SF Mono','Cascadia Mono',Consolas,'Courier New',monospace;font-weight:700}
.title{font-size:10px;fill:#e8ecf5;letter-spacing:1.5px}.sub{font-size:9px;fill:#8b97b8;letter-spacing:1px}
.t{font-size:9px;fill:#8b97b8}.f{font-size:9.5px;fill:#c3cbe0;letter-spacing:.5px}.fa{fill:#ff6a2b}
.tip{font-size:10px;fill:#ffffff}
@keyframes cur{0%{transform:translate(150px,70px);opacity:0}8%{opacity:1}28%,78%{transform:translate(0,0);opacity:1}90%,100%{transform:translate(60px,50px);opacity:0}}
@keyframes hov{0%,30%{opacity:0}34%,76%{opacity:1}82%,100%{opacity:0}}
.cur{animation:cur 7s cubic-bezier(.45,0,.2,1) infinite}.hv,.tp{animation:hov 7s infinite}
@media (prefers-reduced-motion:reduce){.cur,.hv,.tp{animation:none}}
</style>
<defs>
  <linearGradient id="sky" gradientUnits="userSpaceOnUse" x1="${SX}" x2="${SX + SW * P}" y1="0" y2="0">${skyStops}</linearGradient>
  <linearGradient id="shade" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity=".18"/><stop offset=".7" stop-color="#000" stop-opacity="0"/></linearGradient>
  <clipPath id="scene"><rect x="${SX}" y="${SY}" width="${SW * P}" height="${SH * P}"/></clipPath>
</defs>
<path d="M4 0H476V2H478V4H480V162H478V164H476V166H4V164H2V162H0V4H2V2H4Z" fill="#2c3550"/>
<path d="M6 2H474V4H476V162H474V164H6V162H4V4H6Z" fill="#141a2b"/>
<rect x="6" y="5" width="${8 + 'CODING HABITS'.length * 7.6}" height="15" fill="#2c3550"/>
<rect x="9" y="10" width="4" height="4" fill="#ff6a2b"/>
<text x="18" y="16" class="title">CODING HABITS</text>
<text x="472" y="16" class="sub" text-anchor="end">COMMITS BY HOUR · ISTANBUL TIME</text>
<g clip-path="url(#scene)">
  <rect x="${SX}" y="${SY}" width="${SW * P}" height="${SH * P}" fill="url(#sky)"/>
  <rect x="${SX}" y="${SY}" width="${SW * P}" height="${SH * P}" fill="url(#shade)"/>
  <g transform="translate(${SX} ${SY}) scale(${P})" shape-rendering="crispEdges">${px.join('')}${hover}</g>
</g>
<rect x="${SX - 1}" y="${SY - 1}" width="${SW * P + 2}" height="${SH * P + 2}" fill="none" stroke="#0a0d16" stroke-width="2"/>
${ticks}
<text x="12" y="158" class="f">${dates.length.toLocaleString('en-US')} COMMITS · LAST 12 MONTHS</text>
<text x="468" y="158" class="f" text-anchor="end">BUSIEST ON <tspan class="fa">${peakDay.toUpperCase()}S</tspan></text>
<g class="tp" shape-rendering="crispEdges">
  <rect x="${tx}" y="${ty}" width="${tw}" height="${th}" fill="#0b0d14"/>
  <rect x="${tx + 2}" y="${ty + 2}" width="${tw - 4}" height="${th - 4}" fill="#1e2440"/>
  <rect x="${tx + 2}" y="${ty + 2}" width="3" height="${th - 4}" fill="#ff6a2b"/>
  <text x="${tx + 11}" y="${ty + 14}" class="tip">${label}</text>
</g>
<g transform="translate(${tipX} ${tipY})"><g class="cur"><g transform="scale(${P})" shape-rendering="crispEdges">${cursor}</g></g></g>
</svg>
`;
}

/* ------------------------------------------------------------------ main */

const data = await collect();
mkdirSync(OUT_DIR, { recursive: true });
const panels = {
  profile: renderProfile(data),
  calendar: renderCalendar(data),
  languages: renderLanguages(data),
  habits: renderHabits(data.dates),
};
for (const [name, svg] of Object.entries(panels)) {
  writeFileSync(join(OUT_DIR, `${name}.svg`), svg);
  console.log(`panels: wrote ${join(OUT_DIR, name)}.svg (${(svg.length / 1024).toFixed(1)} KB)`);
}
