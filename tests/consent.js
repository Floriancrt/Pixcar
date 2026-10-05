// Mesure d'audience (Google Analytics) avec consentement préalable, dans le navigateur : rien n'est envoyé et aucun cookie n'est déposé avant
// l'accord ; l'accord charge la bibliothèque de Google (simulée ici) exactement comme l'extrait officiel le prévoit ; le refus, le retrait et
// l'expiration du choix ; le bandeau (même poids pour « Refuser » et « Accepter », clavier, lecteurs d'écran, thèmes, mobile) ; le texte de
// confidentialité de la version avec Google ; la politique de sécurité de la version publiée (GitHub Pages, sans en-têtes) qui laisse passer
// Google et rien d'autre. Les sites sont construits ici, avec une copie des sources dont src/legal.json est complet (valeurs fictives).
// Google lui-même n'est jamais joint : tests/mocks.js (option google) fournit une bibliothèque qui fait ce que fait la vraie à l'arrivée.
//   node tests/consent.js
delete process.env.PIXCAR_ROOT; // la suite construit et sert ses propres pages, quel que soit le site que les autres suites testent
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { serve, launch, open, search, ROOT, injectScript } = require("./harness");
const { buildElements } = require("./mocks");
const { serveDir } = require("./static-server");

const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond });
  if (!cond) console.log("  FAIL:", name, "|", String(detail).slice(0, 600));
};

const AXE = fs.readFileSync(path.join(__dirname, "..", "node_modules/axe-core/axe.min.js"), "utf8");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const OUT = path.join(__dirname, ".out", "consent-site");
const SRC = process.env.PIXCAR_SRC || path.join(ROOT, "src"); // les tests de mutation y mettent une copie modifiée des sources
const BUILD = process.env.PIXCAR_BUILD ? path.resolve(ROOT, process.env.PIXCAR_BUILD) : path.join(ROOT, "scripts/build.mjs"); // les tests de mutation y mettent une copie modifiée du build
const ID = "G-TEST123456";
const REAL = JSON.parse(fs.readFileSync(path.join(SRC, "analytics.json"), "utf8")); // l'identifiant et la durée du dépôt, pour la version publiée
const LEGAL = {
  editorLine: "Pixcar est édité à titre non professionnel par Jeanne Exemple, responsable du traitement des données décrites ici.",
  contact: "contact@exemple.test",
  hostPages: "GitHub, Inc. (GitHub Pages), États-Unis",
  hostApi: "Amazon Web Services EMEA SARL, Luxembourg (région Europe, Stockholm)",
  repairRetentionMonths: 24,
  updated: "3 octobre 2026",
};
const KEY = "jg.consent.v1";
const DAY = 864e5;
const GOOGLE_HOST = /(^|\.)(googletagmanager\.com|google-analytics\.com|analytics\.google\.com)$/;
const googleOf = (urls) => urls.filter((u) => { try { return GOOGLE_HOST.test(new URL(u).hostname); } catch { return false; } });

// Construit un site dans OUT/<name> : ga = identifiant (« » : aucune mesure ; undefined : ce que la construction décide seule), only = single|dist.
function site(name, { ga, legal = LEGAL, only = "single", pages, api = "" } = {}) {
  const src = path.join(OUT, name + "-src");
  fs.cpSync(SRC, src, { recursive: true });
  fs.writeFileSync(path.join(src, "legal.json"), JSON.stringify(legal));
  const env = { ...process.env, PIXCAR_API_BASE: api };
  if (ga === undefined) delete env.PIXCAR_GA_ID;
  else env.PIXCAR_GA_ID = ga;
  const args = [BUILD, "--only", only, "--src", src, "--out", path.join(OUT, name)];
  if (pages) args.push("--pages", pages);
  execFileSync(process.execPath, args, { stdio: "pipe", env });
  return path.join(OUT, name, only === "dist" ? "dist" : "");
}
const attempt = (name, { ga, legal = LEGAL, pages } = {}) => {
  const src = path.join(OUT, name + "-src");
  fs.cpSync(SRC, src, { recursive: true });
  fs.writeFileSync(path.join(src, "legal.json"), JSON.stringify(legal));
  const env = { ...process.env, PIXCAR_API_BASE: "" };
  if (ga === undefined) delete env.PIXCAR_GA_ID;
  else env.PIXCAR_GA_ID = ga;
  const args = [BUILD, "--only", "single", "--src", src, "--out", path.join(OUT, name)];
  if (pages) args.push("--pages", pages);
  return spawnSync(process.execPath, args, { encoding: "utf8", env });
};

const MOCK = () => ({ elements: buildElements(), google: true });
const snap = (page) =>
  page.evaluate((id) => {
    const b = document.getElementById("consent");
    return {
      banner: b ? !b.hidden && b.getClientRects().length > 0 : null,
      stored: localStorage.getItem("jg.consent.v1"),
      cookie: document.cookie,
      layer: window.dataLayer ? Array.from(window.dataLayer, (a) => Array.from(a)) : null,
      gtag: typeof window.gtag,
      state: document.documentElement.dataset.analytics,
      disabled: window["ga-disable-" + id],
      loaded: window.__gtagLoaded || 0,
      scripts: [...document.scripts].map((s) => s.src).filter(Boolean),
    };
  }, ID);
const choiceOf = (s) => { try { return JSON.parse(s.stored); } catch { return null; } };
const axeOf = async (page) => {
  await injectScript(page, AXE);
  return page.evaluate(async (tags) => (await axe.run(document, { runOnly: { type: "tag", values: tags } })).violations.map((x) => ({ id: x.id, n: x.nodes.length, ex: x.nodes.slice(0, 2).map((n) => n.html.slice(0, 120)) })), TAGS);
};
const norm = (t) => String(t).replace(/[  ]/g, " ").replace(/\s+/g, " ").trim();
// Attentes qui ne plantent pas la suite : une condition qui n'arrive pas fait échouer le contrôle qui suit (avec son nom), pas toute la suite.
const loaded = (page) => page.waitForFunction(() => window.__gtagLoaded === 1, null, { timeout: 4000 }).then(() => true, () => false);
const opened = (page) => page.waitForFunction(() => document.getElementById("legalDlg").open, null, { timeout: 4000 }).then(() => true, () => false);
const appears = (page, selector) => page.waitForSelector(selector, { timeout: 4000 }).then(() => true, () => false);

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // ============ M0. la construction ============
  const none = site("none", { ga: "" });
  const withGa = site("with", { ga: ID });
  const noneHtml = fs.readFileSync(path.join(none, "index.html"), "utf8");
  const gaHtml = fs.readFileSync(path.join(withGa, "index.html"), "utf8");
  check("M01 without an identifier: no banner, an empty analytics meta, no Google host or script in the page", !/id="consent"/.test(noneHtml) && /<meta name="pixcar-analytics" content="">/.test(noneHtml) && !/googletagmanager|google-analytics/.test(noneHtml.replace(/<script>[\s\S]*<\/script>/, "")), "");
  check("M02 with an identifier: the banner and the identifier are in the page, and still no Google address in the HTML (the library is added by the script, after consent)", /id="consent"/.test(gaHtml) && gaHtml.includes(`<meta name="pixcar-analytics" content="${ID}">`) && !/<script[^>]*googletagmanager/.test(gaHtml) && !/<link[^>]*googletagmanager/.test(gaHtml), "");
  const bad = attempt("bad-id", { ga: "UA-123" });
  check("M03 a malformed identifier stops the build, with a message that says why", bad.status !== 0 && /identifiant de mesure invalide/.test(bad.stderr), bad.stderr.slice(0, 300));
  const bare = attempt("bare", { ga: ID, legal: { ...LEGAL, editorLine: "", contact: "", repairRetentionMonths: "", updated: "" } });
  check("M04 no banner without the privacy window it points to: the build refuses when src/legal.json is incomplete", bare.status !== 0 && /mesure d'audience/.test(bare.stderr), bare.stderr.slice(0, 300));
  check("M05 a build for the published site (--pages) takes the identifier of src/analytics.json, one for anything else does not", (() => {
    const pub = site("pages-default", { pages: "pixcar.fr", only: "dist" });
    const html = fs.readFileSync(path.join(pub, "index.html"), "utf8");
    const dflt = fs.readFileSync(path.join(none, "index.html"), "utf8");
    const plain = site("dist-plain", { only: "dist" });
    const plainHtml = fs.readFileSync(path.join(plain, "index.html"), "utf8");
    return html.includes(`<meta name="pixcar-analytics" content="${REAL.measurementId}">`) && /id="consent"/.test(html) && /<meta name="pixcar-analytics" content="">/.test(plainHtml) && !/id="consent"/.test(plainHtml) && /<meta name="pixcar-analytics" content="">/.test(dflt);
  })());
  check("M06 PIXCAR_GA_ID empty switches the measurement off even for the published site", (() => {
    const off = site("pages-off", { pages: "pixcar.fr", only: "dist", ga: "" });
    const html = fs.readFileSync(path.join(off, "index.html"), "utf8");
    return /<meta name="pixcar-analytics" content="">/.test(html) && !/googletagmanager/.test(html);
  })());
  const policyOf = (dir) => (/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(fs.readFileSync(path.join(dir, "index.html"), "utf8")) || [])[1] || "";
  const pubDir = path.join(OUT, "pages-default", "dist");
  const offDir = path.join(OUT, "pages-off", "dist");
  const dirv = (p, d) => ((new RegExp(d + "([^;]*)").exec(p) || [])[1] || "").trim().split(/\s+/).filter(Boolean);
  const pubPolicy = policyOf(pubDir), offPolicy = policyOf(offDir);
  check("M07 the policy of the published site adds Google to script-src (the library) and connect-src (the measures), nothing to the other directives", (() => {
    const s = dirv(pubPolicy, "script-src"), c = dirv(pubPolicy, "connect-src"), s0 = dirv(offPolicy, "script-src"), c0 = dirv(offPolicy, "connect-src");
    const addedS = s.filter((x) => !s0.includes(x)), addedC = c.filter((x) => !c0.includes(x));
    const rest = (p) => p.split("; ").filter((d) => !/^(script-src|connect-src)/.test(d)).join("; ");
    return JSON.stringify(addedS) === JSON.stringify(["https://www.googletagmanager.com"]) && JSON.stringify(addedC) === JSON.stringify(["https://*.google-analytics.com", "https://analytics.google.com", "https://*.analytics.google.com", "https://*.googletagmanager.com"]) && rest(pubPolicy) === rest(offPolicy);
  })(), pubPolicy);
  check("M08 …and still no inline script, no eval, no wildcard in script-src", !/unsafe-eval/.test(pubPolicy) && !/script-src[^;]*unsafe-inline/.test(pubPolicy) && !/script-src[^;]*\*/.test(pubPolicy), pubPolicy);
  const regular = site("dist-headers", { only: "dist", ga: "" });
  const headers = fs.readFileSync(path.join(regular, "_headers"), "utf8");
  check("M09 a build without an identifier keeps Google out of the policy (headers file included)", !/google/.test(headers) && !/google/.test(offPolicy), headers.slice(0, 300));

  const dflt = await serve(withGa);
  const plain = await serve(none);
  const browser = await launch();
  try {
    // ============ A. version sans mesure d'audience : rien ne change ============
    {
      const { page, ctx, logs } = await open(browser, plain, "index.html", { width: 1440, height: 900, mock: MOCK() });
      await search(page, { service: "vidange" });
      await appears(page, ".legal-foot:not([hidden]) [data-open-legal]");
      check("M10 no analytics build: no banner, no consent link in the panel, no analytics state on the page", !(await page.$("#consent")) && !(await page.$("[data-consent-open]")) && (await page.evaluate(() => document.documentElement.dataset.analytics)) === undefined);
      await page.click(".legal-foot [data-open-legal]");
      await opened(page);
      const text = norm(await page.evaluate(() => document.getElementById("legalDlg").innerText));
      check("M11 its privacy text is the one without Google: « aucun cookie », « ni ne partage », no Google Analytics section", text.includes("Pixcar n'utilise aucun cookie") && text.includes("ne vend ni ne partage vos données") && !/Mesure d'audience|Google Analytics/.test(text), text.slice(0, 200));
      check("M12 no request to a Google measurement host, and nothing in the page's globals", googleOf(logs.requests).length === 0 && (await page.evaluate(() => [typeof window.dataLayer, typeof window.gtag].join())) === "undefined,undefined");
      check("M13 no console message, no script error", logs.console.length === 0 && logs.errors.length === 0, JSON.stringify([logs.console, logs.errors]));
      await ctx.close();
    }

    // ============ B. première visite : rien avant la réponse ============
    {
      const { page, ctx, logs } = await open(browser, dflt, "index.html", { width: 1440, height: 900, mock: MOCK() });
      let s = await snap(page);
      check("M20 first visit: the banner is shown, nothing is stored, the state is « unset »", s.banner === true && s.stored === null && s.state === "unset", JSON.stringify(s));
      check("M21 before any answer: no cookie, no data layer, no gtag, no Google script in the page", s.cookie === "" && s.layer === null && s.gtag === "undefined" && s.scripts.every((u) => !/google/.test(u)) && s.loaded === 0, JSON.stringify(s));
      check("M22 before any answer: not one request to Google (the browser's own list of requests, including the blocked ones)", googleOf(logs.requests).length === 0 && ctx.__counters.google.length === 0 && ctx.__counters.other.every((u) => !/google/.test(u)), JSON.stringify([googleOf(logs.requests), ctx.__counters.google]));
      const geo = await page.evaluate(() => {
        const [no, yes] = ["deny", "grant"].map((k) => document.querySelector(`#consent [data-consent=${k}]`));
        const st = (b) => { const c = getComputedStyle(b), r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), font: c.fontSize + c.fontWeight + c.fontFamily, bg: c.backgroundColor, border: c.borderTopColor + c.borderTopWidth, color: c.color, shadow: c.boxShadow, text: b.textContent.trim() }; };
        return { no: st(no), yes: st(yes), focused: !!document.activeElement.closest && !!document.activeElement.closest("#consent") };
      });
      check("M23 « Refuser » and « Accepter » carry the same weight: same size, same type, same colours, same border (the choice must not be steered)", JSON.stringify({ ...geo.no, text: 0 }) === JSON.stringify({ ...geo.yes, text: 0 }) && geo.no.text === "Refuser" && geo.yes.text === "Accepter", JSON.stringify(geo));
      check("M24 the banner does not grab the focus on arrival", geo.focused === false);
      await page.keyboard.press("Tab");
      check("M25 the keyboard reaches the banner first (« Refuser » is the first stop)", (await page.evaluate(() => document.activeElement.dataset.consent)) === "deny");
      const lay = await page.evaluate(() => { const b = document.getElementById("consent").getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: innerWidth, h: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth }; });
      check("M26 desktop: the banner is fully on screen, bottom right, and the page does not overflow", lay.l >= 0 && lay.r <= lay.w && lay.t >= 0 && lay.b <= lay.h && lay.l > lay.w / 2 && !lay.overflow, JSON.stringify(lay));
      // aller sur la page, chercher, ouvrir une fiche, ouvrir le formulaire : ce n'est pas un consentement
      await search(page, { service: "vidange" });
      await page.click("#list > li:nth-child(1) .g-main");
      await page.waitForTimeout(300);
      await page.click("#addRepairBtn");
      await page.waitForSelector("#repairDlg[open]");
      await page.keyboard.press("Escape");
      s = await snap(page);
      check("M27 searching, opening a card and the declaration form is not an answer: the banner stays, nothing is stored, nothing is sent", s.banner === true && s.stored === null && s.state === "unset" && s.cookie === "" && googleOf(logs.requests).length === 0 && s.layer === null, JSON.stringify(s));
      await ctx.close();
    }

    // ============ C. Échap, « En savoir plus » ============
    {
      // fenêtre basse : en mode local le texte avant la section est court, elle serait visible sans défilement et ce contrôle ne prouverait rien
      const { page, ctx, logs } = await open(browser, dflt, "index.html", { width: 1440, height: 420, mock: MOCK() });
      await page.keyboard.press("Tab");
      await page.keyboard.press("Escape");
      let s = await snap(page);
      check("M30 Escape closes the banner without an answer: nothing stored, nothing sent", s.banner === false && s.stored === null && s.state === "unset" && googleOf(logs.requests).length === 0, JSON.stringify(s));
      await page.reload();
      await page.waitForLoadState("load");
      s = await snap(page);
      check("M31 …and the banner is back on the next visit", s.banner === true, JSON.stringify(s));
      await page.click("[data-consent-more]");
      await opened(page);
      await page.waitForTimeout(250);
      const pos = await page.evaluate(() => { const d = document.getElementById("legalDlg").getBoundingClientRect(), h = document.getElementById("lg-audience").getBoundingClientRect(); return { dTop: d.top, dBottom: d.bottom, hTop: h.top, hBottom: h.bottom }; });
      check("M32 « En savoir plus » opens the privacy window at the « Mesure d'audience » section (its heading is on screen)", pos.hTop >= pos.dTop - 1 && pos.hBottom <= pos.dBottom, JSON.stringify(pos));
      check("M33 the window shows « Votre choix : pas encore fait », both buttons unpressed", (await page.evaluate(() => document.querySelector("#legalDlg [data-consent-label]").textContent)) === "pas encore fait" && (await page.$$eval("#legalDlg .legal-choice [aria-pressed]", (l) => l.map((b) => b.getAttribute("aria-pressed")).join())) === "false,false");
      await ctx.close();
    }

    // ============ D. accepter ============
    {
      const { page, ctx, logs } = await open(browser, dflt, "index.html", { width: 1440, height: 900, mock: MOCK() });
      await page.click('#consent [data-consent="grant"]');
      await loaded(page);
      await page.waitForTimeout(200);
      const s = await snap(page);
      const c = choiceOf(s);
      check("M40 « Accepter »: the banner closes, the choice is kept with its date, the state is « granted »", s.banner === false && c && c.analytics === true && Math.abs(c.at - Date.now()) < 60e3 && s.state === "granted", JSON.stringify(s));
      const libs = ctx.__counters.google.filter((u) => u.startsWith("https://www.googletagmanager.com/gtag/js"));
      check("M41 the library of Google is requested once, from googletagmanager.com, for this identifier only, as an asynchronous script", libs.length === 1 && libs[0] === `https://www.googletagmanager.com/gtag/js?id=${ID}` && s.scripts.filter((u) => /googletagmanager/.test(u)).length === 1 && (await page.evaluate(() => [...document.scripts].find((e) => /googletagmanager/.test(e.src)).async === true)), JSON.stringify(libs));
      const L = s.layer || [];
      check("M42 the data layer starts with Google's own snippet (js, config) preceded by the consent defaults: analytics allowed, advertising refused", L.length === 3 && L[0][0] === "consent" && L[0][1] === "default" && L[0][2].analytics_storage === "granted" && L[0][2].ad_storage === "denied" && L[0][2].ad_user_data === "denied" && L[0][2].ad_personalization === "denied" && L[1][0] === "js" && L[2][0] === "config" && L[2][1] === ID, JSON.stringify(L));
      check("M43 the configuration limits what Google may do: cookies kept 13 months, Google signals and ad personalisation off", L[2] && L[2][2].cookie_expires === 34128000 && L[2][2].allow_google_signals === false && L[2][2].allow_ad_personalization_signals === false, JSON.stringify(L[2]));
      check("M44 gtag is Google's function (it pushes the arguments object, not an array: what gtag.js reads)", await page.evaluate(() => Object.prototype.toString.call(window.dataLayer[0]) === "[object Arguments]" && window.gtag.toString().includes("arguments")));
      check("M45 the cookies appear only now (the stub library sets them like the real one), and the measures leave to the hosts the policy knows", /_ga=/.test(s.cookie) && /_ga_TEST123456=/.test(s.cookie) && ctx.__counters.google.some((u) => /region1\.google-analytics\.com/.test(u)) && ctx.__counters.google.some((u) => /^https:\/\/www\.google-analytics\.com/.test(u)) && ctx.__counters.google.some((u) => /^https:\/\/analytics\.google\.com/.test(u)));
      check("M46 nothing else leaves: no other Google host, no other host at all because of this", googleOf(logs.requests).every((u) => /^https:\/\/(www\.googletagmanager\.com\/gtag\/js|region1\.google-analytics\.com|www\.google-analytics\.com|analytics\.google\.com)/.test(u)) && s.disabled === false, JSON.stringify(googleOf(logs.requests)));
      await appears(page, ".legal-foot:not([hidden]) [data-open-legal]");
      await page.click(".legal-foot [data-open-legal]");
      await opened(page);
      const shown = await page.evaluate(() => document.querySelector("#legalDlg [data-consent-label]").textContent + "|" + [...document.querySelectorAll("#legalDlg .legal-choice [data-consent]")].map((b) => b.dataset.consent + "=" + b.getAttribute("aria-pressed")).join());
      check("M47 the legal window follows: « Votre choix : accepté », « Accepter » pressed", shown === "accepté|deny=false,grant=true", shown);
      await page.keyboard.press("Escape");
      // la page suivante : le choix est retenu, le bandeau ne revient pas, la bibliothèque est rechargée (une fois)
      await page.reload();
      await loaded(page);
      const again = await snap(page);
      check("M48 next visit: no banner, the library is loaded again (once), the choice is still there", again.banner === false && again.state === "granted" && again.loaded === 1 && choiceOf(again).analytics === true, JSON.stringify(again));
      check("M49 no console message, no script error, no security-policy report during the whole accept flow", logs.console.length === 0 && logs.errors.length === 0, JSON.stringify([logs.console, logs.errors]));
      await ctx.close();
    }

    // ============ E. refuser ============
    {
      const { page, ctx, logs } = await open(browser, dflt, "index.html", { width: 1440, height: 900, mock: MOCK() });
      await page.click('#consent [data-consent="deny"]');
      await page.waitForTimeout(300);
      let s = await snap(page);
      const c = choiceOf(s);
      check("M50 « Refuser »: the banner closes, the refusal is kept with its date, the state is « denied »", s.banner === false && c && c.analytics === false && Math.abs(c.at - Date.now()) < 60e3 && s.state === "denied", JSON.stringify(s));
      check("M51 …and nothing was loaded or stored: no cookie, no data layer, no request to Google", s.cookie === "" && s.layer === null && s.loaded === 0 && googleOf(logs.requests).length === 0, JSON.stringify(s));
      await search(page, { service: "vidange" });
      await page.reload();
      await page.waitForLoadState("load");
      await page.waitForTimeout(300);
      s = await snap(page);
      check("M52 next visit: no banner (the refusal is respected), still nothing sent", s.banner === false && s.state === "denied" && googleOf(logs.requests).length === 0 && s.cookie === "", JSON.stringify(s));
      await ctx.close();
    }

    // ============ F. changer d'avis ============
    {
      // accepté, puis retiré depuis la fenêtre de confidentialité
      const { page, ctx } = await open(browser, dflt, "index.html", { width: 1440, height: 900, mock: MOCK() });
      await page.click('#consent [data-consent="grant"]');
      await loaded(page);
      await appears(page, ".legal-foot:not([hidden]) [data-open-legal]");
      await page.click(".legal-foot [data-open-legal]");
      await opened(page);
      await page.click('#legalDlg .legal-choice [data-consent="deny"]');
      await page.waitForTimeout(250);
      const s = await snap(page);
      check("M60 withdrawal (« Refuser » in the privacy window): the cookies of Google are deleted", !/_ga/.test(s.cookie), s.cookie);
      check("M61 …the measurement is switched off the official way (ga-disable-<id>) and Google is told (consent update: analytics denied)", s.disabled === true && JSON.stringify(s.layer[s.layer.length - 1]) === JSON.stringify(["consent", "update", { analytics_storage: "denied" }]), JSON.stringify([s.disabled, s.layer]));
      check("M62 …the refusal is kept, the window follows (« refusé », « Refuser » pressed), the banner stays closed", choiceOf(s).analytics === false && s.banner === false && (await page.evaluate(() => document.querySelector("#legalDlg [data-consent-label]").textContent + "|" + [...document.querySelectorAll("#legalDlg .legal-choice [data-consent]")].map((b) => b.dataset.consent + "=" + b.getAttribute("aria-pressed")).join())) === "refusé|deny=true,grant=false");
      await page.click('#legalDlg .legal-choice [data-consent="grant"]');
      await page.waitForTimeout(250);
      const back = await snap(page);
      const tail = back.layer.slice(-2).map((x) => JSON.stringify(x));
      check("M63 changing one's mind again in the same page switches the measurement back on without loading the library twice", back.disabled === false && back.loaded === 1 && ctx.__counters.google.filter((u) => /gtag\/js/.test(u)).length === 1 && tail[0] === JSON.stringify(["consent", "update", { analytics_storage: "granted" }]) && tail[1].startsWith('["config","' + ID), JSON.stringify(back.layer));
      await page.click('#legalDlg .legal-choice [data-consent="deny"]');
      await page.keyboard.press("Escape");
      await page.reload();
      await page.waitForLoadState("load");
      await page.waitForTimeout(300);
      const after = await snap(page);
      check("M64 after a withdrawal, the next visit loads nothing and sets no cookie", after.loaded === 0 && after.layer === null && !/_ga/.test(after.cookie) && after.banner === false, JSON.stringify(after));
      await ctx.close();
    }
    {
      // rouvrir le choix depuis le bas du panneau, au clavier
      const { page, ctx } = await open(browser, dflt, "index.html", { width: 1440, height: 900, mock: MOCK(), storage: { [KEY]: { analytics: false, at: Date.now() - 2 * DAY } } });
      await appears(page, ".legal-foot:not([hidden]) [data-consent-open]");
      check("M70 the choice is reachable from the bottom of the panel (link « Mesure d'audience »), and the banner is closed once a choice is kept", (await page.evaluate(() => document.getElementById("consent").hidden)) === true && (await page.textContent(".legal-foot [data-consent-open]", { timeout: 1500 }).catch(() => null)) === "Mesure d'audience");
      await page.focus(".legal-foot [data-consent-open]");
      await page.keyboard.press("Enter");
      let on = await page.evaluate(() => ({ shown: !document.getElementById("consent").hidden, focus: document.activeElement.dataset.consent }));
      check("M71 the link reopens the banner and moves the focus to its first button", on.shown === true && on.focus === "deny", JSON.stringify(on));
      await page.keyboard.press("Escape");
      on = await page.evaluate(() => ({ shown: !document.getElementById("consent").hidden, focus: document.activeElement.hasAttribute("data-consent-open") }));
      check("M72 Escape closes it again, without touching the choice, and gives the focus back to the link", on.shown === false && on.focus === true && choiceOf(await snap(page)).analytics === false, JSON.stringify(on));
      await page.keyboard.press("Enter");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter"); // « Accepter » (second bouton)
      await loaded(page);
      const done = await snap(page);
      check("M73 accepting from the reopened banner works with the keyboard alone, and the focus returns to the link", done.banner === false && choiceOf(done).analytics === true && (await page.evaluate(() => document.activeElement.hasAttribute("data-consent-open"))), JSON.stringify(done));
      await ctx.close();
    }

    // ============ G. durée de validité du choix ============
    {
      const run = async (stored, label) => {
        const { page, ctx, logs } = await open(browser, dflt, "index.html", { width: 1280, height: 800, mock: MOCK(), storage: stored === undefined ? null : { [KEY]: stored } });
        await page.waitForTimeout(250);
        const s = await snap(page);
        const out = { banner: s.banner, loaded: s.loaded, requests: googleOf(logs.requests).length };
        await ctx.close();
        return out;
      };
      const old = await run({ analytics: true, at: Date.now() - 190 * DAY });
      check("M80 an acceptance older than six months is not valid: the banner is back and nothing is loaded", old.banner === true && old.loaded === 0 && old.requests === 0, JSON.stringify(old));
      const oldNo = await run({ analytics: false, at: Date.now() - 190 * DAY });
      check("M81 a refusal older than six months is asked again too", oldNo.banner === true, JSON.stringify(oldNo));
      const young = await run({ analytics: true, at: Date.now() - 170 * DAY });
      check("M82 an acceptance of five months and three weeks is still valid: the library loads, no banner", young.banner === false && young.loaded === 1, JSON.stringify(young));
      const future = await run({ analytics: true, at: Date.now() + 30 * DAY });
      check("M83 a choice dated in the future (clock error, tampering) is not trusted", future.banner === true && future.loaded === 0, JSON.stringify(future));
      const junk = await run("granted");
      const junk2 = await run({ analytics: "yes", at: Date.now() });
      const junk3 = await run({ analytics: true });
      check("M84 an unreadable or incomplete choice is ignored: the banner is shown, nothing is loaded", [junk, junk2, junk3].every((r) => r.banner === true && r.loaded === 0 && r.requests === 0), JSON.stringify([junk, junk2, junk3]));
    }

    // ============ H. le texte de confidentialité de la version avec Google ============
    {
      const { page, ctx } = await open(browser, dflt, "index.html", { width: 1440, height: 900, mock: MOCK() });
      await appears(page, ".legal-foot:not([hidden]) [data-open-legal]");
      await page.click(".legal-foot [data-open-legal]");
      await opened(page);
      const text = norm(await page.evaluate(() => document.getElementById("legalDlg").innerText));
      check("M90 the privacy text describes the measurement: Google Ireland Limited and Google LLC, consent, cookies _ga and _ga_<stream>, 13 months, retention from src/analytics.json, six months for the choice, withdrawal", ["Mesure d'audience (Google Analytics)", "Google Ireland Limited", "Google LLC", "seulement si vous l'acceptez", "_ga_TEST123456", "13 mois au plus", `${REAL.retentionMonths} mois au plus`, "gardé six mois", "votre consentement", "retirer à tout moment", "l'identifiant de votre cookie _ga"].every((w) => text.includes(w)), text.slice(0, 120));
      check("M91 …and it no longer promises what is no longer true: no « aucun cookie » (except « ne dépose lui-même aucun cookie »), no « ni cookie », no « ne partage »", !/Pixcar n'utilise aucun cookie/.test(text) && !/ni cookie/.test(text) && !/ni ne partage/.test(text) && text.includes("Pixcar ne dépose lui-même aucun cookie") && text.includes("Pixcar ne vend pas vos données"), text.slice(0, 100));
      check("M92 Google Analytics is in the list of services the browser contacts, only if the visitor accepts; « Avis Google » is still there", /Google \(Google Analytics\), seulement si vous acceptez la mesure d'audience/.test(text) && /Google, seulement si vous touchez « Avis Google »/.test(text));
      check("M93 the choice is kept in the browser and says so (« votre choix sur la mesure d'audience »)", /dont votre choix sur la mesure d'audience/.test(text));
      check("M94 the update date of the notice is the one of src/legal.json, and the contact is there (rights, withdrawal)", text.includes("Dernière mise à jour : 3 octobre 2026") && text.includes("contact@exemple.test"));
      const html = await page.evaluate(() => document.getElementById("legalDlg").innerHTML);
      check("M95 no template marker left in the window (GA markers, {{ga.*}}, {{legal.*}})", !/GA:(on|off)|\{\{/.test(html), html.match(/GA:(on|off)|\{\{[^}]*\}\}/g)?.join());
      check("M96 local mode with Google: « Pixcar ne reçoit aucune donnée vous concernant (hors mesure d'audience, si vous l'acceptez) »", /Pixcar ne reçoit aucune donnée vous concernant \(hors mesure d'audience, si vous l'acceptez\)/.test(text), text.slice(0, 100));
      await ctx.close();
      const remote = await open(browser, dflt, "index.html", { width: 1440, height: 900, mock: MOCK(), initScript: 'window.JG_TUNE.api="http://127.0.0.1:9";' }); // mode API : l'adresse ne répond pas, rien d'autre n'est testé ici
      await appears(remote.page, ".legal-foot:not([hidden]) [data-open-legal]");
      await remote.page.click(".legal-foot [data-open-legal]");
      await opened(remote.page);
      const rtext = norm(await remote.page.evaluate(() => document.getElementById("legalDlg").innerText));
      check("M97 API mode with Google (what is published): the declaration section keeps its list (« ni nom, ni adresse électronique, ni compte. », no « ni cookie »), the API hosting is there, and so is the audience section", (await remote.page.evaluate(() => document.body.dataset.store)) === "remote" && rtext.includes("Rien d'autre : ni nom, ni adresse électronique, ni compte.") && !/ni cookie/.test(rtext) && /API et base de données/.test(rtext) && rtext.includes("Mesure d'audience (Google Analytics)") && !/rien n'est envoyé à Pixcar/.test(rtext), rtext.slice(0, 160));
      await remote.ctx.close();
    }

    // ============ I. accessibilité, thèmes, mobile ============
    {
      for (const [label, o] of [["desktop light", { width: 1440, height: 900 }], ["desktop dark", { width: 1440, height: 900, colorScheme: "dark" }], ["mobile light", { width: 390, height: 844, dpr: 2, touch: true }], ["mobile dark", { width: 390, height: 844, dpr: 2, touch: true, colorScheme: "dark" }]]) {
        const { page, ctx } = await open(browser, dflt, "index.html", { ...o, mock: MOCK() });
        await search(page, { service: "vidange" });
        const viol = await axeOf(page);
        check(`M100 ${label}: no accessibility violation (axe) with the banner shown`, viol.length === 0, JSON.stringify(viol));
        const geo = await page.evaluate(() => {
          const b = document.getElementById("consent").getBoundingClientRect(), t = document.getElementById("tabs").getBoundingClientRect();
          const text = document.querySelector("#consent p"), c = getComputedStyle(text);
          return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: innerWidth, h: innerHeight, tabsTop: t.top, tabsVisible: t.height > 0 && t.top > innerHeight / 2, overflow: document.documentElement.scrollWidth > innerWidth, clipped: text.scrollHeight > text.clientHeight + 1, font: parseFloat(c.fontSize) };
        });
        const fits = geo.l >= 0 && geo.r <= geo.w && geo.t >= 0 && geo.b <= geo.h && !geo.overflow && !geo.clipped && geo.font >= 13;
        check(`M101 ${label}: the banner is entirely on screen, its text is not clipped and is at least 13 px` + (geo.tabsVisible ? ", and it stays above the bottom navigation" : ""), fits && (!geo.tabsVisible || geo.b <= geo.tabsTop), JSON.stringify(geo));
        await ctx.close();
      }
      const { page, ctx } = await open(browser, dflt, "index.html", { width: 1440, height: 900, mock: MOCK() });
      check("M102 the banner is a labelled region (landmark) named « Mesure d'audience »", await page.evaluate(() => { const s = document.getElementById("consent"); return s.tagName === "SECTION" && document.getElementById(s.getAttribute("aria-labelledby")).textContent === "Mesure d'audience"; }));
      await appears(page, ".legal-foot:not([hidden]) [data-open-legal]");
      await page.click("[data-consent-more]");
      await opened(page);
      const viol = await axeOf(page);
      check("M103 the privacy window with the audience section: no accessibility violation", viol.length === 0, JSON.stringify(viol));
      await ctx.close();
    }
  } finally {
    await browser.close();
    plain.close();
    dflt.close();
  }

  // ============ P. la version publiée (GitHub Pages : politique en <meta>, aucun en-tête) ============
  {
    const published = await serveDir(pubDir);
    const browser2 = await launch();
    try {
      const watch = "window.__csp=[];document.addEventListener('securitypolicyviolation',function(e){window.__csp.push(e.violatedDirective+' '+e.blockedURI)});";
      const { page, ctx, logs } = await open(browser2, published, "index.html", { width: 1440, height: 900, mock: MOCK(), initScript: watch });
      await search(page, { service: "vidange" });
      let csp = await page.evaluate(() => window.__csp.slice());
      check("M110 published site, first visit: the banner is shown, nothing was asked of Google, the policy reports nothing", (await page.evaluate(() => !document.getElementById("consent").hidden)) && googleOf(logs.requests).length === 0 && csp.length === 0, JSON.stringify(csp));
      check("M111 it carries the identifier of src/analytics.json", (await page.evaluate(() => document.querySelector('meta[name="pixcar-analytics"]').content)) === REAL.measurementId);
      await page.click('#consent [data-consent="grant"]');
      await loaded(page);
      await page.waitForTimeout(400); // les mesures partent à l'arrivée de la bibliothèque : on laisse arriver les rapports de violation
      csp = await page.evaluate(() => window.__csp.slice());
      const urls = ctx.__counters.google;
      check("M112 under the real policy (a <meta>, no header), accepting loads the library AND lets its measures through: script, fetch, beacon and image to the three kinds of host, not one violation", urls.some((u) => /googletagmanager\.com\/gtag\/js/.test(u)) && urls.some((u) => /region1\.google-analytics\.com/.test(u)) && urls.some((u) => /^https:\/\/www\.google-analytics\.com.*img=1/.test(u)) && urls.some((u) => /^https:\/\/analytics\.google\.com/.test(u)) && csp.length === 0, JSON.stringify({ urls, csp }));
      const probe = await page.evaluate(async () => {
        const ok = (src) => new Promise((r) => { const s = document.createElement("script"); s.src = src; s.onload = () => r("ran"); s.onerror = () => r("blocked"); document.head.appendChild(s); });
        const first = await ok("https://www.google-analytics.com/analytics.js"); // un hôte de mesure n'est pas un hôte de scripts
        const second = await ok("https://stats.g.doubleclick.net/g/collect.js");
        const inline = document.createElement("script");
        inline.textContent = "window.__ranInline = true";
        document.head.appendChild(inline);
        await new Promise((r) => setTimeout(r, 200));
        return { first, second, inline: window.__ranInline === true, violations: window.__csp.slice() };
      });
      check("M113 the policy stays narrow: only googletagmanager.com may serve scripts (google-analytics.com, doubleclick.net and inline scripts are refused)", probe.first === "blocked" && probe.second === "blocked" && probe.inline === false && probe.violations.filter((v) => /^script-src/.test(v)).length >= 3, JSON.stringify(probe));
      check("M114 no script error on the published site through the whole flow", logs.errors.length === 0, JSON.stringify(logs.errors));
      await ctx.close();
    } finally {
      await browser2.close();
      published.close();
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[consent] ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("FAILED:\n" + failed.map((f) => "  - " + f.name).join("\n"));
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
