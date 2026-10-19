// Espace Pro, calendrier avancé (docs/calendrier-avance.md, lot 3a) : l'assistant en six étapes (garage, personnel, équipements,
// prestations, réservation, vérification et activation), et les mêmes écrans pour modifier ensuite sans tout recommencer. Les fiches
// (mécanicien, poste, prestation, absence) s'ouvrent dans un même volet, construit ici. Que du TEXTE écrit dans la page.
import { DAYS, hoursText, parseHours } from "../shared/garage-profile.js";
import { PRO_SERVICES } from "../shared/pro-prices.js";
import { dayLabel, minOf, timeLabel } from "../shared/rdv.js";

const SERVICE = new Map(PRO_SERVICES.map((s) => [s.id, s]));
const TIMES = Array.from({ length: 97 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`);
const TIMES5 = Array.from({ length: 289 }, (_, i) => `${String(Math.floor(i / 12)).padStart(2, "0")}:${String((i % 12) * 5).padStart(2, "0")}`).slice(0, 288);
const STEPS = [
  ["garage", "Garage", "Horaires, pauses, fermetures, délais et marges"],
  ["staff", "Personnel", "Vos mécaniciens, leurs horaires, absences et compétences"],
  ["resources", "Équipements", "Ponts, postes et équipements, leurs disponibilités"],
  ["services", "Prestations", "Durées, compétences et équipements demandés"],
  ["booking", "Réservation", "Confirmation, capacité en ligne, notifications"],
  ["check", "Vérification", "Contrôles, rendez-vous déjà pris, activation"],
];
const minText = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? " " + String(m % 60).padStart(2, "0") : ""}` : `${m} min`);
const plural = (n, one, many = one + "s") => `${n} ${n > 1 ? many : one}`;
const label = (id) => (SERVICE.get(id) || { label: id }).label;

export function createCalendarViews({ api, $, el, icon, alertBox, busy, apiProblem, goPanel, onMode = () => {} }) {
  let garageId = null;
  let st = null; // réponse de GET …/rdv/calendar
  let cur = 1; // étape affichée (1 à 6)
  let check = null; // réponse de POST …/calendar/check (étape 6)
  let placements = {}; // { requestId: { staff: [id], station } } choisis à la main à l'étape 6
  let dlg = null; // { kind, item, armed }
  const fail = (e) => {
    if (!apiProblem(e)) alertBox(e.message);
  };
  const live = (text) => ($("calLive").textContent = text);
  const advanced = () => st && st.mode === "advanced";

  // ================================================================= ouverture, étapes
  async function open(id, { focus = true, step = null } = {}) {
    garageId = id;
    alertBox("");
    st = await api.calendar(id);
    if (!st.started) st = await api.calStart(id);
    cur = step || (advanced() ? 2 : Math.min(6, Math.max(1, st.step + 1)));
    check = null;
    placements = {};
    render();
    if (focus) $("calTitle").focus();
  }
  const put = (out) => {
    st = out;
    render();
  };
  async function go(n, { save = false } = {}) {
    if (save && !advanced() && n > st.step) {
      try {
        st = await api.calSettings(garageId, { step: Math.min(6, n - 1) });
      } catch (e) {
        return fail(e);
      }
    }
    cur = n;
    if (n === 6) await runCheck();
    render();
    $("calStepTitle").focus();
  }

  function render() {
    onMode(st.mode); // le menu montre « Planning » en mode avancé
    $("calTitle").textContent = advanced() ? "Mon atelier" : "Calendrier avancé";
    $("calLead").textContent = advanced()
      ? "Le mode avancé est actif : les horaires proposés tiennent compte de vos mécaniciens, de vos postes et du temps de chaque prestation."
      : "Six étapes pour que Pixcar propose des horaires selon vos vraies ressources. Tout est enregistré au fur et à mesure ; rien ne change pour vos clients avant l'activation.";
    $("calSteps").replaceChildren(
      ...STEPS.map(([key, name], i) =>
        el(
          "li",
          { class: i + 1 === cur ? "cur" : !advanced() && i + 1 <= st.step ? "done" : "" },
          el("button", { type: "button", "data-step": String(i + 1), "aria-current": i + 1 === cur ? "step" : null, onclick: () => go(i + 1).catch(fail) }, el("span", { "aria-hidden": "true", text: String(i + 1) }), i === 5 && advanced() ? "Contrôles" : name),
        ),
      ),
    );
    const [key, name, sub] = STEPS[cur - 1];
    const body = { garage: stepGarage, staff: stepStaff, resources: stepResources, services: stepServices, booking: stepBooking, check: stepCheck }[key]();
    $("calBody").replaceChildren(el("div", { class: "cal-head" }, el("h2", { id: "calStepTitle", tabindex: "-1", text: `${cur}. ${cur === 6 && advanced() ? "Contrôles et conflits" : name}` }), el("p", { class: "sub", text: sub })), ...body.filter((b) => b != null));
    const foot = [];
    if (cur > 1) foot.push(el("button", { type: "button", class: "btn", onclick: () => go(cur - 1).catch(fail) }, "Précédent"));
    if (cur < 6) foot.push(el("button", { type: "button", class: "btn primary", id: "calNext", onclick: () => go(cur + 1, { save: true }).catch(fail) }, advanced() ? "Suivant" : "Continuer"));
    $("calFoot").replaceChildren(...foot);
  }

  // un petit menu de valeurs (minutes, pourcentages…)
  function choice(id, labelText, small, values, value, onchange) {
    const s = el("select", { id }, ...values.map(([v, t]) => el("option", { value: String(v), text: t, selected: v === value })));
    s.addEventListener("change", () => onchange(Number(s.value), s));
    return el("div", { class: "ag-rule" }, el("label", { for: id }, labelText, small ? el("small", { text: small }) : null), s);
  }
  const saving = (fn) => async (v, s) => {
    s.disabled = true;
    try {
      await fn(v);
      live("Enregistré.");
    } catch (e) {
      fail(e);
    } finally {
      s.disabled = false;
    }
  };

  // ================================================================= 1. garage
  function stepGarage() {
    const hours = st.hours ? hoursText(st.hours) : "";
    const b = st.booking;
    const soon = st.closures.slice(0, 3).map((c) => el("li", { text: `${c.label || "Fermeture"} : ${c.first === c.last ? dayLabel(c.first) : `du ${dayLabel(c.first)} au ${dayLabel(c.last)}`}` }));
    return [
      el(
        "section",
        { class: "mg-panel", "aria-labelledby": "calHoursTitle" },
        el("div", { class: "mg-head" }, el("h3", { id: "calHoursTitle", text: "Horaires et pauses" }), el("button", { type: "button", class: "btn small", onclick: () => goPanel("garage") }, "Modifier dans Mon garage")),
        el("p", { class: hours ? "" : "warn", text: hours || "Pas encore renseignés : ils sont nécessaires au calcul des horaires." }),
        el("p", { class: "help", text: "Les pauses sont les coupures de vos horaires (12:00–14:00 par exemple) : le travail s'y interrompt et reprend après, la voiture reste sur son poste. Chaque mécanicien peut avoir ses propres horaires (étape 2)." }),
      ),
      el(
        "section",
        { class: "mg-panel", "aria-labelledby": "calClosTitle" },
        el("div", { class: "mg-head" }, el("h3", { id: "calClosTitle", text: "Fermetures" }), el("button", { type: "button", class: "btn small", onclick: () => goPanel("agenda") }, "Gérer dans Disponibilités")),
        soon.length ? el("ul", { class: "cal-mini" }, ...soon) : el("p", { class: "muted", text: "Aucune fermeture à venir. Les jours fériés sont réglés dans Disponibilités." }),
      ),
      el(
        "section",
        { class: "mg-panel", "aria-labelledby": "calDelayTitle" },
        el("h3", { id: "calDelayTitle", text: "Délais et marges" }),
        choice("calDelay", "Délai minimum", "avant un rendez-vous", [[0, "Aucun"], [2, "2 heures"], [4, "4 heures"], [24, "24 heures"], [48, "48 heures"]], b.minDelayH, saving(async (v) => (st = { ...st, booking: { ...st.booking, ...(await api.rdvSettings(garageId, { minDelayH: v })).settings } }))),
        choice("calHorizon", "Jusqu'à", "combien de temps à l'avance", [[7, "1 semaine"], [14, "2 semaines"], [21, "3 semaines"], [28, "4 semaines"]], b.horizonDays, saving(async (v) => (st = { ...st, booking: { ...st.booking, ...(await api.rdvSettings(garageId, { horizonDays: v })).settings } }))),
        choice("calStep", "Horaires proposés", "pour les rendez-vous à l'heure", [[15, "toutes les 15 min"], [30, "toutes les 30 min"], [60, "toutes les heures"]], b.stepMin, saving(async (v) => (st = { ...st, booking: { ...st.booking, ...(await api.rdvSettings(garageId, { stepMin: v })).settings } }))),
        choice("calReception", "Accueil du véhicule", "entre l'arrivée et le début des travaux", [0, 5, 10, 15, 20, 30].map((m) => [m, m ? `${m} min` : "Aucun"]), st.settings.receptionMin, saving(async (v) => (st = await api.calSettings(garageId, { receptionMin: v })))),
        choice("calReturn", "Marge de restitution", "entre la fin des travaux et l'heure annoncée au client", [0, 10, 15, 30, 45, 60].map((m) => [m, m ? `${m} min` : "Aucune"]), st.settings.returnMin, saving(async (v) => (st = await api.calSettings(garageId, { returnMin: v })))),
      ),
    ];
  }

  // ================================================================= 2. personnel
  const skillName = (id) => (st.skills.find((k) => k.id === id) || { label: "" }).label;
  const unavailItem = (u) => el("li", {}, el("span", { text: u.text }), el("button", { type: "button", class: "link-btn", "aria-label": `Retirer : ${u.text}`, onclick: (ev) => removeUnavail(u, ev.currentTarget) }, "Retirer"));
  function stepStaff() {
    const list = st.staff.map((m) =>
      el(
        "li",
        { class: "cal-item", "data-id": m.id },
        el(
          "div",
          { class: "cal-item-main" },
          el("p", { class: "cal-item-name" }, el("b", { text: m.name }), el("span", { class: `pill ${m.active ? "ok" : "off"}`, text: m.active ? "Actif" : "Désactivé" })),
          el("p", { class: "cal-item-sub", text: [m.hours ? hoursText(m.hours) : "Horaires du garage", m.services ? plural(m.services.length, "prestation autorisée", "prestations autorisées") : "Toutes les prestations"].join(" · ") }),
          m.skills.length ? el("p", { class: "cal-tags" }, ...m.skills.map((k) => el("span", { class: "cal-tag", text: skillName(k.id) + (k.until ? ` (jusqu'au ${dayLabel(k.until, { short: true })})` : "") }))) : el("p", { class: "cal-item-sub muted", text: "Aucune compétence cochée" }),
          m.unavail.length ? el("ul", { class: "cal-unav" }, ...m.unavail.map(unavailItem)) : null,
        ),
        el("div", { class: "cal-item-acts" }, el("button", { type: "button", class: "btn small", onclick: () => openStaff(m) }, "Modifier"), el("button", { type: "button", class: "btn small", onclick: () => openUnavail("staff", m) }, "Absence")),
      ),
    );
    return [
      el(
        "section",
        { class: "mg-panel", "aria-labelledby": "calStaffTitle" },
        el("div", { class: "mg-head" }, el("h3", { id: "calStaffTitle", text: `Mécaniciens · ${st.staff.length}` }), el("button", { type: "button", class: "btn primary small", id: "calAddStaff", onclick: () => openStaff(null) }, icon("i-plus"), "Ajouter")),
        list.length ? el("ul", { class: "cal-list" }, ...list) : el("p", { class: "empty", text: "Aucun mécanicien pour l'instant. Ajoutez une fiche par personne qui travaille à l'atelier : le prénom suffit." }),
      ),
      el(
        "section",
        { class: "mg-panel", "aria-labelledby": "calSkillsTitle" },
        el("h3", { id: "calSkillsTitle", text: "Compétences et habilitations" }),
        el("p", { class: "help", text: "Une prestation peut demander une compétence ; une habilitation a en plus une date de fin, par mécanicien. Nous en avons proposé : renommez, supprimez ou ajoutez les vôtres." }),
        el("ul", { class: "cal-skills" }, ...st.skills.map((k) => el("li", {}, el("span", { text: k.label }), k.cert ? el("small", { text: "habilitation" }) : null, el("button", { type: "button", class: "icon-btn", "aria-label": `Supprimer « ${k.label} »`, onclick: (ev) => removeSkill(k, ev.currentTarget) }, icon("i-close"))))),
        el(
          "form",
          { class: "ag-inline cal-skill-form", novalidate: true, onsubmit: addSkill },
          el("label", { class: "sr-only", for: "calSkillName", text: "Nouvelle compétence" }),
          el("input", { id: "calSkillName", type: "text", maxlength: "50", placeholder: "Nouvelle compétence", autocomplete: "off" }),
          el("label", { class: "check cal-inline-check" }, el("input", { type: "checkbox", id: "calSkillCert" }), el("span", { text: "Habilitation" })),
          el("button", { type: "submit", class: "btn small", id: "calSkillAdd" }, "Ajouter"),
        ),
        el("p", { class: "field-err", id: "calSkillErr", hidden: true }),
      ),
    ];
  }
  async function addSkill(ev) {
    ev.preventDefault();
    const name = $("calSkillName").value.trim();
    const err = $("calSkillErr");
    await busy($("calSkillAdd"), async () => {
      try {
        put(await api.saveSkill(garageId, null, { label: name, cert: $("calSkillCert").checked }));
        live(`Compétence « ${name} » ajoutée.`);
        $("calSkillName").focus();
      } catch (e) {
        if (e.status === 422 || e.status === 409) {
          err.textContent = e.message;
          err.hidden = false;
          return;
        }
        fail(e);
      }
    });
  }
  async function removeSkill(k, button) {
    if (button.dataset.armed !== "1") {
      button.dataset.armed = "1";
      button.setAttribute("aria-label", `Confirmer la suppression de « ${k.label} »`);
      button.classList.add("armed");
      live(`Touchez encore pour supprimer « ${k.label} » des fiches et des prestations.`);
      return;
    }
    await busy(button, async () => {
      try {
        put(await api.deleteSkill(garageId, k.id));
        live(`Compétence « ${k.label} » supprimée.`);
      } catch (e) {
        fail(e);
      }
    });
  }
  async function removeUnavail(u, button) {
    await busy(button, async () => {
      try {
        put(await api.deleteUnavail(garageId, u.id));
        live("Retiré.");
      } catch (e) {
        fail(e);
      }
    });
  }

  // ================================================================= volet commun (fiches)
  function sheet(kind, title, eyebrow, fields, { onsubmit, onDelete = null, deleteLabel = "" }) {
    dlg = { kind, armed: false };
    const form = $("calForm");
    const del = onDelete ? el("button", { type: "button", class: "link-btn danger", id: "calDel", onclick: () => remove(onDelete, deleteLabel) }, deleteLabel) : null;
    form.replaceChildren(
      el("div", { class: "sheet-head" }, el("div", {}, eyebrow ? el("p", { class: "eyebrow", text: eyebrow }) : null, el("h2", { id: "calDlgTitle", text: title })), el("button", { type: "button", class: "icon-btn", "aria-label": "Fermer", onclick: () => $("calDlg").close() }, icon("i-close"))),
      ...fields.filter((f) => f != null),
      el("p", { class: "field-err", id: "calErr", role: "alert", hidden: true }),
      el("div", { class: "sheet-actions" }, el("button", { class: "btn primary", type: "submit", id: "calSave" }, "Enregistrer"), el("button", { class: "btn", type: "button", onclick: () => $("calDlg").close() }, "Annuler"), del),
    );
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      await busy($("calSave"), async () => {
        try {
          await onsubmit();
        } catch (e) {
          if (e.status === 422 || e.status === 409) return err(e.message);
          $("calDlg").close();
          fail(e);
        }
      });
    };
    $("calDlg").showModal();
    const first = form.querySelector("input, select");
    if (first) first.focus();
  }
  function err(message) {
    $("calErr").textContent = message || "";
    $("calErr").hidden = !message;
  }
  async function remove(fn, text) {
    if (!dlg.armed) {
      dlg.armed = true;
      $("calDel").textContent = "Confirmer la suppression";
      return;
    }
    await busy($("calDel"), async () => {
      try {
        put(await fn());
        $("calDlg").close();
        live(`${text} : fait.`);
      } catch (e) {
        if (e.status === 409) return err(e.message);
        $("calDlg").close();
        fail(e);
      }
    });
  }
  const field = (id, text, input, help) => el("div", { class: "cal-field" }, el("label", { for: id, text }), input, help ? el("p", { class: "help", id: id + "Help", text: help }) : null);
  const input = (attrs, value = "") => Object.assign(el("input", attrs), { value });
  const checkbox = (id, text, checked, attrs = {}) => el("label", { class: "check" }, el("input", { type: "checkbox", id, checked: !!checked, ...attrs }), el("span", { text }));

  // horaires propres : « comme le garage », ou une semaine (deux plages par jour au plus)
  function hoursBlock(prefix, hours, what) {
    const own = !!hours;
    const grid = el("div", { class: "mg-days cal-hours", id: prefix + "Days", hidden: !own });
    for (const [k, long] of DAYS) {
      const slots = (hours && hours[k]) || [];
      const time = (i, j, w) => {
        const v = (slots[i] && slots[i][j]) || "";
        return el("select", { "data-day": k, "data-slot": `${i}${j}`, "aria-label": `${long}, ${w}` }, el("option", { value: "", text: "—", selected: !v }), ...TIMES.map((t) => el("option", { value: t, text: timeLabel(minOf(t)), selected: t === v })));
      };
      grid.append(
        el(
          "fieldset",
          { class: "mg-day" },
          el("legend", { text: long }),
          el("label", { class: "check" }, el("input", { type: "checkbox", "data-open": k, checked: slots.length > 0 }), el("span", { text: "Présent" })),
          el("span", { class: "mg-slot" }, time(0, 0, "début"), "–", time(0, 1, "fin")),
          el("span", { class: "mg-slot" }, time(1, 0, "reprise"), "–", time(1, 1, "fin du soir")),
        ),
      );
    }
    const radios = el(
      "fieldset",
      { class: "ag-modes" },
      el("legend", { text: what }),
      el("label", {}, el("input", { type: "radio", name: prefix + "Mode", value: "garage", checked: !own, onchange: () => (grid.hidden = true) }), el("span", {}, el("b", { text: "Ceux du garage" }), el("small", { text: st.hours ? hoursText(st.hours) : "Mon garage › Horaires" }))),
      el("label", {}, el("input", { type: "radio", name: prefix + "Mode", value: "own", checked: own, onchange: () => (grid.hidden = false) }), el("span", {}, el("b", { text: "Des horaires propres" }), el("small", { text: "Toujours dans les horaires d'ouverture du garage." }))),
    );
    const read = () => {
      if (document.querySelector(`input[name="${prefix}Mode"]:checked`).value === "garage") return { value: null };
      const out = {};
      for (const [k, long] of DAYS) {
        if (!grid.querySelector(`input[data-open="${k}"]`).checked) continue;
        const v = (slot) => grid.querySelector(`[data-day="${k}"][data-slot="${slot}"]`).value;
        const slots = [];
        for (const i of [0, 1]) {
          const a = v(`${i}0`), b = v(`${i}1`);
          if (!a && !b) continue;
          if (!a || !b) return { error: `${long} : indiquez le début et la fin.` };
          slots.push([a, b]);
        }
        if (!slots.length) return { error: `${long} : indiquez une plage, ou décochez « Présent ».` };
        out[k] = slots;
      }
      return Object.keys(out).length ? parseHours(out) : { error: "Cochez au moins un jour, ou choisissez « Ceux du garage »." };
    };
    return { nodes: [radios, grid], read };
  }
  // prestations : toutes, ou une sélection parmi celles du garage
  function servicesBlock(prefix, chosen, what) {
    const ids = st.services.map((s) => s.id);
    const some = !!chosen;
    const boxes = el("div", { class: "cal-checks", id: prefix + "Svcs", hidden: !some }, ...ids.map((id) => el("label", { class: "check" }, el("input", { type: "checkbox", value: id, checked: some ? chosen.includes(id) : true }), el("span", { text: label(id) }))));
    const radios = el(
      "fieldset",
      { class: "ag-modes" },
      el("legend", { text: what }),
      el("label", {}, el("input", { type: "radio", name: prefix + "Scope", value: "all", checked: !some, onchange: () => (boxes.hidden = true) }), el("span", {}, el("b", { text: "Toutes" }))),
      el("label", {}, el("input", { type: "radio", name: prefix + "Scope", value: "some", checked: some, onchange: () => (boxes.hidden = false) }), el("span", {}, el("b", { text: "Certaines seulement" }))),
    );
    const read = () => {
      if (document.querySelector(`input[name="${prefix}Scope"]:checked`).value === "all") return null;
      return [...boxes.querySelectorAll("input:checked")].map((x) => x.value);
    };
    return { nodes: [radios, boxes], read };
  }

  // ---- fiche d'un mécanicien
  function openStaff(m) {
    const hours = hoursBlock("calStaffH", m ? m.hours : null, "Horaires de travail");
    const svcs = servicesBlock("calStaffS", m ? m.services : null, "Prestations qu'il ou elle peut faire");
    const skills = el(
      "fieldset",
      { class: "cal-checks" },
      el("legend", { text: "Compétences et habilitations" }),
      ...st.skills.map((k) => {
        const mine = m && m.skills.find((x) => x.id === k.id);
        return el(
          "div",
          { class: "cal-skill" },
          el("label", { class: "check" }, el("input", { type: "checkbox", value: k.id, checked: !!mine }), el("span", { text: k.label })),
          k.cert ? el("label", { class: "cal-until" }, el("span", { text: "valable jusqu'au" }), input({ type: "date", "data-until": k.id, "aria-label": `${k.label} : valable jusqu'au` }, (mine && mine.until) || "")) : null,
        );
      }),
    );
    sheet(
      "staff",
      m ? "Modifier la fiche" : "Nouveau mécanicien",
      "Personnel",
      [
        field("calStaffName", "Nom", input({ id: "calStaffName", type: "text", maxlength: "60", autocomplete: "off", placeholder: "Prénom", "aria-describedby": "calStaffNameHelp" }, m ? m.name : ""), "Le prénom suffit : ce nom ne sort pas de votre Espace Pro."),
        checkbox("calStaffActive", "Fiche active (comptée dans les horaires proposés)", m ? m.active : true),
        ...hours.nodes,
        skills,
        ...svcs.nodes,
        m && m.active ? el("p", { class: "help", text: "Désactiver la fiche n'efface rien : ses rendez-vous à venir sont signalés en conflit pour que vous les réaffectiez." }) : null,
      ],
      {
        onsubmit: async () => {
          const h = hours.read();
          if (h.error) return err(h.error);
          const services = svcs.read();
          if (services && !services.length) return err("Cochez au moins une prestation, ou choisissez « Toutes ».");
          const chosen = [...document.querySelectorAll("#calForm .cal-skill input[type=checkbox]:checked")].map((x) => ({ id: x.value, until: (document.querySelector(`#calForm [data-until="${x.value}"]`) || { value: "" }).value || null }));
          const out = await api.saveStaff(garageId, m && m.id, { name: $("calStaffName").value.trim(), active: $("calStaffActive").checked, hours: h.value, services, skills: chosen });
          $("calDlg").close();
          put(out);
          live(m ? "Fiche enregistrée." : "Mécanicien ajouté.");
        },
        onDelete: m ? () => api.deleteStaff(garageId, m.id) : null,
        deleteLabel: "Supprimer la fiche",
      },
    );
  }

  // ---- absence d'un mécanicien, indisponibilité d'un poste
  function openUnavail(target, x) {
    const kinds = st.catalogs.kinds.filter((k) => k.for === target || k.for === "both");
    const today = st.today;
    const opt = (id) => el("select", { id }, el("option", { value: "", text: "toute la journée" }), ...TIMES5.filter((t) => t >= "06:00" && t <= "21:00").map((t) => el("option", { value: t, text: timeLabel(minOf(t)) })));
    sheet(
      "unavail",
      target === "staff" ? `Absence de ${x.name}` : `${x.name} indisponible`,
      target === "staff" ? "Personnel" : "Équipements",
      [
        field("calUnKind", "Motif", el("select", { id: "calUnKind" }, ...kinds.map((k) => el("option", { value: k.id, text: k.label })))),
        el("div", { class: "row2" }, field("calUnFirst", "Du", input({ id: "calUnFirst", type: "date", min: today }, today)), field("calUnLast", "Au", input({ id: "calUnLast", type: "date", min: today }, today))),
        el("div", { class: "row2" }, field("calUnFrom", "À partir de", opt("calUnFrom")), field("calUnTo", "Jusqu'à", opt("calUnTo"))),
        el("p", { class: "help", text: "Sans heure : journées entières. Les rendez-vous déjà affectés ne bougent pas : ils sont signalés en conflit pour que vous décidiez." }),
        field("calUnLabel", "Précision (facultatif)", input({ id: "calUnLabel", type: "text", maxlength: "60", autocomplete: "off", "aria-describedby": "calUnLabelHelp" })),
        el("p", { class: "help", id: "calUnLabelHelp", text: "N'indiquez pas de motif médical ni d'information personnelle : « Congés », « Formation » ou « Absence » suffisent." }),
      ],
      {
        onsubmit: async () => {
          const out = await api.saveUnavail(garageId, {
            target,
            targetId: x.id,
            kind: $("calUnKind").value,
            first: $("calUnFirst").value,
            last: $("calUnLast").value || $("calUnFirst").value,
            from: $("calUnFrom").value || undefined,
            to: $("calUnTo").value || undefined,
            label: $("calUnLabel").value.trim(),
          });
          $("calDlg").close();
          put(out);
          const n = (out.touched || []).length;
          if (n) alertBox(`${plural(n, "rendez-vous à venir est concerné", "rendez-vous à venir sont concernés")} : voyez « Contrôles et conflits » (étape 6) pour les réaffecter ou les déplacer.`, "info");
          live("Enregistré.");
        },
      },
    );
  }

  // ================================================================= 3. équipements
  const typeName = (id) => (st.catalogs.types.find((t) => t.id === id) || { label: id }).label;
  function stepResources() {
    const list = st.resources.map((r) =>
      el(
        "li",
        { class: "cal-item", "data-id": r.id },
        el(
          "div",
          { class: "cal-item-main" },
          el("p", { class: "cal-item-name" }, el("b", { text: r.name }), el("span", { class: `pill ${r.active ? "ok" : "off"}`, text: r.active ? "Disponible" : "Indisponible" })),
          el("p", { class: "cal-item-sub", text: [typeName(r.type), r.hours ? hoursText(r.hours) : "Heures du garage", r.services ? plural(r.services.length, "prestation compatible", "prestations compatibles") : "Toutes les prestations de ce type"].join(" · ") }),
          r.unavail.length ? el("ul", { class: "cal-unav" }, ...r.unavail.map(unavailItem)) : null,
        ),
        el("div", { class: "cal-item-acts" }, el("button", { type: "button", class: "btn small", onclick: () => openResource(r) }, "Modifier"), el("button", { type: "button", class: "btn small", onclick: () => openUnavail("resource", r) }, "Maintenance")),
      ),
    );
    return [
      el(
        "section",
        { class: "mg-panel", "aria-labelledby": "calResTitle" },
        el("div", { class: "mg-head" }, el("h3", { id: "calResTitle", text: `Postes et équipements · ${st.resources.length}` }), el("button", { type: "button", class: "btn primary small", id: "calAddRes", onclick: () => openResource(null) }, icon("i-plus"), "Ajouter")),
        list.length ? el("ul", { class: "cal-list" }, ...list) : el("p", { class: "empty", text: "Aucun poste pour l'instant. Ajoutez chaque pont, poste ou équipement qui ne sert qu'à une voiture à la fois (deux ponts : deux fiches)." }),
        el("p", { class: "help", text: "Une prestation sans poste (une batterie par exemple) se planifie sans pont. Un équipement demandé en plus (station de climatisation…) est réservé pendant la main-d'œuvre." }),
      ),
    ];
  }
  function openResource(r) {
    const hours = hoursBlock("calResH", r ? r.hours : null, "Heures d'utilisation");
    const svcs = servicesBlock("calResS", r ? r.services : null, "Prestations compatibles");
    sheet(
      "resource",
      r ? "Modifier le poste" : "Nouveau poste ou équipement",
      "Équipements",
      [
        field("calResName", "Nom", input({ id: "calResName", type: "text", maxlength: "40", autocomplete: "off", placeholder: "Pont n°1" }, r ? r.name : "")),
        field("calResType", "Type", el("select", { id: "calResType" }, ...st.catalogs.types.map((t) => el("option", { value: t.id, text: t.label, selected: r ? r.type === t.id : t.id === "lift" })))),
        checkbox("calResActive", "Disponible", r ? r.active : true),
        ...hours.nodes,
        ...svcs.nodes,
      ],
      {
        onsubmit: async () => {
          const h = hours.read();
          if (h.error) return err(h.error);
          const services = svcs.read();
          if (services && !services.length) return err("Cochez au moins une prestation, ou choisissez « Toutes ».");
          const out = await api.saveResource(garageId, r && r.id, { name: $("calResName").value.trim(), type: $("calResType").value, active: $("calResActive").checked, hours: h.value, services });
          $("calDlg").close();
          put(out);
          live(r ? "Poste enregistré." : "Poste ajouté.");
        },
        onDelete: r ? () => api.deleteResource(garageId, r.id) : null,
        deleteLabel: "Supprimer le poste",
      },
    );
  }

  // ================================================================= 4. prestations
  function reqSummary(s) {
    const q = s.req;
    if (!q) return "À régler";
    return [minText(q.labour) + (s.unit ? ` ${s.unit}` : ""), q.stations.length ? q.stations.map(typeName).join(" ou ") : "sans poste", q.skills.length ? q.skills.map(skillName).join(", ") : "", q.staffN > 1 ? `${q.staffN} mécaniciens` : "", q.drop ? "dépôt" : ""].filter(Boolean).join(" · ");
  }
  function stepServices() {
    if (!st.services.length) return [el("p", { class: "empty", text: "Aucune prestation déclarée. Indiquez d'abord celles que vous faites dans Mon garage › Prestations effectuées." })];
    return [
      el(
        "ul",
        { class: "cal-list" },
        ...st.services.map((s) =>
          el(
            "li",
            { class: "cal-item", "data-id": s.id },
            el(
              "div",
              { class: "cal-item-main" },
              el("p", { class: "cal-item-name" }, el("b", { text: s.label }), s.req && !s.req.online ? el("span", { class: "pill off", text: "Pas en ligne" }) : null),
              el("p", { class: "cal-item-sub", text: reqSummary(s) }),
            ),
            el("div", { class: "cal-item-acts" }, el("button", { type: "button", class: "btn small", "aria-label": `Régler : ${s.label}`, onclick: () => openReq(s) }, "Régler")),
          ),
        ),
      ),
      el("p", { class: "help", text: "Main-d'œuvre : le temps des mécaniciens. Immobilisation : le temps où le poste est occupé (main-d'œuvre et attente). Temps commun : installation, levage… compté une seule fois quand plusieurs prestations se font ensemble." }),
    ];
  }
  function openReq(s) {
    const q = s.req || { online: true, labour: s.minutes || 60, shared: 0, immob: s.minutes || 60, staffN: 1, skills: [], stations: [], tools: [], margin: 0, auto: false, parts: false, partsH: 0, drop: false, vehicles: {} };
    const num = (id, value) => input({ id, type: "text", inputmode: "numeric", maxlength: "3", class: "cal-num", autocomplete: "off" }, String(value));
    const types = (name, chosen) => el("div", { class: "cal-checks" }, ...st.catalogs.types.map((t) => el("label", { class: "check" }, el("input", { type: "checkbox", name, value: t.id, checked: chosen.includes(t.id) }), el("span", { text: t.label }))));
    const vehicleRows = st.catalogs.vehicles.map((v) => {
      const d = q.vehicles[v.id];
      return el("div", { class: "cal-vrow" }, el("span", { text: v.label }), num(`calV-${v.id}-l`, d ? d.labour : ""), num(`calV-${v.id}-i`, d ? d.immob : ""));
    });
    sheet(
      "req",
      s.label,
      `Prestation${s.unit ? ` · temps ${s.unit}` : ""}`,
      [
        checkbox("calReqOnline", "Proposée à la réservation en ligne", q.online),
        el("div", { class: "cal-row3" }, field("calReqLabour", "Main-d'œuvre (min)", num("calReqLabour", q.labour)), field("calReqShared", "dont temps commun", num("calReqShared", q.shared)), field("calReqImmob", "Immobilisation (min)", num("calReqImmob", q.immob))),
        el("div", { class: "row2" }, field("calReqStaff", "Mécaniciens nécessaires", el("select", { id: "calReqStaff" }, ...[1, 2, 3].map((n) => el("option", { value: String(n), text: String(n), selected: n === q.staffN })))), field("calReqMargin", "Marge de sécurité", el("select", { id: "calReqMargin" }, ...[0, 5, 10, 15, 20, 30, 45, 60].map((n) => el("option", { value: String(n), text: n ? `${n} min` : "Aucune", selected: n === q.margin }))))),
        el("fieldset", { class: "cal-set" }, el("legend", { text: "Où se fait-elle ?" }), el("p", { class: "help", text: "Un poste parmi les types cochés ; aucun coché : sans poste." }), types("calReqSt", q.stations)),
        el("fieldset", { class: "cal-set" }, el("legend", { text: "Équipement en plus" }), types("calReqTo", q.tools)),
        el("fieldset", { class: "cal-set" }, el("legend", { text: "Compétences demandées" }), el("div", { class: "cal-checks" }, ...st.skills.map((k) => el("label", { class: "check" }, el("input", { type: "checkbox", name: "calReqSk", value: k.id, checked: q.skills.includes(k.id) }), el("span", { text: k.label }))))),
        checkbox("calReqDrop", "Le client laisse sa voiture (arrivée en début de matinée ou d'après-midi, restitution annoncée)", q.drop),
        checkbox("calReqParts", "Pièces à vérifier avant de confirmer", q.parts),
        field("calReqPartsH", "Délai de commande des pièces", el("select", { id: "calReqPartsH" }, ...st.catalogs.partsDelays.map((h) => el("option", { value: String(h), text: h ? `${h / 24} jour${h > 24 ? "s" : ""}` : "Aucun", selected: h === q.partsH })))),
        el("details", { class: "cal-vehicles", open: Object.keys(q.vehicles).length > 0 }, el("summary", { text: "Durées selon le véhicule (facultatif)" }), el("p", { class: "help", text: "Main-d'œuvre et immobilisation en minutes ; vide : comme d'habitude. Le client choisit alors son type de véhicule." }), el("div", { class: "cal-vrow head", "aria-hidden": "true" }, el("span"), el("span", { text: "Main-d'œuvre" }), el("span", { text: "Immobilisation" })), ...vehicleRows),
      ],
      {
        onsubmit: async () => {
          const n = (id) => (($(id).value || "").trim() === "" ? undefined : Number($(id).value.trim()));
          const vehicles = {};
          for (const v of st.catalogs.vehicles) {
            const l = n(`calV-${v.id}-l`), i = n(`calV-${v.id}-i`);
            if (l !== undefined || i !== undefined) vehicles[v.id] = { labour: l === undefined ? n("calReqLabour") : l, immob: i === undefined ? Math.max(l || 0, n("calReqImmob") || 0) : i };
          }
          const checked = (name) => [...document.querySelectorAll(`#calForm input[name="${name}"]:checked`)].map((x) => x.value);
          const parts = $("calReqParts").checked;
          const out = await api.saveReq(garageId, s.id, {
            online: $("calReqOnline").checked,
            labour: n("calReqLabour"),
            shared: n("calReqShared") || 0,
            immob: n("calReqImmob"),
            staffN: Number($("calReqStaff").value),
            margin: Number($("calReqMargin").value),
            stations: checked("calReqSt"),
            tools: checked("calReqTo"),
            skills: checked("calReqSk"),
            drop: $("calReqDrop").checked,
            parts,
            partsH: parts ? Number($("calReqPartsH").value) : 0,
            auto: parts ? false : !!q.auto,
            vehicles,
          });
          $("calDlg").close();
          put(out);
          live(`${s.label} : enregistré.`);
        },
      },
    );
  }

  // ================================================================= 5. réservation
  function stepBooking() {
    const rows = st.services.filter((s) => s.req).map((s) => {
      const id = `calAuto-${s.id}`;
      const blocked = s.req.parts;
      return el(
        "div",
        { class: "ag-row cal-auto" },
        el("span", {}, el("b", { id: id + "L", text: s.label }), el("small", { id: id + "T", text: blocked ? "Pièces à vérifier : vous confirmez." : s.req.auto ? "Confirmée dès la demande" : "Vous confirmez chaque demande" })),
        el("button", { type: "button", class: "tgl", role: "switch", id, "aria-checked": String(!!s.req.auto), "aria-labelledby": id + "L", "aria-describedby": id + "T", disabled: blocked, onclick: (ev) => setAuto([s], !s.req.auto, ev.currentTarget) }),
      );
    });
    const all = st.services.filter((s) => s.req && !s.req.parts);
    const c = st.settings;
    return [
      el(
        "section",
        { class: "mg-panel", "aria-labelledby": "calAutoTitle" },
        el("div", { class: "mg-head" }, el("h3", { id: "calAutoTitle", text: "Confirmation" }), el("span", { class: "cal-bulk" }, el("button", { type: "button", class: "btn small", onclick: (ev) => setAuto(all, true, ev.currentTarget) }, "Tout en automatique"), el("button", { type: "button", class: "btn small", onclick: (ev) => setAuto(all, false, ev.currentTarget) }, "Tout à confirmer"))),
        el("p", { class: "help", text: "Automatique : le rendez-vous est confirmé dès la demande, les ressources sont réservées, vous êtes prévenu par e-mail. Une demande qui mêle une prestation à confirmer reste à confirmer." }),
        ...(rows.length ? rows : [el("p", { class: "muted", text: "Réglez d'abord vos prestations (étape 4)." })]),
      ),
      el(
        "section",
        { class: "mg-panel", "aria-labelledby": "calCapTitle" },
        el("h3", { id: "calCapTitle", text: "Capacité en ligne" }),
        choice("calLoad", "Part de la capacité ouverte en ligne", "le reste pour le comptoir et le téléphone", [100, 90, 80, 70, 60, 50].map((p) => [p, p === 100 ? "Toute" : `${p} %`]), c.loadPct, saving(async (v) => (st = await api.calSettings(garageId, { loadPct: v })))),
        choice("calMaxDay", "Rendez-vous en ligne par jour", "au plus", [[0, "Sans limite"], ...[1, 2, 3, 4, 5, 6, 8, 10, 15, 20].map((n) => [n, String(n)])], c.maxDay, saving(async (v) => (st = await api.calSettings(garageId, { maxDay: v })))),
        el(
          "div",
          { class: "ag-row" },
          el("span", {}, el("b", { id: "calAssignL", text: "Affecter automatiquement les mécaniciens" }), el("small", { id: "calAssignT", text: c.autoAssign ? "Pixcar choisit le mécanicien et le poste ; vous pouvez changer." : "Pixcar propose un mécanicien et un poste ; vous confirmez." })),
          el("button", { type: "button", class: "tgl", role: "switch", id: "calAssign", "aria-checked": String(c.autoAssign), "aria-labelledby": "calAssignL", "aria-describedby": "calAssignT", onclick: (ev) => toggleAssign(ev.currentTarget) }),
        ),
      ),
      el(
        "section",
        { class: "mg-panel", "aria-labelledby": "calNotifTitle" },
        el("h3", { id: "calNotifTitle", text: "Demandes et notifications" }),
        st.notify ? el("p", { class: "ag-notify-now" }, icon("i-check"), `Les demandes et les confirmations arrivent à ${st.notify}.`) : el("p", { class: "warn", text: "Aucune adresse ne reçoit encore les demandes." }),
        el("button", { type: "button", class: "btn small", onclick: () => goPanel("agenda") }, st.notify ? "Changer d'adresse (Disponibilités)" : "Indiquer l'adresse (Disponibilités)"),
      ),
    ];
  }
  async function setAuto(list, on, button) {
    await busy(button, async () => {
      try {
        let out = st;
        for (const s of list) if (!!s.req.auto !== on) out = await api.saveReq(garageId, s.id, { ...s.req, auto: on });
        put(out);
        live(on ? "Confirmation automatique." : "Confirmation par vous.");
      } catch (e) {
        fail(e);
      }
    });
  }
  async function toggleAssign(button) {
    await busy(button, async () => {
      try {
        put(await api.calSettings(garageId, { autoAssign: !st.settings.autoAssign }));
        live("Enregistré.");
      } catch (e) {
        fail(e);
      }
    });
  }

  // ================================================================= 6. vérification, activation, conflits
  async function runCheck() {
    if (advanced()) return;
    try {
      check = await api.calCheck(garageId, { placements: Object.entries(placements).map(([requestId, p]) => ({ requestId, ...p })) });
    } catch (e) {
      check = null;
      fail(e);
    }
  }
  const whenText = (r) => `${r.when.label} · ${r.services.map((s) => s.label).join(" + ")}${r.client ? ` · ${r.client}` : ""}`;
  function stepCheck() {
    const rd = advanced() ? st.readiness : (check && check.readiness) || st.readiness;
    const problems = rd.problems.map((p) => el("li", { class: p.blocking ? "bad" : "" }, icon(p.blocking ? "i-close" : "i-info"), el("span", { text: p.text })));
    const out = [
      el(
        "section",
        { class: "mg-panel", "aria-labelledby": "calChkTitle" },
        el("h3", { id: "calChkTitle", text: "Contrôles" }),
        rd.ready.length ? el("p", { class: "ag-notify-now" }, icon("i-check"), `Proposées en ligne : ${rd.ready.map(label).join(", ")}.`) : null,
        problems.length ? el("ul", { class: "cal-problems" }, ...problems) : el("p", { text: "Rien à signaler." }),
      ),
    ];
    if (advanced()) {
      const conflicts = st.conflicts.map((c) => el("li", {}, el("b", { text: whenText(c) }), el("span", { text: c.reasons.join(" ") })));
      out.push(
        el(
          "section",
          { class: "mg-panel", "aria-labelledby": "calConfTitle" },
          el("h3", { id: "calConfTitle", text: `Conflits · ${st.conflicts.length}` }),
          conflicts.length
            ? el("ul", { class: "cal-conflicts" }, ...conflicts)
            : el("p", { class: "muted", text: "Aucun : chaque rendez-vous à venir a un mécanicien et un poste disponibles." }),
          conflicts.length ? el("p", { class: "help", text: "Rien n'a été déplacé. Réaffectez ou déplacez ces rendez-vous (calendrier, prochainement), ou annulez-les depuis Demandes : le client est prévenu." }) : null,
        ),
        el(
          "section",
          { class: "mg-panel", "aria-labelledby": "calModeTitle" },
          el("h3", { id: "calModeTitle", text: "Mode du calendrier" }),
          el("p", { class: "help", text: "Revenir au mode simple rattache chaque rendez-vous à venir à un créneau de votre semaine type. Vos mécaniciens, postes et réglages restent enregistrés." }),
          el("div", { class: "rv-acts" }, el("button", { type: "button", class: "btn", id: "calRecompute", onclick: (ev) => activate(ev.currentTarget) }, "Recalculer les affectations"), el("button", { type: "button", class: "btn danger", id: "calToSimple", onclick: (ev) => toSimple(ev.currentTarget) }, "Revenir au mode simple")),
          el("div", { id: "calSimpleFail" }),
        ),
      );
      return out;
    }
    // avant l'activation : les rendez-vous déjà pris trouvent-ils leur place ?
    const placed = check ? check.placed : [];
    const failed = check ? check.failed : [];
    const options = (list, chosen, none) => [el("option", { value: "", text: none }), ...list.map((x) => el("option", { value: x.id, text: x.name, selected: x.id === chosen }))];
    out.push(
      el(
        "section",
        { class: "mg-panel", "aria-labelledby": "calPlaceTitle" },
        el("h3", { id: "calPlaceTitle", text: "Rendez-vous déjà pris" }),
        !check
          ? el("p", { class: "muted", text: "Vérification impossible pour l'instant." })
          : !placed.length && !failed.length
            ? el("p", { class: "muted", text: "Aucun rendez-vous à venir : rien à placer." })
            : el("p", { text: `${plural(placed.length, "rendez-vous trouve sa place", "rendez-vous trouvent leur place")}${failed.length ? `, ${plural(failed.length, "ne la trouve pas", "ne la trouvent pas")}` : ""}. Aucun horaire ne change.` }),
        placed.length ? el("ul", { class: "cal-mini" }, ...placed.map((p) => el("li", { text: `${whenText(p)} → ${[...p.staff, ...p.posts].join(", ")}` }))) : null,
        ...failed.map((f) =>
          el(
            "div",
            { class: "cal-fail", "data-id": f.id },
            el("p", {}, el("b", { text: whenText(f) })),
            el("p", { class: "help", text: f.reasons.join(" ") }),
            el(
              "div",
              { class: "row2" },
              field(`calPS-${f.id}`, "Mécanicien", el("select", { id: `calPS-${f.id}` }, ...options(st.staff.filter((m) => m.active), (placements[f.id] || {}).staff?.[0], "Choisir…"))),
              field(`calPR-${f.id}`, "Poste", el("select", { id: `calPR-${f.id}` }, ...options(st.resources.filter((r) => r.active), (placements[f.id] || {}).station, "Sans poste / au choix"))),
            ),
            el("button", { type: "button", class: "btn small", onclick: (ev) => place(f, ev.currentTarget) }, "Placer ici"),
          ),
        ),
        failed.length ? el("p", { class: "help", text: "Vous pouvez aussi annuler un rendez-vous depuis Demandes (le client est prévenu), ou corriger une fiche aux étapes précédentes." }) : null,
      ),
    );
    out.push(
      el(
        "div",
        { class: "cal-activate" },
        el("button", { type: "button", class: "btn primary", id: "calActivate", disabled: !rd.ok || failed.length > 0, onclick: (ev) => activate(ev.currentTarget) }, "Activer le mode avancé"),
        el("p", { class: "help", text: !rd.ok ? "Corrigez d'abord les points bloquants ci-dessus." : failed.length ? "Placez d'abord les rendez-vous qui n'ont pas trouvé de place." : "Dès l'activation, les horaires proposés en ligne viennent de vos ressources ; votre semaine type reste enregistrée." }),
      ),
    );
    return out;
  }
  async function place(f, button) {
    const staff = $(`calPS-${f.id}`).value, station = $(`calPR-${f.id}`).value;
    placements[f.id] = { staff: staff ? [staff] : [], station: station || null };
    await busy(button, async () => {
      await runCheck();
      render();
      const still = check && check.failed.find((x) => x.id === f.id);
      live(still ? `Toujours impossible : ${still.reasons[0] || ""}` : "Placé.");
      $("calStepTitle").focus();
    });
  }
  async function activate(button) {
    await busy(button, async () => {
      try {
        st = await api.calActivate(garageId, { placements: Object.entries(placements).map(([requestId, p]) => ({ requestId, ...p })) });
        placements = {};
        check = null;
        render();
        alertBox(advanced() && st.placed !== undefined ? `Mode avancé actif. ${plural(st.placed, "rendez-vous à venir affecté", "rendez-vous à venir affectés")}.` : "Mode avancé actif.", "info");
        $("calStepTitle").focus();
      } catch (e) {
        if (e.status === 409 && e.details && e.details.failed) {
          check = { readiness: st.readiness, placed: [], failed: e.details.failed };
          render();
          return alertBox(e.message);
        }
        fail(e);
      }
    });
  }
  async function toSimple(button) {
    if (button.dataset.armed !== "1") {
      button.dataset.armed = "1";
      button.textContent = "Confirmer le retour au mode simple";
      return;
    }
    await busy(button, async () => {
      try {
        st = await api.calSimple(garageId);
        onMode(st.mode);
        await goPanel("agenda");
        alertBox("Mode simple : les horaires proposés viennent de nouveau de votre semaine type.", "info");
      } catch (e) {
        if (e.status === 409 && e.details && e.details.failed) {
          $("calSimpleFail").replaceChildren(el("p", { class: "warn", text: e.message }), el("ul", { class: "cal-conflicts" }, ...e.details.failed.map((f) => el("li", {}, el("b", { text: whenText(f) }), el("span", { text: f.reasons.join(" ") })))));
          button.dataset.armed = "";
          button.textContent = "Revenir au mode simple";
          return;
        }
        fail(e);
      }
    });
  }

  return { open, reset: () => (st = null) };
}
