# Interface

Ce que voit et fait le visiteur, et les choix de présentation. Le fonctionnement interne (données, API, disponibilité) est dans [architecture.md](architecture.md), la mise en ligne dans [exploitation.md](exploitation.md), les vérifications dans [tests.md](tests.md).

## Navigation et réparations déclarées

- **Deux vues** : « Garages » (recherche, liste, carte) et « Prix et promos ». **L'onglet « Mes réparations » n'existe plus** : sans compte ni session il n'y avait rien à y gérer, et une réparation déclarée met directement à jour l'onglet « Garages » (échelle de prix, note et historique de la fiche du garage, médianes, marqueurs).
- **Déclarer** : bouton « Déclarer une réparation ». La fenêtre demande le garage, le véhicule (modèle, immatriculation, année), la prestation, le prix, la date, la note et un commentaire facultatif. À l'enregistrement, un message « Réparation enregistrée : … » propose **Annuler**, qui retire aussitôt la réparation.
- **Retirer plus tard** : dans l'historique de la fiche d'un garage, chaque ligne déclarée **depuis ce navigateur** a un bouton **Supprimer** (suivi d'un message avec **Annuler** pour la remettre). Les lignes des autres visiteurs n'en ont pas. Ce droit repose sur un jeton secret gardé dans le navigateur, pas sur un compte : vider les données du site ou changer d'appareil le fait perdre (la ligne reste alors en base ; l'effacement à la demande est décrit dans `exploitation.md`).
- **Sans API** (la page ouverte telle quelle, ou construite sans `PIXCAR_API_BASE`) : les réparations restent dans le navigateur (`jg.repairs.v1`) et ne complètent que l'échelle de prix de ce navigateur. La fenêtre le dit.
- **Avec l'API** : la déclaration est partagée, et la fiche d'un garage montre aussi ce que les autres ont déclaré autour de l'adresse cherchée. La fenêtre dit ce qui est publié (prix, mois, modèle, année, note) et ce qui ne l'est jamais (nom, commentaire, immatriculation).
- **Étiquettes d'état** sur vos lignes, avec l'API seulement : « En attente d'envoi » (hors ligne ou API qui ne répond pas : l'envoi est retenté tout seul), « Gardée sur cet appareil » (déclarée avant l'API, refusée par le serveur ou abandonnée au bout de 7 jours), « En relecture avant publication » (prix très éloigné de ceux des autres : visible de vous, pas des autres tant qu'elle n'est pas relue).
- **Encart sous le récapitulatif** : « Les réparations déclarées par les automobilistes sont momentanément indisponibles… » (API en panne et aucune copie), « … la dernière copie enregistrée sur cet appareil est affichée » (API en panne, copie de moins de 7 jours), « N réparations en attente d'envoi… ».
- **Messages** : réparation déjà déclarée (comptée une fois), refusée par le serveur (elle reste sur l'appareil), abandonnée après une semaine.

## Ce qui a changé dans l'interface (refonte)

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

Recherche (IGN, OpenStreetMap, SIRENE, DGCCRF), prix et promotions des enseignes, calculs, liens d'action, clés `localStorage` (`jg.*`) : les données affichées sont identiques à l'original. Ne changent que la présentation et les textes ou liens décrits ci-dessous : plus de « dès » devant les prix, repères de médiane dans l'échelle de prix, téléphones lus et affichés autrement (les liens `tel:` sont désormais internationaux, `tel:+33472000007` au lieu de `tel:0472000007`), messages OpenStreetMap retirés. Le formulaire « Déclarer une réparation » change aussi : immatriculation et année du modèle en plus, suggestions de modèles (voir « Véhicule » plus bas) ; les déclarations gardent la clé `jg.repairs.v1` avec deux champs de plus (`immat`, `year`) et les anciennes restent lisibles.

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

OpenStreetMap n'a pas toujours l'adresse d'un garage (beaucoup de Speedy, par exemple). Quand la rue manque, la page demande à la **Base Adresse Nationale** (géocodeur inverse de la Géoplateforme IGN, déjà utilisé pour la recherche d'adresse) l'adresse la plus proche de la position du garage, **à l'ouverture de sa fiche ou à sa sélection** (une requête par garage, jamais pour toute la liste ; la seule autre demande de ce genre est celle de la commune pour la puce distance, voir la section suivante, qui partage la même requête et le même cache) :

- affichée précédée de **« ≈ »** (« Environ » pour les lecteurs d'écran) avec une infobulle « adresse la plus proche de la position du garage (à 14 m), à titre indicatif » : c'est une approximation, pas l'adresse déclarée ;
- **refusée au-delà de 80 m** (distance recalculée à partir de la géométrie renvoyée, la propriété `distance` n'étant qu'un repli) : le garage garde « Adresse non renseignée » ;
- gardée **90 jours** (`jg.addr.v1`, 400 entrées au plus) ; un refus, 7 jours ; un échec réseau n'est jamais mémorisé (une nouvelle tentative à l'ouverture suivante, puis plus) ;
- reprise partout : fiche, frise du trajet, bulle de la carte, lien « Avis Google » (le nom + l'adresse précisent la recherche), liste de suggestions et confirmation du formulaire « Déclarer une réparation » (l'adresse enregistrée garde le « ≈ ») ;
- OpenStreetMap lui-même est mieux lu : `addr:full`, `addr:place`, `addr:suburb` et `contact:*` complètent `addr:*` (cache OSM passé en `jg.osm.v3` pour que ces balises soient conservées) ;
- sans effet sur le contrôle technique et le registre SIRENE, dont l'adresse vient des données.

## Ville dans la puce distance

La puce distance de chaque carte dit où se trouve le garage : **« (épingle) 2,5 km · Bron »** (les lecteurs d'écran entendent « à 2,5 km, Bron »). La ville vient, dans cet ordre :

1. **la balise OpenStreetMap** : `addr:city`, `contact:city`, sinon `addr:suburb` (le quartier vaut mieux que rien) ;
2. **l'adresse déjà connue** : ce qui suit le dernier code postal (« 12 rue X, 69100 Villeurbanne » → « Villeurbanne ») ; vaut pour `addr:full`, le contrôle technique, le registre SIRENE et l'adresse approchée ci-dessus ;
3. **pour un garage qui n'a ni l'un ni l'autre** (beaucoup de Speedy) : la **commune de l'adresse la plus proche**, demandée à la Base Adresse Nationale (celle de la section précédente : même requête `reverse?limit=1`, même cache `jg.addr.v1`, où l'entrée garde la commune dans le champ `c`).

Règles de la demande (étape 3) :

- **seulement pour les cartes qui entrent à l'écran** (`IntersectionObserver`, marge de 160 px), pas pour toute la liste : un lecteur qui descend la liste voit les villes arriver une à une ; une liste parcourue d'un bond n'interroge pas les cartes sautées. Sans `IntersectionObserver`, les 12 premières cartes ;
- **3 demandes à la fois**, 80 ms entre deux, **300 par visite** au plus ; une carte déjà servie par le cache (90 jours si l'adresse a été acceptée, sinon 7 jours) ne redemande rien, et une commune en cache sert même périmée (elle ne change pas) ;
- **refusée au-delà de 250 m** de l'adresse la plus proche (l'adresse elle-même reste refusée au-delà de 80 m : une réponse à 200 m donne la commune mais pas l'adresse). Si la réponse n'a pas de propriété `city`, la commune est lue dans son `label` ;
- **échec réseau** : une nouvelle tentative au plus par garage ; **4 échecs de suite arrêtent les demandes pendant une minute** (réglage `cityPause` de `window.JG_TUNE`), puis un nouvel affichage de la liste reprend ; un échec n'est jamais mémorisé ;
- **ouvrir une fiche pendant que sa demande court** rejoint la même requête (une seule par garage) ; la fiche montre alors l'adresse « ≈ » et la puce la commune ;
- interrupteur : `window.JG_CITY_LOOKUP = false` (plus aucune demande ; la puce montre la commune quand elle est dans les données ou dans l'adresse d'une fiche ouverte).

Mise en forme (`modules/city.js`, testée sans navigateur par `tests/city_unit.js`) : un nom tout en majuscules est remis en casse de titre avec ses particules (« SAINT-GENIS-LAVAL » → « Saint-Genis-Laval », « VILLEFRANCHE-SUR-SAONE » → « Villefranche-sur-Saone » : les accents manquants dans la source ne sont pas devinés), « Cedex » est retiré, un arrondissement s'écrit « 3e » / « 1er » (« LYON 3EME », « Lyon 03 » → « Lyon 3e »). Un texte déjà en minuscules reste tel quel.

Mise en page : la ville s'abrège avec « … » sur un écran étroit au lieu de déborder de la carte (`.g-id` a une colonne `minmax(0, 1fr)` ; `.dist` a `min-width: 0`, `.d-city` `overflow: hidden; text-overflow: ellipsis`). Sur un téléphone de 390 px il reste ~170 px à la colonne du nom : « Saint-Genis-Laval » y est écourté, « Villeurbanne » non.

Limite : la commune de l'adresse la plus proche peut différer de celle du garage quand il se trouve à cheval sur une limite communale. Le format réel de la réponse du géocodeur (`city`, `label`) n'a pas pu être vérifié depuis le bac à sable (hôte bloqué) : voir `exploitation.md`.

## Repères de prix

L'**échelle de prix** (fiche d'un garage chez qui des réparations ont été déclarées) repère deux médianes, écrites en toutes lettres et chiffrées :

- **Médiane des enseignes** (▼ au-dessus de la barre) : médiane des prix nationaux de la prestation, hors « pièces en plus » ;
- **Médiane de ce garage** (▲ sous la barre) : médiane des réparations déclarées chez ce garage pour cette prestation (les vôtres et, avec l'API, celles des autres visiteurs) ;
- une pastille donne l'écart : « 18 % sous les enseignes » (vert), « 42 % au-dessus des enseignes » (ambre), « Au niveau des enseignes » en dessous de 5 % d'écart ;
- les points de la barre sont les réparations déclarées chez ce garage (infobulle : prix, modèle, mois) ; sans prix d'enseigne pour la prestation (révision, batterie…), seule la médiane du garage est repérée ;
- les médianes sont du texte (lisible sans la barre, qui reste décorative) ; en couleurs forcées les repères prennent `CanvasText` / `Highlight`.

**« dès » est retiré de tous les prix** (cartes, ligne de synthèse, bulle et barre de la carte, note de la fiche, vue Prix et promos). Conservé volontairement : les libellés des offres tels que les enseignes les publient (« vidange dès 49,95 € », « Montage dès 9,95 € »), où le mot décrit la condition de l'offre, et la mention « à partir de » une fois (sous-titre de la vue Prix, encadré « les repères » du formulaire). `from: true` reste dans les données, donc rétablir le mot est une ligne par endroit (`${n.from ? … : ""}`) ; les cinq endroits sont ceux des mutations « dès back … » de `tests/mutation/mut_ux.py`.

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

## Véhicule : immatriculation, modèle, année

La fenêtre « Déclarer une réparation » demande le véhicule en trois champs, entre le garage et la prestation. Les trois sont **obligatoires**.

- **Modèle du véhicule** : champ à suggestions (il remplace la liste du navigateur, 208 noms). Le catalogue compte **917 modèles de 65 marques** : voitures courantes en France, anciennes comprises, utilitaires, électriques, voitures sans permis, quelques marques de luxe. On tape « 208 », « clio », « citroen c3 », « vw golf », « chr » : sans accents ni majuscules, la marque peut manquer, « vw » et « Mercedes-Benz » sont compris, « chr » trouve « C-HR ». Classement : nom exact, nom suivi d'autres mots, début de nom, mots commençant par la saisie, saisie contenue dans le nom ; à égalité, marques et modèles les plus courants d'abord. Les modèles déjà déclarés passent devant (« déjà déclaré »). Champ vide (clic ou ↓) : les modèles déjà déclarés puis douze modèles très répandus. Douze suggestions au plus ; au clavier ↓ ↑ pour parcourir, Entrée pour choisir l'option active (sinon elle passe au champ suivant, comme pour le garage), Échap pour fermer la liste (pas la fenêtre). Un modèle absent se saisit tel quel ; la normalisation d'origine `J()` le met en forme à la sortie du champ (« clio 4 » devient « Renault Clio 4 »).
  Le catalogue est la constante `CARS` du script, une ligne par marque (« Marque: modèle, modèle… ») ; la liste des noms `b`, les marques `O` et donc `J()` en sont déduits. **Il est écrit de mémoire, ce n'est pas une base officielle** : des oublis ou des erreurs sont possibles, à relire. Les 208 noms de l'ancienne liste y sont tous, orthographiés pareil (des déclarations enregistrées les citent). Un nom de modèle d'un seul caractère (« e », « 3 », « #1 ») ne suffit plus à deviner la marque quand on le tape seul.
- **Immatriculation** : format SIV, 2 lettres, 3 chiffres, 2 lettres (`EZ-108-BC`). Le champ se met en forme à la saisie : capitales, tirets posés tout seuls (« ez108bc » devient « EZ-108-BC » ; un tiret n'apparaît qu'avec le caractère qui le suit, sinon Retour arrière resterait bloqué), espaces, points, barres et tirets typographiques acceptés au collage. Un caractère qui n'a pas sa place (un chiffre là où une lettre est attendue, un 8e caractère, une lettre accentuée) est **refusé, avec un rappel du format** affiché sous le champ et annoncé aux lecteurs d'écran (une frappe ignorée ne se voit pas). Un séparateur saisi fait passer au groupe suivant : on corrige un chiffre au milieu (« EZ-18-BC ») sans que « BC » soit expulsé. À l'envoi, seule une plaque complète passe (« Immatriculation incomplète. Format attendu : AB-123-CD (2 lettres, 3 chiffres, 2 lettres). »). Toutes les lettres sont acceptées, I, O et U comprises (je crois qu'elles ne sont pas attribuées dans le SIV, mais le champ ne le vérifie pas), de même que « 000 ».
- **Année du modèle** : 4 chiffres (le reste est retiré, collage compris), entre 1950 et l'année en cours, **jamais postérieure à la date de la réparation**. Aide affichée : « Année de 1re mise en circulation (carte grise, case B) ». Corriger la date de la réparation remet à jour le message de l'année, s'il y en avait un.

**Données.** Chaque déclaration enregistre `immat` (« EZ-108-BC ») et `year` (nombre) en plus de `model`, dans la même clé `jg.repairs.v1`. Les déclarations déjà enregistrées restent valides sans ces champs ; à la lecture, une immatriculation ou une année invalide (modifiée à la main dans le stockage, par exemple) est supprimée et jamais affichée. L'ancien champ `plate` et sa migration sont inchangés, d'où le nom `immat`. À l'ouverture, le formulaire reprend le dernier véhicule déclaré (immatriculation, modèle, année), gardé à part dans `jg.vehicles.v1` (cinq au plus) : il survit à « Annuler » et à « Supprimer ». Les deux colonnes de la fenêtre (plaque / année, prix / date) restent alignées en haut quand un champ affiche une erreur (le prix et la date se décalaient avant).

**Affichage.** Dans la fiche d'un garage (historique, info-bulle de l'échelle de prix) : « Peugeot 208 · 2019 », **jamais l'immatriculation**, ni la vôtre ni celle des autres ; les phrases qui décrivent l'historique (dans la fiche et dans « Sources et méthode ») le disent : « Les commentaires et l'immatriculation n'y figurent jamais ».

**Limites, à vérifier avant d'aller plus loin**

- **Une plaque obligatoire au format SIV refuse les véhicules dont la plaque date d'avant avril 2009** (« 1234 AB 56 », « 123 ABC 45 »), qui roulent toujours. Je ne suis pas sûr de tous les cas où un véhicule ancien reçoit un nouveau numéro : à vérifier sur service-public.fr. Si ces véhicules doivent pouvoir être déclarés : rendre le champ facultatif, ou accepter l'ancien format (motif `PLATE_RE` et `plateMask()`).
- **L'immatriculation est une donnée personnelle** (elle permet de remonter au titulaire). Sans API, elle reste dans le navigateur. Avec l'API, elle est envoyée pour repérer les doublons mais n'est conservée que sous forme d'empreinte (HMAC-SHA256 avec un secret du serveur) : ni stockée en clair, ni affichée, ni renvoyée par l'API. Une empreinte reste une donnée personnelle au sens du RGPD (pseudonymisée, pas anonymisée) : base légale, durée de conservation, information des visiteurs et effacement à la demande (`moderate.mjs forget`, voir `exploitation.md`) sont à définir. **À faire valider avant publication.**
- « Case B de la carte grise » : date de première immatriculation, d'après mes souvenirs du certificat d'immatriculation, à vérifier sur un exemplaire. « Année du modèle » est comprise comme cette année-là ; un millésime de l'année suivante est refusé.
- Claviers de téléphone : le masque réécrit la valeur à chaque frappe (il attend la fin d'une composition de clavier). Essayé seulement dans Chromium, pas sur un vrai téléphone (Gboard, claviers Samsung, iOS).

## Confidentialité et mentions légales

Une fenêtre (`<dialog>`, même habillage que le formulaire de déclaration) dit qui édite Pixcar, où le site est hébergé, ce qui est enregistré et combien de temps, les services que le navigateur contacte et les droits des visiteurs. Un lien « Confidentialité et mentions légales » figure en bas du panneau « Garages » (dès le premier écran), un autre dans « Sources et méthode », un troisième sous la note du formulaire de déclaration (**mode API seulement**). Celui du panneau est masqué dans le HTML et montré par le script deux images après son démarrage : le panneau se remplit au démarrage (jusqu'à 144 px de plus sur un téléphone de 390 px) et le lien, déjà visible, descendait avec lui, ce qui doublait le décalage de mise en page mesuré (0,0103 au lieu de 0,0046 ; test `prerender`, P6) ; sans script il n'apparaît pas, mais il n'ouvrirait rien non plus. Les passages propres à un mode (`data-store-only`) ne s'affichent que dans ce mode : en mode local, la fenêtre dit que les réparations restent dans le navigateur et ne parle ni de base ni de durées ; sa section « Vos droits » y dit que Pixcar ne reçoit aucune donnée (rien à consulter ni à effacer chez lui) et ne promet ni réponse sous un mois ni recherche par immatriculation. Elle s'ouvre par-dessus le formulaire sans le fermer ; Échap, le bouton « Fermer », le × et un clic sur le fond la ferment, et le focus revient au lien. Source : `src/partials/legal.html` ; code : `src/js/modules/legal.js` ; informations de l'éditeur : `src/legal.json`. Tant que ce fichier est incomplet, **ni la fenêtre ni ses liens ne sont dans la page** et le build avec l'API échoue (`docs/exploitation.md`, section 6).

## Maintenance du JS

`src/js/app.js` est le script d'origine (noms de variables minifiés), reformaté et modifié à la main. Autour de lui, des modules ES : `modules/repair-store.js` (réparations : local ou API, file d'envoi), `modules/api-client.js` (HTTP : délai, nouvelles tentatives, disjoncteur), `modules/phone.js` (lecture des numéros), `modules/city.js` (mise en forme et lecture de la ville), `modules/config.js` (adresse de l'API), `modules/load-script.js` (Leaflet local puis CDN de secours), `modules/sw-register.js`. Le dossier `shared/` (règles de validation, prestations, requête Overpass) est **partagé avec l'API** : une seule source, importée par la page et par le serveur. Le catalogue des modèles est `src/data/models.txt`. Après toute modification : `npm run build` (voir README).

| Fonction | Rôle |
| --- | --- |
| `bt()`, `av()`, `kd()` | gabarit de fiche, avatar (logo, monogramme ou initiale), libellé du type de garage |
| `logoLoad()`, `logoTry()`, `logoApply()`, `logoShow()`, `logoHostOk()` | résolution Wikidata → Commons puis icône du site, cache 30 jours, remplacement du monogramme par le logo ; `logoBrand` / `ctBrand` : monogrammes |
| `adEnsure()`, `adFetch()`, `adRepaint()`, `adInit()` | adresses manquantes : requête BAN, cache, mise à jour de la fiche, de la bulle et du lien Google |
| `cityOf()`, `distHtml()`, `cityRepaint()`, `cityWatch()`, `cityPump()`, `cityHalted()` | ville de la puce distance : source (balise, adresse, cache), rendu, mise à jour d'une puce, mise en file des cartes à l'écran, 3 demandes à la fois, disjoncteur ; `cityTidy()` et `cityFromAddr()` sont dans `modules/city.js` |
| `ct()`, `dt()` | `ct()` : état « recherche en cours » (bouton, `body.is-searching`) ; `dt()` : encart d'état, avec la phrase d'attente pendant une recherche |
| `wt()`, `rb()` | détails de fiche (lignes Téléphone / Horaires / Site), frise du trajet |
| `it()` | échelle de prix : médiane des enseignes (▼), médiane du garage (▲), écart |
| `vt()` | premier numéro d'un garage (`phoneParse()` et `phoneList()` sont dans `modules/phone.js`) |
| `kt()`, `kc()` | accordéon ; compense le défilement quand une fiche au-dessus se referme (utile sur Safari) |
| `sl()`, `slMap()`, `mi()`, `sx()`, `bindTip()` | sélection liste ↔ carte, barre récapitulative, bulles |
| `St()` | bascule Liste / Carte sur mobile (classe `is-map` sur `<body>`) |
| `Et()` | carte : cadrage qui tient compte du panneau (`fo()`), marqueurs |
| `Zt()` | expose l'écran courant dans `body[data-screen]` |
| `plateMask()`, `plateInput()`, `yearMsg()`, `vehLabel()`, `vehPrefill()` | immatriculation (masque, caret, rappel du format), année, libellé « modèle · année », reprise du dernier véhicule |
| `mdlFind()`, `mdlShow()`, `mdlMove()`, `mdlPick()`, `wireVehicle()` | suggestions de modèles : classement, liste, flèches, choix ; `CARS` : catalogue |
| `nt()`, `rt()`, `st()` | rattachement d'une réparation à un garage (par identifiant pour celles des autres visiteurs), réparations d'un garage, prix déclaré |
| `renderRepairNote()`, `storeNotice()`, `refreshRowState()`, `unrepair()`, `stateLabel()` | encart d'état des réparations, messages du magasin, étiquette d'envoi d'une ligne, « Annuler » / « Supprimer » |

- Le point de bascule **1024 px** doit rester identique dans le CSS (`@media (min-width: 1024px)`) et dans le JS (`ge()`).
- Couleurs des marqueurs lues par le JS : `--mk-priced`, `--mk-none`, `--mk-sel`, `--mk-user`, `--mk-user-ring`, `--mk-ring`.
- Le fond de carte reste le Plan IGN, adouci par `--map-filter` (inversé en sombre).
- L'ambre (jaune doux) est réservé aux avertissements et à « Avis Google » ; les étoiles gardent leur jaune.
- La page est servie avec une politique de sécurité du contenu **sans script ni style en ligne** (hors la feuille de style signée par empreinte) : ne pas ajouter de `<script>` en ligne ni d'`eval`. `tests/budget.js` le vérifie.
