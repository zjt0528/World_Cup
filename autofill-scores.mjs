// ============================================================================
// Auto-fill finished World Cup scores into Supabase  (API-Football edition).
// Runs in GitHub Actions (Node 20+). One API call per run returns all fixtures.
// Required GitHub secrets:
//   SUPABASE_URL           e.g. https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY   service_role key (Project Settings -> API)
//   APIFOOTBALL_KEY        free key from https://dashboard.api-football.com
// Optional (defaults shown): APIFOOTBALL_LEAGUE=1  APIFOOTBALL_SEASON=2026
// ============================================================================
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const AF_KEY = process.env.APIFOOTBALL_KEY;
const AF_BASE = "https://v3.football.api-sports.io";
const LEAGUE = process.env.APIFOOTBALL_LEAGUE || "1";   // 1 = FIFA World Cup
const SEASON = process.env.APIFOOTBALL_SEASON || "2026";
const FINISHED = new Set(["FT", "AET", "PEN"]);
const LIVE = new Set(["1H", "2H", "HT", "ET", "BT", "P", "SUSP", "INT", "LIVE"]);

// normalized team name -> FIFA 3-letter code (matches the codes in your match names)
const NAME2CODE = {
  mexico:"MEX", southafrica:"RSA", southkorea:"KOR", korearepublic:"KOR", korea:"KOR",
  czechia:"CZE", czechrepublic:"CZE", canada:"CAN", switzerland:"SUI", qatar:"QAT",
  bosniaandherzegovina:"BIH", bosnia:"BIH", bosniaherzegovina:"BIH", brazil:"BRA",
  morocco:"MAR", haiti:"HTI", scotland:"SCO", usa:"USA", unitedstates:"USA",
  unitedstatesofamerica:"USA", paraguay:"PAR", australia:"AUS", turkey:"TUR", turkiye:"TUR",
  germany:"GER", ivorycoast:"CIV", cotedivoire:"CIV", ecuador:"ECU", curacao:"CUW",
  netherlands:"NED", sweden:"SWE", tunisia:"TUN", japan:"JPN", belgium:"BEL",
  iran:"IRI", iranislamicrepublic:"IRI", islamicrepublicofiran:"IRI", newzealand:"NZL",
  egypt:"EGY", spain:"ESP", saudiarabia:"KSA", uruguay:"URU", capeverde:"CPV", caboverde:"CPV", capeverdeislands:"CPV",
  france:"FRA", iraq:"IRQ", norway:"NOR", senegal:"SEN", argentina:"ARG", austria:"AUT",
  jordan:"JOR", algeria:"DZA", portugal:"POR", uzbekistan:"UZB", colombia:"COL",
  drcongo:"COD", congodr:"COD", democraticrepublicofthecongo:"COD", congodemocraticrepublic:"COD",
  england:"ENG", ghana:"GHA", panama:"PAN", croatia:"CRO",
};
// lowercase + decompose accents (NFD) + keep only a-z0-9 (this also drops the accent marks)
const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");
const codeOfName = n => NAME2CODE[norm(n)] || null;
const code = s => { const m = String(s || "").match(/\(([A-Z]{3})\)/); return m ? m[1] : null; };
const daysApart = (a, b) => { if (!a || !b) return 999; return Math.abs((new Date(a) - new Date(b)) / 86400000); };

async function afGet(path) {
  const r = await fetch(`${AF_BASE}${path}`, { headers: { "x-apisports-key": AF_KEY } });
  if (!r.ok) throw new Error(`API-Football ${path} -> ${r.status} ${await r.text().catch(()=> "")}`);
  const j = await r.json();
  const errs = j.errors;
  if (errs && (Array.isArray(errs) ? errs.length : Object.keys(errs).length)) throw new Error("API-Football error: " + JSON.stringify(errs));
  return j.response || [];
}
async function sbGet(q) {
  const r = await fetch(`${SB_URL}/rest/v1/${q}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
  if (!r.ok) throw new Error(`supabase GET -> ${r.status} ${await r.text().catch(()=> "")}`);
  return r.json();
}
async function sbPatch(id, body) {
  const r = await fetch(`${SB_URL}/rest/v1/matches?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`supabase PATCH ${id} -> ${r.status} ${await r.text().catch(()=> "")}`);
}

// For a live fixture: pull goals + cards (events) and stats, mapped to home/away.
async function fetchDetails(fixtureId, homeCode, awayCode) {
  if (!fixtureId) return null;
  const sideOf = name => { const c = codeOfName(name); return c === homeCode ? "home" : (c === awayCode ? "away" : null); };
  let ev = [], st = [];
  try { ev = await afGet(`/fixtures/events?fixture=${fixtureId}`); } catch (e) {}
  try { st = await afGet(`/fixtures/statistics?fixture=${fixtureId}`); } catch (e) {}
  const events = [];
  for (const e of (ev || [])) {
    const side = sideOf(e.team && e.team.name); if (!side) continue;
    const min = e.time && e.time.elapsed; const player = (e.player && e.player.name) || "";
    if (e.type === "Goal" && e.detail !== "Missed Penalty") {
      const scoring = e.detail === "Own Goal" ? (side === "home" ? "away" : "home") : side;
      events.push({ team: scoring, player, minute: min, type: "goal", detail: e.detail });
    } else if (e.type === "Card") {
      events.push({ team: side, player, minute: min, type: "card", detail: e.detail });
    }
  }
  events.sort((a, b) => (a.minute || 0) - (b.minute || 0));
  const stats = {};
  for (const s of (st || [])) {
    const side = sideOf(s.team && s.team.name); if (!side) continue;
    const get = t => { const f = (s.statistics || []).find(x => x.type === t); return f ? f.value : null; };
    stats[side] = { poss: get("Ball Possession"), shots: get("Total Shots"), sot: get("Shots on Goal"), corners: get("Corner Kicks") };
  }
  return { events, stats };
}

// match API-Football fixtures to our matches by FIFA code pair
export function buildUpdates(fixtures, sbMatches) {
  const byPair = {};
  sbMatches.forEach(m => { const h = code(m.home), a = code(m.away); if (!h || !a) return; const k = [h, a].sort().join("-"); (byPair[k] = byPair[k] || []).push(m); });
  const updates = [], unmatched = new Set();
  for (const f of fixtures) {
    const st = f.fixture && f.fixture.status && f.fixture.status.short;
    const isFinal = FINISHED.has(st), isLive = LIVE.has(st);
    if (!isFinal && !isLive) continue;
    const hn = f.teams && f.teams.home && f.teams.home.name;
    const an = f.teams && f.teams.away && f.teams.away.name;
    const hc = codeOfName(hn), ac = codeOfName(an);
    if (!hc) { if (hn) unmatched.add(hn); continue; }
    if (!ac) { if (an) unmatched.add(an); continue; }
    const hs = f.goals && f.goals.home, as = f.goals && f.goals.away;
    if (hs == null || as == null) continue;
    const list = byPair[[hc, ac].sort().join("-")];
    if (!list || !list.length) continue;
    const date = String((f.fixture && f.fixture.date) || "").slice(0, 10);
    const sb = list.length === 1 ? list[0] : list.slice().sort((x, y) => daysApart(x.match_date, date) - daysApart(y.match_date, date))[0];
    const sbH = code(sb.home), sbA = code(sb.away);
    let ah, aa;
    if (sbH === hc && sbA === ac) { ah = +hs; aa = +as; }
    else if (sbH === ac && sbA === hc) { ah = +as; aa = +hs; }
    else continue;
    const minute = isLive ? (f.fixture.status.elapsed ?? null) : null;
    if (String(sb.actual_home) === String(ah) && String(sb.actual_away) === String(aa) && sb.status === st && (sb.minute ?? null) === minute) continue;
    updates.push({ id: sb.id, actual_home: ah, actual_away: aa, status: st, minute, live: isLive, fixtureId: f.fixture && f.fixture.id, homeCode: sbH, awayCode: sbA, label: `${hc} ${ah}-${aa} ${ac} [${st}]` });
  }
  if (unmatched.size) console.log("Note: unrecognized team names (tell me to add them):", [...unmatched].join(", "));
  return updates;
}

async function main() {
  if (!SB_URL || !SB_KEY) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY"); process.exit(1); }
  if (!AF_KEY) { console.error("Missing APIFOOTBALL_KEY"); process.exit(1); }
  const fixtures = await afGet(`/fixtures?league=${LEAGUE}&season=${SEASON}`);
  const sbMatches = await sbGet("matches?select=id,match_date,home,away,actual_home,actual_away,status,minute");
  console.log(`API-Football: ${fixtures.length} fixtures | DB: ${sbMatches.length} matches`);
  const updates = buildUpdates(fixtures, sbMatches);
  if (!updates.length) { console.log("Nothing to update."); return; }
  for (const u of updates) {
    const body = { actual_home: u.actual_home, actual_away: u.actual_away, status: u.status, minute: u.minute };
    if (u.live) body.details = await fetchDetails(u.fixtureId, u.homeCode, u.awayCode);
    await sbPatch(u.id, body);
    console.log("Updated", u.id, "->", u.label);
  }
  console.log(`Done. ${updates.length} match(es) updated.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e.message || e); process.exit(1); });
}
