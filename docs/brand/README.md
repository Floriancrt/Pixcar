# Identité Pixcar (charte graphique v2.1)

Refonte du 24 octobre 2026, d'après les fichiers de l'utilisateur : la maquette HTML « Pixcar Atelier — Parcours complet » et la
charte graphique v2.1 (PDF du 23 octobre 2026). Périmètre choisi par l'utilisateur : **identité seule** — l'Espace Pro prend la charte
(accueil, connexion, transition, barre latérale, tous les écrans restylés sans changer leur organisation) ; le comparateur ne prend que
le logo, le favicon et l'orange, sans changement de mise en page. La gestion simple / avancée de l'atelier décrite dans le troisième
fichier (catalogue libre, règles par prestation) n'est pas dans ce lot.

## Charte

| Élément | Valeur |
| --- | --- |
| Dégradé du logo (vertical, un seul pour tout le logo) | `#F82B15` → `#FC4916` → `#FB8855` |
| Orange des actions | `#FC4916`, **texte noir** (6,1:1) ; le blanc sur l'orange (3,44:1) est à éviter |
| Noir (bandeaux, barre latérale, rideau) | `#000000` |
| Bleu (liens, information, focus) | `#0659E5` (5,49:1 sur `#F6F7F9`) |
| Vert (succès) | `#068E17` en aplat ou en filet ; texte vert `#0B6A18` (le `#068E17` ne fait que 4,3:1 sur blanc) |
| Orange en texte sur fond clair | `#B83A0B` (5,37:1) ou `#9D330E` (7,1:1, surtitres de l'accueil) |
| Police | Manrope 400 et 700 |
| Rayons | 8 à 12 px (boutons, champs), 12 à 16 px (cartes) |

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `pixcar-logo-trace-maquette.svg` | Version vectorielle noire du logo, copiée de la maquette (un chemin en polylignes, 135 Ko) : la source |
| `symbol-100.txt`, `word.json`, `logo.svg` | Produits par `scripts/brand-logo.py` : symbole (carré 0..100), lettrage et logo complet en dégradé (9 Ko au lieu de 135 ; écart de 0,7 % des pixels au sextuple) |
| `apple-touch-icon.svg` | Source de `src/assets/apple-touch-icon.png` (`scripts/apple-touch-icon.mjs` : rendu 180 px, 64 couleurs) |

`python3 scripts/brand-logo.py --apply` réécrit aussi, à partir de la source : la règle `.px-word` de `src/css/app.css` (mot-symbole en
SVG, dégradé ; variante `.px-word.ink` noire), le `<symbol id="px-mark">` de `src/partials/sprite.html` avec son dégradé `#px-grad`, et
`src/assets/favicon.svg` (carré noir arrondi, symbole en dégradé). Puis `node scripts/apple-touch-icon.mjs`, `node scripts/favicon-ico.mjs`
(16, 32 et 48 px) et `node scripts/build.mjs` : le build recopie `.px-word` et `#px-mark` dans l'Espace Pro et la page de rendez-vous.

Le symbole est peint par `fill: url(#px-grad) <orange>` : si un navigateur ne trouvait pas le dégradé, il reste orange uni. **Vérifié
sur Chromium seulement** (seul navigateur de l'environnement de test) : à regarder une fois sur Firefox et Safari.

## Espace Pro

- **Accueil** (visiteur non connecté) : promesse et aperçu d'une semaine de planning (exemple), bandeau des atouts, trois usages en
  onglets (Organiser, Publier, Comprendre ; flèches, Début, Fin), accès vérifié en trois étapes et règle des prix, questions, appel
  final. Il ne promet que ce qui existe.
- **Connexion guidée** (connexion, inscription, code) : formulaire à gauche, les trois étapes à droite (« Étape 1 sur 3 ») ; sur
  téléphone, les étapes passent en bandeau au-dessus du formulaire.
- **Rideau** (`src/js/pro/curtain.js`) : une fois le code accepté, un rideau noir glisse depuis la droite (700 ms,
  `cubic-bezier(.76, 0, .24, 1)`) et le logo apparaît au centre pendant le chargement ; puis, sur ordinateur, le rideau se resserre
  jusqu'à la largeur de la barre latérale et le logo rejoint sa place en haut de celle-ci (1 s). Sans barre latérale (téléphone, liste
  des garages), il s'efface. Animations Web (WAAPI), donc rien d'inline dans le HTML (politique de sécurité `style-src 'self'`) ;
  **aucun rideau** si le système demande moins d'animations.
- **Barre latérale** noire sur toute la hauteur, logo agrandi (symbole 36 px, mot 30 px) ; le bandeau du compte commence à sa droite.
- Jetons dans `src/css/pro.css` (section `:root`) : `--btn` / `--on-btn` (orange, texte noir), `--link`, `--accent`, `--topbar-bg`,
  `--chrome-*`.

## Comparateur

Seuls changent le logo (même plaque marine, mot-symbole 84 × 27 px au lieu de 80 × 27), le favicon et l'orange (`--btn`, `--px-lime`,
`--ld-car` à `#FC4916`, texte noir sur les boutons orange). Mise en page inchangée.

## Limites connues

- Le favicon reste un peu flou à 16 px (le symbole est fin) ; la charte le signale aussi pour les très petites tailles.
- Le marqueur choisi sur la carte garde son orange `#E5440B` (contraste avec le fond de carte).
