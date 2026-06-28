// ============================================================================
// Auto-fill finished World Cup scores into Supabase  (API-Football edition).
// Runs in GitHub Actions (Node 20+). One API call per run returns all fixtures.
// Required GitHub secrets:
//   SUPABASE_URL           e.g. https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY   service_role key (Project Settings -> API)
//   APIFOOTBALL_KEY        free key from https://dashboard.api-football.com
// Optional (defaults shown): APIFOOTBALL_LEAGUE=1  APIFOOTBALL_SEASON=2026
//
// Knockout matches are stored with placeholder slots like "TBD (1st Group A)"
// or "TBD (Winner of 53452545)". We resolve those to the real teams (same logic
// as the website) BEFORE matching, so knockout games auto-fill too.
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

// ----------------------------------------------------------------------------
// Bracket resolver: turns each match's home/away into the real team name.
// Group matches resolve to themselves; knockout slots resolve via the live
// group standings (FIFA 2026 tiebreakers), best-8 third places, and the
// winner/loser of feeder matches. Returns resolve(id, side) -> "Team (XXX)" | null.
// ----------------------------------------------------------------------------
function makeResolver(matches, gmeta) {
  gmeta = gmeta || {};
  const isNumv = x => x !== "" && x != null && !isNaN(Number(x));
  const byId = {}; matches.forEach(m => byId[m.id] = m);
  const gmatches = g => matches.filter(m => m.stage === "Group " + g);
  const GROUPS = [...new Set(matches.filter(m => /^Group /.test(m.stage || "")).map(m => m.stage.slice(6)))].sort();
  function rankTeams(arr, played) {
    const byPts = {}; arr.forEach(t => { (byPts[t.Pts] = byPts[t.Pts] || []).push(t); });
    const levels = Object.keys(byPts).map(Number).sort((a, b) => b - a); let out = [];
    levels.forEach(p => {
      const grp = byPts[p]; if (grp.length === 1) { out.push(grp[0]); return; }
      const set = new Set(grp.map(t => t.team)); const h = {}; grp.forEach(t => h[t.team] = { pts: 0, gd: 0, gf: 0 });
      played.forEach(m => { if (set.has(m.home) && set.has(m.away)) { const hs = +m.actual_home, as = +m.actual_away;
        h[m.home].gf += hs; h[m.away].gf += as; h[m.home].gd += hs - as; h[m.away].gd += as - hs;
        if (hs > as) h[m.home].pts += 3; else if (hs < as) h[m.away].pts += 3; else { h[m.home].pts++; h[m.away].pts++; } } });
      out = out.concat(grp.slice().sort((a, b) => h[b.team].pts - h[a.team].pts || h[b.team].gd - h[a.team].gd || h[b.team].gf - h[a.team].gf || b.GD - a.GD || b.GF - a.GF || a.team.localeCompare(b.team)));
    });
    return out;
  }
  function table(g) {
    const T = {}; const teams = new Set(); gmatches(g).forEach(m => { teams.add(m.home); teams.add(m.away); });
    teams.forEach(t => T[t] = { team: t, P: 0, GF: 0, GA: 0, Pts: 0 }); const played = [];
    gmatches(g).forEach(m => { if (!isNumv(m.actual_home) || !isNumv(m.actual_away)) return; const h = T[m.home], a = T[m.away], hs = +m.actual_home, as = +m.actual_away;
      h.P++; a.P++; h.GF += hs; h.GA += as; a.GF += as; a.GA += hs; if (hs > as) h.Pts += 3; else if (hs < as) a.Pts += 3; else { h.Pts++; a.Pts++; } played.push(m); });
    return rankTeams(Object.values(T).map(t => ({ ...t, GD: t.GF - t.GA })), played);
  }
  const started = g => gmatches(g).some(m => isNumv(m.actual_home) && isNumv(m.actual_away));
  function gpos(g, n) { const mm = gmeta[g] || { mode: "auto" }; if (mm.mode === "manual") return mm["pos" + n] || null;
    if (!started(g)) return null; const t = table(g)[n - 1]; return t ? t.team : null; }
  function thirdsRank() { const r = []; GROUPS.forEach(g => { if (started(g)) { const t = table(g)[2]; if (t) r.push({ grp: g, ...t }); } });
    r.sort((x, y) => y.Pts - x.Pts || y.GD - x.GD || y.GF - x.GF || x.team.localeCompare(y.team)); return r; }
  function autoThirdGroups() { return thirdsRank().slice(0, 8).map(t => t.grp); }
  function thirdGroups() { const auto = new Set(autoThirdGroups()); const set = new Set();
    GROUPS.forEach(g => { const ti = (gmeta[g] || {}).third_in || "auto"; if (ti === "yes") set.add(g); else if (ti === "no") {} else if (auto.has(g)) set.add(g); }); return set; }
  function parseSlot(text) { if (!text) return { type: "fixed", team: text }; let m;
    if (m = text.match(/1st Group ([A-L])\b/)) return { type: "pos", grp: m[1], n: 1 };
    if (m = text.match(/2nd Group ([A-L])\b/)) return { type: "pos", grp: m[1], n: 2 };
    if (m = text.match(/3rd Group ([A-L/]+)\)/)) return { type: "third", allowed: new Set(m[1].split("/")) };
    if (m = text.match(/Winner of (\d+)/)) return { type: "winner", id: m[1] };
    if (m = text.match(/Loser of (\d+)/)) return { type: "loser", id: m[1] };
    return { type: "fixed", team: text }; }
  function assignThirds(slots) {
    const qG = [...thirdGroups()].filter(g => gpos(g, 3)); const slotAssigned = {};
    function tryA(g, seen) { for (let i = 0; i < slots.length; i++) { if (!slots[i].allowed.has(g) || seen.has(i)) continue; seen.add(i);
      if (slotAssigned[i] === undefined || tryA(slotAssigned[i], seen)) { slotAssigned[i] = g; return true; } } return false; }
    qG.forEach(g => tryA(g, new Set()));
    const res = {}; for (const i in slotAssigned) { const g = slotAssigned[i]; res[slots[i].matchId + "|" + slots[i].side] = gpos(g, 3); } return res; }
  const slots = []; matches.filter(m => m.stage === "Round Of 32").forEach(m => ["home", "away"].forEach(side => {
    const p = parseSlot(side === "home" ? m.home : m.away); if (p.type === "third") slots.push({ matchId: m.id, side, allowed: p.allowed }); }));
  const tA = assignThirds(slots); const memo = {};
  function winner(id) { const m = byId[id]; if (!m || !isNumv(m.actual_home) || !isNumv(m.actual_away)) return null; const hs = +m.actual_home, as = +m.actual_away; let w = hs > as ? "home" : hs < as ? "away" : ((m.pen_winner || "").toLowerCase() === "home" ? "home" : (m.pen_winner || "").toLowerCase() === "away" ? "away" : null); return w ? resolve(id, w) : null; }
  function loser(id) { const m = byId[id]; if (!m || !isNumv(m.actual_home) || !isNumv(m.actual_away)) return null; const hs = +m.actual_home, as = +m.actual_away; let l = hs > as ? "away" : hs < as ? "home" : ((m.pen_winner || "").toLowerCase() === "home" ? "away" : (m.pen_winner || "").toLowerCase() === "away" ? "home" : null); return l ? resolve(id, l) : null; }
  function resolve(id, side) { const k = id + "|" + side; if (k in memo) return memo[k]; memo[k] = null;
    const m = byId[id]; if (!m) return null; const text = side === "home" ? m.home : m.away; const p = parseSlot(text); let out = null;
    if (p.type === "fixed") out = p.team; else if (p.type === "pos") out = gpos(p.grp, p.n);
    else if (p.type === "third") out = tA[k] || null; else if (p.type === "winner") out = winner(p.id); else if (p.type === "loser") out = loser(p.id);
    memo[k] = out; return out; }
  return resolve;
}

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

// match API-Football fixtures to our matches by FIFA code pair (teams resolved via the bracket)
export function buildUpdates(fixtures, sbMatches, groupMeta) {
  const resolve = makeResolver(sbMatches, groupMeta);
  const codeCache = {};
  const getCodes = m => codeCache[m.id] || (codeCache[m.id] = { h: code(resolve(m.id, "home")), a: code(resolve(m.id, "away")) });
  const byPair = {};
  sbMatches.forEach(m => { const { h, a } = getCodes(m); if (!h || !a) return; const k = [h, a].sort().join("-"); (byPair[k] = byPair[k] || []).push(m); });
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
    const { h: sbH, a: sbA } = getCodes(sb);
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
  const sbMatches = await sbGet("matches?select=id,match_date,stage,home,away,actual_home,actual_away,status,minute,pen_winner");
  let groupMeta = {};
  try { const gm = await sbGet("group_meta?select=*"); (gm || []).forEach(r => groupMeta[r.grp] = r); } catch (e) { /* table optional */ }
  console.log(`API-Football: ${fixtures.length} fixtures | DB: ${sbMatches.length} matches`);
  const updates = buildUpdates(fixtures, sbMatches, groupMeta);
  if (!updates.length) { console.log("Nothing to update."); return; }
  // 1) Write every score/status/minute FIRST (fast, no per-match API calls), so two
  //    simultaneous live matches never block each other on a slow/limited detail fetch.
  for (const u of updates) {
    await sbPatch(u.id, { actual_home: u.actual_home, actual_away: u.actual_away, status: u.status, minute: u.minute });
    console.log("Score", u.id, "->", u.label);
  }
  // 2) Then fetch + write live details in parallel (best-effort; failures don't stall scores).
  const live = updates.filter(u => u.live);
  await Promise.all(live.map(async u => {
    try {
      const details = await fetchDetails(u.fixtureId, u.homeCode, u.awayCode);
      if (details) await sbPatch(u.id, { details });
    } catch (e) { console.log("details failed for", u.id, "-", e.message || e); }
  }));
  console.log(`Done. ${updates.length} match(es) updated (${live.length} live).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e.message || e); process.exit(1); });
}
