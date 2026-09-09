#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SOURCE_URL = "https://www.fantacalcio.it/quotazioni-fantacalcio";
const PROBABILITIES_URL = "https://www.fantacalcio.it/probabili-formazioni-serie-a";
const INJURIES_URL = "https://www.fantacalcio.it/infortunati-serie-a";
const SUSPENSIONS_URL = "https://www.fantacalcio.it/serie-a/squalificati";
const OUTPUT_FILE = resolve(process.argv[2] || "data/listone-live.json");

const TEAM_CODE_BY_NAME = {
  atalanta: "ATA", bologna: "BOL", cagliari: "CAG", como: "COM", fiorentina: "FIO",
  frosinone: "FRO", genoa: "GEN", inter: "INT", juventus: "JUV", lazio: "LAZ",
  lecce: "LEC", milan: "MIL", monza: "MON", napoli: "NAP", parma: "PAR",
  roma: "ROM", sassuolo: "SAS", torino: "TOR", udinese: "UDI", venezia: "VEN"
};

function decodeHtml(value = "") {
  const named = {
    amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ",
    agrave: "à", egrave: "è", eacute: "é", igrave: "ì", ograve: "ò", ugrave: "ù"
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function cleanText(value = "") {
  return decodeHtml(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function normalizeKey(value = "") {
  return cleanText(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function attr(html, name) {
  const match = html.match(new RegExp(`${name}=["']([^"']*)["']`, "i"));
  return match ? decodeHtml(match[1]).trim() : "";
}

function cell(html, className) {
  const match = html.match(new RegExp(`<(?:td|th)\\b[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/(?:td|th)>`, "i"));
  return match ? cleanText(match[1]) : "";
}

function parsePlayers(html) {
  const rows = html.match(/<tr\b[^>]*class=["'][^"']*\bplayer-row\b[^"']*["'][^>]*>[\s\S]*?<\/tr>/gi) || [];
  return rows.map((row, index) => {
    const link = row.match(/<a\b[^>]*class=["'][^"']*\bplayer-link\b[^"']*["'][^>]*href=["']([^"']+)["']/i);
    const id = link?.[1]?.match(/\/(\d+)\/?(?:[?#].*)?$/)?.[1] || "";
    const name = attr(row, "data-filter-keywords") || cell(row, "player-name");
    const role = attr(row, "data-filter-role-classic").toUpperCase();
    const teamCode = cell(row, "player-team").toUpperCase();
    const initialQuotation = Number(cell(row, "player-classic-initial-price"));
    const quotation = Number(cell(row, "player-classic-current-price"));
    const fvm = Number(cell(row, "player-classic-fvm"));
    return {
      officialId: id,
      name,
      role,
      teamCode,
      initialQuotation,
      quotation,
      fvm,
      active: true,
      sourceOrder: index
    };
  });
}

function parseProbabilities(html) {
  const matchday = Number(html.match(/<small\b[^>]*>\s*Giornata\s+(\d+)\s*<\/small>/i)?.[1]) || null;
  const blocks = html.split(/(?=<li\b[^>]*class=["'][^"']*\bmatch\b[^"']*\bmatch-item\b[^"']*["'])/i)
    .filter(block => /^\s*<li\b[^>]*class=["'][^"']*\bmatch\b[^"']*\bmatch-item\b/i.test(block));
  const byId = new Map();
  const matches = [];

  for (const block of blocks) {
    const openTag = block.match(/^\s*(<li\b[^>]*>)/i)?.[1] || "";
    const matchId = attr(openTag, "data-match-id");
    const matchHash = attr(openTag, "data-match-hash").toUpperCase();
    if (!matchId || !/^[A-Z]{3}-[A-Z]{3}$/.test(matchHash)) continue;

    const [homeCode, awayCode] = matchHash.split("-");
    const dateLabel = cleanText(block.match(/<div\b[^>]*class=["'][^"']*\bmatch-info\b[^"']*["'][^>]*>[\s\S]*?<div\b[^>]*class=["'][^"']*\bmatch-date\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || "");
    const officialUpdatedLabel = cleanText(block.match(/<div\b[^>]*class=["'][^"']*\blast-update\b[^"']*["'][^>]*>[\s\S]*?<span\b[^>]*class=["'][^"']*\bdate\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || "");
    matches.push({ matchId, matchHash, homeCode, awayCode, dateLabel, officialUpdatedLabel });

    const playerItems = block.match(/<li\b[^>]*class=["'][^"']*\bplayer-item\b[^"']*["'][^>]*>[\s\S]*?<\/li>/gi) || [];
    for (const item of playerItems) {
      const href = item.match(/<a\b[^>]*class=["'][^"']*\bplayer-link\b[^"']*["'][^>]*href=["']([^"']+)["']/i)?.[1] || "";
      const officialId = href.match(/\/(\d+)\/?(?:[?#].*)?$/)?.[1] || "";
      const percentage = Number(item.match(/aria-valuenow=["'](\d+(?:\.\d+)?)["']/i)?.[1]);
      if (!officialId || !Number.isFinite(percentage) || percentage < 0 || percentage > 100) continue;
      byId.set(officialId, { startingProbability: Math.round(percentage), probabilityMatchId: matchId, probabilityMatchHash: matchHash });
    }

    // Integra eventuali alternative presenti soltanto nei ballottaggi.
    const ballots = block.match(/<li\b[^>]*class=["'][^"']*\bdot\b[^"']*["'][^>]*>[\s\S]*?<\/li>/gi) || [];
    for (const ballot of ballots) {
      const href = ballot.match(/<a\b[^>]*class=["'][^"']*\bplayer-link\b[^"']*["'][^>]*href=["']([^"']+)["']/i)?.[1] || "";
      const officialId = href.match(/\/(\d+)\/?(?:[?#].*)?$/)?.[1] || "";
      const percentage = Number(ballot.match(/<strong\b[^>]*class=["'][^"']*\bpercentage\b[^"']*["'][^>]*>\s*(\d+(?:\.\d+)?)\s*%/i)?.[1]);
      if (!byId.has(officialId) && officialId && Number.isFinite(percentage) && percentage >= 0 && percentage <= 100) {
        byId.set(officialId, { startingProbability: Math.round(percentage), probabilityMatchId: matchId, probabilityMatchHash: matchHash });
      }
    }
  }

  if (matches.length < 9) throw new Error(`Probabili formazioni incomplete: solo ${matches.length} partite`);
  if (byId.size < 400) throw new Error(`Probabili formazioni incomplete: solo ${byId.size} calciatori`);
  return { matchday, matches, byId };
}

function parseUnavailable(html, type) {
  const blocks = html.split(/(?=<div\b[^>]*id=["']team-\d+["'][^>]*class=["'][^"']*\bteam-card\b[^"']*["'][^>]*>)/i)
    .filter(block => /^\s*<div\b[^>]*id=["']team-\d+["'][^>]*class=["'][^"']*\bteam-card\b/i.test(block));
  const byKey = new Map();
  const teams = new Set();

  for (const block of blocks) {
    const teamName = cleanText(block.match(/<span\b[^>]*class=["'][^"']*\bteam-name\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || "");
    const teamCode = TEAM_CODE_BY_NAME[normalizeKey(teamName)];
    if (!teamCode) continue;
    teams.add(teamCode);

    let relevant = block;
    if (type === "suspended") {
      const start = block.search(/<strong\b[^>]*class=["'][^"']*\blabel-danger\b/i);
      const end = block.search(/<strong\b[^>]*class=["'][^"']*\blabel-warn\b/i);
      relevant = start >= 0 ? block.slice(start, end > start ? end : undefined) : "";
    }

    const items = relevant.match(/<li\b[^>]*>[\s\S]*?<strong\b[^>]*class=["'][^"']*\bitem-name\b[^"']*["'][^>]*>[\s\S]*?<\/li>/gi) || [];
    for (const item of items) {
      const name = cleanText(item.match(/<strong\b[^>]*class=["'][^"']*\bitem-name\b[^"']*["'][^>]*>([\s\S]*?)<\/strong>/i)?.[1] || "");
      const note = cleanText(item.match(/<(?:p|div)\b[^>]*class=["'][^"']*\bitem-description\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:p|div)>/i)?.[1] || "");
      if (!name || normalizeKey(name) === "nessuno") continue;
      const mentionedMatchday = Number(note.match(/(\d+)\s*[aª°]?\s*giornata/i)?.[1]) || null;
      byKey.set(`${teamCode}|${normalizeKey(name)}`, { type, teamCode, name, note, mentionedMatchday });
    }
  }

  if (teams.size < 18) throw new Error(`${type === "injured" ? "Infortunati" : "Squalificati"} incompleti: solo ${teams.size} squadre`);
  return { byKey, teamCount: teams.size };
}

function validate(players) {
  const errors = [];
  if (players.length < 450) errors.push(`solo ${players.length} giocatori trovati`);
  const ids = new Set();
  const teams = new Set();
  const roles = new Set();
  for (const player of players) {
    if (!player.officialId || !player.name || !player.teamCode) errors.push(`riga incompleta: ${JSON.stringify(player)}`);
    if (!/^[PDCA]$/.test(player.role)) errors.push(`ruolo Classic non valido per ${player.name}: ${player.role}`);
    if (!Number.isFinite(player.quotation) || player.quotation < 0) errors.push(`quotazione non valida per ${player.name}`);
    if (ids.has(player.officialId)) errors.push(`ID duplicato: ${player.officialId}`);
    ids.add(player.officialId);
    teams.add(player.teamCode);
    roles.add(player.role);
  }
  if (teams.size < 18) errors.push(`solo ${teams.size} squadre trovate`);
  if (["P", "D", "C", "A"].some(role => !roles.has(role))) errors.push("manca almeno un ruolo Classic");
  if (errors.length) throw new Error(`Listone non valido: ${errors.slice(0, 8).join("; ")}`);
}

async function previousPayload() {
  try {
    const previous = JSON.parse(await readFile(OUTPUT_FILE, "utf8"));
    return previous && Array.isArray(previous.players) ? previous : { players: [] };
  } catch {
    return { players: [] };
  }
}

async function fetchHtml(url, label) {
  const response = await fetch(url, {
    headers: {
      "accept": "text/html,application/xhtml+xml",
      "accept-language": "it-IT,it;q=0.9,en;q=0.6",
      "user-agent": "Mozilla/5.0 (compatible; FantaListoneUpdater/2.0; +https://github.com/)"
    },
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`${label} ha risposto ${response.status}`);
  return response.text();
}

const [quotationsHtml, probabilitiesHtml, injuriesHtml, suspensionsHtml] = await Promise.all([
  fetchHtml(SOURCE_URL, "Fantacalcio.it quotazioni"),
  fetchHtml(PROBABILITIES_URL, "Fantacalcio.it probabili formazioni"),
  fetchHtml(INJURIES_URL, "Fantacalcio.it infortunati"),
  fetchHtml(SUSPENSIONS_URL, "Fantacalcio.it squalificati")
]);
const current = parsePlayers(quotationsHtml);
const probabilities = parseProbabilities(probabilitiesHtml);
const injuries = parseUnavailable(injuriesHtml, "injured");
const suspensions = parseUnavailable(suspensionsHtml, "suspended");
validate(current);

const previousData = await previousPayload();
const previous = previousData.players;
const previousById = new Map(previous.map(player => [String(player.officialId), player]));
let nextSlot = previous.reduce((max, player) => Math.max(max, Number(player.slot) || 0), -1) + 1;
const currentIds = new Set(current.map(player => player.officialId));

const players = current.map(player => {
  const old = previousById.get(player.officialId);
  const probability = probabilities.byId.get(player.officialId);
  const availabilityKey = `${player.teamCode}|${normalizeKey(player.name)}`;
  const suspended = suspensions.byKey.get(availabilityKey);
  const validSuspension = suspended && (!suspended.mentionedMatchday || suspended.mentionedMatchday === probabilities.matchday)
    ? suspended : null;
  const unavailable = validSuspension || injuries.byKey.get(availabilityKey) || null;
  const availabilityMatch = probabilities.matches.find(match => match.homeCode === player.teamCode || match.awayCode === player.teamCode);
  return {
    ...player,
    slot: Number.isInteger(old?.slot) ? old.slot : nextSlot++,
    addedAt: old?.addedAt || new Date().toISOString(),
    startingProbability: probability?.startingProbability ?? null,
    probabilityMatchId: probability?.probabilityMatchId ?? null,
    probabilityMatchHash: probability?.probabilityMatchHash ?? null,
    unavailability: unavailable?.type ?? null,
    unavailabilityNote: unavailable?.note ?? null,
    unavailabilityMatchday: unavailable ? probabilities.matchday : null,
    unavailabilityMatchHash: unavailable ? (availabilityMatch?.matchHash ?? null) : null
  };
});

for (const old of previous) {
  if (!currentIds.has(String(old.officialId))) {
    players.push({
      ...old,
      active: false,
      removedAt: old.removedAt || new Date().toISOString(),
      startingProbability: null,
      probabilityMatchId: null,
      probabilityMatchHash: null,
      unavailability: null,
      unavailabilityNote: null,
      unavailabilityMatchday: null,
      unavailabilityMatchHash: null
    });
  }
}

players.sort((a, b) => a.slot - b.slot);
const activeCount = players.filter(player => player.active).length;
const probabilityMatches = probabilities.matches.sort((a, b) => a.matchHash.localeCompare(b.matchHash));
const playersUnchanged = previous.length > 0 && JSON.stringify(previous) === JSON.stringify(players);
const probabilitiesUnchanged = previous.length > 0
  && Number(previousData.probabilityMatchday) === Number(probabilities.matchday)
  && JSON.stringify(previousData.probabilityMatches || []) === JSON.stringify(probabilityMatches)
  && previous.every((old, index) => old.startingProbability === players[index]?.startingProbability
    && old.probabilityMatchId === players[index]?.probabilityMatchId
    && old.probabilityMatchHash === players[index]?.probabilityMatchHash);
const availabilityUnchanged = previous.length > 0 && previous.every((old, index) =>
  old.unavailability === players[index]?.unavailability
  && old.unavailabilityNote === players[index]?.unavailabilityNote
  && old.unavailabilityMatchday === players[index]?.unavailabilityMatchday
  && old.unavailabilityMatchHash === players[index]?.unavailabilityMatchHash);
const unchanged = playersUnchanged && probabilitiesUnchanged && availabilityUnchanged;
const now = new Date().toISOString();
const payload = {
  schema: 3,
  updatedAt: unchanged
    ? previousData.updatedAt
    : now,
  source: SOURCE_URL,
  sourceLabel: "Fantacalcio.it · ruoli Classic, quotazioni, FVM, titolarità e indisponibili",
  probabilitySource: PROBABILITIES_URL,
  probabilityUpdatedAt: probabilitiesUnchanged ? (previousData.probabilityUpdatedAt || previousData.updatedAt || now) : now,
  probabilityMatchday: probabilities.matchday,
  probabilityMatches,
  probabilityPlayerCount: players.filter(player => player.active && Number.isFinite(player.startingProbability)).length,
  injurySource: INJURIES_URL,
  suspensionSource: SUSPENSIONS_URL,
  availabilityUpdatedAt: availabilityUnchanged ? (previousData.availabilityUpdatedAt || previousData.updatedAt || now) : now,
  injuredCount: players.filter(player => player.active && player.unavailability === "injured").length,
  suspendedCount: players.filter(player => player.active && player.unavailability === "suspended").length,
  activeCount,
  totalCount: players.length,
  players
};

await mkdir(dirname(OUTPUT_FILE), { recursive: true });
await writeFile(OUTPUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(`Listone aggiornato: ${activeCount} attivi, ${players.length} record totali, ${payload.injuredCount} infortunati, ${payload.suspendedCount} squalificati.`);
