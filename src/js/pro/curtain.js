// Transition après la connexion (maquette « Parcours Atelier ») : un rideau noir glisse depuis la droite et couvre l'écran, le logo
// apparaît au centre ; une fois l'espace chargé, le rideau se resserre jusqu'à la largeur de la barre latérale et le logo rejoint sa
// place en haut de celle-ci. Sans barre latérale (téléphone, liste des garages), le rideau s'efface. Animations Web (WAAPI) : rien
// d'inline dans le HTML (politique de sécurité), et aucun rideau si le visiteur demande moins d'animations.
const EASE = "cubic-bezier(.76, 0, .24, 1)";
const ZOOM = 2.2; // taille du logo au centre, par rapport à celle de la barre latérale

export function createCurtain(root) {
  const surface = root.querySelector(".curtain-surface");
  const logo = root.querySelector(".curtain-logo");
  const word = logo.querySelector(".px-word");
  const still = () => typeof root.animate !== "function" || matchMedia("(prefers-reduced-motion: reduce)").matches;
  const centred = () => `translate(${(innerWidth - logo.offsetWidth * ZOOM) / 2}px, ${(innerHeight - logo.offsetHeight * ZOOM) / 2}px) scale(${ZOOM})`;
  const play = (n, frames, o) => n.animate(frames, { fill: "forwards", ...o }).finished;

  // couvre l'écran ; renvoie false (rien n'a bougé) quand les animations sont réduites
  async function cover() {
    if (still()) return false;
    root.hidden = false;
    const at = centred();
    await Promise.all([
      play(surface, [{ transform: "translateX(100%)" }, { transform: "none" }], { duration: 700, easing: EASE }),
      play(logo, [{ opacity: 0, transform: `${at} translateY(6px)` }, { opacity: 1, transform: at }], { duration: 420, delay: 380, easing: "ease-out" }),
    ]);
    return true;
  }

  // découvre l'espace chargé sous le rideau
  async function reveal() {
    if (root.hidden) return;
    try {
      const nav = document.querySelector('body[data-view="dash"] .dash-nav');
      const brand = nav && nav.querySelector(".nav-brand");
      if (brand && brand.offsetWidth && matchMedia("(min-width: 900px)").matches) {
        const r = brand.getBoundingClientRect();
        const moves = [
          play(surface, [{ transform: "none" }, { transform: `scaleX(${nav.offsetWidth / innerWidth})` }], { duration: 1000, easing: EASE }),
          play(logo, [{ transform: centred() }, { transform: `translate(${r.left}px, ${r.top}px)` }], { duration: 1000, easing: EASE }),
        ];
        // barre repliée : seul le symbole reste
        if (document.body.classList.contains("rail-min")) moves.push(play(word, [{ opacity: 1 }, { opacity: 0 }], { duration: 300 }));
        await Promise.all(moves);
        await play(root, [{ opacity: 1 }, { opacity: 0 }], { duration: 160 });
      } else {
        await play(root, [{ opacity: 1 }, { opacity: 0 }], { duration: 400, easing: "ease-out" });
      }
    } finally {
      root.hidden = true;
      for (const n of [root, surface, logo, word]) for (const a of n.getAnimations()) a.cancel();
    }
  }

  return { cover, reveal };
}
