// Accord de sous-traitance des données (docs/sous-traitance.md) : où il en est (Mon garage › Modules, bandeau de Gestion d'atelier), la
// fenêtre qui le montre et l'acceptation au nom du garage. Le texte est dans la page (src/partials/sous-traitance.html, mis par la
// construction) ; l'API dit la version en vigueur et refuse l'équipe, les absences et les rendez-vous saisis tant qu'il n'est pas accepté
// (403 agreement_required : api.js rouvre alors cette fenêtre). Que du TEXTE écrit dans la page.
const LONG = { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris" };
const when = (iso) => new Date(iso).toLocaleDateString("fr-FR", LONG);

export function createAgreement({ api, $, busy, apiProblem }) {
  let garageId = null;
  let state = null; // { version, label, draft, accepted, acceptedAt?, signer?, required } ; null : API sans accord (ancienne version)
  const dlg = $("dpaDlg");

  function render() {
    $("planDpa").hidden = !state || state.accepted;
    $("mgDpa").hidden = !state;
    if (!state) return;
    $("mgDpaState").textContent = state.accepted
      ? `Accepté le ${when(state.acceptedAt)} par ${state.signer} (${state.label}).`
      : state.required
        ? "Pas encore accepté. Sans lui, Gestion d'atelier n'enregistre ni votre équipe ni les clients que vous notez."
        : "Pas encore accepté.";
  }
  function set(id, agreement) {
    garageId = id;
    state = agreement || null;
    render();
  }
  function fail(text) {
    $("dpaErr").textContent = text;
    $("dpaErr").hidden = false;
  }
  async function open() {
    // page chargée avant la mise à jour de l'API (elle ne connaissait pas l'accord) : le demander maintenant
    if (!state && garageId) {
      try {
        set(garageId, await api.agreement(garageId));
      } catch {
        return;
      }
    }
    if (!state) return;
    $("dpaAsk").hidden = state.accepted;
    $("dpaDone").hidden = !state.accepted;
    $("dpaDone").textContent = state.accepted ? `Accepté au nom du garage le ${when(state.acceptedAt)} par ${state.signer}.` : "";
    $("dpaCheck").checked = false;
    $("dpaErr").hidden = true;
    if (!dlg.open) dlg.showModal();
  }

  $("dpaForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!$("dpaCheck").checked) return fail("Cochez la case pour accepter l'accord.");
    await busy($("dpaAccept"), async () => {
      try {
        set(garageId, await api.acceptAgreement(garageId, state.version));
        dlg.close();
        $("mgLive").textContent = "Accord de sous-traitance accepté.";
      } catch (e) {
        if (e.status === 401) {
          dlg.close();
          return apiProblem(e);
        }
        // texte changé depuis l'ouverture de la page : la version en vigueur n'est pas celle qui est affichée, recharger
        fail(e.code === "agreement_version" ? "Cet accord a changé depuis l'ouverture de la page : rechargez-la pour lire la nouvelle version." : e.message);
      }
    });
  });
  $("dpaCheck").addEventListener("change", () => ($("dpaErr").hidden = true));
  for (const b of document.querySelectorAll("[data-dpa]")) b.addEventListener("click", open);

  return { set, open };
}
