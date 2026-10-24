// Espace Pro, rendez-vous en ligne (docs/rendez-vous.md, lot 2 ; maquettes « Espace Pro » 2 et 3, « Rendez-vous » 5 et 6) :
//  - « Demandes » : à traiter (accepter, refuser avec un motif, appeler), à venir (annuler avec un motif, exporter vers un agenda), passées ;
//  - « Disponibilités » : interrupteur, semaine type (grille sur ordinateur, liste par jour sur téléphone) et volet d'un créneau avec son
//    aperçu, fermetures et jours fériés, règles, adresse privée qui reçoit les demandes (vérifiée par un code).
// Que du TEXTE écrit dans la page.
import { DAYS, minutesText, phoneText } from "../shared/garage-profile.js";
import { PRO_SERVICES } from "../shared/pro-prices.js";
import { DECLINE_REASONS, GARAGE_CANCEL_REASONS, MAX_CAPACITY, addDays, dayLabel, hm, icsCalendar, minOf, nextHolidays, parisParts, timeLabel, weekday } from "../shared/rdv.js";

const SERVICE = new Map(PRO_SERVICES.map((s) => [s.id, s]));
const LETTERS = { mo: "L", tu: "M", we: "M", th: "J", fr: "V", sa: "S", su: "D" };
const STATUS = { pending: "À traiter", confirmed: "Confirmé", declined: "Refusée", expired: "Sans réponse", cancelled: "Annulée" };
const BY = { client: "par le client", garage: "par vous", closure: "fermeture" };
const QUARTERS = Array.from({ length: 97 }, (_, i) => i * 15);
const TONES = 4; // couleurs des créneaux (CSS .tone-0 … .tone-3)
const msOf = (iso) => new Date(iso).getTime();
const shortInstant = (iso) => {
  const p = parisParts(msOf(iso));
  return `${dayLabel(p.iso, { short: true })}, ${timeLabel(p.min)}`;
};
const longDay = (iso) => dayLabel(iso);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n, one, many = one + "s") => `${n} ${n > 1 ? many : one}`;
const svcText = (list) => list.map((s) => s.label).join(" + ");
// mode avancé : qui fait l'intervention, sur quel poste (« proposé » quand l'affectation est à confirmer)
const planText = (p) => (p ? [p.staff.length ? `${p.proposed ? "Proposé" : "Affecté"} : ${p.staff.join(", ")}` : "", p.posts.join(", ")].filter(Boolean).join(" · ") : "");

export function createRdvViews({ api, $, el, icon, alertBox, busy, apiProblem, goPanel, onTodo }) {
  let garageId = null;
  let agenda = null; // réponse de GET …/rdv
  let view = "todo";
  let rows = []; // demandes affichées
  let editing = null; // créneau en cours de modification (null : nouveau)
  let closing = null; // fermeture en cours de modification
  let deciding = null; // { request, act } pour la fenêtre du motif
  let armed = false; // « Supprimer le créneau » : second clic pour confirmer
  const say = (id, text) => ($(id).textContent = text);
  const fail = (e) => {
    if (!apiProblem(e)) alertBox(e.message);
  };

  // ================================================================= Demandes
  async function openRequests(id, { focus = true } = {}) {
    garageId = id;
    alertBox("");
    if (!agenda || agenda.garageId !== id) await loadAgenda(id);
    renderState();
    await showView(view, { focus: false });
    if (focus) $("rqTitle").focus();
  }
  async function showView(v, { focus = false } = {}) {
    view = v;
    for (const t of document.querySelectorAll(".rv-tabs [role=tab]")) {
      const on = t.dataset.view === v;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    }
    $("rqList").setAttribute("aria-labelledby", `rqTab-${v}`);
    const out = await api.requests(garageId, v);
    rows = out.requests;
    setTodo(out.todo);
    renderRequests();
  }
  function setTodo(n) {
    const c = $("rqTodoCount");
    c.hidden = !n;
    c.textContent = n ? String(n) : "";
    c.setAttribute("aria-label", `${n} à traiter`);
    if (agenda) agenda.todo = n;
    onTodo(n);
  }

  function renderRequests() {
    const list = $("rqList");
    $("rqTools").hidden = view !== "upcoming" || !rows.length;
    if (!rows.length) {
      list.replaceChildren(
        el("p", {
          class: "empty",
          text:
            view === "todo"
              ? "Aucune demande à traiter. Les nouvelles demandes arrivent aussi par e-mail, avec deux boutons : Accepter et Refuser."
              : view === "upcoming"
                ? "Aucun rendez-vous à venir."
                : "Rien pour l'instant. Les demandes passées restent ici 30 jours après le rendez-vous (7 jours après un refus ou une annulation).",
        }),
      );
      return;
    }
    if (view === "todo") list.replaceChildren(...rows.map(card));
    else list.replaceChildren(table());
  }

  // une demande à traiter (maquette « Rendez-vous 5 »)
  function card(r) {
    const p = r.when;
    const d = new Date(p.day + "T12:00:00Z");
    const fmt = (o) => d.toLocaleDateString("fr-FR", { timeZone: "UTC", ...o });
    const c = r.client;
    const slot = r.slot ? `Créneau « ${r.slot.name} »${r.slot.capacity > 1 ? ` · encore ${plural(r.slot.left, "place")} sur ${r.slot.capacity} à cette heure` : ""}` : planText(r.plan);
    return el(
      "article",
      { class: "rq-card", "data-id": r.id, "aria-labelledby": `rq-${r.id}` },
      el("div", { class: "rq-date", "aria-hidden": "true" }, el("span", { text: fmt({ weekday: "short" }).replace(".", "").toUpperCase() }), el("b", { text: String(d.getUTCDate()) }), el("span", { text: fmt({ month: "short" }).replace(".", "").toUpperCase() }), el("strong", { text: timeLabel(minOf(p.start)) })),
      el(
        "div",
        { class: "rq-main" },
        el("div", { class: "rq-head" }, el("h2", { id: `rq-${r.id}`, text: `${svcText(r.services)}, ${p.label}` }), el("span", { class: "rq-limit" }, icon("i-clock"), `À traiter avant ${shortInstant(r.deadline)}`)),
        p.mode === "drop" ? el("p", { class: "rq-slot", text: `Voiture déposée entre ${timeLabel(minOf(p.start))} et ${timeLabel(minOf(p.until))}, rendue vers ${timeLabel(minOf(p.end))}` }) : p.back ? el("p", { class: "rq-slot", text: `Voiture rendue vers ${timeLabel(minOf(p.back))}` }) : null,
        slot ? el("p", { class: "rq-slot", text: slot }) : null,
        el(
          "ul",
          { class: "rq-facts" },
          el("li", {}, icon("i-user"), el("span", {}, el("b", { text: c.name }), " · ", el("a", { href: `tel:${c.phone}`, text: c.phoneText || c.phone }), " · ", el("span", { text: c.email }))),
          el("li", {}, icon("i-car"), el("span", { text: [c.car, c.year, c.plate].filter(Boolean).join(" · ") })),
          el("li", {}, icon("i-mail"), el("span", { class: r.message ? "" : "muted", text: r.message || "Pas de message" })),
        ),
        el(
          "div",
          { class: "rq-acts" },
          el("button", { type: "button", class: "btn primary small", onclick: (ev) => accept(r, ev.currentTarget) }, icon("i-check"), "Accepter"),
          el("button", { type: "button", class: "btn small", onclick: () => openWhy(r, "decline") }, "Refuser"),
          el("a", { class: "rq-call", href: `tel:${c.phone}` }, icon("i-phone"), "Appeler le client"),
        ),
      ),
    );
  }

  // à venir et passées : un tableau, avec le détail d'une ligne sur demande
  function table() {
    const tbody = el("tbody");
    for (const r of rows) {
      const c = r.client;
      const st = r.status === "confirmed" && view === "past" ? "Passé" : r.status === "cancelled" ? `Annulée${r.cancelledBy ? " " + BY[r.cancelledBy] : ""}` : STATUS[r.status];
      const tone = r.status === "confirmed" ? "ok" : r.status === "pending" ? "due" : "off";
      const details = el(
        "tr",
        { class: "rq-more", hidden: true },
        el(
          "td",
          { colspan: "5" },
          el(
            "div",
            { class: "rq-detail" },
            el("p", {}, el("b", { text: "Client : " }), `${c.name} · `, el("a", { href: `tel:${c.phone}`, text: c.phoneText || c.phone }), ` · ${c.email}`),
            el("p", {}, el("b", { text: "Voiture : " }), [c.car, c.year, c.plate].filter(Boolean).join(" · ")),
            el("p", {}, el("b", { text: "Message : " }), r.message || "aucun"),
            r.reasonText ? el("p", {}, el("b", { text: "Motif : " }), r.reasonText + (r.note ? ` — « ${r.note} »` : "")) : null,
            view === "upcoming" && r.status === "confirmed" ? el("button", { type: "button", class: "link-btn danger", onclick: () => openWhy(r, "cancel") }, "Annuler ce rendez-vous") : null,
          ),
        ),
      );
      const toggle = el("button", { type: "button", class: "link-btn", "aria-expanded": "false", text: "Détails" });
      toggle.addEventListener("click", () => {
        details.hidden = !details.hidden;
        toggle.setAttribute("aria-expanded", String(!details.hidden));
      });
      const d = r.when;
      tbody.append(
        el(
          "tr",
          { "data-id": r.id },
          el("th", { scope: "row" }, el("b", { text: dayLabel(d.day, { short: true }) }), el("small", { text: d.mode === "drop" ? `dépôt ${timeLabel(minOf(d.start))}–${timeLabel(minOf(d.until))}` : timeLabel(minOf(d.start)) })),
          el("td", {}, svcText(r.services)),
          el("td", {}, el("span", { text: c.name }), el("small", { text: [c.car, c.year].filter(Boolean).join(" · ") })),
          el("td", {}, el("span", { class: `pill ${tone}`, text: st })),
          el("td", { class: "rq-tog" }, toggle),
        ),
        details,
      );
    }
    return el(
      "table",
      { class: "rq-table" },
      el("caption", { class: "sr-only", text: view === "upcoming" ? "Rendez-vous à venir" : "Demandes passées" }),
      el("thead", {}, el("tr", {}, ...["Quand", "Prestation", "Client", "État"].map((h) => el("th", { scope: "col", text: h })), el("th", { scope: "col" }, el("span", { class: "sr-only", text: "Détails" })))),
      tbody,
    );
  }

  async function accept(r, button) {
    alertBox("");
    await busy(button, async () => {
      try {
        await api.decide(garageId, r.id, "accept");
        say("rqLive", "Rendez-vous confirmé : le client reçoit la confirmation par e-mail.");
        alertBox(`Rendez-vous du ${r.when.label} confirmé. ${r.client.name} reçoit la confirmation par e-mail.`, "info");
        await showView(view);
      } catch (e) {
        if (e.status === 409) {
          alertBox(e.message);
          return showView(view);
        }
        fail(e);
      }
    });
  }

  // ---- motif d'un refus ou d'une annulation
  // onDone : appelé après la décision (ou son refus par l'API) au lieu de recharger la liste (tableau de bord, lot 3c)
  function openWhy(r, act, onDone = null) {
    deciding = { r, act, onDone };
    const list = act === "decline" ? DECLINE_REASONS : GARAGE_CANCEL_REASONS;
    $("whyDlgKind").textContent = act === "decline" ? "Refuser la demande" : "Annuler le rendez-vous";
    $("whyDlgTitle").textContent = `${svcText(r.services)}, ${r.when.label}`;
    $("whyReasons").replaceChildren(
      el("legend", { text: "Motif (transmis au client)" }),
      ...list.map(([code, label]) => el("label", { class: "choice-line" }, el("input", { type: "radio", name: "whyReason", value: code }), el("span", { text: label }))),
    );
    $("whyNote").value = "";
    $("whySave").textContent = act === "decline" ? "Refuser la demande" : "Annuler le rendez-vous";
    $("whyErr").hidden = true;
    $("whyDlg").showModal();
  }
  async function submitWhy(ev) {
    ev.preventDefault();
    const picked = document.querySelector('input[name="whyReason"]:checked');
    if (!picked) {
      $("whyErr").textContent = "Choisissez un motif : il est transmis au client.";
      $("whyErr").hidden = false;
      return;
    }
    const { r, act, onDone } = deciding;
    const after = () => (onDone ? onDone() : showView(view));
    await busy($("whySave"), async () => {
      try {
        await api.decide(garageId, r.id, act, { reason: picked.value, note: $("whyNote").value.trim() });
        $("whyDlg").close();
        alertBox(act === "decline" ? `Demande refusée. ${r.client.name} est prévenu(e) par e-mail, avec votre motif.` : `Rendez-vous annulé. ${r.client.name} est prévenu(e) par e-mail, avec votre motif.`, "info");
        await after();
      } catch (e) {
        if (e.status === 422) {
          $("whyErr").textContent = e.message;
          $("whyErr").hidden = false;
          return;
        }
        $("whyDlg").close();
        if (e.status === 409) {
          alertBox(e.message);
          return after();
        }
        fail(e);
      }
    });
  }

  // ---- export des rendez-vous à venir (fichier .ics)
  function exportIcs() {
    const events = rows
      .filter((r) => r.status === "confirmed")
      .map((r) => ({
        uid: `${r.id}@pixcar.fr`,
        start: msOf(r.when.startsAt),
        end: msOf(r.when.endsAt),
        summary: `${svcText(r.services)} · ${r.client.name}`,
        description: [`${r.client.phoneText || r.client.phone} · ${r.client.email}`, [r.client.car, r.client.year, r.client.plate].filter(Boolean).join(" · "), r.message].filter(Boolean).join("\n"),
      }));
    const url = URL.createObjectURL(new Blob([icsCalendar(events)], { type: "text/calendar" }));
    const a = el("a", { href: url, download: "rendez-vous-pixcar.ics" });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  // ================================================================= Disponibilités
  async function loadAgenda(id) {
    garageId = id;
    agenda = { ...(await api.agenda(id)), garageId: id };
    onTodo(agenda.todo);
  }
  async function openAgenda(id, { focus = true } = {}) {
    alertBox("");
    await loadAgenda(id);
    renderAgenda();
    if (focus) $("agTitle").focus();
  }
  const put = (out) => {
    agenda = { ...out, garageId };
    renderAgenda();
  };

  // état des rendez-vous (interrupteur, et rappel en tête de « Demandes »)
  const stateText = () => (agenda.open ? "Activés" : agenda.enabled && agenda.paused ? "En pause" : agenda.enabled ? "Incomplets" : "Fermés");
  function renderState() {
    const b = $("rqState");
    b.replaceChildren(el("span", { class: `dot ${agenda.open ? "ok" : "off"}` }), `Rendez-vous en ligne : ${stateText().toLowerCase()}`);
  }

  function renderAgenda() {
    const a = agenda;
    renderMode();
    const tgl = $("agEnabled");
    tgl.setAttribute("aria-checked", String(a.open));
    say("agStateText", stateText());
    $("agStateText").className = a.open ? "on" : "";
    renderState();
    renderMissing();
    renderWeek();
    renderClosures();
    for (const s of document.querySelectorAll("#dash-agenda [data-setting]")) s.value = String(a.settings[s.dataset.setting]);
    renderNotify();
  }

  // simple (semaine type en créneaux) ou avancé (ressources de l'atelier, calendar.js) ; la semaine type reste enregistrée
  function renderMode() {
    const c = agenda.calendar || { mode: "simple", started: false };
    const adv = c.mode === "advanced";
    $("agWeekBox").hidden = adv;
    say("agModeText", adv ? "Avancé : les horaires proposés viennent de vos mécaniciens, de vos postes et du temps de chaque prestation." : "Simple : votre semaine type en créneaux, chacun avec un nombre de voitures.");
    say("agModeHelp", adv ? "Votre semaine type reste enregistrée : elle reprend si vous revenez au mode simple (Mon atelier › Contrôles)." : "Le mode avancé tient compte de vos mécaniciens, de leurs absences et compétences, de vos ponts et postes. Un assistant vous guide ; rien ne change pour vos clients avant l'activation.");
    $("agModeGo").textContent = adv ? "Gérer l'atelier" : c.started ? "Reprendre la configuration" : "Passer au mode avancé";
    $("agModeGo").className = adv ? "btn small" : "btn primary small";
    const lead = document.querySelector("#dash-agenda .rv-top .lead");
    lead.textContent = adv ? "Quand votre atelier peut prendre une voiture : Pixcar calcule les horaires avec vos ressources (Mon atelier)." : "Quand vous pouvez prendre une voiture, et pour quelles prestations. Pixcar ne propose aux automobilistes que des horaires pris dans ces créneaux.";
  }

  function renderMissing() {
    const a = agenda;
    const box = $("agMissing");
    const items = [];
    if (a.paused) items.push(el("li", {}, el("b", { text: "En pause : " }), "3 demandes de suite sont restées sans réponse avant leur heure limite. Réactivez les rendez-vous avec l'interrupteur quand vous pouvez répondre."));
    const todo = {
      hours: ["Renseignez vos horaires d'ouverture", "Mon garage", () => goPanel("garage")],
      notify: ["Indiquez l'adresse qui recevra les demandes", "Plus bas", () => $("agNotifyEmail").focus()],
      slots: ["Ajoutez un créneau à votre semaine type", "Ajouter un créneau", () => openSlot(null)],
    };
    for (const k of a.missing) {
      const [text, label, go] = todo[k];
      items.push(el("li", {}, el("span", { text: text + " " }), el("button", { type: "button", class: "link-btn", onclick: go, text: label === "Plus bas" ? "Aller à l'adresse" : label })));
    }
    if (!a.garage.phone) items.push(el("li", { class: "soft" }, "Votre téléphone n'apparaît pas dans les e-mails aux clients : demandez-le dans ", el("button", { type: "button", class: "link-btn", onclick: () => goPanel("garage"), text: "Mon garage" }), "."));
    box.hidden = !items.length;
    box.replaceChildren(...(a.missing.length ? [el("p", { text: "Pour ouvrir les rendez-vous en ligne :" })] : []), el("ul", {}, ...items));
  }

  // ---- semaine type
  const openDays = () => DAYS.map((d) => d[0]).filter((k) => a().hours && (a().hours[k] || []).length);
  const a = () => agenda;
  const rangesOf = (k) => ((agenda.hours && agenda.hours[k]) || []).map(([x, y]) => [minOf(x), minOf(y)]);
  function span() {
    let lo = Infinity, hi = -Infinity;
    for (const [k] of DAYS) for (const [x, y] of rangesOf(k)) (lo = Math.min(lo, x)), (hi = Math.max(hi, y));
    for (const s of agenda.slots) (lo = Math.min(lo, minOf(s.start))), (hi = Math.max(hi, minOf(s.end)));
    if (!Number.isFinite(lo)) [lo, hi] = [8 * 60, 18 * 60];
    return [Math.floor(lo / 60) * 60, Math.ceil(hi / 60) * 60];
  }
  const tone = (i) => `tone-${i % TONES}`;
  const slotSummary = (s) => `${s.mode === "drop" ? "dépôt, " : ""}${plural(s.capacity, "voiture")}`;

  function renderWeek() {
    const slots = agenda.slots;
    $("agLegend").replaceChildren(...slots.map((s, i) => el("li", {}, el("span", { class: `sw ${tone(i)}`, "aria-hidden": "true" }), `${s.name} · ${slotSummary(s)}`)));
    const [lo, hi] = span();
    const total = hi - lo;
    const pct = (m) => `${((m - lo) / total) * 100}%`;
    // grille (ordinateur) : une colonne par jour, heures d'ouverture en blanc, créneaux par-dessus (côte à côte s'ils se chevauchent)
    const ruler = el("div", { class: "ag-ruler", "aria-hidden": "true" });
    for (let m = lo; m <= hi; m += 60) {
      const t = el("span", { text: hm(m) });
      t.style.top = pct(m);
      ruler.append(t);
    }
    const cols = DAYS.map(([k, long, short]) => {
      const ranges = rangesOf(k);
      const mine = slots.map((s, i) => ({ s, i })).filter(({ s }) => s.days.includes(k));
      const body = el("div", { class: "ag-col-body" });
      for (const [x, y] of ranges) {
        const o = el("div", { class: "ag-open" });
        o.style.top = pct(x);
        o.style.height = `${((y - x) / total) * 100}%`;
        body.append(o);
      }
      // couloirs : un créneau qui chevauche un précédent passe à côté
      const lanes = [];
      for (const it of mine) {
        const st = minOf(it.s.start);
        let lane = lanes.findIndex((end) => end <= st);
        if (lane < 0) lane = lanes.length;
        lanes[lane] = minOf(it.s.end);
        it.lane = lane;
      }
      for (const it of mine) {
        const b = el(
          "button",
          { type: "button", class: `ag-slot ${tone(it.i)}${it.s.mode === "drop" ? " drop" : ""}`, "aria-label": `${it.s.name}, ${long.toLowerCase()} de ${timeLabel(minOf(it.s.start))} à ${timeLabel(minOf(it.s.end))}, ${slotSummary(it.s)} : modifier`, onclick: () => openSlot(it.s) },
          el("b", { text: it.s.name }),
          el("span", { text: `${timeLabel(minOf(it.s.start))}–${timeLabel(minOf(it.s.end))}` }),
          el("span", { text: plural(it.s.services.length, "prestation") }),
          el("span", { class: "cap" }, icon("i-car"), String(it.s.capacity)),
        );
        b.style.top = pct(minOf(it.s.start));
        b.style.height = `${((minOf(it.s.end) - minOf(it.s.start)) / total) * 100}%`;
        b.style.left = `${(it.lane / lanes.length) * 100}%`;
        b.style.width = `${100 / lanes.length}%`;
        body.append(b);
      }
      return el("div", { class: `ag-col${ranges.length ? "" : " closed"}` }, el("div", { class: "ag-col-head" }, el("b", { text: short.replace(".", "") }), el("small", { text: ranges.length ? plural(mine.length, "créneau", "créneaux") : "Fermé" })), body);
    });
    $("agWeek").replaceChildren(ruler, ...cols);
    // liste par jour (téléphone)
    $("agDays").replaceChildren(
      ...DAYS.map(([k, long]) => {
        const mine = slots.map((s, i) => ({ s, i })).filter(({ s }) => s.days.includes(k));
        const ranges = rangesOf(k);
        return el(
          "li",
          {},
          el("b", { class: "ag-dname", text: long }),
          !ranges.length
            ? el("span", { class: "muted", text: "Fermé" })
            : mine.length
              ? el("div", { class: "ag-dslots" }, ...mine.map(({ s, i }) => el("button", { type: "button", class: `ag-chip ${tone(i)}`, onclick: () => openSlot(s) }, el("b", { text: s.name }), el("span", { text: `${timeLabel(minOf(s.start))}–${timeLabel(minOf(s.end))} · ${slotSummary(s)}` }))))
              : el("span", { class: "muted", text: "Aucun créneau" }),
        );
      }),
    );
  }

  // ---- volet d'un créneau (maquette « Espace Pro 3 »)
  function openSlot(s) {
    editing = s;
    armed = false;
    $("slotDlgTitle").textContent = s ? "Modifier le créneau" : "Nouveau créneau";
    $("slotName").value = s ? s.name : "";
    const open = openDays();
    $("slotDays").replaceChildren(
      el("legend", { text: "Jours" }),
      ...DAYS.map(([k, long]) =>
        el(
          "label",
          { class: "ag-dayck", title: long },
          el("input", { type: "checkbox", value: k, checked: s ? s.days.includes(k) : open.includes(k) && !["sa", "su"].includes(k), disabled: !open.includes(k), "aria-label": long }),
          el("span", { "aria-hidden": "true", text: LETTERS[k] }),
        ),
      ),
    );
    const closed = DAYS.filter(([k]) => !open.includes(k)).map(([, long]) => long.toLowerCase());
    $("slotDaysHelp").textContent = closed.length ? `${cap(closed.join(", "))} : le garage est fermé (Mon garage › Horaires).` : "";
    const [lo, hi] = span();
    const opts = QUARTERS.filter((m) => m >= lo && m <= hi).map((m) => hm(m));
    for (const [id, value] of [["slotStart", s ? s.start : hm(lo)], ["slotEnd", s ? s.end : hm(Math.min(hi, lo + 4 * 60))]])
      $(id).replaceChildren(...opts.map((t) => el("option", { value: t, text: timeLabel(minOf(t)), selected: t === value })));
    for (const r of document.querySelectorAll('input[name="slotMode"]')) r.checked = r.value === (s ? s.mode : "hour");
    $("slotCap").value = String(s ? s.capacity : 1);
    $("slotDelete").hidden = !s;
    $("slotDelete").textContent = "Supprimer le créneau";
    $("slotErr").hidden = true;
    renderSlotServices(s ? s.services : null);
    updateSlot();
    $("slotDlg").showModal();
  }
  // prestations : faites avec un temps moyen (cochables), ou grisées avec la raison
  function renderSlotServices(chosen) {
    const minutes = new Map(agenda.services.map((x) => [x.id, x.minutes]));
    const box = $("slotSvcs");
    const items = PRO_SERVICES.filter((x) => minutes.has(x.id)).map((x) =>
      el(
        "label",
        { class: "ag-svc", "data-id": x.id },
        el("input", { type: "checkbox", value: x.id, checked: chosen ? chosen.includes(x.id) : true }),
        el("span", {}, el("span", { class: "n", text: x.label }), el("small", { class: "why" })),
        el("span", { class: "t", text: minutesText(minutes.get(x.id)) + (x.unit ? ` ${x.unit}` : "") }),
      ),
    );
    box.replaceChildren(el("legend", { id: "slotSvcsTitle", text: "Prestations acceptées" }), ...items, ...(items.length ? [] : [el("p", { class: "help", text: "Aucune prestation n'a encore de temps moyen : renseignez-les dans Mon garage › Prestations effectuées." })]));
  }
  function slotDraft() {
    return {
      name: $("slotName").value.trim(),
      days: [...document.querySelectorAll("#slotDays input:checked")].map((x) => x.value),
      start: $("slotStart").value,
      end: $("slotEnd").value,
      mode: (document.querySelector('input[name="slotMode"]:checked') || { value: "hour" }).value,
      capacity: Math.max(1, Math.min(MAX_CAPACITY, Number($("slotCap").value) || 1)),
      services: [...document.querySelectorAll("#slotSvcs input:checked:not(:disabled)")].map((x) => x.value),
    };
  }
  // longueur du créneau → prestations trop longues grisées ; titre « 7 sur 12 » ; aperçu
  function updateSlot() {
    const d = slotDraft();
    const len = minOf(d.end) - minOf(d.start);
    const minutes = new Map(agenda.services.map((x) => [x.id, x.minutes]));
    let n = 0, on = 0;
    for (const row of document.querySelectorAll("#slotSvcs .ag-svc")) {
      const m = minutes.get(row.dataset.id);
      const box = row.querySelector("input");
      const tooLong = len > 0 && m > len;
      box.disabled = tooLong;
      row.classList.toggle("off", tooLong);
      row.querySelector(".why").textContent = tooLong ? `Plus longue que le créneau (${minutesText(len)})` : "";
      n++;
      if (box.checked && !tooLong) on++;
    }
    $("slotSvcsTitle").textContent = `Prestations acceptées · ${on} sur ${n}`;
    $("slotDropHelp").textContent = `Arrivée entre ${timeLabel(minOf(d.start))} et ${timeLabel(Math.min(minOf(d.start) + 60, minOf(d.end)))}, voiture rendue à ${timeLabel(minOf(d.end))}.`;
    renderPreview(d);
  }
  // Aperçu : les horaires que verrait un automobiliste pour la première prestation cochée, au prochain jour du créneau (sans compter les
  // demandes déjà prises ni l'heure limite de réponse)
  function renderPreview(d) {
    const box = $("slotPreview");
    const first = d.services[0];
    const minutes = new Map(agenda.services.map((x) => [x.id, x.minutes]));
    const start = minOf(d.start), end = minOf(d.end);
    if (!first || !d.days.length || end <= start) {
      box.replaceChildren(el("p", { class: "help", text: "L'aperçu apparaît quand le créneau a un jour, des horaires et une prestation." }));
      return;
    }
    let day = addDays(agenda.today || parisParts(Date.now()).iso, 1);
    for (let i = 0; i < 7 && !d.days.includes(weekday(day)); i++) day = addDays(day, 1);
    const need = minutes.get(first);
    const ranges = rangesOf(weekday(day));
    const label = `${SERVICE.get(first).label.toLowerCase()} (${minutesText(need)}) le ${longDay(day)}`;
    let times = [];
    if (d.mode === "drop") times = need <= end - start ? [start] : [];
    else for (let t = start; t + need <= end; t += agenda.settings.stepMin) if (ranges.some(([x, y]) => t >= x && t + need <= y)) times.push(t);
    box.replaceChildren(
      el("p", {}, el("b", { text: "Aperçu" }), ` · ${label} :`),
      times.length ? el("ul", { class: "ag-times-prev" }, ...times.map((t) => el("li", { text: d.mode === "drop" ? `${timeLabel(t)}–${timeLabel(Math.min(t + 60, end))}` : timeLabel(t) }))) : el("p", { class: "help", text: "Aucun horaire : la prestation ne tient pas dans le créneau (pause de midi comprise)." }),
      times.length
        ? el("p", {
            class: "help",
            text:
              d.mode === "drop"
                ? `${plural(d.capacity, "voiture déposée", "voitures déposées")} au plus ce jour-là.`
                : `${plural(times.length, "horaire")}, ${plural(d.capacity, "voiture")} à la fois. Un horaire disparaît quand il est pris${d.capacity > 1 ? ` ${d.capacity} fois` : ""}.`,
          })
        : null,
    );
  }
  async function saveSlot(ev) {
    ev.preventDefault();
    const d = slotDraft();
    const err = (m) => {
      $("slotErr").textContent = m;
      $("slotErr").hidden = !m;
    };
    if (!d.days.length) return err("Choisissez au moins un jour.");
    if (minOf(d.end) - minOf(d.start) < 30) return err("Le créneau dure 30 minutes au moins.");
    if (!d.services.length) return err("Cochez au moins une prestation.");
    await busy($("slotSave"), async () => {
      try {
        put(await api.saveSlot(garageId, editing && editing.id, d));
        $("slotDlg").close();
        alertBox(editing ? "Créneau modifié." : "Créneau ajouté à votre semaine type.", "info");
      } catch (e) {
        if (e.status === 422 || e.status === 409) return err(e.message);
        $("slotDlg").close();
        fail(e);
      }
    });
  }
  async function deleteSlot() {
    if (!armed) {
      armed = true;
      $("slotDelete").textContent = "Confirmer la suppression";
      return;
    }
    await busy($("slotDelete"), async () => {
      try {
        put(await api.deleteSlot(garageId, editing.id));
        $("slotDlg").close();
        alertBox("Créneau supprimé. Les rendez-vous déjà pris restent.", "info");
      } catch (e) {
        $("slotDlg").close();
        fail(e);
      }
    });
  }

  // ---- fermetures et jours fériés
  function renderClosures() {
    const list = agenda.closures;
    $("agClosures").replaceChildren(
      ...(list.length
        ? list.map((c) =>
            el(
              "li",
              {},
              icon("i-calendar"),
              el("span", {}, el("b", { text: c.first === c.last ? `Le ${longDay(c.first)}` : `Du ${longDay(c.first)} au ${longDay(c.last)}` }), el("small", { text: `${c.label ? c.label + " · " : ""}aucun rendez-vous proposé` })),
              el("button", { type: "button", class: "link-btn", onclick: () => openClosure(c), text: "Modifier" }),
            ),
          )
        : [el("li", { class: "muted", text: "Aucune fermeture prévue." })]),
    );
    const next = agenda.holidays[0];
    const on = agenda.settings.holidays;
    $("agHolidays").setAttribute("aria-checked", String(on));
    say("agHolText", `${on ? "Fermé automatiquement" : "Proposés comme les autres jours"}${next ? ` (prochain : ${longDay(next.day)}, ${next.name.toLowerCase()})` : ""}`);
  }
  function openClosure(c) {
    closing = c;
    $("closDlgTitle").textContent = c ? "Modifier la fermeture" : "Nouvelle fermeture";
    $("closFirst").value = c ? c.first : "";
    $("closLast").value = c ? c.last : "";
    $("closLabel").value = c ? c.label : "";
    $("closDeleteBox").hidden = !c;
    $("closErr").hidden = true;
    $("closDlg").showModal();
  }
  async function saveClosure(ev) {
    ev.preventDefault();
    const first = $("closFirst").value, last = $("closLast").value || first;
    const err = (m) => {
      $("closErr").textContent = m;
      $("closErr").hidden = !m;
    };
    if (!first) return err("Indiquez le premier jour.");
    await busy($("closSave"), async () => {
      try {
        const out = await api.saveClosure(garageId, closing && closing.id, { first, last, label: $("closLabel").value.trim() });
        put(out);
        $("closDlg").close();
        alertBox(out.cancelled ? `Fermeture enregistrée. ${plural(out.cancelled, "demande ou rendez-vous annulé", "demandes ou rendez-vous annulés")} sur la période : les clients sont prévenus par e-mail.` : "Fermeture enregistrée.", "info");
      } catch (e) {
        if (e.status === 422 || e.status === 409) return err(e.message);
        $("closDlg").close();
        fail(e);
      }
    });
  }
  async function deleteClosure() {
    await busy($("closDelete"), async () => {
      try {
        put(await api.deleteClosure(garageId, closing.id));
        $("closDlg").close();
        alertBox("Fermeture retirée.", "info");
      } catch (e) {
        $("closDlg").close();
        fail(e);
      }
    });
  }

  // ---- interrupteurs et règles (enregistrés tout de suite)
  async function setting(body, button) {
    alertBox("");
    const run = async () => {
      try {
        put(await api.rdvSettings(garageId, body));
        say("agLive", "Enregistré.");
      } catch (e) {
        if (e.status === 409) {
          alertBox(e.message);
          return renderAgenda();
        }
        fail(e);
        renderAgenda();
      }
    };
    return button ? busy(button, run) : run();
  }

  // ---- adresse qui reçoit les demandes
  function renderNotify() {
    const n = agenda.notify;
    const now = $("agNotifyNow");
    now.hidden = !n.email;
    now.replaceChildren(icon("i-check"), el("span", {}, "Les demandes arrivent à ", el("b", { text: n.email }), "."));
    $("agNotifySend").textContent = n.email ? "Changer d'adresse" : "Recevoir un code";
    const waiting = !!(n.pending && n.codeLive);
    $("agNotifyCodeForm").hidden = !waiting;
    if (waiting) say("agNotifyTo", n.pending);
    notifyErr(null, "");
  }
  const notifyErr = (input, m) => {
    $("agNotifyErr").textContent = m || "";
    $("agNotifyErr").hidden = !m;
    for (const x of [$("agNotifyEmail"), $("agNotifyCode")]) x.setAttribute("aria-invalid", m && x === input ? "true" : "false");
    if (m && input) input.focus();
  };
  async function sendNotify(ev) {
    ev.preventDefault();
    const input = $("agNotifyEmail");
    const email = input.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return notifyErr(input, "Adresse e-mail invalide.");
    await busy($("agNotifySend"), async () => {
      try {
        const out = await api.notify(garageId, email);
        agenda.notify = { ...agenda.notify, pending: out.pending, codeLive: true };
        renderNotify();
        notifyErr(null, "");
        $("agNotifyCode").value = "";
        $("agNotifyCode").focus();
        say("agLive", `Code envoyé à ${out.pending}.`);
      } catch (e) {
        if (e.status === 401) return apiProblem(e);
        notifyErr(input, e.message);
      }
    });
  }
  async function checkNotify(ev) {
    ev.preventDefault();
    const input = $("agNotifyCode");
    const code = input.value.replace(/\D/g, "");
    if (code.length !== 6) return notifyErr(input, "Le code compte 6 chiffres.");
    await busy($("agNotifyCheck"), async () => {
      try {
        put(await api.notifyCode(garageId, code));
        $("agNotifyEmail").value = "";
        alertBox(`Adresse vérifiée : les demandes arriveront à ${agenda.notify.email}.`, "info");
      } catch (e) {
        if (e.status === 401) return apiProblem(e);
        notifyErr(input, e.message);
      }
    });
  }

  // ---- branchements
  for (const t of document.querySelectorAll(".rv-tabs [role=tab]")) {
    t.addEventListener("click", () => showView(t.dataset.view).catch(fail));
    t.addEventListener("keydown", (e) => {
      const tabs = [...document.querySelectorAll(".rv-tabs [role=tab]")];
      const i = tabs.indexOf(t);
      const j = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i + tabs.length - 1) % tabs.length : -1;
      if (j < 0) return;
      e.preventDefault();
      showView(tabs[j].dataset.view, { focus: true }).catch(fail);
    });
  }
  $("rqExport").addEventListener("click", exportIcs);
  $("rqState").addEventListener("click", () => goPanel("agenda"));
  $("whyForm").addEventListener("submit", submitWhy);
  $("whyClose").addEventListener("click", () => $("whyDlg").close());
  $("agEnabled").addEventListener("click", (e) => setting({ enabled: !agenda.open }, e.currentTarget));
  $("agHolidays").addEventListener("click", (e) => setting({ holidays: !agenda.settings.holidays }, e.currentTarget));
  for (const s of document.querySelectorAll("#dash-agenda [data-setting]")) s.addEventListener("change", () => setting({ [s.dataset.setting]: Number(s.value) }));
  $("agAddSlot").addEventListener("click", () => openSlot(null));
  $("slotForm").addEventListener("submit", saveSlot);
  $("slotForm").addEventListener("change", updateSlot);
  $("slotForm").addEventListener("input", (e) => e.target.id === "slotCap" && updateSlot());
  $("slotClose").addEventListener("click", () => $("slotDlg").close());
  $("slotCancel").addEventListener("click", () => $("slotDlg").close());
  $("slotDelete").addEventListener("click", deleteSlot);
  const step = (n) => {
    $("slotCap").value = String(Math.max(1, Math.min(MAX_CAPACITY, (Number($("slotCap").value) || 1) + n)));
    updateSlot();
  };
  $("slotCapMinus").addEventListener("click", () => step(-1));
  $("slotCapPlus").addEventListener("click", () => step(1));
  $("agAddClosure").addEventListener("click", () => openClosure(null));
  $("agModeGo").addEventListener("click", () => goPanel("calendar"));
  $("closForm").addEventListener("submit", saveClosure);
  $("closClose").addEventListener("click", () => $("closDlg").close());
  $("closDelete").addEventListener("click", deleteClosure);
  $("agNotifyForm").addEventListener("submit", sendNotify);
  $("agNotifyCodeForm").addEventListener("submit", checkNotify);
  $("agNotifyCode").addEventListener("input", (e) => (e.target.value = e.target.value.replace(/[^\d\s]/g, "")));

  return {
    // refus d'une demande depuis le tableau de bord (lot 3c) : même fenêtre de motif, puis onDone
    decline(id, r, onDone) {
      garageId = id;
      openWhy(r, "decline", onDone);
    },
    openRequests,
    openAgenda,
    reset() {
      agenda = null;
      view = "todo";
    },
  };
}
