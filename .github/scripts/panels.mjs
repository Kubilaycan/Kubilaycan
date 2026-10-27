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
  rows.forEach((row, y) => {
    const cells = [...row];
    // Merge runs of the same colour into one rect to keep files small
    for (let x = 0; x < cells.length;) {
      const c = cells[x];
      let n = 1;
      while (cells[x + n] === c) n++;
      if (palette[c]) out += `<rect x="${+(x0 + x * p).toFixed(2)}" y="${+(y0 + y * p).toFixed(2)}" width="${+(n * p).toFixed(2)}" height="${p}" fill="${palette[c]}"/>`;
      x += n;
    }
  });
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
  const OX = 50, OY = 156; // front-left corner of the grid
  const LEVEL = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };
  const HEIGHT = [0, 10, 12, 16, 24];

  const pt = (x, y) => `${x},${y}`;
  const poly = (pts, fill, extra = '') => `<polygon points="${pts.map(([x, y]) => pt(x, y)).join(' ')}" fill="${fill}"${extra}/>`;
  // Grid point in oblique projection; fractional c/r let the rim follow the grid's own slant
  const base = (c, r) => [OX + c * CW + r * DX, OY - r * DY];

  // Sand rim and cliff, built from the same axes as the tiles so every edge is parallel
  const cols = weeks.length;
  const rim = (m) => [base(-m, -m), base(cols + m, -m), base(cols + m, 7 + m), base(-m, 7 + m)];
  const [A, B, C] = rim(0.7);
  const down = ([x, y], d) => [x, y + d];
  let art = poly([A, B, down(B, 9), down(A, 9)], '#6b4a2b')
    + poly([B, C, down(C, 9), down(B, 9)], '#5a3d22')
    + poly(rim(0.7), '#e6c98a')
    + poly(rim(0.3), '#d9b877');

  // A box standing on cell (c, r): top face, front face, right side face
  const faces = (x, y, h) => ({
    top: [[x, y - h], [x + CW, y - h], [x + CW + DX, y - DY - h], [x + DX, y - DY - h]],
    side: [[x + CW, y], [x + CW + DX, y - DY], [x + CW + DX, y - DY - h], [x + CW, y - h]],
  });
  const windowsOn = (x, y, h, fill, step = 4) => {
    let out = '';
    for (let wy = y - h + 3; wy <= y - 5; wy += step)
      for (const wx of [x + 3, x + 8]) out += `<rect x="${wx}" y="${wy}" width="2" height="2" fill="${fill}"/>`;
    return out;
  };

  // Every level is a building at a different stage of being made, like a UI going from sketch to launch
  const building = (lvl, x, y) => {
    const h = HEIGHT[lvl], f = faces(x, y, h);
    if (lvl === 1) {
      // Sketch: a blueprint outline with dashed windows
      const s = ' fill="#9cc9ff" fill-opacity=".14" stroke="#9cc9ff" stroke-width="1" stroke-dasharray="2 1.5"';
      return poly(f.side, '#9cc9ff', s.replace(' fill="#9cc9ff"', '')) + poly(f.top, '#9cc9ff', s.replace(' fill="#9cc9ff"', ''))
        + `<rect x="${x}" y="${y - h}" width="${CW}" height="${h}"${s}/>`
        + `<rect x="${x + 3}" y="${y - h + 3}" width="2" height="2" fill="none" stroke="#9cc9ff" stroke-width=".6"/><rect x="${x + 8}" y="${y - h + 3}" width="2" height="2" fill="none" stroke="#9cc9ff" stroke-width=".6"/>`;
    }
    if (lvl === 2) {
      // Lo-fi: grey massing with placeholder windows and a door
      return poly(f.top, '#c4cad8') + `<rect x="${x}" y="${y - h}" width="${CW}" height="${h}" fill="#9098ad"/>` + poly(f.side, '#747c93')
        + windowsOn(x, y, h, '#c4cad8') + `<rect x="${x + 5}" y="${y - 4}" width="3" height="4" fill="#6b7287"/>`;
    }
    if (lvl === 3) {
      // Built: finished house, cream walls and a green roof
      return poly(f.top, '#40c463') + `<rect x="${x}" y="${y - h}" width="${CW}" height="${h}" fill="#ece4d0"/>` + poly(f.side, '#c9bfa6')
        + `<rect x="${x}" y="${y - h}" width="${CW}" height="2" fill="#2f9a4a"/>`
        + windowsOn(x, y, h, '#2b3a55') + `<rect x="${x + 5}" y="${y - 5}" width="3" height="5" fill="#8a5a33"/>`;
    }
    // Launched: lit tower with an orange roof and an antenna
    return poly(f.top, '#ff6a2b') + `<rect x="${x}" y="${y - h}" width="${CW}" height="${h}" fill="#3d4a6b"/>` + poly(f.side, '#28304a')
      + windowsOn(x, y, h, '#ffd36b') + `<rect x="${x + DX / 2 + 6}" y="${y - DY / 2 - h - 6}" width="1" height="6" fill="#e8ecf5"/>`
      + `<rect x="${x + DX / 2 + 5.5}" y="${y - DY / 2 - h - 7}" width="2" height="2" fill="#ff6a2b"/>`;
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
      art += poly([[x, y], [x + CW, y], [x + CW + DX, y - DY], [x + DX, y - DY]], (c + r) % 2 ? '#4caf50' : '#46a24a');
      if (lvl) art += building(lvl, x, y);
      if (day.date === today) {
        const fx = x + 2, fy = y - HEIGHT[lvl] - (lvl === 4 ? 8 : 1);
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
      months += `<text x="${x}" y="${OY + 26}" class="t">${m}</text>`;
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
    const x = Math.floor(rand() * 470), y = 66 + Math.floor(rand() * 104);
    shimmer += `<rect x="${x}" y="${y}" width="${4 + Math.floor(rand() * 6)}" height="1" fill="#bfe3ff" style="animation-delay:${(-rand() * 4).toFixed(2)}s"/>`;
  }

  // Legend: the four build stages
  const legend = [
    ['SKETCH', `<rect x=".5" y=".5" width="7" height="7" fill="#9cc9ff" fill-opacity=".14" stroke="#9cc9ff" stroke-dasharray="2 1.5"/>`],
    ['LO-FI', `<rect x="0" y="0" width="8" height="8" fill="#9098ad"/><rect x="2" y="2" width="2" height="2" fill="#c4cad8"/><rect x="5" y="2" width="2" height="2" fill="#c4cad8"/>`],
    ['BUILT', `<rect x="0" y="0" width="8" height="8" fill="#ece4d0"/><rect x="0" y="0" width="8" height="2" fill="#40c463"/><rect x="2" y="4" width="2" height="2" fill="#2b3a55"/><rect x="5" y="4" width="2" height="2" fill="#2b3a55"/>`],
    ['LAUNCHED', `<rect x="0" y="0" width="8" height="8" fill="#3d4a6b"/><rect x="0" y="0" width="8" height="2" fill="#ff6a2b"/><rect x="2" y="4" width="2" height="2" fill="#ffd36b"/><rect x="5" y="4" width="2" height="2" fill="#ffd36b"/>`],
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

/* ------------------------------------------------------ pixel icon kit */

// Tiny 3x5 font for letters inside icons
const F35 = {
  A: ['.x.', 'x.x', 'xxx', 'x.x', 'x.x'], C: ['xxx', 'x..', 'x..', 'x..', 'xxx'], E: ['xxx', 'x..', 'xx.', 'x..', 'xxx'],
  J: ['..x', '..x', '..x', 'x.x', 'xxx'], N: ['x..x', 'xx.x', 'x.xx', 'x..x', 'x..x'], S: ['xxx', 'x..', 'xxx', '..x', 'xxx'],
  T: ['xxx', '.x.', '.x.', '.x.', '.x.'], '#': ['.x.x.', 'xxxxx', '.x.x.', 'xxxxx', '.x.x.'], '+': ['...', '.x.', 'xxx', '.x.', '...'],
};

// Small raster to compose icons from primitives; cells hold palette characters
function canvas(w, h) {
  const g = Array.from({ length: h }, () => Array(w).fill('.'));
  const api = {
    set(x, y, c) { if (x >= 0 && y >= 0 && x < w && y < h) g[y][x] = c; return api; },
    rect(x, y, rw, rh, c) { for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) api.set(x + i, y + j, c); return api; },
    disc(cx, cy, r, c) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) api.set(x, y, c);
      return api;
    },
    ring(cx, cy, r, t, c) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d <= r && d > r - t) api.set(x, y, c);
      }
      return api;
    },
    line(x0, y0, x1, y1, c) {
      const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      for (let i = 0; i <= n; i++) api.set(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), c);
      return api;
    },
    text(str, x, y, c) {
      for (const ch of str) {
        const glyph = F35[ch];
        glyph.forEach((row, j) => [...row].forEach((v, i) => v === 'x' && api.set(x + i, y + j, c)));
        x += glyph[0].length + 1;
      }
      return api;
    },
    rows: () => g.map((r) => r.join('')),
  };
  return api;
}

// Rounded tile helper: square with clipped corners
const tile = (w, h, c) => canvas(w, h).rect(0, 0, w, h, c).set(0, 0, '.').set(w - 1, 0, '.').set(0, h - 1, '.').set(w - 1, h - 1, '.');

// 24 tools, each { name, rows, pal }. Drawn at 3x scale.
const ICONS = [
  ['React', () => ({
    rows: ['.....ccc.....', '...cc...cc...', 'cc..c...c..cc', 'c.cc.....cc.c', 'c...c.c.c...c', '.cc..ccc..cc.', 'c...c.c.c...c', 'c.cc.....cc.c', 'cc..c...c..cc', '...cc...cc...', '.....ccc.....'],
    pal: { c: '#61dafb' },
  })],
  ['TypeScript', () => ({ rows: tile(12, 12, 'b').text('TS', 4, 6, 'w').rows(), pal: { b: '#3178c6', w: '#ffffff' } })],
  ['JavaScript', () => ({ rows: tile(12, 12, 'y').text('JS', 4, 6, 'k').rows(), pal: { y: '#f7df1e', k: '#1b1b1b' } })],
  ['Vite', () => ({
    rows: ['pppppppppppp', '.pppppyyppp.', '..ppppyyp...', '..pppyyyyyp.', '...ppyyypp..', '...pppyypp..', '....pyypp...', '....pyyp....', '.....yp.....', '.....p......'],
    pal: { p: '#8c7bff', y: '#ffcf33' },
  })],
  ['Tailwind', () => ({
    rows: ['.....cccc....', '...cc....c...', '..c.......cc.', 'cc..cccc.....', '...cc....c...', '..c.......cc.', 'cc...........'],
    pal: { c: '#38bdf8' },
  })],
  ['Next.js', () => ({ rows: canvas(12, 12).disc(6, 6, 6, 'w').rect(3, 3, 1, 6, 'k').line(4, 4, 8, 9, 'k').rect(8, 3, 1, 4, 'k').rows(), pal: { w: '#f2f4f8', k: '#0b0d14' } })],
  ['Angular', () => ({
    rows: ['.....rr.....', '...rrrRR....', '.rrrrrRRRRR.', '.rrrrwwRRRR.', '.rrrwrrwRRR.', '.rrrwrrwRRR.', '.rrrwwwwRRR.', '..rwrrrRwR..', '..rwrrrRwR..', '...rrrRRR...', '....rrRR....', '.....rR.....'],
    pal: { r: '#dd0031', R: '#b3002a', w: '#ffffff' },
  })],
  ['three.js', () => ({
    rows: ['w...........', 'ww..........', 'w.w.........', 'wwww........', 'w...w.......', 'ww..ww......', 'w.w.w.w.....', 'wwwwwwww....', 'w.......w...', 'ww......ww..', 'w.w....w.w..', 'wwwwwwwwwwww'],
    pal: { w: '#e8ecf5' },
  })],
  ['Blender', () => ({
    rows: canvas(13, 12).line(0, 3, 5, 3, 'o').line(2, 6, 5, 6, 'o').line(1, 1, 6, 4, 'o').ring(8, 7, 5, 2, 'o').disc(8, 7, 2.2, 'b').rows(),
    pal: { o: '#f5792a', b: '#265787' },
  })],
  ['Unity', () => ({
    rows: ['.....ww.....', '...ww..ww...', '.ww......ww.', 'ww...ww...ww', 'w.ww....ww.w', 'w...wwww...w', 'w.....w....w', 'w.....w....w', 'ww....w...ww', '.ww...w..ww.', '...ww.w.ww..', '.....www....'],
    pal: { w: '#e8ecf5' },
  })],
  ['C#', () => ({ rows: canvas(12, 12).disc(6, 6, 6, 'p').text('C#', 1, 4, 'w').rows(), pal: { p: '#9b4f96', w: '#ffffff' } })],
  ['C++', () => ({ rows: canvas(13, 12).disc(6.5, 6, 6, 'b').text('C++', 1, 4, 'w').rows(), pal: { b: '#00599c', w: '#ffffff' } })],
  ['Node.js', () => {
    const c = canvas(12, 12);
    [4, 2, 1, 0, 0, 0, 0, 0, 0, 1, 2, 4].forEach((inset, y) => c.rect(inset, y, 12 - inset * 2, 1, 'g'));
    return { rows: c.text('JS', 3, 4, 'w').rows(), pal: { g: '#5fa04e', w: '#ffffff' } };
  }],
  ['NestJS', () => ({
    rows: ['.r........r.', '.rr......rr.', '.rrrrrrrrrr.', 'rrrrrrrrrrrr', 'rrkkrrrrkkrr', 'rrrrrrrrrrrr', '.rrrrrrrrrr.', '..rrrrrrrr..', '...rrrrrr...', '....rrrr....'],
    pal: { r: '#e0234e', k: '#1b1b1b' },
  })],
  ['Prisma', () => ({
    rows: ['.....w......', '.....ww.....', '....wiw.....', '....wiiw....', '...wiiiw....', '...wiiiiw...', '..wiiiiiw...', '..wiiiiiiw..', '.wiiiiiiiw..', '.wwiiiiiiww.', '..wwwwwwwwww'],
    pal: { w: '#e8ecf5', i: '#5a67d8' },
  })],
  ['PostgreSQL', () => ({
    rows: ['..bbbbbbb...', '.bbbbbbbbb..', 'bbwbbbbbbbbb', 'bbbbbbbbbbbb', 'bbbbbbbbb.bb', '.bbbbbbb..b.', '..bb.bb...b.', '..bb.bb..bb.', '..ww.ww.....'],
    pal: { b: '#336791', w: '#e8ecf5' },
  })],
  ['.NET', () => ({ rows: tile(14, 12, 'p').set(1, 8, 'w').text('NET', 2, 4, 'w').rows(), pal: { p: '#512bd4', w: '#ffffff' } })],
  ['Azure', () => ({
    rows: ['....bbb.....', '....bbbb....', '...bbbbb....', '...bbb.bb...', '..bbb..bbb..', '..bbb...bbb.', '.bbb...lllb.', '.bbb..lllllb', 'bbb.lllllll.', 'bb..........'],
    pal: { b: '#0078d4', l: '#50e6ff' },
  })],
  ['Firebase', () => ({
    rows: ['..y.........', '..yy........', '..yyy..o....', '.yyyy.oo....', '.yyyyooo....', '.yyyoooo.o..', '.yyyoooooo..', 'yyyyooooooo.', 'yyyoooooooo.', '.oooooooooo.', '..oooooooo..'],
    pal: { y: '#ffca28', o: '#f57c00' },
  })],
  ['Git', () => {
    const c = canvas(12, 12);
    for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) if (Math.abs(x + 0.5 - 6) + Math.abs(y + 0.5 - 6) <= 6) c.set(x, y, 'o');
    return { rows: c.line(4, 3, 4, 8, 'w').line(5, 4, 7, 6, 'w').rect(4, 8, 1, 1, 'w').rect(3, 8, 2, 2, 'w').rect(7, 6, 2, 2, 'w').rect(3, 2, 2, 2, 'w').rows(), pal: { o: '#f05032', w: '#ffffff' } };
  }],
  ['GH Actions', () => ({
    rows: canvas(12, 12).ring(3, 3, 3, 1.2, 'b').line(3, 6, 3, 9, 'b').line(6, 3, 8, 3, 'b').ring(9, 4, 2.5, 1.2, 'b').ring(4, 10, 2.2, 1.2, 'b').line(6, 10, 9, 10, 'b').disc(10, 10, 1.6, 'w').rows(),
    pal: { b: '#2088ff', w: '#e8ecf5' },
  })],
  ['Netlify', () => {
    const c = canvas(12, 12);
    for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) {
      const d = Math.abs(x + 0.5 - 6) + Math.abs(y + 0.5 - 6);
      if (d <= 6 && d > 4.6) c.set(x, y, 't');
    }
    return { rows: c.rect(5, 2, 2, 8, 't').rect(2, 5, 8, 2, 't').rows(), pal: { t: '#32e6e2' } };
  }],
  ['Jest', () => ({ rows: tile(12, 12, 'm').text('J', 4, 3, 'w').disc(3, 10, 1.4, 'w').disc(6, 10.5, 1.4, 'w').disc(9, 10, 1.4, 'w').rows(), pal: { m: '#99425b', w: '#ffffff' } })],
  ['Vitest', () => ({
    rows: ['g..........g', 'gg........gg', '.gg..y...gg.', '.gg.yy...gg.', '..ggyyyyygg.', '..gg.yyygg..', '...gg.ygg...', '...ggyygg...', '....ggggg...', '.....ggg....', '......g.....'],
    pal: { g: '#729b1b', y: '#fcc72b' },
  })],
];

/* ------------------------------------------------------------ top panels */

// 5x7 pixel font for the hero headline
const F57 = {
  H: ['x...x', 'x...x', 'x...x', 'xxxxx', 'x...x', 'x...x', 'x...x'], I: ['xxx', '.x.', '.x.', '.x.', '.x.', '.x.', 'xxx'],
  M: ['x...x', 'xx.xx', 'x.x.x', 'x.x.x', 'x...x', 'x...x', 'x...x'], K: ['x...x', 'x..x.', 'x.x..', 'xx...', 'x.x..', 'x..x.', 'x...x'],
  U: ['x...x', 'x...x', 'x...x', 'x...x', 'x...x', 'x...x', '.xxx.'], B: ['xxxx.', 'x...x', 'x...x', 'xxxx.', 'x...x', 'x...x', 'xxxx.'],
  L: ['x....', 'x....', 'x....', 'x....', 'x....', 'x....', 'xxxxx'], A: ['.xxx.', 'x...x', 'x...x', 'xxxxx', 'x...x', 'x...x', 'x...x'],
  Y: ['x...x', 'x...x', '.x.x.', '..x..', '..x..', '..x..', '..x..'], ',': ['..', '..', '..', '..', '..', '.x', 'x.'],
  "'": ['x', 'x', '.', '.', '.', '.', '.'], ' ': ['...', '...', '...', '...', '...', '...', '...'],
};
const pixelText = (str) => {
  const rows = Array(7).fill('');
  for (const ch of str) F57[ch].forEach((r, i) => { rows[i] += r + '.'; });
  return rows;
};

function renderHero() {
  const W = 966, H = 128;
  const headline = pixelText("HI, I'M KUBILAY");
  const quests = [
    ['Product UI at Echonos', '#40c463'],
    ['Building a drivable portfolio at kubilaycan.com', '#ff6a2b'],
    ['GPU sims, engine sounds and WebGL experiments', '#3fa9f5'],
    ['Unity games after hours', '#a371f7'],
  ];
  const qx = 572, qy = 30;
  const questRows = quests.map(([q, c], i) => `<rect x="${qx + 14}" y="${qy + 23 + i * 18}" width="6" height="6" fill="${c}"/><text x="${qx + 28}" y="${qy + 30 + i * 18}" class="q">${q}</text>`).join('');
  return `${svgOpen(W, H, "Hi, I'm Kubilay. Frontend Engineer at Echonos. UI architecture, interactive experiences, real-time graphics and game development.", `.q{font-size:11px;fill:#e8ecf5;font-weight:600}.sub2{font-size:13px;fill:#ff6a2b;letter-spacing:1px}.tag{font-size:9.5px;fill:#8b97b8;letter-spacing:.6px}
.cursor{animation:blink 1.1s steps(1) infinite}@keyframes blink{50%{opacity:0}}
@media (prefers-reduced-motion:reduce){.cursor{animation:none}}`)}
${frame(W, H, 'HELLO WORLD')}
<text x="${W - 14}" y="16" class="sub" text-anchor="end">PRESS START</text>
<g shape-rendering="crispEdges">${bitmap(headline, { x: '#0b0d14' }, 25, 37, 5)}${bitmap(headline, { x: '#ffffff' }, 22, 34, 5)}</g>
<rect class="cursor" x="${22 + headline[0].length * 5 + 2}" y="34" width="12" height="35" fill="#ff6a2b"/>
<text x="22" y="94" class="sub2">FRONTEND ENGINEER AT ECHONOS</text>
<text x="22" y="114" class="tag">UI ARCHITECTURE · INTERACTIVE EXPERIENCES · REAL-TIME GRAPHICS · GAME DEVELOPMENT</text>
<rect x="${qx}" y="${qy}" width="${W - qx - 14}" height="${H - qy - 12}" fill="#0b0d14"/>
<rect x="${qx + 2}" y="${qy + 2}" width="${W - qx - 18}" height="${H - qy - 16}" fill="#1b2236"/>
<text x="${qx + 14}" y="${qy + 15}" class="sub">CURRENT QUESTS</text>
${questRows}
</svg>
`;
}

function renderSkills() {
  const W = 966, P = 3, COLS = 8;
  const sw = 112, sh = 64, gap = 6, x0 = (W - (COLS * sw + (COLS - 1) * gap)) / 2, y0 = 30;
  const rows = Math.ceil(ICONS.length / COLS);
  const H = y0 + rows * sh + (rows - 1) * gap + 12;
  const slots = ICONS.map(([name, make], i) => {
    const { rows: icon, pal } = make();
    const x = x0 + (i % COLS) * (sw + gap), y = y0 + Math.floor(i / COLS) * (sh + gap);
    const iw = icon[0].length * P, ih = icon.length * P;
    return `<rect x="${x}" y="${y}" width="${sw}" height="${sh}" fill="#0b0d14"/><rect x="${x + 2}" y="${y + 2}" width="${sw - 4}" height="${sh - 4}" fill="#1b2236"/>`
      + bitmap(icon, pal, x + (sw - iw) / 2, y + 6 + (39 - ih) / 2, P)
      + `<text x="${x + sw / 2}" y="${y + sh - 9}" class="s" text-anchor="middle">${name}</text>`;
  }).join('');
  return `${svgOpen(W, H, `Tech stack: ${ICONS.map(([n]) => n).join(', ')}`, `.s{font-size:9.5px;fill:#c3cbe0}`)}
${frame(W, H, 'SKILL TREE')}
<text x="${W - 14}" y="16" class="sub" text-anchor="end">${ICONS.length} TOOLS UNLOCKED</text>
<g shape-rendering="crispEdges">${slots}</g>
</svg>
`;
}

// Link buttons: one small image per link so each can sit inside its own <a>
function renderButton(label, value) {
  const lw = label.length * 7 + 22, vw = value.length * 7.2 + 22, W = lw + vw + 8, H = 30;
  return `${svgOpen(W, H, `${label}: ${value}`, `.bl{font-size:10px;fill:#e8ecf5;letter-spacing:1.2px}.bv{font-size:10.5px;fill:#ffffff;letter-spacing:.5px}`)}
<path d="M2 0H${W - 2}V2H${W}V${H - 2}H${W - 2}V${H}H2V${H - 2}H0V2H2Z" fill="#2c3550"/>
<rect x="4" y="4" width="${lw - 4}" height="${H - 8}" fill="#141a2b"/>
<rect x="${lw + 2}" y="4" width="${vw}" height="${H - 8}" fill="#ff6a2b"/>
<rect x="${lw + 2}" y="${H - 7}" width="${vw}" height="3" fill="#c94f1d"/>
<rect x="10" y="12" width="5" height="5" fill="#ff6a2b"/>
<text x="20" y="19" class="bl">${label}</text>
<text x="${lw + 2 + vw / 2}" y="19" class="bv" text-anchor="middle">${value}</text>
</svg>
`;
}

/* ------------------------------------------------------------------ main */

// Every panel gets a 3px transparent margin, so a full-width panel lines up exactly with
// two half-width panels placed side by side (966 + 6 = 2 x (480 + 6)).
const PAD = 3;
function padded(svg) {
  return svg
    .replace(/<svg ([^>]*?)width="([\d.]+)" height="([\d.]+)" viewBox="0 0 [\d.]+ [\d.]+"([^>]*)>/, (_, pre, w, h, post) => {
      const W = +w + PAD * 2, H = +h + PAD * 2;
      return `<svg ${pre}width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"${post}><g transform="translate(${PAD} ${PAD})">`;
    })
    .replace(/<\/svg>\s*$/, '</g>\n</svg>\n');
}

const data = await collect();
mkdirSync(OUT_DIR, { recursive: true });
const panels = {
  hero: renderHero(),
  skills: renderSkills(),
  'link-website': renderButton('WEBSITE', 'KUBILAYCAN.COM'),
  'link-linkedin': renderButton('LINKEDIN', 'KUBILAY CAN'),
  'link-email': renderButton('EMAIL', 'CAN.KUBILAY@OUTLOOK.COM'),
  profile: renderProfile(data),
  calendar: renderCalendar(data),
  languages: renderLanguages(data),
  habits: renderHabits(data.dates),
};
for (const [name, svg] of Object.entries(panels)) {
  const out = name.startsWith('link-') ? svg : padded(svg);
  writeFileSync(join(OUT_DIR, `${name}.svg`), out);
  console.log(`panels: wrote ${join(OUT_DIR, name)}.svg (${(out.length / 1024).toFixed(1)} KB)`);
}
