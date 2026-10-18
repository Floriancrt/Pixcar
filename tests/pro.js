// Espace Pro (dist/pro/) de bout en bout : page construite pour de bon, servie avec ses en-têtes (_headers), vraie API (PGlite) avec l'Espace Pro
// ouvert, registre des entreprises simulé, Amazon Cognito simulé par cette suite (inscription et connexion sans mot de passe, code par e-mail).
// Parcours : inscription → code → rattachement d'un garage (SIRET, « Qui êtes-vous ? », choix du moyen, code) → tableau de bord ; déconnexion,
// reconnexion, session expirée ; accessibilité (axe) de chaque écran ; politique de sécurité (en-têtes et balise <meta> de la version publiée).
//   node tests/pro.js
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
const OUT = path.join(__dirname, ".out", "pro-site");
const SHOTS = path.join(__dirname, ".out", "shots");
const SRC = process.env.PIXCAR_SRC || path.join(ROOT, "src");
const BUILD = process.env.PIXCAR_BUILD ? path.resolve(ROOT, process.env.PIXCAR_BUILD) : path.join(ROOT, "scripts/build.mjs");
const POOL = "eu-north-1_PixcarTest1";
const CLIENT = "4pro0test1client2id3";
const COGNITO = "https://cognito-idp.eu-north-1.amazonaws.com/";
const LEGAL = { editorLine: "Pixcar est édité à titre non professionnel par Jeanne Exemple, responsable du traitement des données décrites ici.", contact: "contact@exemple.test", hostPages: "GitHub, Inc. (GitHub Pages), États-Unis", hostApi: "Amazon Web Services EMEA SARL, Luxembourg (région Europe, Stockholm)", repairRetentionMonths: 24, updated: "3 octobre 2026" };

// ---- données : un garage avec e-mail public, site propre et portable ; un voisin déjà rattaché ; un établissement au registre
const HERE = { lat: 43.2174, lon: 1.1014 };
const north = (m) => ({ lat: HERE.lat + m / 111320, lon: HERE.lon });
const CONTACTS = [
  { id: "aaaaaaaa-0000-4000-8000-000000000001", name: "Garage Démo Centre", addr: "12 rue de l'Exemple, 31220 Cazères", pc: "31220", ...HERE, emails: ["contact@garage-demo.fr"], phones: ["+33561000001", "+33612345678"], web: "https://www.garage-demo.fr/" },
  { id: "aaaaaaaa-0000-4000-8000-000000000002", name: "Centre Auto Démo", addr: "3 avenue Fictive, 31220 Cazères", pc: "31220", ...north(120), emails: ["atelier@centre-auto-demo.fr"] },
];
function siretOf(prefix13) {
  for (let k = 0; k <= 9; k++) {
    const s = prefix13 + k;
    let sum = 0;
    for (let i = 0; i < 14; i++) {
      let d = Number(s[13 - i]);
      if (i % 2 === 1) (d *= 2) > 9 && (d -= 9);
      sum += d;
    }
    if (sum % 10 === 0) return s;
  }
}
const SIRET = siretOf("9876543210001");
const REGISTRY = { [SIRET]: { siret: SIRET, name: "GARAGE DEMO CENTRE", company: "DEMO SARL", addr: "12 RUE DE L'EXEMPLE 31220 CAZERES", naf: "45.20A", active: true, pc: "31220", ...north(30) } };

// ---- Amazon Cognito simulé (API JSON « AWSCognitoIdentityProviderService.* »)
function fakeCognito() {
  const users = new Map(); // e-mail → { sub, confirmed }
  const sessions = new Map(); // session → { email, code }
  const mail = []; // codes « envoyés » : { email, code, kind }
  const calls = [];
  let n = 0;
  const err = (type, message) => ({ status: 400, body: { __type: type, message } });
  const tokens = (email) => ({ AuthenticationResult: { AccessToken: `tok.${users.get(email).sub}.${++n}`, IdToken: "id." + n, RefreshToken: "ref." + users.get(email).sub, ExpiresIn: 3600, TokenType: "Bearer" } });
  // comme le vrai Cognito (constaté le 12 octobre 2026) : code d'inscription à 6 chiffres, code de connexion (EMAIL_OTP) à 8 chiffres
  const code = () => String(100000 + ((n++ * 7919) % 900000));
  const signinCode = () => String(10000000 + ((n++ * 7919) % 90000000));
  function handle(action, b) {
    calls.push(action);
    if (b.ClientId !== CLIENT) return err("ResourceNotFoundException", "client inconnu");
    const email = String((b.AuthParameters && b.AuthParameters.USERNAME) || b.Username || (b.ChallengeResponses && b.ChallengeResponses.USERNAME) || "").toLowerCase();
    switch (action) {
      case "SignUp": {
        if (b.Password) return err("InvalidParameterException", "pas de mot de passe attendu");
        if (users.has(email)) return err("UsernameExistsException", "User already exists");
        users.set(email, { sub: "sub-" + users.size + 1, confirmed: false, code: code() });
        mail.push({ email, code: users.get(email).code, kind: "signup" });
        return { status: 200, body: { UserConfirmed: false, UserSub: users.get(email).sub } };
      }
      case "ConfirmSignUp": {
        const u = users.get(email);
        if (!u || b.ConfirmationCode !== u.code) return err("CodeMismatchException", "Invalid code");
        u.confirmed = true;
        const s = "confirm-" + ++n;
        sessions.set(s, { email, confirmed: true });
        return { status: 200, body: { Session: s } };
      }
      case "InitiateAuth": {
        if (b.AuthFlow === "REFRESH_TOKEN_AUTH") {
          const u = [...users.entries()].find(([, v]) => "ref." + v.sub === b.AuthParameters.REFRESH_TOKEN);
          return u ? { status: 200, body: { AuthenticationResult: { AccessToken: `tok.${u[1].sub}.${++n}`, ExpiresIn: 3600 } } } : err("NotAuthorizedException", "Invalid Refresh Token");
        }
        if (b.AuthFlow !== "USER_AUTH") return err("InvalidParameterException", "flow");
        if (b.Session) {
          const s = sessions.get(b.Session);
          return s && s.confirmed && s.email === email ? { status: 200, body: tokens(email) } : err("NotAuthorizedException", "Invalid session");
        }
        const u = users.get(email);
        if (!u || !u.confirmed) return err("UserNotFoundException", "User does not exist.");
        if (b.AuthParameters.PREFERRED_CHALLENGE !== "EMAIL_OTP") return err("InvalidParameterException", "challenge");
        const s = "otp-" + ++n;
        sessions.set(s, { email, code: signinCode() });
        mail.push({ email, code: sessions.get(s).code, kind: "signin" });
        return { status: 200, body: { ChallengeName: "EMAIL_OTP", Session: s, ChallengeParameters: { CODE_DELIVERY_DESTINATION: "c***@g***" } } };
      }
      case "RespondToAuthChallenge": {
        const s = sessions.get(b.Session);
        if (!s || b.ChallengeName !== "EMAIL_OTP") return err("NotAuthorizedException", "Invalid session");
        if (b.ChallengeResponses.EMAIL_OTP_CODE !== s.code) return err("CodeMismatchException", "Invalid code");
        sessions.delete(b.Session);
        return { status: 200, body: tokens(email) };
      }
      case "RevokeToken":
        return { status: 200, body: {} };
      default:
        return err("InvalidAction", action);
    }
  }
  return { users, mail, calls, handle, last: (email) => [...mail].reverse().find((m) => m.email === email).code };
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, "empty"), { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const srv = await serveDir(path.join(OUT, "empty"));
  const { AuthError } = await import("../server/lib/jwt.mjs");
  const { parseContactRows } = await import("../server/lib/contact.mjs");
  const api = await startApi({
    origin: srv.url,
    env: { PRO_ENABLED: "1" },
    proOptions: {
      verifier: async (token) => {
        const m = /^tok\.(sub-[\w-]+)\.\d+$/.exec(token);
        if (!m) throw new AuthError("jeton refusé");
        return { sub: m[1] };
      },
      sirene: async (siret) => REGISTRY[siret] || null,
    },
  });
  await api.app.pro.repo.upsertContacts(parseContactRows(CONTACTS).rows, "test");
  // le voisin est déjà géré par un autre compte
  await api.db.query("INSERT INTO pro_claims (id, account_id, garage_id, siret, status, channel, holder_name, holder_role, target_hash, target_hint, verified_at) VALUES (gen_random_uuid(), 'someone-else', $1, $2, 'verified', 'email', 'Autre Personne', 'manager', $3, 'a•••••@centre-auto-demo.fr', now())", [CONTACTS[1].id, SIRET, "b".repeat(64)]);

  // ---- construction : sources copiées avec des mentions légales complètes (valeurs fictives)
  const src = path.join(OUT, "src");
  fs.cpSync(SRC, src, { recursive: true });
  fs.writeFileSync(path.join(src, "legal.json"), JSON.stringify(LEGAL));
  const env = { ...process.env, PIXCAR_API_BASE: api.url, PIXCAR_PRO_POOL: POOL, PIXCAR_PRO_CLIENT: CLIENT, PIXCAR_GA_ID: "", PIXCAR_CS_ID: "", PIXCAR_MAPBOX_TOKEN: "" };
  const build = (name, extra = [], e = env) => execFileSync(process.execPath, [BUILD, "--only", "dist", "--src", src, "--out", path.join(OUT, name), ...extra], { stdio: "pipe", env: e });
  build("site");
  const dist = path.join(OUT, "site", "dist");
  srv.setRoot(dist);

  // sans identifiants Cognito, ou sans API : pas de page pro (et une configuration incohérente arrête le build)
  build("plain", [], { ...env, PIXCAR_PRO_POOL: "", PIXCAR_PRO_CLIENT: "" });
  check("without Cognito settings the site has no pro/ page and no trace of Cognito", !fs.existsSync(path.join(OUT, "plain/dist/pro")) && !/cognito/.test(fs.readFileSync(path.join(OUT, "plain/dist/_headers"), "utf8")));
  // texte de confidentialité : la section « Espace Pro » n'existe que dans le site qui a la page pro/, jamais dans la page tout-en-un
  const legalPro = (file) => /id="lg-pro"/.test(fs.readFileSync(file, "utf8"));
  execFileSync(process.execPath, [BUILD, "--only", "single", "--src", src, "--out", path.join(OUT, "single")], { stdio: "pipe", env });
  check("privacy text: an « Espace Pro » section in the site that has the pro page, none without it, none in the all-in-one page", legalPro(path.join(dist, "index.html")) && !legalPro(path.join(OUT, "plain/dist/index.html")) && !legalPro(path.join(OUT, "single/index.html")));
  const proText = (/<section aria-labelledby="lg-pro"[\s\S]*?<\/section>/.exec(fs.readFileSync(path.join(dist, "index.html"), "utf8")) || [""])[0].replace(/<[^>]+>/g, " ").replace(/&nbsp;|\s+/g, " ");
  check("privacy text: announced prices, the visit counting (daily keyed IP fingerprint, no IP kept, totals only) and its 60-day retention", /Les prix annoncés/.test(proText) && /empreinte de son adresse IP liée au garage et au jour/.test(proText) && /l'adresse IP n'est pas enregistrée/.test(proText) && /que des totaux/.test(proText) && /les empreintes des visites, 60 jours/.test(proText), proText.slice(0, 300));
  check("privacy text: the garage's fiche (declared details published, average times never shown, change requests reviewed) and its retention", /La fiche du garage/.test(proText) && /temps moyen, qui n'est pas publié/.test(proText) && /relues par Pixcar avant publication/.test(proText) && /la fiche du garage, tant que le garage est rattaché au compte/.test(proText) && /relue ou annulée, 90 jours/.test(proText), proText.slice(0, 300));
  check("privacy text: the change requests are e-mailed to Pixcar for review, without the requester's name or e-mail", /transmises à Pixcar par le même service, pour relecture/.test(proText) && /ni le nom ni l'adresse e-mail du demandeur/.test(proText), proText.slice(0, 300));
  let refused = "";
  try {
    build("noapi", [], { ...env, PIXCAR_API_BASE: "" });
  } catch (e) {
    refused = String(e.stderr || e.message);
  }
  check("a pro page without the API is refused at build time", /Espace Pro : la page pro\/ a besoin de l'API/.test(refused), refused);
  try {
    build("badpool", [], { ...env, PIXCAR_PRO_POOL: "pool" });
    refused = "";
  } catch (e) {
    refused = String(e.stderr || e.message);
  }
  check("a malformed user pool id is refused at build time", /groupe d'utilisateurs Cognito invalide/.test(refused), refused);
  // version publiée (GitHub Pages) : la page pro porte sa propre politique, étroite
  build("pages", ["--pages", "pixcar.example"]);
  const pagesHtml = fs.readFileSync(path.join(OUT, "pages/dist/pro/index.html"), "utf8");
  const meta = (/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(pagesHtml) || [])[1] || "";
  check("published pro page: its own CSP, connect-src = the API and Cognito only, no inline script or style", meta.includes(`connect-src ${new URL(api.url).origin} https://cognito-idp.eu-north-1.amazonaws.com;`) && /script-src 'self';/.test(meta) && /style-src 'self';/.test(meta) && !/unsafe-inline/.test(meta), meta);
  check("published pro page: not indexed, no inline <script> or <style>", /<meta name="robots" content="noindex">/.test(pagesHtml) && !/<script>(?!<\/)/.test(pagesHtml) && !/<style>/.test(pagesHtml));
  const robots = fs.readFileSync(path.join(dist, "robots.txt"), "utf8");
  check("robots.txt keeps crawlers out of /pro/", /Disallow: \/pro\//.test(robots), robots);
  // lien « Espace pro » de l'en-tête du comparateur : seulement dans le site qui a la page pro/
  const proLink = (file) => /<a class="tab tab-pro" href="pro\/"/.test(fs.readFileSync(file, "utf8"));
  check("« Espace pro » in the comparator's header only in the site that has the pro page (none without it, none in the all-in-one page)", proLink(path.join(dist, "index.html")) && !proLink(path.join(OUT, "plain/dist/index.html")) && !proLink(path.join(OUT, "single/index.html")));

  // ---- navigateur
  const cognito = fakeCognito();
  const browser = await chromium.launch({ args: ["--proxy-server=direct://", "--proxy-bypass-list=*"] });
  const outside = [];
  async function newPage({ width = 1280, height = 900 } = {}) {
    const ctx = await browser.newContext({ viewport: { width, height }, locale: "fr-FR", serviceWorkers: "block" });
    await ctx.route("**/*", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.href.startsWith(COGNITO)) {
        const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, x-amz-target, x-amz-user-agent", "access-control-allow-methods": "POST" };
        if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
        const action = String(req.headers()["x-amz-target"] || "").replace("AWSCognitoIdentityProviderService.", "");
        const out = cognito.handle(action, JSON.parse(req.postData() || "{}"));
        return route.fulfill({ status: out.status, headers: { ...cors, "content-type": "application/x-amz-json-1.1" }, body: JSON.stringify(out.body) });
      }
      if (url.hostname === "127.0.0.1") return route.continue();
      outside.push(url.href);
      return route.abort();
    });
    const page = await ctx.newPage();
    const logs = [];
    // les refus attendus de l'API et de Cognito (400, 401, 422) apparaissent dans la console comme « Failed to load resource » : ce ne sont pas des erreurs de la page
    page.on("console", (m) => ["error", "warning"].includes(m.type()) && !/^Failed to load resource: the server responded with a status of (400|401|422)\b/.test(m.text()) && logs.push(`[${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => logs.push("[pageerror] " + e.message));
    return { ctx, page, logs };
  }
  const axe = async (page, label) => {
    await page.evaluate(AXE);
    const r = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } })).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`));
    check(`axe: no violation on « ${label} »`, r.length === 0, r.join("\n"));
  };
  const visible = (page, screen) => page.locator(`[data-screen="${screen}"]`).isVisible();
  const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `pro-${name}.png`), fullPage: true });
  const EMAIL = "camille@garage-demo.fr";

  const { ctx, page, logs } = await newPage();
  const res = await page.goto(`${srv.url}/pro/`);
  const csp = res.headers()["content-security-policy"] || "";
  check("served with the site headers: the CSP lets the page talk to Cognito", csp.includes("https://cognito-idp.eu-north-1.amazonaws.com"), csp);

  // accueil des visiteurs (maquette 2) : la promesse, l'en-tête, rien de demandé à Cognito ; il ne promet que ce qui existe
  await page.waitForSelector('[data-screen="welcome"]:not([hidden])');
  const w = await page.evaluate(() => ({
    h1: document.getElementById("welcomeTitle").textContent,
    nav: [...document.querySelectorAll("#proNav a")].map((a) => a.getAttribute("href")),
    text: document.querySelector('[data-screen="welcome"]').textContent.replace(/\s+/g, " "),
  }));
  check("a visitor lands on the welcome page; the header offers the FAQ, « Se connecter », « Gérer mon garage »; nothing asked of Cognito", w.h1 === "Vos prix, à jour, là où vos clients comparent." && w.nav.join() === "#faq,#connexion,#inscription" && !cognito.calls.length && (await page.locator("#account").isHidden()), JSON.stringify(w.nav));
  check("the welcome page promises only what exists: the sample garage says « Exemple », verification by an e-mail code (no phone call), no hourly rate", /Exemple/.test(w.text) && /un code envoyé à une adresse e-mail connue de votre garage/.test(w.text) && !/appel automatique|Décrochez|taux horaire/i.test(w.text), w.text.slice(0, 200));
  await axe(page, "accueil");
  await shot(page, "0-accueil");
  await page.click('#proNav a[href="#faq"]');
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === "faq");
  check("« Questions fréquentes » leads to the questions, on the welcome page", await visible(page, "welcome"));
  await page.click('#proNav a[href="#connexion"]');
  await page.waitForSelector('[data-screen="login"]:not([hidden])');
  check("« Se connecter » opens the login form at #connexion", (await page.locator("#loginTitle").isVisible()) && new URL(page.url()).hash === "#connexion");
  await page.goBack();
  await page.waitForSelector('[data-screen="welcome"]:not([hidden])');
  check("the browser's back button returns to the welcome page", await visible(page, "welcome"));
  await page.click('#proNav a[href="#connexion"]');
  await page.click('[data-screen="login"] a.back');
  await page.waitForSelector('[data-screen="welcome"]:not([hidden])');
  check("the login form's « Découvrir l'Espace Pro » returns to the welcome page", await visible(page, "welcome"));
  await page.click('.w-cta a[href="#inscription"]');
  await page.waitForSelector('[data-screen="login"]:not([hidden])');
  check("#inscription opens the sign-up form", (await page.locator("#signupTitle").isVisible()) && !(await page.locator("#loginTitle").isVisible()));
  await axe(page, "inscription");
  await shot(page, "1-inscription");

  // inscription : e-mail invalide, puis le bon
  await page.fill("#email", "pas-un-mail");
  await page.click("#loginBtn");
  check("an invalid e-mail is caught before calling Cognito", (await page.textContent("#emailErr")).includes("invalide") && !cognito.calls.length);
  await page.fill("#email", EMAIL);
  await page.click("#loginBtn");
  await page.waitForSelector('[data-screen="otp"]:not([hidden])');
  check("sign-up: Cognito gets SignUp without any password, the code screen names the address", cognito.calls.join() === "SignUp" && (await page.textContent("#otpTo")) === EMAIL);
  await page.fill("#otp", "000000");
  await page.click('#otpForm button[type="submit"]');
  await page.waitForFunction(() => !document.getElementById("otpErr").hidden);
  check("a wrong e-mail code says so, in French", (await page.textContent("#otpErr")).includes("Code incorrect"));
  await page.fill("#otp", cognito.last(EMAIL));
  await page.click('#otpForm button[type="submit"]');
  await page.waitForSelector('[data-screen="home"]:not([hidden])');
  check("confirmed and signed in at once (ConfirmSignUp session, no second code)", cognito.calls.slice(-2).join() === "ConfirmSignUp,InitiateAuth" && cognito.mail.length === 1, cognito.calls.join());
  check("dashboard: no garage yet, the account is shown in the header (not the visitor's links), the address loses #inscription", (await page.locator("#noGarage").isVisible()) && (await page.textContent("#accountEmail")) === EMAIL && (await page.locator("#proNav").isHidden()) && new URL(page.url()).hash === "");
  const stored = await page.evaluate(() => [Object.keys(sessionStorage), Object.keys(localStorage), document.cookie]);
  check("tokens live in sessionStorage only (no localStorage, no cookie)", stored[0].includes("pixcar-pro-session") && !stored[1].length && !stored[2], JSON.stringify(stored));
  await axe(page, "tableau de bord vide");

  // étape 1 : SIRET
  await page.click('[data-screen="home"] [data-go="garage"]');
  check("the steps appear, step 1 is current", (await page.locator("#steps").isVisible()) && (await page.getAttribute('[data-step="garage"]', "aria-current")) === "step");
  await page.fill("#siret", "123");
  await page.click('#siretForm button[type="submit"]');
  check("a SIRET that is not 14 digits is refused on the page", (await page.textContent("#siretErr")).includes("14 chiffres"));
  await page.fill("#siret", "12345678901234");
  await page.click('#siretForm button[type="submit"]');
  await page.waitForFunction(() => !document.getElementById("siretErr").hidden && /SIRET/.test(document.getElementById("siretErr").textContent));
  check("a SIRET with a wrong key: the API's message is shown", (await page.textContent("#siretErr")).includes("clé de contrôle"));
  await page.fill("#siret", `${SIRET.slice(0, 3)} ${SIRET.slice(3, 6)} ${SIRET.slice(6, 9)} ${SIRET.slice(9)}`);
  await page.click('#siretForm button[type="submit"]');
  await page.waitForSelector("#siretResult:not([hidden])");
  const choices = await page.$$eval("#garageOptions .choice", (els) => els.map((e) => [e.querySelector("b").textContent, e.querySelector("input").disabled, e.querySelector("input").checked, e.querySelector("small").textContent]));
  check(
    "establishment found; its garage is preselected with its means counted; the neighbour already managed by someone else cannot be chosen",
    (await page.textContent("#etabName")) === "GARAGE DEMO CENTRE" && choices[0][0] === "Garage Démo Centre" && choices[0][2] && /3 moyens/.test(choices[0][3]) && choices[1][1] && /autre compte/.test(choices[1][3]),
    JSON.stringify(choices),
  );
  await axe(page, "SIRET trouvé");
  await shot(page, "2-siret");
  await page.click("#pickGarage");

  // étape 2 : la personne
  await page.waitForSelector('[data-screen="you"]:not([hidden])');
  check("step 2 names the garage and shows the account e-mail read-only", (await page.textContent("#youGarage")) === "Garage Démo Centre" && (await page.inputValue("#youEmail")) === EMAIL && (await page.getAttribute("#youEmail", "readonly")) !== null);
  await page.fill("#firstName", "Camille");
  await page.fill("#lastName", "Durand");
  await page.click('#youForm button[type="submit"]');
  check("the certification box is required", (await page.textContent("#youErr")).includes("Cochez"));
  await page.check("#certify");
  await page.click('#youForm button[type="submit"]');
  await page.waitForSelector('[data-screen="verify"]:not([hidden])');
  await axe(page, "Qui êtes-vous");

  // étape 3 : choix du moyen
  const opts = await page.$$eval("#channelOptions .choice", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()));
  check("three means offered, all masked: public e-mail, an address on the garage's own domain, SMS", opts.length === 3 && /E-mail public du garage c•••••@garage-demo\.fr/.test(opts[0]) && /@garage-demo\.fr/.test(opts[1]) && /SMS au portable du garage 06 •• •• •• 78/.test(opts[2]), opts.join(" / "));
  check("nothing in the page reveals the real address or number", !/contact@garage-demo|612345678/.test(await page.content()));
  await page.click('#channelForm button[type="submit"]');
  check("a means must be chosen (none preselected when there are several)", (await page.textContent("#channelErr")).includes("Choisissez"));
  await page.focus("#localPart");
  await page.click('#channelForm button[type="submit"]');
  check("focusing the local-part field selects the domain option; an empty local part is refused", (await page.isChecked('input[name="channel"][value="domain"]')) && (await page.textContent("#channelErr")).includes("avant le @"));
  await axe(page, "choix du moyen");
  await shot(page, "3-moyen");
  await page.check('input[name="channel"][value="sms:1"]');
  await page.click('#channelForm button[type="submit"]');
  await page.waitForSelector('[data-screen="code"]:not([hidden])');
  const outbox = api.app.pro.senders.outbox;
  check("the code left by SMS to the garage's mobile, never to anything typed on the page", outbox.length === 1 && outbox[0].channel === "sms" && outbox[0].target === "+33612345678", JSON.stringify(outbox));
  check("code screen: where the code went (masked), resend locked for 60 s", (await page.textContent("#codeWhere")) === "par SMS au 06 •• •• •• 78" && (await page.isDisabled("#resend")) && /dans 1:00|dans 0:5\d/.test(await page.textContent("#resendIn")), await page.textContent("#resendIn"));
  await axe(page, "saisie du code");
  await shot(page, "4-code");
  const good = outbox[0].code;
  await page.fill("#code", String((Number(good) + 1) % 1e6).padStart(6, "0"));
  await page.click('#codeForm button[type="submit"]');
  await page.waitForFunction(() => !document.getElementById("codeErr").hidden);
  check("a wrong code: « Encore 4 essais »", (await page.textContent("#codeErr")).includes("Encore 4 essais"));
  await page.fill("#code", good);
  await page.click('#codeForm button[type="submit"]');
  await page.waitForSelector('[data-screen="done"]:not([hidden])');
  check("verified: step 4, the garage named", (await page.textContent("#doneGarage")) === "Garage Démo Centre" && (await page.getAttribute('[data-step="done"]', "aria-current")) === "step");
  const row = (await api.db.query("SELECT status, holder_name, holder_role, account_id FROM pro_claims WHERE account_id LIKE 'sub-%'")).rows[0];
  check("in the database: verified, with the person's name and role, under the Cognito account", row && row.status === "verified" && row.holder_name === "Camille Durand" && row.holder_role === "manager", JSON.stringify(row));
  await axe(page, "garage vérifié");
  await shot(page, "5-fait");
  // ---- « Vos premiers prix » : tableau de bord du garage
  await page.click("#doneDash");
  await page.waitForSelector('[data-screen="dash"]:not([hidden])');
  const today = new Date().toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", day: "numeric", month: "long", year: "numeric" });
  check(
    "dashboard: hello by first name, the garage, verified today, no price yet, zero visits",
    (await page.textContent("#dashTitle")) === "Bonjour Camille" && (await page.textContent("#dashGarage")).startsWith("Garage Démo Centre") && (await page.textContent("#dashVerified")).includes(today) &&
      (await page.locator("#noPrice").isVisible()) && (await page.textContent("#statViews")) === "0" && (await page.textContent("#statFresh")) === "—" && (await page.locator("#dashDue").isHidden()),
    [await page.textContent("#dashTitle"), await page.textContent("#dashVerified")].join(" | "),
  );
  check("the steps are gone on the dashboard", await page.locator("#steps").isHidden());
  await axe(page, "tableau de bord vide (garage)");
  // ajout d'un prix : le formulaire contrôle avant l'API, l'aperçu suit la saisie
  await page.click("#addPrice");
  await page.waitForSelector("#priceDlg[open]");
  check("add: the first service of the catalogue, all vehicles, parts and labour ticked", (await page.inputValue("#priceService")) === "geo_av" && (await page.$$eval('#priceVehicles input', (els) => els.every((e) => e.checked))) && (await page.$$eval('#priceIncludes input:checked', (els) => els.map((e) => e.value).join())) === "parts,labour");
  await page.selectOption("#priceService", "vidange");
  await page.click("#priceSave");
  check("a missing price is refused on the page, in French", (await page.textContent("#priceErr")).includes("Prix TTC") && (await page.getAttribute("#priceValue", "aria-invalid")) === "true");
  await page.fill("#priceValue", "89,5");
  check("preview: « 89,50 € Annoncé forfait, pièces et main-d'œuvre »", (await page.textContent("#previewPrice")) === "89,50\u00a0€" && (await page.textContent("#previewDetail")) === "forfait, pièces et main-d'œuvre", await page.textContent("#previewPrice"));
  await page.click('#priceForm .seg label:has(input[value="quote"])');
  check("« sur devis » hides the price field", (await page.locator("#priceBox").isHidden()) && (await page.textContent("#previewPrice")) === "Sur devis");
  await page.click('#priceForm .seg label:has(input[value="fixed"])');
  await page.click('#priceVehicles label:has(input[value="van"])');
  await axe(page, "saisie d'un prix");
  await shot(page, "6-saisie");
  await page.click("#priceSave");
  await page.waitForFunction(() => !document.getElementById("priceDlg").open);
  const saved = (await api.db.query("SELECT service_id, kind, price_cents, vehicles, includes, status FROM pro_prices")).rows;
  check("saved in the database: the service, 89.50 €, four vehicles, parts and labour, published", saved.length === 1 && saved[0].service_id === "vidange" && saved[0].price_cents === 8950 && saved[0].vehicles.join() === "city,compact,sedan,suv" && saved[0].includes.join() === "parts,labour" && saved[0].status === "published", JSON.stringify(saved));
  const rowText = (await page.textContent("#priceRows tr")).replace(/\s+/g, " ");
  check("the price is listed: service, type, price, up to date today", /Vidange \(huile \+ filtre\).*Forfait.*89,50.*Pièces \+ main-d'œuvre.*Pas encore de déclaration/.test(rowText) && (await page.textContent("#statFresh")) === "1\u00a0/\u00a01" && (await page.textContent("#alert")).includes("visible sur Pixcar"), rowText);
  // un prix « sur devis », puis retiré (deux clics)
  await page.click("#addPrice");
  await page.selectOption("#priceService", "diag");
  check("a service that already has a price is not offered again", await page.isDisabled('#priceService option[value="vidange"]'));
  await page.click('#priceForm .seg label:has(input[value="quote"])');
  await page.click("#priceSave");
  await page.waitForFunction(() => !document.getElementById("priceDlg").open);
  await page.click('#priceRows button[aria-label="Modifier : Diagnostic électronique (voyant allumé)"]');
  check("edit: the service is fixed, the kind is kept", (await page.locator("#pickService").isHidden()) && (await page.isChecked('#priceForm input[name="kind"][value="quote"]')) && (await page.textContent("#priceDlgTitle")) === "Diagnostic électronique (voyant allumé)");
  await page.click("#priceDelete");
  check("removing asks for a second click", (await page.textContent("#priceDelete")).includes("Confirmer") && (await page.locator("#priceDlg[open]").count()) === 1);
  await page.click("#priceDelete");
  await page.waitForFunction(() => !document.getElementById("priceDlg").open);
  check("removed: one price left", (await page.$$eval("#priceRows tr", (els) => els.length)) === 1 && (await api.db.query("SELECT count(*)::int AS n FROM pro_prices")).rows[0].n === 1);
  // prix à confirmer, visites et prix payés : tableau de bord rechargé
  const garageId = CONTACTS[0].id;
  // daté par l'horloge de l'API (pas par now() de la base, à l'heure réelle) : « à confirmer » ne dépend pas du jour où tourne le test
  await api.db.query("UPDATE pro_prices SET confirmed_at = to_timestamp($1::double precision / 1000) - interval '170 days'", [api.now()]);
  // l'horloge de l'API de test part du 1er octobre 2026 (tests/api-harness.js) : les jours des visites se comptent depuis elle
  const apiDay = (ago) => new Date(Date.parse("2026-10-01T12:00:00Z") - ago * 864e5).toISOString().slice(0, 10);
  await api.db.query("INSERT INTO pro_visits (garage_id, day, kind, visitor) VALUES ($1, $4::date, 'view', $2), ($1, $4::date, 'view', $3), ($1, $4::date, 'call', $2), ($1, $5::date, 'view', $2)", [garageId, "1".repeat(64), "2".repeat(64), apiDay(0), apiDay(40)]);
  await api.db.query("INSERT INTO garages (id, name, addr, lat, lon, chain_id, area_y, area_x) VALUES ($1, 'Garage Démo Centre', '', $2, $3, '', 0, 0)", ["custom:ovt-" + garageId.replace(/-/g, ""), HERE.lat, HERE.lon]);
  await api.db.query("INSERT INTO repairs (id, garage_id, service_id, price_cents, repaired_on, rating, vehicle_model, vehicle_year, plate_hmac, status, delete_token_hash) VALUES (gen_random_uuid(), $1, 'vidange', 9800, current_date, 4, 'Clio', 2018, $2, 'approved', $3)", ["custom:ovt-" + garageId.replace(/-/g, ""), "3".repeat(64), "4".repeat(64)]);
  await page.click('.dash-link[data-go="home"]');
  await page.waitForSelector('[data-screen="home"]:not([hidden])');
  const items = await page.$$eval("#garageList li", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  check("« Mes garages » lists the garage as verified, with « Mes prix »", items.length === 1 && /Garage Démo Centre.*Vérifié.*Mes prix/.test(items[0]), items.join(" / "));
  await axe(page, "mes garages");
  await page.click("#garageList button");
  await page.waitForSelector('[data-screen="dash"]:not([hidden])');
  check(
    "reloaded: « 1 prix à confirmer », 2 views (+100 %), 1 call, customers paid +9 % over the announced price (98 € against 89.50 €), the row « À confirmer »",
    (await page.textContent("#dashDueTitle")).startsWith("1 prix à confirmer avant le") && (await page.textContent("#dashDueCount")) === "1" && (await page.textContent("#statViews")) === "2" && (await page.textContent("#statViewsDelta")) === "+100\u00a0%" &&
      (await page.textContent("#statCalls")) === "1" && (await page.textContent("#statPaid")) === "+9\u00a0%" && (await page.textContent("#priceRows .state")) === "À confirmer" && /98\u00a0€ médiane · 1/.test(await page.textContent("#priceRows .c-paid")),
    [await page.textContent("#dashDueTitle"), await page.textContent("#statViewsDelta"), await page.textContent("#statPaid"), await page.textContent("#priceRows .c-paid")].join(" | "),
  );
  await axe(page, "tableau de bord (prix à confirmer)");
  await shot(page, "7-tableau");
  await page.click("#confirmAll");
  await page.waitForFunction(() => document.getElementById("dashDue").hidden);
  check("« Tout confirmer »: nothing left to confirm, the row is up to date again", (await page.textContent("#alert")).includes("confirmé") && (await page.textContent("#priceRows .state")) !== "À confirmer");

  // ---- « Mon garage » : coordonnées (contacts privés jamais montrés), registre, horaires, changements relus, prestations et temps moyens
  await page.click('.dash-link[data-panel="garage"]');
  await page.waitForSelector("#dash-garage:not([hidden])");
  const coords = async () => Object.fromEntries(await page.$$eval("#mgCoords li", (els) => els.map((e) => [e.dataset.field, e.querySelector(".mg-main").textContent.replace(/\s+/g, " ").trim()])));
  let c0 = await coords();
  check(
    "« Mon garage »: the dashboard gives way, the menu says where we are, the title has the focus",
    (await page.locator("#dash-top").isHidden()) && (await page.getAttribute('.dash-link[data-panel="garage"]', "aria-current")) === "true" && (await page.getAttribute('.dash-link[data-panel="top"]', "aria-current")) === null && (await page.evaluate(() => document.activeElement.id)) === "mgTitle",
  );
  check(
    "coordinates: name and address from the public data, the rest not filled in yet",
    /Garage Démo Centre.*Données publiques/.test(c0.name) && /12 rue de l'Exemple, 31220 Cazères.*Données publiques/.test(c0.addr) && /Pas encore renseigné ici/.test(c0.phone) && /Pas encore renseigné ici/.test(c0.website) && /Aucun \(facultatif\)/.test(c0.email),
    JSON.stringify(c0),
  );
  check("the garage's private contacts (verification e-mail and numbers) appear nowhere in the page", !/contact@garage-demo|561000001|612345678|61 00 00 01|12 34 56 78/.test(await page.content()));
  const reg = (await page.textContent("#mgRegistry")).replace(/\s+/g, " ");
  check(
    "official registry, read-only: company, SIRET in groups, activity code and label, address, state",
    reg.includes("DEMO SARL") && reg.includes(`${SIRET.slice(0, 3)} ${SIRET.slice(3, 6)} ${SIRET.slice(6, 9)} ${SIRET.slice(9)}`) && reg.includes("45.20A · Entretien et réparation de véhicules automobiles légers") && reg.includes("12 RUE DE L'EXEMPLE") && reg.includes("Actif") && !(await page.locator("#mgRegistry button").count()),
    reg,
  );
  const svcRow = (id) => page.$eval(`#mgSvcRows tr[data-svc="${id}"]`, (tr) => ({ on: tr.querySelector(".tgl").getAttribute("aria-checked"), sel: tr.querySelector("select").disabled, min: tr.querySelector("select").value, text: tr.textContent.replace(/\s+/g, " ").trim(), cls: tr.className }));
  const v0 = await svcRow("vidange"), d0 = await svcRow("diag"), g0 = await svcRow("geo_av");
  check(
    "services: the two that got a price are ticked (the price removed later does not untick it), time to enter; the rest unticked",
    v0.on === "true" && /Temps moyen à saisir/.test(v0.text) && /89,50/.test(v0.text) && d0.on === "true" && /Annoncer un prix/.test(d0.text) && g0.on === "false" && g0.sel && (await page.$$eval("#mgSvcRows tr[data-svc]", (els) => els.length)) === 17 && (await page.textContent("#mgSvcSummary")) === "2 sur 17 · temps moyen renseigné pour 0",
    JSON.stringify([v0, d0, g0, await page.textContent("#mgSvcSummary")]),
  );
  await axe(page, "Mon garage");
  await shot(page, "7b-mon-garage");

  // site internet : publié tout de suite ; une adresse refusée d'abord
  await page.click('#mgCoords li[data-field="website"] button');
  await page.waitForSelector("#fieldDlg[open]");
  check("website: the dialog says it is published at once, focus in the field, nothing to erase yet", (await page.textContent("#fieldHelp")).includes("Publié tout de suite") && (await page.evaluate(() => document.activeElement.id)) === "fieldValue" && (await page.getAttribute("#fieldValue", "type")) === "url" && (await page.locator("#fieldClearBox").isHidden()));
  await page.fill("#fieldValue", "javascript:alert(1)");
  await page.click("#fieldSave");
  check("a website that is not an http(s) address is refused on the page", (await page.textContent("#fieldErr")).includes("Site : adresse invalide") && (await page.locator("#fieldDlg[open]").count()) === 1);
  await axe(page, "Mon garage : modifier un champ");
  await page.fill("#fieldValue", "Garage-Demo.fr/atelier");
  await page.click("#fieldSave");
  await page.waitForFunction(() => !document.getElementById("fieldDlg").open);
  const prof = async () => (await api.db.query("SELECT name, street, phone, website, email, hours FROM pro_profiles WHERE garage_id = $1", [garageId])).rows[0];
  let p1 = await prof();
  c0 = await coords();
  check("website saved as a full https address, shown short with « Communiqué par le garage »", p1 && p1.website === "https://garage-demo.fr/atelier" && /garage-demo\.fr\/atelier.*Communiqué par le garage/.test(c0.website) && (await page.textContent("#alert")).includes("enregistré"), JSON.stringify([p1, c0.website]));
  // e-mail affiché, puis effacé
  await page.click('#mgCoords li[data-field="email"] button');
  await page.fill("#fieldValue", "Accueil@Garage-Demo.fr");
  await page.click("#fieldSave");
  await page.waitForFunction(() => !document.getElementById("fieldDlg").open);
  check("displayed e-mail saved in lower case", (await prof()).email === "accueil@garage-demo.fr" && /accueil@garage-demo\.fr/.test((await coords()).email));
  await page.click('#mgCoords li[data-field="email"] button');
  check("a published e-mail can be erased", await page.locator("#fieldClearBox").isVisible());
  await page.click("#fieldClear");
  await page.waitForFunction(() => !document.getElementById("fieldDlg").open);
  check("erased: gone from the database and the page", (await prof()).email === "" && /Aucun \(facultatif\)/.test((await coords()).email));

  // téléphone : relu par Pixcar ; la demande s'affiche, puis s'annule
  await page.click('#mgCoords li[data-field="phone"] button');
  check("phone: the dialog says it is reviewed by Pixcar, phone keyboard", (await page.textContent("#fieldHelp")).includes("Relu par Pixcar") && (await page.getAttribute("#fieldValue", "type")) === "tel");
  await page.fill("#fieldValue", "05 61 00 00 01 ou 06 00 00 00 00");
  await page.click("#fieldSave");
  check("two numbers in the phone field are refused", (await page.textContent("#fieldErr")).includes("un numéro"));
  await page.fill("#fieldValue", "05 61 00 00 99");
  await page.click("#fieldSave");
  await page.waitForFunction(() => !document.getElementById("fieldDlg").open);
  const pending = (await api.db.query("SELECT field, value, status FROM pro_profile_changes WHERE garage_id = $1", [garageId])).rows;
  c0 = await coords();
  check("phone change: pending in the database (international form), shown « Changement demandé · relu par Pixcar », not published", pending.length === 1 && pending[0].value === "+33561000099" && pending[0].status === "pending" && /Changement demandé : 05 61 00 00 99 · relu par Pixcar/.test(c0.phone) && !(await prof()).phone, JSON.stringify([pending, c0.phone]));
  await page.click('#mgCoords li[data-field="phone"] button[aria-label^="Annuler"]');
  await page.waitForFunction(() => !/Changement demandé/.test(document.querySelector('#mgCoords li[data-field="phone"]').textContent));
  check("the request is cancelled", (await api.db.query("SELECT status FROM pro_profile_changes WHERE garage_id = $1", [garageId])).rows[0].status === "cancelled" && (await page.textContent("#alert")).includes("demande annulée"));

  // nom : approuvé par Pixcar (op « pro-change ») ; adresse : refusée avec un motif
  await page.click('#mgCoords li[data-field="name"] button');
  check("name: prefilled with the current name", (await page.inputValue("#fieldValue")) === "Garage Démo Centre");
  await page.fill("#fieldValue", "Garage Démo du Centre");
  await page.click("#fieldSave");
  await page.waitForFunction(() => !document.getElementById("fieldDlg").open);
  await page.click('#mgCoords li[data-field="addr"] button');
  check("address: three fields, the postcode prefilled", (await page.locator("#fieldAddr").isVisible()) && (await page.locator("#fieldOne").isHidden()) && (await page.inputValue("#addrPc")) === "31220" && (await page.evaluate(() => document.activeElement.id)) === "addrStreet");
  await page.fill("#addrStreet", "14 rue de l'Exemple");
  await page.fill("#addrPc", "");
  await page.locator("#addrPc").pressSequentially("31 22-0");
  check("the postcode keeps digits only, typed with a space or a dash", (await page.inputValue("#addrPc")) === "31220", await page.inputValue("#addrPc"));
  await page.fill("#addrCity", "Cazères");
  await page.click("#fieldSave");
  await page.waitForFunction(() => !document.getElementById("fieldDlg").open);
  const asked = Object.fromEntries((await api.db.query("SELECT field, id FROM pro_profile_changes WHERE garage_id = $1 AND status = 'pending'", [garageId])).rows.map((r) => [r.field, r.id]));
  await api.app.pro.repo.decideChange({ id: asked.name, decision: "approve" });
  await api.app.pro.repo.decideChange({ id: asked.addr, decision: "reject", reason: "Adresse différente du registre" });
  await page.click('.dash-link[data-panel="top"]');
  await page.waitForSelector("#dash-top:not([hidden])");
  check("« Tableau de bord » in the menu: back to the top, focus on the greeting", (await page.evaluate(() => document.activeElement.id)) === "dashTitle" && (await page.locator("#dash-garage").isHidden()));
  await page.click('.dash-link[data-panel="garage"]');
  await page.waitForSelector("#dash-garage:not([hidden])");
  c0 = await coords();
  check(
    "reopened: the approved name « Vérifié par Pixcar », the refused address with its reason, the old address still shown",
    /Garage Démo du Centre.*Vérifié par Pixcar/.test(c0.name) && /12 rue de l'Exemple, 31220 Cazères.*Données publiques.*Changement refusé : 14 rue de l'Exemple, 31220 Cazères · Adresse différente du registre/.test(c0.addr),
    JSON.stringify(c0),
  );

  // horaires : copie du lundi, samedi matin, dimanche ouvert sans plage refusé
  await page.click("#mgHoursEdit");
  await page.waitForSelector("#hoursDlg[open]");
  const hourOpts = await page.$$eval('#hoursDays select[data-day="mo"][data-slot="00"] option', (els) => els.map((o) => [o.value, o.textContent]));
  check(
    "hours: none yet, the first time list has the focus; quarter hours from 0:00 to 24:00, written without a leading zero (typing 8 picks 8:00), sent as 08:00",
    (await page.$$eval("#hoursDays fieldset", (els) => els.length)) === 7 && (await page.evaluate(() => document.activeElement.tagName === "SELECT" && document.activeElement.dataset.slot === "00")) &&
      hourOpts.length === 98 && hourOpts[0][0] === "" && hourOpts[1].join() === "00:00,0:00" && hourOpts.find((o) => o[0] === "08:15").join() === "08:15,8:15" && hourOpts[97].join() === "24:00,24:00" && (await page.$$eval("#hoursDays input:not([type=checkbox])", (els) => els.length)) === 0,
    JSON.stringify(hourOpts.slice(0, 3)),
  );
  const t = (day, slot) => `#hoursDays select[data-day="${day}"][data-slot="${slot}"]`;
  await page.selectOption(t("mo", "00"), "08:00");
  await page.selectOption(t("mo", "01"), "12:00");
  await page.selectOption(t("mo", "10"), "14:00");
  await page.selectOption(t("mo", "11"), "18:30");
  check("choosing a time ticks « Ouvert »", await page.isChecked('#hoursDays input[data-open="mo"]'));
  await page.click("#hoursCopy");
  const copied = await page.$$eval("#hoursDays select", (els) => els.map((e) => `${e.dataset.day}${e.dataset.slot}=${e.value}`).join(" "));
  check("« Copier les horaires du lundi » fills the four times of Tuesday to Friday, not the weekend", ["tu", "we", "th", "fr"].every((d) => copied.includes(`${d}00=08:00 ${d}01=12:00 ${d}10=14:00 ${d}11=18:30`)) && copied.includes("sa00= ") && (await page.isChecked('#hoursDays input[data-open="th"]')) && !(await page.isChecked('#hoursDays input[data-open="sa"]')) && (await page.textContent("#mgLive")).includes("copiés"));
  await page.selectOption(t("sa", "00"), "08:00");
  await page.selectOption(t("sa", "01"), "12:00");
  await page.check('#hoursDays input[data-open="su"]');
  await page.click("#hoursSave");
  check("a day ticked open without any time is refused", (await page.textContent("#hoursErr")).includes("Dimanche : indiquez une plage"));
  await page.uncheck('#hoursDays input[data-open="su"]');
  await page.selectOption(t("we", "10"), "11:00");
  await page.click("#hoursSave");
  check("overlapping slots are refused", (await page.textContent("#hoursErr")) === "Horaires du mercredi : plages dans l'ordre, sans chevauchement.", await page.textContent("#hoursErr"));
  await page.selectOption(t("we", "10"), "14:00");
  const hdDesk = await page.$eval("#hoursDlg", (d) => {
    const box = d.getBoundingClientRect();
    const cut = [...d.querySelectorAll("legend, input, select")].filter((e) => { const r = e.getBoundingClientRect(); return r.left < box.left || r.right > box.right; }).length;
    return { over: d.scrollWidth - d.clientWidth, cut, width: Math.round(box.width) };
  });
  check("hours dialog (1280 px): no sideways scroll, no day or field cut off", hdDesk.over <= 0 && hdDesk.cut === 0, JSON.stringify(hdDesk));
  await axe(page, "Mon garage : horaires");
  await shot(page, "7c-horaires");
  await page.click("#hoursSave");
  await page.waitForFunction(() => !document.getElementById("hoursDlg").open);
  const week = { mo: [["08:00", "12:00"], ["14:00", "18:30"]], tu: [["08:00", "12:00"], ["14:00", "18:30"]], we: [["08:00", "12:00"], ["14:00", "18:30"]], th: [["08:00", "12:00"], ["14:00", "18:30"]], fr: [["08:00", "12:00"], ["14:00", "18:30"]], sa: [["08:00", "12:00"]] };
  const hours = (await prof()).hours;
  const shown = await page.$$eval("#mgHours dl > div", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  check(
    "hours saved; the week is listed day by day, Sunday closed, with a one-line summary for screen readers",
    JSON.stringify(Object.entries(hours).sort()) === JSON.stringify(Object.entries(week).sort()) && shown[0] === "Lundi08:00 – 12:00 · 14:00 – 18:30" && shown[6] === "DimancheFermé" && (await page.getAttribute("#mgHours dl", "aria-label")) === "lun.–ven. 8:00–12:00, 14:00–18:30 · sam. 8:00–12:00 · dim. fermé",
    JSON.stringify([hours, shown]),
  );

  // prestations : cocher, temps moyen, « Annoncer un prix » d'ici ; décocher une prestation qui a un prix demande confirmation
  await page.click('#mgSvcRows tr[data-svc="geo_av"] .tgl');
  await page.waitForFunction(() => document.querySelector('#mgSvcRows tr[data-svc="geo_av"] .tgl').getAttribute("aria-checked") === "true");
  check("ticked: the time select opens, « Temps moyen à saisir », the focus stays on the switch", !(await svcRow("geo_av")).sel && /Temps moyen à saisir/.test((await svcRow("geo_av")).text) && (await page.evaluate(() => document.activeElement.getAttribute("aria-label"))) === "Je fais : Parallélisme / géométrie avant");
  await page.selectOption('#mgSvcRows tr[data-svc="geo_av"] select', "45");
  await page.waitForFunction(() => /temps moyen renseigné pour 1/.test(document.getElementById("mgSvcSummary").textContent));
  const svcDb = async () => Object.fromEntries((await api.db.query("SELECT service_id, offered, minutes FROM pro_services WHERE garage_id = $1", [garageId])).rows.map((r) => [r.service_id, [r.offered, r.minutes]]));
  check("45 min saved, the summary counts it, the focus back on the select", JSON.stringify((await svcDb()).geo_av) === "[true,45]" && (await page.textContent("#mgSvcSummary")) === "3 sur 17 · temps moyen renseigné pour 1" && (await page.evaluate(() => document.activeElement.tagName)) === "SELECT");
  check("per-tyre services say so next to the time", /par pneu/.test((await svcRow("montage")).text));
  await page.click('#mgSvcRows tr[data-svc="geo_av"] button[aria-label^="Annoncer un prix"]');
  await page.waitForSelector("#priceDlg[open]");
  check("« Annoncer un prix » from Mon garage: the service is set, no picker, focus on the price", (await page.textContent("#priceDlgKind")) === "Annoncer un prix" && (await page.textContent("#priceDlgTitle")) === "Parallélisme / géométrie avant" && (await page.locator("#pickService").isHidden()) && (await page.evaluate(() => document.activeElement.id)) === "priceValue");
  await page.fill("#priceValue", "79");
  await page.click("#priceSave");
  await page.waitForFunction(() => !document.getElementById("priceDlg").open);
  await page.waitForFunction(() => /79\s€/.test(document.querySelector('#mgSvcRows tr[data-svc="geo_av"]').textContent));
  check("the price is published and shown in the row; the focus comes back to the row's switch", (await api.db.query("SELECT price_cents FROM pro_prices WHERE service_id = 'geo_av'")).rows[0].price_cents === 7900 && (await page.evaluate(() => document.activeElement.getAttribute("aria-label"))) === "Je fais : Parallélisme / géométrie avant", await page.evaluate(() => document.activeElement.outerHTML.slice(0, 120)));
  await page.click('#mgSvcRows tr[data-svc="vidange"] .tgl');
  await page.waitForSelector("#untickDlg[open]");
  check("unticking a service with a price asks first, naming the price", (await page.textContent("#untickText")).includes("89,50") && (await page.textContent("#untickText")).includes("Vidange"));
  await axe(page, "Mon garage : décocher une prestation qui a un prix");
  await page.click("#untickNo");
  await page.waitForFunction(() => !document.getElementById("untickDlg").open);
  check("« Garder la prestation »: nothing changes", (await svcRow("vidange")).on === "true" && (await api.db.query("SELECT count(*)::int AS n FROM pro_prices WHERE service_id = 'vidange'")).rows[0].n === 1);
  await page.click('#mgSvcRows tr[data-svc="vidange"] .tgl');
  await page.click("#untickYes");
  await page.waitForFunction(() => document.querySelector('#mgSvcRows tr[data-svc="vidange"] .tgl').getAttribute("aria-checked") === "false");
  check(
    "« Décocher et retirer le prix »: unticked, the announced price removed from the database and from « Mes prix »",
    JSON.stringify((await svcDb()).vidange) === "[false,null]" && (await api.db.query("SELECT count(*)::int AS n FROM pro_prices WHERE service_id = 'vidange'")).rows[0].n === 0 && (await page.textContent("#alert")).includes("son prix annoncé est retiré") && !(await page.textContent("#priceRows")).includes("Vidange"),
    await page.textContent("#alert"),
  );
  await page.click('#mgSvcRows tr[data-svc="geo_av"] .tgl');
  await page.waitForSelector("#untickDlg[open]");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.getElementById("untickDlg").open);
  check("closed with Escape after an earlier « yes »: the service and its price are kept", (await svcRow("geo_av")).on === "true" && (await api.db.query("SELECT count(*)::int AS n FROM pro_prices WHERE service_id = 'geo_av'")).rows[0].n === 1);
  // une prestation sans prix se décoche sans question
  await page.click('#mgSvcRows tr[data-svc="diag"] .tgl');
  await page.waitForFunction(() => document.querySelector('#mgSvcRows tr[data-svc="diag"] .tgl').getAttribute("aria-checked") === "false");
  check("a service without a price is unticked at once", (await page.locator("#untickDlg[open]").count()) === 0 && JSON.stringify((await svcDb()).diag) === "[false,null]");
  await page.click('.dash-link[data-panel="prices"]');
  await page.waitForSelector("#dash-top:not([hidden])");
  check("« Mes prix » in the menu: back to the dashboard, focus on the prices heading", (await page.evaluate(() => document.activeElement.id)) === "pricesTitle" && (await page.getAttribute('.dash-link[data-panel="prices"]', "aria-current")) === "true");

  // déconnexion, puis reconnexion (compte existant : code de connexion)
  await page.click("#signOut");
  await page.waitForSelector('[data-screen="login"]:not([hidden])');
  check("sign out: back to the login form, session forgotten, refresh token revoked", (await page.evaluate(() => sessionStorage.getItem("pixcar-pro-session"))) === null && cognito.calls.includes("RevokeToken") && (await page.locator("#account").isHidden()));
  await page.fill("#email", EMAIL);
  await page.click("#loginBtn");
  await page.waitForSelector('[data-screen="otp"]:not([hidden])');
  // le code de connexion de Cognito compte 8 chiffres (6 pour l'inscription) : la page l'accepte, tapé avec une espace, et l'affiche en entier
  const signin = cognito.last(EMAIL);
  await page.fill("#otp", signin.slice(0, 4) + " " + signin.slice(4));
  const fit = await page.$eval("#otp", (el) => ({ value: el.value, clipped: el.scrollWidth > el.clientWidth + 1, lead: el.closest("section").querySelector(".lead").textContent }));
  check("sign-in code: 8 digits (Cognito), typed with a space, kept whole and fully visible; the screen does not promise 6 digits", signin.length === 8 && fit.value.replace(/\D/g, "") === signin && !fit.clipped && !/6 chiffres/.test(fit.lead), JSON.stringify(fit));
  await page.click('#otpForm button[type="submit"]');
  await page.waitForSelector('[data-screen="dash"]:not([hidden])');
  check("sign in again by e-mail code: an account with one verified garage lands on its dashboard, under the name Pixcar approved", (await page.textContent("#dashGarage")).startsWith("Garage Démo du Centre"), await page.textContent("#dashGarage"));

  // « Gérer mon garage » avec une adresse déjà inscrite : on bascule sur la connexion
  await page.click("#signOut");
  await page.click('[data-mode="signup"]');
  await page.fill("#email", EMAIL);
  const before = cognito.calls.length;
  await page.click("#loginBtn");
  await page.waitForSelector('[data-screen="otp"]:not([hidden])');
  check("signing up with an address that already has an account turns into a sign-in", cognito.calls.slice(before).join() === "SignUp,InitiateAuth", cognito.calls.slice(before).join());
  await page.fill("#otp", cognito.last(EMAIL));
  await page.click('#otpForm button[type="submit"]');
  await page.waitForSelector('[data-screen="dash"]:not([hidden])');

  // session refusée par l'API (jeton révoqué côté serveur) : retour propre à la connexion
  await page.evaluate(() => {
    const s = JSON.parse(sessionStorage.getItem("pixcar-pro-session"));
    s.access = "jeton-refuse";
    sessionStorage.setItem("pixcar-pro-session", JSON.stringify(s));
  });
  await page.reload();
  await page.waitForSelector('[data-screen="login"]:not([hidden])');
  check("a token the API refuses: back to login with a message", (await page.textContent("#alert")).includes("session a expiré"));
  check("no console error, no page error", !logs.length, logs.join("\n"));
  await ctx.close();

  // ---- mobile
  {
    const m = await newPage({ width: 390, height: 844 });
    await m.page.goto(`${srv.url}/pro/`);
    await m.page.waitForSelector('[data-screen="welcome"]:not([hidden])');
    const overflow = await m.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check("mobile (390 px): no horizontal scroll on the welcome page", overflow <= 0, overflow);
    await axe(m.page, "accueil (mobile)");
    await shot(m.page, "8-mobile-accueil");
    await m.page.click('#proNav a[href="#connexion"]');
    await m.page.waitForSelector('[data-screen="login"]:not([hidden])');
    const loginOverflow = await m.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check("mobile (390 px): no horizontal scroll on the login form", loginOverflow <= 0, loginOverflow);
    await shot(m.page, "8-mobile-connexion");
    await m.page.fill("#email", EMAIL);
    await m.page.click("#loginBtn");
    await m.page.waitForSelector('[data-screen="otp"]:not([hidden])');
    await m.page.fill("#otp", cognito.last(EMAIL));
    await m.page.click('#otpForm button[type="submit"]');
    await m.page.waitForSelector('[data-screen="dash"]:not([hidden])');
    const dashOverflow = await m.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const nav = await m.page.$eval(".dash-nav", (n) => ({ position: getComputedStyle(n).position, bottom: Math.round(n.getBoundingClientRect().bottom) }));
    check("mobile dashboard: no horizontal scroll, the navigation sits at the bottom of the screen", dashOverflow <= 0 && nav.position === "fixed" && nav.bottom === 844, JSON.stringify({ dashOverflow, nav }));
    await axe(m.page, "tableau de bord (mobile)");
    await shot(m.page, "9-mobile-tableau");
    await m.page.click("#priceRows button");
    await m.page.waitForSelector("#priceDlg[open]");
    await shot(m.page, "10-mobile-saisie");
    await m.page.click("#priceClose");
    await m.page.click('.dash-link[data-panel="garage"]');
    await m.page.waitForSelector("#dash-garage:not([hidden])");
    const mg = await m.page.evaluate(() => {
      const tr = document.querySelector('#mgSvcRows tr[data-svc="geo_av"]');
      return { over: document.documentElement.scrollWidth - window.innerWidth, row: getComputedStyle(tr).display, head: getComputedStyle(document.querySelector("#mgServices thead")).display, sw: Math.round(tr.querySelector(".tgl").getBoundingClientRect().height) };
    });
    check("mobile « Mon garage »: no horizontal scroll, the services become cards (no table header), the switch at least 24 px tall", mg.over <= 0 && mg.row !== "table-row" && mg.head === "none" && mg.sw >= 24, JSON.stringify(mg));
    await axe(m.page, "Mon garage (mobile)");
    await shot(m.page, "11-mobile-mon-garage");
    await m.page.click("#mgHoursEdit");
    await m.page.waitForSelector("#hoursDlg[open]");
    const hd = await m.page.$eval("#hoursDlg", (d) => ({ over: d.scrollWidth - d.clientWidth, w: Math.round(d.getBoundingClientRect().width) }));
    check("mobile hours dialog: fits the screen, nothing cut on the side", hd.over <= 0 && hd.w <= 390, JSON.stringify(hd));
    await shot(m.page, "12-mobile-horaires");
    check("mobile: no console error, no page error", !m.logs.length, m.logs.join("\n"));
    await m.ctx.close();
  }
  check("nothing but the site, the API and Cognito was contacted", !outside.length, outside.join("\n"));

  // en-tête du comparateur (site avec la page pro/) : « Espace pro » mène à l'accueil de l'Espace Pro ; tient sur un téléphone
  for (const [width, height] of [[1440, 900], [390, 844], [320, 640]]) {
    const c = await browser.newContext({ viewport: { width, height }, locale: "fr-FR", serviceWorkers: "block" });
    await c.route("**/*", (route) => (new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort()));
    const p = await c.newPage();
    await p.goto(`${srv.url}/index.html`);
    const link = p.getByRole("link", { name: "Espace pro" });
    const hdr = await p.evaluate(() => { const t = document.querySelector(".topbar-in"); return { over: t.scrollWidth - t.clientWidth, page: document.documentElement.scrollWidth - innerWidth }; });
    check(`comparator header (${width} px): « Espace pro » shown, nothing pushed out of the bar`, (await link.isVisible()) && hdr.over <= 0 && hdr.page <= 0, JSON.stringify(hdr));
    if (width === 1440) {
      await link.click();
      await p.waitForSelector('[data-screen="welcome"]:not([hidden])');
      check("« Espace pro » opens the Pro space's welcome page", new URL(p.url()).pathname.endsWith("/pro/"));
    }
    await c.close();
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
