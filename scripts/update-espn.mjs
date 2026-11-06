#!/usr/bin/env node
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fetchScoreboard, futureFixtures, collectLineups } from "./espn-feed.mjs";

const output = resolve(process.argv[2] || "data/serie-a-live.json");
const now = Date.now();
const data = await fetchScoreboard(new Date(now - 60 * 86400000), new Date(now + 60 * 86400000));
const fixtures = futureFixtures(data.events, now);
const { lineups, expectedTeamCount, missingTeamIds } = await collectLineups(data.events.filter(event => Date.parse(event.date) <= now));
if (!fixtures.length) throw new Error("Nessuna partita futura: non sovrascrivo il calendario salvato.");
if (lineups.length < Math.min(18, expectedTeamCount)) throw new Error("Troppe formazioni mancanti: mantengo il file precedente.");
const payload = {
  schema: 1, source: "ESPN", updatedAt: new Date(now).toISOString(),
  season: data.leagues?.[0]?.season?.displayName || "", expectedTeamCount, missingTeamIds, fixtures, lineups
};
// Rinnova il controllo almeno una volta al giorno, senza commit inutili ogni 4 ore.
let previous = null;
try { previous = JSON.parse(await readFile(output, "utf8")); } catch {}
if (previous && JSON.stringify({ ...previous, updatedAt: null }) === JSON.stringify({ ...payload, updatedAt: null })
    && now - Date.parse(previous.updatedAt) < 20 * 3600000) {
  console.log("Calendario e formazioni ESPN invariati.");
} else {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(`${output}.tmp`, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(`${output}.tmp`, output);
  console.log(`ESPN: ${fixtures.length} partite future, ${lineups.length}/${expectedTeamCount} formazioni complete.`);
}
