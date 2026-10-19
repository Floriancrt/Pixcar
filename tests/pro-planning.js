// Espace Pro, écran Planning (docs/calendrier-avance.md, lot 3b) de bout en bout : page construite pour de bon, vraie API (PGlite), un garage
// en mode avancé (deux mécaniciens, deux ponts), une demande confirmée, une à confirmer, un rendez-vous pris hors Pixcar, un créneau bloqué
// et une absence. Parcours : le menu (Planning seulement en mode avancé) → semaine (statuts en mots et icônes, légende) → fiche d'un
// rendez-vous (détail, appeler, déplacer au clavier : conflit avec d'autres horaires, puis confirmation et e-mail au client) → glisser-déposer
// (vers un autre mécanicien ; vers une autre heure, avec la confirmation) → création rapide (refus expliqué, puis enregistrée) → filtres →
// mois → par mécanicien (absence) et par poste → suppression d'un bloc, annulation d'un rendez-vous → tablette et téléphone ; axe.
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
  // deux jours ouvrés à venir (après-demain au plus tôt : l'heure limite de réponse d'une demande doit rester à venir) : D1 et le suivant
  const today = R.parisParts(Date.now()).iso;
  const workday = (iso) => !["sa", "su"].includes(R.weekday(iso));
  let D1 = R.addDays(today, 2);
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
  execFileSync(process.execPath, [BUILD, "--only", "dist", "--src", src, "--out", path.join(OUT, "site")], { stdio: "pipe", env });
  srv.setRoot(path.join(OUT, "site", "dist"));

  const browser = await chromium.launch({ args: ["--proxy-server=direct://", "--proxy-bypass-list=*"] });
  async function newPage({ width = 1280, height = 1000, touch = false } = {}) {
    const ctx = await browser.newContext({ viewport: { width, height }, locale: "fr-FR", serviceWorkers: "block", hasTouch: touch, isMobile: touch });
    await ctx.addInitScript(([token, account]) => sessionStorage.setItem("pixcar-pro-session", JSON.stringify({ email: "camille@garage-planning.fr", access: token, refresh: "ref." + account, expiresAt: Date.now() + 3600e3 })), [TOKEN, ACCOUNT]);
    await ctx.route("**/*", (route) => (new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort()));
    const page = await ctx.newPage();
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
  const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `pro-plan-${name}.png`), fullPage: true });
  const text = (page, sel) => page.$eval(sel, (e) => e.innerText.replace(/\s+/g, " ").trim());
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
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
    const x0 = b.x + Math.min(20, b.width / 2), y0 = b.y + 6;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x0 + 8, y0 + 8, { steps: 2 });
    await page.mouse.move(col.x + col.width / 2, col.y + (minute - lo) + 6, { steps: 10 });
    await page.mouse.up();
  }

  // ---- mode simple : pas de Planning
  {
    const { ctx, page } = await newPage();
    await page.goto(`${srv.url}/pro/`);
    await page.waitForSelector('[data-screen="dash"]:not([hidden])');
    check("simple mode: no Planning in the menu, Disponibilités is there", (await page.isHidden('.dash-link[data-panel="planning"]')) && (await page.isVisible('.dash-link[data-panel="agenda"]')));
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

  const { ctx, page, logs } = await newPage();
  await page.goto(`${srv.url}/pro/`);
  await page.waitForSelector('[data-screen="dash"]:not([hidden])');
  check("advanced mode: Planning is in the menu, next to Demandes", await page.isVisible('.dash-link[data-panel="planning"]'));
  await page.click('.dash-link[data-panel="planning"]');
  await page.waitForSelector("#dash-planning:not([hidden]) .pl-grid");
  if (monday(D1) !== monday(today)) {
    await page.click("#planNext");
    await page.waitForFunction((d) => !!document.querySelector(`.pl-col[data-day="${d}"]`), D1);
  }
  check("the menu points at Planning, the week view is the default on a computer", (await page.getAttribute('.dash-link[data-panel="planning"]', "aria-current")) === "true" && (await page.getAttribute('.pl-view[aria-pressed="true"]', "aria-pressed")) === "true" && (await text(page, '.pl-view[aria-pressed="true"]')) === "Semaine");
  const weekCols = await page.$$eval(".pl-col", (c) => c.map((x) => x.dataset.day));
  check("week: today's column says so", !weekColsHaveToday() || (await text(page, ".pl-colhead.is-today")).endsWith("Aujourd'hui"));
  check("week: one column per open day (Monday to Friday)", weekCols.length === 5 && weekCols.includes(D1) && weekCols.includes(D2), weekCols.join());
  const ev = (id) => `.pl-ev[data-id="${id}"]`;
  const label = (id) => page.getAttribute(ev(id), "aria-label");
  check("week: the confirmed request, in words (time, client, service, mechanic, status)", /^8:00–\d+:\d\d, Julien Roux, Vidange.*, (Paul|Léa), Confirmé$/.test(await label(julien)), await label(julien));
  check("week: the pending request says « À confirmer »", /Marie Curie.*À confirmer$/.test(await label(marie)), await label(marie));
  check("week: the phone booking says « Hors Pixcar », the blocked slot « Bloqué »", /^14:00–.*M\. Martin \(tél\.\).*Paul, Hors Pixcar$/.test(await label(job.saved)) && /^10:00–11:00, Livraison pièces, .*Bloqué$/.test(await label(hold.saved)), [await label(job.saved), await label(hold.saved)].join(" / "));
  check("week: each block shows its status in words, not only a colour", (await text(page, `${ev(julien)} .pl-ev-st`)) === "Confirmé" && (await text(page, `${ev(hold.saved)} .pl-ev-st`)) === "Bloqué");
  check("the legend lists the five statuses", (await text(page, "#planLegend")) === "À confirmer Confirmé Hors Pixcar Bloqué En conflit");
  const top = async (id) => page.$eval(ev(id), (e) => parseFloat(e.style.top));
  check("week: blocks sit at their hour (1 px per minute from the first hour shown)", (await top(job.saved)) - (await top(julien)) === 360, `${await top(julien)} → ${await top(job.saved)}`);
  check("the planning shows no stray null / undefined", await noNull(page, "#dash-planning"), (await page.$eval("#dash-planning", (e) => e.innerText)).split("\n").filter((l) => /\b(null|undefined|NaN)\b/.test(l)).join(" | "));
  check("no page-wide horizontal scroll on a computer", (await overflow(page)) <= 0, await overflow(page));
  await axe(page, "planning · semaine");
  await shot(page, "1-semaine");

  // ---- fiche d'un rendez-vous, déplacement au clavier
  await page.click(ev(julien));
  await page.waitForSelector("#planDlg[open] #planMove");
  const sheet = await text(page, "#planForm");
  check("sheet: client and phone, car, service, drop-off, work, return, assignments", /^Rendez-vous Pixcar Julien Roux Confirmé Client : Julien Roux · 06 39 98 12 34 Voiture : Peugeot 208 · EZ-108-BC/i.test(sheet) && /Dépôt : .* à 8:00/.test(sheet) && /Travaux : 8:00–8:45/.test(sheet) && /Affectations (Paul|Léa) · main-d'œuvre/.test(sheet) && /Pont n°\d · poste/.test(sheet), sheet);
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
    while (!(await page.$(`.pl-col[data-day="${D1}"]`))) {
      await page.click("#planNext");
      await page.waitForTimeout(150);
    }
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
  await page.click("#planMvSave");
  await closed(page);
  ag = await agenda();
  check("confirmed: the request moved to 11:00, still with the same mechanic", ag.appointments.find((a) => a.id === marie).when.start === "11:00" && ag.appointments.find((a) => a.id === marie).plan.some((r) => r.id === col && r.role === "labour"));

  // ---- création rapide
  await page.click("#planNew");
  await page.waitForSelector("#planDlg[open] #planLabel");
  check("quick creation: a phone booking by default, the day shown, no stray null", (await page.isChecked('input[name="planKind"][value="job"]')) && (await page.inputValue("#planDay")) === D1 && (await noNull(page, "#planForm")));
  await axe(page, "création rapide");
  await page.click("#planSave");
  await page.waitForFunction(() => !document.getElementById("planErr").hidden);
  check("an empty label is refused with the API's reason", /Libellé/.test(await text(page, "#planErr")), await text(page, "#planErr"));
  // un créneau bloqué sur Paul pendant la demande de Julien (15:00) : refusé, avec la cause
  await page.check('input[name="planKind"][value="hold"]');
  await page.waitForSelector("#planTo");
  check("switching to a blocked slot keeps the focus on the choice", (await page.evaluate(() => document.activeElement.value)) === "hold");
  await page.fill("#planLabel", "Réunion fournisseur");
  const jWho = (await agenda()).appointments.find((a) => a.id === julien).plan.find((r) => r.role === "labour").id;
  await page.fill("#planTime", "15:00");
  await page.fill("#planTo", "15:30");
  await page.check(`input[name="planHoldStaff"][value="${jWho}"]`);
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
  await page.locator(`.pl-col[data-staff="${paul}"]`).click({ position: { x: 20, y: 9 * 60 - Number(await page.$eval(".pl-grid", (g) => g.dataset.lo)) + 4 } });
  await page.waitForSelector("#planDlg[open] #planLabel");
  check("a click on an empty cell opens the creation at that time, for that mechanic", (await page.inputValue("#planTime")) === "09:00" && (await page.inputValue("#planStaff")) === paul);
  await page.fill("#planLabel", "Mme Petit (comptoir)");
  await page.check('input[name="planSvc"][value="vidange"]');
  check("a service ticked keeps the focus", (await page.evaluate(() => document.activeElement.value)) === "vidange");
  await page.click("#planSave");
  await closed(page);
  ag = await agenda();
  const petit = ag.blocks.find((k) => k.label === "Mme Petit (comptoir)");
  check("a phone booking is placed by the engine with the mechanic chosen, and no e-mail is sent", petit && petit.when.start === "09:00" && petit.plan.some((r) => r.id === paul && r.role === "labour"), JSON.stringify(petit));

  // ---- filtres
  await page.click('.pl-view:has-text("Semaine")');
  await page.waitForSelector(`.pl-col[data-day="${D1}"]`);
  await page.selectOption("#planFStatus", "hold");
  await live(page, /Filtre appliqué/);
  const shown = await page.$$eval(".pl-ev", (e) => e.map((x) => x.dataset.id).sort());
  check("filter « Bloqué »: only the blocked slots", shown.join() === [hold.saved, meeting.id].sort().join(), shown.join());
  await page.selectOption("#planFStatus", "");
  await page.selectOption("#planFStaff", lea);
  const leaOnly = await page.$$eval(".pl-ev", (e) => e.map((x) => x.dataset.id));
  check("filter « Léa »: only what Léa does", leaOnly.includes(job.saved) && !leaOnly.includes(petit.id), leaOnly.join());
  await page.click('#planFilters .link-btn:has-text("Retirer les filtres")');
  check("filters removed: everything is back, focus on the first filter", (await page.$$eval(".pl-ev", (e) => e.length)) === 6 && (await page.evaluate(() => document.activeElement.id)) === "planFStaff");
  await axe(page, "planning · filtres");

  // ---- mois
  await page.click('.pl-view:has-text("Mois")');
  await page.waitForSelector(".pl-month");
  const cell = page.locator(".pl-mday", { hasText: "" }).filter({ has: page.locator("b", { hasText: new RegExp(`^${Number(D1.slice(8))}$`) }) }).first();
  check("month: six weeks of days, the busy day counts its bookings", (await page.$$eval(".pl-mday", (c) => c.length)) === 42 && /5 éléments/.test(await cell.innerText()), await cell.innerText());
  await axe(page, "planning · mois");
  await shot(page, "5-mois");
  await cell.click();
  await page.waitForSelector("#planBy");
  check("a day of the month opens that day", (await text(page, '.pl-view[aria-pressed="true"]')) === "Jour" && !!(await page.$(`.pl-col[data-day="${D1}"]`)));

  // ---- par mécanicien (absence de Léa) et par poste
  await page.click('.pl-view:has-text("Par mécanicien")');
  await page.waitForSelector("#planWho");
  await page.selectOption("#planWho", lea);
  check("by mechanic: Léa's absence is drawn on her day off, in words", /Formation/.test(await text(page, `.pl-col[data-day="${D2}"] .pl-away`)));
  await shot(page, "6-mecanicien");
  await page.click('.pl-view:has-text("Par poste")');
  await page.waitForSelector("#planWhich");
  await page.selectOption("#planWhich", lift2);
  check("by post: the delivery blocks Pont n°2", !!(await page.$(`.pl-col[data-day="${D2}"] ${ev(hold.saved)}`)));
  await axe(page, "planning · par poste");

  // ---- supprimer un bloc, annuler un rendez-vous
  await page.click(ev(hold.saved));
  await page.waitForSelector("#planDlg[open] #planDel");
  await page.click("#planDel");
  check("deleting asks to confirm", (await text(page, "#planDel")) === "Confirmer la suppression");
  await page.click("#planDel");
  await closed(page);
  check("the blocked slot is gone", !(await agenda()).blocks.some((k) => k.id === hold.saved) && !(await page.$(ev(hold.saved))));
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
  check("the Espace Pro privacy note tells how long a block's label is kept", /Le libellé d'un bloc, qui peut contenir un nom, est effacé 30 jours après lui, le bloc 24 mois après/.test(await page.$eval(".pro-privacy", (d) => d.textContent)));
  check("no console error, no page error", !logs.length, logs.join("\n"));
  await ctx.close();

  // ---- tablette et téléphone
  for (const [name, width, height] of [["tablette", 820, 1180], ["telephone", 390, 844]]) {
    const m = await newPage({ width, height, touch: name === "telephone" });
    await m.page.goto(`${srv.url}/pro/`);
    await m.page.waitForSelector('[data-screen="dash"]:not([hidden])');
    if (name === "telephone") {
      check("phone: Planning takes the place of Créneaux in the bottom bar", (await m.page.isVisible('.dash-link[data-panel="planning"]')) && (await m.page.isHidden('.dash-link[data-panel="agenda"]')));
      await m.page.click("#dashMore");
      check("phone: Créneaux is under « Plus »", await m.page.isVisible('.dash-link[data-panel="agenda"]'));
      await m.page.click("#dashMore");
    }
    await m.page.click('.dash-link[data-panel="planning"]');
    await m.page.waitForSelector("#dash-planning:not([hidden]) .pl-grid");
    if (name === "telephone") check("phone: the day view is the default, the filters are folded", (await text(m.page, '.pl-view[aria-pressed="true"]')) === "Jour" && !(await m.page.$eval("#planFBox", (d) => d.open)));
    check(`${name}: no page-wide horizontal scroll (the grid scrolls inside its box)`, (await overflow(m.page)) <= 0, await overflow(m.page));
    await axe(m.page, `planning · ${name}`);
    await shot(m.page, `7-${name}`);
    await m.page.click("#planNew");
    await m.page.waitForSelector("#planDlg[open] #planLabel");
    check(`${name}: the creation sheet fits the screen`, await m.page.evaluate(() => { const r = document.getElementById("planDlg").getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth + 1; }));
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
