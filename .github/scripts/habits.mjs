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

function render(dates) {
  const hours = Array(24).fill(0);
  const days = Array(7).fill(0); // Monday first
  for (const d of dates) {
    const local = new Date(d.getTime() + UTC_OFFSET_HOURS * 3600 * 1000);
    hours[local.getUTCHours()]++;
    days[(local.getUTCDay() + 6) % 7]++;
  }

  const GREENS = ['#9be9a8', '#40c463', '#30a14e', '#216e39'];
  const shade = (v, max) => (v ? GREENS[Math.min(3, Math.floor((v / max) * 4))] : '#d0d7de');

  const W = 480, H = 166;
  // Values are only printed on the peak bar to keep the compact charts readable
  const chart = (values, labels, { y, h, barW, gap, x0, labelEvery = 1 }) => {
    const max = Math.max(1, ...values);
    const peak = values.indexOf(max);
    return values.map((v, i) => {
      const bh = v ? Math.max(3, (v / max) * h) : 2;
      const x = x0 + i * (barW + gap);
      const top = y + h - bh;
      return `<rect x="${x}" y="${top.toFixed(1)}" width="${barW}" height="${bh.toFixed(1)}" rx="2" fill="${shade(v, max)}"/>`
        + (i === peak && v ? `<text x="${x + barW / 2}" y="${(top - 4).toFixed(1)}" class="v">${v}</text>` : '')
        + (i % labelEvery === 0 ? `<text x="${x + barW / 2}" y="${y + h + 13}" class="l">${labels[i]}</text>` : '');
    }).join('');
  };

  const DAY = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  const peakHour = hours.indexOf(Math.max(...hours));
  const peakDay = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][days.indexOf(Math.max(...days))];
  const hourLabels = hours.map((_, i) => String(i).padStart(2, '0'));

  // Side by side so the panel matches the height of the languages panel next to it:
  // 24 hour bars spanning x 12-306, 7 weekday bars spanning x 336-468
  const hoursChart = chart(hours, hourLabels, { y: 58, h: 62, barW: 9, gap: 3.5, x0: 12, labelEvery: 3 });
  const daysChart = chart(days, DAY, { y: 58, h: 62, barW: 15, gap: 4.5, x0: 336 });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Coding habits: commits per hour of day and per day of week">
<style>
text{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif}
.h{font-size:16px;fill:#0366d6}.s{font-size:12px;fill:#0366d6;text-anchor:middle}
.v{font-size:9px;fill:#777;text-anchor:middle}.l{font-size:9px;fill:#777;text-anchor:middle}
.f{font-size:12px;fill:#777}
</style>
<g transform="translate(5 9)" fill="#0366d6"><path d="M8 1.5c-2.363 0-4 1.69-4 3.75 0 .984.424 1.625.984 2.304l.214.253c.223.264.47.556.673.848.284.411.537.896.621 1.49a.75.75 0 0 1-1.484.211c-.04-.282-.163-.547-.37-.847a8.456 8.456 0 0 0-.542-.68c-.084-.1-.173-.205-.268-.32C3.201 7.75 2.5 6.766 2.5 5.25 2.5 2.31 4.863 0 8 0s5.5 2.31 5.5 5.25c0 1.516-.701 2.5-1.328 3.259-.095.115-.184.22-.268.319-.207.245-.383.453-.541.681-.208.3-.33.565-.37.847a.751.751 0 0 1-1.485-.212c.084-.593.337-1.078.621-1.489.203-.292.45-.584.673-.848.075-.088.147-.173.213-.253.561-.679.985-1.32.985-2.304 0-2.06-1.637-3.75-4-3.75ZM5.75 12h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5ZM6 15.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1-.75-.75Z"/></g>
<text x="30" y="22" class="h">Coding habits</text>
<text x="159" y="44" class="s">Commits per hour (Istanbul time)</text>
${hoursChart}
<text x="402" y="44" class="s">Per weekday</text>
${daysChart}
<text x="12" y="157" class="f">${dates.length.toLocaleString('en-US')} commits in the last 12 months · busiest on ${peakDay}s around ${String(peakHour).padStart(2, '0')}:00</text>
</svg>
`;
}

const dates = await collectDates();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, render(dates));
console.log(`habits: wrote ${OUT}`);
