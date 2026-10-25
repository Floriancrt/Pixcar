// Mini-site de réservation d'un garage (docs/rendez-vous.md, « Mini-site de réservation ») de bout en bout : site construit pour de bon
// avec l'Espace Pro (donc la page reserver/), vraie API (PGlite) avec les rendez-vous ouverts, horloge de la page arrêtée au jeudi
// 1er octobre 2026 (celle de l'API part du même jour). Parcours : la page du garage (en-tête, héros, l'atelier, horaires, questions) →
// liste des prestations (prix annoncé) → disponibilités (semaine, « +N créneaux », par jour, matin / après-midi, prochain créneau) →
// immatriculation obligatoire → coordonnées → récapitulatif et code → demande envoyée (suivi) ; horaire pris entre-temps, rechoisi avec
// le même code ; téléphone ; liens faux ou garage fermé ; axe ; politique de la version publiée.
//   node tests/reserver.js
delete process.env.PIXCAR_ROOT;
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { launch, ROOT } = require("./harness");
const { serveDir } = require("./static-server");
const { startApi } = require("./api-harness");
const { OSM, uid } = require("./fixtures/garages-data");

const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond });
  if (!cond) console.log("  FAIL:", name, "|", String(detail).slice(0, 600));
};
const AXE = fs.readFileSync(path.join(ROOT, "node_modules/axe-core/axe.min.js"), "utf8");
const OUT = path.join(__dirname, ".out", "reserver-site");
const SHOTS = path.join(__dirname, ".out", "shots");
const SRC = process.env.PIXCAR_SRC || path.join(ROOT, "src");
const BUILD = process.env.PIXCAR_BUILD ? path.resolve(ROOT, process.env.PIXCAR_BUILD) : path.join(ROOT, "scripts/build.mjs");
const LEGAL = { editorLine: "Pixcar est édité à titre non professionnel par Jeanne Exemple, responsable du traitement des données décrites ici.", contact: "contact@exemple.test", hostPages: "GitHub, Inc. (GitHub Pages), États-Unis", hostApi: "Amazon Web Services EMEA SARL, Luxembourg (région Europe, Stockholm)", repairRetentionMonths: 24, updated: "3 octobre 2026" };
const ACCOUNT = "sub-res";
const TOKEN = `tok.${ACCOUNT}.1`;
const MARTIN = "Garage Martin & Fils";
const NOTIFY = "atelier@garage-martin.fr";
const DAY = [["08:00", "12:00"], ["14:00", "18:00"]];
const WEEK = { mo: DAY, tu: DAY, we: DAY, th: DAY, fr: DAY, sa: [["08:00", "12:00"]] };
const NOW = new Date("2026-10-01T10:00:00+02:00"); // jeudi

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, "empty"), { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const srv = await serveDir(path.join(OUT, "empty"));
  const { AuthError } = await import("../server/lib/jwt.mjs");
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
  api.upstream.elements = OSM;
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(api.url + p, { method, headers: { origin: srv.url, ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const pro = (method, p, body) => call(method, `/v1/pro/garages/${uid(1)}${p}`, body, { authorization: `Bearer ${TOKEN}` });
  const outbox = api.app.pro.senders.outbox;
  const mails = (to) => outbox.filter((m) => m.channel === "rdv" && (!to || m.target === to));
  const lastCode = (to) => {
    const m = mails(to).filter((x) => /code (\d{6})/.test(x.subject)).at(-1);
    return m && /code (\d{6})/.exec(m.subject)[1];
  };

  // Garage Martin : vérifié, fiche approuvée (téléphone, e-mail, site, horaires du lundi au samedi matin), vidange (45 min) et plaquettes
  // avant (60 min) prises en ligne, un créneau du lundi au vendredi 8:00–12:00 (une voiture à la fois), vidange annoncée « dès 79 € »
  await api.db.query("INSERT INTO pro_claims (id, account_id, garage_id, siret, status, channel, holder_name, holder_role, target_hash, target_hint, verified_at) VALUES (gen_random_uuid(), $1, $2, '73282932000074', 'verified', 'email', 'Camille Durand', 'manager', $3, 'c•••@x.fr', now())", [ACCOUNT, uid(1), "a".repeat(64)]);
  await api.db.query("INSERT INTO pro_profiles (garage_id, name, street, pc, city, phone, email, website, hours, account_id) VALUES ($1, $2, '5 rue Neuve', '31220', 'Cazères', '+33561000099', 'contact@garage-martin.fr', 'https://www.garage-martin.fr', $3, 'acc')", [uid(1), MARTIN, JSON.stringify(WEEK)]);
  const ready =
    (await pro("PUT", "/services/vidange", { offered: true, minutes: 45 })).status === 200 &&
    (await pro("PUT", "/services/plaq_av", { offered: true, minutes: 60 })).status === 200 &&
    (await pro("PUT", "/prices/vidange", { kind: "from", price: 79, vehicles: [], includes: ["parts", "labour"] })).status === 200 &&
    (await pro("POST", "/rdv/notify", { email: NOTIFY })).status === 200 &&
    (await pro("POST", "/rdv/notify/code", { code: lastCode(NOTIFY) })).status === 200 &&
    (await pro("POST", "/rdv/slots", { name: "Atelier", days: ["mo", "tu", "we", "th", "fr"], start: "08:00", end: "12:00", mode: "hour", capacity: 1, services: ["vidange", "plaq_av"] })).status === 200 &&
    (await pro("PUT", "/rdv/settings", { enabled: true, minDelayH: 0 })).status === 200;
  check("setup: Garage Martin takes two services online (hours, notification address, one slot, a price, open)", ready);
  outbox.length = 0;

  // ---- construction : avec l'Espace Pro (page reserver/), sans (rien), version publiée (politique)
  const src = path.join(OUT, "src");
  fs.cpSync(SRC, src, { recursive: true });
  fs.writeFileSync(path.join(src, "legal.json"), JSON.stringify(LEGAL));
  const env = { ...process.env, PIXCAR_API_BASE: api.url, PIXCAR_PRO_POOL: "eu-north-1_PixcarTest1", PIXCAR_PRO_CLIENT: "4pro0test1client2id3", PIXCAR_GA_ID: "", PIXCAR_CS_ID: "", PIXCAR_MAPBOX_TOKEN: "" };
  const build = (name, extra = [], e = env) => execFileSync(process.execPath, [BUILD, "--only", "dist", "--src", src, "--out", path.join(OUT, name), ...extra], { stdio: "pipe", env: e });
  build("site");
  const dist = path.join(OUT, "site", "dist");
  srv.setRoot(dist);
  const assets = fs.readdirSync(path.join(dist, "assets"));
  check("with the Espace Pro: reserver/ exists with its own stylesheet and script (fingerprinted)", fs.existsSync(path.join(dist, "reserver/index.html")) && assets.some((f) => /^reserver\.[0-9a-f]+\.css$/.test(f)) && assets.some((f) => /^reserver\.[0-9a-f]+\.js$/.test(f)));
  build("plain", [], { ...env, PIXCAR_PRO_POOL: "", PIXCAR_PRO_CLIENT: "" });
  check("without the Espace Pro: no reserver/ page", !fs.existsSync(path.join(OUT, "plain/dist/reserver")) && !fs.readdirSync(path.join(OUT, "plain/dist/assets")).some((f) => f.startsWith("reserver.")));
  build("pages", ["--pages", "pixcar.example"]);
  const pHtml = fs.readFileSync(path.join(OUT, "pages/dist/reserver/index.html"), "utf8");
  const csp = (/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(pHtml) || [])[1] || "";
  check(
    "published reserver/ page: its own CSP (connect-src = the API only, no inline script or style), noindex, no referrer leak, not blocked in robots.txt (link previews), always revalidated",
    csp.includes(`connect-src ${new URL(api.url).origin};`) && /script-src 'self';/.test(csp) && /style-src 'self';/.test(csp) && /base-uri 'none'/.test(csp) && /<meta name="robots" content="noindex">/.test(pHtml) && /<meta name="referrer" content="strict-origin-when-cross-origin">/.test(pHtml) &&
      !/reserver/.test(fs.readFileSync(path.join(OUT, "pages/dist/robots.txt"), "utf8")) && /\/reserver\/\n  Cache-Control: no-cache/.test(fs.readFileSync(path.join(dist, "_headers"), "utf8")),
    csp,
  );

  // ---- navigateur
  const browser = await launch();
  const axe = async (page, label, scope = "document") => {
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running")); // apparition du calendrier (0,2 s)
    await page.evaluate(AXE);
    const r = await page.evaluate(async (sel) => (await window.axe.run(sel === "document" ? document : document.querySelector(sel), { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } })).violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => `${n.target.join(" ")} ${(n.any[0] && n.any[0].message) || ""}`).join(" | ")}`), scope);
    check(`axe: no violation on « ${label} »`, r.length === 0, r.join("\n"));
  };
  // pleine page : depuis le haut, sinon le récapitulatif (colonne collante) apparaît décalé
  const shot = async (page, name, full = false) => (full && (await page.evaluate(() => window.scrollTo(0, 0))), page.screenshot({ path: path.join(SHOTS, `res-${name}.png`), fullPage: full }));
  const text = (page, sel) => page.$eval(sel, (e) => e.innerText.replace(/\s+/g, " ").trim());
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const newPage = async (viewport) => {
    const ctx = await browser.newContext({ viewport, locale: "fr-FR", timezoneId: "Europe/Paris", serviceWorkers: "block" });
    await ctx.clock.setFixedTime(NOW);
    await ctx.route("**/*", (route) => (new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort()));
    const page = await ctx.newPage();
    const logs = [];
    page.on("console", (m) => ["error", "warning"].includes(m.type()) && !/status of (404|409|422)\b/.test(m.text()) && logs.push(m.text()));
    page.on("pageerror", (e) => logs.push(e.message));
    return { ctx, page, logs };
  };
  const site = `${srv.url}/reserver/?garage=${uid(1)}`;

  // ================================================================ ordinateur
  {
    const { ctx, page, logs } = await newPage({ width: 1440, height: 900 });
    await page.goto(site);
    await page.waitForSelector("#msApp:not([hidden]) #msPanelTitle");
    check("the page: the garage in the header and the title, the hero, verified, open today (Thursday)", (await text(page, "#msHeadName")) === MARTIN && (await page.title()) === `${MARTIN} · Réserver en ligne · Pixcar` && (await text(page, ".hero h1")) === "Réservez votre créneau." && /^Garage Martin & Fils · Cazères$/i.test(await text(page, ".hero .eyebrow")), await text(page, ".hero"));
    check("hero facts: city and postcode, « Garage vérifié », « Ouvert ce jeudi »", /Cazères · 31220/.test(await text(page, ".garage-facts")) && /Garage vérifié/.test(await text(page, ".garage-facts")) && /Ouvert ce jeudi/.test(await text(page, ".garage-facts")), await text(page, ".garage-facts"));
    check("step 1 first: « Préparez votre rendez-vous », the plate and the services side by side, the guide on the right", (await text(page, "#msPanelTitle")) === "Préparez votre rendez-vous" && (await page.isVisible("#msPlate")) && (await page.isVisible("#msSvcBtn")) && /Un rendez-vous, en toute simplicité\./.test(await text(page, "#msSum")) && (await page.getAttribute(".progress [aria-current=step]", "class")) === "current");
    check(
      "the workshop: address, phone, e-mail and website links, route in a new tab, hours (Thursday in bold, Sunday closed), four questions",
      /5 rue Neuve 31220 Cazères/.test(await text(page, "#garage-info")) &&
        (await page.getAttribute('#garage-info a[href^="tel:"]', "href")) === "tel:+33561000099" &&
        (await page.getAttribute('#garage-info a[href^="mailto:"]', "href")) === "mailto:contact@garage-martin.fr" &&
        (await page.getAttribute('#garage-info a[href^="https://www.garage"]', "target")) === "_blank" &&
        /destination=Garage%20Martin%20%26%20Fils%2C%205%20rue%20Neuve/.test(await page.getAttribute('#garage-info a[href*="google.com/maps"]', "href")) &&
        (await text(page, ".hours .active-day")) === "Jeudi 08:00–12:00 / 14:00–18:00" &&
        /Dimanche Fermé/.test(await text(page, ".hours")) &&
        (await page.$$eval(".faq details", (d) => d.length)) === 4,
      await text(page, "#garage-info"),
    );
    await axe(page, "mini-site : accueil");
    await shot(page, "1-accueil", true);

    // prestations : la liste déroulante
    await page.click("#msOpenSvc");
    check("« Choisir mes prestations » opens the list: the two online services, the announced price, how each is confirmed", (await page.isVisible("#msSvcMenu")) && (await page.getAttribute("#msSvcBtn", "aria-expanded")) === "true" && (await page.$$eval("#msSvcMenu .multi-option", (r) => r.map((x) => x.innerText.replace(/\s+/g, " ").trim()))).join(" | ") === "Vidange (huile + filtre) Confirmée par le garage Dès 79 € | Plaquettes de frein avant Confirmée par le garage", await text(page, "#msSvcMenu"));
    await shot(page, "2-prestations");
    await page.check("#svc-vidange");
    await page.waitForSelector(".availability-week .slot-button");
    check("one service: the panel becomes « Les disponibilités de l'atelier », the list stays open, the chip and the count", (await text(page, "#msPanelTitle")) === "Les disponibilités de l'atelier" && (await page.isVisible("#msSvcMenu")) && (await text(page, ".picked-tags")) === "Vidange (huile + filtre) ×" && (await text(page, "#msSvcValue")) === "1 prestation sélectionnée");
    await page.keyboard.press("Escape");
    check("Escape closes the list and gives the focus back to its button", (await page.isHidden("#msSvcMenu")) && (await page.evaluate(() => document.activeElement.id)) === "msSvcBtn");
    const cols = await page.$$eval(".availability-column", (cs) => cs.map((c) => [c.querySelector(".day-heading").innerText.replace(/\s+/g, " ").trim(), c.querySelectorAll(".slot-button").length, (c.querySelector(".slot-more, .no-slot") || { innerText: "" }).innerText.trim()]));
    check(
      "the week of the first free time (5–11 Oct.): five days of 7 times (5 shown, « +2 créneaux »), Saturday « Pas de créneau » (no slot), Sunday « Fermé »",
      (await text(page, "#msRange")) === "5 oct. – 11 oct." && cols.length === 7 && cols.slice(0, 5).every((c) => c[1] === 5 && c[2] === "+2 créneaux") && /7 créneaux/.test(cols[0][0]) && cols[5][2] === "Pas de créneau" && cols[6][2] === "Fermé" && (await page.isDisabled("#msPrevWeek")) === false,
      JSON.stringify(cols),
    );
    check("next free time and how the garage confirms (by Friday noon)", (await text(page, "#msNext")) === "Prochain créneau : lun. 5 oct. · 08:00" && /au plus tard le vendredi 2 octobre à 12:00/.test(await text(page, ".service-rule")), await text(page, ".service-rule"));
    await page.click("#msPrevWeek");
    const prev = await page.$$eval(".availability-column .no-slot", (n) => n.map((x) => x.innerText.trim()));
    check("the week before: past days « Passé », today and tomorrow « Pas de créneau » (deadline), Sunday « Fermé »; no earlier week", (await text(page, "#msRange")) === "28 sept. – 4 oct." && prev.join(",") === "Passé,Passé,Passé,Pas de créneau,Pas de créneau,Pas de créneau,Fermé" && (await page.isDisabled("#msPrevWeek")), prev.join(","));
    await page.click("#msNextWeek");
    await page.click("#m-2026-10-05");
    const dayTimes = (await page.$$eval(".day-slot-view .slot-button", (b) => b.map((x) => x.innerText.trim()))).join(" ");
    check("« +2 créneaux » opens that day: all seven times", (await page.getAttribute("#msViewDay", "aria-pressed")) === "true" && dayTimes === "08:00 08:30 09:00 09:30 10:00 10:30 11:00" && (await text(page, ".day-slot-view h3")) === "Lundi 5 octobre", `${dayTimes} | ${await text(page, "#msCal")}`);
    await page.click("#msF-pm");
    check("« Après-midi »: nothing that day, said plainly", /Aucun créneau pour cette sélection\./.test(await text(page, ".availability-empty")) && /Aucun créneau à ce moment de la journée/.test(await text(page, ".next-slot")));
    await page.click("#msF-all");
    await page.click("#msViewWeek");
    await page.click("#s-2026-10-05-0830");
    check("a time chosen: pressed, in the summary (drop-off), « Continuer » enabled, the price estimate", (await page.getAttribute("#s-2026-10-05-0830", "aria-pressed")) === "true" && /Dépôt lun\. 5 oct\. · 08:30/.test(await text(page, ".summary-dl")) && !(await page.isDisabled("#msContinue")) && /Estimation à partir de 79 €/.test(await text(page, ".summary-price")), await text(page, "#msSum"));
    await axe(page, "mini-site : disponibilités");
    await shot(page, "3-creneaux", true);

    // l'immatriculation, obligatoire
    await page.click("#msContinue");
    check("no plate: « Continuer » stops on the plate, with the reason", (await text(page, "#msPlateErr")) === "Indiquez l'immatriculation de la voiture." && (await page.evaluate(() => document.activeElement.id)) === "msPlate" && !(await page.$("#msForm")));
    await page.fill("#msPlate", "GE 123456");
    await page.click("#msContinue");
    check("a foreign plate needs « Plaque étrangère »", /^Immatriculation au format AB-123-CD/.test(await text(page, "#msPlateErr")));
    await page.check("#msPlateForeign");
    check("« Plaque étrangère » hides the F of the blue band and changes the example", (await page.isHidden("#msPlate").catch(() => false)) === false && (await page.$eval(".plate-country", (e) => getComputedStyle(e).display)) === "none" && (await page.getAttribute("#msPlate", "placeholder")) === "Ex. M-AB 1234");
    await page.uncheck("#msPlateForeign");
    await page.fill("#msPlate", "ab 123 cd");
    check("the plate shows in the summary as it is typed", (await text(page, "#msSumPlate")) === "AB 123 CD");
    await page.click("#msContinue");
    await page.waitForSelector("#msForm");
    check("details: step 2, the time recalled, the plate set (AB-123-CD), the summary keeps it", (await page.getAttribute(".progress [aria-current=step]", "class")) === "current" && /Vos coordonnées/.test(await text(page, ".progress [aria-current=step]")) && /Lundi 5 octobre à 08:30/.test(await text(page, ".selected-slot-strip")) && (await page.inputValue("#msPlate2")) === "AB-123-CD" && (await text(page, "#msSumPlate")) === "AB-123-CD" && (await page.evaluate(() => document.activeElement.id)) === "msContactTitle");
    await page.click("#msSend");
    check("an empty first name is caught on the page, nothing sent", (await text(page, "#msFirstErr")) === "Indiquez votre prénom." && !mails().length);
    await page.fill("#msFirst", "Lina");
    await page.fill("#msLast", "Morel");
    await page.fill("#msEmail", "lina.morel@example.com");
    await page.fill("#msPhone", "06 22 33 44 55");
    await page.fill("#msCar", "Renault Clio");
    await page.fill("#msYear", "2018");
    await page.fill("#msMsg", "Voyant d'huile allumé.");
    await axe(page, "mini-site : coordonnées");
    await shot(page, "4-coordonnees", true);
    await page.click("#msSend");
    await page.waitForSelector("#msCode");
    check("step 3: the code is sent (nothing to the garage yet), the review shows the plate, the car, the service, the estimate and the details", mails("lina.morel@example.com").length === 1 && !mails(NOTIFY).length && /Immatriculation AB-123-CD Véhicule Renault Clio · 2018 Prestations Vidange \(huile \+ filtre\) Estimation À partir de 79 € TTC/.test(await text(page, ".review-card")) && /Nom Lina Morel E-mail lina\.morel@example\.com Téléphone 06 22 33 44 55/.test(await text(page, ".contact-card")) && /Envoyé à lina\.morel@example\.com/.test(await text(page, "#msCodeHelp")) && (await text(page, "#msConfirm")) === "Envoyer la demande", await text(page, ".contact-card"));
    await page.fill("#msCode", "000000");
    await page.click("#msConfirm");
    await page.waitForFunction(() => !document.getElementById("msCodeErr").hidden);
    check("a wrong code says so, nothing sent", /^Code incorrect/.test(await text(page, "#msCodeErr")) && !mails(NOTIFY).length, await text(page, "#msCodeErr"));
    await axe(page, "mini-site : récapitulatif et code");
    await shot(page, "5-confirmation", true);
    await page.fill("#msCode", lastCode("lina.morel@example.com"));
    await page.click("#msConfirm");
    await page.waitForSelector("#msDoneTitle");
    const linaMail = mails("lina.morel@example.com").find((x) => /#c=/.test(x.text || ""));
    const track = await page.getAttribute("#msTrack", "href");
    const row = (await api.db.query("SELECT plate, car, car_year, name FROM rdv_requests WHERE email = 'lina.morel@example.com'")).rows[0] || {};
    check(
      "sent: « Votre demande est envoyée. », the deadline, the plate; « Suivre ma demande » leads to rendez-vous/#c=…; the garage gets the plate",
      (await text(page, "#msDoneTitle")) === "Votre demande est envoyée." && /au plus tard le vendredi 2 octobre à 12:00/.test(await text(page, ".success-panel .intro")) && /AB-123-CD/.test(await text(page, ".success-panel .review-card")) &&
        !!linaMail && track === `${srv.url}/rendez-vous/#c=${(/#c=([A-Za-z0-9_-]{43})/.exec(linaMail.text) || [])[1]}` && mails(NOTIFY).some((x) => /AB-123-CD/.test(x.text)) && row.plate === "AB-123-CD" && row.name === "Lina Morel" && row.car === "Renault Clio" && row.car_year === 2018 && (await page.isHidden("#msNavBook")),
      `${track} | ${JSON.stringify(row)}`,
    );
    await axe(page, "mini-site : demande envoyée");
    await shot(page, "6-envoyee", true);

    // un autre rendez-vous : l'horaire pris entre-temps se rechoisit avec le même code
    await page.click("#msAgain");
    await page.waitForSelector("#msPanelTitle");
    check("« Prendre un autre rendez-vous »: back to step 1, the plate kept", (await text(page, "#msPanelTitle")) === "Préparez votre rendez-vous" && (await page.inputValue("#msPlate")) === "AB-123-CD");
    await page.click("#msOpenSvc");
    await page.check("#svc-vidange");
    await page.check("#svc-plaq_av");
    await page.waitForFunction(() => document.querySelectorAll(".availability-week .slot-button").length && /2 prestations/.test(document.getElementById("msSvcValue").textContent) && /Plaquettes/.test(document.getElementById("msSum").textContent));
    await page.keyboard.press("Escape");
    check("two services: both chips, the summary lists both, the estimate becomes « Tarif à préciser » (one has no price)", (await page.$$eval(".picked-tags > span", (s) => s.length)) === 2 && /Plaquettes de frein avant À préciser/.test(await text(page, ".summary-services")) && /Tarif à préciser/.test(await text(page, ".summary-price")), await text(page, "#msSum"));
    await page.click("#s-2026-10-06-0800");
    await page.click("#msContinue");
    await page.waitForSelector("#msForm");
    check("details remembered from the first booking", (await page.inputValue("#msFirst")) === "Lina" && (await page.inputValue("#msEmail")) === "lina.morel@example.com");
    await page.fill("#msEmail", "lina2@example.com");
    await page.click("#msSend");
    await page.waitForSelector("#msCode");
    // quelqu'un prend le même horaire avant le code
    const o = await call("POST", "/v1/rdv/requests", { garageId: uid(1), services: [{ id: "vidange", qty: 1 }], day: "2026-10-06", time: "08:00", name: "Inès Martin", email: "ines@example.com", phone: "07 11 22 33 44", car: "Peugeot 208", year: 2019, plate: "EZ-108-BC" });
    const oc = o.status === 201 && (await call("POST", `/v1/rdv/requests/${o.body.id}/code`, { code: lastCode("ines@example.com") }));
    await page.fill("#msCode", lastCode("lina2@example.com"));
    await page.click("#msConfirm");
    await page.waitForSelector(".ms-notice");
    check("the time was taken meanwhile: back to the times with the reason, that time gone, « Envoyer avec cet horaire »", oc && oc.status === 200 && /vient d'être pris|n'est plus libre/.test(await text(page, ".ms-notice")) && !(await page.$("#s-2026-10-06-0800")) && (await text(page, "#msContinue")) === "Envoyer avec cet horaire", await text(page, "#booking"));
    await page.click("#msNext");
    const nextT = await page.$eval(".slot-button.selected", (b) => b.id);
    await page.click("#msContinue");
    await page.waitForSelector("#msDoneTitle");
    check("another time, the same code: sent without retyping anything", (await text(page, "#msDoneTitle")) === "Votre demande est envoyée." && mails(NOTIFY).filter((x) => /Lina Morel/.test(`${x.subject} ${x.text}`)).length === 2, nextT);
    check("desktop: no console error, no page error", !logs.length, logs.join("\n"));
    await ctx.close();
  }

  // ================================================================ téléphone
  {
    const { ctx, page, logs } = await newPage({ width: 390, height: 844 });
    await page.goto(site);
    await page.waitForSelector("#msPanelTitle");
    check("phone: no horizontal scroll on arrival", (await overflow(page)) <= 0, await overflow(page));
    await page.click("#msOpenSvc");
    await page.check("#svc-vidange");
    await page.waitForSelector(".availability-week .slot-button");
    await page.keyboard.press("Escape");
    check("phone: no horizontal scroll with the week (the week scrolls inside its panel)", (await overflow(page)) <= 0, await overflow(page));
    await axe(page, "mini-site : téléphone");
    await shot(page, "7-telephone", true);
    check("phone: no console error, no page error", !logs.length, logs.join("\n"));
    await ctx.close();
  }

  // ================================================================ liens faux, garage sans rendez-vous en ligne
  {
    const { ctx, page, logs } = await newPage({ width: 1280, height: 900 });
    await page.goto(`${srv.url}/reserver/?garage=pas-un-garage`);
    await page.waitForSelector("#msGone:not([hidden])");
    check("a malformed link: « Ce lien de réservation n'est pas valide », back to the comparator", (await text(page, "#msGoneTitle")) === "Ce lien de réservation n'est pas valide" && (await page.getAttribute("#msGoneActs a", "href")) === "../" && (await page.isHidden("#msNav")));
    await page.goto(`${srv.url}/reserver/?garage=aaaaaaaa-0000-4000-8000-00000000dead`);
    await page.waitForSelector("#msGone:not([hidden])");
    check("a garage that does not book online: « Pas de rendez-vous en ligne pour l'instant »", (await text(page, "#msGoneTitle")) === "Pas de rendez-vous en ligne pour l'instant" && /sur le comparateur\.$/.test(await text(page, "#msGoneText")));
    await axe(page, "mini-site : garage sans rendez-vous en ligne");
    await page.goto(`${srv.url}/reserver/`);
    await page.waitForSelector("#msGone:not([hidden])");
    check("no garage at all: invalid link too", (await text(page, "#msGoneTitle")) === "Ce lien de réservation n'est pas valide");
    check("error pages: no console error, no page error", !logs.length, logs.join("\n"));
    await ctx.close();
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
