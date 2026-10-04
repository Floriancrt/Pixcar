// Fenêtre « Confidentialité et mentions légales » dans le navigateur : ouverture depuis le bas du panneau, depuis « Sources et méthode » et
// depuis le formulaire de déclaration (mode API), fermeture (bouton, Échap, clic sur le fond), focus rendu à qui l'a ouverte, défilement
// bloqué tant qu'une fenêtre est ouverte, textes propres à chaque mode, accessibilité (thèmes clair et sombre), téléphone. La page est
// construite ici, avec une copie des sources dont src/legal.json est complet (valeurs fictives) : le fichier du dépôt peut être incomplet.
// Ce que le build fait de ce fichier (garde, échappement, durées annoncées) est vérifié par server/test/legal.test.mjs.
//   node tests/legal.js
delete process.env.PIXCAR_ROOT; // la suite construit et sert sa propre page, quel que soit le site que les autres suites testent
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { serve, launch, open, ROOT, injectScript } = require("./harness");

const AXE = fs.readFileSync(path.join(__dirname, "..", "node_modules/axe-core/axe.min.js"), "utf8");
const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond });
  if (!cond) console.log("  FAIL:", name, "|", String(detail).slice(0, 500));
};

const OUT = path.join(__dirname, ".out", "legal-site");
const SRC = process.env.PIXCAR_SRC || path.join(ROOT, "src"); // les tests de mutation y mettent une copie modifiée des sources
const LEGAL = {
  editorLine: "Pixcar est édité à titre non professionnel par Jeanne Exemple, responsable du traitement des données décrites ici.",
  contact: "contact@exemple.test",
  hostPages: "GitHub, Inc. (GitHub Pages), États-Unis",
  hostApi: "Amazon Web Services EMEA SARL, Luxembourg (région Europe, Stockholm)",
  repairRetentionMonths: 24,
  updated: "3 octobre 2026",
};
// Construit la page tout-en-un dans OUT/<name>/index.html à partir d'une copie des sources dont on fixe src/legal.json.
function site(name, legal) {
  const src = path.join(OUT, name + "-src");
  fs.cpSync(SRC, src, { recursive: true });
  fs.writeFileSync(path.join(src, "legal.json"), JSON.stringify(legal));
  execFileSync(process.execPath, [path.join(ROOT, "scripts/build.mjs"), "--only", "single", "--src", src, "--out", path.join(OUT, name)], { stdio: "ignore", env: { ...process.env, PIXCAR_API_BASE: "" } });
  return path.join(OUT, name);
}
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const axeOf = async (page, selector) => {
  await injectScript(page, AXE);
  return page.evaluate(async ([sel, tags]) => (await axe.run(sel ? document.querySelector(sel) : document, { runOnly: { type: "tag", values: tags } })).violations.map((x) => ({ id: x.id, n: x.nodes.length, ex: x.nodes.slice(0, 2).map((n) => n.html.slice(0, 120)) })), [selector, TAGS]);
};
const REMOTE = 'window.JG_TUNE.api="http://127.0.0.1:9";'; // mode API (l'adresse ne répond pas : rien d'autre n'est testé ici)
const PANEL = ".legal-foot [data-open-legal]";

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const complete = site("complete", LEGAL);
  const bare = site("bare", { ...LEGAL, editorLine: "", contact: "", repairRetentionMonths: "", updated: "" });
  const withNotice = await serve(complete);
  const without = await serve(bare);
  const browser = await launch();
  const norm = (t) => String(t).replace(/[\u00a0\u202f]/g, " ").replace(/\s+/g, " ").trim();
  // La fermeture déclenche l'événement « close » un instant après le clic : on laisse la page le traiter avant de lire son état.
  const state = async (page) => {
    await page.waitForTimeout(60);
    return page.evaluate(() => {
      const a = document.activeElement;
      const focusOn = !a ? "none" : a.closest("#repairDlg") ? "form-link" : a.closest(".sources") ? "sources-link" : a.closest(".legal-foot") ? "panel-link" : a.tagName.toLowerCase();
      const dlg = document.getElementById("legalDlg");
      return { open: dlg.open, repairOpen: document.getElementById("repairDlg").open, locked: document.documentElement.classList.contains("dlg-open"), focusInside: dlg.contains(a), focusOn };
    });
  };
  const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + ".png") });
  const visible = (page, selector) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden"; }, selector);
  const openFromPanel = async (page) => {
    await page.click(PANEL);
    await page.waitForFunction(() => document.getElementById("legalDlg").open);
  };

  try {
    // ============ L. mode local (pas d'API) ============
    {
      const { page, ctx, logs } = await open(browser, withNotice, "index.html", { width: 1440, height: 900 });
      check("L1 the window exists and is closed at load, the page is in local mode", (await state(page)).open === false && (await page.evaluate(() => document.body.dataset.store)) === "local");
      await shot(page, "legal-panel");
      const whole = await axeOf(page, null);
      check("L2b axe: no violation on the whole page with the link at the bottom of the panel (light theme)", whole.length === 0, JSON.stringify(whole));
      check("L2 the link sits at the bottom of the Garages panel from the first screen; the declaration form's link is hidden in local mode", (await visible(page, PANEL)) && !(await visible(page, "#repairDlg [data-open-legal]")));
      {
        // Sous le panneau des résultats, que le script remplit, le lien descendrait de plusieurs lignes au démarrage : il est absent de la mise en page jusque-là.
        const noScript = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 }, locale: "fr-FR" });
        const bareLoad = await noScript.newPage();
        await bareLoad.goto(`${withNotice.url}/index.html`, { waitUntil: "load" });
        const shownBefore = await bareLoad.evaluate((s) => { const e = document.querySelector(s); return !e || e.getClientRects().length > 0; }, PANEL);
        await noScript.close();
        check("L2c the panel link is left out of the layout until the script has built the page (nothing moves under it), then shown", !shownBefore && (await visible(page, PANEL)), String(shownBefore));
      }
      await openFromPanel(page);
      let s = await state(page);
      check("L3 clicking it opens the modal window, scrolling is locked, the focus moves inside it", s.open && s.locked && s.focusInside, JSON.stringify(s));
      const txt = norm(await page.evaluate(() => document.getElementById("legalDlg").innerText));
      check("L4 it shows the editor, the hosting of the pages, a working mailto link to the contact, the update date", txt.includes(LEGAL.editorLine) && txt.includes(LEGAL.hostPages) && txt.includes("3 octobre 2026") && (await page.evaluate(() => [...document.querySelectorAll("#legalDlg a")].some((a) => a.href === "mailto:contact@exemple.test"))), txt.slice(0, 300));
      check("L5 in local mode the declaration sections and the API hosting are hidden, the local-storage sentence is shown", !(await visible(page, "#lg-data")) && !(await visible(page, "#lg-why")) && !(await visible(page, "#lg-keep")) && !txt.includes("API et base de données") && txt.includes("Elles restent dans ce navigateur : rien n'est envoyé à Pixcar") && !txt.includes("24 mois"), txt);
      check("L5b in local mode « Vos droits » says Pixcar receives nothing and still gives the contact; the API-mode promises (reply within a month, retrieval by plate) are absent", txt.includes("Pixcar ne reçoit aucune donnée vous concernant") && !txt.includes("Réponse sous un mois") && !txt.includes("l'immatriculation concernée") && (await visible(page, "#lg-rights")), txt);
      check("L6 every service the page contacts is listed, Google only on a click, no cookie", ["IGN", "Overpass", "Wikimedia", "Recherche d'entreprises", "Avis Google"].every((w) => txt.includes(w)) && txt.includes("Pixcar n'utilise aucun cookie"));
      const v = await axeOf(page, "#legalDlg");
      check("L7 axe: no violation in the open window (light theme)", v.length === 0, JSON.stringify(v));
      const tree = await page.locator("#legalDlg").ariaSnapshot();
      check("L7b the accessibility tree: a dialog named « Confidentialité et mentions légales », and both of its buttons named « Fermer »", /^- dialog "Confidentialité et mentions légales"/.test(tree) && (tree.match(/- button "Fermer"/g) || []).length === 2, tree.slice(0, 300));
      await shot(page, "legal-desktop-light");
      await page.click("#legalDlg .dlg-close");
      s = await state(page);
      check("L8 the × button closes it, unlocks scrolling and gives the focus back to the link", !s.open && !s.locked && s.focusOn === "panel-link", JSON.stringify(s));
      await openFromPanel(page);
      await page.keyboard.press("Escape");
      s = await state(page);
      check("L9 Escape closes it too, the focus returns to the link", !s.open && !s.locked && s.focusOn === "panel-link", JSON.stringify(s));
      await openFromPanel(page);
      await page.click("#legalTitle");
      check("L10 a click inside the window does not close it", (await state(page)).open);
      await page.mouse.click(4, 4);
      s = await state(page);
      check("L11 a click on the backdrop closes it", !s.open && !s.locked, JSON.stringify(s));
      await openFromPanel(page);
      await page.evaluate(() => (document.getElementById("legalDlg").scrollTop = 600));
      await page.click("#legalDlg .dlg-actions .primary");
      check("L12 the « Fermer » button closes it", !(await state(page)).open);
      await openFromPanel(page);
      check("L12b reopened, it starts again at the top", (await page.evaluate(() => document.getElementById("legalDlg").scrollTop)) === 0);
      await page.keyboard.press("Escape");
      // « Prix et promos » : le lien de « Sources et méthode »
      await page.click('#tabs [data-view="prix"]');
      await page.click(".sources summary");
      await page.click(".sources [data-open-legal]");
      await page.waitForFunction(() => document.getElementById("legalDlg").open);
      await page.keyboard.press("Escape");
      s = await state(page);
      check("L13 « Sources et méthode » links to it as well, and the focus returns there", !s.open && s.focusOn === "sources-link", JSON.stringify(s));
      check("L14 opening and closing it again and again leaves nothing behind (no script error, one window)", logs.errors.length === 0 && (await page.evaluate(() => document.querySelectorAll("#legalDlg").length)) === 1, logs.errors.join("|"));
      await ctx.close();
    }

    // ============ D. thème sombre ============
    {
      const { page, ctx } = await open(browser, withNotice, "index.html", { width: 1440, height: 900, colorScheme: "dark" });
      const whole = await axeOf(page, null);
      check("D0 axe: no violation on the whole page with the link at the bottom of the panel (dark theme)", whole.length === 0, JSON.stringify(whole));
      await openFromPanel(page);
      const v = await axeOf(page, "#legalDlg");
      check("D1 axe: no violation in the open window (dark theme)", v.length === 0, JSON.stringify(v));
      await shot(page, "legal-desktop-dark");
      await ctx.close();
    }

    // ============ M. mode API ============
    {
      const { page, ctx, logs } = await open(browser, withNotice, "index.html", { width: 1440, height: 900, initScript: REMOTE });
      check("M1 the page is in API mode", (await page.evaluate(() => document.body.dataset.store)) === "remote");
      await openFromPanel(page);
      const txt = norm(await page.evaluate(() => document.getElementById("legalDlg").innerText));
      check("M2 the declaration sections are shown: what is stored (fingerprints), why, how long (24 months declared, 30 days IP, backups)", (await visible(page, "#lg-data")) && (await visible(page, "#lg-why")) && (await visible(page, "#lg-keep")) && /24 mois après leur dépôt/.test(txt) && /Empreintes d'adresses IP : 30 jours/.test(txt) && /Sauvegardes de la base : 30 jours/.test(txt), txt.slice(0, 400));
      check("M3 the API hosting and the rights section with a mailto link to the contact are shown, the local-only sentence is not", txt.includes("API et base de données") && txt.includes("Vos droits") && txt.includes("Réponse sous un mois") && (await page.evaluate(() => !!document.querySelector('section[aria-labelledby="lg-rights"] a[href="mailto:contact@exemple.test"]'))) && !txt.includes("Elles restent dans ce navigateur : rien n'est envoyé à Pixcar") && !txt.includes("Pixcar ne reçoit aucune donnée vous concernant"), txt);
      const v = await axeOf(page, "#legalDlg");
      check("M4 axe: no violation with the API-mode sections", v.length === 0, JSON.stringify(v));
      await shot(page, "legal-desktop-api");
      await page.keyboard.press("Escape");
      // depuis le formulaire de déclaration, par-dessus lequel la fenêtre s'ouvre
      await page.click("#addRepairBtn");
      await page.waitForFunction(() => document.getElementById("repairDlg").open);
      check("M5 the declaration form carries the link in API mode", await visible(page, "#repairDlg [data-open-legal]"));
      await shot(page, "legal-form-link");
      await page.click("#repairDlg [data-open-legal]");
      await page.waitForFunction(() => document.getElementById("legalDlg").open);
      let s = await state(page);
      check("M6 the window opens above the form, which stays open underneath", s.open && s.repairOpen && s.locked && s.focusInside, JSON.stringify(s));
      await page.keyboard.press("Escape");
      s = await state(page);
      check("M7 Escape closes only the window: the form stays open, scrolling stays locked, the focus returns to the form's link", !s.open && s.repairOpen && s.locked && s.focusOn === "form-link", JSON.stringify(s));
      check("M8 no script error with the API address unreachable", logs.errors.length === 0, logs.errors.join("|"));
      await ctx.close();
    }

    // ============ T. téléphone ============
    {
      const { page, ctx } = await open(browser, withNotice, "index.html", { width: 390, height: 844, touch: true, initScript: REMOTE });
      await openFromPanel(page);
      await page.waitForTimeout(450); // la feuille glisse et apparaît en 0,3 s : mesurer et photographier une fois posée
      const geo = await page.evaluate(() => {
        const d = document.getElementById("legalDlg"), r = d.getBoundingClientRect(), close = d.querySelector(".dlg-close").getBoundingClientRect();
        return { w: Math.round(r.width), vw: innerWidth, h: Math.round(r.height), vh: innerHeight, scrolls: d.scrollHeight > d.clientHeight, closeTop: Math.round(close.top), closeH: Math.round(close.height), overflowX: d.scrollWidth > d.clientWidth };
      });
      check("T1 on a phone it is a full-width sheet that fits the screen, scrolls (long text) without sideways scrolling, with a 44 px close button in view", geo.w === geo.vw && geo.h <= geo.vh && geo.scrolls && !geo.overflowX && geo.closeTop >= 0 && geo.closeH >= 44, JSON.stringify(geo));
      await shot(page, "legal-phone");
      await page.evaluate(() => (document.getElementById("legalDlg").scrollTop = 1e6));
      const inView = await page.evaluate(() => { const b = document.querySelector("#legalDlg .dlg-actions .primary").getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight; });
      check("T2 scrolled to the end, the « Fermer » button is reachable", inView);
      const v = await axeOf(page, "#legalDlg");
      check("T3 axe: no violation on a phone", v.length === 0, JSON.stringify(v));
      await ctx.close();
    }

    // ============ F. navigateur sans showModal(), close() ni method="dialog" (anciens navigateurs) ============
    {
      const { page, ctx } = await open(browser, withNotice, "index.html", { width: 1440, height: 900, initScript: "delete HTMLDialogElement.prototype.showModal; delete HTMLDialogElement.prototype.close;" });
      await page.evaluate(() => {
        window.__same = 1; // la page n'est pas rechargée
        document.querySelector("#legalDlg form").setAttribute("method", "get"); // un navigateur qui ne connaît pas method="dialog" enverrait le formulaire
      });
      const read = () => page.evaluate(() => ({ open: document.getElementById("legalDlg").hasAttribute("open"), locked: document.documentElement.classList.contains("dlg-open"), same: window.__same === 1 }));
      await page.click(PANEL);
      let s = await read();
      check("F1 without showModal() the window still opens (plain open attribute) and scrolling is locked", s.open && s.locked, JSON.stringify(s));
      await page.click("#legalDlg .dlg-close");
      s = await read();
      check("F2 without close() the × button still closes it and releases the lock, and the form does not reload the page", !s.open && !s.locked && s.same, JSON.stringify(s));
      await page.click(PANEL);
      await page.click("#legalDlg .dlg-actions .primary");
      s = await read();
      check("F3 reopened, the « Fermer » button closes it the same way", !s.open && !s.locked && s.same, JSON.stringify(s));
      await ctx.close();
    }

    // ============ N. sans mentions légales ============
    for (const [label, init] of [["local", ""], ["API", REMOTE]]) {
      const { page, ctx } = await open(browser, without, "index.html", { width: 1440, height: 900, initScript: init });
      const found = await page.evaluate(() => ({ dialog: !!document.getElementById("legalDlg"), links: document.querySelectorAll("[data-open-legal]").length, foot: !!document.querySelector(".legal-foot") }));
      check(`N1 incomplete src/legal.json, ${label} mode: no window, no link, nothing to click`, !found.dialog && found.links === 0 && !found.foot, JSON.stringify(found));
      await ctx.close();
    }
  } catch (e) {
    check("legal section crashed", false, e && e.stack);
  } finally {
    await browser.close();
    withNotice.close();
    without.close();
  }
  const bad = results.filter((r) => !r.ok);
  console.log(`\n[legal] ${results.length - bad.length}/${results.length} checks passed`);
  bad.forEach((b) => console.log("  ✗", b.name));
  process.exit(bad.length ? 1 : 0);
})();
