// Generates metrics/metrics-light.svg and metrics/metrics-dark.svg from the GitHub GraphQL API.
// No dependencies. Run: GITHUB_TOKEN=... USERNAME=zarkasias node scripts/metrics.mjs
// For a local preview without a token: MOCK=1 node scripts/metrics.mjs
import { mkdir, writeFile } from "node:fs/promises";

const USER = process.env.USERNAME || "zarkasias";
const TOKEN = process.env.GITHUB_TOKEN;
const OUT = "metrics";

async function gql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors || json));
  return json.data;
}

async function fetchData() {
  const base = await gql(
    `query($login:String!){ user(login:$login){
      createdAt
      contributionsCollection{
        totalCommitContributions totalPullRequestContributions
        totalIssueContributions restrictedContributionsCount
        contributionCalendar{ totalContributions weeks{ contributionDays{ date contributionCount } } }
      }
    }}`,
    { login: USER }
  );
  const u = base.user;

  // Owned, non-fork repos (paginated). Includes private repos if the token can see them.
  const repos = [];
  let cursor = null;
  do {
    const d = await gql(
      `query($login:String!,$cursor:String){ user(login:$login){
        repositories(first:100, after:$cursor, ownerAffiliations:OWNER, isFork:false){
          pageInfo{ hasNextPage endCursor }
          nodes{ stargazerCount languages(first:10, orderBy:{field:SIZE,direction:DESC}){ edges{ size node{ name color } } } }
        }
      }}`,
      { login: USER, cursor }
    );
    const r = d.user.repositories;
    repos.push(...r.nodes);
    cursor = r.pageInfo.hasNextPage ? r.pageInfo.endCursor : null;
  } while (cursor);

  const langs = {};
  for (const repo of repos)
    for (const e of repo.languages.edges) {
      langs[e.node.name] ??= { size: 0, color: e.node.color || "#8b949e" };
      langs[e.node.name].size += e.size;
    }

  const cc = u.contributionsCollection;
  return {
    contributions: cc.contributionCalendar.totalContributions,
    commits: cc.totalCommitContributions + cc.restrictedContributionsCount,
    prs: cc.totalPullRequestContributions,
    repos: repos.length,
    stars: repos.reduce((s, r) => s + r.stargazerCount, 0),
    since: new Date(u.createdAt).getFullYear(),
    days: cc.contributionCalendar.weeks.flatMap((w) => w.contributionDays),
    langs,
  };
}

function mockData() {
  const days = [];
  const start = new Date();
  start.setDate(start.getDate() - 364);
  for (let i = 0; i < 365; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const r = Math.sin(i * 0.7) + Math.sin(i * 0.13) * 2 + (d.getDay() % 6 === 0 ? -2 : 1);
    days.push({ date: d.toISOString().slice(0, 10), contributionCount: Math.max(0, Math.round(r * 2)) });
  }
  return {
    contributions: days.reduce((s, d) => s + d.contributionCount, 0),
    commits: 812, prs: 64, repos: 25, stars: 31, since: 2012, days,
    langs: {
      TypeScript: { size: 620, color: "#3178c6" }, JavaScript: { size: 180, color: "#f1e05a" },
      CSS: { size: 90, color: "#663399" }, HTML: { size: 50, color: "#e34c26" }, Shell: { size: 15, color: "#89e051" },
    },
  };
}

function streaks(days) {
  let longest = 0, run = 0;
  for (const d of days) { run = d.contributionCount ? run + 1 : 0; longest = Math.max(longest, run); }
  // Current streak: don't break it just because today has no contributions yet.
  let current = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].contributionCount) current++;
    else if (i === days.length - 1) continue;
    else break;
  }
  return { current, longest };
}

const THEMES = {
  light: { bg: "#ffffff", border: "#d0d7de", text: "#1f2328", muted: "#656d76", empty: "#ebedf0", heat: ["#9be9a8", "#40c463", "#30a14e", "#216e39"] },
  dark: { bg: "#0d1117", border: "#30363d", text: "#e6edf3", muted: "#8d96a0", empty: "#161b22", heat: ["#0e4429", "#006d32", "#26a641", "#39d353"] },
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const fmt = (n) => n.toLocaleString("en-US");

function render(data, t) {
  const W = 840, H = 280, P = 28;
  const { current, longest } = streaks(data.days);
  const font = `font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"`;

  // Stat row
  const stats = [
    [fmt(data.contributions), "contributions this year"],
    [fmt(data.commits), "commits"],
    [fmt(data.prs), "pull requests"],
    [`${current}d`, `current streak · best ${longest}d`],
    [fmt(data.repos), "repositories"],
  ];
  const colW = (W - P * 2) / stats.length;
  const statSvg = stats.map(([v, l], i) => `
    <text x="${P + i * colW}" y="${P + 26}" fill="${t.text}" font-size="26" font-weight="600">${esc(v)}</text>
    <text x="${P + i * colW}" y="${P + 46}" fill="${t.muted}" font-size="12">${esc(l)}</text>`).join("");

  // Contribution heatmap (last 52 weeks)
  const days = data.days.slice(-364);
  const cols = Math.ceil((days.length + new Date(days[0].date + "T00:00:00Z").getUTCDay()) / 7);
  const step = (W - P * 2 + 3) / cols, cell = step - 3;
  const max = Math.max(1, ...days.map((d) => d.contributionCount));
  const firstDow = new Date(days[0].date + "T00:00:00Z").getUTCDay();
  const hx = P, hy = P + 78;
  const heat = days.map((d, i) => {
    const idx = i + firstDow, col = Math.floor(idx / 7), row = idx % 7;
    const c = d.contributionCount;
    const fill = c === 0 ? t.empty : t.heat[Math.min(3, Math.floor((c / max) * 4))];
    return `<rect x="${hx + col * step}" y="${hy + row * step}" width="${cell}" height="${cell}" rx="2" fill="${fill}"/>`;
  }).join("");

  // Languages: one stacked bar + legend, under the heatmap
  const entries = Object.entries(data.langs).sort((a, b) => b[1].size - a[1].size);
  const top = entries.slice(0, 5);
  const otherSize = entries.slice(5).reduce((s, [, v]) => s + v.size, 0);
  if (otherSize) top.push(["Other", { size: otherSize, color: t.muted }]);
  const total = top.reduce((s, [, v]) => s + v.size, 0) || 1;
  const by = hy + 7 * step + 18, bw = W - P * 2;
  let x = P;
  const bar = top.map(([, v]) => {
    const w = (v.size / total) * bw;
    const r = `<rect x="${x}" y="${by}" width="${Math.max(w - 2, 1)}" height="8" fill="${v.color}"/>`;
    x += w; return r;
  }).join("");
  let lx = P;
  const legend = top.map(([name, v]) => {
    const label = `${name} ${((v.size / total) * 100).toFixed(0)}%`;
    const g = `<circle cx="${lx + 5}" cy="${by + 28}" r="5" fill="${v.color}"/>
      <text x="${lx + 15}" y="${by + 32}" fill="${t.muted}" font-size="12">${esc(label)}</text>`;
    lx += 26 + label.length * 6.8; return g;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ${font}>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${t.bg}" stroke="${t.border}"/>
  ${statSvg}
  <g>${heat}</g>
  <text x="${W - P}" y="${by + 32}" text-anchor="end" fill="${t.muted}" font-size="12">on GitHub since ${data.since}</text>
  <clipPath id="bar"><rect x="${P}" y="${by}" width="${bw}" height="8" rx="4"/></clipPath>
  <g clip-path="url(#bar)">${bar}</g>
  ${legend}
</svg>`.replace(/\n\s*\n/g, "\n");
}

const data = process.env.MOCK ? mockData() : await fetchData();
await mkdir(OUT, { recursive: true });
for (const [name, theme] of Object.entries(THEMES))
  await writeFile(`${OUT}/metrics-${name}.svg`, render(data, theme));
console.log(`Wrote ${OUT}/metrics-light.svg and ${OUT}/metrics-dark.svg`);
