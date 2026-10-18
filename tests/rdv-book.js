// Rendez-vous en ligne côté automobiliste (docs/rendez-vous.md, lot 2) de bout en bout : site construit pour de bon avec l'Espace Pro (donc
// la fenêtre « Prendre rendez-vous » et la page rendez-vous/), vraie API (PGlite) avec les rendez-vous ouverts, tuiles de la table et
// OpenStreetMap simulés. Parcours : étiquette et bloc de la fiche → fenêtre chargée au premier clic → horaire → coordonnées (voiture
// reprise de la mémoire du comparateur) → code → horaire pris entre-temps, rechoisi avec le même code → demande envoyée → suivi (page
// rendez-vous/#c=…) → réponse du garage sans connexion (#g=…) → agenda, annulation, refus avec motif ; téléphone ; axe ; politiques.
//   node tests/rdv-book.js
delete process.env.PIXCAR_ROOT;
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { launch, open, search, ROOT } = require("./harness");
const { serveDir } = require("./static-server");
const { startApi } = require("./api-harness");
const { OSM, oid, uid, TILES, indexOf, dayStr } = require("./fixtures/garages-data");

const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond });
  if (!cond) console.log("  FAIL:", name, "|", String(detail).slice(0, 600));
};
const AXE = fs.readFileSync(path.join(ROOT, "node_modules/axe-core/axe.min.js"), "utf8");
const OUT = path.join(__dirname, ".out", "rdv-book-site");
const SHOTS = path.join(__dirname, ".out", "shots");
const SRC = process.env.PIXCAR_SRC || path.join(ROOT, "src");
const BUILD = process.env.PIXCAR_BUILD ? path.resolve(ROOT, process.env.PIXCAR_BUILD) : path.join(ROOT, "scripts/build.mjs");
const LEGAL = { editorLine: "Pixcar est édité à titre non professionnel par Jeanne Exemple, responsable du traitement des données décrites ici.", contact: "contact@exemple.test", hostPages: "GitHub, Inc. (GitHub Pages), États-Unis", hostApi: "Amazon Web Services EMEA SARL, Luxembourg (région Europe, Stockholm)", repairRetentionMonths: 24, updated: "3 octobre 2026" };
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
const ACCOUNT = "sub-rdv";
const TOKEN = `tok.${ACCOUNT}.1`;
const MARTIN = "Garage Martin & Fils";
const NOTIFY = "atelier@garage-martin.fr";
const DAY = [["08:00", "12:00"], ["14:00", "18:00"]];
const WEEK = { mo: DAY, tu: DAY, we: DAY, th: DAY, fr: DAY };
const ME = { name: "Julien Roux", email: "julien.roux@example.com", phone: "06 39 98 12 34" };
const OTHER = { name: "Inès Martin", email: "ines.martin@example.com" };

async function tiles(ctx) {
  await ctx.route("**/garages/**", (route) => {
    const u = new URL(route.request().url());
    if (!u.pathname.startsWith("/garages/")) return route.fallback(); // /v1/rdv/garages/…/times : l'API, pas les tuiles
    const m = /\/garages\/(index|t\/(-?\d+--?\d+))\.json$/.exec(u.pathname);
    if (!m) return route.fulfill({ status: 404, body: "" });
    const body = m[2] ? { v: 1, g: TILES[m[2]] || [] } : indexOf({ built: dayStr(20), tiles: TILES });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

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
  const tokenIn = (m, kind) => (m && new RegExp(`#${kind}=([A-Za-z0-9_-]{43})`).exec(m.text) || [])[1];

  // Garage Martin (OpenStreetMap osm:node/9301 complété par le lieu uid(1) de la table) : vérifié, fiche « Mon garage » approuvée, vidange en
  // 45 min, adresse des demandes vérifiée, un créneau du lundi au vendredi 8:00–12:00 (une voiture à la fois), rendez-vous ouverts
  await api.db.query("INSERT INTO pro_claims (id, account_id, garage_id, siret, status, channel, holder_name, holder_role, target_hash, target_hint, verified_at) VALUES (gen_random_uuid(), $1, $2, '73282932000074', 'verified', 'email', 'Camille Durand', 'manager', $3, 'x', now())", [ACCOUNT, uid(1), "a".repeat(64)]);
  await api.db.query("INSERT INTO pro_claims (id, account_id, garage_id, siret, status, channel, holder_name, holder_role, target_hash, target_hint, verified_at) VALUES (gen_random_uuid(), 'acc-5', $1, '73282932000074', 'verified', 'email', 'Léa Petit', 'manager', $2, 'x', now())", [uid(5), "b".repeat(64)]);
  await api.db.query("INSERT INTO pro_profiles (garage_id, name, street, pc, city, phone, hours, account_id) VALUES ($1, $2, '5 rue Neuve', '31220', 'Cazères', '+33561000099', $3, 'acc')", [uid(1), MARTIN, JSON.stringify(WEEK)]);
  const ready =
    (await pro("PUT", "/services/vidange", { offered: true, minutes: 45 })).status === 200 &&
    (await pro("POST", "/rdv/notify", { email: NOTIFY })).status === 200 &&
    (await pro("POST", "/rdv/notify/code", { code: lastCode(NOTIFY) })).status === 200 &&
    (await pro("POST", "/rdv/slots", { name: "Entretien", days: ["mo", "tu", "we", "th", "fr"], start: "08:00", end: "12:00", mode: "hour", capacity: 1, services: ["vidange"] })).status === 200 &&
    (await pro("PUT", "/rdv/settings", { enabled: true, minDelayH: 0 })).status === 200;
  check("setup: Garage Martin takes oil changes online (hours, 45 min, notification address, one slot, open)", ready);
  outbox.length = 0;

  // ---- construction : avec l'Espace Pro (fenêtre et page rendez-vous/), sans (rien), version publiée (politiques)
  const src = path.join(OUT, "src");
  fs.cpSync(SRC, src, { recursive: true });
  fs.writeFileSync(path.join(src, "legal.json"), JSON.stringify(LEGAL));
  const env = { ...process.env, PIXCAR_API_BASE: api.url, PIXCAR_PRO_POOL: "eu-north-1_PixcarTest1", PIXCAR_PRO_CLIENT: "4pro0test1client2id3", PIXCAR_GA_ID: "", PIXCAR_CS_ID: "", PIXCAR_MAPBOX_TOKEN: "" };
  const build = (name, extra = [], e = env) => execFileSync(process.execPath, [BUILD, "--only", "dist", "--src", src, "--out", path.join(OUT, name), ...extra], { stdio: "pipe", env: e });
  build("site");
  const dist = path.join(OUT, "site", "dist");
  srv.setRoot(dist);
  const assets = fs.readdirSync(path.join(dist, "assets"));
  const bookJs = assets.find((f) => /^rdv-book\.[0-9a-f]+\.js$/.test(f)), bookCss = assets.find((f) => /^rdv-book\.[0-9a-f]+\.css$/.test(f));
  const app = fs.readFileSync(path.join(dist, "assets", assets.find((f) => /^app\./.test(f))), "utf8");
  check("with the Espace Pro: the booking window is two files apart, the comparator only knows their names; rendez-vous/ exists and is kept out of robots", bookJs && bookCss && app.includes(`assets/${bookJs}`) && app.includes(`assets/${bookCss}`) && !app.includes("Recevoir le code") && fs.existsSync(path.join(dist, "rendez-vous/index.html")) && /Disallow: \/rendez-vous\//.test(fs.readFileSync(path.join(dist, "robots.txt"), "utf8")));
  build("plain", [], { ...env, PIXCAR_PRO_POOL: "", PIXCAR_PRO_CLIENT: "" });
  const plainAssets = fs.readdirSync(path.join(OUT, "plain/dist/assets"));
  check("without the Espace Pro: no booking window, no rendez-vous/ page", !plainAssets.some((f) => f.startsWith("rdv-")) && !fs.existsSync(path.join(OUT, "plain/dist/rendez-vous")));
  // texte de confidentialité : une section « Rendez-vous en ligne » dans le site qui a l'Espace Pro, aucune sans lui
  const legalRdv = (file) => (/<section aria-labelledby="lg-rdv"[\s\S]*?<\/section>/.exec(fs.readFileSync(file, "utf8")) || [""])[0].replace(/<[^>]+>/g, " ").replace(/&nbsp;|\s+/g, " ");
  const rdvText = legalRdv(path.join(dist, "index.html"));
  check("privacy text: a « Rendez-vous en ligne » section only with the Espace Pro", !!rdvText && !legalRdv(path.join(OUT, "plain/dist/index.html")));
  check(
    "privacy text: what goes to the garage only, the code and the hashed counting (no IP kept), Scaleway, the legal bases, the retention (24 h, 2 days, 30 / 7 days, 24 months anonymous)",
    /transmises au seul garage choisi/.test(rdvText) && /l'adresse IP n'est pas enregistrée/.test(rdvText) && /Scaleway Transactional Email/.test(rdvText) && /point b/.test(rdvText) && /consentement, point a/.test(rdvText) &&
      /une demande dont le code n'a pas été saisi, 24 heures/.test(rdvText) && /envois de codes, 2 jours/.test(rdvText) && /30 jours après le rendez-vous, ou 7 jours après un refus/.test(rdvText) && /effacés après 24 mois/.test(rdvText) && /rien de vous ne leur est transmis/.test(rdvText),
    rdvText.slice(0, 400),
  );
  build("pages", ["--pages", "pixcar.example"]);
  const rvHtml = fs.readFileSync(path.join(OUT, "pages/dist/rendez-vous/index.html"), "utf8");
  const rvCsp = (/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(rvHtml) || [])[1] || "";
  check("published rendez-vous/ page: its own CSP (connect-src = the API only, no inline script or style), not indexed, no referrer leak of the link", rvCsp.includes(`connect-src ${new URL(api.url).origin};`) && /script-src 'self';/.test(rvCsp) && /style-src 'self';/.test(rvCsp) && !/unsafe-inline|cognito/.test(rvCsp) && /<meta name="robots" content="noindex">/.test(rvHtml) && /strict-origin-when-cross-origin/.test(rvHtml), rvCsp);

  // ---- navigateur
  const browser = await launch();
  const axe = async (page, label, scope = "document") => {
    await page.evaluate(AXE);
    const r = await page.evaluate(async (sel) => (await window.axe.run(sel === "document" ? document : document.querySelector(sel), { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } })).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`), scope);
    check(`axe: no violation on « ${label} »`, r.length === 0, r.join("\n"));
  };
  const shot = (page, name, full = false) => page.screenshot({ path: path.join(SHOTS, `rdv-${name}.png`), fullPage: full });
  const text = (page, sel) => page.$eval(sel, (e) => e.innerText.replace(/\s+/g, " ").trim());
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const vehicle = { "jg.vehicles.v1": [{ model: "Peugeot 208", year: 2019, plate: "EZ-108-BC", at: "2026-09-01T10:00:00Z" }] };
  const go = async (vp = { width: 1440, height: 900 }) => {
    const r = await open(browser, srv, "index.html", { ...vp, storage: vehicle, mock: { elements: OSM }, initScript: `window.JG_CITY_LOOKUP=false;window.JG_GARAGES_BASE="garages/";` });
    await tiles(r.ctx);
    return r;
  };
  const errorsOf = (logs) => [...logs.errors, ...logs.console.filter((l) => !/status of (409|422)\b/.test(l))];

  let { page, ctx, logs } = await go();
  await search(page, { service: "vidange", km: 10 });
  await page.waitForFunction(() => document.querySelector("#list .v-rdv"), null, { timeout: 8000 }).catch(() => {});
  const badges = await page.$$eval("#list > li.card", (els) => els.map((c) => [c.querySelector(".g-name").textContent.trim(), [...c.querySelectorAll(".v-badge")].map((b) => b.innerText.trim()).join(" + ")]).filter((x) => x[1]));
  check("list: « Rendez-vous en ligne » beside « Garage vérifié » for Garage Martin only (the other verified garage does not book online)", badges.some(([n, b]) => n === MARTIN && b === "Garage vérifié + Rendez-vous en ligne") && badges.some(([n, b]) => n === "Carrosserie du Soleil" && b === "Garage vérifié"), JSON.stringify(badges));
  check("nothing of the booking window is loaded before a click", !logs.requests.some((u) => /rdv-book/.test(u)));
  await page.click(`#list [data-id="${oid(1)}"] .g-main`);
  await page.waitForSelector(`#list [data-id="${oid(1)}"] .rdv-box`);
  await page.$eval(`#list [data-id="${oid(1)}"] .g-more`, (el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  await page.locator(`#list [data-id="${oid(1)}"]`).screenshot({ path: path.join(SHOTS, "rdv-0-fiche.png") });
  await axe(page, "fiche avec « Prendre rendez-vous »", "#list");
  check("fiche: a « Prendre rendez-vous » block with « Choisir un horaire »", /^Prendre rendez-vous Choisissez un horaire libre\. Le garage confirme au plus tard à midi le jour ouvré suivant ; sa réponse arrive par e-mail\. Choisir un horaire$/.test(await text(page, `#list [data-id="${oid(1)}"] .rdv-box`)), await text(page, `#list [data-id="${oid(1)}"] .rdv-box`));

  // 1. horaire
  await page.click(`#list [data-id="${oid(1)}"] [data-act="rdv"]`);
  await page.waitForSelector(".rdv-dlg[open] .rb-time");
  check("the window loads on the first click (script and stylesheet), opens on the times, names the garage and the service", logs.requests.some((u) => u.endsWith(bookJs)) && logs.requests.some((u) => u.endsWith(bookCss)) && (await text(page, "#rbGarage")) === `${MARTIN} · Vidange (huile + filtre)` && (await page.evaluate(() => document.activeElement.textContent)) === "Choisissez un horaire");
  const days = await page.$$eval(".rb-day", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ")));
  const times = await page.$$eval(".rb-time", (els) => els.map((e) => e.textContent));
  check("times: from Monday (answer due Friday noon), every 30 min that fits 45 min in 8:00–12:00, nothing chosen yet", /^lun\. 5 oct\. 7 horaires$/.test(days[0]) && times.join() === "8:00,8:30,9:00,9:30,10:00,10:30,11:00" && (await page.isDisabled("#rbGo")), JSON.stringify({ days: days.slice(0, 3), times }));
  check("the answer deadline is said before anything is typed (and no stray « null »)", !/null|undefined/.test(await text(page, ".rb-body")) && /Le garage répond au plus tard le vendredi 2 octobre à 12:00\. Vous recevez sa réponse par e-mail\./.test(await text(page, ".rb-body")), await text(page, ".rb-body"));
  await page.click('.rb-day:nth-child(2)');
  check("another day: its times, the day button keeps the focus", (await page.getAttribute(".rb-day:nth-child(2)", "aria-pressed")) === "true" && (await page.evaluate(() => document.activeElement.classList.contains("rb-day"))));
  await page.click('.rb-day:nth-child(1)');
  await page.click('.rb-time[data-t="08:00"]');
  check("a time chosen: pressed, « Continuer » enabled", (await page.getAttribute('.rb-time[data-t="08:00"]', "aria-pressed")) === "true" && !(await page.isDisabled("#rbGo")));
  await axe(page, "fenêtre de rendez-vous : horaire", ".rdv-dlg");
  await shot(page, "1-horaire");
  await page.click("#rbGo");

  // 2. coordonnées
  await page.waitForSelector("#rbName");
  check("details: the title recalls the time; the car comes from the comparator's memory (model, year, plate)", (await text(page, ".rb-h")) === "lun. 5 oct., 8:00" && (await page.inputValue("#rbCar")) === "Peugeot 208" && (await page.inputValue("#rbYear")) === "2019" && (await page.inputValue("#rbPlate")) === "EZ-108-BC");
  await page.click("#rbSend");
  check("an empty name is caught on the page, nothing sent", (await text(page, "#rbNameErr")) === "Indiquez votre nom." && (await page.getAttribute("#rbName", "aria-invalid")) === "true" && !mails().length);
  await page.fill("#rbName", ME.name);
  await page.fill("#rbEmail", "julien.roux@");
  await page.fill("#rbPhone", ME.phone);
  await page.click("#rbSend");
  check("an invalid e-mail is caught on the page", (await text(page, "#rbEmailErr")) === "Adresse e-mail invalide." && !mails().length);
  await page.fill("#rbEmail", ME.email);
  await page.fill("#rbMsg", "Un bruit au freinage.");
  await page.check("#rbRemind");
  await axe(page, "fenêtre de rendez-vous : coordonnées", ".rdv-dlg");
  await shot(page, "2-coordonnees");
  await page.click("#rbSend");

  // 3. code
  await page.waitForSelector("#rbCode");
  check("code: sent to the typed address (code in the subject), the window names the address, resend waits 60 s", mails(ME.email).length === 1 && /Envoyé à julien\.roux@example\.com\. Valable 10 minutes\./.test(await text(page, "#rbCodeHelp")) && /^Renvoyer le code \(\d+ s\)$/.test(await text(page, "#rbResend")) && (await page.isDisabled("#rbResend")));
  await page.fill("#rbCode", "000000");
  await page.click("#rbCheck");
  await page.waitForFunction(() => !document.getElementById("rbCodeErr").hidden);
  check("a wrong code says how many tries are left", /^Code incorrect\. Encore 4 essais\.$/.test(await text(page, "#rbCodeErr")), await text(page, "#rbCodeErr"));
  await axe(page, "fenêtre de rendez-vous : code", ".rdv-dlg");
  // entre-temps, quelqu'un d'autre prend lundi 8:00 (une voiture à la fois)
  const r2 = await call("POST", "/v1/rdv/requests", { garageId: uid(1), services: [{ id: "vidange", qty: 1 }], day: "2026-10-05", time: "08:00", name: OTHER.name, email: OTHER.email, phone: "07 11 22 33 44", car: "Renault Clio", year: 2017, plate: "", message: "", remindPrice: false });
  const c2 = await call("POST", `/v1/rdv/requests/${r2.body.id}/code`, { code: lastCode(OTHER.email) });
  check("setup: another driver takes Monday 8:00 meanwhile", c2.status === 200, JSON.stringify(c2.body));
  await page.fill("#rbCode", lastCode(ME.email));
  await page.click("#rbCheck");
  await page.waitForSelector(".rdv-dlg .dlg-note.warn");
  const after = await page.$$eval(".rb-time", (els) => els.map((e) => e.textContent));
  check("the time was taken: back to the times with the reason; 8:00 and 8:30 are gone (45 min on one car), the code stays valid", /Cet horaire vient d'être pris\. Choisissez-en un autre : votre code reste valable\./.test(await text(page, ".rdv-dlg .dlg-note.warn")) && after[0] === "9:00" && (await text(page, "#rbGo")) === "Envoyer avec cet horaire", JSON.stringify(after));
  await page.click('.rb-time[data-t="09:00"]');
  await page.click("#rbGo");

  // envoyée
  await page.waitForSelector(".rb-done");
  const doneText = await text(page, ".rb-body");
  check("sent with the same code: « Demande envoyée », the time, the deadline, where the answer arrives", /^Demande envoyée lundi 5 octobre à 9:00 Vidange \(huile \+ filtre\) /.test(doneText) && /répond au plus tard le vendredi 2 octobre à 12:00\. Sa réponse arrive par e-mail à julien\.roux@example\.com/.test(doneText) && (await page.isHidden("#rbSteps")), doneText);
  const garageMail = mails(NOTIFY).find((m) => m.text.includes(ME.name));
  const myMail = mails(ME.email).find((m) => /^Demande envoyée/.test(m.subject));
  check("e-mails: the garage gets the request with its answer link, the driver a summary with the tracking link", !!tokenIn(garageMail, "g") && !!tokenIn(myMail, "c"), mails().map((m) => `${m.target}: ${m.subject}`).join(" / "));
  await axe(page, "fenêtre de rendez-vous : envoyée", ".rdv-dlg");
  await shot(page, "3-envoyee");
  const track = await page.getAttribute(".rb-done ~ .dlg-actions a", "href");
  check("« Suivre ma demande » leads to rendez-vous/#c=<the same token as in the e-mail>", track === `${srv.url}/rendez-vous/#c=${tokenIn(myMail, "c")}`, track);
  await page.click('.rdv-dlg .dlg-actions button:has-text("Fermer")');
  check("closing gives the focus back to « Choisir un horaire »", (await page.evaluate(() => document.activeElement.dataset.act)) === "rdv");
  check("comparator: no console error, no page error", !errorsOf(logs).length, errorsOf(logs).join("\n"));
  await ctx.close();

  // ---- page de suivi et page du garage
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "fr-FR", timezoneId: "Europe/Paris", serviceWorkers: "block", acceptDownloads: true });
  await ctx2.route("**/*", (route) => (new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort()));
  const p2 = await ctx2.newPage();
  const logs2 = [];
  p2.on("console", (m) => ["error", "warning"].includes(m.type()) && !/status of (404|409|422)\b/.test(m.text()) && logs2.push(m.text()));
  p2.on("pageerror", (e) => logs2.push(e.message));
  const visit = async (hash) => {
    await p2.goto(`${srv.url}/rendez-vous/${hash}`);
    await p2.waitForFunction(() => document.getElementById("rvLoading").hidden);
  };
  await visit(`#c=${tokenIn(myMail, "c")}`);
  check("tracking: pending, the deadline, the garage, the car; three steps", (await text(p2, "#rvStatus")) === "En attente du garage" && (await text(p2, "#rvTitle")) === "Demande envoyée" && /au plus tard le vendredi 2 octobre à 12:00/.test(await text(p2, "#rvLead")) && /Garage Martin & Fils · 5 rue Neuve, 31220 Cazères/.test(await text(p2, "#rvCard")) && /Peugeot 208 · 2019 · EZ-108-BC/.test(await text(p2, "#rvCard")) && (await p2.$$eval("#rvSteps li", (l) => l.length)) === 3, await text(p2, "#rvView"));
  await axe(p2, "suivi : en attente");
  await shot(p2, "4-suivi", true);
  // le garage répond depuis l'e-mail, sans connexion
  await visit(`#g=${tokenIn(garageMail, "g")}`);
  check("garage page: the request, the client, the deadline; Accept / Refuse / Call", (await text(p2, "#rvTitle")) === "Nouvelle demande de rendez-vous" && /Julien Roux · 06 39 98 12 34 · julien\.roux@example\.com/.test(await text(p2, "#rvCard")) && /Un bruit au freinage\./.test(await text(p2, "#rvCard")) && (await text(p2, "#rvActs")) === "Accepter Refuser Appeler le client", await text(p2, "#rvView"));
  await axe(p2, "page du garage");
  await shot(p2, "5-garage", true);
  await p2.click("#rvAccept");
  await p2.waitForFunction(() => document.getElementById("rvTitle").textContent === "Rendez-vous confirmé");
  check("accepted from the e-mail: confirmed, the client gets the confirmation", mails(ME.email).some((m) => /^Confirmé :/.test(m.subject)) && /Ouvrir l'Espace Pro/.test(await text(p2, "#rvActs")));
  await visit(`#c=${tokenIn(myMail, "c")}`);
  check("tracking: confirmed, with agenda, route and call", (await text(p2, "#rvTitle")) === "Rendez-vous confirmé" && /Ajouter à mon agenda Itinéraire Appeler le garage Annuler ce rendez-vous/.test(await text(p2, "#rvActs")), await text(p2, "#rvActs"));
  const [dl] = await Promise.all([p2.waitForEvent("download"), p2.click('#rvActs button:has-text("Ajouter à mon agenda")')]);
  const ics = fs.readFileSync(await dl.path(), "utf8");
  check("agenda: an .ics event at the garage", /^BEGIN:VCALENDAR\r\n/.test(ics) && /SUMMARY:Vidange \(huile \+ filtre\) · Garage Martin & Fils/.test(ics) && /LOCATION:5 rue Neuve\\, 31220 Cazères/.test(ics) && /DTSTART:20261005T070000Z/.test(ics), ics.slice(0, 500));
  check("route: Google Maps towards the garage", /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=/.test(await p2.getAttribute('#rvActs a:has-text("Itinéraire")', "href")));
  await p2.click('#rvActs button:has-text("Annuler ce rendez-vous")');
  await p2.waitForSelector("#rvCancel");
  await axe(p2, "suivi : annulation");
  await p2.check('#rvCancel input[value="unable"]');
  await p2.click("#rvCancelGo");
  await p2.waitForFunction(() => document.getElementById("rvTitle").textContent === "Rendez-vous annulé");
  check("cancelled by the driver: the page says so, the garage is told by e-mail", mails(NOTIFY).some((m) => /^Annulé par le client/.test(m.subject)) && !(await p2.$("#rvCancel")) && /C'est annulé/.test(await text(p2, "#rvAlert")));
  // l'autre demande : refusée par le garage, avec un motif
  const otherGarage = mails(NOTIFY).find((m) => m.text.includes(OTHER.name));
  await visit(`#g=${tokenIn(otherGarage, "g")}`);
  await p2.click('#rvActs button:has-text("Refuser")');
  await p2.click("#rvDeclineGo");
  check("decline from the e-mail: a reason is required", /Choisissez un motif/.test(await text(p2, "#rvDecline")));
  await p2.check('#rvDecline input[value="full"]');
  await p2.fill("#rvNote", "Essayez la semaine prochaine.");
  await axe(p2, "page du garage : refus");
  await p2.click("#rvDeclineGo");
  await p2.waitForFunction(() => document.getElementById("rvTitle").textContent === "Demande refusée");
  const otherMail = mails(OTHER.email).find((m) => /^Demande envoyée/.test(m.subject));
  await visit(`#c=${tokenIn(otherMail, "c")}`);
  check("the other driver sees the refusal and its reason", (await text(p2, "#rvTitle")) === "Garage Martin & Fils ne peut pas vous recevoir" && (await text(p2, "#rvLead")) === "Motif : pas de place à cet horaire — « Essayez la semaine prochaine. ».", await text(p2, "#rvView"));
  await visit(`#c=${"A".repeat(43)}`);
  check("an unknown link: « Ce lien ne fonctionne plus »", (await p2.isVisible("#rvGone")) && (await text(p2, "#rvGoneTitle")) === "Ce lien ne fonctionne plus");
  await visit("");
  check("no link at all: the page says to use the e-mail's link", (await text(p2, "#rvGoneText")) === "Ouvrez cette page depuis le lien reçu par e-mail.");
  await axe(p2, "lien expiré");
  check("rendez-vous/: no console error, no page error", !logs2.length, logs2.join("\n"));
  await ctx2.close();

  // ---- téléphone
  {
    const m = await go({ width: 390, height: 844 });
    await search(m.page, { service: "vidange", km: 10 });
    await m.page.waitForFunction(() => document.querySelector("#list .v-rdv"), null, { timeout: 8000 }).catch(() => {});
    await m.page.click(`#list [data-id="${oid(1)}"] .g-main`);
    await m.page.waitForSelector(`#list [data-id="${oid(1)}"] [data-act="rdv"]`);
    await m.page.click(`#list [data-id="${oid(1)}"] [data-act="rdv"]`);
    await m.page.waitForSelector(".rdv-dlg[open] .rb-time");
    await m.page.$eval(".rdv-dlg", (el) => Promise.all(el.getAnimations().map((a) => a.finished))); // la feuille monte en 0,3 s
    const box = await m.page.evaluate(() => {
      const r = document.querySelector(".rdv-dlg").getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom), inner: document.querySelector(".rdv-dlg").scrollWidth - document.querySelector(".rdv-dlg").clientWidth };
    });
    check("mobile: the window is a sheet at the bottom, full width, nothing cut on the side", box.left === 0 && box.right === 390 && box.bottom === 844 && box.inner <= 0, JSON.stringify(box));
    await shot(m.page, "6-mobile-horaire");
    await m.page.click(".rb-time");
    await m.page.click("#rbGo");
    await m.page.waitForSelector("#rbName");
    check("mobile details: no horizontal scroll inside the window", (await m.page.evaluate(() => document.querySelector(".rdv-dlg").scrollWidth - document.querySelector(".rdv-dlg").clientWidth)) <= 0);
    await axe(m.page, "fenêtre de rendez-vous (mobile)", ".rdv-dlg");
    await shot(m.page, "7-mobile-coordonnees");
    await m.ctx.close();
    const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "fr-FR", timezoneId: "Europe/Paris", serviceWorkers: "block" });
    await ctx3.route("**/*", (route) => (new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort()));
    const p3 = await ctx3.newPage();
    await p3.goto(`${srv.url}/rendez-vous/#c=${tokenIn(otherMail, "c")}`);
    await p3.waitForFunction(() => document.getElementById("rvLoading").hidden);
    check("mobile tracking page: no horizontal scroll", (await overflow(p3)) <= 0, await overflow(p3));
    await shot(p3, "8-mobile-suivi", true);
    await ctx3.close();
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
