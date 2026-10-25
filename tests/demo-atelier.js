// Garage de démonstration « Gestion d'atelier » (docs/gestion-atelier.md) : vraie API (PGlite), page construite pour de bon, données
// réalistes, horloges de l'API et du navigateur fixées au mardi 27 octobre 2026 à 10:40 (heure de Paris). Trois mécaniciens, six postes,
// une semaine de rendez-vous Pixcar (confirmés ou à confirmer) et pris par téléphone ou au comptoir, des interventions en cours, une
// absence, une maintenance, un créneau bloqué. Sert aux maquettes et aux captures ; n'est pas une suite de tests (aucun contrôle).
//   node tests/demo-atelier.js            captures de l'Espace Pro (Gestion d'atelier) dans tests/.out/demo-atelier/
delete process.env.PIXCAR_ROOT;
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { ROOT } = require("./harness");
const { serveDir } = require("./static-server");
const { startApi } = require("./api-harness");

const OUT = path.join(__dirname, ".out", "demo-atelier");
const SRC = process.env.PIXCAR_SRC || path.join(ROOT, "src");
const LEGAL = { editorLine: "Pixcar est édité à titre non professionnel par Jeanne Exemple, responsable du traitement des données décrites ici.", contact: "contact@exemple.test", hostPages: "GitHub, Inc. (GitHub Pages), États-Unis", hostApi: "Amazon Web Services EMEA SARL, Luxembourg (région Europe, Stockholm)", repairRetentionMonths: 24, updated: "3 octobre 2026" };
const GARAGE = "aaaaaaaa-0000-4000-8000-000000000027";
const CONTACTS = [{ id: GARAGE, name: "Garage des Pyrénées", addr: "12 avenue de la Gare, 31220 Cazères", pc: "31220", lat: 43.2174, lon: 1.1014, emails: ["contact@garage-pyrenees.fr"], phones: ["+33561000027"] }];
const ACCOUNT = "sub-demo";
const TOKEN = `tok.${ACCOUNT}.1`;
const DAY = [["08:00", "12:00"], ["14:00", "18:30"]];
const WEEK = { mo: DAY, tu: DAY, we: DAY, th: DAY, fr: DAY, sa: [["08:30", "12:00"]] };
const NOTIFY = "atelier@garage-pyrenees.fr";
// le jour de la démonstration : mardi 27 octobre 2026, 10:40 à Paris (heure d'hiver depuis le 25 : UTC+1)
const NOW = Date.parse("2026-10-27T09:40:00Z");
const D = { mo: "2026-10-26", tu: "2026-10-27", we: "2026-10-28", th: "2026-10-29", fr: "2026-10-30", sa: "2026-10-31" };
const SERVICES = [["vidange", 45], ["revision", 90], ["plaq_av", 60], ["disq_av", 120], ["montage", 15], ["geo_av", 45], ["clim", 45], ["diag", 60], ["batterie", 30], ["distribution", 240], ["amortisseurs", 120]];

async function demo({ log = console.log } = {}) {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, "empty"), { recursive: true });
  const srv = await serveDir(path.join(OUT, "empty"));
  const { AuthError } = await import("../server/lib/jwt.mjs");
  const { parseContactRows } = await import("../server/lib/contact.mjs");
  const api = await startApi({
    origin: srv.url,
    // la démonstration dépose une vingtaine de demandes depuis la même adresse : plafonds anti-abus relevés
    env: { PRO_ENABLED: "1", RDV_ENABLED: "1", RDV_CODES_PER_IP_PER_HOUR: "500", RDV_CODES_PER_IP_PER_DAY: "500", RDV_PENDING_PER_EMAIL: "50" },
    proOptions: {
      verifier: async (token) => {
        const m = /^tok\.(sub-[\w-]+)\.\d+$/.exec(token);
        if (!m) throw new AuthError("jeton refusé");
        return { sub: m[1] };
      },
      sirene: async () => null,
    },
  });
  const setClock = (ms) => (api.clock.skew += ms - api.now());
  const paris = (day, time) => Date.parse(`${day}T${time}:00${day < "2026-10-25" ? "+02:00" : "+01:00"}`);
  await api.app.pro.repo.upsertContacts(parseContactRows(CONTACTS).rows, "demo");
  await api.db.query("INSERT INTO pro_claims (id, account_id, garage_id, siret, status, channel, holder_name, holder_role, target_hash, target_hint, verified_at) VALUES (gen_random_uuid(), $1, $2, '73282932000082', 'verified', 'email', 'Camille Durand', 'manager', $3, 'c•••••@garage-pyrenees.fr', now())", [ACCOUNT, GARAGE, "d".repeat(64)]);
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
  const must = (what, r, ok = [200, 201]) => {
    if (!ok.includes(r.status)) log(`  démo : ${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    return r.body;
  };

  // ---- vendredi 23 octobre, 9:00 : le garage s'installe (mode simple), puis passe au calcul par ressources
  setClock(paris("2026-10-23", "09:00"));
  must("horaires", await pro("PUT", "/profile", { hours: WEEK }));
  for (const [s, m] of SERVICES) must(`prestation ${s}`, await pro("PUT", `/services/${s}`, { offered: true, minutes: m }));
  must("adresse de notification", await pro("POST", "/rdv/notify", { email: NOTIFY }));
  must("code de l'adresse", await pro("POST", "/rdv/notify/code", { code: lastCode(NOTIFY) }));
  must("créneau Atelier", await pro("POST", "/rdv/slots", { name: "Atelier", days: ["mo", "tu", "we", "th", "fr"], start: "08:00", end: "18:30", mode: "hour", capacity: 3, services: SERVICES.map(([s]) => s) }));
  must("créneau Samedi", await pro("POST", "/rdv/slots", { name: "Samedi matin", days: ["sa"], start: "08:30", end: "12:00", mode: "hour", capacity: 2, services: ["vidange", "plaq_av", "montage", "batterie"] }));
  must("réglages", await pro("PUT", "/rdv/settings", { enabled: true, minDelayH: 0, horizonDays: 28, stepMin: 30 }));
  const s = must("assistant", await pro("POST", "/rdv/calendar/start"));
  const skill = (label) => s.skills.find((k) => k.label.startsWith(label)).id;
  must("réglages du calendrier", await pro("PUT", "/rdv/calendar/settings", { receptionMin: 10, returnMin: 15, step: 5 }));
  const staff = {};
  for (const [name, skills] of [
    ["Thomas", ["Entretien courant", "Freinage", "Pneumatiques"]],
    ["Paul", ["Entretien courant", "Freinage", "Distribution", "Diagnostic électronique", "Électricité automobile"]],
    ["Inès", ["Entretien courant", "Pneumatiques", "Climatisation", "Diagnostic électronique"]],
  ])
    staff[name] = must(`mécanicien ${name}`, await pro("POST", "/rdv/calendar/staff", { name, skills: skills.map(skill) })).saved;
  const res = {};
  for (const [name, type] of [["Pont 1", "lift"], ["Pont 2", "lift"], ["Pont 3", "lift"], ["Banc de géométrie", "align"], ["Station clim", "clim"], ["Poste diagnostic", "diag"]])
    res[name] = must(`poste ${name}`, await pro("POST", "/rdv/calendar/resources", { name, type })).saved;
  must("activation", await pro("POST", "/rdv/calendar/activate"));

  // ---- les demandes Pixcar (déposées vendredi 23 octobre, comme sur le comparateur)
  const people = [
    ["Julien Roux", "Peugeot 208", 2019, "EZ-108-BC"], ["Sophie Martin", "Renault Clio IV", 2017, "FG-512-HJ"], ["Karim Benali", "Citroën C3", 2020, "GA-334-KL"],
    ["Lucie Bernard", "Toyota Yaris", 2021, "GK-778-PN"], ["Marc Petit", "Volkswagen Golf VII", 2016, "EB-921-RT"], ["Emma Leroy", "Dacia Sandero", 2022, "GN-145-AZ"],
    ["Hugo Fontaine", "Peugeot 3008", 2018, "FD-603-QS"], ["Chloé Morel", "Renault Captur", 2020, "FY-287-LM"], ["Nathan Girard", "Ford Fiesta", 2015, "DV-450-HB"],
    ["Léa Dubois", "Tesla Model 3", 2022, "GL-019-XC"], ["Antoine Mercier", "BMW Série 1", 2019, "FB-336-KD"],
  ];
  let n = 0;
  async function book(day, time, services, { accept = true } = {}) {
    const [name, car, year, plate] = people[n++ % people.length];
    const email = `${name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z]/g, ".")}@example.com`;
    const d = await call("POST", "/v1/rdv/requests", { garageId: GARAGE, services: services.map((x) => (typeof x === "string" ? { id: x, qty: 1 } : x)), day, time, name, email, phone: `06 ${String(10 + n).padStart(2, "0")} 45 67 ${String(20 + n)}`, car, year, plate, message: "", remindPrice: false });
    if (d.status !== 201) return void log(`  démo : demande ${day} ${time} → ${d.status} ${JSON.stringify(d.body).slice(0, 300)}`);
    const c = await call("POST", `/v1/rdv/requests/${d.body.id}/code`, { code: lastCode(email) });
    if (c.status !== 200) return void log(`  démo : code ${day} ${time} → ${c.status} ${JSON.stringify(c.body).slice(0, 300)}`);
    if (accept && !(c.body && c.body.status === "confirmed")) must(`acceptation ${day} ${time}`, await pro("POST", `/rdv/requests/${d.body.id}/accept`, {}));
    return d.body.id;
  }
  const req = {
    julien: await book(D.tu, "08:00", ["vidange"]),
    sophie: await book(D.tu, "09:00", ["revision"]),
    karim: await book(D.tu, "14:00", ["plaq_av"]),
    marc: await book(D.we, "08:00", ["distribution"]),
    emma: await book(D.we, "10:00", [{ id: "montage", qty: 4 }]),
    chloe: await book(D.th, "08:00", ["disq_av"]),
    lea: await book(D.fr, "08:00", ["revision"]),
    antoine: await book(D.fr, "11:00", ["batterie"]),
  };

  // ---- lundi 26 octobre, 18:00 : demandes à confirmer (heure limite : mardi midi), rendez-vous pris par téléphone, créneau bloqué,
  // absence, maintenance
  setClock(paris(D.mo, "18:00"));
  req.lucie = await book(D.tu, "16:00", ["clim"], { accept: false });
  req.hugo = await book(D.we, "15:00", ["geo_av"], { accept: false });
  req.nathan = await book(D.th, "14:30", ["diag"], { accept: false });
  const job = async (label, day, time, services, more = {}) =>
    must(`rendez-vous ${label}`, await pro("POST", "/rdv/calendar/blocks", { kind: "job", label, day, time, services: services.map((x) => (typeof x === "string" ? { id: x } : x)), confirm: true, ...more })).saved;
  const blocks = {
    garcia: await job("M. Garcia · Mégane", D.tu, "08:00", ["plaq_av"]),
    lambert: await job("Mme Lambert · 3008", D.tu, "09:30", ["diag"]),
    dumas: await job("Ets Dumas · Kangoo", D.tu, "11:00", [{ id: "montage", qty: 4 }]),
    chevalier: await job("M. Chevalier · Golf", D.tu, "14:00", ["amortisseurs"]),
    roche: await job("Mme Roche · Twingo", D.we, "14:00", ["vidange"]),
    faure: await job("M. Faure · Scénic", D.th, "08:00", ["revision"]),
    blanc: await job("M. Blanc · Kangoo", D.fr, "14:00", ["disq_av"]),
  };
  must("créneau bloqué", await pro("POST", "/rdv/calendar/blocks", { kind: "hold", label: "Livraison pièces", day: D.tu, time: "17:30", to: "18:00", resources: [res["Pont 3"]] }));
  must("absence", await pro("POST", "/rdv/calendar/unavail", { target: "staff", targetId: staff["Inès"], kind: "training", first: D.th, from: "14:00" }));
  must("maintenance", await pro("POST", "/rdv/calendar/unavail", { target: "resource", targetId: res["Pont 3"], kind: "maintenance", first: D.we, to: "12:00" }));

  // ---- mardi 27 octobre, 10:40 : la journée est lancée
  setClock(NOW);
  const work = async (id, ...steps) => {
    for (const status of steps) must(`état ${status}`, await pro("POST", `/rdv/calendar/work/${id}`, { status, notify: false }));
  };
  await work(req.julien, "received", "in_progress", "done");
  await work(blocks.garcia, "received", "in_progress");
  await work(req.sophie, "received", "in_progress");
  await work(blocks.lambert, "received", "in_progress", "waiting_parts");
  must("client sur place", await pro("POST", "/rdv/calendar/blocks", { kind: "job", label: "Client sur place · C4", day: D.tu, time: "10:45", services: [{ id: "batterie" }], received: true, confirm: true }));

  // ---- le site, construit comme la version publiée
  const src = path.join(OUT, "src");
  fs.cpSync(SRC, src, { recursive: true });
  fs.writeFileSync(path.join(src, "legal.json"), JSON.stringify(LEGAL));
  const env = { ...process.env, PIXCAR_API_BASE: api.url, PIXCAR_PRO_POOL: "eu-north-1_PixcarTest1", PIXCAR_PRO_CLIENT: "4pro0test1client2id3", PIXCAR_GA_ID: "", PIXCAR_CS_ID: "", PIXCAR_MAPBOX_TOKEN: "" };
  execFileSync(process.execPath, [path.join(ROOT, "scripts/build.mjs"), "--only", "dist", "--src", src, "--out", path.join(OUT, "site"), "--pages", "pixcar.fr"], { stdio: "pipe", env });
  srv.setRoot(path.join(OUT, "site", "dist"));

  const browser = await chromium.launch({ args: ["--proxy-server=direct://", "--proxy-bypass-list=*"] });
  async function newPage({ width = 1440, height = 1000, touch = false } = {}) {
    const ctx = await browser.newContext({ viewport: { width, height }, locale: "fr-FR", serviceWorkers: "block", hasTouch: touch, isMobile: touch });
    await ctx.clock.setFixedTime(NOW + (Date.now() % 1000));
    await ctx.addInitScript(([token, account]) => sessionStorage.setItem("pixcar-pro-session", JSON.stringify({ email: "camille@garage-pyrenees.fr", access: token, refresh: "ref." + account, expiresAt: Date.now() + 3600e3 })), [TOKEN, ACCOUNT]);
    await ctx.route("**/*", (route) => (new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort()));
    const page = await ctx.newPage();
    return { ctx, page };
  }
  return { api, srv, browser, newPage, pro, call, setClock, paris, req, blocks, staff, res, D, NOW, GARAGE, OUT, async close() { await browser.close(); await srv.close?.(); } };
}

module.exports = { demo, OUT };

if (require.main === module)
  (async () => {
    const only = process.argv.slice(2);
    const d = await demo();
    const shots = path.join(OUT, "shots");
    fs.mkdirSync(shots, { recursive: true });
    const settle = (page) => page.waitForFunction(() => !document.getAnimations().some((a) => a.playState === "running"));
    // une capture : l'écran Gestion d'atelier dans un affichage, puis ce que fait steps
    async function screen(name, { display = "simple", width = 1440, height = 1000, full = true } = {}, steps = async () => {}) {
      if (only.length && !only.includes(name)) return;
      const { page, ctx } = await d.newPage({ width, height });
      await ctx.addInitScript((v) => localStorage.setItem("pixcar-pro-display", v), display);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      await page.goto(`${d.srv.url}/pro/`);
      await page.waitForSelector('[data-screen="dash"]:not([hidden])');
      await page.click('.dash-link[data-panel="planning"]');
      await page.waitForSelector("#planGrid > *");
      await settle(page);
      await steps(page);
      await settle(page);
      await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: full });
      if (errors.length) console.log(`  ${name} : erreurs`, errors.slice(0, 3));
      await ctx.close();
    }
    const view = (page, t) => page.click(`.pl-view:has-text("${t}")`);
    const space = (page, t) => page.click(`.pl-space:has-text("${t}")`);
    await screen("01-simple-semaine");
    await screen("02-simple-jour", {}, (p) => view(p, "Jour"));
    await screen("03-simple-creation", { full: false, height: 1180 }, async (p) => {
      await view(p, "Jour");
      await p.click("#planNewRdv");
      await p.check('input[name="planSvc"][value="vidange"]');
      await p.fill("#planLabel", "Mme Petit");
      await p.fill("#planPhone", "06 12 34 56 78");
      await p.fill("#planCar", "Renault Clio IV");
      await p.fill("#planPlate", "FG-512-HJ");
    });
    await screen("04-simple-filtres", {}, async (p) => {
      await p.click("#planFToggle");
      await p.check('input[name="planFOrigin"][value="phone"]', { force: true });
    });
    await screen("04b-simple-filtres-replies", {}, async (p) => {
      await p.click("#planFToggle");
      await p.check('input[name="planFOrigin"][value="phone"]', { force: true });
      await p.click("#planFClose");
    });
    await screen("05-simple-plein-ecran", { full: false }, async (p) => {
      await view(p, "Jour");
      await p.click("#planFocus");
    });
    await screen("05b-simple-liste", {}, (p) => view(p, "Liste"));
    await screen("06-avance-agenda", { display: "advanced" });
    await screen("07-avance-equipe", { display: "advanced" }, async (p) => {
      await space(p, "Équipe");
      await view(p, "Jour");
    });
    await screen("07b-avance-equipe-semaine", { display: "advanced" }, async (p) => {
      await space(p, "Équipe");
      await view(p, "Semaine");
    });
    await screen("08-avance-equipements", { display: "advanced" }, async (p) => {
      await space(p, "Équipements");
      await view(p, "Jour");
    });
    await screen("09-avance-suivi", { display: "advanced" }, (p) => space(p, "Suivi"));
    await screen("10-avance-charge", { display: "advanced" }, async (p) => {
      await space(p, "Charge");
      await view(p, "Jour");
    });
    await screen("10b-avance-charge-semaine", { display: "advanced" }, async (p) => {
      await space(p, "Charge");
      await view(p, "Semaine");
    });
    await screen("11-parametres-modules", { display: "advanced" }, async (p) => {
      await p.click('.dash-link[data-panel="garage"]');
      await p.click("#mgTab-modules");
      await p.click("#mgMod-track");
      await p.waitForSelector(".mg-mod-ask");
    });
    await screen("12-fiche-intervention", { display: "advanced" }, async (p) => {
      await view(p, "Jour");
      await p.click(`.pl-ev[data-id="${d.req.sophie}"]`);
    });
    await screen("13-telephone-liste", { width: 390, height: 844 });
    await d.close();
    console.log("démonstration : captures dans", shots);
    process.exit(0);
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
