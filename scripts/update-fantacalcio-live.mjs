#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  FC_CALENDAR_URL, FC_GRADES_URL, FC_GRADES_SOURCE, FC_SEASON, parseFcCalendarRound,
  parseFcGrades, currentFcRound, nearFcKickoff, validFcCalendar, validFcGrades
} from "./fantacalcio-live.mjs";

const [mode, ...args] = process.argv.slice(2);
if (!["calendar","votes"].includes(mode)) throw new Error("Uso: node scripts/update-fantacalcio-live.mjs calendar|votes [--only-near-kickoff]");
const now = Date.now();
const updatedAt = new Date(now).toISOString();
const calendarPath = resolve("data/serie-a-giornate.json");
const votesPath = resolve("data/voti-live.json");
const existing = async path => { try { return JSON.parse(await readFile(path,"utf8")); } catch { return null; } };
async function fetchHtml(url) {
  const response = await fetch(url, {
    signal:AbortSignal.timeout(22000),
    headers:{ Accept:"text/html", "Accept-Language":"it-IT,it;q=0.9" }
  });
  if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) throw new Error(`Fantacalcio.it HTTP ${response.status}: pagina non disponibile`);
  return response.text();
}
async function save(file, payload) {
  await mkdir(dirname(file),{recursive:true});
  await writeFile(`${file}.tmp`,`${JSON.stringify(payload,null,2)}\n`,"utf8");
  await rename(`${file}.tmp`,file);
}
const comparable = (data, ...ignored) => JSON.stringify(data, (key,value)=>ignored.includes(key)?undefined:value);
const previousCalendar = await existing(calendarPath);

if (mode === "calendar") {
  const current = parseFcCalendarRound(await fetchHtml(FC_CALENDAR_URL));
  const previous = validFcCalendar(previousCalendar, now) ? previousCalendar : null;
  const rounds = new Map((previous?.rounds || []).map(r=>[r.matchday,r]));
  rounds.set(current.matchday,current);
  const days = Array.from({length:7},(_,i)=>current.matchday-2+i).filter(day=>day>=1&&day<=38&&day!==current.matchday);
  const refresh = !previous || now-Date.parse(previous.updatedAt)>=20*3600000 || previous.activeMatchday!==current.matchday;
  let failed = 0;
  const needs = days.filter(day=>refresh||!rounds.has(day));
  for (let i=0;i<needs.length;i+=3) {
    const batch = await Promise.allSettled(needs.slice(i,i+3).map(async day=>
      parseFcCalendarRound(await fetchHtml(`${FC_CALENDAR_URL}/${day}`),day)));
    for (const result of batch) {
      if (result.status === "fulfilled") rounds.set(result.value.matchday,result.value);
      else { failed++; console.warn(result.reason.message); }
    }
  }
  const payload={schema:1, source:"Fantacalcio.it", season:FC_SEASON, updatedAt, activeMatchday:current.matchday,
    rounds:[...rounds.values()].sort((a,b)=>a.matchday-b.matchday)};
  if (!validFcCalendar(payload,now)) throw new Error("Calendario non valido: mantengo la copia precedente");
  if (!previous || comparable(previous,"updatedAt")!==comparable(payload,"updatedAt") || refresh) {
    await save(calendarPath,payload);
    console.log(`Calendario: ${rounds.size} giornate, corrente ${current.matchday}.`);
  } else console.log("Calendario invariato.");
  if (failed) console.warn(`${failed} giornate non aggiornate; mantenuti i dati già disponibili.`);
} else {
  if (!validFcCalendar(previousCalendar,now)) throw new Error("Calendario ufficiale mancante: avvia prima l'aggiornamento giornate");
  const round = currentFcRound(previousCalendar,now);
  if (!round) throw new Error("Impossibile verificare la giornata corrente");
  if (args.includes("--only-near-kickoff") && !nearFcKickoff(round,now)) {
    console.log("Nessuna gara nella finestra di aggiornamento voti.");
  } else {
    const parsed = parseFcGrades(await fetchHtml(`${FC_GRADES_URL}/${FC_SEASON}/${round.matchday}`),round);
    const payload = {schema:1,source:FC_GRADES_SOURCE,season:FC_SEASON,updatedAt,...parsed};
    if (!validFcGrades(payload,round,now)) throw new Error("Voti non validi: mantengo la copia precedente");
    const previous = await existing(votesPath);
    if (validFcGrades(previous,round,now)) {
      const activeStates = new Map(payload.matches.map(m=>[m.id,m.state]));
      const newCounts = new Set(payload.grades.map(g=>g.matchId));
      if (previous.grades.some(g=>activeStates.get(g.matchId)==="post"&&!newCounts.has(g.matchId))) {
        throw new Error("Voti pubblicati mancanti nella nuova risposta: mantengo la copia precedente");
      }
    }
    const ttl = payload.matches.some(m=>m.state==="in") ? 18*60000 : 12*3600000;
    if (!previous || comparable(previous,"updatedAt")!==comparable(payload,"updatedAt") || now-Date.parse(previous.updatedAt)>ttl) {
      await save(votesPath,payload);
      console.log(`Giornata ${round.matchday}: ${payload.grades.length} voti/fantavoti dalla Redazione Fantacalcio.it.`);
    } else console.log("Voti ufficiali invariati.");
  }
}
