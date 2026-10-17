// Espace Pro, « Mon garage » (docs/rendez-vous.md, lot 1) : coordonnées (nom, adresse et téléphone relus par Pixcar ; site, e-mail et horaires
// publiés tout de suite), registre officiel (lecture seule), horaires, prestations faites et leur temps moyen (privé). Chaque prestation est
// enregistrée dès qu'on la touche. Que du TEXTE écrit dans la page.
import { PRO_SERVICES, announcedText } from "../shared/pro-prices.js";
import {
  DAYS, MINUTES_MAX, MINUTES_MIN, MINUTES_STEP, addrText, hoursText, minutesText, parseAddr, parseEmail, parseHours, parseName, parsePhone, parseWebsite, phoneText,
} from "../shared/garage-profile.js";

const FIELDS = {
  name: { label: "Nom affiché", icon: "i-garage", reviewed: true, parse: parseName },
  addr: { label: "Adresse", icon: "i-pin", reviewed: true, parse: parseAddr },
  phone: { label: "Téléphone", icon: "i-phone", reviewed: true, parse: parsePhone },
  website: { label: "Site internet", icon: "i-globe", parse: parseWebsite },
  email: { label: "E-mail affiché aux clients", icon: "i-mail", parse: parseEmail },
};
const SOURCE = { data: "Données publiques", reviewed: "Vérifié par Pixcar", garage: "Communiqué par le garage" };
const LONG = { day: "numeric", month: "long", year: "numeric" };
const date = (iso) => new Date(iso).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", ...LONG });
const siretText = (s) => String(s).replace(/^(\d{3})(\d{3})(\d{3})(\d{5})$/, "$1 $2 $3 $4");
const hostOf = (url) => {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, "")).slice(0, 80);
  } catch {
    return url;
  }
};
const valueText = (field, v) => (field === "addr" ? addrText(v) : field === "phone" ? phoneText(v) : field === "website" ? hostOf(v) : String(v || ""));
const MINUTES = Array.from({ length: (MINUTES_MAX - MINUTES_MIN) / MINUTES_STEP + 1 }, (_, i) => MINUTES_MIN + i * MINUTES_STEP);

export function createGarageView({ api, $, el, icon, alertBox, busy, apiProblem, prices, openPrice, onPricesChanged }) {
  let garageId = null;
  let data = null; // réponse de GET /v1/pro/garages/:id/profile
  let registry = null; // réponse de GET …/registry, ou { error }
  let editing = null; // champ en cours de modification
  let untick = null; // prestation à décocher une fois le retrait du prix confirmé

  // ---- chargement
  async function open(id, { verifiedAt } = {}) {
    garageId = id;
    if (verifiedAt) $("mgVerified").replaceChildren(icon("i-shield"), `Garage vérifié le ${date(verifiedAt)}`);
    const [profile, reg] = await Promise.allSettled([api.profile(id), api.registry(id)]);
    if (profile.status === "rejected") throw profile.reason;
    data = profile.value;
    registry = reg.status === "fulfilled" ? reg.value : { error: reg.reason };
    if (registry.error && registry.error.status === 401) throw registry.error;
    render();
  }
  // après un prix enregistré ou retiré depuis « Mes prix » : la prestation a pu être cochée
  async function refresh() {
    if (!garageId || !data) return;
    try {
      data = await api.profile(garageId);
      // le prix a pu être annoncé depuis une ligne de « Prestations » : le rendu la remplace, le focus revient sur son interrupteur
      const row = document.activeElement && document.activeElement.closest && document.activeElement.closest("#mgSvcRows tr[data-svc]");
      render();
      const back = row && document.querySelector(`#mgSvcRows tr[data-svc="${row.dataset.svc}"] .tgl`);
      if (back) back.focus();
    } catch {} // la page reste juste ; la prochaine ouverture rechargera
  }

  function render() {
    renderCoords();
    renderRegistry();
    renderHours();
    renderServices();
  }

  // ---- coordonnées
  function current(field) {
    const p = data.profile, g = data.garage;
    if (field === "name") return p.name ? { text: p.name, src: "reviewed" } : { text: g.name, src: "data" };
    if (field === "addr") return p.addr ? { text: addrText(p.addr), src: "reviewed" } : g.addr ? { text: g.addr, src: "data" } : null;
    if (field === "phone") return p.phone ? { text: phoneText(p.phone), src: "reviewed" } : null;
    return p[field] ? { text: valueText(field, p[field]), src: "garage" } : null;
  }
  function renderCoords() {
    const list = $("mgCoords");
    list.replaceChildren();
    for (const [field, f] of Object.entries(FIELDS)) {
      const cur = current(field);
      const pending = data.changes.find((c) => c.field === field && c.status === "pending");
      const refused = !pending && data.changes.find((c) => c.field === field && c.status === "rejected");
      const main = el(
        "div",
        { class: "mg-main" },
        el("span", { class: "k", text: f.label }),
        cur ? el("span", { class: "v", text: cur.text }) : el("span", { class: "v none", text: field === "email" ? "Aucun (facultatif)" : "Pas encore renseigné ici" }),
        cur ? el("span", { class: "src " + cur.src, text: SOURCE[cur.src] }) : null,
        !cur && field === "phone" ? el("span", { class: "hint", text: "Sur Pixcar, la fiche montre le numéro trouvé dans les données publiques." }) : null,
        pending
          ? el(
              "span",
              { class: "src pending" },
              icon("i-clock"),
              `Changement demandé : ${valueText(field, pending.value)} · relu par Pixcar`,
            )
          : null,
        refused ? el("span", { class: "src refused", text: `Changement refusé : ${valueText(field, refused.value)}${refused.reason ? ` · ${refused.reason}` : ""}` }) : null,
      );
      const act = pending
        ? el("button", { type: "button", class: "link-btn", "aria-label": `Annuler le changement demandé : ${f.label}`, onclick: (e) => cancelChange(pending, e.currentTarget) }, "Annuler la demande")
        : el("button", { type: "button", class: "link-btn", "aria-label": `${cur ? "Modifier" : "Ajouter"} : ${f.label}`, onclick: () => openField(field) }, cur ? "Modifier" : "Ajouter");
      list.append(el("li", { class: "mg-row", "data-field": field }, icon(f.icon), main, act));
    }
  }

  function openField(field) {
    alertBox("");
    editing = field;
    const f = FIELDS[field];
    $("fieldDlgTitle").textContent = f.label;
    $("fieldOne").hidden = field === "addr";
    $("fieldAddr").hidden = field !== "addr";
    const p = data.profile;
    if (field === "addr") {
      const a = p.addr || { street: "", pc: data.garage.pc || "", city: "" };
      $("addrStreet").value = a.street;
      $("addrPc").value = a.pc;
      $("addrCity").value = a.city;
    } else {
      $("fieldLabel").textContent = f.label;
      const input = $("fieldValue");
      input.type = field === "email" ? "email" : field === "phone" ? "tel" : field === "website" ? "url" : "text";
      input.inputMode = field === "phone" ? "tel" : field === "email" ? "email" : field === "website" ? "url" : "text";
      input.value = field === "phone" ? (p.phone ? phoneText(p.phone) : "") : field === "name" ? p.name || data.garage.name : p[field] || "";
    }
    $("fieldHelp").textContent = f.reviewed
      ? "Relu par Pixcar avant publication : la valeur actuelle reste affichée d'ici là. Ce contrôle protège vos clients si votre compte était piraté."
      : "Publié tout de suite sur votre fiche Pixcar.";
    $("fieldClearBox").hidden = f.reviewed || !p[field];
    $("fieldErr").hidden = true;
    $("fieldDlg").showModal();
    (field === "addr" ? $("addrStreet") : $("fieldValue")).focus();
  }

  async function saveField(ev) {
    ev.preventDefault();
    const field = editing;
    const f = FIELDS[field];
    const raw = field === "addr" ? { street: $("addrStreet").value, pc: $("addrPc").value, city: $("addrCity").value } : $("fieldValue").value;
    const parsed = f.parse(raw);
    if (parsed.error || (f.reviewed && field !== "addr" && !String(raw).trim())) return fieldError(parsed.error || `${f.label} : à remplir.`);
    await busy($("fieldSave"), async () => {
      try {
        if (f.reviewed) {
          const change = await api.requestChange(garageId, { field, value: raw });
          data.changes = data.changes.filter((c) => !(c.field === field && c.status === "pending")).concat(change);
          alertBox(`${f.label} : changement envoyé. Il sera publié une fois relu par Pixcar.`, "info");
        } else {
          data.profile = await api.putProfile(garageId, { [field]: raw });
          alertBox(`${f.label} : enregistré, visible sur Pixcar.`, "info");
        }
        $("fieldDlg").close();
        renderCoords();
      } catch (e) {
        if (e.status === 401) {
          $("fieldDlg").close();
          return apiProblem(e);
        }
        fieldError(e.message);
      }
    });
  }
  async function clearField() {
    const field = editing;
    await busy($("fieldClear"), async () => {
      try {
        data.profile = await api.putProfile(garageId, { [field]: "" });
        $("fieldDlg").close();
        renderCoords();
        alertBox(`${FIELDS[field].label} : retiré de votre fiche.`, "info");
      } catch (e) {
        if (e.status === 401) {
          $("fieldDlg").close();
          return apiProblem(e);
        }
        fieldError(e.message);
      }
    });
  }
  function fieldError(message) {
    $("fieldErr").textContent = message;
    $("fieldErr").hidden = false;
  }
  async function cancelChange(change, button) {
    await busy(button, async () => {
      try {
        await api.cancelChange(garageId, change.id);
        data.changes = data.changes.filter((c) => c.id !== change.id);
        renderCoords();
        alertBox(`${FIELDS[change.field].label} : demande annulée.`, "info");
      } catch (e) {
        if (!apiProblem(e)) alertBox(e.message);
      }
    });
  }

  // ---- registre officiel
  function renderRegistry() {
    const dl = $("mgRegistry");
    dl.replaceChildren();
    if (registry.error) {
      dl.append(el("div", {}, el("dd", { class: "muted", text: registry.error.status === 404 ? registry.error.message : "Le registre des entreprises ne répond pas pour l'instant. Réessayez plus tard." })));
      return;
    }
    const r = registry;
    const rows = [
      ["Raison sociale", r.company || r.name],
      ["SIRET", siretText(r.siret)],
      ["Activité (code APE)", `${r.naf}${r.nafLabel ? ` · ${r.nafLabel}` : ""}`],
      ["Adresse", r.addr],
      ["État", r.active ? "Actif" : "Fermé"],
    ];
    for (const [k, v] of rows) if (v) dl.append(el("div", {}, el("dt", { text: k }), el("dd", { text: v })));
  }

  // ---- horaires
  function renderHours() {
    const box = $("mgHours");
    box.replaceChildren();
    const h = data.profile.hours;
    if (!h) {
      box.append(el("p", { class: "muted", text: "Pas encore renseignés ici. Sur Pixcar, la fiche montre ceux des données publiques quand il y en a." }));
      $("mgHoursEdit").lastChild.textContent = "Renseigner";
      return;
    }
    $("mgHoursEdit").lastChild.textContent = "Modifier";
    const list = el("dl", { class: "mg-week", "aria-label": hoursText(h) });
    for (const [k, label] of DAYS) {
      const slots = h[k] || [];
      list.append(el("div", { class: slots.length ? "" : "closed" }, el("dt", { text: label }), el("dd", { text: slots.length ? slots.map((s) => `${s[0]} – ${s[1]}`).join(" · ") : "Fermé" })));
    }
    box.append(list);
  }
  function openHours() {
    alertBox("");
    const box = $("hoursDays");
    box.replaceChildren();
    const h = data.profile.hours || {};
    for (const [k, label] of DAYS) {
      const slots = h[k] || [];
      const time = (i, j, what) => el("input", { type: "time", step: "900", "data-day": k, "data-slot": `${i}${j}`, value: (slots[i] && slots[i][j]) || "", "aria-label": `${label}, ${what}` });
      box.append(
        el(
          "fieldset",
          { class: "mg-day" },
          el("legend", { text: label }),
          el("label", { class: "check" }, el("input", { type: "checkbox", "data-open": k, checked: slots.length > 0 }), el("span", { text: "Ouvert" })),
          el("span", { class: "mg-slot" }, time(0, 0, "ouverture"), "–", time(0, 1, "fermeture")),
          el("span", { class: "mg-slot" }, time(1, 0, "réouverture"), "–", time(1, 1, "fermeture du soir")),
        ),
      );
    }
    $("hoursErr").hidden = true;
    $("hoursDlg").showModal();
    box.querySelector('input[type="time"]').focus();
  }
  function readHours() {
    const out = {};
    for (const [k, label] of DAYS) {
      if (!document.querySelector(`#hoursDays input[data-open="${k}"]`).checked) continue;
      const v = (slot) => document.querySelector(`#hoursDays input[data-day="${k}"][data-slot="${slot}"]`).value;
      const slots = [];
      for (const i of [0, 1]) {
        const a = v(`${i}0`), b = v(`${i}1`);
        if (!a && !b) continue;
        if (!a || !b) return { error: `${label} : indiquez l'heure d'ouverture et celle de fermeture.` };
        slots.push([a, b]);
      }
      if (!slots.length) return { error: `${label} : indiquez une plage, ou décochez « Ouvert ».` };
      out[k] = slots;
    }
    return parseHours(out);
  }
  function copyMonday() {
    const get = (slot) => document.querySelector(`#hoursDays input[data-day="mo"][data-slot="${slot}"]`).value;
    const open = document.querySelector('#hoursDays input[data-open="mo"]').checked;
    for (const k of ["tu", "we", "th", "fr"]) {
      document.querySelector(`#hoursDays input[data-open="${k}"]`).checked = open;
      for (const slot of ["00", "01", "10", "11"]) document.querySelector(`#hoursDays input[data-day="${k}"][data-slot="${slot}"]`).value = get(slot);
    }
    $("mgLive").textContent = "Horaires du lundi copiés sur les jours de mardi à vendredi.";
  }
  async function saveHours(ev) {
    ev.preventDefault();
    const parsed = readHours();
    if (parsed.error) {
      $("hoursErr").textContent = parsed.error;
      $("hoursErr").hidden = false;
      return;
    }
    await busy($("hoursSave"), async () => {
      try {
        data.profile = await api.putProfile(garageId, { hours: parsed.value });
        $("hoursDlg").close();
        renderHours();
        alertBox("Horaires enregistrés, visibles sur Pixcar.", "info");
      } catch (e) {
        if (e.status === 401) {
          $("hoursDlg").close();
          return apiProblem(e);
        }
        $("hoursErr").textContent = e.message;
        $("hoursErr").hidden = false;
      }
    });
  }

  // ---- prestations
  function renderServices() {
    const rows = $("mgSvcRows");
    rows.replaceChildren();
    const state = new Map(data.services.map((s) => [s.service, s]));
    const priced = new Map(prices().map((p) => [p.service, p]));
    let group = "";
    for (const s of PRO_SERVICES) {
      if (s.g !== group) {
        group = s.g;
        rows.append(el("tr", { class: "cat" }, el("th", { colspan: "4", scope: "colgroup", text: group })));
      }
      const st = state.get(s.id) || { offered: null, minutes: null };
      const on = st.offered === true;
      const price = priced.get(s.id);
      const select = el(
        "select",
        { "aria-label": `Temps moyen : ${s.label}`, disabled: !on, onchange: (e) => saveService(s.id, { offered: true, minutes: e.target.value ? Number(e.target.value) : null }, { focus: "select" }) },
        el("option", { value: "", text: on ? "À saisir" : "—" }),
        ...MINUTES.map((m) => el("option", { value: String(m), text: minutesText(m), selected: st.minutes === m })),
      );
      rows.append(
        el(
          "tr",
          { class: on ? (st.minutes === null ? "todo" : "") : "off", "data-svc": s.id },
          el("th", { scope: "row" }, el("span", { text: s.label }), on && st.minutes === null ? el("span", { class: "warnline", text: "Temps moyen à saisir" }) : null),
          el(
            "td",
            { class: "c-on", "data-l": "Je la fais" },
            el("button", { type: "button", class: "tgl", role: "switch", "aria-checked": on ? "true" : "false", "aria-label": `Je fais : ${s.label}`, onclick: (e) => toggle(s, !on, e.currentTarget) }),
          ),
          el("td", { class: "c-min", "data-l": "Temps moyen" }, select, s.unit ? el("span", { class: "unit", text: s.unit }) : null),
          el(
            "td",
            { class: "c-pp", "data-l": "Prix annoncé" },
            price
              ? el("b", { text: announcedText(price.kind, price.price) })
              : on
                ? el("button", { type: "button", class: "link-btn", "aria-label": `Annoncer un prix : ${s.label}`, onclick: () => openPrice(s.id) }, "Annoncer un prix")
                : el("span", { class: "muted", text: "—" }),
          ),
        ),
      );
    }
    const offered = data.services.filter((s) => s.offered === true);
    $("mgSvcSummary").textContent = data.services.some((s) => s.offered !== null)
      ? `${offered.length} sur ${PRO_SERVICES.length} · temps moyen renseigné pour ${offered.filter((s) => s.minutes !== null).length}`
      : "Cochez les prestations que vous faites : elles apparaîtront sur votre fiche Pixcar.";
  }

  async function toggle(s, on, button) {
    alertBox("");
    const price = prices().find((p) => p.service === s.id);
    if (!on && price) {
      untick = { s, button };
      $("untickText").textContent = `Vous annoncez ${announcedText(price.kind, price.price)} pour « ${s.label} ». Une prestation que vous ne faites pas ne peut pas avoir de prix annoncé : il sera retiré de Pixcar.`;
      $("untickDlg").returnValue = ""; // fermée par Échap, la boîte garderait sinon la réponse précédente
      $("untickDlg").showModal();
      return;
    }
    const st = data.services.find((x) => x.service === s.id);
    await saveService(s.id, { offered: on, minutes: st ? st.minutes : null }, { button, focus: ".tgl" });
  }

  async function saveService(serviceId, body, { button, focus = ".tgl" } = {}) {
    const label = (PRO_SERVICES.find((x) => x.id === serviceId) || {}).label || serviceId;
    const run = async () => {
      try {
        const out = await api.putService(garageId, serviceId, body);
        data.services = data.services.map((x) => (x.service === serviceId ? { service: serviceId, offered: out.offered, minutes: out.minutes } : x));
        if (out.priceRemoved) {
          await onPricesChanged();
          alertBox(`${label} : décochée, son prix annoncé est retiré de Pixcar.`, "info");
        }
        renderServices();
        $("mgLive").textContent = `${label} : enregistré.`;
        const row = document.querySelector(`#mgSvcRows tr[data-svc="${serviceId}"]`);
        const back = row && row.querySelector(focus);
        if (back) back.focus(); // le rendu a remplacé la ligne : le focus revient sur la commande touchée
      } catch (e) {
        if (!apiProblem(e)) alertBox(e.message);
        renderServices();
      }
    };
    return button ? busy(button, run) : run();
  }

  // ---- branchements
  $("fieldForm").addEventListener("submit", saveField);
  $("fieldClose").addEventListener("click", () => $("fieldDlg").close());
  $("fieldClear").addEventListener("click", clearField);
  $("mgHoursEdit").addEventListener("click", openHours);
  $("hoursForm").addEventListener("submit", saveHours);
  $("hoursClose").addEventListener("click", () => $("hoursDlg").close());
  $("hoursCopy").addEventListener("click", copyMonday);
  // saisir une heure ouvre le jour
  $("hoursDays").addEventListener("input", (e) => {
    const k = e.target.dataset.day;
    if (k && e.target.value) document.querySelector(`#hoursDays input[data-open="${k}"]`).checked = true;
  });
  $("addrPc").addEventListener("input", (e) => (e.target.value = e.target.value.replace(/\D/g, "").slice(0, 5)));
  $("untickDlg").addEventListener("close", async () => {
    const u = untick;
    untick = null;
    if (!u || $("untickDlg").returnValue !== "yes") return;
    const st = data.services.find((x) => x.service === u.s.id);
    await saveService(u.s.id, { offered: false, minutes: st ? st.minutes : null }, { focus: ".tgl" });
  });

  return { open, refresh };
}
