// A6 — avatar persistence to Supabase, in the web layer (Godot's web HTTPRequest
// callback is unreliable; browser fetch works). Signs in ANONYMOUSLY (no forced
// login — a real auth uid that RLS accepts) and reuses the same anonymous user
// per-device via a refresh token in localStorage, then upserts the avatar the
// player created (sh_avatar) into the Supabase `profiles` table. All failures are
// swallowed — the game runs regardless. Google login can replace the anon session
// later for durable cross-device identity.
(function () {
  var BASE = "https://dojgwvqmgplbfombrqic.supabase.co";
  var KEY = "sb_publishable_9OTQ1u2dCAf-aG-hfS7qkA_cnnIox4G";
  var H = { apikey: KEY, "Content-Type": "application/json" };

  async function session() {
    var rt = localStorage.getItem("sh_sess");
    if (rt) {
      var r = await fetch(BASE + "/auth/v1/token?grant_type=refresh_token",
        { method: "POST", headers: H, body: JSON.stringify({ refresh_token: rt }) });
      if (r.ok) { var j = await r.json(); localStorage.setItem("sh_sess", j.refresh_token); return j; }
      localStorage.removeItem("sh_sess"); // stale → fall through to a fresh anon user
    }
    var r2 = await fetch(BASE + "/auth/v1/signup", { method: "POST", headers: H, body: "{}" });
    var j2 = await r2.json();
    if (j2 && j2.refresh_token) localStorage.setItem("sh_sess", j2.refresh_token);
    return j2;
  }

  async function persist() {
    try {
      var raw = localStorage.getItem("sh_avatar");
      if (!raw) return;                       // nothing created yet
      var av = JSON.parse(raw);
      var s = await session();
      if (!s || !s.access_token) return;
      var body = { id: s.user.id, name: av.name || "Player", character: av };
      var w = await fetch(BASE + "/rest/v1/profiles", {
        method: "POST",
        headers: Object.assign({}, H, {
          Authorization: "Bearer " + s.access_token,
          Prefer: "resolution=merge-duplicates,return=minimal",
        }),
        body: JSON.stringify(body),
      });
      console.log("[persist] profile upsert " + w.status + " uid " + s.user.id.slice(0, 8));
    } catch (e) {
      console.log("[persist] skipped: " + (e && e.message));
    }
  }

  persist();
})();
