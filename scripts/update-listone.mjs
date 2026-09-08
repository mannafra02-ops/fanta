#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SOURCE_URL = "https://www.fantacalcio.it/quotazioni-fantacalcio";
const OUTPUT_FILE = resolve(process.argv[2] || "data/listone-live.json");

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

async function previousList() {
  try {
    const previous = JSON.parse(await readFile(OUTPUT_FILE, "utf8"));
    return Array.isArray(previous.players) ? previous.players : [];
  } catch {
    return [];
  }
}

const response = await fetch(SOURCE_URL, {
  headers: {
    "accept": "text/html,application/xhtml+xml",
    "accept-language": "it-IT,it;q=0.9,en;q=0.6",
    "user-agent": "Mozilla/5.0 (compatible; FantaListoneUpdater/1.0; +https://github.com/)"
  },
  redirect: "follow"
});

if (!response.ok) throw new Error(`Fantacalcio.it ha risposto ${response.status}`);
const current = parsePlayers(await response.text());
validate(current);

const previous = await previousList();
const previousById = new Map(previous.map(player => [String(player.officialId), player]));
let nextSlot = previous.reduce((max, player) => Math.max(max, Number(player.slot) || 0), -1) + 1;
const currentIds = new Set(current.map(player => player.officialId));

const players = current.map(player => {
  const old = previousById.get(player.officialId);
  return {
    ...player,
    slot: Number.isInteger(old?.slot) ? old.slot : nextSlot++,
    addedAt: old?.addedAt || new Date().toISOString()
  };
});

for (const old of previous) {
  if (!currentIds.has(String(old.officialId))) {
    players.push({
      ...old,
      active: false,
      removedAt: old.removedAt || new Date().toISOString()
    });
  }
}

players.sort((a, b) => a.slot - b.slot);
const activeCount = players.filter(player => player.active).length;
const unchanged = previous.length > 0 && JSON.stringify(previous) === JSON.stringify(players);
const payload = {
  schema: 1,
  updatedAt: unchanged
    ? JSON.parse(await readFile(OUTPUT_FILE, "utf8")).updatedAt
    : new Date().toISOString(),
  source: SOURCE_URL,
  sourceLabel: "Fantacalcio.it · ruoli Classic, quotazioni e FVM",
  activeCount,
  totalCount: players.length,
  players
};

await mkdir(dirname(OUTPUT_FILE), { recursive: true });
await writeFile(OUTPUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(`Listone aggiornato: ${activeCount} attivi, ${players.length} record totali.`);
