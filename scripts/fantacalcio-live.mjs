// Solo pagine pubbliche Fantacalcio.it: nessun account, token o voto stimato.
export const FC_SEASON = "2026-27";
export const FC_CALENDAR_URL = "https://www.fantacalcio.it/serie-a/calendario";
export const FC_GRADES_URL = "https://www.fantacalcio.it/voti-fantacalcio-serie-a";
export const FC_GRADES_SOURCE = "Fantacalcio.it · Redazione Fantacalcio";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const idPattern = /^\d+$/;
const roundNumber = n => Number.isInteger(n) && n >= 1 && n <= 38;
const stateFor = n => ({ 0:"pre", 1:"in", 2:"in", 3:"in", 4:"post", 5:"suspended", 6:"postponed" })[n];
const entities = { amp:"&", quot:'"', apos:"'", lt:"<", gt:">", nbsp:" ", rsquo:"’" };
function decode(value) {
  return String(value ?? "").replace(/&(?:#(x[0-9a-f]+|\d+)|([a-z]+));/gi, (whole, number, name) => {
    if (!number) return entities[name.toLowerCase()] ?? whole;
    const code = number[0].toLowerCase() === "x" ? parseInt(number.slice(1), 16) : Number(number);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}
function attr(tag, name) {
  const value = String(tag).match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return value ? decode(value[1] ?? value[2]) : null;
}
function innerText(value) { return decode(String(value ?? "").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim(); }
function tagWith(html, name, prop, value) {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map(m => m[0]).find(tag => attr(tag, prop) === value) || "";
}
function readSpan(html, cls) {
  for (const [, tag, contents] of html.matchAll(/(<span\b[^>]*>)([\s\S]*?)<\/span>/gi)) {
    if ((attr(tag, "class") || "").split(/\s+/).includes(cls)) return innerText(contents);
  }
  return "";
}
function teamFromBlock(html, side) {
  for (const [, tag, contents] of html.matchAll(/(<label\b[^>]*>)([\s\S]*?)<\/label>/gi)) {
    if (attr(tag, "itemprop") !== side) continue;
    const teamId = attr(tag, "for")?.match(/^team-(\d+)$/)?.[1];
    const name = attr(tagWith(contents, "meta", "itemprop", "name"), "content");
    const href = attr(tagWith(contents, "meta", "itemprop", "url"), "content");
    const slug = href?.match(/\/serie-a\/squadre\/([a-z0-9-]+)\/?$/i)?.[1];
    const logo = attr(tagWith(contents, "img", "itemprop", "logo"), "src");
    if (!teamId || !name || !slug) return null;
    return { id:teamId, name, slug, logo:logo?.startsWith("https://content.fantacalcio.it/") ? logo : "" };
  }
  return null;
}

export function parseFcFixtures(html, { season = FC_SEASON, matchday, largeOnly = false } = {}) {
  const fixtures = new Map();
  const pills = [...html.matchAll(/<div\b[^>]*\bdata-match-status\s*=\s*["']\d+["'][^>]*>/gi)]
    .filter(m => (attr(m[0], "class") || "").split(/\s+/).includes("match-pill"));
  for (const [index, pill] of pills.entries()) {
    const classes = (attr(pill[0], "class") || "").split(/\s+/);
    if (largeOnly && !classes.includes("size-large")) continue;
    const content = html.slice(pill.index + pill[0].length, pills[index+1]?.index ?? html.length);
    const urls = [...content.matchAll(/<meta\b[^>]*>/gi)].map(m => m[0]).filter(tag => attr(tag, "itemprop") === "url");
    const matchUrl = urls.map(tag => attr(tag, "content")?.match(/\/serie-a\/calendario\/(\d+)\/(\d{4}-\d{2})\/[a-z0-9-]+\/(\d+)\/?$/i)).find(Boolean);
    if (!matchUrl || matchUrl[2] !== season || !roundNumber(Number(matchUrl[1])) || (matchday && Number(matchUrl[1]) !== matchday)) continue;
    const id = matchUrl[3];
    if (fixtures.has(id)) continue; // la copia nel widget laterale non è un altro incontro
    const home = teamFromBlock(content, "homeTeam"), away = teamFromBlock(content, "awayTeam");
    const date = attr(tagWith(content, "meta", "itemprop", "startDate"), "content");
    const time = readSpan(content, "hours");
    const state = stateFor(Number(attr(pill[0], "data-match-status")));
    if (!home || !away || home.id === away.id || !datePattern.test(date || "") || !state) continue;
    const hs = readSpan(content, "score-home"), as = readSpan(content, "score-away");
    const score = ["in","post","suspended"].includes(state) && /^\d{1,2}$/.test(hs) && /^\d{1,2}$/.test(as) ? [Number(hs), Number(as)] : null;
    fixtures.set(id, { id, matchday:Number(matchUrl[1]), date, time:timePattern.test(time) ? time : null, home, away, state, score, venue:readSpan(content, "stadium") });
  }
  return [...fixtures.values()].sort((a,b) => kickoffKey(a).localeCompare(kickoffKey(b)));
}

function kickoffKey(match) { return `${match.date}T${match.time || "23:59"}`; }
export function parseFcCalendarRound(html, expectedDay, season = FC_SEASON) {
  const matches = parseFcFixtures(html, { season, matchday:expectedDay, largeOnly:true });
  const day = expectedDay ?? matches[0]?.matchday;
  if (!roundNumber(day) || matches.length !== 10 || matches.some(m => m.matchday !== day)
    || new Set(matches.flatMap(m => [m.home.id,m.away.id])).size !== 20) {
    throw new Error(`Calendario ufficiale incompleto o non corrispondente${expectedDay ? ` per la giornata ${expectedDay}` : ""}`);
  }
  return { matchday:day, matches };
}

function gradeValue(value, min, max) {
  if (!/^-?\d{1,2}(?:[,.]\d{1,2})?$/.test(value ?? "")) return null;
  const n = Number(value.replace(",", "."));
  return n >= min && n <= max ? n : null;
}
function redazioneColumn(header) {
  // La pagina rende 3 coppie V/FV: l'ordine si legge dalle intestazioni, non dai numeri.
  const headings = [...header.matchAll(/<img\b[^>]*>/gi)].map(m => attr(m[0], "title"))
    .filter(title => ["Redazione Fantacalcio", "Voto Statistico", "Voto Italia"].includes(title));
  if (new Set(headings.slice(0,3)).size !== 3) return -1;
  return headings.slice(0,3).indexOf("Redazione Fantacalcio");
}
function gradeSpan(pill, className) {
  return [...pill.matchAll(/<span\b[^>]*>/gi)].map(m=>m[0]).find(tag => (attr(tag,"class") || "").split(/\s+/).includes(className));
}
export function parseFcGrades(html, round, season = FC_SEASON) {
  const seasonLabel = html.match(/<!--\s*Season:\s*(\d{4})[\/-](\d{2})\s*-->/i);
  const matchday = Number(html.match(/<!--\s*Matchweek:\s*(\d+)\s*-->/i)?.[1]);
  if (!seasonLabel || `${seasonLabel[1]}-${seasonLabel[2]}` !== season || matchday !== round.matchday) throw new Error("Pagina voti di una stagione o giornata diversa");
  const matches = parseFcFixtures(html, { season, matchday });
  const expected = new Map(round.matches.map(m => [m.id,m]));
  if (matches.length !== 10 || matches.some(m => {
    const f = expected.get(m.id);
    return !f || f.home.id !== m.home.id || f.away.id !== m.away.id;
  })) throw new Error("Partite dei voti non corrispondenti al calendario ufficiale");
  const teamMatch = new Map(matches.flatMap(m => [[m.home.id,m],[m.away.id,m]]));
  const grades = new Map();
  for (const [, open, body] of html.matchAll(/(<li\b[^>]*\bid=["']team-\d+["'][^>]*>)([\s\S]*?)<\/li>/gi)) {
    if (!(attr(open, "class") || "").split(/\s+/).includes("team-table")) continue;
    const teamId = attr(open, "id").slice(5);
    const match = teamMatch.get(teamId);
    if (!match || !["in","post"].includes(match.state)) continue;
    const team = match.home.id === teamId ? match.home : match.away;
    const table = body.match(/<table\b[^>]*\bclass=["'][^"']*\bgrades-table\b[^"']*["'][^>]*>([\s\S]*?)<\/table>/i)?.[1] || "";
    const header = table.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/i)?.[1] || "";
    const column = redazioneColumn(header);
    const rows = table.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i)?.[1] || "";
    if (rows && column < 0) throw new Error("Colonna Redazione Fantacalcio non riconosciuta");
    for (const [, row] of rows.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const playerLink = [...row.matchAll(/<a\b[^>]*>/gi)].map(m => m[0]).find(tag => (attr(tag,"class") || "").split(/\s+/).includes("player-link"));
      const identity = attr(playerLink, "href")?.match(/\/serie-a\/squadre\/([a-z0-9-]+)\/[^/?#]+\/(\d+)\/?$/i);
      if (!identity || identity[1] !== team.slug) continue;
      const pairs = [...row.matchAll(/<div\b[^>]*\bclass=["'][^"']*\bpill\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi)];
      const cell = pairs[column]?.[1] || "";
      const rawVote = attr(gradeSpan(cell, "player-grade"), "data-value");
      const rawFanta = attr(gradeSpan(cell, "player-fanta-grade"), "data-value");
      const vote = gradeValue(rawVote, 0, 10), fanta = gradeValue(rawFanta, -15, 35);
      // Un valore assente o un codice interno non è un voto numerico (es. 55).
      if (vote === null && fanta === null) continue;
      const officialId = identity[2];
      if (grades.has(officialId)) throw new Error("ID giocatore duplicato nei voti ufficiali");
      grades.set(officialId, { officialId, matchId:match.id, vote, fanta });
    }
  }
  return { matchday, matches, grades:[...grades.values()].sort((a,b) => Number(a.officialId)-Number(b.officialId)) };
}

const rome = new Intl.DateTimeFormat("en-GB", { timeZone:"Europe/Rome", year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23" });
export function romeClockKey(now = Date.now()) {
  const p = Object.fromEntries(rome.formatToParts(now).map(x => [x.type,x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
export function currentFcRound(calendar, now = Date.now()) {
  if (!calendar?.rounds?.length || calendar.season !== FC_SEASON || now-Date.parse(calendar.updatedAt)>21*86400000) return null;
  const local = romeClockKey(now);
  const ordered = calendar.rounds.slice().sort((a,b)=>a.matchday-b.matchday);
  const started = ordered.filter(round => round.matches.some(m => m.time && m.state !== "postponed" && kickoffKey(m) <= local));
  return started.at(-1) || ordered[0];
}
export function nearFcKickoff(round, now = Date.now()) {
  if (!round) return true;
  // Confronto tra orari locali di Roma; nessun fuso del browser/runner.
  const local = Date.parse(romeClockKey(now)+"Z");
  return round.matches.some(m => {
    const diff = local - Date.parse(kickoffKey(m)+"Z");
    return m.time && m.state !== "postponed" && diff >= -10*60000 && diff < 4*3600000;
  });
}
function validFixture(m, day) {
  return idPattern.test(m?.id ?? "") && m.matchday === day && datePattern.test(m.date) && Number.isFinite(Date.parse(m.date))
    && (m.time === null || timePattern.test(m.time)) && [m.home,m.away].every(t => idPattern.test(t?.id ?? "") && typeof t.name === "string" && typeof t.slug === "string")
    && ["pre","in","post","postponed","suspended"].includes(m.state);
}
export function validFcCalendar(payload, now = Date.now()) {
  return payload?.schema === 1 && payload.source === "Fantacalcio.it" && payload.season === FC_SEASON
    && Number.isFinite(Date.parse(payload.updatedAt)) && Date.parse(payload.updatedAt)<=now+5*60000
    && Array.isArray(payload.rounds) && payload.rounds.length > 0
    && new Set(payload.rounds.map(r=>r.matchday)).size===payload.rounds.length
    && payload.rounds.some(r=>r.matchday===payload.activeMatchday)
    && payload.rounds.every(r=>roundNumber(r.matchday) && Array.isArray(r.matches) && r.matches.length===10
      && new Set(r.matches.map(m=>m?.id)).size===10 && r.matches.every(m=>validFixture(m,r.matchday))
      && new Set(r.matches.flatMap(m=>[m.home.id,m.away.id])).size===20);
}
export function validFcGrades(payload, expectedRound, now = Date.now()) {
  if (!expectedRound || payload?.schema !== 1 || payload.source !== FC_GRADES_SOURCE || payload.season !== FC_SEASON
    || payload.matchday !== expectedRound.matchday || !Number.isFinite(Date.parse(payload.updatedAt))
    || Date.parse(payload.updatedAt)>now+5*60000 || !Array.isArray(payload.matches) || payload.matches.length!==10 || !Array.isArray(payload.grades)) return false;
  const expected = new Map(expectedRound.matches.map(m=>[m.id,m]));
  if (new Set(payload.matches.map(m=>m.id)).size!==10 || payload.matches.some(m=>!validFixture(m,payload.matchday)
    || expected.get(m.id)?.home.id!==m.home.id || expected.get(m.id)?.away.id!==m.away.id)) return false;
  const states = new Map(payload.matches.map(m=>[m.id,m.state]));
  const validNumber = (n,min,max) => n===null || Number.isFinite(n) && n>=min && n<=max;
  return new Set(payload.grades.map(g=>g.officialId)).size===payload.grades.length && payload.grades.every(g=>idPattern.test(g.officialId)
    && ["in","post"].includes(states.get(g.matchId)) && validNumber(g.vote,0,10) && validNumber(g.fanta,-15,35)
    && (g.vote!==null || g.fanta!==null));
}
