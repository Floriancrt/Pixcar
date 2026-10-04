// Fenêtre « Confidentialité et mentions légales » (src/partials/legal.html) : elle s'ouvre depuis tout élément [data-open-legal] (lien du
// bas du panneau, de « Sources et méthode », du formulaire de déclaration) et se ferme par ses boutons, Échap ou un clic sur le fond. Elle
// s'ouvre par-dessus le formulaire de déclaration, qui reste ouvert dessous. Absente de la page tant que src/legal.json est incomplet (voir
// scripts/build.mjs) : il n'y a alors rien à brancher. Le navigateur rend le focus à qui l'a ouverte. Le lien du bas du panneau est masqué
// dans le HTML et montré ici, une fois la page construite : sous des résultats que le script remplit, il descendrait de plusieurs lignes au
// démarrage (décalage de mise en page, test « prerender »).
export function initLegal(doc = document) {
  const dlg = doc.getElementById("legalDlg");
  if (!dlg) return;
  const win = doc.defaultView;
  const reveal = () => doc.querySelectorAll(".legal-foot[hidden]").forEach((p) => (p.hidden = false));
  win && win.requestAnimationFrame ? win.requestAnimationFrame(() => win.requestAnimationFrame(reveal)) : reveal(); // après deux images : la page a fini de bouger
  const root = doc.documentElement;
  const shut = () => {
    if (!doc.querySelector("dialog[open]")) root.classList.remove("dlg-open"); // le formulaire de déclaration peut rester ouvert dessous
  };
  const close = () => {
    if ("function" == typeof dlg.close) dlg.close(); // l'événement « close » (plus bas) fait le reste
    else (dlg.removeAttribute("open"), shut());
  };
  doc.addEventListener("click", (e) => {
    if (!(e.target.closest && e.target.closest("[data-open-legal]"))) return;
    root.classList.add("dlg-open");
    "function" == typeof dlg.showModal ? dlg.showModal() : dlg.setAttribute("open", "");
  });
  dlg.addEventListener("click", (e) => {
    const r = dlg.getBoundingClientRect();
    if (e.target === dlg && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) close();
  });
  dlg.querySelector("form").addEventListener("submit", (e) => (e.preventDefault(), close())); // un navigateur sans method="dialog" enverrait le formulaire
  dlg.addEventListener("close", shut);
}
