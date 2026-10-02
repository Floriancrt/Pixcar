# Pixcar — interface rafraîchie

Comparateur de garages aux couleurs de Pixcar (anciennement « Juste Garage »), inspiré de la maquette « Package tracking » : rail d'icônes, panneau « verre », carte plein écran, fiche sélectionnée dépliée et barre récapitulative flottante sur la carte.

| Fichier | Rôle |
| --- | --- |
| `index.html` | Version rafraîchie. Fichier unique et autonome : à ouvrir dans un navigateur (connexion requise pour les adresses, garages et tuiles). |
| `original.html` | Version d'origine, inchangée, pour comparaison ou retour arrière. |

> Ce dossier est indépendant du thème Shopify du dépôt : un thème Shopify ne contient que `assets/`, `config/`, `layout/`, `locales/`, `sections/`, `snippets/` et `templates/`, il n'est donc pas envoyé avec le thème.

## Ce qui change

- **Ordinateur (≥ 1024 px)** : rail d'icônes à gauche, panneau (recherche + liste) flottant sur une **carte persistante plein écran**. Cliquer une fiche ou un marqueur la **sélectionne** : contour vert, fiche dépliée avec la frise « Votre adresse → garage », marqueur agrandi avec bulle noire, barre récapitulative sur la carte.
- **Mobile** : barre du haut + navigation flottante en bas ; bouton **Carte / Liste** ; carte plein écran avec barre récapitulative (« Voir la fiche » ramène à la fiche).
- **Fiches** : une seule fiche ouverte à la fois (accordéon), avatars (logo ou monogramme de l'enseigne, initiale pastel pour un indépendant), distance en pastille, statuts en pastilles à point, actions teintées, bouton noir « Déclarer une réparation ».
- **Style** : charte Pixcar (noir, vert menthe, vert vif, blanc cassé : voir ci-dessous), grands rayons, police *Plus Jakarta Sans* (remplace Barlow), thème sombre complet (préférence système, ou `data-theme="light|dark"` sur `<html>`).
- **Accessibilité** : lien d'évitement, titres ordonnés, cibles tactiles de 42 à 44 px (`pointer: coarse`), contrastes calculés y compris au pic des lueurs du fond (texte ≥ 4,5:1, bordures de champs ≥ 3:1), `prefers-reduced-motion`, `prefers-contrast`, `forced-colors`.

## Charte Pixcar

Tirée du logo, couleurs mesurées sur vos images : noir, vert menthe du symbole `#9DFC8C`, vert vif de « car » `#79FA52`, blanc cassé de « pix » `#F2F2F2`.

| Élément | Clair | Sombre |
| --- | --- | --- |
| Rail, barre du haut (mobile), navigation flottante | noir (le « pix » est blanc : le logo a besoin d'un fond noir) | noir |
| Onglet actif, bouton « Réparation » | vert vif, texte noir | idem |
| Accent (liens, sélection, focus, marqueur choisi, rayon de recherche) | vert forêt `#0A7427` | vert vif `#79FA52` |
| Bouton principal (pilule) | noir, texte blanc | vert vif, texte noir |
| Pastille « Promo » | noir, texte vert vif | vert vif, texte noir |
| Fond | blanc verdi `#EDF1EC`, lueurs menthe | noir `#040604`, lueurs vertes |
| Fond de carte | Plan IGN désaturé (`--map-filter`) pour que marqueurs et accents ressortent | idem, inversé |
| Initiales des garages indépendants | pastel dans les verts | idem, sombre |

Pourquoi un vert plus sombre en clair : le vert vif sur blanc ne fait que 1,35:1 ; `#0A7427` fait 5,9:1 sur blanc et au moins 4,5:1 sur tous les fonds clairs, y compris au pic des lueurs. Le jaune ne subsiste que dans les étoiles et l'ambre des avertissements ; les monogrammes d'enseignes gardent leurs propres couleurs.

Logos :

- **Symbole** (anneau de 16 secteurs) : retracé en vectoriel à partir de votre image (superposé à l'original : même surface à 0,2 % près, bords à moins d'un pixel à 840 px). Il est dans le sprite SVG (`<symbol id="px-mark">`) et sert au rail, à la barre du haut et au favicon.
- **Mot-symbole « pixcar »** : votre PNG, recadré et réduit à 32 couleurs (572 × 193, ≈ 5 Ko), en image de fond de `.px-word`. Sur ordinateur il remplace le titre « Garages » dans une plaque noire (le texte reste pour les lecteurs d'écran) ; sur mobile il est dans la barre du haut. C'est un raster : net même sur un écran 3× à cette taille ; si vous avez le SVG, remplacez l'image.
- Favicon SVG et icône d'écran d'accueil (`apple-touch-icon`) en `data:`, `theme-color` noir, `<title>` « Pixcar ».
- Changer de logo : remplacer le `<path>` de `#px-mark` et l'image de `.px-word` (mettre à jour `aspect-ratio` si les proportions changent).

Jetons (section 1 du CSS) : `--px-mint`, `--px-lime`, `--px-ice` (marque, fixes), `--accent*`, `--promo-*`, `--chrome-*` (rail), `--mk-*` (marqueurs, lus par le JS). Les anciens jetons `--indigo*` et `--pink*` n'existent plus.

## Ce qui ne change pas

Recherche (IGN, OpenStreetMap, SIRENE, DGCCRF), prix et promotions des enseignes, calculs, liens d'action, clés `localStorage` (`jg.*`) : les données affichées sont identiques à l'original. Ne changent que la présentation et les textes ou liens décrits ci-dessous : plus de « dès » devant les prix, repères de médiane dans l'échelle de prix, téléphones lus et affichés autrement (les liens `tel:` sont désormais internationaux, `tel:+33472000007` au lieu de `tel:0472000007`), messages OpenStreetMap retirés.

## Avatars des enseignes

Les 26 enseignes de la page et les 8 réseaux de contrôle technique ont toujours un avatar « de marque » ; seuls les garages indépendants gardent l'initiale pastel. Trois niveaux, du meilleur au repli :

1. **Logo Wikidata.** Une seule requête à `query.wikidata.org` (icône `P8972`, sinon logo `P154`, hors logos périmés) pour les enseignes affichées, puis l'image depuis **Wikimedia Commons** (128 px). Seules les images de Commons sont acceptées.
2. **Icône du site de l'enseigne.** `/apple-touch-icon.png`, puis `/favicon.ico`, acceptée si elle fait **au moins 32 px** (pour un `.ico`, Chromium retient la plus grande image du fichier). Le site vient, dans l'ordre : des données de la page (prix et promotions : 6 enseignes), de la table `logoDom` (19 sites officiels relevés par recherche web le 1er octobre 2026), puis de Wikidata (`P856`, seule source pour une enseigne absente des deux premières ; un site Wikidata n'est admis que si les deux derniers libellés de son domaine portent le nom de l'enseigne : `norauto.fr`, `carter-cash.com` passent, `norauto.exemple.org` non ; en `https`, sans IP ni `localhost`). **Ce palier ne dépend pas de Wikidata** : il démarre au bout de 2,5 s au plus, que Wikidata ait répondu ou non ; une réponse plus tardive donne une seconde chance aux enseignes encore sans logo (sans refaire les requêtes déjà échouées).
3. **Monogramme** (toujours présent, remplacé dès qu'un logo se charge) : initiales sur la couleur de la marque, texte blanc ou foncé selon le meilleur contraste (≥ 4,5:1 pour les 34). **Ces couleurs sont des teintes d'interface choisies de mémoire, pas les couleurs officielles** : à ajuster dans `logoBrand` / `ctBrand` si vous avez la charte.

Fonctionnement et limites :

- Les réponses sont gardées 30 jours (`localStorage`, clé `jg.logos.v2` ; l'ancienne `jg.logos.v1` est supprimée). Une icône qui a fonctionné est réessayée en premier. **Un échec n'est jamais mémorisé.**
- Seules les enseignes réellement affichées sont résolues, jamais plus.
- Le niveau 2 contacte **directement les sites des enseignes** : elles voient l'adresse IP et le navigateur du visiteur (et leurs cookies si le navigateur autorise les cookies tiers), pas la page d'origine (`no-referrer`). Pour s'en passer : `window.JG_SITE_ICONS = false` avant le script (reste Wikidata + monogrammes) ; pour ne pas interroger Wikidata : `window.JG_WIKIDATA = false` (reste icônes des sites + monogrammes). Les requêtes sont toutes ignorées si `navigator.connection.saveData` est actif.
- Sans réseau, ou si rien n'est trouvé : monogramme, sans erreur.
- **Imposer un logo** (enseigne introuvable, logo officiel de meilleure qualité) : `window.JG_LOGOS = { norauto: "https://…/logo.png" }` avant le script (URL ou `data:`). Les identifiants sont ceux du tableau `l` du JS (`norauto`, `feuvert`, `speedy`, `midas`, `roady`, `euromaster`, `points`, …). Seul Driver Center n'a aucun site connu (aucun site français trouvé) : sans surcharge il reste en monogramme. Profil Plus, Siligom, Carter-Cash et Eurorepar n'ont pas d'identifiant Wikidata : leur logo ne peut venir que de l'icône de leur site. Pour garantir un logo **sans aucun appel réseau**, intégrez le fichier : `window.JG_LOGOS = { speedy: "data:image/svg+xml;base64,…" }` (à définir avant le script, ou à écrire en dur dans `logoPin`).
- Diagnostic : `jgLogos()` dans la console liste, pour chaque enseigne, le logo Wikidata trouvé, le site utilisé et l'image affichée.
- Les logos sont des marques de leurs propriétaires ; les fichiers de Commons ont leurs propres licences.

## Adresses manquantes

OpenStreetMap n'a pas toujours l'adresse d'un garage (beaucoup de Speedy, par exemple). Quand la rue manque, la page demande à la **Base Adresse Nationale** (géocodeur inverse de la Géoplateforme IGN, déjà utilisé pour la recherche d'adresse) l'adresse la plus proche de la position du garage, **à l'ouverture de sa fiche ou à sa sélection** (une requête par garage, jamais pour toute la liste) :

- affichée précédée de **« ≈ »** (« Environ » pour les lecteurs d'écran) avec une infobulle « adresse la plus proche de la position du garage (à 14 m), à titre indicatif » : c'est une approximation, pas l'adresse déclarée ;
- **refusée au-delà de 80 m** (distance recalculée à partir de la géométrie renvoyée, la propriété `distance` n'étant qu'un repli) : le garage garde « Adresse non renseignée » ;
- gardée **90 jours** (`jg.addr.v1`, 400 entrées au plus) ; un refus, 7 jours ; un échec réseau n'est jamais mémorisé (une nouvelle tentative à l'ouverture suivante, puis plus) ;
- reprise partout : fiche, frise du trajet, bulle de la carte, lien « Avis Google » (le nom + l'adresse précisent la recherche), liste de suggestions et confirmation du formulaire « Déclarer une réparation » (l'adresse enregistrée garde le « ≈ ») ;
- OpenStreetMap lui-même est mieux lu : `addr:full`, `addr:place`, `addr:suburb` et `contact:*` complètent `addr:*` (cache OSM passé en `jg.osm.v3` pour que ces balises soient conservées) ;
- sans effet sur le contrôle technique et le registre SIRENE, dont l'adresse vient des données.

## Repères de prix

L'**échelle de prix** (fiche d'un garage où vous avez déclaré des réparations, et vue « Mes réparations ») repère deux médianes, écrites en toutes lettres et chiffrées :

- **Médiane des enseignes** (▼ au-dessus de la barre) : médiane des prix nationaux de la prestation, hors « pièces en plus » ;
- **Médiane de ce garage** (▲ sous la barre) : médiane de vos réparations déclarées chez ce garage pour cette prestation ;
- une pastille donne l'écart : « 18 % sous les enseignes » (vert), « 42 % au-dessus des enseignes » (ambre), « Au niveau des enseignes » en dessous de 5 % d'écart ;
- les points de la barre sont toujours vos réparations (infobulle : prix, modèle, mois) ; sans prix d'enseigne pour la prestation (révision, batterie…), seule la médiane du garage est repérée ;
- les médianes sont du texte (lisible sans la barre, qui reste décorative) ; en couleurs forcées les repères prennent `CanvasText` / `Highlight`.

**« dès » est retiré de tous les prix** (cartes, ligne de synthèse, bulle et barre de la carte, note de la fiche, vue Prix et promos). Conservé volontairement : les libellés des offres tels que les enseignes les publient (« vidange dès 49,95 € », « Montage dès 9,95 € »), où le mot décrit la condition de l'offre, et la mention « à partir de » une fois (sous-titre de la vue Prix, encadré « les repères » du formulaire). `from: true` reste dans les données, donc rétablir le mot est une ligne (`${n.from ? … : ""}` dans les cinq endroits ; la liste est dans `build.py`, patchs J13a-e).

## Fiche garagiste et téléphones

Tous les garages ont les mêmes lignes dans la fiche : **Téléphone, Horaires, Site** (« Non renseigné » quand l'information manque, avec un lien « chercher sur Google Maps » pour le numéro). Les numéros :

- OpenStreetMap les saisit de dix façons ; `phoneParse()` lit `phone`, `contact:phone`, **`mobile`** (nouveau), `contact:mobile`, `phone:mobile`, plusieurs numéros dans une valeur (séparés par `;`, `,`, `/`, « ou », « et »), `+33 (0)4…`, `0033…`, points, tirets ;
- écrits à la française (`04 72 55 34 57`), doublons supprimés (un même numéro écrit de deux façons compte une fois), **deux numéros au plus** par fiche, chacun avec son bouton « Copier » ; le bouton « Appeler » de la carte appelle le premier (`tel:+33…`, libellé accessible « Appeler le 04 72 55 34 57 ») ;
- une valeur qui n'est pas un numéro (« n/a », numéro trop court ou trop long, extension collée) est ignorée, jamais devinée ; un numéro étranger est gardé tel quel (`+32 2 123 45 67`) ;
- contrôle technique : le champ officiel `cct_tel`, même mise en forme ; registre SIRENE : aucun numéro dans les données.

**Limite** : la page ne peut afficher que les numéros que ces sources contiennent, et je ne connais pas d'autre source ouverte exploitable depuis une page web : SIRENE n'a pas de champ téléphone ; le service public Nominatim n'est pas prévu pour cet usage (limite d'une requête par seconde pour toute l'application, d'après sa politique d'usage : à revérifier) ; les sites des enseignes ne répondent pas aux pages d'un autre domaine (CORS) et leur extraction relève de leurs conditions d'utilisation. Une couverture complète demanderait une source commerciale à clé (Google Places par exemple : coût et conditions d'usage à vérifier). Le gain réel de la lecture de `mobile` et des numéros multiples dépend de la couverture d'OpenStreetMap dans votre zone, que le bac à sable ne permet pas de mesurer.

## Messages et textes

- Phrase sous le logo (ordinateur) : « 1ère plateforme communautaire de comparaison de prestations d'entretien et de réparation auto ». Sur mobile le bandeau du haut reste compact, sans phrase.
- Carte vide : « Votre titine est comme vous, elle n'aime pas qu'on lui cache des choses ».
- **Plus aucun paragraphe sur OpenStreetMap dans l'interface.** OpenStreetMap fournit la liste des garages (nom, position, adresse, téléphone, horaires, site, enseigne), lue avec l'API Overpass ; le fond de carte est le Plan IGN et la recherche d'adresse la BAN. Retirés : « OpenStreetMap ne répond pas pour le moment (…) » (liste enregistrée ou liste du registre), les états du type « Le serveur OpenStreetMap principal tarde à répondre » (devenus « Le serveur principal… »), « seuls les garages d'OpenStreetMap sont affichés » ; en cas de panne totale, « Ni la base des garages ni le registre des entreprises ne répondent », la liste des serveurs et de leurs codes d'erreur étant repliée sous **« Détails techniques »**. Restent, parce que la licence ODbL l'exige : la ligne « © les contributeurs d'OpenStreetMap » sous la liste, le crédit de la carte, et la rubrique « Sources et méthode » (qui dit maintenant ce que fournit OpenStreetMap). Conservés aussi : la date de la liste enregistrée avec « Actualiser », et la phrase du registre SIRENE facultatif quand il ne répond pas.

## Barre de défilement

Sur ordinateur les flèches haut/bas de la barre native dépassaient des coins arrondis du panneau (et de la fenêtre « Déclarer une réparation » : 208 pixels hors de la forme sur la version précédente, mesurés par différence d'image). Pour la souris et le pavé tactile (`hover: hover` et `pointer: fine`), le panneau, cette fenêtre et la liste de suggestions ont maintenant une barre fine **sans flèches**, rentrée de 18 px (8 px pour les suggestions) en haut et en bas pour rester dans la courbe (`::-webkit-scrollbar`, Chromium et Safari). Firefox garde les propriétés standard (`scrollbar-width: thin`) ; elles sont dans un `@supports not selector(::-webkit-scrollbar)` : les poser aussi dans Chromium désactiverait le style WebKit. Écrans tactiles : barres natives en surimpression, sans changement.

À vérifier : le rendu sous Windows (mon bac à sable est Linux) et sous macOS/Safari, où une barre personnalisée devient permanente au lieu de la barre « automatique » du système.

## Chargement

Pendant une recherche (`body.is-searching`, posé par `ct()` du début à la fin, erreurs comprises) :

- **Sur la carte (ordinateur)** : un rond-point autour de l'épingle de l'adresse, au centre du rayon de recherche, et une voiture qui y tourne. C'est votre GIF (anneau routier, pointillés, voiture dans la voie extérieure, un tour qui accélère puis ralentit, puis une pause) **redessiné en SVG** pour suivre la charte et les deux thèmes, ce qu'un GIF de 340 Ko ne fait pas : bitume noir (gris foncé en thème sombre pour se détacher du fond), pointillés blanc cassé `#F2F2F2`, voiture vert vif `#79FA52`, îlot et épingle aux couleurs de la carte. Le sens est **inverse des aiguilles d'une montre** (giratoire français ; le GIF tourne dans l'autre sens). Un tour dure 1,8 s avec la même courbe d'accélération que le GIF (`cubic-bezier(.65, 0, .35, 1)`, relevée image par image : 151 images en 5 s, la voiture fait son tour en 1,5 s puis attend 3,5 s), puis 0,6 s de pause : la pause du GIF est trop longue pour une attente. La carte d'attente (« La carte s'affiche après votre recherche ») s'efface pendant ce temps.
- **Encart d'état** : la phrase « Votre titine est comme vous, elle n'aime pas qu'on lui cache des choses » en titre, l'étape en cours (« Recherche des garages dans un rayon de 10 km… ») en dessous, plus petite. Seuls les messages d'avancement d'une recherche sont concernés ; erreurs et informations gardent leur aspect. La phrase est décorative et cachée aux lecteurs d'écran (la zone vivante `#results` la relirait à chaque étape), l'étape ne l'est pas. Sur mobile, où la carte est cachée, le même rond-point (72 px) apparaît à gauche de l'encart.
- L'encadré « les repères » (teaser) s'efface pendant la recherche : l'encart d'état se trouvait sous lui, hors écran sur mobile et sur les petits ordinateurs.
- **Recherche rapide** : le rond-point et l'encart n'apparaissent qu'après 0,35 s, en fondu ; une recherche servie par la liste enregistrée ne les montre jamais.
- **Aucun coût hors recherche** : les animations n'existent que sous `body.is-searching` (Chromium en crée même sous un `<g>` en `display:none`, d'où cette précaution) ; 60 images/s mesurées avec et sans (Chromium sans GPU). `prefers-reduced-motion` : la voiture reste en haut de l'anneau ; couleurs forcées : couleurs du système, voiture (`Canvas`) sur bitume (`CanvasText`).
- Couleurs : jetons `--ld-*` (section 1 du CSS, thème clair et sombre). Dessins : classes `ld-*`, section « Chargement » du CSS.

## Maintenance

Le JS est celui de l'original (noms de variables minifiés), reformaté, avec des patchs ciblés :

| Fonction | Rôle |
| --- | --- |
| `bt()`, `av()`, `kd()` | gabarit de fiche, avatar (logo, monogramme ou initiale), libellé du type de garage |
| `logoLoad()`, `logoTry()`, `logoApply()`, `logoShow()`, `logoHostOk()` | résolution Wikidata → Commons puis icône du site, cache 30 jours, remplacement du monogramme par le logo ; `logoBrand` / `ctBrand` : monogrammes |
| `adEnsure()`, `adFetch()`, `adRepaint()`, `adInit()` | adresses manquantes : requête BAN, cache, mise à jour de la fiche, de la bulle et du lien Google |
| `ct()`, `dt()` | `ct()` : état « recherche en cours » (bouton, `body.is-searching`) ; `dt()` : encart d'état, avec la phrase d'attente pendant une recherche |
| `wt()`, `rb()` | détails de fiche (lignes Téléphone / Horaires / Site), frise du trajet |
| `it()` | échelle de prix : médiane des enseignes (▼), médiane du garage (▲), écart |
| `phoneParse()`, `phoneList()`, `vt()` | lecture, mise en forme et dédoublonnage des numéros ; `vt()` = premier numéro |
| `kt()`, `kc()` | accordéon ; compense le défilement quand une fiche au-dessus se referme (utile sur Safari) |
| `sl()`, `slMap()`, `mi()`, `sx()`, `bindTip()` | sélection liste ↔ carte, barre récapitulative, bulles |
| `St()` | bascule Liste / Carte sur mobile (classe `is-map` sur `<body>`) |
| `Et()` | carte : cadrage qui tient compte du panneau (`fo()`), marqueurs |
| `Zt()` | expose l'écran courant dans `body[data-screen]` |

- Le point de bascule **1024 px** doit rester identique dans le CSS (`@media (min-width: 1024px)`) et dans le JS (`ge()`).
- Couleurs des marqueurs lues par le JS : `--mk-priced`, `--mk-none`, `--mk-sel`, `--mk-user`, `--mk-user-ring`, `--mk-ring`.
- Le fond de carte reste le Plan IGN, adouci par `--map-filter` (inversé en sombre).
- L'ambre (jaune doux) est réservé aux avertissements et à « Avis Google » ; les étoiles gardent leur jaune.

## Vérifications effectuées

Tests automatisés (Chromium) contre des services simulés, sur l'original puis sur la nouvelle version : 26 contrôles communs et des données identiques (résumés, ordre, prix et liens des fiches, tri, filtres, rayon, contrôle technique, réparations, navigation), 36 contrôles propres à la nouvelle interface, 0 violation axe-core sur 14 états (clair/sombre, ordinateur/mobile), débordement et redimensionnement à chaud.

Charte : 31 contrôles (titre, favicon, symbole de 16 secteurs, pixels de la plaque noire / « pix » blanc cassé / « car » vert vif, rail et barre noirs, onglet actif vert vif, jetons, marqueurs lisant les jetons, initiales dans les verts, mobile et ordinateur, couleurs forcées) et 150 rapports de contraste calculés à partir des jetons livrés (texte ≥ 4,5:1, bordures de champs et focus ≥ 3:1, au pic des lueurs et sur les deux extrémités du verre). Cinq variantes cassées volontairement de la page (couleurs forcées, plaque masquée, secteur manquant, anneau du marqueur, accent) font échouer les contrôles attendus.

Avatars : 62 contrôles, dont les trois niveaux ensemble (logo Wikidata, icône du site après un 404 sur `apple-touch-icon.png`, `.ico` à plusieurs images, icône de 16 px refusée, fichier illisible, monogramme), les garde-fous (IP, `localhost`, sous-domaine trompeur, schéma, identifiants et port retirés), le cache v2 (rechargement sans nouvelle requête, expiration à 30 jours), Wikidata en panne, `JG_LOGOS`, `JG_SITE_ICONS = false`, économiseur de données, contrôle technique, contraste de chacun des 34 monogrammes, alignement des avatars (fiches, vue Prix, ordinateur et mobile), 25 enseignes sur 26 dotées d'un site officiel sans réponse de Wikidata, Wikidata muet (le palier 2 démarre après 2,5 s), Wikidata tardif (seconde chance, requêtes échouées non répétées), `JG_WIKIDATA = false`. Le niveau 2 est testé à travers un vrai serveur HTTPS local (les chaînes réelles ne sont pas joignables depuis le bac à sable). Les contrôles principaux ont été éprouvés par mutation (quinze variantes de la page volontairement cassées, quatorze détectées : retirer le filtre des requêtes déjà échouées ne change rien sous Chromium, qui garde en mémoire les images en échec) et ceux d'alignement en échec sur la version qui portait le défaut.

Adresses : 31 contrôles contre un géocodeur simulé (affichage en attente puis « ≈ », une requête aux coordonnées du garage, tooltip et lien Google, cache et expiration à 90 jours, adresses déjà dans OSM jamais redemandées, balises `addr:full` / `addr:place` / `contact:*` conservées par le cache, garage à 300 m refusé et refus mémorisé, échec réseau avec une seule nouvelle tentative, réponses sans `distance` ou sans géométrie, formulaire de réparation, contrôle technique, mobile, axe-core). Neuf variantes cassées volontairement, huit détectées (l'application du cache à la création des garages ne l'est que grâce à la liste de suggestions du formulaire ; retirer le rappel à l'ouverture de la fiche ne l'est pas, le rappel à la sélection faisant le même travail : les deux sont conservés).

Repères de prix, téléphones, messages, barre de défilement : 98 contrôles (clair/sombre, ordinateur/mobile/320 px) et 37 cas de lecture de numéros. Les médianes attendues sont recalculées dans le test à partir des prix lus sur la vue Prix et des réparations déclarées (positions des repères comprises), pas recopiées de la page ; la barre de défilement est jugée par différence d'image entre la page et la même page sans barre (rien ne doit être dessiné hors de la courbe, ni dans les 17 premiers et derniers pixels de la piste) ; 0 violation axe-core avec échelle et lignes de téléphone ouvertes (4 états) ; les 62 + 62 + 31 + 31 contrôles précédents passent toujours. Comparée à l'original, la page ne diffère que par les prix sans « dès », la distance en pastille (refonte), les liens `tel:` internationaux et l'échelle. Sur la version précédente, 51 des 77 contrôles applicables échouent. 25 variantes cassées volontairement (« dès » rétabli aux cinq endroits, `mobile` ignoré ou retiré de la liste des balises gardées, doublons conservés, libellé d'appel retiré, copie du mauvais numéro, repères mal placés ou écart de signe inversé, seuil de 5 % ignoré, messages OpenStreetMap rétablis, détails techniques dépliés, flèches rétablies, barre non rentrée, barre personnalisée sur écran tactile, propriétés standard dans Chromium, couleurs forcées) : 25 détectées, dont quatre seulement après avoir durci le test (une expression trop stricte, un jeu d'essai sans doublon visible, un seuil jamais exercé, un contrôle de couleurs forcées trop faible).

Chargement : 39 contrôles (ordinateur, mobile, clair/sombre, mouvement réduit, couleurs forcées). La position de la voiture est mesurée sur l'écran à 11 instants (animation arrêtée puis avancée) et comparée à la courbe attendue : rayon constant, sens inverse des aiguilles d'une montre, écart maximal inférieur à 5°, pause puis tour suivant ; le rond-point est centré sur l'épingle ; rien n'est dessiné ni animé hors recherche ; les couleurs calculées sont celles de la charte et rien d'autre (aucun rouge, bleu ou jaune dans le pictogramme) ; l'encart est visible sans défilement (ordinateur 900 px, mobile 844 px au-dessus de la navigation) ; fin de recherche, échec, adresse inconnue, contrôle technique et recherche rapide ; 0 violation axe-core pendant la recherche (4 états). Sur la version précédente, 18 des 26 contrôles applicables échouent. 23 variantes cassées volontairement (état jamais posé ou jamais retiré, pictogramme visible au repos, sens inversé, mauvais centre, tour trop rapide, carte ou encadré non masqués, phrase absente, lue par les lecteurs d'écran ou affichée sur les erreurs, pas de délai de 0,35 s, voiture rouge, pointillés jaunes, couleurs forcées, mouvement réduit ignoré…) : 23 détectées. Les séries précédentes (98 + 62 + 62 + 31 + 31 contrôles, axe-core sur 14 états, contrastes 150/150) passent toujours.

**À vérifier en conditions réelles** : le rendu du Plan IGN réel avec le filtre désaturant (testé avec des tuiles simulées), Safari / iOS, les API publiques en production, et **les logos d'enseignes eux-mêmes** : le bac à sable n'atteint ni Wikidata, ni Commons, ni les sites des enseignes. Les domaines officiels de `logoDom` ont été relevés par recherche web (les sites eux-mêmes sont bloqués depuis le bac à sable : aucune icône n'a pu être téléchargée ni vue). Quelles enseignes obtiennent un vrai logo (et lequel : un `favicon.ico` de 32 px peut être flou), si l'API de géocodage inverse renvoie bien `properties.name`, `postcode`, `city` et une géométrie (format relu de mémoire, jamais appelé pour de vrai), et si Safari ou Firefox mesurent un `.ico` multi-images comme Chromium, ne se sait que sur le réseau réel. Dans le doute, l'avatar reste un monogramme lisible.

Pour le chargement : le mouvement n'a pas pu être vu en direct (captures image par image, animation arrêtée à des instants précis) ni sous Safari et Firefox (rotation d'un groupe SVG par CSS, `transform-origin: 0 0` : conforme à la spécification, non essayé). Pour la série prix / téléphones / messages / barre : la **couverture réelle des numéros** dans OpenStreetMap près de chez vous (le bac à sable n'atteint pas Overpass : tout est testé sur des données simulées), le rendu de la barre de défilement sous **Windows** et **macOS / Safari**, et le comportement de la page quand les serveurs Overpass ne répondent pas depuis votre environnement (liste du registre SIRENE ou liste enregistrée, sans paragraphe d'explication).
