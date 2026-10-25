// Espace Pro, tableau de bord « Pilotage » et suivi des interventions (docs/calendrier-avance.md) de bout en bout : page construite comme
// la version publiée (politique de sécurité), vraie API (PGlite), horloges de la page et de l'API arrêtées un mercredi à 10:30. Un garage en
// mode avancé (trois mécaniciens dont une absente à 15:00, deux ponts dont l'un en maintenance demain, un poste pneus en maintenance, la
// climatisation faite mais que personne ne sait faire) et la journée : une voiture prête, deux en cours (en retard), une pas arrivée,
// une demande à confirmer, un rendez-vous pris par téléphone. Parcours : en-tête et période → actions rapides → capacité de l'atelier →
// quatre chiffres → rendez-vous du jour (trois, puis tous ; états, menu d'actions au clavier, voiture reçue, voiture prête avec le client
// prévenu par e-mail) → filtre par un chiffre → demandes à traiter (confirmer) → équipe et postes → points d'attention → Semaine, flèches,
// Mois, calendrier en ligne au clavier, Jour → « Gérer l'équipe » → client déjà sur place (formulaire du Planning) → ouvrir dans le
// planning (fiche, avancement) → page de suivi du client → prix annoncés (Mon garage › Prestations) → téléphone (calendrier des mois) →
// mode simple ; axe.
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
  const kpis = (page) => page.$$eval("#dbKpis .db-kpi-btn", (bs) => Object.fromEntries(bs.map((b) => [b.dataset.kpi, { v: b.querySelector(".db-kpi-v").textContent, l: b.querySelector(".db-kpi-l").textContent, s: b.querySelector(".db-kpi-s").textContent, p: b.getAttribute("aria-pressed") }])));
  const rows = (page) => page.$$eval("#dbList .db-row", (rs) => rs.map((r) => [r.querySelector(".db-time").textContent, r.querySelector(".db-who").textContent.split(" · ")[0], r.querySelector(".db-chip").textContent.trim()].join(" | ")));
  const facts = (page) => page.$$eval("#dbCapa .pv-facts div", (ds) => ds.map((d) => `${d.querySelector("dt").textContent} ${d.querySelector("dd").textContent}`));
  const settled = (page) => page.waitForSelector("#dbBody:not([aria-busy])");
  const allRows = async (page) => {
    if ((await page.isVisible("#dbMoreRows")) && (await page.getAttribute("#dbMoreRows", "aria-expanded")) === "false") await page.click("#dbMoreRows");
  };
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
  check("the dashboard is the first screen: title, greeting, the day shown (Jour, today, « Aujourd'hui »)", (await words(page, "#dashTitle")) === "Tableau de bord" && /^Bonjour Camille · Garage Démo Atelier, 14 rue de l'Exemple/.test(await page.textContent("#dashGarage")) && (await words(page, "#dbToday")) === "Mercredi 4 novembre 2026" && (await page.getAttribute('#dbGran [data-gran="day"]', "aria-pressed")) === "true" && (await words(page, "#dbNow")) === "Aujourd'hui" && (await page.getAttribute("#dbPicker", "aria-label")) === "Choisir un jour" && (await page.getAttribute("#dbPicker", "aria-expanded")) === "false" && (await page.getAttribute("#dbCal", "aria-hidden")) === "true", await words(page, ".pv-head"));
  check("the menu says « Tableau de bord »; the prices are in « Mon garage »", (await page.getAttribute('.dash-link[data-panel="top"]', "aria-current")) === "true" && !(await page.$('.dash-link[data-panel="prices"]')) && (await words(page, '.dash-link[data-panel="garage"]')) === "Mon garage");
  check("quick actions as the proposal: new appointment (orange), client already here, block a slot, an absence", (await page.$$eval("#dbActions .db-act", (bs) => bs.map((b) => b.textContent))).join() === "Nouveau rendez-vous,Client déjà sur place,Bloquer un créneau,Déclarer une absence" && (await page.$$("#dbActions .db-act.is-primary")).length === 1);
  check("the workshop's capacity: 11 h 45 still free today, 3 / 3 mechanics, 3 / 4 posts (tyres down), 5 h planned out of 21 h", (await words(page, "#dbCapa .pv-capa-v")) === "11 h 45" && (await words(page, "#dbCapa h3")) === "de main-d'œuvre encore disponible" && JSON.stringify(await facts(page)) === JSON.stringify(["Mécaniciens présents 3 / 3", "Postes disponibles 3 / 4", "Charge planifiée 5 h"]) && (await words(page, "#dbCapa .pv-scale")) === "5 h planifiées 21 h de capacité" && (await page.getAttribute("#dbCapa .pv-meter", "aria-label")) === "Charge planifiée : 24 % de la capacité", `${await words(page, "#dbCapa")} ${JSON.stringify(await facts(page))}`);
  let k = await kpis(page);
  check("four figures: 3 vehicles expected (1 to confirm), 2 in progress, 1 ready, 6 attention points", k.expected.v === "3" && k.expected.s === "à recevoir, dont 1 à confirmer" && k.live.v === "2" && k.live.s === "dans l'atelier" && k.ready.v === "1" && k.ready.s === "à restituer" && k.alerts.v === "6" && k.alerts.l === "Points d'attention" && Object.keys(k).length === 4, JSON.stringify(k));
  check("the figures that filter the list say so (aria-pressed)", k.expected.p === "false" && k.live.p === "false" && k.ready.p === "false" && k.alerts.p === null);
  let list = await rows(page);
  check("today at the workshop: the first three by drop-off time, then « Voir les 6 rendez-vous »", JSON.stringify(list) === JSON.stringify(["8:00 | Sophie Lambert | Prête", "8:30 | Julien Roux | En cours", "9:00 | Marie Curie | Voiture reçue"]) && (await words(page, "#dbListCount")) === "6 rendez-vous sur la journée" && (await words(page, "#dbMoreRows")) === "Voir les 6 rendez-vous" && (await words(page, "#dbTodayText")) === "Aujourd'hui à l'atelier", JSON.stringify(list));
  await page.click("#dbMoreRows");
  list = await rows(page);
  check("« Voir les 6 rendez-vous » unfolds the whole day in place", JSON.stringify(list) === JSON.stringify(["8:00 | Sophie Lambert | Prête", "8:30 | Julien Roux | En cours", "9:00 | Marie Curie | Voiture reçue", "9:30 | Lucas Petit | Prévue", "14:00 | M. Martin (tél.) | Prévue", "14:30 | Thomas Bernard | À confirmer"]) && (await page.getAttribute("#dbMoreRows", "aria-expanded")) === "true" && (await words(page, "#dbMoreRows")) === "Voir moins", JSON.stringify(list));
  check("a row gives the service, the client, the car and plate, and Pixcar or not", (await words(page, rowSel(julien))).includes("Pixcar : Vidange") && (await words(page, rowSel(julien))).includes("Julien Roux · Peugeot 208 · FY-123-AB") && (await words(page, "#dbList .db-row:nth-child(5)")).includes("Hors Pixcar : Plaquettes de frein avant"), await words(page, rowSel(julien)));
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
  check("« Voiture reçue »: the row and the figures follow, the focus stays on the row", (await words(page, `${rowSel(lucas)} .db-chip`)) === "Voiture reçue" && k.live.v === "3" && k.expected.v === "2" && k.expected.s === "à recevoir, dont 1 à confirmer" && (await page.evaluate((id) => !!document.activeElement.closest(`[data-id="${id}"]`), lucas.id)), JSON.stringify(k));
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
  check("« Tout afficher » brings the whole day back (three rows, then the rest behind the button)", (await rows(page)).length === 3 && (await words(page, "#dbListCount")) === "6 rendez-vous sur la journée" && (await page.getAttribute('[data-kpi="live"]', "aria-pressed")) === "false");

  // ---- demandes à traiter
  const rq = await page.$$eval("#dbRq .db-rq-row", (rs) => rs.map((r) => r.innerText.replace(/\s+/g, " ")));
  check("requests to handle: Thomas Bernard, with Confirm and Refuse", rq.length === 1 && /Thomas Bernard/.test(rq[0]) && /Citroën C3 · BB-789-EF/.test(rq[0]) && /Confirmer/.test(rq[0]) && /Refuser/.test(rq[0]) && (await words(page, "#dbRqCount")) === "1", JSON.stringify(rq));
  // ---- équipe et postes
  const team = await page.$$eval("#dbTeam .pv-person", (rs) => rs.map((r) => r.innerText.replace(/\s+/g, " ").trim()));
  check("team: initials, today's load (planned / hours), the hours still free, what each does now; Sami away from 15:00", team.length === 3 && /^PM Paul Martin 2 h 45 \/ 8 h 4 h 30 disponibles/.test(team[0]) && team.some((t) => /^S Sami 0 h \/ 5 h .*disponibles Absent à partir de 15:00/.test(t)), JSON.stringify(team));
  const posts = await page.$$eval("#dbPosts .pv-post", (rs) => rs.map((r) => r.innerText.replace(/\s+/g, " ").trim()));
  check("posts: the tyre post is down, the others free now", posts.length === 4 && posts.some((p) => /^Pneus Maintenance Indisponible/.test(p)) && posts.some((p) => /^Pont 1 Disponible/.test(p)) && posts.some((p) => /^Diagnostic Disponible/.test(p)), JSON.stringify(posts));
  // ---- points d'attention : le plus urgent en encart, les autres derrière un bouton
  const others = () => page.$$eval("#dbAlerts .db-alert", (bs) => bs.map((b) => b.querySelector("b").textContent));
  check("attention points: the most urgent in a box with its action, the others behind « N autres points d'attention »", (await words(page, "#dbAlertsCount")) === "5" && (await words(page, "#dbAlertTop b")) === "Pas prête à l'heure : Julien Roux" && (await words(page, "#dbAlertTop .pv-alert-go")) === "Voir le rendez-vous" && (await words(page, "#dbAlertsMore")) === "4 autres points d'attention" && (await page.isHidden("#dbAlerts")), await words(page, "#dbAlertsCard"));
  await page.click("#dbAlertsMore");
  const al = await others();
  check("the other points: the late car, the service nobody can do, tomorrow's maintenance, the client to confirm", al.length === 4 && al.includes("Pas prête à l'heure : Lucas Petit") && al.includes("Recharge de climatisation non planifiable") && al.includes("Pont 2 indisponible demain") && al.includes("1 client à confirmer") && (await page.getAttribute("#dbAlertsMore", "aria-expanded")) === "true" && (await words(page, "#dbAlertsMore")) === "Masquer les autres points", JSON.stringify(al));
  check("tomorrow's maintenance says when", (await page.$$eval("#dbAlerts .db-alert", (bs) => bs.map((b) => b.innerText.replace(/\s+/g, " ")).find((t) => /Pont 2/.test(t)))).includes("De 9:00 à 11:00 (maintenance)"));
  // ---- confirmer la demande de Thomas
  await page.click("#dbRq .db-ok");
  await live(page, /Rendez-vous confirmé\./);
  check("confirmed from the dashboard: the request leaves the list, the menu badge is gone, the client is told", (await page.$$("#dbRq .db-rq-row")).length === 0 && (await page.isVisible("#dbRqEmpty")) && (await page.isHidden("#rqCount")) && outbox.some((m) => m.target === "thomas@example.com" && /confirm/i.test(m.subject || "")));

  // ---- la période : Semaine, flèches, Mois, calendrier en ligne au clavier
  await page.click('#dbGran [data-gran="week"]');
  await settled(page);
  k = await kpis(page);
  check("Semaine: Monday to Sunday, « Cette semaine », the week's appointments with their day, figures on the week", (await words(page, "#dbToday")) === "2 – 8 novembre 2026" && (await page.getAttribute('#dbGran [data-gran="week"]', "aria-pressed")) === "true" && (await page.getAttribute("#dbGran", "data-gran")) === "week" && (await words(page, "#dbNow")) === "Cette semaine" && (await page.getAttribute("#dbPrev", "aria-label")) === "Semaine précédente" && (await words(page, "#dbTodayText")) === "Les rendez-vous de la semaine" && (await words(page, "#dbList .db-row:first-child .db-time")) === "mer. 4 8:00" && k.all.v === "6" && k.all.s === "sur la semaine" && k.returned && k.ready && k.alerts && !k.live && (await words(page, "#dbCapa h3")) === "de main-d'œuvre non planifiée" && (await facts(page))[0] === "Mécaniciens sur la période 3 / 3", JSON.stringify(k));
  await page.click("#dbNext");
  await settled(page);
  check("the next week: nothing booked, the empty state points to the planning", (await words(page, "#dbToday")) === "9 – 15 novembre 2026" && (await page.isVisible("#dbListEmpty")) && (await words(page, "#dbListEmptyTitle")) === "Aucun rendez-vous sur cette semaine." && (await words(page, "#dbListEmptyGo")) === "Consulter le planning" && (await kpis(page)).all.v === "0");
  await page.click("#dbNow");
  await settled(page);
  check("« Cette semaine » comes back", (await words(page, "#dbToday")) === "2 – 8 novembre 2026");
  await page.click('#dbGran [data-gran="month"]');
  await settled(page);
  check("Mois: the calendar month", (await words(page, "#dbToday")) === "Novembre 2026" && (await words(page, "#dbNow")) === "Ce mois" && (await words(page, "#dbTodayText")) === "Les rendez-vous du mois" && (await kpis(page)).all.s === "sur le mois");
  await page.click("#dbPicker");
  await page.waitForFunction(() => document.getElementById("dbCal").dataset.open === "true");
  check("the calendar opens in the page, under the period: the twelve months, November chosen, the focus on it", (await page.getAttribute("#dbPicker", "aria-expanded")) === "true" && (await page.getAttribute("#dbCal", "aria-hidden")) === "false" && !(await page.$eval("#dbCal", (n) => n.inert)) && (await words(page, "#dbCalTitle")) === "Choisir un mois" && (await page.$$("#dbCal .pv-months button")).length === 12 && (await page.getAttribute('[data-month="2026-11"]', "aria-pressed")) === "true" && (await page.evaluate(() => document.activeElement.dataset.month)) === "2026-11" && (await words(page, "#dbCal .pv-cal-sel strong")) === "Novembre 2026");
  await axe(page, "calendrier de la période (mois)");
  await page.keyboard.press("ArrowRight");
  check("the arrows move in the grid", (await page.evaluate(() => document.activeElement.dataset.month)) === "2026-12");
  await page.keyboard.press("Enter");
  await settled(page);
  check("Enter picks December: the period follows, the calendar stays open on the choice", (await words(page, "#dbToday")) === "Décembre 2026" && (await words(page, "#dbCal .pv-cal-sel strong")) === "Décembre 2026" && (await page.evaluate(() => document.activeElement.dataset.month)) === "2026-12" && (await page.getAttribute("#dbPicker", "aria-expanded")) === "true");
  await page.keyboard.press("Escape");
  check("Escape folds the calendar and gives the focus back to the period", (await page.getAttribute("#dbPicker", "aria-expanded")) === "false" && (await page.$eval("#dbCal", (n) => n.inert)) && (await page.evaluate(() => document.activeElement.id)) === "dbPicker");
  await page.click('#dbGran [data-gran="day"]');
  await settled(page);
  check("Jour after December: the first of December, « La journée à l'atelier »", (await words(page, "#dbToday")) === "Mardi 1 décembre 2026" && (await words(page, "#dbTodayText")) === "La journée à l'atelier");
  await page.click("#dbNow");
  await settled(page);
  await page.click("#dbPicker");
  await page.waitForFunction(() => document.getElementById("dbCal").dataset.open === "true");
  check("Choisir un jour: six weeks of days, today chosen and focused, one tab stop", (await words(page, "#dbCalTitle")) === "Choisir un jour" && (await page.$$("#dbCal .pv-days button")).length === 42 && (await page.getAttribute(`[data-day="${D}"]`, "aria-label")) === "Mercredi 4 novembre 2026" && (await page.evaluate(() => document.activeElement.dataset.day)) === D && (await page.$$eval("#dbCal .pv-days button", (bs) => bs.filter((b) => b.tabIndex === 0).length)) === 1);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await settled(page);
  check("the next day picked from the keyboard: Thursday, the list of that day", (await words(page, "#dbToday")) === "Jeudi 5 novembre 2026" && (await words(page, "#dbTodayText")) === "La journée à l'atelier" && (await page.isVisible("#dbListEmpty")));
  await axe(page, "calendrier de la période (jour)");
  await page.click("#dbCal .pv-fold");
  await page.click("#dbNow");
  await settled(page);
  await page.waitForSelector("#dbList .db-row");
  check("« Aujourd'hui » brings today back", (await words(page, "#dbToday")) === "Mercredi 4 novembre 2026" && (await words(page, "#dbTodayText")) === "Aujourd'hui à l'atelier");
  // ---- « Gérer l'équipe » : Mon garage › Ressources
  await page.click("#dbTeamCard [data-goto]");
  await page.waitForSelector("#dash-garage:not([hidden]):not([aria-busy])");
  check("« Gérer l'équipe » opens Mon garage › Ressources", (await page.getAttribute('.dash-link[data-panel="garage"]', "aria-current")) === "true" && (await page.getAttribute("#mgTab-resources", "aria-selected")) === "true");
  await page.click('.dash-link[data-panel="top"]');
  await page.waitForSelector("#dash-top:not([hidden]):not([aria-busy]) #dbList .db-row");

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
  await page.waitForSelector("#dash-top:not([hidden]):not([aria-busy]) #dbList .db-row");
  await allRows(page);
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

  // ---- prix annoncés (l'ancien tableau de bord, puis « Prestations & tarifs ») : Mon garage › Prestations
  {
    const c = await newPage();
    await c.page.goto(`${srv.url}/pro/`);
    await c.page.waitForSelector("#dbList .db-row");
    await c.page.click('.dash-link[data-panel="garage"]');
    await c.page.waitForSelector("#dash-garage:not([hidden]):not([aria-busy])");
    await c.page.click("#mgTab-services");
    await c.page.waitForSelector("#mgPanel-services:not([hidden])");
    check("« Prix annoncés »: Mon garage › Prestations, with the visits and the prices", (await words(c.page, "#pricesTitle")) === "Prix annoncés sur Pixcar" && (await c.page.isVisible("#statViews")) && (await c.page.isVisible("#noPrice")) && (await c.page.isHidden("#dash-top")) && (await words(c.page, "#crumb")) === "Mon atelier / Mon garage / Prestations");
    await c.ctx.close();
  }

  // ---- téléphone
  {
    const c = await newPage({ width: 390, height: 844, touch: true });
    await c.page.goto(`${srv.url}/pro/`);
    await c.page.waitForSelector("#dbList .db-row");
    check("phone: no horizontal scroll, the figures two by two, the period on two lines (Jour/Semaine/Mois and « Aujourd'hui », then the arrows and the day)", (await overflow(c.page)) <= 0 && (await c.page.$$eval("#dbKpis .db-kpi", (ks) => new Set(ks.slice(0, 2).map((x) => Math.round(x.getBoundingClientRect().top))).size === 1)) && (await c.page.evaluate(() => { const top = (id) => document.getElementById(id).getBoundingClientRect().top; return Math.abs(top("dbGran") - top("dbNow")) < 8 && top("dbPicker") > top("dbGran") + 20; })), String(await overflow(c.page)));
    await c.page.click('#dbGran [data-gran="month"]');
    await c.page.click("#dbPicker");
    await c.page.waitForFunction(() => document.getElementById("dbCal").dataset.open === "true");
    check("phone: the months calendar fits the screen", (await overflow(c.page)) <= 0 && (await c.page.$$("#dbCal .pv-months button")).length === 12);
    await c.page.screenshot({ path: path.join(SHOTS, "pro-dash-4b-telephone-calendrier.png"), fullPage: true });
    await axe(c.page, "calendrier de la période (téléphone)");
    await c.page.click("#dbCal .pv-cal-x");
    await c.page.click('#dbGran [data-gran="day"]');
    await c.page.waitForSelector("#dbBody:not([aria-busy]) #dbList .db-row");
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
    check("simple mode: the big card counts today's confirmed appointments; figures for the requests, the visits, the calls; no team nor posts", (await words(c.page, "#dbCapa .pv-capa-v")) === "5" && (await words(c.page, "#dbCapa h3")) === "rendez-vous confirmés sur la journée" && (await words(c.page, "#dbCapaTitle")) === "Vos rendez-vous en ligne" && kk.todo.v === "0" && kk.views && kk.calls && kk.alerts && !kk.live && (await c.page.isHidden("#dbResources")) && (await c.page.isVisible("#dbPeriod")), JSON.stringify(kk));
    check("simple mode: the day's list without progress actions", (await c.page.$$("#dbList .db-more-btn")).length === 0 && (await c.page.isHidden("#dbPlanLink")) && (await words(c.page, "#dbListCount")) === "5 rendez-vous sur la journée");
    check("simple mode: quick actions for the hours, a day off, a price, the advanced planning", (await c.page.$$eval("#dbActions b", (bs) => bs.map((b) => b.textContent))).join() === "Mes horaires et créneaux,Fermer une journée,Annoncer un prix,Planning avancé");
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
