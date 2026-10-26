// Espace Pro, rendez-vous en ligne (docs/rendez-vous.md, lot 2) de bout en bout : page construite pour de bon, vraie API (PGlite) avec
// l'Espace Pro et les rendez-vous ouverts, un compte déjà connecté (jeton accepté par un vérificateur simulé) et un garage déjà rattaché.
// Parcours : Disponibilités (ce qui manque, adresse qui reçoit les demandes vérifiée par code, créneau et son aperçu, ouverture, règles,
// fermeture, jours fériés) → demandes envoyées par l'API publique → Demandes (accepter, refuser avec un motif, détails, export, annuler) ;
// téléphone (rail d'icônes, liste par jour, volet du créneau) ; accessibilité (axe) de chaque écran.
//   node tests/pro-rdv.js
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
const OUT = path.join(__dirname, ".out", "pro-rdv-site");
const SHOTS = path.join(__dirname, ".out", "shots");
const SRC = process.env.PIXCAR_SRC || path.join(ROOT, "src");
const BUILD = process.env.PIXCAR_BUILD ? path.resolve(ROOT, process.env.PIXCAR_BUILD) : path.join(ROOT, "scripts/build.mjs");
const POOL = "eu-north-1_PixcarTest1";
const CLIENT = "4pro0test1client2id3";
const LEGAL = { editorName: "Jeanne Exemple", editorLine: "Pixcar est édité à titre non professionnel par Jeanne Exemple, responsable du traitement des données décrites ici.", contact: "contact@exemple.test", hostPages: "GitHub, Inc. (GitHub Pages), États-Unis", hostApi: "Amazon Web Services EMEA SARL, Luxembourg (région Europe, Stockholm)", repairRetentionMonths: 24, updated: "3 octobre 2026" };

const HERE = { lat: 43.2174, lon: 1.1014 };
const GARAGE = "aaaaaaaa-0000-4000-8000-000000000001";
const CONTACTS = [{ id: GARAGE, name: "Garage Démo Centre", addr: "12 rue de l'Exemple, 31220 Cazères", pc: "31220", ...HERE, emails: ["contact@garage-demo.fr"], phones: ["+33561000001"] }];
const ACCOUNT = "sub-rdv";
const TOKEN = `tok.${ACCOUNT}.1`;
const AM = [["08:00", "12:00"]], DAY = [["08:00", "12:00"], ["14:00", "18:00"]];
const WEEK = { mo: DAY, tu: DAY, we: DAY, th: DAY, fr: DAY, sa: AM };
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
      sirene: async (siret) => ({ siret, name: "GARAGE DEMO CENTRE", company: "DEMO SARL", addr: "12 RUE DE L'EXEMPLE 31220 CAZERES", naf: "45.20A", active: true, pc: "31220", ...HERE }),
    },
  });
  await api.app.pro.repo.upsertContacts(parseContactRows(CONTACTS).rows, "test");
  await api.db.query("INSERT INTO pro_claims (id, account_id, garage_id, siret, status, channel, holder_name, holder_role, target_hash, target_hint, verified_at) VALUES (gen_random_uuid(), $1, $2, '73282932000074', 'verified', 'email', 'Camille Durand', 'manager', $3, 'c•••••@garage-demo.fr', now())", [ACCOUNT, GARAGE, "a".repeat(64)]);
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(api.url + p, { method, headers: { origin: srv.url, ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const pro = (method, p, body) => call(method, `/v1/pro/garages/${GARAGE}${p}`, body, { authorization: `Bearer ${TOKEN}` });
  // horaires (samedi matin compris) et temps moyens, comme dans « Mon garage » (lot 1)
  check("setup: hours and average times saved through the API", (await pro("PUT", "/profile", { hours: WEEK })).status === 200 && (await Promise.all([["vidange", 45], ["plaq_av", 60], ["distribution", 270]].map(([s, m]) => pro("PUT", `/services/${s}`, { offered: true, minutes: m })))).every((r) => r.status === 200));
  const outbox = api.app.pro.senders.outbox;
  const rdvMails = (to) => outbox.filter((m) => m.channel === "rdv" && (!to || m.target === to));
  const lastCode = (to) => {
    const m = rdvMails(to).filter((x) => /code (\d{6})/.test(x.subject)).at(-1);
    return m && /code (\d{6})/.exec(m.subject)[1];
  };

  // ---- construction
  const src = path.join(OUT, "src");
  fs.cpSync(SRC, src, { recursive: true });
  fs.writeFileSync(path.join(src, "legal.json"), JSON.stringify(LEGAL));
  const env = { ...process.env, PIXCAR_ALLOW_DRAFT_AGREEMENT: "1", PIXCAR_API_BASE: api.url, PIXCAR_PRO_POOL: POOL, PIXCAR_PRO_CLIENT: CLIENT, PIXCAR_GA_ID: "", PIXCAR_CS_ID: "", PIXCAR_MAPBOX_TOKEN: "" };
  execFileSync(process.execPath, [BUILD, "--only", "dist", "--src", src, "--out", path.join(OUT, "site")], { stdio: "pipe", env });
  srv.setRoot(path.join(OUT, "site", "dist"));

  // ---- navigateur : session déjà ouverte (sessionStorage), rien ne sort de la machine
  const browser = await chromium.launch({ args: ["--proxy-server=direct://", "--proxy-bypass-list=*"] });
  async function newPage({ width = 1280, height = 900 } = {}) {
    const ctx = await browser.newContext({ viewport: { width, height }, locale: "fr-FR", serviceWorkers: "block", acceptDownloads: true });
    await ctx.addInitScript(([token, account]) => sessionStorage.setItem("pixcar-pro-session", JSON.stringify({ email: "camille@garage-demo.fr", access: token, refresh: "ref." + account, expiresAt: Date.now() + 3600e3 })), [TOKEN, ACCOUNT]);
    await ctx.route("**/*", (route) => (new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort()));
    const page = await ctx.newPage();
    const logs = [];
    page.on("console", (m) => ["error", "warning"].includes(m.type()) && !/^Failed to load resource: the server responded with a status of (400|401|409|422)\b/.test(m.text()) && logs.push(`[${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => logs.push("[pageerror] " + e.message));
    page.on("response", (r) => r.status() === 404 && logs.push("[404] " + r.url()));
    return { ctx, page, logs };
  }
  const axe = async (page, label) => {
    await page.evaluate(AXE);
    const r = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } })).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`));
    check(`axe: no violation on « ${label} »`, r.length === 0, r.join("\n"));
    if (r.length) console.log(JSON.stringify(await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: "rule", values: ["color-contrast"] } })).violations.map((v) => v.nodes.map((n) => n.any.map((a) => a.message))))));
  };
  const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `pro-rdv-${name}.png`), fullPage: true });
  const text = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, " ").trim());
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  const { ctx, page, logs } = await newPage();
  await page.goto(`${srv.url}/pro/`);
  await page.waitForSelector('[data-screen="dash"]:not([hidden])');
  const nav = await page.$$eval("#dashNav .dash-link:not(.rail-toggle)", (els) => els.filter((e) => e.offsetParent).map((e) => e.innerText.trim()));
  // Gestion d'atelier (docs/gestion-atelier.md) : l'agenda existe aussi en calcul par créneaux
  check("with appointments open in the API, the menu offers « Gestion d'atelier » and « Demandes » (nothing to answer yet); Disponibilités and the prices are in Mon garage", nav.join("|") === "Tableau de bord|Gestion d'atelier|Demandes|Mon garage|Mes garages" && (await page.locator("#rqCount").isHidden()) && (await page.locator("#dbRqCount").isHidden()) && (await text(page, "#dbRqEmpty h3")) === "Aucune demande en attente.", nav.join("|"));

  // ---- Disponibilités, dans Mon garage › Horaires (demande du 24 octobre 2026) : fermés, et ce qui manque
  await page.click('.dash-link[data-panel="garage"]');
  await page.waitForSelector("#dash-garage:not([hidden]):not([aria-busy])");
  const tabs = await page.$$eval("#mgTabs [role=tab]", (ts) => ts.filter((t) => !t.hidden).map((t) => t.querySelector("b").textContent + (t.getAttribute("aria-selected") === "true" ? "*" : "")));
  check("Mon garage with appointments: Horaires (selected), Prestations, Ressources, Modules, Fiche Pixcar; the title has the focus, the menu says where we are", tabs.join("|") === "Horaires*|Prestations|Ressources|Modules|Fiche Pixcar" && (await page.evaluate(() => document.activeElement.id)) === "mgTitle" && (await page.getAttribute('.dash-link[data-panel="garage"]', "aria-current")) === "true", tabs.join("|"));
  check("Horaires: opening hours, then online appointments, the typical week, closures, rules and the address, in that order", (await page.$$eval("#mgPanel-hours > section:not([hidden]) h2", (hs) => hs.map((h) => h.textContent))).join("|") === "Horaires d'ouverture|Rendez-vous en ligne|Ma semaine type|Fermetures et congés|Règles de réservation|Où recevoir les demandes");
  let missing = await text(page, "#agMissing");
  check("closed at first; what is missing is listed (address for the requests, a slot), hours are already there", (await text(page, "#agStateText")) === "Fermés" && (await page.getAttribute("#agEnabled", "aria-checked")) === "false" && /l'adresse qui recevra les demandes/.test(missing) && /Ajoutez un créneau/.test(missing) && !/horaires d'ouverture/.test(missing), missing);
  const week = await page.$$eval("#agWeek .ag-col", (cols) => cols.map((c) => [c.querySelector(".ag-col-head b").textContent, c.querySelector(".ag-col-head small").textContent, c.classList.contains("closed")]));
  check("the week: seven columns, Sunday closed, no slot yet", week.length === 7 && week[6][1] === "Fermé" && week[6][2] && week.slice(0, 6).every((c) => c[1] === "0 créneau" && !c[2]), JSON.stringify(week));
  check("the opening rules show the defaults (24 h, 4 weeks, every 30 min) and the next public holiday", (await page.inputValue("#agDelay")) === "24" && (await page.inputValue("#agHorizon")) === "28" && (await page.inputValue("#agStep")) === "30" && /Fermé automatiquement \(prochain : .*1 novembre.*toussaint\)/i.test(await text(page, "#agHolText")), await text(page, "#agHolText"));
  const link = `${srv.url}/reserver/?garage=${GARAGE}`;
  check(
    "the mini-site link (to put on the garage's website or networks): reserver/?garage=<id>, « Copier le lien », « Ouvrir » in a new tab; closed, it says what the client will see",
    (await page.inputValue("#agLink")) === link && (await page.getAttribute("#agLinkTry", "href")) === link && (await page.getAttribute("#agLinkTry", "target")) === "_blank" && (await text(page, "#agLinkCopy")) === "Copier le lien" && /^Ouvrir/.test(await text(page, "#agLinkTry")) && /aucun rendez-vous n'est proposé/.test(await text(page, "#agLinkState")),
    `${await page.inputValue("#agLink")} | ${await text(page, "#agLinkState")}`,
  );
  await axe(page, "Disponibilités (fermés)");

  // opening before anything is ready is refused, with the reason
  await page.click("#agEnabled");
  await page.waitForFunction(() => !document.getElementById("alert").hidden);
  check("switching on while something is missing: the API's reason is shown, the switch stays off", (await page.getAttribute("#agEnabled", "aria-checked")) === "false" && /adresse|créneau/i.test(await text(page, "#alert")), await text(page, "#alert"));

  // l'adresse qui reçoit les demandes : code à 6 chiffres
  await page.fill("#agNotifyEmail", "pas-une-adresse");
  await page.click("#agNotifySend");
  check("an invalid address is caught on the page", /invalide/.test(await text(page, "#agNotifyErr")) && !rdvMails().length);
  await page.fill("#agNotifyEmail", NOTIFY);
  await page.click("#agNotifySend");
  await page.waitForSelector("#agNotifyCodeForm:not([hidden])");
  check("the code goes to the typed address, the page says where and focuses the code field", rdvMails(NOTIFY).length === 1 && (await text(page, "#agNotifyTo")) === NOTIFY && (await page.evaluate(() => document.activeElement.id)) === "agNotifyCode");
  await page.fill("#agNotifyCode", "000000");
  await page.click("#agNotifyCheck");
  await page.waitForFunction(() => !document.getElementById("agNotifyErr").hidden);
  check("a wrong code says so", /incorrect/i.test(await text(page, "#agNotifyErr")), await text(page, "#agNotifyErr"));
  await page.fill("#agNotifyCode", lastCode(NOTIFY));
  await page.click("#agNotifyCheck");
  await page.waitForSelector("#agNotifyNow:not([hidden])");
  check("verified: « Les demandes arrivent à … », the code form is gone, the missing list no longer asks for it", (await text(page, "#agNotifyNow")) === `Les demandes arrivent à ${NOTIFY}.` && (await page.locator("#agNotifyCodeForm").isHidden()) && !/adresse qui recevra/.test(await text(page, "#agMissing")));

  // ---- un créneau
  await page.click("#agAddSlot");
  await page.waitForSelector("#slotDlg[open]");
  const days = await page.$$eval("#slotDays input", (els) => els.map((e) => `${e.value}:${e.checked ? 1 : 0}${e.disabled ? "x" : ""}`));
  check("new slot: weekdays checked, Saturday offered but unchecked, Sunday closed (cannot be chosen, and said why)", days.join() === "mo:1,tu:1,we:1,th:1,fr:1,sa:0,su:0x" && /Dimanche : le garage est fermé/.test(await text(page, "#slotDaysHelp")), days.join() + " " + (await text(page, "#slotDaysHelp")));
  check("the slot sheet shows no stray « null »", !/\bnull\b/.test(await page.$eval("#slotSvcs", (f) => f.innerText)));
  const svcs = await page.$$eval("#slotSvcs .ag-svc", (els) => els.map((e) => [e.dataset.id, e.querySelector("input").checked, e.querySelector("input").disabled, e.querySelector(".why").textContent]));
  check("services with an average time are listed; a 4 h 30 job does not fit a 4 h slot (greyed out, with the reason)", svcs.length === 3 && svcs.find((s) => s[0] === "distribution")[2] && /Plus longue que le créneau \(4 h\)/.test(svcs.find((s) => s[0] === "distribution")[3]) && (await text(page, "#slotSvcsTitle")) === "Prestations acceptées · 2 sur 3", JSON.stringify(svcs));
  let preview = await text(page, "#slotPreview");
  check("the preview shows the times a driver would see (oil change, 45 min, every 30 min within the slot)", /Aperçu · vidange.*45 min/i.test(preview) && /8:00.*8:30.*9:00.*9:30.*10:00.*10:30.*11:00/.test(preview) && !/11:30/.test(preview), preview);
  await axe(page, "volet d'un créneau");
  await shot(page, "1-creneau");
  await page.fill("#slotName", "Entretien courant");
  await page.selectOption("#slotEnd", "12:00");
  await page.click("#slotCapPlus");
  check("capacity stepper: 2 cars at a time, said in the preview", (await page.inputValue("#slotCap")) === "2" && /2 voitures à la fois/.test(await text(page, "#slotPreview")));
  await page.check('input[name="slotMode"][value="drop"]');
  preview = await text(page, "#slotPreview");
  check("drop-off mode: one arrival window, cars counted per day", /8:00–9:00/.test(preview) && /2 voitures déposées au plus/.test(preview) && /Arrivée entre 8:00 et 9:00, voiture rendue à 12:00/.test(await text(page, "#slotDropHelp")), preview);
  await page.check('input[name="slotMode"][value="hour"]');
  await page.click("#slotSave");
  await page.waitForFunction(() => !document.getElementById("slotDlg").open);
  const cells = await page.$$eval("#agWeek .ag-slot", (els) => els.map((e) => e.getAttribute("aria-label")));
  check("saved: the slot appears on the five weekdays, each one a button that names it", cells.length === 5 && /^Entretien courant, lundi de 8:00 à 12:00, 2 voitures : modifier$/.test(cells[0]), cells.join(" / "));
  missing = await text(page, "#agMissing");
  check("nothing is missing any more (only a hint: no published phone for the e-mails); the state still says closed until switched on", missing === "Votre téléphone n'apparaît pas dans les e-mails aux clients : demandez-le dans Fiche Pixcar." && (await text(page, "#agStateText")) === "Fermés", missing);

  // ouverture
  await page.click("#agEnabled");
  await page.waitForFunction(() => document.getElementById("agEnabled").getAttribute("aria-checked") === "true");
  check("switched on: « Activés », and the API now offers times to drivers", (await text(page, "#agStateText")) === "Activés" && (await call("GET", `/v1/rdv/garages/${GARAGE}/times?services=vidange`)).status === 200);
  check("switched on: the mini-site link says it is active", /^Votre mini-site est actif/.test(await text(page, "#agLinkState")), await text(page, "#agLinkState"));
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: srv.url });
  await page.click("#agLinkCopy");
  await page.waitForFunction(() => /Lien copié/.test(document.getElementById("agLive").textContent));
  check("« Copier le lien » puts the link in the clipboard and says so", (await page.evaluate(() => navigator.clipboard.readText())) === link && /Lien de votre mini-site copié/.test(await text(page, "#alert")), await text(page, "#alert"));
  await page.evaluate(() => (document.getElementById("agLive").textContent = "")); // « Enregistré. » est déjà là depuis l'ouverture
  await page.selectOption("#agDelay", "2");
  await page.waitForFunction(() => document.getElementById("agLive").textContent === "Enregistré.");
  check("a rule changes as soon as it is picked (minimum delay 2 h)", (await pro("GET", "/rdv")).body.settings.minDelayH === 2);
  // fermeture
  await page.click("#agAddClosure");
  await page.waitForSelector("#closDlg[open]");
  await page.fill("#closFirst", "2026-12-24");
  await page.fill("#closLast", "2026-12-31");
  await page.fill("#closLabel", "Congés de fin d'année");
  await axe(page, "fermeture");
  await page.click("#closSave");
  await page.waitForFunction(() => !document.getElementById("closDlg").open);
  check("a closure is listed with its dates and label", /Du jeudi 24 décembre au jeudi 31 décembre.*Congés de fin d'année · aucun rendez-vous proposé/.test(await text(page, "#agClosures")), await text(page, "#agClosures"));
  await page.click("#agHolidays");
  await page.waitForFunction(() => document.getElementById("agHolidays").getAttribute("aria-checked") === "false");
  check("public holidays can be offered like other days", /^Proposés comme les autres jours/.test(await text(page, "#agHolText")));
  await page.click("#agHolidays");
  await page.waitForFunction(() => document.getElementById("agHolidays").getAttribute("aria-checked") === "true");
  await axe(page, "Disponibilités (activés)");
  await shot(page, "2-disponibilites");

  // ---- deux demandes envoyées par des automobilistes (API publique)
  const times = (await call("GET", `/v1/rdv/garages/${GARAGE}/times?services=vidange`)).body;
  const [t1, t2] = [times.days[0], times.days[1]].map((d) => ({ day: d.day, time: d.times[0].t }));
  const ask = async (who, t) => {
    const b = { garageId: GARAGE, services: [{ id: "vidange", qty: 1 }], day: t.day, time: t.time, name: who.name, email: who.email, phone: "06 39 98 12 34", car: "Peugeot 208", year: 2019, plate: "EZ-108-BC", message: who.message || "", remindPrice: false };
    const r = await call("POST", "/v1/rdv/requests", b);
    const c = await call("POST", `/v1/rdv/requests/${r.body.id}/code`, { code: lastCode(who.email) });
    return c.status === 200;
  };
  check("setup: two requests sent and confirmed by their code", (await ask({ name: "Julien Roux", email: "julien.roux@example.com", message: "Un bruit au freinage." }, t1)) && (await ask({ name: "Inès Martin", email: "ines.martin@example.com" }, t2)));
  await page.reload();
  await page.waitForSelector('[data-screen="dash"]:not([hidden])');
  check("the dashboard lists the 2 requests under « Demandes à traiter », the menu counts them", (await text(page, "#dbRqCount")) === "2" && (await page.$$eval("#dbRq > li", (els) => els.length)) === 2 && (await text(page, "#rqCount")) === "2");
  await axe(page, "tableau de bord (demandes à traiter)");
  await page.click("#dbRqLink");
  await page.waitForSelector("#dash-requests:not([hidden]):not([aria-busy])");
  const cards = await page.$$eval("#rqList .rq-card", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ")));
  check("« Demandes »: one card per request, with the deadline, the slot and its places, the client, the car, the message", cards.length === 2 && /Vidange.*À traiter avant/.test(cards[0]) && /Créneau « Entretien courant » · encore 1 place sur 2 à cette heure/.test(cards[0]) && /Julien Roux · 06 39 98 12 34 · julien\.roux@example\.com/.test(cards[0]) && /Peugeot 208 · 2019 · EZ-108-BC/.test(cards[0]) && /Un bruit au freinage\./.test(cards[0]) && /Pas de message/.test(cards[1]), cards.join("\n"));
  check("the state button says the appointments are open; « À traiter » counts 2", /Rendez-vous en ligne : activés/.test(await text(page, "#rqState")) && (await text(page, "#rqTodoCount")) === "2");
  await axe(page, "Demandes (à traiter)");
  await shot(page, "3-demandes");

  // accepter la première
  const before = rdvMails().length;
  await page.click('#rqList .rq-card:first-child button:has-text("Accepter")');
  await page.waitForFunction(() => document.querySelectorAll("#rqList .rq-card").length === 1);
  check("accepted: the card leaves, the counters say 1, the client gets the confirmation e-mail", (await text(page, "#rqCount")) === "1" && (await text(page, "#rqTodoCount")) === "1" && rdvMails().slice(before).some((m) => m.target === "julien.roux@example.com" && /^Confirmé :/.test(m.subject)) && /confirmé/.test(await text(page, "#alert")), rdvMails().slice(before).map((m) => m.subject).join(" / "));
  // refuser la seconde : un motif est demandé
  await page.click('#rqList .rq-card button:has-text("Refuser")');
  await page.waitForSelector("#whyDlg[open]");
  check("decline: the dialog names the request and lists the reasons", (await text(page, "#whyDlgKind")) === "Refuser la demande" && (await page.$$eval('#whyReasons input[name="whyReason"]', (els) => els.length)) === 4);
  await axe(page, "motif d'un refus");
  await page.click("#whySave");
  check("a reason is required", /Choisissez un motif/.test(await text(page, "#whyErr")));
  await page.check('#whyReasons input[value="full"]');
  await page.fill("#whyNote", "Rappelez-nous la semaine prochaine.");
  await page.click("#whySave");
  await page.waitForFunction(() => !document.getElementById("whyDlg").open);
  await page.waitForSelector("#rqList .empty");
  check("declined: nothing left to answer, the counters disappear, the client is told", (await page.locator("#rqCount").isHidden()) && (await page.locator("#rqTodoCount").isHidden()) && rdvMails("ines.martin@example.com").some((m) => /ne peut pas vous recevoir/.test(m.subject)), rdvMails("ines.martin@example.com").map((m) => m.subject).join(" / "));

  // à venir : tableau, détails, export, annulation
  await page.click("#rqTab-upcoming");
  await page.waitForSelector("#rqList .rq-table");
  const row = await page.$$eval("#rqList .rq-table tbody tr:not(.rq-more)", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ")));
  check("« À venir »: the confirmed appointment in a table, export offered", row.length === 1 && /Vidange/.test(row[0]) && /Julien Roux/.test(row[0]) && /Confirmé/.test(row[0]) && (await page.locator("#rqTools").isVisible()), row.join(" / "));
  await page.click('#rqList .rq-table button:has-text("Détails")');
  check("details: client, car, message, and the cancel action", /Client : Julien Roux/.test(await text(page, "#rqList .rq-more")) && (await page.getAttribute('#rqList .rq-table button:has-text("Détails")', "aria-expanded")) === "true");
  await axe(page, "Demandes (à venir)");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#rqExport")]);
  const ics = fs.readFileSync(await dl.path(), "utf8");
  check("export: an .ics calendar with the appointment", dl.suggestedFilename() === "rendez-vous-pixcar.ics" && /^BEGIN:VCALENDAR\r\n/.test(ics) && /SUMMARY:Vidange \(huile \+ filtre\) · Julien Roux/.test(ics) && (ics.match(/BEGIN:VEVENT/g) || []).length === 1, ics.slice(0, 400));
  await page.click('#rqList button:has-text("Annuler ce rendez-vous")');
  await page.waitForSelector("#whyDlg[open]");
  check("cancel: the garage's own reasons are offered", (await text(page, "#whyDlgKind")) === "Annuler le rendez-vous" && (await page.$$eval('#whyReasons input[name="whyReason"]', (els) => els.map((e) => e.value).join())) === "workshop,parts,closed,other");
  await page.check('#whyReasons input[value="parts"]');
  await page.click("#whySave");
  await page.waitForFunction(() => !document.getElementById("whyDlg").open);
  await page.waitForSelector("#rqList .empty");
  check("cancelled: no appointment left to come, the client is told", rdvMails("julien.roux@example.com").some((m) => /^Rendez-vous annulé par Garage Démo Centre/.test(m.subject)), rdvMails("julien.roux@example.com").map((m) => m.subject).join(" / "));
  await page.click("#rqTab-past");
  await page.waitForSelector("#rqList .rq-table");
  const past = await page.$$eval("#rqList .pill", (els) => els.map((e) => e.textContent));
  check("« Passées »: the declined request and the cancelled appointment, each with who did it", past.sort().join() === "Annulée par vous,Refusée", past.join());
  await page.focus("#rqTab-past");
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(() => document.activeElement.id === "rqTab-upcoming" && document.getElementById("rqTab-upcoming").getAttribute("aria-selected") === "true");
  check("tabs: arrow keys move between « À traiter », « À venir », « Passées »", true);
  await axe(page, "Demandes (passées)");
  check("no console error, no page error", !logs.length, logs.join("\n"));
  await ctx.close();

  // ---- téléphone
  {
    const m = await newPage({ width: 390, height: 844 });
    await m.page.goto(`${srv.url}/pro/`);
    await m.page.waitForSelector('[data-screen="dash"]:not([hidden])');
    // depuis la maquette « Parcours Atelier » (24 octobre 2026) : un rail d'icônes de 64 px à gauche remplace la barre du bas et son « Plus »
    const bar = await m.page.$$eval("#dashNav .dash-link:not(.rail-toggle)", (els) => els.filter((e) => e.offsetParent).map((e) => { const r = e.getBoundingClientRect(), t = [...e.querySelectorAll("span")].filter((x) => x.offsetParent && !x.classList.contains("dash-count")); return [e.innerText.trim(), Math.round(r.right), Math.round(r.bottom), Math.max(0, ...t.map((x) => x.getBoundingClientRect().width))]; }));
    check("mobile: the 64 px icon rail lists every link, names kept for screen readers but not shown, all inside the screen, no « Plus »", bar.map((x) => x[0]).join("|") === "Tableau de bord|Gestion d'atelier|Demandes|Mon garage|Mes garages" && bar.every(([, right, bottom, label]) => right <= 64 && bottom <= 844 && label <= 1) && (await m.page.locator("#dashMore").isHidden()), JSON.stringify(bar));
    await shot(m.page, "4-mobile-rail");
    await m.page.click('#dashNav .dash-link[data-panel="garage"]');
    await m.page.waitForSelector("#dash-garage:not([hidden]):not([aria-busy])");
    check("mobile: a link of the rail opens its screen", await m.page.locator("#dash-garage").isVisible());
    await m.page.click("#mgTab-hours");
    await m.page.waitForSelector("#mgPanel-hours:not([hidden])");
    const list = await m.page.evaluate(() => ({ grid: getComputedStyle(document.getElementById("agWeek")).display, days: [...document.querySelectorAll("#agDays li")].map((li) => li.innerText.replace(/\s+/g, " ")) }));
    check("mobile « Disponibilités »: a list by day instead of the grid, the slot on weekdays, Sunday closed", list.grid === "none" && list.days.length === 7 && /^Lundi Entretien courant 8:00–12:00 · 2 voitures$/.test(list.days[0]) && /Samedi Aucun créneau/.test(list.days[5]) && /Dimanche Fermé/.test(list.days[6]), JSON.stringify(list));
    check("mobile « Disponibilités »: no horizontal scroll", (await overflow(m.page)) <= 0, await overflow(m.page));
    await axe(m.page, "Disponibilités (mobile)");
    await shot(m.page, "5-mobile-disponibilites");
    await m.page.click("#agDays .ag-chip");
    await m.page.waitForSelector("#slotDlg[open]");
    const dlg = await m.page.evaluate(() => { const r = document.getElementById("slotDlg").getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), title: document.getElementById("slotDlgTitle").textContent, inner: document.getElementById("slotDlg").scrollWidth - document.getElementById("slotDlg").clientWidth }; });
    check("mobile: tapping a slot opens it for editing, the dialog fits the screen", dlg.title === "Modifier le créneau" && dlg.left >= 0 && dlg.right <= 390 && dlg.inner <= 0, JSON.stringify(dlg));
    await shot(m.page, "6-mobile-creneau");
    await m.page.click("#slotCancel");
    await m.page.click('.dash-link[data-panel="requests"]');
    await m.page.waitForSelector("#dash-requests:not([hidden]):not([aria-busy])");
    await m.page.click("#rqTab-past");
    await m.page.waitForSelector("#rqList .rq-table");
    check("mobile « Demandes »: no horizontal scroll, the table header is dropped", (await overflow(m.page)) <= 0 && (await m.page.$eval("#rqList thead", (e) => getComputedStyle(e).display)) === "none", await overflow(m.page));
    await axe(m.page, "Demandes (mobile)");
    await shot(m.page, "7-mobile-demandes");
    check("mobile: no console error, no page error", !m.logs.length, m.logs.join("\n"));
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
