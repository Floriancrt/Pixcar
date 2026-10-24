// Espace Pro, tableau de bord et suivi des interventions (docs/calendrier-avance.md, lot 3c) de bout en bout : page construite comme la
// version publiée (politique de sécurité), vraie API (PGlite), horloges de la page et de l'API arrêtées un mercredi à 10:30. Un garage en
// mode avancé (trois mécaniciens dont une absente à 15:00, deux ponts dont l'un en maintenance demain, un poste pneus en maintenance, la
// climatisation faite mais que personne ne sait faire) et la journée : une voiture prête, deux en cours (en retard), une pas arrivée,
// une demande à confirmer, un rendez-vous pris par téléphone. Parcours : cinq chiffres → liste du jour (états, menu d'actions au clavier,
// voiture reçue, voiture prête avec le client prévenu par e-mail) → filtre par un chiffre → demandes à traiter (confirmer) → équipe et
// postes → points d'attention → raccourcis personnalisés (gardés sur le compte) → client déjà sur place (formulaire du Planning) →
// ouvrir dans le planning (fiche, avancement) → page de suivi du client → Prestations & tarifs → mode simple → téléphone ; axe.
//   node tests/pro-dashboard.js
delete process.env.PIXCAR_ROOT;
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { ROOT } = require("./harness");
const { serveDir } = require("./static-server");
const { startApi } = require("./api-harness");

const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond });
  if (!cond) console.log("  FAIL:", name, "|", String(detail).slice(0, 600));
};
const AXE = fs.readFileSync(path.join(ROOT, "node_modules/axe-core/axe.min.js"), "utf8");
const OUT = path.join(__dirname, ".out", "pro-dashboard-site");
const SHOTS = path.join(__dirname, ".out", "shots");
const SRC = process.env.PIXCAR_SRC || path.join(ROOT, "src");
const BUILD = process.env.PIXCAR_BUILD ? path.resolve(ROOT, process.env.PIXCAR_BUILD) : path.join(ROOT, "scripts/build.mjs");
const LEGAL = { editorLine: "Pixcar est édité à titre non professionnel par Jeanne Exemple, responsable du traitement des données décrites ici.", contact: "contact@exemple.test", hostPages: "GitHub, Inc. (GitHub Pages), États-Unis", hostApi: "Amazon Web Services EMEA SARL, Luxembourg (région Europe, Stockholm)", repairRetentionMonths: 24, updated: "3 octobre 2026" };
const HERE = { lat: 43.2174, lon: 1.1014 };
const GARAGE = "aaaaaaaa-0000-4000-8000-000000000003";
const CONTACTS = [{ id: GARAGE, name: "Garage Démo Atelier", addr: "14 rue de l'Exemple, 31220 Cazères", pc: "31220", ...HERE, emails: ["contact@garage-atelier.fr"], phones: ["+33561000003"] }];
const ACCOUNT = "sub-dash";
const TOKEN = `tok.${ACCOUNT}.1`;
const DAY = [["08:00", "12:00"], ["14:00", "18:00"]];
const WEEK = { mo: DAY, tu: DAY, we: DAY, th: DAY, fr: DAY };
const NOTIFY = "atelier@garage-atelier.fr";
// l'avant-veille (rendez-vous du matin : le garage répond avant midi la veille), la veille (la demande encore à confirmer le jour même,
// heure limite à midi), le jour même à 10:30 (le tableau de bord), le lendemain
const EARLY = "2026-11-02", PREV = "2026-11-03", D = "2026-11-04", NEXT = "2026-11-05";

(async () => {
  const R = await import("../src/js/shared/rdv.js");
  const at = (iso, hhmm) => R.parisInstant(iso, R.minOf(hhmm));
  const T = at(D, "10:30");
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, "empty"), { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const srv = await serveDir(path.join(OUT, "empty"));
  const { AuthError } = await import("../server/lib/jwt.mjs");
  const { parseContactRows } = await import("../server/lib/contact.mjs");
  const api = await startApi({
    origin: srv.url,
    env: { PRO_ENABLED: "1", RDV_ENABLED: "1" },
    proOptions: {
      verifier: async (token) => {
        const m = /^tok\.(sub-[\w-]+)\.\d+$/.exec(token);
        if (!m) throw new AuthError("jeton refusé");
        return { sub: m[1] };
      },
      sirene: async () => null,
    },
  });
  const setClock = (ms) => (api.clock.skew += ms - api.now()); // l'horloge de l'API saute à cet instant, puis avance en temps réel
  setClock(at(EARLY, "10:00"));
  await api.app.pro.repo.upsertContacts(parseContactRows(CONTACTS).rows, "test");
  await api.db.query("INSERT INTO pro_claims (id, account_id, garage_id, siret, status, channel, holder_name, holder_role, target_hash, target_hint, verified_at) VALUES (gen_random_uuid(), $1, $2, '73282932000090', 'verified', 'email', 'Camille Durand', 'manager', $3, 'c•••••@garage-atelier.fr', now())", [ACCOUNT, GARAGE, "c".repeat(64)]);
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(api.url + p, { method, headers: { origin: srv.url, ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const pro = (method, p, body) => call(method, `/v1/pro/garages/${GARAGE}${p}`, body, { authorization: `Bearer ${TOKEN}` });
  const outbox = api.app.pro.senders.outbox;
  const lastCode = (to) => {
    const m = outbox.filter((x) => x.channel === "rdv" && x.target === to && /code (\d{6})/.test(x.subject)).at(-1);
    return m && /code (\d{6})/.exec(m.subject)[1];
  };

  // ---- le garage : ouvert, rendez-vous en ligne, calendrier avancé
  let ok =
    (await pro("PUT", "/profile", { hours: WEEK })).status === 200 &&
    (await Promise.all([["vidange", 45], ["plaq_av", 60], ["clim", 45]].map(([s, m]) => pro("PUT", `/services/${s}`, { offered: true, minutes: m })))).every((r) => r.status === 200) &&
    (await pro("POST", "/rdv/notify", { email: NOTIFY })).status === 200 &&
    (await pro("POST", "/rdv/notify/code", { code: lastCode(NOTIFY) })).status === 200 &&
    (await pro("POST", "/rdv/slots", { name: "Journée", days: ["mo", "tu", "we", "th", "fr"], start: "08:00", end: "18:00", mode: "hour", capacity: 2, services: ["vidange", "plaq_av"] })).status === 200 &&
    (await pro("PUT", "/rdv/settings", { enabled: true, minDelayH: 0, horizonDays: 28 })).status === 200;
  const s = (await pro("POST", "/rdv/calendar/start")).body;
  const skill = (label) => s.skills.find((k) => k.label === label).id;
  await pro("PUT", "/rdv/calendar/settings", { receptionMin: 0, returnMin: 15, step: 5 });
  const both = [skill("Entretien courant"), skill("Freinage")];
  const paul = (await pro("POST", "/rdv/calendar/staff", { name: "Paul Martin", skills: both })).body.saved;
  const lea = (await pro("POST", "/rdv/calendar/staff", { name: "Léa", skills: both })).body.saved;
  const sami = (await pro("POST", "/rdv/calendar/staff", { name: "Sami", skills: both })).body.saved;
  const lift1 = (await pro("POST", "/rdv/calendar/resources", { name: "Pont 1", type: "lift" })).body.saved;
  const lift2 = (await pro("POST", "/rdv/calendar/resources", { name: "Pont 2", type: "lift" })).body.saved;
  const tyre = (await pro("POST", "/rdv/calendar/resources", { name: "Pneus", type: "tyre" })).body.saved;
  await pro("POST", "/rdv/calendar/resources", { name: "Diagnostic", type: "diag" });
  const act = await pro("POST", "/rdv/calendar/activate");
  ok = ok && paul && lea && sami && lift1 && lift2 && tyre && act.status === 200;
  check("setup: advanced mode with three mechanics and four posts", ok, JSON.stringify(act.body).slice(0, 300));
  const un = await Promise.all([
    pro("POST", "/rdv/calendar/unavail", { target: "staff", targetId: sami, kind: "leave", first: D, from: "15:00" }),
    pro("POST", "/rdv/calendar/unavail", { target: "resource", targetId: tyre, kind: "maintenance", first: D }),
    pro("POST", "/rdv/calendar/unavail", { target: "resource", targetId: lift2, kind: "maintenance", first: NEXT, from: "09:00", to: "11:00" }),
  ]);
  check("setup: Sami away from 15:00, the tyre post down today, Pont 2 down tomorrow morning", un.every((r) => r.status === 200), JSON.stringify(un.map((r) => r.body)).slice(0, 400));
  // ---- la veille : les rendez-vous du jour
  async function book(time, service, name, email, car, plate) {
    const d = await call("POST", "/v1/rdv/requests", { garageId: GARAGE, services: [{ id: service, qty: 1 }], day: D, time, name, email, phone: "06 39 98 12 34", car, year: 2019, plate, message: "", remindPrice: false });
    const c = await call("POST", `/v1/rdv/requests/${d.body && d.body.id}/code`, { code: lastCode(email) });
    if (c.status !== 200) console.log("  booking", time, d.status, JSON.stringify(d.body).slice(0, 200), c.status);
    return c.status === 200 ? { id: d.body.id, token: c.body.token } : null;
  }
  const sophie = await book("08:00", "vidange", "Sophie Lambert", "sophie@example.com", "Peugeot 3008", "DD-654-IJ");
  const julien = await book("08:30", "vidange", "Julien Roux", "julien@example.com", "Peugeot 208", "FY-123-AB");
  const marie = await book("09:00", "plaq_av", "Marie Curie", "marie@example.com", "Renault Clio", "AA-456-CD");
  const lucas = await book("09:30", "vidange", "Lucas Petit", "lucas@example.com", "Renault Captur", "EE-987-KL");
  const accepted = await Promise.all([sophie, julien, marie, lucas].map((q) => q && pro("POST", `/rdv/requests/${q.id}/accept`, {})));
  const phone = await pro("POST", "/rdv/calendar/blocks", { kind: "job", label: "M. Martin (tél.)", services: [{ id: "plaq_av" }], day: D, time: "14:00" });
  setClock(at(PREV, "10:00"));
  const thomas = await book("14:30", "vidange", "Thomas Bernard", "thomas@example.com", "Citroën C3", "BB-789-EF");
  check("setup: five bookings (four accepted, one to confirm) and a phone booking", sophie && julien && marie && lucas && thomas && accepted.every((r) => r && r.status === 200) && phone.status === 201, JSON.stringify([accepted.map((r) => r && r.status), phone.body]));
  // ---- le jour même, 10:30 : Sophie prête (sans e-mail), Julien en cours, Marie reçue, Lucas pas arrivé
  setClock(T);
  const work = (q, status, extra = {}) => pro("POST", `/rdv/calendar/work/${q.id}`, { status, ...extra });
  const steps = [];
  for (const [q, list] of [[sophie, ["received", "in_progress", "done"]], [julien, ["received", "in_progress"]], [marie, ["received"]]])
    for (const st of list) steps.push((await work(q, st, st === "done" ? { notify: false } : {})).status);
  check("setup: the morning's interventions (ready without e-mail, in progress, received)", steps.every((x) => x === 200) && !outbox.some((m) => /prête/.test(m.subject || "")), steps.join());

  // ---- construction (comme la version publiée)
  const src = path.join(OUT, "src");
  fs.cpSync(SRC, src, { recursive: true });
  fs.writeFileSync(path.join(src, "legal.json"), JSON.stringify(LEGAL));
  const env = { ...process.env, PIXCAR_API_BASE: api.url, PIXCAR_PRO_POOL: "eu-north-1_PixcarTest1", PIXCAR_PRO_CLIENT: "4pro0test1client2id3", PIXCAR_GA_ID: "", PIXCAR_CS_ID: "", PIXCAR_MAPBOX_TOKEN: "" };
  execFileSync(process.execPath, [BUILD, "--only", "dist", "--src", src, "--out", path.join(OUT, "site"), "--pages", "pixcar.fr"], { stdio: "pipe", env });
  srv.setRoot(path.join(OUT, "site", "dist"));

  const browser = await chromium.launch({ args: ["--proxy-server=direct://", "--proxy-bypass-list=*"] });
  async function newPage({ width = 1440, height = 1000, touch = false } = {}) {
    const ctx = await browser.newContext({ viewport: { width, height }, locale: "fr-FR", timezoneId: "Europe/Paris", serviceWorkers: "block", hasTouch: touch, isMobile: touch });
    await ctx.addInitScript(([token, account]) => sessionStorage.setItem("pixcar-pro-session", JSON.stringify({ email: "camille@garage-atelier.fr", access: token, refresh: "ref." + account, expiresAt: 4102444800000 })), [TOKEN, ACCOUNT]); // horloge de la page arrêtée : session valable
    await ctx.route("**/*", (route) => (new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort()));
    const page = await ctx.newPage();
    await page.clock.setFixedTime(new Date(T));
    const logs = [];
    page.on("console", (m) => ["error", "warning"].includes(m.type()) && !/status of (400|401|409|422)\b/.test(m.text()) && logs.push(`[${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => logs.push("[pageerror] " + e.message));
    return { ctx, page, logs };
  }
  const axe = async (page, label) => {
    await page.evaluate(AXE);
    const r = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } })).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`));
    check(`axe: no violation on « ${label} »`, r.length === 0, r.join("\n"));
  };
  const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `pro-dash-${name}.png`), fullPage: true });
  const words = (page, sel) => page.$eval(sel, (e) => { const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT), out = []; while (w.nextNode()) out.push(w.currentNode.textContent); return out.join(" ").replace(/\s+/g, " ").trim(); });
  const kpis = (page) => page.$$eval("#dbKpis .db-kpi-btn", (bs) => Object.fromEntries(bs.map((b) => [b.dataset.kpi, { v: b.querySelector(".db-kpi-v").textContent, l: b.querySelector(".db-kpi-l").textContent, s: (b.querySelector(".db-kpi-s") || {}).textContent || "", p: b.getAttribute("aria-pressed") }])));
  const rows = (page) => page.$$eval("#dbList .db-row", (rs) => rs.map((r) => [r.querySelector(".db-time").textContent, r.querySelector(".db-who b").textContent, r.querySelector(".db-chip").textContent.trim()].join(" | ")));
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const live = (page, re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById("dbLive").textContent), re.source);
  const rowSel = (q) => `#dbList [data-id="${q.id}"]`;
  async function menu(page, q) {
    await page.click(`${rowSel(q)} .db-more-btn`);
    return page.$$eval(`${rowSel(q)} .db-menu [role="menuitem"]`, (bs) => bs.map((b) => b.textContent));
  }

  // ================================================================= mode avancé, ordinateur
  const { ctx, page, logs } = await newPage();
  await page.goto(`${srv.url}/pro/`);
  await page.waitForSelector('[data-screen="dash"]:not([hidden]) #dbKpis .db-kpi').catch(async (e) => {
    console.log(logs.join("\n"), await page.evaluate(() => document.getElementById("alert") && document.getElementById("alert").textContent));
    throw e;
  });
  await page.waitForSelector("#dbList .db-row");
  check("the dashboard is the first screen, with its title, the greeting and today's date", (await words(page, "#dashTitle")) === "Tableau de bord" && /^Bonjour Camille · Garage Démo Atelier/.test(await words(page, "#dashGarage")) && (await words(page, "#dbToday")) === "Mer. 4 nov. 2026", (await words(page, ".db-head")));
  check("the menu says « Tableau de bord » and « Prestations & tarifs »", (await page.getAttribute('.dash-link[data-panel="top"]', "aria-current")) === "true" && (await words(page, '.dash-link[data-panel="prices"] .wide-only')) === "Prestations & tarifs");
  let k = await kpis(page);
  check("five figures: 6 vehicles expected (2 to receive, 1 to confirm, 1 off Pixcar), 2 in progress, 1 ready, the free capacity, the alerts", k.expected.v === "6" && k.expected.s === "2 à recevoir · 1 à confirmer · 1 hors Pixcar" && k.live.v === "2" && k.live.s === "Sur 6 véhicules aujourd'hui" && k.ready.v === "1" && k.capacity.v === "11 h 45" && k.alerts.v === "6" && k.alerts.l === "Alertes", JSON.stringify(k));
  check("the figures that filter the list say so (aria-pressed)", k.expected.p === "false" && k.live.p === "false" && k.ready.p === "false" && k.capacity.p === null);
  let list = await rows(page);
  check("today at the workshop: by drop-off time, each with its state", JSON.stringify(list) === JSON.stringify(["8:00 | Sophie Lambert | Prête", "8:30 | Julien Roux | En cours", "9:00 | Marie Curie | Voiture reçue", "9:30 | Lucas Petit | Prévue", "14:00 | M. Martin (tél.) | Prévue", "14:30 | Thomas Bernard | À confirmer"]), JSON.stringify(list));
  check("a row gives the car and plate, the service, and Pixcar or not", (await words(page, rowSel(julien))).includes("Peugeot 208 · FY-123-AB") && (await words(page, rowSel(julien))).includes("Vidange") && (await words(page, `#dbList .db-row:nth-child(5)`)).includes("Hors Pixcar") && (await words(page, rowSel(julien))).includes("Travaux 8:30–9:15"), await words(page, rowSel(julien)));
  check("the page carries the published security policy, and nothing complained", /(^|; )style-src 'self'(;|$)/.test(await page.$eval('meta[http-equiv="Content-Security-Policy"]', (m) => m.content)) && logs.length === 0, logs.join("\n"));
  await shot(page, "1-ordinateur");
  await axe(page, "tableau de bord (mode avancé)");

  // ---- le menu d'une ligne, au clavier : Lucas n'est pas arrivé → « Voiture reçue »
  let items = await menu(page, lucas);
  check("actions of an expected car: received, client absent (the drop-off time is past), open in the planning", JSON.stringify(items) === JSON.stringify(["Voiture reçue", "Client absent", "Ouvrir dans le planning"]) && (await page.getAttribute(`${rowSel(lucas)} .db-more-btn`, "aria-expanded")) === "true" && (await page.evaluate(() => document.activeElement.textContent)) === "Voiture reçue", JSON.stringify(items));
  await page.keyboard.press("ArrowDown");
  check("the menu goes down with the arrow keys", (await page.evaluate(() => document.activeElement.textContent)) === "Client absent");
  await page.keyboard.press("Escape");
  check("Escape closes the menu and gives the focus back to its button", (await page.isHidden(`${rowSel(lucas)} .db-menu`)) && (await page.evaluate(() => document.activeElement.classList.contains("db-more-btn"))));
  await menu(page, lucas);
  await page.click(`${rowSel(lucas)} .db-menu >> text=Voiture reçue`);
  await live(page, /Lucas Petit : Voiture reçue\./);
  k = await kpis(page);
  check("« Voiture reçue »: the row and the figures follow, the focus stays on the row", (await words(page, `${rowSel(lucas)} .db-chip`)) === "Voiture reçue" && k.live.v === "3" && k.expected.s === "1 à recevoir · 1 à confirmer · 1 hors Pixcar" && (await page.evaluate((id) => !!document.activeElement.closest(`[data-id="${id}"]`), lucas.id)), JSON.stringify(k));
  items = await menu(page, julien);
  check("actions of a car in progress: waiting for parts, suspend, ready", JSON.stringify(items) === JSON.stringify(["En attente de pièces", "Suspendre", "Voiture prête", "Ouvrir dans le planning"]), JSON.stringify(items));
  await page.keyboard.press("Escape");
  // ---- « Voiture prête » : la fenêtre, la case « prévenir le client » cochée par défaut
  await menu(page, marie);
  await page.click(`${rowSel(marie)} .db-menu >> text=Voiture prête`);
  await page.waitForSelector("#workDlg[open]");
  check("ready: a window names the client and the car, the « tell the client » box is ticked", (await words(page, "#workDlgTitle")) === "Marie Curie" && (await words(page, "#workDlgText")).includes("Renault Clio") && (await page.isChecked("#workNotify")));
  await axe(page, "fenêtre « Voiture prête »");
  await page.click("#workSave");
  await live(page, /Marie Curie : voiture prête, client prévenu par e-mail\./);
  const mail = outbox.filter((m) => m.target === "marie@example.com" && /^Votre voiture est prête/.test(m.subject || ""));
  check("the client gets « Votre voiture est prête », with when to come", mail.length === 1 && /Vous pouvez venir la chercher aujourd'hui jusqu'à 12:00 et de 14:00 à 18:00\./.test(mail[0].text), JSON.stringify(mail.map((m) => m.subject)));
  check("the row says « Prête », two cars ready now", (await words(page, `${rowSel(marie)} .db-chip`)) === "Prête" && (await kpis(page)).ready.v === "2");
  // ---- un chiffre filtre la liste
  await page.click('[data-kpi="live"]');
  list = await rows(page);
  check("« Interventions en cours » filters the list, the filter is named and can be undone", (await page.getAttribute('[data-kpi="live"]', "aria-pressed")) === "true" && list.length === 2 && list.every((r) => /En cours|Voiture reçue/.test(r)) && (await words(page, "#dbFilter")).startsWith("Filtre : Interventions en cours"), JSON.stringify(list));
  await page.click("#dbFilter button");
  check("« Tout afficher » brings the whole day back", (await rows(page)).length === 6 && (await page.getAttribute('[data-kpi="live"]', "aria-pressed")) === "false");

  // ---- demandes à traiter
  const rq = await page.$$eval("#dbRq .db-rq-row", (rs) => rs.map((r) => r.innerText.replace(/\s+/g, " ")));
  check("requests to handle: Thomas Bernard, with Confirm and Refuse", rq.length === 1 && /Thomas Bernard/.test(rq[0]) && /Citroën C3 · BB-789-EF/.test(rq[0]) && /Confirmer/.test(rq[0]) && /Refuser/.test(rq[0]) && (await words(page, "#dbRqCount")) === "1", JSON.stringify(rq));
  // ---- équipe et postes
  const team = await page.$$eval("#dbTeam .db-team-row", (rs) => rs.map((r) => r.innerText.replace(/\s+/g, " ").trim()));
  check("team: each mechanic with initials, today's load and what they do now; Sami away from 15:00", team.length === 3 && /^PM Paul Martin/.test(team[0]) && team.some((t) => /^S Sami .*Absent à partir de 15:00/.test(t)) && team.every((t) => /\d+ %/.test(t)), JSON.stringify(team));
  const posts = await page.$$eval("#dbPosts .db-post-row", (rs) => rs.map((r) => r.innerText.replace(/\s+/g, " ").trim()));
  check("posts: the tyre post is down, the others free now", posts.length === 4 && posts.some((p) => /^Pneus Indisponible/.test(p)) && posts.some((p) => /^Pont 1 Disponible/.test(p)) && posts.some((p) => /^Diagnostic Disponible/.test(p)), JSON.stringify(posts));
  // ---- points d'attention : les plus urgents d'abord, quatre affichés
  const alerts = () => page.$$eval("#dbAlerts .db-alert", (bs) => bs.map((b) => b.querySelector("b").textContent));
  let al = await alerts();
  check("attention points: late cars first, four shown, the rest behind a button", al.length === 4 && al[0] === "Pas prête à l'heure : Julien Roux" && (await words(page, "#dbAlertsMore")) === "Voir tous les points (5)", JSON.stringify(al));
  await page.click("#dbAlertsMore");
  al = await alerts();
  check("all points: the service nobody can do, tomorrow's maintenance, the client to confirm", al.length === 5 && al.includes("Recharge de climatisation non planifiable") && al.includes("Pont 2 indisponible demain") && al.includes("1 client à confirmer") && (await page.getAttribute("#dbAlertsMore", "aria-expanded")) === "true", JSON.stringify(al));
  check("tomorrow's maintenance says when", (await page.$$eval("#dbAlerts .db-alert", (bs) => bs.map((b) => b.innerText.replace(/\s+/g, " ")).find((t) => /Pont 2/.test(t)))).includes("De 9:00 à 11:00 (maintenance)"));
  // ---- confirmer la demande de Thomas
  await page.click("#dbRq .db-ok");
  await live(page, /Rendez-vous confirmé\./);
  check("confirmed from the dashboard: the request leaves the list, the menu badge is gone, the client is told", (await page.$$("#dbRq .db-rq-row")).length === 0 && (await page.isVisible("#dbRqEmpty")) && (await page.isHidden("#rqCount")) && outbox.some((m) => m.target === "thomas@example.com" && /confirmé/i.test(m.subject || "")) && (await words(page, `${rowSel(thomas)} .db-chip`)) === "Prévue");

  // ---- raccourcis : trois par défaut, personnalisés, gardés sur le compte
  const shorts = () => page.$$eval("#dbShortcuts .db-short", (bs) => bs.map((b) => b.querySelector("b").textContent));
  check("shortcuts: Planning, Prestations & tarifs, Disponibilités by default", JSON.stringify(await shorts()) === JSON.stringify(["Aller au planning", "Prestations & tarifs", "Disponibilités"]), JSON.stringify(await shorts()));
  await page.click("#dbShortEdit");
  await page.waitForSelector("#shortDlg[open]");
  await page.uncheck('#shortList input[value="agenda"]');
  for (const v of ["requests", "garage", "team", "new"]) await page.check(`#shortList input[value="${v}"]`);
  check("six at most: the other boxes are disabled once six are ticked", (await page.$$eval("#shortList input:disabled", (x) => x.length)) === 3 && /6 sur 6/.test(await words(page, "#shortHelp")));
  await axe(page, "fenêtre des raccourcis");
  await page.click("#shortSave");
  await live(page, /Raccourcis enregistrés\./);
  check("saved: in the order of the list", JSON.stringify(await shorts()) === JSON.stringify(["Aller au planning", "Demandes", "Prestations & tarifs", "Mon garage", "Équipe et postes", "Nouveau rendez-vous"]), JSON.stringify(await shorts()));
  check("kept on the account (the API has them)", JSON.stringify((await pro("GET", "")).body.prefs.shortcuts) === JSON.stringify(["planning", "requests", "prices", "garage", "team", "new"]));
  await page.click('#dbShortcuts [data-short="garage"]');
  await page.waitForSelector("#dash-garage:not([hidden])");
  check("a shortcut opens its screen", (await page.getAttribute('.dash-link[data-panel="garage"]', "aria-current")) === "true");
  await page.click('.dash-link[data-panel="top"]');
  await page.waitForSelector("#dash-top:not([hidden]) #dbList .db-row");

  // ---- client déjà sur place : le formulaire du Planning, puis « Voiture reçue »
  await page.click("#dbActions .db-act:nth-child(2)");
  await page.waitForSelector("#planDlg[open]");
  check("« Client déjà sur place » opens the Planning's form on today, at the next five minutes", (await page.isVisible("#dash-planning")) && (await words(page, "#planDlgTitle")) === "Client déjà sur place" && (await page.inputValue("#planDay")) === D && (await page.inputValue("#planTime")) === "10:35" && (await page.$$('input[name="planKind"]')).length === 0, await page.inputValue("#planTime"));
  await page.fill("#planLabel", "Mme Durand");
  await page.check('input[name="planSvc"][value="vidange"]');
  await page.click("#planSave");
  await page.waitForFunction(() => !document.getElementById("planDlg").open);
  const walk = (await pro("GET", `/rdv/calendar/agenda?from=${D}&to=${D}`)).body.blocks.find((b) => b.label === "Mme Durand");
  check("saved and received at once", walk && walk.work && walk.work.status === "received", JSON.stringify(walk && walk.work));
  await page.click('.dash-link[data-panel="top"]');
  await page.waitForSelector(`#dbList [data-id="${walk.id}"]`);
  check("back on the dashboard: the walk-in is in the list, received", (await words(page, `#dbList [data-id="${walk.id}"] .db-chip`)) === "Voiture reçue");

  // ---- ouvrir dans le planning : la fiche et son avancement
  await menu(page, julien);
  await page.click(`${rowSel(julien)} .db-menu >> text=Ouvrir dans le planning`);
  await page.waitForSelector("#planDlg[open] .pl-work");
  check("« Ouvrir dans le planning »: the day view and the appointment's sheet, with its progress actions", (await words(page, '.pl-view[aria-pressed="true"]')) === "Jour" && (await words(page, "#planDlgTitle")) === "Julien Roux" && JSON.stringify(await page.$$eval("#planDlg [data-work]", (bs) => bs.map((b) => b.textContent))) === JSON.stringify(["En attente de pièces", "Suspendre", "Voiture prête"]) && (await page.isChecked("#planNotify")));
  check("a started intervention no longer moves nor cancels from its sheet", (await page.$("#planMove")) === null && !(await page.$$eval("#planDlg button", (bs) => bs.some((b) => /Annuler ce rendez-vous/.test(b.textContent)))));
  await page.uncheck("#planNotify");
  await page.click('#planDlg [data-work="done"]');
  await page.waitForFunction(() => /Julien Roux : Prête\./.test(document.getElementById("planLive").textContent));
  check("ready from the sheet, box unticked: no e-mail", !outbox.some((m) => m.target === "julien@example.com" && /prête/.test(m.subject || "")) && JSON.stringify(await page.$$eval("#planDlg [data-work]", (bs) => bs.map((b) => b.textContent))) === JSON.stringify(["Voiture restituée", "Pas prête finalement"]));
  await page.click("#planDlg .icon-btn");
  check("the block says « Prête » (in its name, read and shown as a tooltip)", (await page.$$eval(`.pl-ev[data-id="${julien.id}"]`, (bs) => bs.map((b) => b.getAttribute("aria-label")))).every((l) => /Intervention : Prête/.test(l)), JSON.stringify(await page.$$eval(`.pl-ev[data-id="${julien.id}"]`, (bs) => bs.map((b) => b.getAttribute("aria-label")))));
  await shot(page, "2-planning-fiche");
  await ctx.close();

  // ---- la page de suivi du client
  {
    const c = await newPage({ width: 420, height: 900 });
    await c.page.goto(`${srv.url}/rendez-vous/#c=${marie.token}`);
    await c.page.waitForSelector("#rvView:not([hidden])");
    const steps = await c.page.$$eval("#rvSteps li", (ls) => ls.map((l) => `${l.className}:${l.querySelector("b").textContent}`));
    check("the client's page: « Votre voiture est prête », the steps up to ready", (await words(c.page, "#rvTitle")) === "Votre voiture est prête" && JSON.stringify(steps) === JSON.stringify(["done:Demande envoyée", "done:Réponse du garage", "done:Rendez-vous", "done:Voiture reçue", "done:Travaux", "cur:Prête", "off:Restituée"]) && !(await c.page.$$eval("#rvActs button", (bs) => bs.some((b) => /Annuler/.test(b.textContent)))), JSON.stringify(steps));
    await c.page.screenshot({ path: path.join(SHOTS, "pro-dash-3-suivi-client.png"), fullPage: true });
    await axe(c.page, "page de suivi (voiture prête)");
    await c.ctx.close();
  }

  // ---- Prestations & tarifs : l'ancien tableau de bord
  {
    const c = await newPage();
    await c.page.goto(`${srv.url}/pro/`);
    await c.page.waitForSelector("#dbList .db-row");
    await c.page.click('.dash-link[data-panel="prices"]');
    await c.page.waitForSelector("#dash-prices:not([hidden])");
    check("« Prestations & tarifs »: its own screen, with the visits and the prices", (await words(c.page, "#pricesTitle")) === "Prestations & tarifs" && (await c.page.isVisible("#statViews")) && (await c.page.isVisible("#noPrice")) && (await c.page.isHidden("#dash-top")));
    await c.ctx.close();
  }

  // ---- téléphone
  {
    const c = await newPage({ width: 390, height: 844, touch: true });
    await c.page.goto(`${srv.url}/pro/`);
    await c.page.waitForSelector("#dbList .db-row");
    check("phone: no horizontal scroll, the figures two by two", (await overflow(c.page)) <= 0 && (await c.page.$$eval("#dbKpis .db-kpi", (ks) => new Set(ks.slice(0, 2).map((x) => Math.round(x.getBoundingClientRect().top))).size === 1)), String(await overflow(c.page)));
    await c.page.screenshot({ path: path.join(SHOTS, "pro-dash-4-telephone.png"), fullPage: true });
    await axe(c.page, "tableau de bord (téléphone)");
    await c.ctx.close();
  }

  // ================================================================= mode simple
  const back = await pro("POST", "/rdv/calendar/simple");
  check("back to simple mode", back.status === 200, JSON.stringify(back.body).slice(0, 300));
  {
    const c = await newPage();
    await c.page.goto(`${srv.url}/pro/`);
    await c.page.waitForSelector("#dbKpis .db-kpi");
    const kk = await kpis(c.page);
    check("simple mode: other figures (today's appointments, requests, visits, prices), no team nor posts", kk.today && kk.today.v === "5" && kk.todo.v === "0" && kk.views && kk.fresh && !kk.live && (await c.page.isHidden("#dbTeamCard")) && (await c.page.isHidden("#dbPostsCard")), JSON.stringify(kk));
    check("simple mode: today's list without progress actions, the shortcuts that need the advanced mode are hidden", (await c.page.$$("#dbList .db-more-btn")).length === 0 && !(await c.page.$$eval("#dbShortcuts b", (bs) => bs.some((b) => /planning|Équipe|Nouveau/.test(b.textContent)))), await words(c.page, "#dbShortcuts"));
    check("simple mode: quick actions for the requests, a day off, a price, the advanced planning", (await c.page.$$eval("#dbActions b", (bs) => bs.map((b) => b.textContent))).join() === "Mes disponibilités,Fermer une journée,Annoncer un prix,Planning avancé");
    await c.page.screenshot({ path: path.join(SHOTS, "pro-dash-5-mode-simple.png"), fullPage: true });
    await axe(c.page, "tableau de bord (mode simple)");
    await c.ctx.close();
  }

  await browser.close();
  await api.close();
  await srv.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} cas passés`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
