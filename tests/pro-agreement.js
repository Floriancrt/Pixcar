// Espace Pro, accord de sous-traitance des données (docs/sous-traitance.md) de bout en bout : page construite pour de bon, vraie API
// (PGlite) qui exige l'accord (PRO_AGREEMENT_REQUIRED=1), un garage en calcul par créneaux. Parcours : Gestion d'atelier annonce l'accord
// à accepter → « Nouveau rendez-vous » refusé par l'API : la fenêtre de l'accord s'ouvre d'elle-même (texte complet, éditeur et
// hébergeur remplis, mention de projet) → case non cochée : refusé → acceptée : le bandeau disparaît, le rendez-vous s'enregistre au
// second essai → Mon garage › Modules dit quand et par qui → relu, sans formulaire → téléphone ; axe.
//   node tests/pro-agreement.js
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
const OUT = path.join(__dirname, ".out", "pro-agreement-site");
const SHOTS = path.join(__dirname, ".out", "shots");
const SRC = process.env.PIXCAR_SRC || path.join(ROOT, "src");
const BUILD = process.env.PIXCAR_BUILD ? path.resolve(ROOT, process.env.PIXCAR_BUILD) : path.join(ROOT, "scripts/build.mjs");
const LEGAL = { editorName: "Jeanne Exemple", editorLine: "Pixcar est édité à titre non professionnel par Jeanne Exemple, responsable du traitement des données décrites ici.", contact: "contact@exemple.test", hostPages: "GitHub, Inc. (GitHub Pages), États-Unis", hostApi: "Amazon Web Services EMEA SARL, Luxembourg (région Europe, Stockholm)", repairRetentionMonths: 24, updated: "3 octobre 2026" };
const HERE = { lat: 43.2174, lon: 1.1014 };
const GARAGE = "aaaaaaaa-0000-4000-8000-000000000004";
const CONTACTS = [{ id: GARAGE, name: "Garage Démo Accord", addr: "18 rue de l'Exemple, 31220 Cazères", pc: "31220", ...HERE, emails: ["contact@garage-accord.fr"], phones: ["+33561000004"] }];
const ACCOUNT = "sub-accord";
const TOKEN = `tok.${ACCOUNT}.1`;
const DAY = [["08:00", "12:00"], ["14:00", "18:00"]];
const WEEK = { mo: DAY, tu: DAY, we: DAY, th: DAY, fr: DAY };
const NOTIFY = "atelier@garage-accord.fr";

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, "empty"), { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const srv = await serveDir(path.join(OUT, "empty"));
  const { AuthError } = await import("../server/lib/jwt.mjs");
  const { parseContactRows } = await import("../server/lib/contact.mjs");
  const { AGREEMENT } = await import("../src/js/shared/agreement.js");
  const R = await import("../src/js/shared/rdv.js");
  const api = await startApi({
    origin: srv.url,
    env: { PRO_ENABLED: "1", RDV_ENABLED: "1", PRO_AGREEMENT_REQUIRED: "1" },
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
  await api.db.query(
    "INSERT INTO pro_claims (id, account_id, garage_id, siret, status, channel, holder_name, holder_role, target_hash, target_hint, verified_at) VALUES (gen_random_uuid(), $1, $2, '73282932000090', 'verified', 'email', 'Camille Durand', 'manager', $3, 'c•••••@garage-accord.fr', now())",
    [ACCOUNT, GARAGE, "c".repeat(64)],
  );
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
  const today = R.parisParts(Date.now()).iso;
  let D1 = R.addDays(today, 1);
  while (["sa", "su"].includes(R.weekday(D1))) D1 = R.addDays(D1, 1);

  const ok =
    (await pro("PUT", "/profile", { hours: WEEK })).status === 200 &&
    (await pro("PUT", "/services/vidange", { offered: true, minutes: 45 })).status === 200 &&
    (await pro("POST", "/rdv/notify", { email: NOTIFY })).status === 200 &&
    (await pro("POST", "/rdv/notify/code", { code: lastCode(NOTIFY) })).status === 200 &&
    (await pro("POST", "/rdv/slots", { name: "Journée", days: ["mo", "tu", "we", "th", "fr"], start: "08:00", end: "18:00", mode: "hour", capacity: 2, services: ["vidange"] })).status === 200 &&
    (await pro("PUT", "/rdv/settings", { enabled: true, minDelayH: 0, horizonDays: 28 })).status === 200;
  check("setup: the garage takes requests, the agreement is not accepted yet", ok && (await pro("GET", "/agreement")).body.accepted === false);

  // ---- construction (comme la version publiée : politique de sécurité dans la page ; le projet permis pour l'essai)
  const src = path.join(OUT, "src");
  fs.cpSync(SRC, src, { recursive: true });
  fs.writeFileSync(path.join(src, "legal.json"), JSON.stringify(LEGAL));
  const env = { ...process.env, PIXCAR_ALLOW_DRAFT_AGREEMENT: "1", PIXCAR_API_BASE: api.url, PIXCAR_PRO_POOL: "eu-north-1_PixcarTest1", PIXCAR_PRO_CLIENT: "4pro0test1client2id3", PIXCAR_GA_ID: "", PIXCAR_CS_ID: "", PIXCAR_MAPBOX_TOKEN: "" };
  execFileSync(process.execPath, [BUILD, "--only", "dist", "--src", src, "--out", path.join(OUT, "site"), "--pages", "pixcar.fr"], { stdio: "pipe", env });
  srv.setRoot(path.join(OUT, "site", "dist"));
  // sans la permission d'essai, la version publiée refuse de se construire tant que le texte est un projet
  let refused = "";
  try {
    execFileSync(process.execPath, [BUILD, "--only", "dist", "--src", src, "--out", path.join(OUT, "refused"), "--pages", "pixcar.fr"], { stdio: "pipe", env: { ...env, PIXCAR_ALLOW_DRAFT_AGREEMENT: "" } });
  } catch (e) {
    refused = String(e.stderr || e.message);
  }
  check("a draft agreement is never published: the published build refuses it", !AGREEMENT.draft || /accord de sous-traitance est encore un projet/.test(refused), refused.slice(0, 300));

  const browser = await chromium.launch({ args: ["--proxy-server=direct://", "--proxy-bypass-list=*"] });
  async function newPage({ width = 1440, height = 1000, touch = false } = {}) {
    const ctx = await browser.newContext({ viewport: { width, height }, locale: "fr-FR", serviceWorkers: "block", hasTouch: touch, isMobile: touch });
    await ctx.addInitScript(([token, account]) => sessionStorage.setItem("pixcar-pro-session", JSON.stringify({ email: "camille@garage-accord.fr", access: token, refresh: "ref." + account, expiresAt: Date.now() + 3600e3 })), [TOKEN, ACCOUNT]);
    await ctx.route("**/*", (route) => (new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort()));
    const page = await ctx.newPage();
    const logs = [];
    const expected = (m) => /status of (400|401|403|409|422)\b/.test(m.text()) || (/status of 404\b/.test(m.text()) && /\/registry$/.test(m.location().url));
    page.on("console", (m) => ["error", "warning"].includes(m.type()) && !expected(m) && logs.push(`[${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => logs.push("[pageerror] " + e.message));
    return { ctx, page, logs };
  }
  const axe = async (page, label) => {
    await page.waitForFunction(() => !document.getAnimations().some((a) => a instanceof CSSTransition));
    await page.evaluate(AXE);
    const r = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } })).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`));
    check(`axe: no violation on « ${label} »`, r.length === 0, r.join("\n"));
  };
  const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `pro-agreement-${name}.png`) });
  const text = (page, sel) => page.$eval(sel, (e) => e.innerText.replace(/\s+/g, " ").trim());
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  const { ctx, page, logs } = await newPage();
  await page.goto(`${srv.url}/pro/`);
  await page.waitForSelector('[data-screen="dash"]:not([hidden])');
  await page.click('.dash-link[data-panel="planning"]');
  await page.waitForSelector("#dash-planning:not([hidden]):not([aria-busy])");
  check("Gestion d'atelier announces the agreement to accept, and why", (await page.isVisible("#planDpa")) && /^Accord de sous-traitance des données à accepter\. Il couvre votre équipe et les clients que vous notez ici/.test(await text(page, "#planDpa")), await text(page, "#planDpa"));

  // ---- un rendez-vous noté avant l'accord : l'API refuse, la fenêtre de l'accord s'ouvre d'elle-même
  await page.click("#planNewRdv");
  await page.waitForSelector('#planDlg[open] input[name="planSvc"]');
  await page.click('label:has(> input[name="planSvc"][value="vidange"])');
  await page.fill("#planDay", D1);
  await page.fill("#planTime", "09:00");
  await page.fill("#planLabel", "M. Martin");
  await page.fill("#planPhone", "06 12 34 56 78");
  await page.click("#planSave");
  await page.waitForSelector("#dpaDlg[open]");
  check("refused by the API: the agreement opens by itself, the form says why", /accord de sous-traitance/.test(await text(page, "#planErr")) && (await pro("GET", "/rdv/calendar/agenda?from=" + D1 + "&to=" + D1)).body.blocks.length === 0, await text(page, "#planErr"));
  const body = await text(page, "#dpaDlg .dpa-text");
  check(
    "the whole text: parties, data, instructions, security, sub-processors, retention, rights, breach, end, audits, the garage's commitments, a notice for its clients",
    ["1. Les parties", "2. Les données concernées", "4. Les instructions du garage", "6. Sécurité", "7. Sous-traitants ultérieurs", "8. Durées de conservation", "9. Les droits des personnes", "10. Violation de données", "11. Fin de l'accord", "12. Preuves et audits", "13. Les engagements du garage", "Modèle de mention pour vos clients"].every((h) => body.includes(h)),
    body.slice(0, 400),
  );
  check("filled from the editor's settings: processor, contact, host; nothing left to fill", body.includes("Jeanne Exemple, éditeur du site Pixcar") && body.includes("contact@exemple.test") && body.includes("Amazon Web Services EMEA SARL, Luxembourg") && !/\{\{|\}\}/.test(body));
  check("the version is shown; a draft says it is one", (await page.textContent("#dpaDlg .eyebrow")) === `Article 28 du RGPD · ${AGREEMENT.label}` && (!AGREEMENT.draft || /^Projet : ce texte doit être relu par un juriste/.test(await text(page, "#dpaDlg .dpa-draft"))));
  await axe(page, "accord de sous-traitance");
  await shot(page, "1-fenetre");

  // ---- case non cochée : rien ; cochée : accepté au nom du garage
  await page.click("#dpaAccept");
  check("unticked: refused in words, nothing recorded", (await text(page, "#dpaErr")) === "Cochez la case pour accepter l'accord." && (await pro("GET", "/agreement")).body.accepted === false);
  await page.check("#dpaCheck");
  check("ticking clears the message", await page.isHidden("#dpaErr"));
  await page.click("#dpaAccept");
  await page.waitForFunction(() => !document.getElementById("dpaDlg").open);
  const a = (await pro("GET", "/agreement")).body;
  check("accepted: recorded with the name given when the garage was attached", a.accepted && a.signer === "Camille Durand" && a.version === AGREEMENT.version, JSON.stringify(a));
  check("the banner goes", await page.isHidden("#planDpa"));
  check("the booking panel is still open with what was typed", (await page.$eval("#planDlg", (d) => d.open)) && (await page.inputValue("#planLabel")) === "M. Martin");
  await page.click("#planSave");
  await page.waitForFunction(() => !document.getElementById("planDlg").open);
  check("second try: the booking is saved", (await pro("GET", "/rdv/calendar/agenda?from=" + D1 + "&to=" + D1)).body.blocks.some((k) => k.client === "M. Martin"));

  // ---- Mon garage › Modules : quand et par qui ; relu sans formulaire
  await page.click('.dash-link[data-panel="garage"]');
  await page.waitForSelector("#dash-garage:not([hidden]):not([aria-busy])");
  await page.click("#mgTab-modules");
  await page.waitForSelector("#mgPanel-modules:not([hidden]) #mgDpa");
  const when = new Date(a.acceptedAt).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris" });
  check("Mon garage › Modules says when and by whom", (await text(page, "#mgDpaState")) === `Accepté le ${when} par Camille Durand (${AGREEMENT.label}).`, await text(page, "#mgDpaState"));
  await page.click('#mgDpa [data-dpa]');
  await page.waitForSelector("#dpaDlg[open]");
  check("read again: the acceptance, no form", (await text(page, "#dpaDone")) === `Accepté au nom du garage le ${when} par Camille Durand.` && (await page.isHidden("#dpaAsk")));
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.getElementById("dpaDlg").open);
  check("no console error", !logs.length, logs.join("\n"));
  await ctx.close();

  // ---- téléphone : la fenêtre tient dans l'écran, le texte défile dedans
  {
    await api.db.query("DELETE FROM pro_agreements");
    const m = await newPage({ width: 390, height: 844, touch: true });
    await m.page.goto(`${srv.url}/pro/`);
    await m.page.waitForSelector('[data-screen="dash"]:not([hidden])');
    await m.page.click('.dash-link[data-panel="planning"]');
    await m.page.waitForSelector("#dash-planning:not([hidden]):not([aria-busy])");
    check("phone: the banner shows", await m.page.isVisible("#planDpa"));
    await m.page.click("#planDpa [data-dpa]");
    await m.page.waitForSelector("#dpaDlg[open]");
    await m.page.waitForFunction(() => !document.getAnimations().length);
    check(
      "phone: the window fits the screen, the text scrolls inside, the button is reachable",
      await m.page.evaluate(() => {
        const d = document.getElementById("dpaDlg").getBoundingClientRect(), t = document.querySelector("#dpaDlg .dpa-text");
        return d.left >= 0 && d.right <= window.innerWidth + 1 && t.scrollHeight > t.clientHeight;
      }),
    );
    check("phone: no page-wide horizontal scroll", (await overflow(m.page)) <= 0, await overflow(m.page));
    await axe(m.page, "accord de sous-traitance · téléphone");
    await shot(m.page, "2-telephone");
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
