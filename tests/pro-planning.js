// Espace Pro, écran Gestion d'atelier en affichage avancé (docs/gestion-atelier.md ; à l'origine le Planning du lot 3b de
// docs/calendrier-avance.md) de bout en bout : page construite pour de bon, vraie API (PGlite), un garage
// en mode avancé (deux mécaniciens, deux ponts), une demande confirmée, une à confirmer, un rendez-vous pris hors Pixcar, un créneau bloqué
// et une absence. Parcours : la barre latérale (repliable, choix mémorisé) → le menu (Planning seulement en mode avancé) → semaine (vue
// d'ensemble, charge par jour, blocs enrichis : confirmation, provenance et alerte séparées, légende, créneaux libres / pas proposés en
// ligne / fermés) → fiche d'un rendez-vous (détail, appeler, déplacer au clavier : conflit avec d'autres horaires, puis confirmation et
// e-mail au client) → glisser-déposer (vers un autre mécanicien ; vers une autre heure, avec la confirmation) → menu Nouveau (clavier) et
// création rapide (refus expliqué, puis enregistrée) → absence par le menu Nouveau (rendez-vous touchés « En conflit ») → filtres repliés
// et puces → carte d'alerte → week-end → mois → par mécanicien (heures planifiées, absence) et par poste → suppression d'un bloc,
// annulation d'un rendez-vous → tablette et téléphone ; axe.
//   node tests/pro-planning.js
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
const OUT = path.join(__dirname, ".out", "pro-planning-site");
const SHOTS = path.join(__dirname, ".out", "shots");
const SRC = process.env.PIXCAR_SRC || path.join(ROOT, "src");
const BUILD = process.env.PIXCAR_BUILD ? path.resolve(ROOT, process.env.PIXCAR_BUILD) : path.join(ROOT, "scripts/build.mjs");
const LEGAL = { editorLine: "Pixcar est édité à titre non professionnel par Jeanne Exemple, responsable du traitement des données décrites ici.", contact: "contact@exemple.test", hostPages: "GitHub, Inc. (GitHub Pages), États-Unis", hostApi: "Amazon Web Services EMEA SARL, Luxembourg (région Europe, Stockholm)", repairRetentionMonths: 24, updated: "3 octobre 2026" };
const HERE = { lat: 43.2174, lon: 1.1014 };
const GARAGE = "aaaaaaaa-0000-4000-8000-000000000002";
const CONTACTS = [{ id: GARAGE, name: "Garage Démo Planning", addr: "14 rue de l'Exemple, 31220 Cazères", pc: "31220", ...HERE, emails: ["contact@garage-planning.fr"], phones: ["+33561000002"] }];
const ACCOUNT = "sub-plan";
const TOKEN = `tok.${ACCOUNT}.1`;
const DAY = [["08:00", "12:00"], ["14:00", "18:00"]];
const WEEK = { mo: DAY, tu: DAY, we: DAY, th: DAY, fr: DAY };
const NOTIFY = "atelier@garage-planning.fr";

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, "empty"), { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const srv = await serveDir(path.join(OUT, "empty"));
  const { AuthError } = await import("../server/lib/jwt.mjs");
  const { parseContactRows } = await import("../server/lib/contact.mjs");
  const R = await import("../src/js/shared/rdv.js");
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
  api.clock.skew = Date.now() - api.now(); // l'horloge de l'API suit l'heure réelle, comme la page
  await api.app.pro.repo.upsertContacts(parseContactRows(CONTACTS).rows, "test");
  await api.db.query("INSERT INTO pro_claims (id, account_id, garage_id, siret, status, channel, holder_name, holder_role, target_hash, target_hint, verified_at) VALUES (gen_random_uuid(), $1, $2, '73282932000082', 'verified', 'email', 'Camille Durand', 'manager', $3, 'c•••••@garage-planning.fr', now())", [ACCOUNT, GARAGE, "b".repeat(64)]);
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
  // deux jours ouvrés à venir : D1, le jour ouvré qui suit le prochain (l'heure limite de réponse d'une demande, midi du prochain jour
  // ouvré, tombe avant : un samedi ou un vendredi, « après-demain » serait ce jour-là et le matin ne serait pas proposé), et le suivant
  const today = R.parisParts(Date.now()).iso;
  const workday = (iso) => !["sa", "su"].includes(R.weekday(iso));
  let next = R.addDays(today, 1);
  while (!workday(next)) next = R.addDays(next, 1);
  let D1 = R.addDays(next, 1);
  while (!workday(D1)) D1 = R.addDays(D1, 1);
  let D2 = R.addDays(D1, 1);
  while (!workday(D2)) D2 = R.addDays(D2, 1);
  const monday = (iso) => R.addDays(iso, -["mo", "tu", "we", "th", "fr", "sa", "su"].indexOf(R.weekday(iso)));

  // garage ouvert en mode simple, sans encore le calendrier avancé
  const ok =
    (await pro("PUT", "/profile", { hours: WEEK })).status === 200 &&
    (await Promise.all([["vidange", 45], ["plaq_av", 60]].map(([s, m]) => pro("PUT", `/services/${s}`, { offered: true, minutes: m })))).every((r) => r.status === 200) &&
    (await pro("POST", "/rdv/notify", { email: NOTIFY })).status === 200 &&
    (await pro("POST", "/rdv/notify/code", { code: lastCode(NOTIFY) })).status === 200 &&
    (await pro("POST", "/rdv/slots", { name: "Journée", days: ["mo", "tu", "we", "th", "fr"], start: "08:00", end: "18:00", mode: "hour", capacity: 2, services: ["vidange", "plaq_av"] })).status === 200 &&
    (await pro("PUT", "/rdv/settings", { enabled: true, minDelayH: 0, horizonDays: 28 })).status === 200;
  check("setup: the garage takes requests in simple mode", ok);

  // ---- construction
  const src = path.join(OUT, "src");
  fs.cpSync(SRC, src, { recursive: true });
  fs.writeFileSync(path.join(src, "legal.json"), JSON.stringify(LEGAL));
  const env = { ...process.env, PIXCAR_API_BASE: api.url, PIXCAR_PRO_POOL: "eu-north-1_PixcarTest1", PIXCAR_PRO_CLIENT: "4pro0test1client2id3", PIXCAR_GA_ID: "", PIXCAR_CS_ID: "", PIXCAR_MAPBOX_TOKEN: "" };
  // construite comme la version publiée (--pages) : avec sa politique de sécurité dans la page (style-src 'self' refuse l'attribut style)
  execFileSync(process.execPath, [BUILD, "--only", "dist", "--src", src, "--out", path.join(OUT, "site"), "--pages", "pixcar.fr"], { stdio: "pipe", env });
  srv.setRoot(path.join(OUT, "site", "dist"));

  const browser = await chromium.launch({ args: ["--proxy-server=direct://", "--proxy-bypass-list=*"] });
  async function newPage({ width = 1280, height = 1000, touch = false } = {}) {
    const ctx = await browser.newContext({ viewport: { width, height }, locale: "fr-FR", serviceWorkers: "block", hasTouch: touch, isMobile: touch });
    await ctx.addInitScript(([token, account]) => sessionStorage.setItem("pixcar-pro-session", JSON.stringify({ email: "camille@garage-planning.fr", access: token, refresh: "ref." + account, expiresAt: Date.now() + 3600e3 })), [TOKEN, ACCOUNT]);
    await ctx.route("**/*", (route) => (new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort()));
    const page = await ctx.newPage();
    const logs = [];
    // le registre SIRENE n'a pas ce garage d'essai : sa route répond 404, la page le dit (Mon garage › Fiche Pixcar)
    const expected = (m) => /status of (400|401|409|422)\b/.test(m.text()) || (/status of 404\b/.test(m.text()) && /\/registry$/.test(m.location().url));
    page.on("console", (m) => ["error", "warning"].includes(m.type()) && !expected(m) && logs.push(`[${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => logs.push("[pageerror] " + e.message));
    return { ctx, page, logs };
  }
  const axe = async (page, label) => {
    // contrastes mesurés une fois les transitions finies (le panneau apparaît en fondu)
    await page.waitForFunction(() => !document.getAnimations().some((a) => a instanceof CSSTransition));
    await page.evaluate(AXE);
    const r = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } })).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`));
    check(`axe: no violation on « ${label} »`, r.length === 0, r.join("\n"));
  };
  const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `pro-plan-${name}.png`), fullPage: true });
  const text = (page, sel) => page.$eval(sel, (e) => e.innerText.replace(/\s+/g, " ").trim());
  // le texte tel qu'écrit (sans les majuscules de la mise en forme), un espace entre deux éléments
  const words = (page, sel) => page.$eval(sel, (e) => { const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT), out = []; while (w.nextNode()) out.push(w.currentNode.textContent); return out.join(" ").replace(/\s+/g, " ").trim(); });
  const ppm = (page) => page.$eval(".pl-grid", (g) => parseFloat(g.style.getPropertyValue("--hour")) / 60);
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const near = (a, b) => Math.abs(a - b) < 0.01;
  const agenda = async (from = monday(D1), to = R.addDays(monday(D1), 13)) => (await pro("GET", `/rdv/calendar/agenda?from=${from}&to=${to}`)).body;
  const live = (page, re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById("planLive").textContent), re.source);
  const closed = (page) => page.waitForFunction(() => !document.getElementById("planDlg").open);
  const noNull = async (page, sel) => !/\b(null|undefined|NaN)\b/.test(await page.$eval(sel, (e) => e.innerText));
  // glisser un bloc (souris) vers une colonne, à une heure donnée (minutes depuis minuit)
  async function dragTo(page, from, toCol, minute) {
    await page.locator(from).scrollIntoViewIfNeeded();
    const b = await page.locator(from).boundingBox();
    const col = await page.locator(toCol).boundingBox();
    const lo = Number(await page.$eval(".pl-grid", (g) => g.dataset.lo));
    const k = await ppm(page);
    const x0 = b.x + Math.min(20, b.width / 2), y0 = b.y + 6;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x0 + 8, y0 + 8, { steps: 2 });
    await page.mouse.move(col.x + col.width / 2, col.y + (minute - lo) * k + 6, { steps: 10 });
    await page.mouse.up();
  }

  // ---- calcul par créneaux : Gestion d'atelier est déjà là (son agenda n'a pas besoin de mécaniciens ; tests/pro-atelier.js)
  {
    const { ctx, page } = await newPage();
    await page.goto(`${srv.url}/pro/`);
    await page.waitForSelector('[data-screen="dash"]:not([hidden])');
    check("slot calculation: Gestion d'atelier is in the menu, Mon garage too", (await page.isVisible('.dash-link[data-panel="planning"]')) && (await page.isVisible('.dash-link[data-panel="garage"]')));
    await ctx.close();
  }

  // ---- mode avancé : deux mécaniciens, deux ponts ; deux demandes, un rendez-vous hors Pixcar, un créneau bloqué, une absence
  const s = (await pro("POST", "/rdv/calendar/start")).body;
  const skill = (label) => s.skills.find((k) => k.label === label).id;
  await pro("PUT", "/rdv/calendar/settings", { receptionMin: 0, returnMin: 15, step: 5 });
  const paul = (await pro("POST", "/rdv/calendar/staff", { name: "Paul", skills: [skill("Entretien courant"), skill("Freinage")] })).body.saved;
  const lea = (await pro("POST", "/rdv/calendar/staff", { name: "Léa", skills: [skill("Entretien courant"), skill("Freinage")] })).body.saved;
  const lift1 = (await pro("POST", "/rdv/calendar/resources", { name: "Pont n°1", type: "lift" })).body.saved;
  const lift2 = (await pro("POST", "/rdv/calendar/resources", { name: "Pont n°2", type: "lift" })).body.saved;
  const act = await pro("POST", "/rdv/calendar/activate");
  check("setup: advanced mode is active", act.status === 200 && act.body.mode === "advanced", JSON.stringify(act.body));
  async function book(time, name, email) {
    const d = await call("POST", "/v1/rdv/requests", { garageId: GARAGE, services: [{ id: "vidange", qty: 1 }], day: D1, time, name, email, phone: "06 39 98 12 34", car: "Peugeot 208", year: 2019, plate: "EZ-108-BC", message: "", remindPrice: false });
    const c = await call("POST", `/v1/rdv/requests/${d.body && d.body.id}/code`, { code: lastCode(email) });
    if (c.status !== 200) console.log("  booking", time, d.status, JSON.stringify(d.body).slice(0, 200), c.status);
    return c.status === 200 ? d.body.id : null;
  }
  const julien = await book("08:00", "Julien Roux", "julien.roux@example.com");
  const marie = await book("10:00", "Marie Curie", "marie.curie@example.com");
  const acc = await pro("POST", `/rdv/requests/${julien}/accept`, {});
  const job = (await pro("POST", "/rdv/calendar/blocks", { kind: "job", label: "M. Martin (tél.)", services: [{ id: "vidange" }], day: D1, time: "14:00", staff: [paul] })).body;
  const hold = (await pro("POST", "/rdv/calendar/blocks", { kind: "hold", label: "Livraison pièces", day: D2, time: "10:00", to: "11:00", resources: [lift2] })).body;
  const away = await pro("POST", "/rdv/calendar/unavail", { target: "staff", targetId: lea, kind: "training", first: D2 });
  check("setup: two requests (one confirmed), a phone booking, a blocked slot, an absence", julien && marie && acc.status === 200 && job.saved && hold.saved && away.status === 200, JSON.stringify([acc.body, job, hold, away.body]));

  const { ctx, page, logs } = await newPage({ width: 1440, height: 1000 });
  await page.goto(`${srv.url}/pro/`);
  await page.waitForSelector('[data-screen="dash"]:not([hidden])');
  check("resource calculation: Gestion d'atelier is in the menu, next to Demandes", await page.isVisible('.dash-link[data-panel="planning"]'));
  // ---- barre latérale : fixée tout à gauche sur toute la hauteur, repliable en icônes, choix mémorisé
  const rail = () => page.evaluate(() => {
    const n = document.querySelector(".dash-nav").getBoundingClientRect(), m = document.querySelector(".pro-main").getBoundingClientRect(), t = document.querySelector(".pro-top").getBoundingClientRect();
    const label = document.querySelector('.dash-link[data-panel="planning"] span:not(.dash-count)');
    return { left: Math.round(n.left), top: Math.round(n.top), topbar: Math.round(t.left), width: Math.round(n.width), main: Math.round(m.left), height: Math.round(n.height), label: label ? label.getBoundingClientRect().width : -1 };
  });
  await page.waitForFunction(() => !document.getAnimations().length); // le bandeau glisse à droite de la barre (transition de 0,18 s)
  const r0 = await rail();
  // identité du 24 octobre 2026 (maquette Parcours Atelier) : barre noire sur toute la hauteur, le bandeau du compte commence à sa droite
  check("rail: fixed at the far left, full height, the account bar starts at its right edge", r0.left === 0 && r0.top === 0 && r0.height >= 1000 - 1 && r0.topbar === r0.width && r0.main >= r0.width, JSON.stringify(r0));
  check("rail: expanded by default, with its labels and a « Replier le menu » button", r0.width >= 200 && r0.label > 20 && (await text(page, "#dashRail")) === "Replier le menu" && (await page.getAttribute("#dashRail", "aria-expanded")) === "true", JSON.stringify(r0));
  await page.click("#dashRail");
  await page.waitForFunction(() => document.querySelector(".dash-nav").getBoundingClientRect().width <= 80);
  const r1 = await rail();
  check("rail: folded to icons only, the content takes the room", r1.width <= 80 && r1.label <= 1 && r1.main < r0.main && (await page.getAttribute("#dashRail", "aria-expanded")) === "false" && (await words(page, "#dashRail")) === "Déplier le menu", JSON.stringify(r1));
  check("rail folded: each link keeps its name (for screen readers, and as a tooltip)", await page.$eval('.dash-link[data-panel="planning"]', (a) => a.textContent.trim() === "Gestion d'atelier" && a.title === "Gestion d'atelier"), await page.$eval('.dash-link[data-panel="planning"]', (a) => a.outerHTML));
  await axe(page, "barre latérale repliée");
  await shot(page, "0-rail-replie");
  await page.reload();
  await page.waitForSelector('[data-screen="dash"]:not([hidden])');
  check("rail: the choice is remembered on the next visit", (await rail()).width <= 80 && (await page.getAttribute("#dashRail", "aria-expanded")) === "false");
  await page.click("#dashRail");
  await page.waitForFunction(() => document.querySelector(".dash-nav").getBoundingClientRect().width >= 200);
  check("rail: unfolded again", (await rail()).width >= 200 && (await page.evaluate(() => localStorage.getItem("pixcar-pro-rail"))) === "full");
  await page.click('.dash-link[data-panel="planning"]');
  await page.waitForSelector("#dash-planning:not([hidden]):not([aria-busy]) .pl-grid");
  if (monday(D1) !== monday(today)) {
    await page.click("#planNext");
    await page.waitForFunction((d) => !!document.querySelector(`.pl-col[data-day="${d}"]`), D1);
  }
  check("the menu points at Gestion d'atelier, shown in the advanced display (first visit, resource calculation), the week view is the default on a computer", (await page.getAttribute('#planMode [data-display="advanced"]', "aria-checked")) === "true" && (await page.getAttribute('.dash-link[data-panel="planning"]', "aria-current")) === "true" && (await page.getAttribute('.pl-view[aria-pressed="true"]', "aria-pressed")) === "true" && (await text(page, '.pl-view[aria-pressed="true"]')) === "Semaine");
  const weekCols = await page.$$eval(".pl-col", (c) => c.map((x) => x.dataset.day));
  check("week: today's column says so", !weekColsHaveToday() || (await text(page, ".pl-colhead.is-today small")) === "Aujourd'hui");
  check("the page carries the published security policy (no inline style attribute allowed)", /(^|; )style-src 'self'(;|$)/.test(await page.$eval('meta[http-equiv="Content-Security-Policy"]', (m) => m.content)));
  const boxes = await page.$$eval(".pl-col", (c) => c.map((x) => { const r = x.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.height)]; }));
  check("week: the day columns sit side by side, as tall as the opening hours", boxes.length > 1 && boxes.every((b, i) => b[1] === boxes[0][1] && b[2] >= 480 && (i === 0 || b[0] > boxes[i - 1][0])), JSON.stringify(boxes));
  check("week: one column per open day (Monday to Friday), the closed week-end offered behind a button", weekCols.length === 5 && weekCols.includes(D1) && (await page.isVisible("#planWeekend")) && (await words(page, "#planWeekend")) === "Afficher le week-end", weekCols.join());
  // vue d'ensemble : quatre cartes (rendez-vous, charge, mécaniciens, alertes), comptées sur la semaine affichée
  const cards = await page.$$eval(".pl-card", (c) => c.map((x) => [...x.querySelectorAll(".pl-card-l, .pl-card-v, .pl-card-s")].map((n) => n.textContent.trim()).join(" ")));
  check("overview: four cards, in words", cards.length === 4 && /^Rendez-vous 3 1 à confirmer$/.test(cards[0]) && /^Charge atelier \d+ % \d+ h( \d\d)? \/ \d+ h$/.test(cards[1]) && (weekCols.includes(D2) ? /^Mécaniciens 2 1 absent sur la période$/ : /^Mécaniciens 2 Aucune absence$/).test(cards[2]) && /^Alertes \d /.test(cards[3]), cards.join(" | "));
  check("overview: its title names the period", /^Vue d'ensemble · (cette semaine|semaine du .+)$/.test(await words(page, "#planSumTitle")), await words(page, "#planSumTitle"));
  // charge de l'atelier, comme la page doit la compter : heures de travail planifiées des mécaniciens / heures d'ouverture des mécaniciens présents
  const ag0 = await agenda();
  const weekSet = new Set(weekCols);
  const labourMin = [...ag0.appointments, ...ag0.blocks].flatMap((x) => x.plan || []).filter((r) => r.target === "staff" && r.role === "labour" && weekSet.has(R.parisParts(Date.parse(r.start)).iso)).reduce((n, r) => n + (Date.parse(r.end) - Date.parse(r.start)) / 60000, 0);
  const availMin = weekCols.length * 2 * 8 * 60 - (weekSet.has(D2) ? 8 * 60 : 0); // deux mécaniciens, 8 h par jour, Léa en formation le jour D2
  check("overview: the workshop load is the mechanics' planned hours over their available hours", cards[1].startsWith(`Charge atelier ${Math.round((labourMin / availMin) * 100)} %`), `${cards[1]} / ${labourMin} min sur ${availMin}`);
  // chaque jour : heures planifiées / disponibles et nombre de rendez-vous
  const dayLoadText = (d) => text(page, `.pl-colhead:nth-child(${weekCols.indexOf(d) + 2}) .pl-load`);
  check("week: each day shows its load and its bookings", /^\d+ h( \d\d)? \/ 16 h · 3 rdv$/.test(await dayLoadText(D1)), await dayLoadText(D1));
  check("week: the day of Léa's training has 8 h available", !weekSet.has(D2) || /\/ 8 h · /.test(await dayLoadText(D2)), weekSet.has(D2) && (await dayLoadText(D2)));
  const ev = (id) => `.pl-ev[data-id="${id}"]`;
  const label = (id) => page.getAttribute(ev(id), "aria-label");
  check("week: the confirmed request, in words (work time and length, service, car, client and who, origin, confirmation, drop-off and return)", /^8:00–8:45 \(45 min\), Vidange.*, Peugeot 208 · EZ-108-BC, Julien Roux · (Paul|Léa) · Pont n°\d, Pixcar, Confirmé, Dépôt 8:00 · restitution 9:00$/.test(await label(julien)), await label(julien));
  check("week: the pending request says « À confirmer »", /Marie Curie.*, Pixcar, À confirmer, Dépôt 10:00 · restitution 11:00$/.test(await label(marie)), await label(marie));
  check("week: the phone booking says « Téléphone », the blocked slot « Créneau bloqué »", /^14:00–14:45 \(45 min\), .*, M\. Martin \(tél\.\) · Paul.*, Téléphone, Confirmé, Dépôt 14:00 · restitution 15:00$/.test(await label(job.saved)) && /^10:00–11:00 \(1 h\), Livraison pièces, Pont n°2, Créneau bloqué$/.test(await label(hold.saved)), [await label(job.saved), await label(hold.saved)].join(" / "));
  check("week: the tooltip carries the same detail, one line each", (await page.getAttribute(ev(julien), "title")) === (await label(julien)).split(", ").join("\n"), await page.getAttribute(ev(julien), "title"));
  const lines = await page.$eval(ev(julien), (b) => [...b.children].map((c) => c.className + ":" + [...c.childNodes].map((n) => n.textContent.trim()).filter(Boolean).join(" ")));
  // présentation de la maquette « Gestion d'atelier » : horaires et provenance (icône), prestation, voiture et avancement, puis les personnes
  // un bloc de 45 min (51 px) garde deux lignes, comme ceux de la maquette ; la voiture et l'avancement sont dans l'infobulle et la fiche
  check("week: a 45-minute block, as in the maquette: hours and origin (icon), then the service", lines.length === 2 && lines[0] === "pl-ev-h:08:00–08:45" && (await page.$eval(`${ev(julien)} .pl-ev-h use`, (u) => u.getAttribute("href"))) === "#i-globe" && (await page.$eval(`${ev(job.saved)} .pl-ev-h use`, (u) => u.getAttribute("href"))) === "#i-phone" && /^pl-ev-t:Vidange/.test(lines[1]), lines.join(" | "));
  const fits = () => page.$$eval(".pl-ev", (bs) => bs.filter((b) => b.scrollHeight > b.clientHeight + 1 || [...b.querySelectorAll(".pl-ev-h")].some((h) => h.scrollWidth > h.clientWidth + 1)).map((b) => b.getAttribute("aria-label")));
  check("week: every line drawn fits in its block, in height and in width", (await fits()).length === 0, (await fits()).join(" / "));
  const tone = (id) => page.$eval(ev(id), (b) => { const cs = getComputedStyle(b); return [[...b.classList].find((c) => c.startsWith("tone-")), cs.borderLeftWidth, cs.borderLeftColor, cs.backgroundColor].join(" "); });
  check("week: each block is tinted by its state, with a 3 px left edge (to confirm orange, upcoming blue, blocked slot grey)", /^tone-confirmed 3px rgb\(6, 89, 229\) rgb\(237, 243, 255\)$/.test(await tone(julien)) && /^tone-pending 3px rgb\(252, 73, 22\) rgb\(255, 240, 233\)$/.test(await tone(marie)) && /^tone-hold 3px rgb\(165, 171, 182\)/.test(await tone(hold.saved)), [await tone(julien), await tone(marie), await tone(hold.saved)].join(" / "));
  const holdLines = await page.$eval(ev(hold.saved), (b) => [...b.children].map((c) => c.className + ":" + c.textContent.trim()));
  check("week: a one-hour blocked slot shows its hours (padlock), its label and what it holds, no state", (await page.$eval(`${ev(hold.saved)} .pl-ev-h use`, (u) => u.getAttribute("href"))) === "#i-lock" && holdLines.join(" | ") === "pl-ev-h:10:00–11:00 | pl-ev-t:Livraison pièces | pl-ev-w:Pont n°2", holdLines.join(" | "));
  check("the legend sits under the grid, as in the maquette: states, slots, then origins and the count", /^À confirmer À venir En cours En attente Prête En conflit Créneau bloqué Pas proposé en ligne Fermé Absence ou maintenance Pixcar · Téléphone · 3 rendez-vous$/.test(await words(page, "#planLegend")) && (await page.evaluate(() => !!(document.getElementById("planGrid").compareDocumentPosition(document.getElementById("planLegend")) & Node.DOCUMENT_POSITION_FOLLOWING))), await words(page, "#planLegend"));
  const top = async (id) => page.$eval(ev(id), (e) => parseFloat(e.style.top));
  const k0 = await ppm(page);
  check("week: blocks sit at their hour (68 px per hour, as in the maquette, from the first hour shown)", Math.abs(k0 * 60 - 68) < 0.01 && near((await top(job.saved)) - (await top(julien)), 360 * k0), `${await top(julien)} → ${await top(job.saved)}`);
  // créneaux : midi fermé, jours passés grisés ; aujourd'hui et demain, pas proposés en ligne si la réservation l'interdit (ici minDelayH 0)
  const bands = await page.$eval(`.pl-col[data-day="${D1}"]`, (c) => [...c.querySelectorAll(".pl-off")].map((b) => [parseFloat(b.style.top), parseFloat(b.style.height), b.textContent]));
  check("week: the lunch break is drawn closed (12:00–14:00) and named « Pause déjeuner »", bands.some(([t, h, txt]) => near(t, (12 * 60 - 8 * 60) * k0) && near(h, 120 * k0) && txt === "Pause déjeuner"), JSON.stringify(bands));
  check("the planning shows no stray null / undefined", await noNull(page, "#dash-planning"), (await page.$eval("#dash-planning", (e) => e.innerText)).split("\n").filter((l) => /\b(null|undefined|NaN)\b/.test(l)).join(" | "));
  check("no page-wide horizontal scroll on a computer", (await overflow(page)) <= 0, await overflow(page));
  await axe(page, "planning · semaine");
  await shot(page, "1-semaine");
  // ---- maquette « Gestion d'atelier » : bandeau de chiffres masquable, recherche dans la période, plein écran
  await page.click("#planStripHide");
  check("the figures strip can be hidden (×), a link brings it back, and focus lands on it", (await page.$$(".pl-card")).length === 0 && (await page.evaluate(() => document.activeElement.id)) === "planStripShow" && (await words(page, "#planStripShow")) === "Afficher les indicateurs");
  await page.click("#planStripShow");
  check("the figures strip comes back with its four figures", (await page.$$(".pl-card")).length === 4 && (await page.evaluate(() => document.activeElement.id)) === "planStripHide");
  const found = () => page.$$eval(".pl-ev", (bs) => bs.map((b) => b.dataset.id));
  await page.fill("#planSearch", "julien");
  await live(page, /1 élément correspond à la recherche/);
  check("search: a client's name keeps only their booking in the displayed period", JSON.stringify(await found()) === JSON.stringify([julien]), JSON.stringify(await found()));
  await page.fill("#planSearch", "ez108");
  await page.waitForFunction(() => document.querySelectorAll(".pl-ev").length === 2);
  check("search: a plate typed without dashes finds the cars that carry it", (await found()).sort().join() === [julien, marie].sort().join(), JSON.stringify(await found()));
  await page.fill("#planSearch", "zzz");
  await live(page, /Rien ne correspond à la recherche/);
  check("search: nothing found, said in the grid", (await found()).length === 0 && /Aucun rendez-vous ne correspond à la recherche/.test(await text(page, ".pl-empty")));
  await page.fill("#planSearch", "");
  await live(page, /Recherche effacée/);
  check("search cleared: everything is back", (await found()).length === 4, JSON.stringify(await found()));
  await page.click("#planFocus");
  await page.waitForFunction(() => !document.getAnimations().length); // la marge glisse (transition de 0,18 s)
  const focus = () => page.evaluate(() => ({ nav: getComputedStyle(document.querySelector(".dash-nav")).display, top: getComputedStyle(document.querySelector(".pro-top")).display, strip: getComputedStyle(document.getElementById("planSummary")).display, left: Math.round(document.querySelector(".pro-main").getBoundingClientRect().left), pressed: document.getElementById("planFocus").getAttribute("aria-pressed"), text: document.getElementById("planFocusText").textContent }));
  const f1 = await focus();
  check("full screen: the side bar, the top line and the figures strip step aside, the planning takes the width", f1.nav === "none" && f1.top === "none" && f1.strip === "none" && f1.left === 0 && f1.pressed === "true" && f1.text === "Quitter le plein écran", JSON.stringify(f1));
  await shot(page, "1b-plein-ecran");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.getAnimations().length);
  const f2 = await focus();
  check("full screen: Escape leaves it", f2.nav !== "none" && f2.left >= 200 && f2.pressed === "false" && f2.text === "Plein écran" && (await page.evaluate(() => document.activeElement.id)) === "planFocus", JSON.stringify(f2));
  await page.click("#dashRail");
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.waitForFunction(() => document.querySelector(".dash-nav").getBoundingClientRect().width <= 80);
  check("week (menu folded, large screen): everything still fits", (await fits()).length === 0, (await fits()).join(" / "));
  await shot(page, "1-semaine-menu-replie");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.click("#dashRail");
  await page.waitForFunction(() => document.querySelector(".dash-nav").getBoundingClientRect().width >= 200);

  // ---- panneau d'un rendez-vous (demande du 24 octobre 2026) : il s'ajoute à droite de la grille, en transition, et la rétrécit sans la
  // couvrir ; le bloc ouvert est mis en évidence ; Échap le referme et rend le focus au bloc ; aucune transition en mouvement réduit
  const side = () => page.evaluate(() => {
    const g = document.getElementById("planGrid").getBoundingClientRect(), dl = document.getElementById("planDlg"), d = dl.getBoundingClientRect(), sc = document.querySelector("#planGrid .pl-scroll");
    return { grid: Math.round(g.width), gr: g.right, gt: g.top, left: d.left, right: d.right, bottom: d.bottom, width: Math.round(d.width), open: dl.open, modal: dl.matches(":modal"), vw: innerWidth, hscroll: sc.scrollWidth - sc.clientWidth, page: document.documentElement.scrollWidth - innerWidth };
  });
  const settle = () => page.waitForFunction(() => !document.getAnimations().length);
  await settle(); // la barre latérale vient de se déplier : la marge du contenu est encore en transition
  const wide = await side();
  await page.click(ev(julien));
  await page.waitForSelector("#planDlg[open] #planMove");
  check("side panel: it slides in (the grid's width is animated)", await page.evaluate(() => document.getAnimations().some((a) => a.transitionProperty === "grid-template-columns")));
  await settle();
  const opened = await side();
  check("side panel: non-modal, on the right of the grid, which shrinks instead of being covered", opened.open && !opened.modal && opened.left >= opened.gr + 8 && opened.right <= opened.vw && opened.grid <= wide.grid - 300 && opened.width >= 300, JSON.stringify({ wide, opened }));
  check("side panel: the week still fits without scrolling sideways, nor the page", opened.hscroll <= 1 && opened.page <= 0 && (await fits()).length === 0, JSON.stringify(opened) + " / " + (await fits()).join(" / "));
  check("side panel: the open appointment is highlighted in the grid", (await page.$$eval(".pl-ev.is-open", (b) => b.map((x) => x.dataset.id))).join() === julien);
  await shot(page, "2-panneau");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.getElementById("planDlg").open);
  await settle();
  const shut = await side();
  check("side panel: Escape closes it, the grid takes its width back and the block gets the focus", shut.grid === wide.grid && (await page.evaluate(() => document.activeElement.dataset.id)) === julien && !(await page.$(".pl-ev.is-open")), JSON.stringify(shut));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.click(ev(julien));
  await page.waitForSelector("#planDlg[open] #planMove");
  check("side panel, reduced motion: no transition", await page.evaluate(() => !document.getAnimations().length && getComputedStyle(document.getElementById("planLayout")).transitionDuration.split(",").every((t) => parseFloat(t) === 0)));
  await page.click("#planSideClose");
  check("side panel, reduced motion: « Fermer » closes it at once", await page.evaluate(() => !document.getElementById("planDlg").open));
  await page.emulateMedia({ reducedMotion: null });

  // ---- fiche d'un rendez-vous, déplacement au clavier
  await page.click(ev(julien));
  await page.waitForSelector("#planDlg[open] #planMove");
  await settle();
  const sheet = await text(page, "#planForm");
  check("sheet: origin, confirmation and work state apart; client and phone, car, service, drop-off, work, return, assignments", /^Rendez-vous Julien Roux Pixcar Confirmé Intervention : Prévue Client Julien Roux · 06 39 98 12 34 Voiture Peugeot 208 · EZ-108-BC/i.test(sheet) && /Dépôt .* à 8:00/.test(sheet) && /Travaux 8:00–8:45/.test(sheet) && /Affectations (Paul|Léa) · main-d'œuvre/.test(sheet) && /Pont n°\d · poste/.test(sheet), sheet);
  check("sheet: call and cancel are offered", (await page.getAttribute('#planForm a.btn[href^="tel:"]', "href")) === "tel:+33639981234" && /Annuler ce rendez-vous/.test(sheet));
  check("sheet: no stray null", await noNull(page, "#planForm"));
  await axe(page, "fiche d'un rendez-vous");
  await shot(page, "2-fiche");
  await page.click("#planMove");
  await page.waitForSelector("#planMvDay");
  check("move form: day, time, mechanic and post, the current values chosen", (await page.inputValue("#planMvDay")) === D1 && (await page.inputValue("#planMvTime")) === "08:00");
  // samedi : fermé → la cause et d'autres horaires
  let sat = D1;
  while (R.weekday(sat) !== "sa") sat = R.addDays(sat, 1);
  await page.fill("#planMvDay", sat);
  await page.click("#planMvSave");
  await page.waitForSelector("#planForm .pl-conflict");
  const why = await text(page, "#planForm .pl-conflict");
  const alts = await page.$$eval("#planForm .pl-alts .btn", (b) => b.map((x) => x.textContent));
  check("a closed day is refused with the cause, and other times are offered", /fermé/i.test(why) && alts.length >= 1, why + " / " + alts.join(" | "));
  await axe(page, "déplacement refusé, autres horaires");
  await shot(page, "3-conflit");
  await page.click("#planForm .pl-alts .btn >> nth=0");
  check("picking another time fills the form", (await page.inputValue("#planMvDay")) !== sat);
  // une heure possible, le même jour : la confirmation est demandée (le client sera prévenu)
  await page.fill("#planMvDay", D1);
  await page.fill("#planMvTime", "15:00");
  await page.selectOption("#planMvStaff", "");
  await page.selectOption("#planMvPost", "");
  await page.click("#planMvSave");
  await page.waitForSelector("#planForm .pl-ask");
  check("a new time asks for confirmation (the client gets an e-mail)", (await text(page, "#planMvSave")) === "Confirmer et prévenir le client" && /client/i.test(await text(page, "#planForm .pl-ask")), await text(page, "#planForm"));
  const mails = outbox.length;
  await page.click("#planMvSave");
  await closed(page);
  await live(page, /Enregistré/);
  let ag = await agenda();
  const j1 = ag.appointments.find((a) => a.id === julien);
  check("moved: the request is now at 15:00, the client got an e-mail", j1 && j1.when.start === "15:00" && outbox.length > mails && outbox.slice(mails).some((m) => m.target === "julien.roux@example.com"), JSON.stringify(j1 && j1.when));
  check("the alert says the client is told", /Déplacé\. Julien Roux : .* à 15:00\. Le client est prévenu par e-mail\./.test(await text(page, "#alert")), await text(page, "#alert"));

  // ---- glisser-déposer : vue Jour par mécanicien, le rendez-vous hors Pixcar de Paul vers Léa
  await page.click('.pl-view:has-text("Jour")');
  await page.waitForSelector("#planBy");
  if ((await page.$eval("#planRange", (e) => e.textContent)) !== R.dayLabel(D1, { year: true }).replace(/^./, (c) => c.toUpperCase())) {
    // le jour affiché peut être avant ou après D1 (le déplacement vers un samedi fermé a pu y mener la vue)
    const seen = [];
    for (let i = 0; i < 14 && !(await page.$(`.pl-col[data-day="${D1}"]`)); i++) {
      const shown = await page.$eval(".pl-col[data-day]", (c) => c.dataset.day);
      seen.push(shown);
      await page.click(shown < D1 ? "#planNext" : "#planPrev");
      await page.waitForTimeout(150);
    }
    if (!(await page.$(`.pl-col[data-day="${D1}"]`))) throw new Error(`day view: ${D1} never shown (${seen.join(" / ")})`);
  }
  const dayCols = await page.$$eval(".pl-colhead b", (h) => h.map((x) => x.textContent));
  check("day view: one column per mechanic", dayCols.join() === "Paul,Léa", dayCols.join());
  check("day view: the phone booking is in Paul's column", !!(await page.$(`.pl-col[data-staff="${paul}"] ${ev(job.saved)}`)));
  await axe(page, "planning · jour par mécanicien");
  await shot(page, "4-jour");
  await dragTo(page, `.pl-col[data-staff="${paul}"] ${ev(job.saved)}`, `.pl-col[data-staff="${lea}"]`, 14 * 60);
  await page.waitForSelector(`.pl-col[data-staff="${lea}"] ${ev(job.saved)}`, { timeout: 5000 }).catch(() => null);
  ag = await agenda();
  const k1 = ag.blocks.find((k) => k.id === job.saved);
  check("dragged to Léa: same time, Léa does it now", k1 && k1.when.start === "14:00" && k1.plan.some((r) => r.name === "Léa" && r.role === "labour") && !k1.plan.some((r) => r.name === "Paul"), JSON.stringify(k1 && k1.plan));
  check("and it shows in Léa's column", !!(await page.$(`.pl-col[data-staff="${lea}"] ${ev(job.saved)}`)));
  // glisser la demande à confirmer une heure plus tard : confirmation demandée dans la fiche
  const before = (await agenda()).appointments.find((a) => a.id === marie);
  const col = (await page.$(`.pl-col[data-staff="${paul}"] ${ev(marie)}`)) ? paul : lea;
  await dragTo(page, `.pl-col[data-staff="${col}"] ${ev(marie)}`, `.pl-col[data-staff="${col}"]`, minOfIso(before.plan.find((r) => r.role === "labour").start) + 60);
  await page.waitForSelector("#planDlg[open] .pl-ask");
  check("dragging a client's request to another hour asks for confirmation first", (await page.inputValue("#planMvTime")) === "11:00", await page.inputValue("#planMvTime"));
  check("dragged to another hour: the panel opens on the right with « Confirmer et prévenir le client »", (await text(page, "#planMvSave")) === "Confirmer et prévenir le client" && (await page.evaluate(() => !document.getElementById("planDlg").matches(":modal"))));
  const mailsDrag = outbox.length;
  await page.click("#planMvSave");
  await closed(page);
  ag = await agenda();
  check("confirmed: the request moved to 11:00, still with the same mechanic", ag.appointments.find((a) => a.id === marie).when.start === "11:00" && ag.appointments.find((a) => a.id === marie).plan.some((r) => r.id === col && r.role === "labour"));
  const movedMail = outbox.slice(mailsDrag).filter((m) => m.target === "marie.curie@example.com");
  check("the client gets the « Nouvel horaire » e-mail (rendez-vous déplacé, with the new time and the calendar file)", movedMail.length === 1 && /^Nouvel horaire : .*11:00/.test(movedMail[0].subject) && /déplace votre rendez-vous/.test(movedMail[0].text) && (movedMail[0].attachments || []).some((x) => x.type === "text/calendar"), JSON.stringify(movedMail.map((m) => [m.subject, (m.text || "").slice(0, 80)])));
  // glisser le même rendez-vous Pixcar vers l'autre mécanicien, même heure : le panneau s'ouvre aussi, à valider ; aucun e-mail au client
  const other = col === paul ? lea : paul;
  await page.waitForSelector(`.pl-col[data-staff="${col}"] ${ev(marie)}`);
  await dragTo(page, `.pl-col[data-staff="${col}"] ${ev(marie)}`, `.pl-col[data-staff="${other}"]`, 11 * 60);
  await page.waitForSelector("#planDlg[open] .pl-ask.is-info");
  check("dragged to the other mechanic at the same time: the panel opens, says the client is not disturbed, nothing saved yet", (await text(page, "#planMvSave")) === "Enregistrer l'affectation" && /aucun e-mail/.test(await text(page, "#planForm .pl-ask")) && (await agenda()).appointments.find((a) => a.id === marie).plan.some((r) => r.id === col && r.role === "labour"), await text(page, "#planForm"));
  const mailsAssign = outbox.length;
  await page.click("#planMvSave");
  await closed(page);
  const reassigned = (await agenda()).appointments.find((a) => a.id === marie);
  check("validated: the other mechanic does it, same time, no e-mail to the client", reassigned.when.start === "11:00" && reassigned.plan.some((r) => r.id === other && r.role === "labour") && !outbox.slice(mailsAssign).some((m) => m.target === "marie.curie@example.com"), JSON.stringify(reassigned.plan));

  // ---- menu « Nouveau » (clavier), puis création rapide
  // les choix d'une liste (boutons à bascule) se cochent par leur libellé, comme à la souris
  const pick = (name, value) => page.click(`label:has(> input[name="${name}"][value="${value}"])`);
  await page.click("#planNew");
  check("the arrow next to « Nouveau rendez-vous » opens a menu of five choices, focus on the first", (await page.getAttribute("#planNew", "aria-expanded")) === "true" && (await page.$$eval("#planNewMenu button:not([hidden])", (b) => b.map((x) => x.textContent.trim()).join(" | "))) === "Rendez-vous (téléphone, comptoir) | Client déjà sur place | Créneau bloqué | Absence d'un mécanicien | Indisponibilité d'un poste" && (await page.evaluate(() => document.activeElement.dataset.new)) === "job");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  check("the menu: arrows move between the choices", (await page.evaluate(() => document.activeElement.dataset.new)) === "staff");
  await page.keyboard.press("Escape");
  check("the menu: Escape closes it, focus back on « Nouveau »", (await page.isHidden("#planNewMenu")) && (await page.getAttribute("#planNew", "aria-expanded")) === "false" && (await page.evaluate(() => document.activeElement.id)) === "planNew");
  await page.click("#planNew");
  await page.click("#planTitle");
  check("the menu: a click elsewhere closes it", await page.isHidden("#planNewMenu"));
  await page.click("#planNew");
  await page.click('#planNewMenu [data-new="job"]');
  await page.waitForSelector("#planDlg[open] #planLabel");
  check("quick creation: a phone booking by default, the day shown, no stray null", (await page.isChecked('input[name="planKind"][value="job"]')) && (await page.inputValue("#planDay")) === D1 && (await noNull(page, "#planForm")));
  await axe(page, "création rapide");
  await page.click("#planSave");
  await page.waitForFunction(() => !document.getElementById("planErr").hidden);
  check("an empty booking is refused, saying what is missing", /Choisissez au moins une prestation/.test(await text(page, "#planErr")), await text(page, "#planErr"));
  // un créneau bloqué sur Paul pendant la demande de Julien (15:00) : refusé, avec la cause
  await pick("planKind", "hold");
  await page.waitForSelector("#planTo");
  check("switching to a blocked slot keeps the focus on the choice", (await page.evaluate(() => document.activeElement.value)) === "hold");
  await page.fill("#planLabel", "Réunion fournisseur");
  const jWho = (await agenda()).appointments.find((a) => a.id === julien).plan.find((r) => r.role === "labour").id;
  await page.fill("#planTime", "15:00");
  await page.fill("#planTo", "15:30");
  await pick("planHoldStaff", jWho);
  await page.click("#planSave");
  await page.waitForSelector("#planForm .pl-conflict");
  check("a blocked slot over a booking is refused, with who is busy", /déjà occupé/.test(await text(page, "#planForm .pl-conflict")), await text(page, "#planForm .pl-conflict"));
  await page.fill("#planTime", "16:30");
  await page.fill("#planTo", "17:30");
  await page.click("#planSave");
  await closed(page);
  await live(page, /Créneau bloqué enregistré/);
  ag = await agenda();
  const meeting = ag.blocks.find((k) => k.label === "Réunion fournisseur");
  check("the blocked slot is saved and drawn", meeting && meeting.when.start === "16:30" && meeting.when.end === "17:30" && !!(await page.$(ev(meeting.id))), JSON.stringify(meeting));
  // clic sur une case vide : création au jour et à la colonne choisis
  await page.locator(`.pl-col[data-staff="${paul}"]`).click({ position: { x: 20, y: (9 * 60 - Number(await page.$eval(".pl-grid", (g) => g.dataset.lo))) * (await ppm(page)) + 4 } });
  await page.waitForSelector("#planDlg[open] #planLabel");
  check("a click on an empty cell opens the creation at that time, for that mechanic", (await page.inputValue("#planTime")) === "09:00" && (await page.inputValue("#planStaff")) === paul);
  await page.fill("#planLabel", "Mme Petit (comptoir)");
  await pick("planSvc", "vidange");
  check("a service ticked keeps the focus", (await page.evaluate(() => document.activeElement.value)) === "vidange");
  await page.click("#planSave");
  await closed(page);
  ag = await agenda();
  const petit = ag.blocks.find((k) => k.label === "Mme Petit (comptoir)");
  check("a phone booking is placed by the engine with the mechanic chosen, and no e-mail is sent", petit && petit.when.start === "09:00" && petit.plan.some((r) => r.id === paul && r.role === "labour"), JSON.stringify(petit));
  // un autre, déposé à 9:00 avec Paul, pris jusqu'à 9:45 : les travaux attendraient ; Pixcar le dit et demande confirmation
  await page.click("#planNew");
  await page.click('#planNewMenu [data-new="job"]');
  await page.waitForSelector("#planDlg[open] #planLabel");
  await page.fill("#planLabel", "M. Leroy (tél.)");
  await page.fill("#planDay", D1);
  await page.fill("#planTime", "09:00");
  await pick("planSvc", "vidange");
  await page.selectOption("#planStaff", paul);
  await page.click("#planSave");
  await page.waitForSelector("#planForm .pl-ask");
  const askText = await text(page, "#planForm .pl-ask");
  check("a booking whose work would wait asks to confirm: the cause, the work and return times", /^Paul : déjà occupé de 9:00 à 9:45\. Travaux de 9:45 à 10:30, voiture prête vers 10:45 : confirmez, ou choisissez un horaire sans attente\.$/.test(askText) && (await text(page, "#planSave")) === "Confirmer ces horaires" && (await page.evaluate(() => document.activeElement.id)) === "planSave", askText);
  check("…with drop-off times that need no wait", (await page.$$eval("#planForm .pl-alts .btn", (b) => b.length)) >= 1 && /sans attente/.test(await text(page, "#planForm .pl-alts p")));
  check("nothing is saved before the confirmation", !(await agenda()).blocks.some((k) => k.label === "M. Leroy (tél.)"));
  await axe(page, "rendez-vous hors Pixcar : travaux décalés");
  await shot(page, "4-attente");
  await page.click("#planSave");
  await closed(page);
  ag = await agenda();
  const leroy = ag.blocks.find((k) => k.label === "M. Leroy (tél.)");
  check("confirmed: dropped off at 9:00, Paul works on it from 9:45, the alert says so", leroy && leroy.when.start === "09:00" && leroy.plan.some((r) => r.id === paul && r.role === "labour" && minOfIso(r.start) === 9 * 60 + 45) && /travaux de 9:45 à 10:30/.test(await text(page, "#alert")), JSON.stringify(leroy && leroy.plan) + " / " + (await text(page, "#alert")));
  await page.click('.pl-view:has-text("Semaine")');
  await page.waitForSelector(`.pl-col[data-day="${D1}"] ${ev(leroy.id)}`);
  check("week: the block is drawn over the work (9:45), after Mme Petit's, not over the drop-off", near(await top(leroy.id), (9 * 60 + 45 - Number(await page.$eval(".pl-grid", (g) => g.dataset.lo))) * (await ppm(page))) && /Dépôt 9:00 · restitution 10:45$/.test(await label(leroy.id)), `${await top(leroy.id)} · ${await label(leroy.id)}`);
  check("week: with Paul's work in sequence, the two blocks sit full width, not side by side", await page.$$eval(`${ev(leroy.id)}, ${ev(petit.id)}`, (b) => b.length === 2 && b.every((x) => x.style.getPropertyValue("--lanes") === "1")));
  await page.click(ev(leroy.id));
  await page.waitForSelector("#planDlg[open] #planMove");
  check("the sheet gives drop-off, work and return", /Dépôt .* à 9:00/.test(await text(page, "#planForm")) && /Travaux 9:45–10:30/.test(await text(page, "#planForm")) && /Restitution 10:45/.test(await text(page, "#planForm")), await text(page, "#planForm"));
  await page.click('#planSideClose');
  await pro("DELETE", `/rdv/calendar/blocks/${leroy.id}`);

  // ---- filtres : repliés derrière un bouton, les filtres actifs en puces
  await page.click('.pl-view:has-text("Semaine")');
  await page.waitForFunction((sel) => !document.querySelector(sel), ev(leroy.id));
  check("filters: folded by default, one « Filtres » button", (await page.isHidden("#planFilters")) && (await page.getAttribute("#planFToggle", "aria-expanded")) === "false" && (await page.$$eval(".pl-chip", (c) => c.length)) === 0);
  await page.click("#planFToggle");
  check("filters: the button unfolds the panel on the left: state and origin as choices, then service, mechanic and post as lists", (await page.isVisible("#planFilters")) && (await page.$$eval("#planFilters legend", (x) => x.map((l) => l.textContent).join())) === "État,Origine" && (await page.$$eval("#planFilters select", (x) => x.map((s) => s.id).join())) === "planFService,planFStaff,planFPost");
  await pick("planFOrigin", "hold");
  await live(page, /Filtre appliqué/);
  const shown = await page.$$eval(".pl-ev", (e) => e.map((x) => x.dataset.id).sort());
  check("filter « Créneau bloqué »: only the blocked slots", shown.join() === [hold.saved, meeting.id].sort().join(), shown.join());
  check("an active filter shows as a chip, and the button counts it", (await words(page, "#planChips")) === "Origine : Créneau bloqué" && (await words(page, "#planFCount")) === "1" && (await page.getAttribute("#planFToggle", "aria-label")) === "Filtres, 1 actif");
  await pick("planFOrigin", "");
  await page.selectOption("#planFStaff", lea);
  const leaOnly = await page.$$eval(".pl-ev", (e) => e.map((x) => x.dataset.id));
  check("filter « Léa »: only what Léa does", leaOnly.includes(job.saved) && !leaOnly.includes(petit.id), leaOnly.join());
  await pick("planFState", "pending");
  check("filter « À confirmer » with Léa: both apply, two chips and « Tout retirer »", (await page.$$eval(".pl-ev", (e) => e.map((x) => x.dataset.id))).every((id) => id === marie) && (await page.$$eval(".pl-chip:not(.is-reset)", (c) => c.length)) === 2 && (await page.isVisible(".pl-chip.is-reset")));
  await axe(page, "planning · filtres");
  await shot(page, "5-filtres");
  await page.click('.pl-chip:has-text("État")');
  check("a chip removes its filter, focus back on the « Filtres » button", (await page.$$eval(".pl-chip", (c) => c.length)) === 1 && (await page.evaluate(() => document.activeElement.id)) === "planFToggle");
  await page.click("#planFReset");
  check("filters reset: everything is back, focus on the « Filtres » button", (await page.$$eval(".pl-ev", (e) => e.length)) === 6 && (await page.evaluate(() => document.activeElement.id)) === "planFToggle" && (await page.$$eval(".pl-chip", (c) => c.length)) === 0);
  await page.click("#planFToggle");
  check("filters: folded again", await page.isHidden("#planFilters"));

  // ---- absence par le menu « Nouveau » : le rendez-vous de Julien (15:00) touché, « En conflit » ; la carte d'alerte filtre
  await page.click("#planNew");
  await page.click('#planNewMenu [data-new="staff"]');
  await page.waitForSelector("#planDlg[open] #planUnWho");
  check("absence form: mechanic, reason, dates and hours, no stray null", (await page.$$eval("#planUnKind option", (o) => o.map((x) => x.textContent).join())).includes("Formation") && (await noNull(page, "#planForm")));
  await axe(page, "absence d'un mécanicien");
  await page.selectOption("#planUnWho", jWho);
  await page.fill("#planUnFirst", D1);
  await page.fill("#planUnLast", D1);
  await page.fill("#planUnFrom", "15:00");
  await page.fill("#planUnTo", "15:30");
  await page.click("#planUnSave");
  await closed(page);
  await live(page, /Absence enregistrée/);
  // la même absence une seconde fois : refusée, la période déjà saisie nommée, le formulaire reste ouvert
  await page.click("#planNew");
  await page.click('#planNewMenu [data-new="staff"]');
  await page.waitForSelector("#planDlg[open] #planUnWho");
  await page.selectOption("#planUnWho", jWho);
  await page.fill("#planUnFirst", D1);
  await page.fill("#planUnLast", D1);
  await page.fill("#planUnFrom", "15:15");
  await page.fill("#planUnTo", "16:00");
  await page.click("#planUnSave");
  await page.waitForFunction(() => !document.getElementById("planErr").hidden);
  check("an absence over one already entered is refused, naming it; the form stays open", /est déjà absent sur cette période \(Absence : .+ \(15:00–15:30\)\)\. Choisissez d'autres dates ou heures, ou retirez d'abord cette absence\./.test(await text(page, "#planErr")) && (await page.evaluate(() => document.getElementById("planDlg").open)), await text(page, "#planErr"));
  check("and nothing is added", (await agenda()).unavail.filter((u) => u.targetId === jWho && u.first === D1).length === 1);
  await page.click('#planForm .btn:has-text("Annuler")');
  await closed(page);
  check("the alert says which bookings it touches", /Absence enregistrée\. 1 rendez-vous à venir est touché : il apparaît « En conflit » dans le planning\./.test(await text(page, "#alert")), await text(page, "#alert"));
  check("the touched booking is marked « En conflit » (red tone, words, resource alert)", (await page.$eval(ev(julien), (b) => b.classList.contains("is-conflict") && b.classList.contains("tone-conflict"))) && /, En conflit, Dépôt 15:00 · restitution 16:00$/.test(await label(julien)), await label(julien));
  check("the absence is drawn on the day's load (an hour less: 15 h 30 available)", /\/ 15 h 30 · /.test(await dayLoadText(D1)), await dayLoadText(D1));
  check("overview: the alert card counts the conflict", /^Alertes [1-9]\d* .*1 conflit/.test(await words(page, ".pl-card.is-alert")), await words(page, ".pl-card.is-alert"));
  await page.click(".pl-card.is-alert .pl-card-btn");
  check("the alert card shows the conflicts only", (await page.$$eval(".pl-ev", (e) => e.map((x) => x.dataset.id).join())) === julien && (await words(page, "#planChips")) === "État : En conflit", await words(page, "#planChips"));
  await shot(page, "5-conflit");
  await page.click(".pl-chip");
  // week-end : fermé, masqué ; affiché à la demande, grisé
  await page.click("#planWeekend");
  await live(page, /Week-end affiché/);
  const all7 = await page.$$eval(".pl-col", (c) => c.map((x) => x.dataset.day));
  const sun = all7[6];
  check("week-end shown: seven columns, Saturday and Sunday drawn closed", all7.length === 7 && R.weekday(sun) === "su" && (await page.$eval(`.pl-col[data-day="${sun}"]`, (c) => { const o = c.querySelector(".pl-off"); return !!o && Math.abs(o.getBoundingClientRect().height - c.getBoundingClientRect().height) < 2; })) && /Fermé/.test(await text(page, ".pl-colhead:nth-child(8) .pl-load")), all7.join());
  check("the button now hides it", (await words(page, "#planWeekend")) === "Masquer le week-end" && (await page.evaluate(() => document.activeElement.id)) === "planWeekend");
  await page.click("#planWeekend");
  check("week-end hidden again", (await page.$$eval(".pl-col", (c) => c.length)) === 5);

  // ---- mois
  await page.click('.pl-view:has-text("Mois")');
  await page.waitForSelector(".pl-month");
  // les jours du mois voisin (« is-out ») portent aussi un numéro : le 28 septembre ouvre la grille d'octobre 2026
  const cell = page.locator(".pl-mday:not(.is-out)").filter({ has: page.locator("b", { hasText: new RegExp(`^${Number(D1.slice(8))}$`) }) }).first();
  check("month: six weeks of days, the busy day counts its bookings", (await page.$$eval(".pl-mday", (c) => c.length)) === 42 && /5 éléments/.test(await cell.innerText()), await cell.innerText());
  await axe(page, "planning · mois");
  await shot(page, "5-mois");
  await cell.click();
  await page.waitForSelector("#planBy");
  check("a day of the month opens that day", (await text(page, '.pl-view[aria-pressed="true"]')) === "Jour" && !!(await page.$(`.pl-col[data-day="${D1}"]`)));

  // ---- espaces Équipe (absence de Léa) et Équipements (livraison sur le pont n°2), le jour D2, en lignes
  const space = async (name) => {
    await page.click(`#planSpaces .pl-space:has-text("${name}")`);
    await page.waitForSelector(`#planSpaces .pl-space[aria-pressed="true"]:has-text("${name}")`);
  };
  await space("Équipe");
  check("spaces: Agenda, Équipe, Équipements, Suivi, Charge (the four modules of Mon garage are on)", (await page.$$eval("#planSpaces .pl-space", (b) => b.map((x) => x.textContent.trim()).join())) === "Agenda,Équipe,Équipements,Suivi,Charge");
  if ((await page.$eval(".pl-view[aria-pressed=true]", (b) => b.textContent)) !== "Jour") await page.click('.pl-view:has-text("Jour")');
  // aujourd'hui, puis jour après jour jusqu'à D2
  const dayTitle = (d) => R.dayLabel(d, { year: true }).replace(/^./, (c) => c.toUpperCase());
  await page.click("#planToday");
  await page.waitForFunction((t) => document.getElementById("planRange").textContent === t, dayTitle(today));
  for (let d = today; d < D2; ) {
    d = R.addDays(d, 1);
    await page.click("#planNext");
    await page.waitForFunction((t) => document.getElementById("planRange").textContent === t && !document.getElementById("dash-planning").hasAttribute("aria-busy"), dayTitle(d));
  }
  await page.waitForSelector(`.pl-tl-track[data-staff="${lea}"]`);
  check("Équipe: one row per mechanic, Léa's training drawn on her row, in words", /Formation/.test(await text(page, `.pl-tl-track[data-staff="${lea}"] .pl-away`)), await page.$eval(`.pl-tl-track[data-staff="${lea}"]`, (t) => t.innerText));
  await shot(page, "6-equipe");
  await space("Équipements");
  await page.waitForSelector(`.pl-tl-track[data-post="${lift2}"]`);
  check("Équipements: the delivery blocks Pont n°2 on its row", !!(await page.$(`.pl-tl-track[data-post="${lift2}"] ${ev(hold.saved)}`)));
  await axe(page, "gestion d'atelier · équipements");

  // ---- supprimer un bloc, annuler un rendez-vous
  await page.click(ev(hold.saved));
  await page.waitForSelector("#planDlg[open] #planDel");
  await page.click("#planDel");
  check("deleting asks to confirm", (await text(page, "#planDel")) === "Confirmer la suppression");
  await page.click("#planDel");
  await closed(page);
  await live(page, /Supprimé/);
  check("the blocked slot is gone", !(await agenda()).blocks.some((k) => k.id === hold.saved) && !(await page.$(ev(hold.saved))));
  await space("Agenda");
  await page.click('.pl-view:has-text("Semaine")');
  await page.waitForSelector(ev(julien));
  await page.click(ev(julien));
  await page.click('#planForm .link-btn:has-text("Annuler ce rendez-vous")');
  await page.waitForSelector('input[name="planWhy"]');
  await page.click("#planWhySave");
  check("cancelling asks for a reason, sent to the client", /Choisissez un motif/.test(await text(page, "#planErr")));
  await page.check('input[name="planWhy"][value="workshop"]');
  await page.click("#planWhySave");
  await closed(page);
  check("cancelled: gone from the planning, the client is told", !(await agenda()).appointments.some((a) => a.id === julien) && /Rendez-vous annulé/.test(await text(page, "#alert")));
  check("the Espace Pro privacy note tells how long what the garage types about a client is kept, and that Pixcar acts on its behalf", /Pour un rendez-vous que vous saisissez, le nom du client, son téléphone, son véhicule, l'immatriculation et votre commentaire interne sont effacés 30 jours après le rendez-vous, le rendez-vous lui-même 24 mois après/.test(await page.$eval(".pro-privacy", (d) => d.textContent)) && /comme sous-traitant \(article 28 du RGPD\)/.test(await page.$eval(".pro-privacy", (d) => d.textContent)));
  // ---- barre latérale sans latence (demande du 25 octobre 2026) : avec une API lente (1,5 s pour la fiche du garage), l'écran change dès
  // le clic, une barre fine dit le chargement, le contenu arrive ensuite ; un écran quitté entre-temps ne reprend ni l'affichage ni le focus
  await page.route("**/profile", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue().catch(() => {});
  });
  const t0 = Date.now();
  await page.click('.dash-link[data-panel="garage"]');
  const instant = await page.evaluate(() => ({
    shown: !document.getElementById("dash-garage").hidden,
    busy: document.getElementById("dash-garage").getAttribute("aria-busy"),
    bar: !document.getElementById("dashBusy").hidden,
    current: document.querySelector('.dash-link[data-panel="garage"]').getAttribute("aria-current"),
    crumb: document.getElementById("crumb").textContent,
    planning: document.getElementById("dash-planning").hidden,
  }));
  check("slow API: the click switches the screen at once (menu, crumb, busy bar), before the data", instant.shown && instant.busy === "true" && instant.bar && instant.current === "true" && /Mon garage/.test(instant.crumb) && instant.planning && Date.now() - t0 < 1200, JSON.stringify(instant));
  await page.waitForSelector("#dash-garage:not([aria-busy])");
  check("slow API: once loaded, the bar goes, the title has the focus", (await page.isHidden("#dashBusy")) && (await page.evaluate(() => document.activeElement.id)) === "mgTitle" && Date.now() - t0 >= 1400);
  await page.click('.dash-link[data-panel="top"]');
  await page.waitForSelector("#dash-top:not([hidden]):not([aria-busy])");
  await page.click('.dash-link[data-panel="garage"]');
  await page.click('.dash-link[data-panel="planning"]');
  await page.waitForSelector("#dash-planning:not([hidden]):not([aria-busy])");
  await page.waitForTimeout(1700); // la fiche du garage arrive après coup
  check("slow API: a screen left before its data came does not come back nor take the focus", (await page.isVisible("#dash-planning")) && (await page.isHidden("#dash-garage")) && (await page.evaluate(() => document.activeElement.id)) !== "mgTitle" && (await page.isHidden("#dashBusy")));
  await page.unroute("**/profile");

  check("no console error, no page error", !logs.length, logs.join("\n"));
  await ctx.close();

  // ---- tablette et téléphone
  for (const [name, width, height] of [["tablette", 820, 1180], ["telephone", 390, 844]]) {
    const m = await newPage({ width, height, touch: name === "telephone" });
    await m.page.goto(`${srv.url}/pro/`);
    await m.page.waitForSelector('[data-screen="dash"]:not([hidden])');
    if (name === "telephone") {
      // depuis la maquette « Parcours Atelier » (24 octobre 2026) : rail d'icônes de 64 px à gauche, plus de barre du bas ni de « Plus »
      const rail = await m.page.evaluate(() => ({ w: Math.round(document.getElementById("dashNav").getBoundingClientRect().width), left: Math.round(document.getElementById("dashNav").getBoundingClientRect().left) }));
      check("phone: the 64 px icon rail on the left shows Gestion d'atelier and Mon garage, no « Plus » menu", rail.w === 64 && rail.left === 0 && (await m.page.isVisible('.dash-link[data-panel="planning"]')) && (await m.page.isVisible('.dash-link[data-panel="garage"]')) && (await m.page.isHidden("#dashMore")), JSON.stringify(rail));
    }
    await m.page.click('.dash-link[data-panel="planning"]');
    await m.page.waitForSelector("#dash-planning:not([hidden]):not([aria-busy]) .pl-grid");
    if (name === "telephone") check("phone: the day view is the default, the filters are folded", (await text(m.page, '.pl-view[aria-pressed="true"]')) === "Jour" && (await m.page.isHidden("#planFilters")));
    check(`${name}: no page-wide horizontal scroll (the grid scrolls inside its box)`, (await overflow(m.page)) <= 0, await overflow(m.page));
    await axe(m.page, `planning · ${name}`);
    await shot(m.page, `7-${name}`);
    await m.page.click("#planNewRdv");
    await m.page.waitForSelector("#planDlg[open] #planLabel");
    await m.page.waitForFunction(() => !document.getAnimations().length);
    // pas la place à côté : le panneau se place au-dessus de la grille, qui reste visible en dessous (rien n'est recouvert)
    check(`${name}: the creation panel fits the screen, above the grid, without covering it`, await m.page.evaluate(() => { const r = document.getElementById("planDlg").getBoundingClientRect(), g = document.getElementById("planGrid").getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth + 1 && r.bottom <= g.top && !document.getElementById("planDlg").matches(":modal"); }));
    await shot(m.page, `7-${name}-creation`);
    check(`${name}: no console error`, !m.logs.length, m.logs.join("\n"));
    await m.ctx.close();
  }

  await browser.close();
  await api.close();
  srv.close && srv.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} cas passés`);
  process.exit(failed.length ? 1 : 0);

  function weekColsHaveToday() {
    return monday(today) === monday(D1) && workday(today);
  }
  function minOfIso(iso) {
    return R.parisParts(Date.parse(iso)).min;
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
