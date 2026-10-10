// Choix des prestations : la fenêtre « Quelles prestations souhaitez-vous réaliser ? » (src/partials/dialog.html, #svcDlg) que le bouton
// « Prestation » de la barre de recherche ouvre. On y cherche par mot (sans accents ni casse), on coche une ou plusieurs prestations (elles
// s'affichent en pastilles « Prestations sélectionnées », chacune retirable) puis on valide : « Valider ces 2 prestations ».
// Règles : le contrôle technique se cherche seul (autre liste de lieux, autres prix : le choisir retire les autres prestations, en choisir
// une autre le retire) ; les autres s'additionnent jusqu'à `max` ; rien n'est choisi tant qu'on n'a pas validé (Échap, ×, clic sur le fond :
// la sélection d'avant reste). Les fonctions pures sont testées sans navigateur (tests/unit/service-picker.test.mjs).
export const SVC_MAX = 5;

const strip = (s) =>
  String(s == null ? "" : s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Prestations dont le libellé, le groupe ou l'aide contient tous les mots de la saisie (sans accents ni casse) ; saisie vide : toutes
export function matchServices(services, query) {
  const words = strip(query).split(" ").filter(Boolean);
  if (!words.length) return services.slice();
  return services.filter((s) => {
    const hay = strip(`${s.label} ${s.g} ${s.hint || ""}`);
    return words.every((w) => hay.includes(w));
  });
}

// Sélection après un clic sur la prestation `id` : la retire si elle y est ; sinon l'ajoute (le contrôle technique remplace tout, et est remplacé
// par toute autre prestation ; à `max`, rien ne s'ajoute ; avec max = 1, la nouvelle remplace l'ancienne).
export function toggleService(services, selected, id, max = SVC_MAX) {
  const svc = services.find((s) => s.id === id);
  if (!svc) return selected.slice();
  if (selected.includes(id)) return selected.filter((x) => x !== id);
  if (svc.kind === "ct" || max === 1) return [id];
  const rest = selected.filter((x) => (services.find((s) => s.id === x) || {}).kind !== "ct");
  return rest.length >= max ? rest : [...rest, id];
}

// Peut-on encore cocher cette case ? (non si la sélection est pleine et que la prestation n'y est pas)
export const canPick = (services, selected, id, max = SVC_MAX) => selected.includes(id) || toggleService(services, selected, id, max).includes(id);

export const goLabel = (n) => (n < 1 ? "Choisissez une prestation" : n === 1 ? "Valider cette prestation" : `Valider ces ${n} prestations`);

// Branche la fenêtre. get() : identifiants choisis en ce moment ; apply(ids) : appelé à la validation (premier identifiant = principal).
// Renvoie { open, close, selected } (ou null si la fenêtre est absente de la page).
export function initServicePicker({ doc = document, services, get, apply, max = SVC_MAX }) {
  const dlg = doc.getElementById("svcDlg"),
    btn = doc.getElementById("svcBtn");
  if (!dlg || !btn || !services.length) return null;
  const q = (id) => doc.getElementById(id),
    form = q("svcForm"),
    search = q("svcSearch"),
    list = q("svcList"),
    chips = q("svcChips"),
    selBox = q("svcSel"),
    note = q("svcNote"),
    go = q("svcGo"),
    root = doc.documentElement;
  const label = (id) => (services.find((s) => s.id === id) || { label: id }).label;
  let sel = [];

  const groups = [];
  for (const s of services) {
    let g = groups.find((x) => x.name === s.g);
    if (!g) groups.push((g = { name: s.g, items: [] }));
    g.items.push(s);
  }
  list.innerHTML =
    groups
      .map(
        (g, i) =>
          `<div class="svc-grp" role="group" aria-labelledby="svcG${i}" data-grp="${i}"><h3 class="svc-g" id="svcG${i}">${esc(g.name)}</h3>${g.items
            .map(
              (s) =>
                `<label class="svc-opt" data-id="${esc(s.id)}"><input type="checkbox" value="${esc(s.id)}" /><span class="svc-t">${esc(s.label)}</span>${s.hint ? `<span class="svc-h">${esc(s.hint)}</span>` : ""}</label>`,
            )
            .join("")}</div>`,
      )
      .join("") + '<p class="svc-none" id="svcNone" hidden>Aucune prestation ne correspond à cette recherche.</p>';

  const paint = () => {
    for (const cb of list.querySelectorAll("input[type=checkbox]")) {
      cb.checked = sel.includes(cb.value);
      cb.disabled = !canPick(services, sel, cb.value, max);
      cb.closest(".svc-opt").classList.toggle("is-on", cb.checked);
    }
    selBox.hidden = max === 1 || !sel.length;
    chips.innerHTML = sel
      .map((id) => `<li class="svc-chip"><span>${esc(label(id))}</span><button type="button" data-rm="${esc(id)}" aria-label="Retirer : ${esc(label(id))}"><svg class="ic" aria-hidden="true"><use href="#i-close" /></svg></button></li>`)
      .join("");
    go.disabled = !sel.length;
    go.textContent = goLabel(sel.length);
    const ct = sel.some((id) => (services.find((s) => s.id === id) || {}).kind === "ct");
    note.textContent = ct
      ? "Le contrôle technique se cherche seul : ses prix viennent des centres agréés."
      : max > 1 && sel.length >= max
        ? `${max} prestations au plus.`
        : "";
  };
  const filter = () => {
    const ok = new Set(matchServices(services, search.value).map((s) => s.id));
    let any = false;
    for (const row of list.querySelectorAll(".svc-opt")) row.hidden = !ok.has(row.dataset.id);
    for (const g of list.querySelectorAll(".svc-grp")) {
      const some = [...g.querySelectorAll(".svc-opt")].some((r) => !r.hidden);
      g.hidden = !some;
      any = any || some;
    }
    q("svcNone").hidden = any;
  };

  const shut = () => {
    if (!doc.querySelector("dialog[open]")) root.classList.remove("dlg-open");
  };
  const close = () => {
    if ("function" == typeof dlg.close) dlg.close(); // l'événement « close » (plus bas) fait le reste
    else (dlg.removeAttribute("open"), shut());
  };
  const open = () => {
    sel = get().slice();
    search.value = "";
    filter();
    paint();
    root.classList.add("dlg-open");
    "function" == typeof dlg.showModal ? dlg.showModal() : dlg.setAttribute("open", "");
    // au doigt, le clavier ne s'ouvre pas tout seul : on pose le focus sur la première prestation cochée (ou la barre de recherche à la souris)
    const coarse = doc.defaultView && doc.defaultView.matchMedia && doc.defaultView.matchMedia("(pointer: coarse)").matches;
    const first = list.querySelector("input:checked");
    (coarse && first ? first : search).focus({ preventScroll: true });
    if (first && first.scrollIntoView) first.scrollIntoView({ block: "nearest" });
  };

  btn.addEventListener("click", open);
  search.addEventListener("input", filter);
  search.addEventListener("keydown", (e) => {
    if ("Enter" === e.key) e.preventDefault(); // Entrée ne valide pas : on coche d'abord
  });
  list.addEventListener("change", (e) => {
    const cb = e.target.closest && e.target.closest("input[type=checkbox]");
    if (!cb) return;
    sel = toggleService(services, sel, cb.value, max);
    paint();
  });
  chips.addEventListener("click", (e) => {
    const b = e.target.closest("[data-rm]");
    if (!b) return;
    sel = sel.filter((x) => x !== b.dataset.rm);
    paint();
    (chips.querySelector("[data-rm]") || search).focus();
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!sel.length) return;
    const ids = sel.slice();
    close();
    apply(ids);
    btn.focus();
  });
  q("svcClose").addEventListener("click", close);
  dlg.addEventListener("click", (e) => {
    const r = dlg.getBoundingClientRect();
    if (e.target === dlg && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) close();
  });
  dlg.addEventListener("close", shut);
  return { open, close, selected: () => sel.slice() };
}
