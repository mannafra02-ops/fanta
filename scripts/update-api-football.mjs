import fs from "node:fs";

const KEY=process.env.API_FOOTBALL_KEY;
if(!KEY) throw new Error("Secret API_FOOTBALL_KEY mancante");
const BASE="https://v3.football.api-sports.io";
const LEAGUE=135;
const SEASON=Number(process.env.FOOTBALL_SEASON||2026);
let requestsUsed=0;

async function api(path,params={}){
  const url=new URL(BASE+path);
  Object.entries(params).forEach(([k,v])=>url.searchParams.set(k,String(v)));
  const response=await fetch(url,{headers:{"x-apisports-key":KEY}});
  requestsUsed++;
  if(!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const body=await response.json();
  if(body.errors&&Object.keys(body.errors).length) throw new Error(`${path}: ${JSON.stringify(body.errors)}`);
  return Array.isArray(body.response)?body.response:[];
}

const now=new Date();
const day=d=>d.toISOString().slice(0,10);
const tomorrow=new Date(now.getTime()+36*60*60*1000);

const [fixturesRaw,injuriesRaw,nearRaw]=await Promise.all([
  api("/fixtures",{league:LEAGUE,season:SEASON,next:20}),
  api("/injuries",{league:LEAGUE,season:SEASON}),
  api("/fixtures",{league:LEAGUE,season:SEASON,from:day(now),to:day(tomorrow)})
]);

const fixtures=fixturesRaw.map(x=>({
  id:x.fixture.id,date:x.fixture.date,status:x.fixture.status?.short,round:x.league?.round,
  venue:x.fixture.venue?.name||null,home:x.teams.home,away:x.teams.away,goals:x.goals
}));

const injuries=injuriesRaw.map(x=>({
  player:x.player,team:x.team,fixture:{id:x.fixture?.id,date:x.fixture?.date},type:x.player?.type||null,reason:x.player?.reason||null
}));

const candidates=nearRaw.slice(0,10);
const lineups=[];
for(const fixture of candidates){
  const response=await api("/fixtures/lineups",{fixture:fixture.fixture.id});
  if(!response.length) continue;
  lineups.push({
    fixtureId:fixture.fixture.id,date:fixture.fixture.date,
    teams:response.map(t=>({team:t.team,formation:t.formation||null,coach:t.coach||null,startXI:(t.startXI||[]).map(x=>x.player),substitutes:(t.substitutes||[]).map(x=>x.player)}))
  });
}

const output={meta:{configured:true,league:LEAGUE,season:SEASON,updatedAt:new Date().toISOString(),requestsUsed},fixtures,injuries,lineups};
fs.mkdirSync("data",{recursive:true});
fs.writeFileSync("data/api-football.json",JSON.stringify(output,null,2)+"\n");
console.log(`Aggiornato: ${fixtures.length} partite, ${injuries.length} infortuni, ${lineups.length} formazioni, ${requestsUsed} richieste`);
