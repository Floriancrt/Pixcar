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
| `source/pixcar-logo-degrade.svg` | **Source** : fichier officiel de l'utilisateur (24 octobre 2026), logo complet en dégradé, un chemin de 22 contours en polylignes (200 Ko) |
| `source/pixcar-logo-orange.svg`, `-noir.svg`, `-blanc.svg`, `source/pixcar-symbole-orange.svg` | Les autres fichiers officiels, copiés tels quels (mêmes tracés, une couleur ; symbole seul) |
| `symbol-100.txt`, `word.json`, `logo.svg` | Produits par `scripts/brand-logo.py` : symbole (carré 0..100), lettrage et logo complet en dégradé (7 Ko au lieu de 200 ; écart de 0,6 % des pixels, tous sur les bords lissés, au sextuple) |
| `apple-touch-icon.svg` | Source de `src/assets/apple-touch-icon.png` (`scripts/apple-touch-icon.mjs` : rendu 180 px, 64 couleurs) |

`python3 scripts/brand-logo.py --apply` réécrit, à partir de la source : la règle `.px-word` de `src/css/app.css` (mot-symbole en SVG,
dégradé ; variante `.px-word.ink` noire), le `<symbol id="px-mark">` de `src/partials/sprite.html` avec son dégradé `#px-grad`, le logo
complet de l'Espace Pro `<symbol id="px-logo">` (`src/partials/pro-logo.html`, un seul tracé dont la couleur se choisit par `fill` :
dégradé `#px-grad-logo` sur fond noir, noir au pied de page) et `src/assets/favicon.svg` (carré noir arrondi, symbole orange
`#FC4916` comme `pixcar-symbole-orange.svg`). Puis `node scripts/apple-touch-icon.mjs`, `node scripts/favicon-ico.mjs` (16, 32 et 48 px)
et `node scripts/build.mjs` : le build recopie `.px-word`, `#px-mark` et `#px-logo` dans l'Espace Pro et la page de rendez-vous.

Le logo est peint par `fill: url(#px-grad-logo) <orange>` : si un navigateur ne trouvait pas le dégradé, il reste orange uni. **Vérifié
sur Chromium seulement** (seul navigateur de l'environnement de test) : à regarder une fois sur Firefox et Safari.

## Espace Pro : la maquette « à la lettre » (étape 1)

Demande du 24 octobre 2026 : suivre exactement la maquette « Pixcar Atelier — Parcours complet » (structure, textes, Manrope et ses
tailles). Découpage choisi par l'utilisateur : **étape 1** (ce lot) = accueil, connexion, code, transition, logos, et la coque de
l'atelier sur les écrans existants ; **étape 2** (lot séparé) = les écrans de l'atelier comme la maquette (Gestion d'atelier
simple / avancée, Mon garage à onglets, prestations libres).

- **Accueil** (visiteur non connecté) : reprise exacte de la proposition retenue de la maquette (en-tête noir 82 px, héros
  `clamp(44px, 4.5vw, 64px)`, aperçu d'une semaine, bandeau des atouts, trois usages en onglets, trois étapes et règle des prix,
  questions, appel final, pied de page). Vérifié par `typo-diff` (comparaison texte par texte de la taille, de la graisse, de
  l'interligne, de l'espacement, de la couleur et de la boîte, maquette contre site) : **0 écart** sur ordinateur (1 440 px) et sur
  téléphone (390 px).
- **Connexion et code** : cadre guidé de 1 000 px, formulaire à gauche, les trois étapes à droite (« Étape N sur 3 ») ; sur téléphone,
  les étapes passent en bandeau. Mêmes mesures : seuls restent les écarts voulus listés plus bas.
- **Transition** (`src/js/pro/curtain.js`), séquence `enterDashboard` de la maquette : le formulaire glisse de 24 px vers la gauche en
  s'effaçant (450 ms), un rideau noir arrive par la droite (700 ms, `cubic-bezier(.76, 0, .24, 1)`), le logo apparaît au centre
  (220 ms) pendant le chargement ; puis le rideau se resserre jusqu'à la largeur de la barre latérale (1 s) et le logo rejoint sa place
  en haut de celle-ci (850 ms, 150 ms après) ; sur téléphone il se réduit au symbole du rail. Animations Web (WAAPI), donc rien
  d'inline dans le HTML (politique de sécurité `style-src 'self'`) ; **aucun rideau** si le système demande moins d'animations.
- **Coque de l'atelier** : barre latérale noire de 216 px (196 px sous 1 200 px, rail de 64 px sous 760 px et quand elle est repliée)
  avec le logo (148 px), la carte du garage, « MON ATELIER » en haut, puis en bas « MON ESPACE », « Replier le menu » et la carte
  utilisateur (initiales, nom, Gérant(e) / Salarié(e), PRO) ; fil d'Ariane et bouton d'aide « ? » au-dessus du titre (29 px) ; chiffres
  du tableau de bord en bandeau (libellé 9 px, valeur 20 px).

- **Planning** (début de l'étape 2, 24 octobre 2026) : présenté comme l'agenda « Gestion d'atelier » de la maquette (bandeau de chiffres,
  barre d'outils avec plein écran et recherche, 68 px par heure, blocs à filet coloré, pause déjeuner nommée, légende sous la grille) ;
  détail dans `docs/calendrier-avance.md` (« Présentation du 24 octobre 2026 »). Le titre reste « Planning », le bouton « + Nouveau »
  garde son menu (rendez-vous hors Pixcar, créneau bloqué, absence, indisponibilité) ; le choix Simple / Avancé et les onglets
  Mécaniciens, Équipements, Interventions, Capacité de la maquette sont pour la suite de l'étape 2.
- **Graisses** : la maquette met l'emphase à 650 et garde 700 pour les titres et les chiffres ; l'Espace Pro (hors accueil et
  connexion, déjà conformes) suit la même règle depuis le 24 octobre 2026 (plus aucun 800).

### Écarts voulus avec la maquette

| Écart | Raison |
| --- | --- |
| Gris secondaires un peu plus foncés (`#6f7580` au lieu de `#737984`, `#6a707b` au lieu de `#777d88` / `#747b88`), numéros d'étape `#d63c0e` au lieu de `#fc4916` | Contraste AA (4,5:1) : les couleurs de la maquette n'y arrivent pas sur fond clair |
| Retirés : « Tester la transition », bandeau « Maquette interactive », e-mail fictif, « Démonstration », « Ouvrir l'agenda de démonstration » | Éléments de démonstration de la maquette (accord de l'utilisateur pour « Tester la transition ») |
| Mention « Connexion gérée par notre prestataire d'identité (Amazon Cognito)… » sous le formulaire | Information sur le traitement des données (déjà présente avant) |
| Code à 6 **ou 8** chiffres (maquette : 6) | Cognito envoie 8 chiffres pour la connexion |
| « Vos données » et « Aide à la connexion » ouvrent une fenêtre ; « Contact » ajouté au pied de page | Les liens de la maquette ne mènent nulle part |
| Adresse du compte et « Se déconnecter » dans le fil d'Ariane | Indispensable ; absent de la maquette |
| Barre latérale : les liens existants (Planning, Prestations & tarifs, Disponibilités, Mes garages, Replier le menu ; « Voir Pixcar » supprimé à la demande de l'utilisateur) | Les écrans de la maquette (Gestion d'atelier…) sont l'étape 2 |
| Rôle de la carte utilisateur : « Gérant(e) », « Salarié(e) » ou « Espace professionnel » (maquette : « Administrateur ») | C'est ce que l'API connaît |
| Libellés « ESPACE PRO » et « Retour à l'accueil » sur une ligne sur téléphone (maquette : deux) | La maquette les coupe parce que le bouton « Tester la transition » prend la place |
| Reproduit tel quel : « Aujourd'hui » à 24 px dans l'aperçu du planning sur téléphone (16 px sur ordinateur) | C'est ce que fait la maquette (sa règle mobile `.product-detail h3` s'applique aussi à ce titre) ; probablement involontaire, à confirmer |
| Reproduit tel quel : textes de 8 à 10 px (barre latérale, bandeau de chiffres, fil d'Ariane) | Tailles de la maquette ; lisibilité limitée sur petit écran, à surveiller |

## Comparateur

Seuls changent le logo (même plaque marine, mot-symbole 84 × 27 px au lieu de 80 × 27), le favicon et l'orange (`--btn`, `--px-lime`,
`--ld-car` à `#FC4916`, texte noir sur les boutons orange). Mise en page inchangée.

## Limites connues

- Le favicon reste un peu flou à 16 px (le symbole est fin) ; la charte le signale aussi pour les très petites tailles.
- Les fichiers source font 200 Ko chacun : ils restent dans `docs/brand/source/` et ne sont pas servis par le site.
- Le marqueur choisi sur la carte garde son orange `#E5440B` (contraste avec le fond de carte).
