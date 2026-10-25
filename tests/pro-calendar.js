// Espace Pro, calendrier avancé (docs/calendrier-avance.md, lot 3a) de bout en bout : page construite pour de bon, vraie API (PGlite) avec
// les rendez-vous ouverts en mode simple et une demande déjà prise, un compte connecté et un garage rattaché. Parcours : Mon garage ›
// Modules (mode simple) → « Passer au mode avancé » → les six étapes (réglages, mécanicien avec compétences et absence, compétence ajoutée,
// pont, exigences d'une prestation, confirmation automatique, contrôles et placement de la demande déjà prise) → activation → Mon garage
// en mode avancé (Horaires, Prestations, Ressources, Modules ; demande du 24 octobre 2026), Demandes avec l'affectation, horaires publics
// selon les ressources → retour au mode simple ; tablette et téléphone ; axe.
//   node tests/pro-calendar.js
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
const OUT = path.join(__dirname, ".out", "pro-calendar-site");
const SHOTS = path.join(__dirname, ".out", "shots");
const SRC = process.env.PIXCAR_SRC || path.join(ROOT, "src");
const BUILD = process.env.PIXCAR_BUILD ? path.resolve(ROOT, process.env.PIXCAR_BUILD) : path.join(ROOT, "scripts/build.mjs");
const LEGAL = { editorLine: "Pixcar est édité à titre non professionnel par Jeanne Exemple, responsable du traitement des données décrites ici.", contact: "contact@exemple.test", hostPages: "GitHub, Inc. (GitHub Pages), États-Unis", hostApi: "Amazon Web Services EMEA SARL, Luxembourg (région Europe, Stockholm)", repairRetentionMonths: 24, updated: "3 octobre 2026" };
const HERE = { lat: 43.2174, lon: 1.1014 };
const GARAGE = "aaaaaaaa-0000-4000-8000-000000000001";
const CONTACTS = [{ id: GARAGE, name: "Garage Démo Centre", addr: "12 rue de l'Exemple, 31220 Cazères", pc: "31220", ...HERE, emails: ["contact@garage-demo.fr"], phones: ["+33561000001"] }];
const ACCOUNT = "sub-cal";
const TOKEN = `tok.${ACCOUNT}.1`;
const DAY = [["08:00", "12:00"], ["14:00", "18:00"]];
const WEEK = { mo: DAY, tu: DAY, we: DAY, th: DAY, fr: DAY };
const NOTIFY = "atelier@garage-demo.fr";

(async () => {
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
  await api.app.pro.repo.upsertContacts(parseContactRows(CONTACTS).rows, "test");
  await api.db.query("INSERT INTO pro_claims (id, account_id, garage_id, siret, status, channel, holder_name, holder_role, target_hash, target_hint, verified_at) VALUES (gen_random_uuid(), $1, $2, '73282932000074', 'verified', 'email', 'Camille Durand', 'manager', $3, 'c•••••@garage-demo.fr', now())", [ACCOUNT, GARAGE, "a".repeat(64)]);
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
  // garage ouvert en mode simple (lot 2), et une demande déjà prise sur son créneau
  const ok =
    (await pro("PUT", "/profile", { hours: WEEK })).status === 200 &&
    (await Promise.all([["vidange", 45], ["plaq_av", 60], ["distribution", 270]].map(([s, m]) => pro("PUT", `/services/${s}`, { offered: true, minutes: m })))).every((r) => r.status === 200) &&
    (await pro("POST", "/rdv/notify", { email: NOTIFY })).status === 200 &&
    (await pro("POST", "/rdv/notify/code", { code: lastCode(NOTIFY) })).status === 200 &&
    (await pro("POST", "/rdv/slots", { name: "Matin", days: ["mo", "tu", "we", "th", "fr"], start: "08:00", end: "12:00", mode: "hour", capacity: 1, services: ["vidange", "plaq_av"] })).status === 200 &&
    (await pro("PUT", "/rdv/settings", { enabled: true, minDelayH: 0 })).status === 200;
  const times = (await call("GET", `/v1/rdv/garages/${GARAGE}/times?services=vidange`)).body;
  const pick = { day: times.days[0].day, time: times.days[0].times[0].t };
  const draft = await call("POST", "/v1/rdv/requests", { garageId: GARAGE, services: [{ id: "vidange", qty: 1 }], ...pick, name: "Julien Roux", email: "julien.roux@example.com", phone: "06 39 98 12 34", car: "Peugeot 208", year: 2019, plate: "EZ-108-BC", message: "", remindPrice: false });
  const sent = await call("POST", `/v1/rdv/requests/${draft.body && draft.body.id}/code`, { code: lastCode("julien.roux@example.com") });
  check("setup: the garage takes requests in simple mode, and a request is already taken", ok && sent.status === 200, JSON.stringify(sent.body));

  // ---- construction
  const src = path.join(OUT, "src");
  fs.cpSync(SRC, src, { recursive: true });
  fs.writeFileSync(path.join(src, "legal.json"), JSON.stringify(LEGAL));
  const env = { ...process.env, PIXCAR_API_BASE: api.url, PIXCAR_PRO_POOL: "eu-north-1_PixcarTest1", PIXCAR_PRO_CLIENT: "4pro0test1client2id3", PIXCAR_GA_ID: "", PIXCAR_CS_ID: "", PIXCAR_MAPBOX_TOKEN: "" };
  execFileSync(process.execPath, [BUILD, "--only", "dist", "--src", src, "--out", path.join(OUT, "site")], { stdio: "pipe", env });
  srv.setRoot(path.join(OUT, "site", "dist"));

  const browser = await chromium.launch({ args: ["--proxy-server=direct://", "--proxy-bypass-list=*"] });
  async function newPage({ width = 1280, height = 900 } = {}) {
    const ctx = await browser.newContext({ viewport: { width, height }, locale: "fr-FR", serviceWorkers: "block" });
    await ctx.addInitScript(([token, account]) => sessionStorage.setItem("pixcar-pro-session", JSON.stringify({ email: "camille@garage-demo.fr", access: token, refresh: "ref." + account, expiresAt: Date.now() + 3600e3 })), [TOKEN, ACCOUNT]);
    await ctx.route("**/*", (route) => (new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort()));
    const page = await ctx.newPage();
    const logs = [];
    // le registre SIRENE n'a pas ce garage d'essai (sirene: null) : sa route répond 404, la page le dit (Mon garage › Fiche Pixcar)
    const expected = (m) => /status of (400|401|409|422)\b/.test(m.text()) || (/status of 404\b/.test(m.text()) && /\/registry$/.test(m.location().url));
    page.on("console", (m) => ["error", "warning"].includes(m.type()) && !expected(m) && logs.push(`[${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => logs.push("[pageerror] " + e.message));
    return { ctx, page, logs };
  }
  const axe = async (page, label) => {
    await page.evaluate(AXE);
    const r = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } })).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`));
    check(`axe: no violation on « ${label} »`, r.length === 0, r.join("\n"));
  };
  const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `pro-cal-${name}.png`), fullPage: true });
  const text = (page, sel) => page.$eval(sel, (e) => e.innerText.replace(/\s+/g, " ").trim());
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const state = async () => (await pro("GET", "/rdv/calendar")).body;
  const live = (page, re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById("calLive").textContent), re.source);
  const closed = (page) => page.waitForFunction(() => !document.getElementById("calDlg").open);

  const { ctx, page, logs } = await newPage();
  await page.goto(`${srv.url}/pro/`);
  await page.waitForSelector('[data-screen="dash"]:not([hidden])');
  const tab = async (pg, name) => {
    if (await pg.isHidden("#dash-garage")) {
      await pg.click('.dash-link[data-panel="garage"]');
      await pg.waitForSelector("#dash-garage:not([hidden]):not([aria-busy])");
    }
    await pg.click(`#mgTab-${name}`);
    await pg.waitForSelector(`#mgPanel-${name}:not([hidden])`);
  };
  await tab(page, "modules");
  const mods0 = await page.$$eval("#mgModules li", (ls) => ls.map((l) => l.innerText.replace(/\s+/g, " ").trim()));
  check("Mon garage › Modules, simple mode: the mode box explains both modes and offers the switch; the four tools of the advanced mode, inactive", /^Simple : votre semaine type en créneaux/.test(await text(page, "#agModeText")) && (await text(page, "#agModeGo")) === "Passer au mode avancé" && mods0.length === 4 && mods0.every((m) => / Inactif$/.test(m)) && /^Mécaniciens Affectations/.test(mods0[0]), mods0.join(" | "));
  check("simple mode: Ressources says they belong to the advanced mode; Horaires has the week and the rules", (await page.$eval("#mgResSimple", (e) => !e.hidden)) && (await page.$eval("#agWeekBox", (e) => !e.hidden)) && (await page.$eval("#agRulesBox", (e) => !e.hidden)) && (await page.$eval("#mgCalResources", (e) => !e.children.length)));
  await axe(page, "Mon garage · Modules (simple)");
  await shot(page, "0-modules-simple");

  // ---- 1. garage
  await page.click("#agModeGo");
  await page.waitForSelector("#dash-calendar:not([hidden]):not([aria-busy]) #calStepTitle");
  const steps = await page.$$eval("#calSteps button", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()));
  check("the wizard opens on step 1 of 6, the menu still points at Mon garage", steps.join("|") === "1 Garage|2 Personnel|3 Équipements|4 Prestations|5 Réservation|6 Vérification" && (await text(page, "#calStepTitle")) === "1. Garage" && (await page.getAttribute("#calSteps [data-step='1']", "aria-current")) === "step" && (await page.getAttribute('.dash-link[data-panel="garage"]', "aria-current")) === "true" && (await text(page, "#crumb")) === "Mon atelier / Mon garage / Mode avancé", steps.join("|"));
  check("step 1: the opening hours, the pauses explained, closures, delays and margins", /lun\.–ven\. 8:00–12:00, 14:00–18:00/.test(await text(page, "#calBody")) && /le travail s'y interrompt et reprend après/.test(await text(page, "#calBody")) && (await page.inputValue("#calReception")) === "10" && (await page.inputValue("#calReturn")) === "15");
  await axe(page, "assistant · 1. Garage");
  await shot(page, "1-garage");
  await page.selectOption("#calReception", "0");
  await live(page, /Enregistré/);
  check("a setting is saved at once", (await state()).settings.receptionMin === 0);
  await page.click("#calNext");
  await page.waitForFunction(() => document.getElementById("calStepTitle").textContent === "2. Personnel");
  check("« Continuer » saves the progress and moves to step 2", (await state()).step === 1 && (await page.evaluate(() => document.activeElement.id)) === "calStepTitle");

  // ---- 2. personnel
  check("step 2: no mechanic yet, eight proposed skills (two qualifications)", /Aucun mécanicien pour l'instant/.test(await text(page, "#calBody")) && (await page.$$eval(".cal-skills li", (l) => l.length)) === 8 && (await page.$$eval(".cal-skills li small", (l) => l.length)) === 2);
  await page.click("#calAddStaff");
  await page.waitForSelector("#calDlg[open] #calStaffName");
  check("the new mechanic sheet shows no stray « null »", !/\bnull\b/.test(await page.$eval("#calForm", (f) => f.innerText)));
  await axe(page, "fiche d'un mécanicien");
  await page.click("#calSave");
  await page.waitForFunction(() => !document.getElementById("calErr").hidden);
  check("an empty name is refused with the API's reason, the sheet stays open", /Nom : de 2 à 60 caractères/.test(await text(page, "#calErr")));
  await page.fill("#calStaffName", "Paul");
  for (const l of ["Entretien courant", "Freinage"]) await page.locator("#calForm .cal-skill").filter({ hasText: l }).locator("input[type=checkbox]").check();
  await page.check('input[name="calStaffHMode"][value="own"]');
  check("own hours: the week grid appears", await page.isVisible("#calStaffHDays"));
  await page.check('input[name="calStaffHMode"][value="garage"]');
  await shot(page, "2-fiche-mecanicien");
  await page.click("#calSave");
  await closed(page);
  await live(page, /Mécanicien ajouté/);
  const paul = (await state()).staff[0];
  check("the mechanic is saved with his two skills and the garage's hours, and listed", paul && paul.name === "Paul" && paul.skills.length === 2 && paul.hours === null && /Paul Actif Horaires du garage · Toutes les prestations Entretien courant Freinage/.test(await text(page, ".cal-list")), await text(page, ".cal-list"));
  // une absence, puis retirée
  await page.click('.cal-item[data-id] button:has-text("Absence")');
  await page.waitForSelector("#calDlg[open] #calUnKind");
  check("the absence sheet shows no stray « null »", !/\bnull\b/.test(await page.$eval("#calForm", (f) => f.innerText)));
  await axe(page, "absence d'un mécanicien");
  const kinds = await page.$$eval("#calUnKind option", (o) => o.map((x) => x.textContent));
  check("absence: the reasons fit a person (no maintenance), dates from today", kinds.join() === "Absence,Congés,Formation,Autre", kinds.join());
  await page.selectOption("#calUnKind", "training");
  await page.fill("#calUnFirst", "2026-10-07");
  await page.fill("#calUnLast", "2026-10-07");
  await page.selectOption("#calUnFrom", "14:00");
  await page.click("#calSave");
  await closed(page);
  check("the absence is listed under the mechanic, in words", /Formation : mer\. 7 oct\. \(14:00–24:00\)/.test(await text(page, ".cal-unav")), await text(page, ".cal-list"));
  await page.click('.cal-unav button:has-text("Retirer")');
  await live(page, /Retiré/);
  check("and removed", !(await page.$(".cal-unav")) && (await state()).staff[0].unavail.length === 0);
  // une compétence en plus
  await page.fill("#calSkillName", "Géométrie");
  await page.click("#calSkillAdd");
  await live(page, /Géométrie/);
  check("a skill of the garage's own is added", (await state()).skills.some((k) => k.label === "Géométrie"));
  await axe(page, "assistant · 2. Personnel");
  await shot(page, "2-personnel");
  await page.click("#calNext");
  await page.waitForFunction(() => document.getElementById("calStepTitle").textContent === "3. Équipements");

  // ---- 3. équipements
  await page.click("#calAddRes");
  await page.waitForSelector("#calDlg[open] #calResName");
  check("the resource sheet shows no stray « null »", !/\bnull\b/.test(await page.$eval("#calForm", (f) => f.innerText)));
  await page.fill("#calResName", "Pont n°1");
  await axe(page, "fiche d'un poste");
  await page.click("#calSave");
  await closed(page);
  check("a lift is added and listed", (await state()).resources.map((r) => [r.name, r.type]).join() === "Pont n°1,lift" && /Pont n°1 Disponible Pont élévateur · Heures du garage/.test(await text(page, ".cal-list")));
  await page.click("#calNext");
  await page.waitForFunction(() => document.getElementById("calStepTitle").textContent === "4. Prestations");

  // ---- 4. prestations
  const rows = await page.$$eval(".cal-list .cal-item", (l) => l.map((x) => x.innerText.replace(/\s+/g, " ").trim()));
  check("step 4: each service the garage does, with what it asks (from the average times of Mon garage)", rows.length === 3 && /^Vidange \(huile \+ filtre\) 45 min · Pont élévateur ou Poste de mécanique rapide · Entretien courant/.test(rows[0]) && /Plaquettes.* 1 h · Pont élévateur · Freinage/.test(rows[1]), rows.join(" / "));
  await page.click('.cal-item[data-id="plaq_av"] button');
  await page.waitForSelector("#calDlg[open] #calReqLabour");
  await axe(page, "exigences d'une prestation");
  await shot(page, "4-prestation");
  await page.fill("#calReqLabour", "90");
  await page.fill("#calReqImmob", "60");
  await page.click("#calSave");
  await page.waitForFunction(() => !document.getElementById("calErr").hidden);
  check("an immobilisation shorter than the labour is refused, with the reason", /Immobilisation : au moins la main-d'œuvre/.test(await text(page, "#calErr")));
  await page.fill("#calReqImmob", "90");
  await page.click("#calSave");
  await closed(page);
  check("saved: 1 h 30 for brake pads", (await state()).services.find((s) => s.id === "plaq_av").req.labour === 90 && /1 h 30/.test(await text(page, '.cal-item[data-id="plaq_av"]')));
  await page.click("#calNext");
  await page.waitForFunction(() => document.getElementById("calStepTitle").textContent === "5. Réservation");

  // ---- 5. réservation
  check("step 5: confirmation per service (the timing belt needs parts: locked), capacity, assignment, the address of the requests", (await page.isDisabled("#calAuto-distribution")) && !(await page.isDisabled("#calAuto-vidange")) && (await page.inputValue("#calLoad")) === "100" && new RegExp(`arrivent à ${NOTIFY.replace(".", "\\.")}`).test(await text(page, "#calBody")));
  await page.click("#calAuto-vidange");
  await live(page, /Confirmation automatique/);
  check("oil changes confirmed at once", (await state()).services.find((s) => s.id === "vidange").req.auto === true && (await page.getAttribute("#calAuto-vidange", "aria-checked")) === "true");
  await axe(page, "assistant · 5. Réservation");
  await page.click("#calNext");
  await page.waitForFunction(() => document.getElementById("calStepTitle").textContent === "6. Vérification");

  // ---- 6. vérification et activation
  const body6 = await text(page, "#calBody");
  check("step 6: what is offered online, what is not (no one does timing belts), the request already taken finds its place", /Proposées en ligne : Vidange \(huile \+ filtre\), Plaquettes de frein avant\./.test(body6) && /Courroie de distribution : aucun mécanicien actif/.test(body6) && /1 rendez-vous trouve sa place\. Aucun horaire ne change\./.test(body6) && /Julien Roux → Paul, Pont n°1/.test(body6), body6);
  await axe(page, "assistant · 6. Vérification");
  await shot(page, "6-verification");
  await page.click("#calActivate");
  await page.waitForSelector("#dash-garage:not([hidden]):not([aria-busy]) #mgPanel-modules:not([hidden]) #calChkTitle");
  check("activated: back in Mon garage › Modules, the alert says how many appointments were affected; the wizard is put away", /Mode avancé actif\. 1 rendez-vous à venir affecté\./.test(await text(page, "#alert")) && (await state()).mode === "advanced" && (await page.evaluate(() => document.activeElement.id)) === "mgTitle" && !(await page.$("#calBody > *")), await text(page, "#alert"));
  const mods1 = await page.$$eval("#mgModules li", (ls) => ls.map((l) => l.innerText.replace(/\s+/g, " ").trim()));
  check("Modules in advanced mode: the four tools active, each with « Ouvrir »; controls, no conflict, recompute and back to simple", mods1.every((m) => /Actif Ouvrir$/.test(m)) && /^Avancé :/.test(await text(page, "#agModeText")) && (await text(page, "#agModeGo")) === "Mécaniciens et postes" && /Conflits · 0/.test(await text(page, "#mgCalModules")) && (await page.isVisible("#calToSimple")) && (await page.isVisible("#calRecompute")), mods1.join(" | "));
  check("the Planning is in the menu", await page.isVisible('.dash-link[data-panel="planning"]'));
  await axe(page, "Mon garage · Modules (avancé)");
  await shot(page, "7-modules-avance");
  // les réglages du mode avancé, rangés dans les rubriques ; titres au niveau h2, sans doublon d'identifiant
  const h2 = (sel) => page.$$eval(`${sel} h2`, (hs) => hs.filter((h) => h.offsetParent).map((h) => h.textContent));
  await tab(page, "hours");
  check("Horaires (advanced): opening hours, online appointments, closures, then delays and margins, online capacity, the address; no typical week nor rules", (await h2("#mgPanel-hours")).join("|") === "Horaires d'ouverture|Rendez-vous en ligne|Fermetures et congés|Délais et marges|Capacité en ligne|Où recevoir les demandes" && (await page.inputValue("#calReception")) === "0", (await h2("#mgPanel-hours")).join("|"));
  await axe(page, "Mon garage · Horaires (avancé)");
  await shot(page, "8-horaires-avance");
  await tab(page, "services");
  check("Prestations (advanced): announced prices, services done, what each service needs, confirmation", (await h2("#mgPanel-services")).join("|") === "Prix annoncés sur Pixcar|Prestations effectuées|Ce que demande chaque prestation|Confirmation" && (await page.getAttribute("#calAuto-vidange", "aria-checked")) === "true", (await h2("#mgPanel-services")).join("|"));
  await axe(page, "Mon garage · Prestations (avancé)");
  await tab(page, "resources");
  check("Ressources (advanced): mechanics, skills, posts; Paul and the lift are there", (await h2("#mgPanel-resources")).join("|") === "Mécaniciens · 1|Compétences et habilitations|Postes et équipements · 1" && /Paul/.test(await text(page, "#mgCalResources")) && /Pont n°1/.test(await text(page, "#mgCalResources")), (await h2("#mgPanel-resources")).join("|"));
  check("no id twice in the page", await page.evaluate(() => { const ids = [...document.querySelectorAll("[id]")].map((e) => e.id); return ids.length === new Set(ids).size; }));
  await axe(page, "Mon garage · Ressources (avancé)");
  await shot(page, "9-ressources-avance");
  // une fiche ouverte d'ici s'enregistre et la liste suit (même volet que l'assistant)
  await page.click('#mgCalResources .cal-item[data-id] button:has-text("Modifier")');
  await page.waitForSelector("#calDlg[open] #calStaffName");
  await page.fill("#calStaffName", "Paul R.");
  await page.click("#calSave");
  await closed(page);
  check("a mechanic edited from Mon garage: saved, the list follows", /Paul R\./.test(await text(page, "#mgCalResources")) && (await state()).staff.some((m) => m.name === "Paul R."), await text(page, "#mgCalResources"));
  await page.click('.dash-link[data-panel="requests"]');
  await page.waitForSelector("#dash-requests:not([hidden]):not([aria-busy]) .rq-card");
  check("Demandes: the request shows who does it and where", /Affecté : Paul R\. · Pont n°1/.test(await text(page, ".rq-card")), await text(page, ".rq-card"));
  const pub = (await call("GET", `/v1/rdv/garages/${GARAGE}/times?services=vidange`)).body;
  check("public times now come from Paul and the lift (afternoons too), with a return time and immediate confirmation", pub.auto === true && pub.days[0].times.some((t) => t.t >= "14:00") && pub.days[0].times.every((t) => /^\d\d:\d\d$/.test(t.end)), JSON.stringify(pub.days[0]).slice(0, 300));

  // ---- tablette et téléphone
  for (const [w, h, name] of [[820, 1180, "tablette"], [390, 844, "telephone"]]) {
    const m = await newPage({ width: w, height: h });
    await m.page.goto(`${srv.url}/pro/`);
    await m.page.waitForSelector('[data-screen="dash"]:not([hidden])');
    await m.page.evaluate(() => document.querySelector('.dash-link[data-panel="garage"]').click());
    await m.page.waitForSelector("#dash-garage:not([hidden]):not([aria-busy])");
    await m.page.click("#mgTab-resources");
    await m.page.waitForSelector("#mgPanel-resources:not([hidden]) .cal-item");
    check(`${name}: Mon garage › Ressources, the tabs in a row, no horizontal scroll`, (await overflow(m.page)) <= 0 && (await m.page.$eval("#mgTabs", (t) => getComputedStyle(t).display)) === "flex", await overflow(m.page));
    await axe(m.page, `Mon garage · Ressources (${name})`);
    await shot(m.page, `${name}-ressources`);
    await m.page.click('#mgCalResources .cal-item[data-id] button:has-text("Modifier")');
    await m.page.waitForSelector("#calDlg[open] #calStaffName");
    check(`${name}: the sheet fits the screen`, await m.page.evaluate(() => { const r = document.getElementById("calDlg").getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth + 1; }));
    await shot(m.page, `${name}-fiche`);
    check(`${name}: no console error`, !m.logs.length, m.logs.join("\n"));
    await m.ctx.close();
  }

  // ---- retour au mode simple (Mon garage › Modules)
  await tab(page, "modules");
  await page.click("#calToSimple");
  check("going back to simple asks to confirm", (await text(page, "#calToSimple")) === "Confirmer le retour au mode simple");
  await page.click("#calToSimple");
  await page.waitForFunction(() => /^Simple/.test(document.getElementById("agModeText").textContent));
  check("back in simple mode: still on Modules, the tools inactive, the week and the rules back, the advanced settings put away, the request kept its slot", (await page.isVisible("#mgPanel-modules")) && (await page.$eval("#agWeekBox", (e) => !e.hidden)) && (await page.$eval("#agRulesBox", (e) => !e.hidden)) && !(await page.$("#mgCalResources > *")) && (await page.isHidden('.dash-link[data-panel="planning"]')) && (await state()).mode === "simple" && (await text(page, "#alert")).startsWith("Mode simple"));
  check("no console error, no page error", !logs.length, logs.join("\n"));

  await ctx.close();
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
