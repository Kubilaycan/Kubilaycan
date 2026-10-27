// Renders metrics/habits.svg: commits per hour of day and per day of week over the last year,
// across every repository the token's owner can access (private and organisation repos included).
// Usage: GITHUB_TOKEN=... node .github/scripts/habits.mjs [output path]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const TOKEN = process.env.GITHUB_TOKEN;
const OUT = process.argv[2] ?? 'metrics/habits.svg';
const UTC_OFFSET_HOURS = 3; // Europe/Istanbul, no DST
const SINCE = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();

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

const HISTORY = `history(first: 100, after: $cursor, since: $since, author: {id: $author}) {
  pageInfo { hasNextPage endCursor }
  nodes { authoredDate }
}`;

async function collectDates() {
  const { viewer } = await gql('{ viewer { id login } }');
  const repos = [];
  let after = null;
  do {
    const data = await gql(
      `query($after: String) { viewer { repositories(first: 100, after: $after, isFork: false,
        affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER],
        ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]) {
          pageInfo { hasNextPage endCursor }
          nodes { owner { login } name }
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
          repository(owner: $owner, name: $name) { defaultBranchRef { target { ... on Commit { ${HISTORY} } } } }
        }`,
        { owner: owner.login, name, since: SINCE, author: viewer.id, cursor },
      );
      const history = data.repository?.defaultBranchRef?.target?.history;
      if (!history) break;
      dates.push(...history.nodes.map((n) => new Date(n.authoredDate)));
      cursor = history.pageInfo.hasNextPage ? history.pageInfo.endCursor : null;
    } while (cursor);
  }
  console.log(`habits: ${dates.length} commits across ${repos.length} repositories`);
  return dates;
}

// Pixel-art skyline: one building per hour of day, height = commits in that hour.
// The sky runs from night to day to night across the hours; a looping cursor "hovers" the busiest hour.
function render(dates) {
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

const dates = await collectDates();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, render(dates));
console.log(`habits: wrote ${OUT}`);
