// Vehicle block of the repair form: plate (AB-123-CD), model with suggestions, model year.
// Usage: node veh.js [file] [only-section-letters]   (file defaults to index.html; run it on an older build / mutants to see checks fail)
//   P plate mask · V validation · Y year · M model suggestions · C catalogue · S storage, prefill, display, privacy · L layout, a11y
const { serve, launch, open, search, SHOTS, ROOT, injectScript } = require("./harness");
const { buildElements } = require("./mocks");
const fs = require("fs");
const path = require("path");

const FILE = process.argv[2] || "index.html";
const ONLY = (process.argv[3] || "PVYMCSL").toUpperCase();
const AXE = fs.readFileSync(path.join(__dirname, "..", "node_modules/axe-core/axe.min.js"), "utf8");
const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond });
  if (!cond) console.log("  FAIL:", name, "|", String(detail).slice(0, 500));
};
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
const has = (s) => ONLY.includes(s);
const J = JSON.stringify;

const REPAIRS = [
  { id: "r1", garageId: "osm:node/1022", garageName: "Norauto Bron", garageAddr: "98 rue Marcel Mérieux, 69100 Bron", lat: null, lon: null, chainId: "norauto", model: "Peugeot 208", immat: "EZ-108-BC", year: 2019, rating: 4, serviceId: "vidange", price: 59.9, date: "2026-09-12", comment: "RAS", createdAt: "2026-09-12T10:00:00Z" },
  { id: "r2", garageId: "osm:node/1022", garageName: "Norauto Bron", garageAddr: "98 rue Marcel Mérieux, 69100 Bron", lat: null, lon: null, chainId: "norauto", model: "Renault Clio", rating: 5, serviceId: "vidange", price: 72, date: "2026-08-02", comment: "", createdAt: "2026-08-02T10:00:00Z" },
  { id: "r3", garageId: "custom:garage-du-coin", garageName: "Garage du Coin", garageAddr: "", lat: null, lon: null, chainId: "", model: "Dacia Sandero", rating: 3, serviceId: "plaq_av", price: 140, date: "2026-07-05", comment: "Un peu long", createdAt: "2026-07-05T10:00:00Z" },
  { id: "r4", garageId: "osm:node/1022", garageName: "Norauto Bron", garageAddr: "98 rue Marcel Mérieux, 69100 Bron", lat: null, lon: null, chainId: "norauto", model: "Citroën C3", rating: 4, serviceId: "vidange", price: 119, date: "2026-06-02", comment: "", createdAt: "2026-06-02T10:00:00Z" },
];
// today is 2026-10-01 in the harness
const TODAY_YEAR = 2026;

(async () => {
  const server = await serve(ROOT);
  const browser = await launch({ scrollbars: true });
  const els = buildElements();
  const dlg = async (o = {}) => {
    const r = await open(browser, server, FILE, { width: 1440, height: 900, mock: { elements: els }, ...o });
    await r.page.click("#addRepairBtn");
    await r.page.waitForTimeout(300);
    return r;
  };
  const items = (page) => page.$$eval("#rModelList li", (l) => l.map((x) => x.querySelector(".s-main").textContent));
  const listOpen = (page) => page.$eval("#rModelList", (l) => !l.hidden);
  const errText = (page, id) => page.$eval(id, (e) => (e.hidden ? "" : e.textContent.trim()));
  const invalid = (page, sel) => page.$eval(sel, (e) => e.getAttribute("aria-invalid") === "true");
  const sel = (page, sel_) => page.$eval(sel_, (e) => [e.selectionStart, e.selectionEnd]);
  const active = (page) => page.evaluate(() => document.activeElement && document.activeElement.id);
  const fillOk = async (page) => {
    await page.fill("#rGarage", "Garage du Coin");
    await page.fill("#rPrice", "59,90");
    await page.click("label[for=rSt4]");
  };

  // =============== P. Plate mask ===============
  if (has("P")) try {
    const { page, ctx, logs } = await dlg();
    const table = [
      ["ez108bc", "EZ-108-BC"], ["EZ-108-BC", "EZ-108-BC"], [" ez 108 bc ", "EZ-108-BC"], ["ez.108.bc", "EZ-108-BC"], ["EZ_108/BC", "EZ-108-BC"],
      ["ez‑108‑bc", "EZ-108-BC"], ["EZ108BCX", "EZ-108-BC"], ["ab12", "AB-12"], ["ab", "AB"], ["a", "A"], ["", ""], ["io123uu", "IO-123-UU"],
      ["1234AB56", "AB-56"], ["EZ-18-BC", "EZ-18-BC"], ["E-108-BC", "E-108-BC"], ["ez  -  108 - bc", "EZ-108-BC"],
    ];
    for (const [raw, want] of table) {
      await page.fill("#rPlate", raw);
      const got = await page.inputValue("#rPlate");
      check(`P1 fill ${J(raw)} → ${J(want)}`, got === want, got);
    }
    // keystrokes, one by one
    await page.fill("#rPlate", "");
    await page.focus("#rPlate");
    const seen = [];
    for (const c of "ez108bc") { await page.keyboard.type(c); seen.push(await page.inputValue("#rPlate")); }
    check("P2 typing ez108bc key by key shows E, EZ, EZ-1, EZ-10, EZ-108, EZ-108-B, EZ-108-BC", J(seen) === J(["E", "EZ", "EZ-1", "EZ-10", "EZ-108", "EZ-108-B", "EZ-108-BC"]), J(seen));
    check("P3 caret stays at the end while typing at the end", J(await sel(page, "#rPlate")) === J([9, 9]), J(await sel(page, "#rPlate")));
    const back = [];
    for (let i = 0; i < 8; i++) { await page.keyboard.press("Backspace"); back.push(await page.inputValue("#rPlate")); }
    check("P4 Backspace walks back one character at a time, dashes never trap it", J(back) === J(["EZ-108-B", "EZ-108", "EZ-10", "EZ-1", "EZ", "E", "", ""]), J(back));
    // explicit dash typed after the first group is accepted silently (the dash is re-added with the next character)
    await page.fill("#rPlate", "");
    await page.focus("#rPlate");
    await page.keyboard.type("ez-");
    check("P5 typing « ez- » keeps « EZ » (no dangling dash) and raises no message", (await page.inputValue("#rPlate")) === "EZ" && !(await errText(page, "#rPlateErr")), await page.inputValue("#rPlate"));
    await page.keyboard.type("1");
    check("P5b … then « 1 » gives « EZ-1 »", (await page.inputValue("#rPlate")) === "EZ-1");
    // wrong class of character: refused, with a reminder of the format
    await page.fill("#rPlate", "");
    await page.focus("#rPlate");
    await page.keyboard.type("1");
    const m1 = await errText(page, "#rPlateErr");
    check("P6 a digit where letters are expected is refused", (await page.inputValue("#rPlate")) === "", await page.inputValue("#rPlate"));
    check("P6b … with a visible reminder of the format and aria-invalid", /AB-123-CD/.test(m1) && /2 lettres, 3 chiffres, 2 lettres/.test(m1) && (await invalid(page, "#rPlate")), m1);
    const say = () => page.$eval("#rPlateSay", (e) => e.textContent.trim());
    const sayAttrs = await page.$eval("#rPlateSay", (e) => ({ role: e.getAttribute("role"), live: e.getAttribute("aria-live"), shown: e.getBoundingClientRect().width <= 1 }));
    check("P6d the refused keystroke is also announced (polite status region, visually hidden)", /AB-123-CD/.test(await say()) && sayAttrs.role === "status" && sayAttrs.live === "polite" && sayAttrs.shown, J({ s: await say(), sayAttrs }));
    await page.keyboard.type("e");
    check("P6e … and the announcement is emptied by the next accepted character", (await say()) === "", await say());
    check("P6c the next accepted character clears the reminder", (await page.inputValue("#rPlate")) === "E" && !(await errText(page, "#rPlateErr")) && !(await invalid(page, "#rPlate")), await errText(page, "#rPlateErr"));
    await page.keyboard.type("z1x");
    check("P7 a letter in the digits is refused, the digit before it is kept", (await page.inputValue("#rPlate")) === "EZ-1" && !!(await errText(page, "#rPlateErr")), await page.inputValue("#rPlate"));
    await page.fill("#rPlate", "EZ-108-BC");
    await page.focus("#rPlate");
    await page.keyboard.press("End");
    await page.keyboard.type("X");
    check("P8 an 8th character is refused (value unchanged, reminder shown)", (await page.inputValue("#rPlate")) === "EZ-108-BC" && !!(await errText(page, "#rPlateErr")), await page.inputValue("#rPlate"));
    await page.keyboard.press("Backspace");
    check("P8b editing again clears the reminder", !(await errText(page, "#rPlateErr")));
    await page.keyboard.type("é");
    check("P9 an accented letter is refused (AZERTY keys without Shift give é, à, ç…)", (await page.inputValue("#rPlate")) === "EZ-108-B" && !!(await errText(page, "#rPlateErr")), await page.inputValue("#rPlate"));
    await page.keyboard.press("Tab");
    check("P10 leaving the field removes the typing reminder (it only describes the keystroke)", !(await errText(page, "#rPlateErr")) && !(await invalid(page, "#rPlate")) && (await say()) === "");
    // in-place edits keep the groups where they are
    await page.fill("#rPlate", "EZ-108-BC");
    await page.evaluate(() => { const e = document.getElementById("rPlate"); e.focus(); e.setSelectionRange(4, 5); });
    await page.keyboard.type("1");
    check("P11 overtyping the middle digit gives EZ-118-BC with the caret after it", (await page.inputValue("#rPlate")) === "EZ-118-BC" && J(await sel(page, "#rPlate")) === J([5, 5]), `${await page.inputValue("#rPlate")} ${J(await sel(page, "#rPlate"))}`);
    await page.evaluate(() => { const e = document.getElementById("rPlate"); e.setSelectionRange(5, 5); });
    await page.keyboard.press("Backspace");
    check("P12 Backspace inside the digits keeps BC where it is (EZ-18-BC)", (await page.inputValue("#rPlate")) === "EZ-18-BC" && J(await sel(page, "#rPlate")) === J([4, 4]), `${await page.inputValue("#rPlate")} ${J(await sel(page, "#rPlate"))}`);
    await page.keyboard.type("0");
    check("P12b … and retyping the digit restores EZ-108-BC", (await page.inputValue("#rPlate")) === "EZ-108-BC" && J(await sel(page, "#rPlate")) === J([5, 5]), `${await page.inputValue("#rPlate")} ${J(await sel(page, "#rPlate"))}`);
    // the caret stays at the edit when the mask rewrites the value
    await page.fill("#rPlate", "AB");
    await page.evaluate(() => { const e = document.getElementById("rPlate"); e.focus(); e.setSelectionRange(1, 1); });
    await page.keyboard.type("1");
    check("P11c a refused digit typed inside « AB » leaves the caret where it was (after A)", (await page.inputValue("#rPlate")) === "AB" && J(await sel(page, "#rPlate")) === J([1, 1]), `${await page.inputValue("#rPlate")} ${J(await sel(page, "#rPlate"))}`);
    await page.fill("#rPlate", "EZ-108-BC");
    await page.evaluate(() => { const e = document.getElementById("rPlate"); e.focus(); e.setSelectionRange(0, 0); });
    await page.keyboard.type("a");
    check("P11d a letter typed at the start: the mask rewrites the value (AE-108-BC), the caret stays after the new letter", (await page.inputValue("#rPlate")) === "AE-108-BC" && J(await sel(page, "#rPlate")) === J([1, 1]), `${await page.inputValue("#rPlate")} ${J(await sel(page, "#rPlate"))}`);
    // paste over a selection
    await page.evaluate(() => { const e = document.getElementById("rPlate"); e.focus(); e.select(); document.execCommand("insertText", false, "ab 123 cd"); });
    check("P13 pasting « ab 123 cd » over the selection gives AB-123-CD", (await page.inputValue("#rPlate")) === "AB-123-CD", await page.inputValue("#rPlate"));
    // keyboard composition (some Android keyboards build words): nothing is rewritten until it ends
    await page.fill("#rPlate", "");
    await page.evaluate(() => { const e = document.getElementById("rPlate"); e.focus(); e.value = "ez108"; e.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true })); });
    const mid = await page.inputValue("#rPlate");
    await page.evaluate(() => document.getElementById("rPlate").dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "ez108" })));
    check("P16 during a keyboard composition the value is left alone, then masked when it ends", mid === "ez108" && (await page.inputValue("#rPlate")) === "EZ-108", `${mid} → ${await page.inputValue("#rPlate")}`);
    // attributes
    const at = await page.$eval("#rPlate", (e) => ({ ac: e.autocomplete, cap: e.getAttribute("autocapitalize"), sp: e.spellcheck, ph: e.placeholder, label: (document.querySelector('label[for="rPlate"]') || {}).textContent, type: e.type, desc: e.getAttribute("aria-describedby").split(" ").every((i) => document.getElementById(i)) }));
    check("P14 attributes: autocomplete off, capitals, no spellcheck, example placeholder, label, described by", at.ac === "off" && at.cap === "characters" && at.sp === false && at.ph === "EZ-108-BC" && norm(at.label) === "Immatriculation" && at.type === "text" && at.desc, J(at));
    check("P15 console clean", logs.console.length === 0 && logs.errors.length === 0, J([logs.console, logs.errors]));
    await ctx.close();
  } catch (e) {
    check("P section crashed", false, e && e.stack);
  }

  // =============== V. Validation on submit ===============
  if (has("V")) try {
    let { page, ctx, logs } = await dlg();
    await page.click("#repairForm button[type=submit]");
    const e0 = { plate: await errText(page, "#rPlateErr"), year: await errText(page, "#rYearErr"), model: await errText(page, "#rModelErr") };
    check("V1 empty submit: plate, year and model are flagged with their own message", e0.plate === "Indiquez l'immatriculation du véhicule." && e0.year === "Indiquez l'année du modèle." && /modèle du véhicule/.test(e0.model), J(e0));
    check("V2 … and marked aria-invalid", (await invalid(page, "#rPlate")) && (await invalid(page, "#rYear")) && (await invalid(page, "#rModel")));
    check("V3 the dialog stays open", await page.$eval("#repairDlg", (d) => d.open));
    // focus goes to the first invalid control, in screen order: garage, model, plate, year, price
    await page.fill("#rGarage", "Garage du Coin");
    await page.click("#repairForm button[type=submit]");
    check("V4 first invalid control gets the focus (model)", (await active(page)) === "rModel", await active(page));
    await page.fill("#rModel", "peugeot 208");
    await page.click("#repairForm button[type=submit]");
    check("V5 … then the plate", (await active(page)) === "rPlate", await active(page));
    await page.fill("#rPlate", "ez10");
    await page.click("#repairForm button[type=submit]");
    const pe = await errText(page, "#rPlateErr");
    check("V6 incomplete plate: « incomplète » with the expected format", /Immatriculation incomplète/.test(pe) && /AB-123-CD/.test(pe) && /2 lettres, 3 chiffres, 2 lettres/.test(pe), pe);
    check("V6b … and focus stays on the plate", (await active(page)) === "rPlate");
    await page.fill("#rPlate", "ez-18-bc");
    check("V6c the mask keeps typed separators, so a short middle group stays visible…", (await page.inputValue("#rPlate")) === "EZ-18-BC", await page.inputValue("#rPlate"));
    await page.click("#repairForm button[type=submit]");
    check("V6d … and is refused on submit (3 digits are required)", /Immatriculation incomplète/.test(await errText(page, "#rPlateErr")) && (await page.$eval("#repairDlg", (d) => d.open)), await errText(page, "#rPlateErr"));
    await page.fill("#rPlate", "ez108bc");
    check("V7 correcting the plate clears its error", !(await errText(page, "#rPlateErr")) && !(await invalid(page, "#rPlate")));
    await page.click("#repairForm button[type=submit]");
    check("V8 … then the year", (await active(page)) === "rYear", await active(page));
    await page.fill("#rYear", "2019");
    await page.click("#repairForm button[type=submit]");
    check("V9 … then the price", (await active(page)) === "rPrice", await active(page));
    check("V9b … which says what is missing", /Indiquez le prix payé/.test(await errText(page, "#rPriceErr")), await errText(page, "#rPriceErr"));
    await page.fill("#rPrice", "0,5");
    await page.click("#repairForm button[type=submit]");
    check("V9c under 1 €: refused with the minimum (the API and the database refuse it too)", /1 € au minimum/.test(norm(await errText(page, "#rPriceErr"))) && (await page.$eval("#repairDlg", (d) => d.open)), await errText(page, "#rPriceErr"));
    await page.fill("#rPrice", "25000");
    await page.click("#repairForm button[type=submit]");
    check("V9d above 20 000 €: refused with the maximum", /20.000 € au maximum/.test(norm(await errText(page, "#rPriceErr"))), await errText(page, "#rPriceErr"));
    await page.fill("#rPrice", "59,90");
    await page.click("label[for=rSt4]");
    await page.click("#repairForm button[type=submit]");
    await page.waitForTimeout(300);
    check("V10 complete form: saved, dialog closed", !(await page.$eval("#repairDlg", (d) => d.open)) && /Réparation enregistrée/.test(norm(await page.textContent("#toast"))));
    const st = await page.evaluate(() => JSON.parse(localStorage.getItem("jg.repairs.v1") || "[]"));
    check("V11 saved record: model, plate (uppercase, dashes), year as a number", st.length === 1 && st[0].model === "Peugeot 208" && st[0].immat === "EZ-108-BC" && st[0].year === 2019 && typeof st[0].year === "number", J(st));
    check("V12 console clean", logs.console.length === 0 && logs.errors.length === 0, J([logs.console, logs.errors]));
    await ctx.close();
  } catch (e) {
    check("V section crashed", false, e && e.stack);
  }

  // =============== Y. Year ===============
  if (has("Y")) try {
    const { page, ctx } = await dlg();
    for (const [raw, want] of [["2019", "2019"], ["20a19", "2019"], ["20191", "2019"], [" 2 0 1 9 ", "2019"], ["abcd", ""], ["", ""]]) {
      await page.fill("#rYear", raw);
      check(`Y1 fill ${J(raw)} → ${J(want)} (digits only, 4 at most)`, (await page.inputValue("#rYear")) === want, await page.inputValue("#rYear"));
    }
    const at = await page.$eval("#rYear", (e) => ({ mode: e.inputMode, max: e.maxLength, type: e.type, ac: e.autocomplete, label: (document.querySelector('label[for="rYear"]') || {}).textContent, desc: e.getAttribute("aria-describedby").split(" ").every((i) => document.getElementById(i)) }));
    check("Y2 attributes: numeric keyboard, text field without maxlength (a paste is cleaned first, then cut to 4), label « Année du modèle », described by", at.mode === "numeric" && at.max === -1 && at.type === "text" && at.ac === "off" && norm(at.label) === "Année du modèle" && at.desc, J(at));
    await fillOk(page);
    await page.fill("#rModel", "peugeot 208");
    await page.fill("#rPlate", "ez108bc");
    const submit = async (year, date) => {
      await page.fill("#rYear", year);
      if (date) await page.fill("#rDate", date);
      await page.click("#repairForm button[type=submit]");
      return { err: await errText(page, "#rYearErr"), open: await page.$eval("#repairDlg", (d) => d.open), bad: await invalid(page, "#rYear") };
    };
    let r = await submit("", "2026-10-01");
    check("Y3 empty year", r.err === "Indiquez l'année du modèle." && r.bad && r.open, J(r));
    r = await submit("201", "2026-10-01");
    check("Y4 3 digits: « Année non reconnue. Exemple : 2019. »", r.err === "Année non reconnue. Exemple : 2019." && r.open, J(r));
    r = await submit("1949", "2026-10-01");
    check("Y5 1949 is too old (between 1950 and the current year)", r.err === `L'année du modèle doit être comprise entre 1950 et ${TODAY_YEAR}.` && r.open, J(r));
    r = await submit(String(TODAY_YEAR + 1), "2026-10-01");
    check("Y6 next year is refused", r.err === `L'année du modèle doit être comprise entre 1950 et ${TODAY_YEAR}.` && r.open, J(r));
    r = await submit("2021", "2020-06-01");
    check("Y7 a model year after the repair date is refused", /ne peut pas être postérieure à la date de la réparation/.test(r.err) && r.open, J(r));
    await page.fill("#rDate", "2022-01-01");
    check("Y8 moving the date past the year clears the message and the red border (no stale error)", !(await errText(page, "#rYearErr")) && !(await invalid(page, "#rYear")), await errText(page, "#rYearErr"));
    await page.fill("#rDate", "2020-06-01");
    check("Y9 once cleared, moving the date back raises nothing by itself (messages come with the submit)…", !(await errText(page, "#rYearErr")));
    r = await submit("2021", "2020-06-01");
    check("Y9b … the submit raises it again", /postérieure/.test(r.err) && r.open, J(r));
    await page.fill("#rYear", "2020");
    check("Y10 typing in the year clears its message", !(await errText(page, "#rYearErr")));
    r = await submit("2020", "2020-06-01");
    check("Y11 same year as the repair date is fine → saved", !r.open && !r.err, J(r));
    await ctx.close();
    // boundaries
    for (const [y, ok] of [[1950, true], [2026, true], [1949, false]]) {
      const { page: p2, ctx: c2 } = await dlg();
      await fillOk(p2);
      await p2.fill("#rModel", "peugeot 208");
      await p2.fill("#rPlate", "ez108bc");
      await p2.fill("#rYear", String(y));
      await p2.fill("#rDate", "2026-10-01");
      await p2.click("#repairForm button[type=submit]");
      await p2.waitForTimeout(150);
      check(`Y12 year ${y} is ${ok ? "accepted" : "refused"}`, ok === !(await p2.$eval("#repairDlg", (d) => d.open)));
      await c2.close();
    }
  } catch (e) {
    check("Y section crashed", false, e && e.stack);
  }

  // =============== M. Model suggestions ===============
  if (has("M")) try {
    let { page, ctx, logs } = await dlg();
    const q = async (text) => { await page.fill("#rModel", text); return items(page); };
    let l = await q("208");
    check("M1 « 208 » → Peugeot 208 first, then e-208 (not the 2008)", l[0] === "Peugeot 208" && l.includes("Peugeot e-208") && !l.includes("Peugeot 2008"), J(l));
    l = await q("clio");
    check("M2 « clio » → Renault Clio", J(l) === J(["Renault Clio"]), J(l));
    l = await q("citroen c3");
    check("M3 no accents needed: « citroen c3 » → Citroën C3 first, then its variants", l[0] === "Citroën C3" && ["Citroën C3 Aircross", "Citroën C3 Picasso", "Citroën C3 Pluriel"].every((n) => l.includes(n)), J(l));
    l = await q("CITROËN c3");
    check("M3b capitals and accents typed: « CITROËN c3 » → Citroën C3 first", l[0] === "Citroën C3", J(l));
    l = await q("mercedes cla");
    check("M4 « mercedes cla » → Mercedes CLA before the Classe models", l[0] === "Mercedes CLA" && l.slice(1).every((n) => /^Mercedes Classe/.test(n)), J(l));
    l = await q("vw golf");
    check("M5 « vw golf » → Volkswagen Golf first", l[0] === "Volkswagen Golf", J(l));
    l = await q("mercedes-benz classe c");
    check("M5b « mercedes-benz classe c » → Mercedes Classe C first", l[0] === "Mercedes Classe C", J(l));
    l = await q("chr");
    check("M6 « chr » finds Toyota C-HR (collée)", l.includes("Toyota C-HR"), J(l));
    l = await q("etron");
    check("M6b « etron » finds Audi e-tron", l.includes("Audi e-tron"), J(l));
    l = await q("bmw serie");
    check("M7 « bmw serie » (no accent) → the BMW Série models, in order", l.slice(0, 3).join() === ["BMW Série 1", "BMW Série 2", "BMW Série 3"].join(), J(l));
    l = await q("série 3");
    check("M7a « série 3 » (accent typed) → BMW Série 3 first", l[0] === "BMW Série 3", J(l));
    l = await q("serie");
    check("M7b « série » alone lists BMW Série models, numbers in order", l.slice(0, 4).join() === ["BMW Série 1", "BMW Série 2", "BMW Série 3", "BMW Série 4"].join(), J(l));
    l = await q("renault");
    check("M8 a brand lists its most common models first (Clio, Mégane, Scénic…)", l.slice(0, 3).join() === ["Renault Clio", "Renault Mégane", "Renault Scénic"].join(), J(l));
    check("M9 at most 12 suggestions", l.length === 12, l.length);
    l = await q("zzzz");
    check("M10 nothing matches → list closed, aria-expanded false", l.length === 0 && !(await listOpen(page)) && (await page.getAttribute("#rModel", "aria-expanded")) === "false");
    l = await q("zz");
    await page.fill("#rModel", "tesla");
    l = await items(page);
    check("M11 « tesla » → its 4 models", l.length === 4 && l.every((n) => /^Tesla Model/.test(n)), J(l));
    // keyboard
    await page.fill("#rModel", "pe");
    check("M12 list open: input is a combobox, aria-expanded true, controls the listbox", (await listOpen(page)) && (await page.getAttribute("#rModel", "aria-expanded")) === "true" && (await page.getAttribute("#rModel", "aria-controls")) === "rModelList" && (await page.getAttribute("#rModel", "role")) === "combobox" && (await page.getAttribute("#rModelList", "role")) === "listbox");
    check("M12b options are role=option with unique ids, none selected yet", await page.$$eval("#rModelList li", (l) => l.every((x) => x.getAttribute("role") === "option" && x.getAttribute("aria-selected") === "false") && new Set(l.map((x) => x.id)).size === l.length));
    await page.keyboard.press("ArrowDown");
    let a = await page.evaluate(() => ({ id: document.getElementById("rModel").getAttribute("aria-activedescendant"), sel: [...document.querySelectorAll("#rModelList li")].map((x) => x.getAttribute("aria-selected")) }));
    check("M13 ArrowDown selects the first option and points aria-activedescendant at it", a.id === "ms-0" && a.sel[0] === "true" && a.sel.filter((x) => x === "true").length === 1, J(a));
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    a = await page.evaluate(() => document.getElementById("rModel").getAttribute("aria-activedescendant"));
    check("M14 ArrowDown ×3 then ArrowUp → second option", a === "ms-1", a);
    await page.keyboard.press("Enter");
    check("M15 Enter picks the active option, closes the list, keeps the dialog open", (await page.inputValue("#rModel")) === "Peugeot 308" && !(await listOpen(page)) && (await page.$eval("#repairDlg", (d) => d.open)), await page.inputValue("#rModel"));
    check("M15b … and the focus stays in the field", (await active(page)) === "rModel");
    await page.keyboard.press("Enter");
    check("M15c a second Enter (nothing active) moves on to the plate, without submitting the form", (await active(page)) === "rPlate" && (await page.$eval("#repairDlg", (d) => d.open)) && !(await invalid(page, "#rGarage")), await active(page));
    await page.fill("#rModel", "pe");
    await page.keyboard.press("Enter");
    check("M15d Enter with the list open and no active option closes it, keeps what was typed and moves on", (await active(page)) === "rPlate" && !(await listOpen(page)) && (await page.inputValue("#rModel")) === "Pe", `${await active(page)} ${await page.inputValue("#rModel")}`);
    await page.fill("#rModel", "pe");
    await page.keyboard.press("ArrowUp");
    a = await page.evaluate(() => ({ id: document.getElementById("rModel").getAttribute("aria-activedescendant"), n: document.querySelectorAll("#rModelList li").length }));
    check("M16 ArrowUp from nothing goes to the last option", a.id === `ms-${a.n - 1}`, J(a));
    check("M16b … and the last option is scrolled into view inside the list", await page.evaluate(() => { const b = document.getElementById("rModelList"), li = b.querySelector('li[aria-selected="true"]'); return li.offsetTop >= b.scrollTop - 1 && li.offsetTop + li.offsetHeight <= b.scrollTop + b.clientHeight + 1; }));
    await page.keyboard.press("ArrowDown");
    check("M16c ArrowDown from the last option wraps to the first", (await page.getAttribute("#rModel", "aria-activedescendant")) === "ms-0");
    await page.keyboard.press("Escape");
    check("M17 first Escape closes the list only", !(await listOpen(page)) && (await page.$eval("#repairDlg", (d) => d.open)));
    await page.waitForTimeout(250);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    check("M17b … the second one closes the dialog", !(await page.$eval("#repairDlg", (d) => d.open)));
    await ctx.close();
    // mouse
    ({ page, ctx, logs } = await dlg());
    await page.fill("#rModel", "golf");
    await page.click("#rModelList li:nth-child(2)");
    check("M18 clicking an option picks it and keeps the field focused", (await page.inputValue("#rModel")) === "Volkswagen Golf Plus" && (await active(page)) === "rModel" && !(await listOpen(page)), `${await page.inputValue("#rModel")} ${await active(page)}`);
    check("M18b a picked value is not rewritten on blur", await (async () => { await page.keyboard.press("Tab"); return (await page.inputValue("#rModel")) === "Volkswagen Golf Plus"; })());
    await page.fill("#rModel", "");
    l = await items(page);
    check("M19 empty field, nothing declared yet: the 12 most common models (Clio, 208, C3 first)", l.length === 12 && l.slice(0, 3).join() === ["Renault Clio", "Peugeot 208", "Citroën C3"].join() && (await listOpen(page)), J(l));
    await page.keyboard.press("Tab");
    await page.waitForTimeout(250);
    check("M19b leaving the field closes the list", !(await listOpen(page)));
    await page.click("#rModel");
    check("M19c clicking into the empty field shows the list again", (await listOpen(page)) && (await items(page)).length === 12);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    check("M19d ArrowDown + Enter picks the first common model", (await page.inputValue("#rModel")) === "Renault Clio" && !(await listOpen(page)), await page.inputValue("#rModel"));
    await page.fill("#rModel", "ford fi");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    await page.keyboard.press("ArrowDown");
    check("M20 ArrowDown reopens a closed list and selects its first option", (await listOpen(page)) && (await page.getAttribute("#rModel", "aria-activedescendant")) === "ms-0");
    // free text and normalisation on blur
    for (const [raw, want] of [["clio", "Renault Clio"], ["208", "Peugeot 208"], ["clio 4", "Renault Clio 4"], ["peugeot 208 allure", "Peugeot 208 Allure"], ["lamborghini miura", "Lamborghini Miura"], ["MERCEDES-BENZ classe a 180", "Mercedes Classe A 180"], ["vw polo", "Volkswagen Polo"], ["Tesla Roadster", "Tesla Roadster"], ["3", "3"], ["e", "E"], ["1", "1"], ["leon", "Leon"], ["500", "500"]]) {
      await page.fill("#rModel", raw);
      await page.keyboard.press("Tab");
      check(`M21 blur: ${J(raw)} → ${J(want)}`, (await page.inputValue("#rModel")) === want, await page.inputValue("#rModel"));
    }
    check("M22 console clean", logs.console.length === 0 && logs.errors.length === 0, J([logs.console, logs.errors]));
    await ctx.close();
    // declared models first, then the catalogue
    ({ page, ctx, logs } = await dlg({ storage: { "jg.repairs.v1": REPAIRS } }));
    check("M23 the dialog opens with the model of the latest declaration", (await page.inputValue("#rModel")) === "Peugeot 208");
    await page.fill("#rModel", "c");
    l = await items(page);
    const own = await page.$$eval("#rModelList li", (l) => l.map((x) => (x.querySelector(".s-sub") || {}).textContent || ""));
    check("M24 typing « c »: declared models first (recent first), marked « déjà déclaré »", l[0] === "Renault Clio" && l[1] === "Citroën C3" && own[0] === "déjà déclaré" && own[1] === "déjà déclaré" && own[2] === "", J({ l: l.slice(0, 4), own: own.slice(0, 4) }));
    check("M24b … and they are not repeated further down", l.filter((n) => n === "Citroën C3").length === 1 && l.filter((n) => n === "Renault Clio").length === 1);
    await page.fill("#rModel", "");
    l = await items(page);
    check("M25 emptied field: the declared models, most recent first, then the common ones not already listed (12 in all)", J(l.slice(0, 5)) === J(["Peugeot 208", "Renault Clio", "Dacia Sandero", "Citroën C3", "Peugeot 308"]) && l.length === 12 && new Set(l).size === 12, J(l));
    const own2 = await page.$$eval("#rModelList li", (l) => l.map((x) => !!x.querySelector(".s-sub")));
    check("M25a … only the declared ones are labelled « déjà déclaré »", own2.slice(0, 4).every(Boolean) && own2.slice(4).every((x) => !x), J(own2));
    await page.fill("#rModel", "peugeot 208");
    check("M25b typing a name that has other matches keeps the list open (e-208 contains the word 208)", (await listOpen(page)) && J(await items(page)) === J(["Peugeot 208", "Peugeot e-208"]), J(await items(page)));
    await page.fill("#rModel", "renault clio");
    check("M25c typing exactly a name that is the only suggestion: list closed", !(await listOpen(page)) && (await items(page)).length === 0);
    await ctx.close();
    ({ page, ctx } = await dlg({ storage: { "jg.repairs.v1": [{ ...REPAIRS[1], id: "d1", model: "peugeot 208", createdAt: "2026-09-20T10:00:00Z" }, REPAIRS[0]] } }));
    await page.fill("#rModel", "208");
    const dd = await items(page);
    check("M26 a declared model written differently (« peugeot 208 ») replaces the catalogue spelling instead of doubling it", dd.filter((n) => /^peugeot 208$/i.test(n)).length === 1 && dd[0] === "peugeot 208", J(dd));
    await ctx.close();
    ({ page, ctx } = await dlg({ storage: { "jg.repairs.v1": [{ ...REPAIRS[1], id: "x1", model: '<img src=x onerror="window.__xss=1"> Clio' }] } }));
    await page.fill("#rModel", "");
    const xs = await page.evaluate(() => ({ imgs: document.querySelectorAll("#rModelList img, #repairDlg img").length, fired: window.__xss === 1, text: [...document.querySelectorAll("#rModelList .s-main")].map((e) => e.textContent)[0] }));
    check("M27 a declared model containing HTML is shown as text in the suggestions, nothing runs", xs.imgs === 0 && !xs.fired && /<img/.test(xs.text || ""), J(xs));
    await ctx.close();
  } catch (e) {
    check("M section crashed", false, e && e.stack);
  }

  // =============== C. Catalogue ===============
  if (has("C")) try {
    const lines = fs.readFileSync(path.join(__dirname, "..", "src", "data", "models.txt"), "utf8").split("\n").filter((x) => x.trim());
    const names = lines.flatMap((l) => { const i = l.indexOf(":"), b = l.slice(0, i).trim(); return l.slice(i + 1).split(",").map((m) => `${b} ${m.trim()}`); });
    const legacy = fs.readFileSync(path.join(__dirname, "fixtures", "legacy-models.txt"), "utf8").split("\n").filter(Boolean);
    const { page, ctx, logs } = await dlg();
    check("C1 catalogue size: at least 900 models (the old list had 208)", names.length >= 900 && legacy.length === 208, `${names.length}/${legacy.length}`);
    const res = await page.evaluate((names) => {
      const input = document.getElementById("rModel"), bad = [];
      for (const n of names) {
        input.value = n.toLowerCase();
        input.dispatchEvent(new Event("blur"));
        if (input.value !== n) bad.push([n, input.value]);
      }
      return bad;
    }, names);
    check(`C2 every one of the ${names.length} catalogue names is recognised (typed in lowercase, blur gives the exact name)`, res.length === 0, J(res.slice(0, 8)));
    const miss = legacy.filter((n) => !names.includes(n));
    check("C3 the 208 names of the old list are all still there, spelt the same", miss.length === 0, J(miss));
    const accentless = await page.evaluate((names) => {
      const input = document.getElementById("rModel"), bad = [];
      for (const n of names.filter((n) => /[^\x00-\x7f]/.test(n))) {
        input.value = n.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
        input.dispatchEvent(new Event("blur"));
        if (input.value !== n) bad.push([n, input.value]);
      }
      return bad;
    }, names);
    check("C4 accented names are recognised without their accents", accentless.length === 0, J(accentless.slice(0, 8)));
    // model typed without its brand: only unambiguous names are completed
    const noBrand = await page.evaluate(() => {
      const input = document.getElementById("rModel"), out = {};
      for (const m of ["golf", "clio", "208", "qashqai", "yaris", "leon", "500", "voyager", "coupe", "3", "2", "e", "9"]) {
        input.value = m;
        input.dispatchEvent(new Event("blur"));
        out[m] = input.value;
      }
      return out;
    });
    check("C5 unambiguous model alone gets its brand (golf, clio, 208, qashqai, yaris)", noBrand.golf === "Volkswagen Golf" && noBrand.clio === "Renault Clio" && noBrand["208"] === "Peugeot 208" && noBrand.qashqai === "Nissan Qashqai" && noBrand.yaris === "Toyota Yaris", J(noBrand));
    check("C6 ambiguous or one-character names are left alone (leon, 500, voyager, coupe, 3, 2, e, 9)", noBrand.leon === "Leon" && noBrand["500"] === "500" && noBrand.voyager === "Voyager" && noBrand.coupe === "Coupe" && noBrand["3"] === "3" && noBrand["2"] === "2" && noBrand.e === "E" && noBrand["9"] === "9", J(noBrand));
    check("C7 console clean", logs.console.length === 0 && logs.errors.length === 0, J([logs.console, logs.errors]));
    await ctx.close();
  } catch (e) {
    check("C section crashed", false, e && e.stack);
  }

  // =============== S. Storage, prefill, display, privacy ===============
  if (has("S")) try {
    let { page, ctx, logs } = await open(browser, server, FILE, { width: 1440, height: 900, mock: { elements: els }, storage: { "jg.repairs.v1": REPAIRS } });
    await page.click("#addRepairBtn");
    await page.waitForTimeout(300);
    const pre = await page.evaluate(() => ({ plate: document.getElementById("rPlate").value, model: document.getElementById("rModel").value, year: document.getElementById("rYear").value, garage: document.getElementById("rGarage").value }));
    check("S1 the form opens with the vehicle of the latest declaration (plate, model, year)", pre.plate === "EZ-108-BC" && pre.model === "Peugeot 208" && pre.year === "2019" && pre.garage === "", J(pre));
    check("S1b … and the focus goes to the first empty field (the garage)", (await active(page)) === "rGarage", await active(page));
    await page.fill("#rGarage", "Garage du Coin");
    await page.fill("#rPrice", "80");
    await page.click("label[for=rSt5]");
    await page.click("#repairForm button[type=submit]");
    await page.waitForTimeout(300);
    const st = await page.evaluate(() => JSON.parse(localStorage.getItem("jg.repairs.v1")));
    const added = st.find((r) => !["r1", "r2", "r3", "r4"].includes(r.id));
    check("S2 prefilled vehicle saved as is", added && added.immat === "EZ-108-BC" && added.year === 2019 && added.model === "Peugeot 208", J(added));
    // legacy declaration first: no plate, no year → they are asked
    await ctx.close();
    ({ page, ctx, logs } = await open(browser, server, FILE, { width: 1440, height: 900, mock: { elements: els }, storage: { "jg.repairs.v1": REPAIRS.slice(1) } }));
    await page.click("#addRepairBtn");
    await page.fill("#rGarage", "Garage du Coin");
    await page.keyboard.press("Enter");
    const pre2 = await page.evaluate(() => ({ plate: document.getElementById("rPlate").value, model: document.getElementById("rModel").value, year: document.getElementById("rYear").value }));
    check("S3 latest declaration without plate/year (older data): model reused, plate and year empty", pre2.plate === "" && pre2.model === "Renault Clio" && pre2.year === "", J(pre2));
    await page.click("#repairForm button[type=submit]");
    check("S3c … a missing plate / year is asked for on submit", /immatriculation/.test(await errText(page, "#rPlateErr")) && /année/.test(await errText(page, "#rYearErr")) && (await page.$eval("#repairDlg", (d) => d.open)));
    await page.click("#dlgCancel");
    await ctx.close();
    // display: the plate and the year are asked for, but only the model and its year ever show, on the garage fiche
    ({ page, ctx, logs } = await open(browser, server, FILE, { width: 1440, height: 900, mock: { elements: els }, storage: { "jg.repairs.v1": REPAIRS } }));
    check("S4 the « Mes réparations » tab is gone: nowhere to read the plate or the comment back", !(await page.$(".tab[data-view=reparations], #view-reparations, .rep-plate")) && (await page.$$(".tab")).length === 2);
    const notes = await page.evaluate(() => ({ src: document.body.textContent.replace(/\s+/g, " ") }));
    check("S5b the sources paragraph says the history shows model and year, never the comment nor the plate", /affiche le modèle et l'année du véhicule, le mois, la note et le prix, jamais le commentaire ni l'immatriculation/.test(notes.src), "");
    // garage sheet: model + year, never the plate
    await search(page, { service: "vidange" });
    await page.click("[data-sort=dist]");
    await page.waitForTimeout(250);
    const id = "osm:node/1022";
    check("S6a the garage with declarations is in the results", (await page.$$(`#list [data-id="${id}"]`)).length === 1, id);
    {
      await page.locator(`#list [data-id="${id}"] .g-main`).scrollIntoViewIfNeeded();
      await page.click(`#list [data-id="${id}"] .g-main`);
      await page.waitForTimeout(500);
      const sheet = await page.evaluate((id) => { const c = document.querySelector(`#list [data-id="${id}"]`); return { text: c.textContent, html: c.innerHTML, rows: [...c.querySelectorAll(".h-model")].map((e) => e.textContent), dots: [...c.querySelectorAll(".scale-dot")].map((e) => e.title) }; }, id);
      check("S6 garage history shows « modèle · année »", sheet.rows.some((t) => /Peugeot 208 · 2019/.test(t)) && sheet.rows.some((t) => /Renault Clio/.test(t) && !/·/.test(t)), J(sheet.rows));
      check("S7 the price-scale tooltip carries the year", sheet.dots.some((t) => /Peugeot 208 · 2019/.test(t)), J(sheet.dots));
      check("S8 the plate appears nowhere on the garage sheet (text, attributes)", !/EZ-108-BC/.test(sheet.html) && !/EZ-108-BC/.test(sheet.text));
      check("S8b the history note says so: model and year shown, comments and plate never", /le modèle et l'année du véhicule et la note donnée au garage\. Les commentaires et l'immatriculation n'y figurent jamais\./.test(norm(sheet.text)), norm(sheet.text).slice(0, 300));
    }
    const all = await page.evaluate(() => ({ garages: document.getElementById("view-garages").innerHTML, prix: document.getElementById("view-prix").innerHTML, bar: document.getElementById("mapInfo").innerHTML }));
    check("S9 …nor in the results list, the map bar or the price page", !/EZ-108-BC/.test(all.garages) && !/EZ-108-BC/.test(all.prix) && !/EZ-108-BC/.test(all.bar));
    await ctx.close();
    // tampered / invalid stored values are dropped, never displayed
    const BAD = [
      { ...REPAIRS[0], id: "b1", immat: "<img src=x onerror=alert(1)>", year: "abc" },
      { ...REPAIRS[1], id: "b2", immat: "ez-108-bc", year: 1800 },
      { ...REPAIRS[2], id: "b3", immat: "1234 AB 56", year: 2500 },
      { ...REPAIRS[3], id: "b4", immat: "AA-111-AA", year: 2018.5 },
      { ...REPAIRS[0], id: "b5", immat: "AB-123-CD", year: 1950 },
    ];
    ({ page, ctx, logs } = await open(browser, server, FILE, { width: 1440, height: 900, mock: { elements: els }, storage: { "jg.repairs.v1": BAD } }));
    await search(page, { service: "vidange" });
    await page.click("[data-sort=dist]");
    await page.waitForTimeout(250);
    await page.locator(`#list [data-id="${id}"] .g-main`).scrollIntoViewIfNeeded();
    await page.click(`#list [data-id="${id}"] .g-main`);
    await page.waitForTimeout(500);
    await page.click(`#list [data-id="${id}"] details.history > summary`);
    const labels = await page.$$eval(`#list [data-id="${id}"] .h-model > span:first-child`, (l) => l.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
    check("S10 invalid years are not displayed (text, out of range, decimal); 1950 is", labels.filter((t) => / · \d{4}$/.test(t)).length === 1 && labels.some((t) => /· 1950$/.test(t)), J(labels));
    // the stored list is cleaned for good at the next save (here: deleting one of the declarations)
    await page.locator(`#list [data-id="${id}"] .h-del[data-rid="b2"]`).click();
    await page.waitForTimeout(250);
    const kept = await page.evaluate(() => ({ ls: JSON.parse(localStorage.getItem("jg.repairs.v1")), imgs: document.querySelectorAll("img[src=x]").length }));
    const by = Object.fromEntries(kept.ls.map((r) => [r.id, r]));
    check("S11 invalid plates are dropped at the next save (HTML, lowercase); valid ones are kept", by.b1 && !("immat" in by.b1) && by.b3 && !("immat" in by.b3) && by.b4 && by.b4.immat === "AA-111-AA" && by.b5 && by.b5.immat === "AB-123-CD", J(kept.ls.map((r) => [r.id, r.immat])));
    check("S11b invalid years are dropped (text, out of range, decimal); 1950 is kept", by.b1 && !("year" in by.b1) && by.b3 && !("year" in by.b3) && by.b4 && !("year" in by.b4) && by.b5 && by.b5.year === 1950, J(kept.ls.map((r) => [r.id, r.year])));
    check("S12 nothing injected", kept.imgs === 0 && logs.errors.length === 0, J(logs.errors));
    await ctx.close();
    // legacy « plate » migration still runs, and does not touch the new fields
    ({ page, ctx, logs } = await open(browser, server, FILE, { width: 1440, height: 900, mock: { elements: els }, storage: { "jg.repairs.v1": [
      { ...REPAIRS[1], id: "m1", model: "", plate: "AA-111-AA", immat: "EZ-108-BC", year: 2019 },
      { ...REPAIRS[2], id: "m2", model: "Dacia Sandero", plate: "AA-111-AA" },
    ] } }));
    const mig = await page.evaluate(() => JSON.parse(localStorage.getItem("jg.repairs.v1")));
    check("S13 the old « plate » field is migrated as before (model copied, field removed)…", mig.every((r) => !("plate" in r)) && mig.find((r) => r.id === "m1").model === "Dacia Sandero", J(mig));
    check("S13b … and the new plate / year survive it", mig.find((r) => r.id === "m1").immat === "EZ-108-BC" && mig.find((r) => r.id === "m1").year === 2019, J(mig));
    await ctx.close();
  } catch (e) {
    check("S section crashed", false, e && e.stack);
  }

  // =============== L. Layout, themes, accessibility ===============
  if (has("L")) try {
    for (const [name, o] of [["desktop", { width: 1440, height: 900 }], ["tablet", { width: 820, height: 1180 }], ["phone", { width: 390, height: 844, dpr: 2, touch: true }], ["small", { width: 320, height: 640, dpr: 2, touch: true }]]) {
      const { page, ctx } = await dlg({ ...o, storage: { "jg.repairs.v1": REPAIRS.slice(1) } });
      await page.fill("#rModel", "pe");
      const g = await page.evaluate(() => {
        const r = (s) => document.querySelector(s).getBoundingClientRect(), d = document.getElementById("repairDlg"), p = r("#rPlate"), y = r("#rYear"), li = [...document.querySelectorAll("#rModelList li")].map((e) => e.getBoundingClientRect()), box = r("#rModelList"), dr = d.getBoundingClientRect();
        return { overX: d.scrollWidth > d.clientWidth, pt: p.top, yt: y.top, ph: p.height, yh: y.height, pw: p.width, yw: y.width, boxIn: box.left >= dr.left - 1 && box.right <= dr.right + 1, label: [...document.querySelectorAll('label[for="rPlate"], label[for="rYear"]')].map((e) => e.getBoundingClientRect().height) };
      });
      check(`L1 [${name}] no horizontal overflow in the dialog, suggestion list inside it`, !g.overX && g.boxIn, J(g));
      check(`L2 [${name}] plate and year inputs are level and the same height`, Math.abs(g.pt - g.yt) < 1 && Math.abs(g.ph - g.yh) < 1 && g.ph >= 44, J(g));
      check(`L3 [${name}] plate wide enough for EZ-108-BC (≥ 130 px), year ≥ 90 px`, g.pw >= 130 && g.yw >= 90, J({ pw: g.pw, yw: g.yw }));
      check(`L4 [${name}] labels stay on one line`, g.label.every((h) => h < 22), J(g.label));
      await ctx.close();
    }
    for (const scheme of ["light", "dark"]) {
      for (const mobile of [false, true]) {
        const o = mobile ? { width: 390, height: 844, dpr: 2, touch: true } : { width: 1440, height: 900 };
        const { page, ctx } = await dlg({ ...o, colorScheme: scheme, storage: { "jg.repairs.v1": REPAIRS } });
        await injectScript(page, AXE);
        const run = () => page.evaluate(async () => (await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } })).violations.map((v) => ({ id: v.id, n: v.nodes.length, ex: v.nodes.slice(0, 2).map((n) => n.target.join(" ")) })));
        let v = await run();
        check(`L5 [${scheme}${mobile ? " mobile" : ""}] axe: no violation, dialog open and prefilled`, v.length === 0, J(v));
        await page.fill("#rModel", "pe");
        await page.keyboard.press("ArrowDown");
        v = await run();
        check(`L6 [${scheme}${mobile ? " mobile" : ""}] axe: no violation with the suggestion list open and an option active`, v.length === 0, J(v));
        await page.keyboard.press("Escape");
        await page.fill("#rPlate", "e1");
        await page.fill("#rYear", "");
        await page.click("#repairForm button[type=submit]");
        v = await run();
        check(`L7 [${scheme}${mobile ? " mobile" : ""}] axe: no violation with the plate / year / model errors displayed`, v.length === 0, J(v));
        await ctx.close();
      }
    }
    // two-column rows stay level when one field shows an error (price and date, which had no fix before)
    {
      const { page: p3, ctx: c3 } = await dlg();
      await p3.click("#repairForm button[type=submit]");
      const lv = await p3.evaluate(() => { const t = (s) => document.querySelector(s).getBoundingClientRect().top; return { price: t("#rPrice"), date: t("#rDate"), plate: t("#rPlate"), year: t("#rYear") }; });
      check("L9 price and date inputs stay level when only the price shows an error", Math.abs(lv.price - lv.date) < 1, J(lv));
      check("L9b plate and year inputs stay level with errors on both", Math.abs(lv.plate - lv.year) < 1, J(lv));
      await c3.close();
    }
    // forced colours: the active option must still be visible
    const { page, ctx } = await dlg({ forcedColors: "active" });
    await page.fill("#rModel", "pe");
    await page.keyboard.press("ArrowDown");
    const fc = await page.evaluate(() => { const li = document.querySelector('#rModelList li[aria-selected="true"]'), cs = getComputedStyle(li), probe = (c) => { const d = document.createElement("i"); d.style.outlineColor = c; document.body.append(d); const v = getComputedStyle(d).outlineColor; d.remove(); return v; }; return { w: cs.outlineWidth, c: cs.outlineColor, hi: probe("Highlight"), box: getComputedStyle(document.getElementById("rModelList")).borderTopWidth }; });
    check("L8 forced colours: the active option has a Highlight outline and the list a border", fc.w === "2px" && fc.c === fc.hi && fc.box === "1px", J(fc));
    await ctx.close();
  } catch (e) {
    check("L section crashed", false, e && e.stack);
  }

  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n[veh ${FILE}] ${results.length - failed.length}/${results.length} checks passed`);
  fs.writeFileSync(path.join(SHOTS, `veh-${path.basename(FILE, ".html")}.json`), J(results, null, 1));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
