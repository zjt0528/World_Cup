// ============================================================================
// Auto-fill finished World Cup scores into Supabase.
// Runs in GitHub Actions (Node 20+). Source: worldcup26.ir (free, no key).
// Matches API games to your matches by FIFA 3-letter code, then PATCHes scores.
// Required env (GitHub secrets):
//   SUPABASE_URL           e.g. https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY   service_role key (Project Settings -> API)
//   WC_EMAIL / WC_PASSWORD  any email+password (the script auto-registers once)
// ============================================================================
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const WC = "https://worldcup26.ir";
const WC_EMAIL = process.env.WC_EMAIL || "autofill@example.com";
const WC_PASSWORD = process.env.WC_PASSWORD || "autofill-pass-123";

// ---- helpers ----
const code = s => { const m = String(s || "").match(/\(([A-Z]{3})\)/); return m ? m[1] : null; };
const toISO = d => { // "06/11/2026 13:00" -> "2026-06-11"
  const m = String(d || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2,"0")}-${m[2].padStart(2,"0")}` : null;
};
const daysApart = (a, b) => { if (!a || !b) return 999; return Math.abs((new Date(a) - new Date(b)) / 86400000); };

async function wcAuthToken() {
  try {
    let r = await fetch(`${WC}/auth/authenticate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: WC_EMAIL, password: WC_PASSWORD }) });
    if (r.ok) return (await r.json()).token || null;
    r = await fetch(`${WC}/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "autofill", email: WC_EMAIL, password: WC_PASSWORD }) });
    if (r.ok) return (await r.json()).token || null;
  } catch (e) { /* fall through to no-token */ }
  return null;
}
async function wcGet(path, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  let r = await fetch(`${WC}${path}`, { headers });
  if (r.status === 401 && !token) { // demo needed auth after all
    const t = await wcAuthToken();
    if (t) r = await fetch(`${WC}${path}`, { headers: { Authorization: `Bearer ${t}` } });
  }
  if (!r.ok) throw new Error(`worldcup26 GET ${path} -> ${r.status} ${await r.text().catch(()=> "")}`);
  const j = await r.json();
  return Array.isArray(j) ? j : (j.data || j.results || j.games || j.teams || []);
}
async function sbGet(q) {
  const r = await fetch(`${SB_URL}/rest/v1/${q}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
  if (!r.ok) throw new Error(`supabase GET ${q} -> ${r.status} ${await r.text().catch(()=> "")}`);
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

// ---- core matching (exported-style for testing) ----
export function buildUpdates(apiTeams, apiGames, sbMatches) {
  const fifaById = {};
  apiTeams.forEach(t => { if (t && t.id != null && t.fifa_code) fifaById[String(t.id)] = String(t.fifa_code).toUpperCase(); });
  // index our matches by unordered code pair
  const byPair = {};
  sbMatches.forEach(m => {
    const h = code(m.home), a = code(m.away);
    if (!h || !a) return;
    const key = [h, a].sort().join("-");
    (byPair[key] = byPair[key] || []).push(m);
  });
  const updates = [];
  for (const g of apiGames) {
    if (String(g.finished).toUpperCase() !== "TRUE") continue;
    if (g.home_score == null || g.away_score == null) continue;
    const hc = fifaById[String(g.home_team_id)], ac = fifaById[String(g.away_team_id)];
    if (!hc || !ac) continue;
    const list = byPair[[hc, ac].sort().join("-")];
    if (!list || !list.length) continue;
    const date = toISO(g.local_date);
    // if several of our matches share this pair, pick the nearest date
    const sb = list.length === 1 ? list[0] : list.slice().sort((x, y) => daysApart(x.match_date, date) - daysApart(y.match_date, date))[0];
    const sbH = code(sb.home), sbA = code(sb.away);
    let ah, aa;
    if (sbH === hc && sbA === ac) { ah = +g.home_score; aa = +g.away_score; }
    else if (sbH === ac && sbA === hc) { ah = +g.away_score; aa = +g.home_score; }
    else continue;
    if (String(sb.actual_home) === String(ah) && String(sb.actual_away) === String(aa)) continue; // unchanged
    updates.push({ id: sb.id, actual_home: ah, actual_away: aa, label: `${hc} ${ah}-${aa} ${ac}` });
  }
  return updates;
}

async function main() {
  if (!SB_URL || !SB_KEY) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY"); process.exit(1); }
  const token = await wcAuthToken();
  const [apiTeams, apiGames] = await Promise.all([wcGet("/get/teams", token), wcGet("/get/games", token)]);
  const sbMatches = await sbGet("matches?select=id,match_date,home,away,actual_home,actual_away");
  console.log(`API: ${apiTeams.length} teams, ${apiGames.length} games | DB: ${sbMatches.length} matches`);
  const updates = buildUpdates(apiTeams, apiGames, sbMatches);
  if (!updates.length) { console.log("No new finished scores to apply."); return; }
  for (const u of updates) {
    await sbPatch(u.id, { actual_home: u.actual_home, actual_away: u.actual_away });
    console.log("Updated", u.id, "->", u.label);
  }
  console.log(`Done. ${updates.length} match(es) updated.`);
}

// only run when executed directly (so tests can import buildUpdates)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e.message || e); process.exit(1); });
}
