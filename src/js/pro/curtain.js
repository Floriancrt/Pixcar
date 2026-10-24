// Transition après la connexion, reprise de la maquette « Parcours Atelier » (enterDashboard) : le formulaire glisse vers la gauche en
// s'effaçant (450 ms), un rideau noir arrive par la droite (700 ms), le logo apparaît au centre (220 ms) pendant le chargement de
// l'espace ; puis le rideau se resserre jusqu'à la largeur de la barre latérale (1 s) et le logo rejoint sa place en haut de celle-ci
// (850 ms, 150 ms après) : sur téléphone, il se réduit au symbole du rail. Sans barre latérale (liste des garages), le rideau s'efface.
// Animations Web (WAAPI) : rien d'inline dans le HTML (politique de sécurité), et aucun rideau si le visiteur demande moins
// d'animations.
const EASE = "cubic-bezier(.76, 0, .24, 1)";
const LOGO = 148; // largeur du logo du rideau (.curtain-logo), celle de la barre latérale de la maquette
const HOME = 24; // position de départ du logo (left et top de .curtain-logo)

export function createCurtain(root) {
  const surface = root.querySelector(".curtain-surface");
  const logo = root.querySelector(".curtain-logo");
  const still = () => typeof root.animate !== "function" || matchMedia("(prefers-reduced-motion: reduce)").matches;
  const play = (n, frames, o) => n.animate(frames, { fill: "forwards", ...o }).finished;
  // au centre : min(300 px, 62 % de l'écran) de large
  const centre = () => {
    const w = Math.min(300, innerWidth * 0.62), scale = w / LOGO;
    return `translate(${(innerWidth - w) / 2 - HOME}px, ${(innerHeight - logo.offsetHeight * scale) / 2 - HOME}px) scale(${scale})`;
  };

  // couvre l'écran ; renvoie false (rien n'a bougé) quand les animations sont réduites. shell : le cadre du formulaire à effacer
  async function cover(shell) {
    if (still()) return false;
    root.hidden = false;
    if (shell) play(shell, [{ opacity: 1, transform: "translateX(0)" }, { opacity: 0, transform: "translateX(-24px)" }], { duration: 450, easing: "ease-in" });
    await play(surface, [{ transform: "translateX(100%)" }, { transform: "translateX(0)" }], { duration: 700, easing: EASE });
    const at = centre();
    await play(logo, [{ opacity: 0, transform: at }, { opacity: 1, transform: at }], { duration: 220 });
    return true;
  }

  // découvre l'espace chargé sous le rideau
  async function reveal(shell) {
    if (root.hidden) return;
    try {
      const nav = document.querySelector('body[data-view="dash"] .dash-nav');
      const dock = nav && nav.querySelector(".m-side-logo");
      if (dock && dock.offsetWidth) {
        const r = dock.getBoundingClientRect(), svg = dock.querySelector("svg").getBoundingClientRect();
        const scale = svg.width / LOGO; // 148 px, 140 px sous 1 200 px de large
        const hidden = Math.max(0, LOGO - r.width / scale); // rail (téléphone, barre repliée) : le symbole seul
        await Promise.all([
          play(surface, [{ transform: "scaleX(1)" }, { transform: `scaleX(${nav.offsetWidth / innerWidth})` }], { duration: 1000, easing: EASE }),
          play(logo, [{ transform: centre(), clipPath: "inset(0 0 0 0)" }, { transform: `translate(${r.left - HOME}px, ${r.top - HOME}px) scale(${scale})`, clipPath: `inset(0 ${hidden}px 0 0)` }], { duration: 850, delay: 150, easing: EASE }),
        ]);
      } else {
        await play(root, [{ opacity: 1 }, { opacity: 0 }], { duration: 400, easing: "ease-out" });
      }
    } finally {
      root.hidden = true;
      for (const n of [root, surface, logo, shell].filter(Boolean)) for (const a of n.getAnimations()) a.cancel();
    }
  }

  return { cover, reveal };
}
