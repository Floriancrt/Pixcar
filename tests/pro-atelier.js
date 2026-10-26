// Espace Pro, Gestion d'atelier en affichage simple (docs/gestion-atelier.md, P0) de bout en bout : page construite pour de bon, vraie
// API (PGlite), un garage qui calcule ses disponibilités par créneaux (une place le matin, une l'après-midi), sans mécanicien ni poste.
// Parcours : l'écran s'ouvre en affichage simple (chiffres du jour, places en ligne restantes) → « Nouveau rendez-vous » au clavier
// (prestation, durée proposée, client, téléphone, véhicule, immatriculation, canal, commentaire) → la place est prise en ligne → un
// second dans la place prise : « complet », enregistré quand même → créneau bloqué de tout l'atelier, puis un qui chevauche un
// rendez-vous → fiche (client, appeler, temps estimé, commentaire, changer l'horaire : les données restent) → client déjà sur place,
// avancement jusqu'à « prête » → liste → affichage avancé gardé sur le compte → un module coupé dans Mon garage → téléphone ; axe.
//   node tests/pro-atelier.js
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
const OUT = path.join(__dirname, ".out", "pro-atelier-site");
const SHOTS = path.join(__dirname, ".out", "shots");
const SRC = process.env.PIXCAR_SRC || path.join(ROOT, "src");
const BUILD = process.env.PIXCAR_BUILD ? path.resolve(ROOT, process.env.PIXCAR_BUILD) : path.join(ROOT, "scripts/build.mjs");
const LEGAL = { editorLine: "Pixcar est édité à titre non professionnel par Jeanne Exemple, responsable du traitement des données décrites ici.", contact: "contact@exemple.test", hostPages: "GitHub, Inc. (GitHub Pages), États-Unis", hostApi: "Amazon Web Services EMEA SARL, Luxembourg (région Europe, Stockholm)", repairRetentionMonths: 24, updated: "3 octobre 2026" };
const HERE = { lat: 43.2174, lon: 1.1014 };
const GARAGE = "aaaaaaaa-0000-4000-8000-000000000003";
const CONTACTS = [{ id: GARAGE, name: "Garage Démo Atelier", addr: "16 rue de l'Exemple, 31220 Cazères", pc: "31220", ...HERE, emails: ["contact@garage-atelier.fr"], phones: ["+33561000003"] }];
const ACCOUNT = "sub-atelier";
const TOKEN = `tok.${ACCOUNT}.1`;
const DAY = [["08:00", "12:00"], ["14:00", "18:00"]];
const WEEK = { mo: DAY, tu: DAY, we: DAY, th: DAY, fr: DAY };
const NOTIFY = "atelier@garage-atelier.fr";

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
  // D1 : le jour ouvré qui suit le prochain (comme tests/pro-planning.js)
  const today = R.parisParts(Date.now()).iso;
  const workday = (iso) => !["sa", "su"].includes(R.weekday(iso));
  let next = R.addDays(today, 1);
  while (!workday(next)) next = R.addDays(next, 1);
  let D1 = R.addDays(next, 1);
  while (!workday(D1)) D1 = R.addDays(D1, 1);
  const monday = (iso) => R.addDays(iso, -["mo", "tu", "we", "th", "fr", "sa", "su"].indexOf(R.weekday(iso)));

  // garage ouvert, calcul par créneaux : une voiture à la fois le matin (« Matin »), une l'après-midi (« Après-midi »)
  const ok =
    (await pro("PUT", "/profile", { hours: WEEK })).status === 200 &&
    (await Promise.all([["vidange", 45], ["plaq_av", 60]].map(([s, m]) => pro("PUT", `/services/${s}`, { offered: true, minutes: m })))).every((r) => r.status === 200) &&
    (await pro("POST", "/rdv/notify", { email: NOTIFY })).status === 200 &&
    (await pro("POST", "/rdv/notify/code", { code: lastCode(NOTIFY) })).status === 200 &&
    (await pro("POST", "/rdv/slots", { name: "Matin", days: ["mo", "tu", "we", "th", "fr"], start: "08:00", end: "12:00", mode: "hour", capacity: 1, services: ["vidange", "plaq_av"] })).status === 200 &&
    (await pro("POST", "/rdv/slots", { name: "Après-midi", days: ["mo", "tu", "we", "th", "fr"], start: "14:00", end: "18:00", mode: "hour", capacity: 1, services: ["vidange", "plaq_av"] })).status === 200 &&
    (await pro("PUT", "/rdv/settings", { enabled: true, minDelayH: 0, horizonDays: 28 })).status === 200;
  check("setup: the garage takes requests, slots of one car at a time", ok);
  const agenda = async (from = monday(D1), to = R.addDays(monday(D1), 6)) => (await pro("GET", `/rdv/calendar/agenda?from=${from}&to=${to}`)).body;
  const times = async (day = D1) => ((await call("GET", `/v1/rdv/garages/${GARAGE}/times?services=vidange`)).body.days.find((d) => d.day === day) || { times: [] }).times.map((x) => x.t);

  // ---- construction (comme la version publiée : politique de sécurité dans la page)
  const src = path.join(OUT, "src");
  fs.cpSync(SRC, src, { recursive: true });
  fs.writeFileSync(path.join(src, "legal.json"), JSON.stringify(LEGAL));
  const env = { ...process.env, PIXCAR_API_BASE: api.url, PIXCAR_PRO_POOL: "eu-north-1_PixcarTest1", PIXCAR_PRO_CLIENT: "4pro0test1client2id3", PIXCAR_GA_ID: "", PIXCAR_CS_ID: "", PIXCAR_MAPBOX_TOKEN: "" };
  execFileSync(process.execPath, [BUILD, "--only", "dist", "--src", src, "--out", path.join(OUT, "site"), "--pages", "pixcar.fr"], { stdio: "pipe", env });
  srv.setRoot(path.join(OUT, "site", "dist"));

  const browser = await chromium.launch({ args: ["--proxy-server=direct://", "--proxy-bypass-list=*"] });
  async function newPage({ width = 1440, height = 1000, touch = false } = {}) {
    const ctx = await browser.newContext({ viewport: { width, height }, locale: "fr-FR", serviceWorkers: "block", hasTouch: touch, isMobile: touch });
    await ctx.addInitScript(([token, account]) => sessionStorage.setItem("pixcar-pro-session", JSON.stringify({ email: "camille@garage-atelier.fr", access: token, refresh: "ref." + account, expiresAt: Date.now() + 3600e3 })), [TOKEN, ACCOUNT]);
    await ctx.route("**/*", (route) => (new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort()));
    const page = await ctx.newPage();
    const logs = [];
    const expected = (m) => /status of (400|401|409|422)\b/.test(m.text()) || (/status of 404\b/.test(m.text()) && /\/registry$/.test(m.location().url));
    page.on("console", (m) => ["error", "warning"].includes(m.type()) && !expected(m) && logs.push(`[${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => logs.push("[pageerror] " + e.message));
    return { ctx, page, logs };
  }
  const axe = async (page, label) => {
    await page.waitForFunction(() => !document.getAnimations().some((a) => a instanceof CSSTransition));
    await page.evaluate(AXE);
    const r = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } })).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`));
    check(`axe: no violation on « ${label} »`, r.length === 0, r.join("\n"));
  };
  const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `pro-atelier-${name}.png`), fullPage: true });
  const text = (page, sel) => page.$eval(sel, (e) => e.innerText.replace(/\s+/g, " ").trim());
  const words = (page, sel) => page.$eval(sel, (e) => { const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT), out = []; while (w.nextNode()) out.push(w.currentNode.textContent); return out.join(" ").replace(/\s+/g, " ").trim(); });
  const live = (page, re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById("planLive").textContent), re.source);
  const closed = (page) => page.waitForFunction(() => !document.getElementById("planDlg").open);
  const settle = (page) => page.waitForFunction(() => !document.getAnimations().length);
  const noNull = async (page, sel) => !/\b(null|undefined|NaN)\b/.test(await page.$eval(sel, (e) => e.innerText));
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const ev = (id) => `.pl-ev[data-id="${id}"]`;

  const { ctx, page, logs } = await newPage();
  const pick = (name, value) => page.click(`label:has(> input[name="${name}"][value="${value}"])`);
  await page.goto(`${srv.url}/pro/`);
  await page.waitForSelector('[data-screen="dash"]:not([hidden])');
  check("slot calculation: Gestion d'atelier is in the menu", await page.isVisible('.dash-link[data-panel="planning"]'));
  await page.click('.dash-link[data-panel="planning"]');
  await page.waitForSelector("#dash-planning:not([hidden]):not([aria-busy]) .pl-grid");
  if (monday(D1) !== monday(today)) {
    await page.click("#planNext");
    await page.waitForFunction((d) => !!document.querySelector(`.pl-col[data-day="${d}"]`), D1);
  }
  // ---- l'écran en affichage simple : pas d'espace, pas de mécanicien ni de poste, des chiffres simples
  check(
    "first visit with the slot calculation: the simple display, the title « Gestion d'atelier », Jour · Semaine · Liste, no space bar",
    (await text(page, "#planTitle")) === "Gestion d'atelier" && (await page.getAttribute('#planMode [data-display="simple"]', "aria-checked")) === "true" && (await page.isHidden("#planSpaces")) && (await page.$$eval("#planViews .pl-view", (b) => b.map((x) => x.textContent).join())) === "Jour,Semaine,Liste",
  );
  const cards = await page.$$eval(".pl-card", (c) => c.map((x) => x.className.match(/is-(\w+)/)[1] + ":" + [...x.querySelectorAll(".pl-card-l, .pl-card-v, .pl-card-s")].map((n) => n.textContent.trim()).join(" ")));
  const ag0 = await agenda();
  const free0 = Object.entries(ag0.free).filter(([d]) => (ag0.days.find((x) => x.day === d) || {}).day).reduce((n, [, v]) => n + v, 0);
  check("the figures: bookings, cars at the workshop, done, and the times still offered online in the week (the API's count)", cards.length === 4 && /^rdv:Rendez-vous 0 aucun à confirmer$/.test(cards[0]) && /^live:À l'atelier 0 /.test(cards[1]) && /^done:Terminés 0 /.test(cards[2]) && cards[3] === `free:Disponibilités ${free0} horaires encore réservables en ligne`, cards.join(" | ") + ` / ${free0}`);
  check("the legend speaks of origins, not of mechanics", /Pixcar · Téléphone · 0 rendez-vous$/.test(await words(page, "#planLegend")) && !/Absence ou maintenance/.test(await words(page, "#planLegend")), await words(page, "#planLegend"));
  await axe(page, "gestion d'atelier simple · semaine vide");

  // ---- « Nouveau rendez-vous » au clavier : ce qu'il faut, rien de plus
  check("before: 9:00 is offered online", (await times()).includes("09:00"));
  await page.click("#planNewRdv");
  await page.waitForSelector('#planDlg[open] input[name="planSvc"]');
  check("the creation panel: services, date and time, estimated duration and return, client and phone, vehicle and plate, origin, comment; no mechanic nor post", (await page.isVisible("#planDay")) && (await page.isVisible("#planMinutes")) && (await page.isVisible("#planBack")) && (await page.isVisible("#planPhone")) && (await page.isVisible("#planPlate")) && (await page.isVisible("#planNote")) && !(await page.$("#planStaff")) && !(await page.$("#planPost")) && (await page.isChecked('input[name="planChannel"][value="phone"]')) && (await noNull(page, "#planForm")));
  await pick("planSvc", "vidange");
  check("a service ticked proposes its duration from Mon garage", /Durée proposée d'après les prestations : 45 min\./.test(await text(page, "#planForm")) && (await page.inputValue("#planMinutes")) === "45");
  const t0 = Date.now();
  await page.fill("#planDay", D1);
  await page.fill("#planTime", "09:00");
  await page.fill("#planLabel", "M. Martin");
  await page.fill("#planPhone", "06 12 34 56 78");
  await page.fill("#planCar", "Renault Clio IV");
  await page.fill("#planPlate", "ab-123-cd");
  await page.fill("#planNote", "Pneus dans le coffre");
  await axe(page, "gestion d'atelier simple · nouveau rendez-vous");
  await shot(page, "1-creation");
  await page.click("#planSave");
  await closed(page);
  await live(page, /Rendez-vous enregistré/);
  check("saved in a few seconds, said in the alert", Date.now() - t0 < 10_000 && /Rendez-vous ajouté : .* à 9:00\./.test(await text(page, "#alert")), await text(page, "#alert"));
  let ag = await agenda();
  const martin = ag.blocks.find((k) => k.client === "M. Martin");
  check("what the garage typed is kept as typed (plate in capitals), counted in « Matin »", martin && martin.phone === "+33612345678" && martin.car === "Renault Clio IV" && martin.plate === "AB-123-CD" && martin.note === "Pneus dans le coffre" && martin.channel === "phone" && martin.minutes === 45 && martin.slot === "Matin", JSON.stringify(martin));
  check("the place is taken online: 9:00 and 8:30 are no longer offered, 10:00 is", !(await times()).includes("09:00") && !(await times()).includes("08:30") && (await times()).includes("10:00"), (await times()).join(" "));
  check("week: the booking shows with its phone icon and in words", /^9:00–9:45 \(45 min\), Vidange.*, Renault Clio IV · AB-123-CD, M\. Martin, Téléphone, Confirmé/.test(await page.getAttribute(ev(martin.id), "aria-label")) && (await page.$eval(`${ev(martin.id)} .pl-ev-h use`, (u) => u.getAttribute("href"))) === "#i-phone", await page.getAttribute(ev(martin.id), "aria-label"));
  check("the figure « Disponibilités » follows", (await words(page, ".pl-card.is-free .pl-card-v")) === String(Object.values(ag.free).reduce((n, v) => n + v, 0)) && Number(await words(page, ".pl-card.is-free .pl-card-v")) < free0);

  // ---- un second dans la place prise : complet, enregistré quand même
  await page.click("#planNewRdv");
  await page.waitForSelector('#planDlg[open] input[name="planSvc"]');
  await pick("planSvc", "vidange");
  await page.fill("#planDay", D1);
  await page.fill("#planTime", "09:15");
  await page.fill("#planCar", "Peugeot 308");
  await page.click("#planSave");
  await page.waitForSelector("#planForm .pl-ask");
  check("the slot is full: the cause, other times of the day, and « Enregistrer quand même »", /^« Matin » est complet à 9:15 : 1 voiture déjà prévue pour 1 place\. Enregistrez quand même, ou choisissez une autre heure\.$/.test(await text(page, "#planForm .pl-ask")) && (await text(page, "#planSave")) === "Enregistrer quand même" && (await page.$$eval("#planForm .pl-alts .btn", (b) => b.length)) >= 1 && (await page.evaluate(() => document.activeElement.id)) === "planSave", await text(page, "#planForm"));
  check("nothing is saved before", (await agenda()).blocks.length === 1);
  await axe(page, "gestion d'atelier simple · créneau complet");
  await page.click("#planSave");
  await closed(page);
  ag = await agenda();
  check("saved anyway, the vehicle alone is enough, counted in « Matin »", ag.blocks.some((k) => k.car === "Peugeot 308" && k.client === "" && k.label === "Peugeot 308" && k.slot === "Matin"), JSON.stringify(ag.blocks.map((k) => [k.label, k.slot])));

  // ---- créneau bloqué de tout l'atelier, puis un qui chevauche un rendez-vous
  await page.click("#planNew");
  await page.click('#planNewMenu [data-new="hold"]');
  await page.waitForSelector("#planDlg[open] #planTo");
  check("a blocked slot in the simple display: the whole workshop, said so; no list of mechanics", /Tout l'atelier est bloqué sur cette plage : aucun horaire n'y est proposé en ligne\./.test(await text(page, "#planForm")) && !(await page.$('input[name="planHoldStaff"]')));
  await page.fill("#planLabel", "Livraison pièces");
  await page.fill("#planDay", D1);
  await page.fill("#planTime", "11:00");
  await page.fill("#planTo", "12:00");
  await page.click("#planSave");
  await closed(page);
  check("blocked: 11:00 and 10:30 no longer offered online", !(await times()).includes("11:00") && !(await times()).includes("10:30") && (await times()).includes("10:00"), (await times()).join(" "));
  await page.click("#planNew");
  await page.click('#planNewMenu [data-new="hold"]');
  await page.waitForSelector("#planDlg[open] #planTo");
  await page.fill("#planLabel", "Réunion");
  await page.fill("#planDay", D1);
  await page.fill("#planTime", "09:00");
  await page.fill("#planTo", "09:30");
  await page.click("#planSave");
  await page.waitForSelector('#planForm .pl-ask[role="alert"]');
  check("over bookings already there: they stay, the garage decides (« Bloquer quand même »)", /^2 rendez-vous sont déjà prévus pendant cette plage \(9:00, 9:15\) : ils restent à leur place\./.test(await text(page, '#planForm .pl-ask[role="alert"]')) && (await text(page, "#planSave")) === "Bloquer quand même", await text(page, '#planForm .pl-ask[role="alert"]'));
  await page.click("#planSave");
  await closed(page);
  ag = await agenda();
  check("both blocked slots saved for the whole workshop", ag.blocks.filter((k) => k.kind === "hold" && k.whole).map((k) => k.label).sort().join() === "Livraison pièces,Réunion");
  await shot(page, "2-semaine");

  // ---- fiche : ce que le garage a saisi ; changer l'horaire garde tout
  await page.click(ev(martin.id));
  await page.waitForSelector("#planDlg[open] #planMove");
  await settle(page);
  const sheet = await text(page, "#planForm");
  check("sheet: phone origin, client and phone, vehicle and plate, estimated time, comment; no assignments; « Changer l'horaire », Appeler", /Téléphone Confirmé/.test(sheet) && /Client M\. Martin · 06 12 34 56 78/.test(sheet) && /Véhicule Renault Clio IV · AB-123-CD/.test(sheet) && /Temps estimé 45 min/.test(sheet) && /Commentaire interne Pneus dans le coffre/.test(sheet) && !/Affectations/.test(sheet) && (await text(page, "#planMove")) === "Changer l'horaire" && (await page.getAttribute('#planForm a.btn[href^="tel:"]', "href")) === "tel:+33612345678", sheet);
  await axe(page, "gestion d'atelier simple · fiche");
  await page.click("#planMove");
  await page.waitForSelector("#planMvDay");
  check("change the time: day and time only (no mechanic in the simple display)", !(await page.$("#planMvStaff")));
  await page.fill("#planMvTime", "14:00");
  await page.click("#planMvSave");
  await closed(page);
  ag = await agenda();
  const moved = ag.blocks.find((k) => k.id === martin.id);
  check("moved to 14:00, counted in « Après-midi », the client's data kept", moved.when.start === "14:00" && moved.slot === "Après-midi" && moved.phone === "+33612345678" && moved.note === "Pneus dans le coffre" && moved.minutes === 45, JSON.stringify(moved));
  check("the morning place is back online at 9:00 for none (the Peugeot is there), 14:00 taken", !(await times()).includes("14:00") && (await times()).includes("15:00"), (await times()).join(" "));

  // ---- client déjà sur place, aujourd'hui : voiture reçue, puis avancement jusqu'à « prête »
  await page.click("#planNew");
  await page.click('#planNewMenu [data-new="arrived"]');
  await page.waitForSelector('#planDlg[open] input[name="planSvc"]');
  check("« Client déjà sur place »: the panel says the car is received on saving; origin « Sur place »", /Client déjà sur place : la voiture est notée « reçue » dès l'enregistrement\./.test(await text(page, "#planForm")) && (await page.isChecked('input[name="planChannel"][value="walkin"]')));
  await pick("planSvc", "plaq_av");
  await page.fill("#planLabel", "Mme Roux");
  await page.click("#planSave");
  await closed(page);
  await page.click('.pl-view:has-text("Liste")');
  await page.click("#planToday");
  await page.waitForSelector(".pl-li-main");
  const roux = (await agenda(today, today)).blocks.find((k) => k.client === "Mme Roux");
  check("received at once, listed today with its next step", roux && roux.work && roux.work.status === "received" && (await page.$eval(`.pl-li:has(.pl-li-main[data-id="${roux.id}"]) .pl-li-act`, (b) => b.textContent)) === "Commencer les travaux", JSON.stringify(roux && roux.work));
  await axe(page, "gestion d'atelier simple · liste");
  await shot(page, "3-liste");
  await page.click(`.pl-li:has(.pl-li-main[data-id="${roux.id}"]) .pl-li-act`);
  // en cours : l'étape suivante du chemin ordinaire est « Voiture prête » (l'attente de pièces est dans la fiche)
  await page.waitForFunction((id) => /Voiture prête/.test(document.querySelector(`.pl-li:has(.pl-li-main[data-id="${id}"]) .pl-li-act`)?.textContent || ""), roux.id);
  await page.click(`.pl-li:has(.pl-li-main[data-id="${roux.id}"]) .pl-li-act`);
  await page.waitForFunction((id) => /Voiture restituée/.test(document.querySelector(`.pl-li:has(.pl-li-main[data-id="${id}"]) .pl-li-act`)?.textContent || ""), roux.id);
  check("in progress, then ready, from the list; the figure « Terminés » counts it", (await agenda(today, today)).blocks.find((k) => k.id === roux.id).work.status === "done" && /^1 /.test(await words(page, ".pl-card.is-done .pl-card-n")), await words(page, ".pl-card.is-done"));

  // ---- affichage avancé : gardé sur le compte (un autre navigateur le retrouve), puis retour au simple
  await page.click('#planMode [data-display="advanced"]');
  await page.waitForSelector("#planSpaces:not([hidden])");
  check("the advanced display: Agenda, Équipe, Équipements, Suivi, Charge", (await page.$$eval("#planSpaces .pl-space", (b) => b.map((x) => x.textContent.trim()).join())) === "Agenda,Équipe,Équipements,Suivi,Charge");
  await page.waitForFunction(async () => true);
  for (let i = 0; i < 20 && (await pro("GET", "")).body.prefs.view !== "advanced"; i++) await page.waitForTimeout(100);
  check("the choice is saved on the account", (await pro("GET", "")).body.prefs.view === "advanced");
  const other = await newPage();
  await other.page.goto(`${srv.url}/pro/`);
  await other.page.waitForSelector('[data-screen="dash"]:not([hidden])');
  await other.page.click('.dash-link[data-panel="planning"]');
  await other.page.waitForSelector("#dash-planning:not([hidden]):not([aria-busy])");
  check("another browser opens it in the advanced display", (await other.page.getAttribute('#planMode [data-display="advanced"]', "aria-checked")) === "true");
  await other.ctx.close();
  await page.click('#planMode [data-display="simple"]');
  await page.waitForSelector("#planSpaces[hidden]", { state: "attached" });
  for (let i = 0; i < 20 && (await pro("GET", "")).body.prefs.view !== "simple"; i++) await page.waitForTimeout(100);
  check("back to simple, saved too", (await pro("GET", "")).body.prefs.view === "simple");

  // ---- un module coupé dans Mon garage › Modules : son espace disparaît de l'affichage avancé
  await page.click('.dash-link[data-panel="garage"]');
  await page.waitForSelector("#dash-garage:not([hidden]):not([aria-busy])");
  await page.click("#mgTab-modules");
  await page.waitForSelector("#mgPanel-modules:not([hidden]) #mgMod-track");
  await page.click("#mgMod-track");
  check("cutting a module asks first, nothing is erased", /Couper « Suivi des interventions » masque son espace dans l'affichage avancé\. Rien n'est effacé/.test(await text(page, ".mg-mod-ask")));
  await page.click('.mg-mod-ask .btn:has-text("Couper le module")');
  await page.waitForFunction(() => document.getElementById("mgMod-track").getAttribute("aria-checked") === "false");
  check("cut: saved for the garage", (await pro("GET", "/rdv/calendar")).body.modules.track === false);
  await page.click('.dash-link[data-panel="planning"]');
  await page.waitForSelector("#dash-planning:not([hidden]):not([aria-busy])");
  await page.click('#planMode [data-display="advanced"]');
  await page.waitForSelector("#planSpaces:not([hidden])");
  check("the advanced display no longer offers « Suivi »", (await page.$$eval("#planSpaces .pl-space", (b) => b.map((x) => x.textContent.trim()).join())) === "Agenda,Équipe,Équipements,Charge");
  await page.click('#planMode [data-display="simple"]');
  check("no console error, no page error", !logs.length, logs.join("\n"));
  await ctx.close();

  // ---- téléphone : la liste d'abord, le panneau de création tient dans l'écran
  {
    const m = await newPage({ width: 390, height: 844, touch: true });
    await m.page.goto(`${srv.url}/pro/`);
    await m.page.waitForSelector('[data-screen="dash"]:not([hidden])');
    await m.page.click('.dash-link[data-panel="planning"]');
    await m.page.waitForSelector("#dash-planning:not([hidden]):not([aria-busy])");
    check("phone, simple display: the list is the default view", (await text(m.page, '.pl-view[aria-pressed="true"]')) === "Liste");
    check("phone: no page-wide horizontal scroll", (await overflow(m.page)) <= 0, await overflow(m.page));
    await axe(m.page, "gestion d'atelier simple · téléphone");
    await shot(m.page, "4-telephone");
    await m.page.click("#planNewRdv");
    await m.page.waitForSelector('#planDlg[open] input[name="planSvc"]');
    await settle(m.page);
    check("phone: the creation panel fits the screen", await m.page.evaluate(() => { const r = document.getElementById("planDlg").getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth + 1; }));
    check("phone: no console error", !m.logs.length, m.logs.join("\n"));
    await m.ctx.close();
  }

  await browser.close();
  await api.close();
  srv.close && srv.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} cas passés`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
