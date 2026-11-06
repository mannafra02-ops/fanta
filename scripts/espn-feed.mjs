// Feed pubblico ESPN. Condiviso dal sito e dall'aggiornamento GitHub Actions.
export const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1";

export async function fetchJson(url, { fetchImpl = globalThis.fetch, timeout = 12000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`ESPN HTTP ${response.status}`);
    const data = await response.json();
    if (!data || data.error || Number(data.code) >= 400) throw new Error(data?.message || "Risposta ESPN non valida");
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export function competition(event) { return event?.competitions?.[0] || null; }
export function homeTeam(comp) { return comp?.competitors?.find(c => c.homeAway === "home") || null; }
export function awayTeam(comp) { return comp?.competitors?.find(c => c.homeAway === "away") || null; }
export function teamLogo(team) { return team?.logo || team?.logos?.[0]?.href || ""; }
export function isCompleted(event) {
  const status = event?.status?.type || competition(event)?.status?.type;
  return status?.completed === true || status?.state === "post";
}

function romeYear(date) {
  return Number(new Intl.DateTimeFormat("en", { year: "numeric", timeZone: "Europe/Rome" }).format(date));
}

export async function fetchScoreboard(from, to, options = {}) {
  if (!Number.isFinite(+from) || !Number.isFinite(+to) || +to < +from) throw new Error("Intervallo date non valido");
  // ESPN rifiuta attualmente dates=YYYYMMDD-YYYYMMDD con HTTP 400.
  // Una richiesta per anno restituisce il calendario: il filtro è applicato qui.
  const years = Array.from({ length: romeYear(to) - romeYear(from) + 1 }, (_, i) => romeYear(from) + i);
  if (years.length > 3) throw new Error("Intervallo troppo ampio");
  const pages = await Promise.all(years.map(year => fetchJson(`${ESPN_BASE}/scoreboard?dates=${year}&limit=1000`, options)));
  if (pages.some(page => !Array.isArray(page.events))) throw new Error("Calendario ESPN incompleto");
  const events = [...new Map(pages.flatMap(page => page.events).filter(event => {
    const date = Date.parse(event.date);
    return event.id && Number.isFinite(date) && date >= +from && date <= +to;
  }).map(event => [String(event.id), event])).values()].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  return { events, leagues: pages.at(-1)?.leagues || [] };
}

export function normalizeFixture(event) {
  const comp = competition(event), home = homeTeam(comp), away = awayTeam(comp);
  if (!event?.id || !home?.team?.id || !away?.team?.id || !Number.isFinite(Date.parse(event.date))) return null;
  const normalize = c => ({
    id: String(c.team.id), name: c.team.displayName || c.team.name || "Squadra",
    abbr: c.team.abbreviation || "", logo: teamLogo(c.team)
  });
  return {
    id: String(event.id), date: event.date, home: normalize(home), away: normalize(away),
    venue: comp.venue?.fullName || event.venue?.displayName || "",
    state: event.status?.type?.state || comp.status?.type?.state || "pre"
  };
}

export function futureFixtures(events, now = Date.now()) {
  return events.filter(event => !isCompleted(event) && Date.parse(event.date) >= now - 3 * 3600000)
    .map(normalizeFixture).filter(Boolean).sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).slice(0, 40);
}

export function normalizeLineups(event, data) {
  const comp = competition(event), home = homeTeam(comp), away = awayTeam(comp);
  if (!home || !away) return [];
  return (data.rosters || []).flatMap(roster => {
    const teamId = String(roster.team?.id || "");
    if (![String(home.team?.id), String(away.team?.id)].includes(teamId)) return [];
    const starters = (roster.roster || []).filter(player => player.starter === true)
      .sort((a, b) => (Number(a.formationPlace) || 99) - (Number(b.formationPlace) || 99))
      .map(player => player.athlete?.displayName || player.athlete?.fullName).filter(Boolean);
    // Mai pubblicare XI vuoti o incompleti come aggiornamento riuscito.
    if (starters.length !== 11 || new Set(starters).size !== 11) return [];
    const isHome = teamId === String(home.team?.id), opponent = isHome ? away : home;
    const score = value => typeof value === "object" ? value?.displayValue ?? value?.value ?? "0" : value ?? "0";
    return [{
      teamId, eventId: String(event.id), team: roster.team?.displayName || roster.team?.name || "Squadra",
      logo: teamLogo(roster.team), formation: typeof roster.formation === "string" ? roster.formation : roster.formation?.displayName || "",
      starters, date: event.date,
      result: `${isHome ? "vs" : "@"} ${opponent?.team?.displayName || "avversario"} · ${score(home.score)}-${score(away.score)}`
    }];
  });
}

async function mapLimited(items, mapper, concurrency = 3) {
  let cursor = 0;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try { results[index] = await mapper(items[index]); }
      catch { results[index] = null; }
    }
  }));
  return results;
}

export async function collectLineups(events, options = {}) {
  const completed = events.filter(isCompleted).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const candidates = new Map();
  for (const event of completed) {
    for (const c of competition(event)?.competitors || []) {
      const id = String(c.team?.id || "");
      if (!id) continue;
      if (!candidates.has(id)) candidates.set(id, []);
      if (candidates.get(id).length < 3) candidates.get(id).push(event);
    }
  }
  if (!candidates.size) throw new Error("Nessuna partita conclusa disponibile");
  const found = new Map(), attempted = new Set();
  for (let round = 0; round < 3; round++) {
    const batch = [...new Map([...candidates].filter(([id]) => !found.has(id))
      .map(([, games]) => games[round]).filter(event => event && !attempted.has(String(event.id)))
      .map(event => [String(event.id), event])).values()];
    batch.forEach(event => attempted.add(String(event.id)));
    const results = await mapLimited(batch, async event => normalizeLineups(event,
      await fetchJson(`${ESPN_BASE}/summary?event=${encodeURIComponent(event.id)}`, options)));
    for (const result of results) {
      for (const lineup of result || []) {
        if (!found.has(lineup.teamId) || Date.parse(lineup.date) > Date.parse(found.get(lineup.teamId).date)) found.set(lineup.teamId, lineup);
      }
    }
    if (found.size >= candidates.size) break;
  }
  if (!found.size) throw new Error("ESPN non ha restituito undici titolari completi");
  return {
    lineups: [...found.values()].sort((a, b) => a.team.localeCompare(b.team, "it")),
    expectedTeamCount: candidates.size,
    missingTeamIds: [...candidates.keys()].filter(id => !found.has(id))
  };
}
