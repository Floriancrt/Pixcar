# Juste Garage — interface rafraîchie

Rafraîchissement de l'interface de Juste Garage, inspiré de la maquette « Package tracking » : rail d'icônes, panneau pastel « verre », carte plein écran, fiche sélectionnée dépliée et barre récapitulative flottante sur la carte.

| Fichier | Rôle |
| --- | --- |
| `index.html` | Version rafraîchie. Fichier unique et autonome : à ouvrir dans un navigateur (connexion requise pour les adresses, garages et tuiles). |
| `original.html` | Version d'origine, inchangée, pour comparaison ou retour arrière. |

> Ce dossier est indépendant du thème Shopify du dépôt : un thème Shopify ne contient que `assets/`, `config/`, `layout/`, `locales/`, `sections/`, `snippets/` et `templates/`, il n'est donc pas envoyé avec le thème.

## Ce qui change

- **Ordinateur (≥ 1024 px)** : rail d'icônes à gauche, panneau (recherche + liste) flottant sur une **carte persistante plein écran**. Cliquer une fiche ou un marqueur la **sélectionne** : contour indigo, fiche dépliée avec la frise « Votre adresse → garage », marqueur agrandi avec bulle noire, barre récapitulative sur la carte.
- **Mobile** : barre du haut + navigation flottante en bas ; bouton **Carte / Liste** ; carte plein écran avec barre récapitulative (« Voir la fiche » ramène à la fiche).
- **Fiches** : une seule fiche ouverte à la fois (accordéon), avatars (logo ou monogramme de l'enseigne, initiale pastel pour un indépendant), distance en pastille, statuts en pastilles à point, actions teintées, bouton noir « Déclarer une réparation ».
- **Style** : noir + pastels (indigo, rose, menthe), grands rayons, police *Plus Jakarta Sans* (remplace Barlow), thème sombre complet (préférence système, ou `data-theme="light|dark"` sur `<html>`).
- **Accessibilité** : lien d'évitement, titres ordonnés, cibles tactiles de 42 à 44 px (`pointer: coarse`), contrastes calculés y compris au pic des lueurs du fond (texte ≥ 4,5:1, bordures de champs ≥ 3:1), `prefers-reduced-motion`, `prefers-contrast`, `forced-colors`.

## Ce qui ne change pas

Recherche (IGN, OpenStreetMap, SIRENE, DGCCRF), prix et promotions des enseignes, calculs, textes, liens d'action, clés `localStorage` (`jg.*`) : les données affichées sont identiques à l'original.

## Avatars des enseignes

Les 26 enseignes de la page et les 8 réseaux de contrôle technique ont toujours un avatar « de marque » ; seuls les garages indépendants gardent l'initiale pastel. Trois niveaux, du meilleur au repli :

1. **Logo Wikidata.** Une seule requête à `query.wikidata.org` (icône `P8972`, sinon logo `P154`, hors logos périmés) pour les enseignes affichées, puis l'image depuis **Wikimedia Commons** (128 px). Seules les images de Commons sont acceptées.
2. **Icône du site de l'enseigne.** `/apple-touch-icon.png`, puis `/favicon.ico`, acceptée si elle fait **au moins 32 px** (pour un `.ico`, Chromium retient la plus grande image du fichier). Le site vient des données de la page (prix et promotions) avant celles de Wikidata (`P856`) ; un site Wikidata n'est admis que si les deux derniers libellés de son domaine portent le nom de l'enseigne (`norauto.fr`, `carter-cash.com` passent ; `norauto.exemple.org` non), en `https` seulement, sans IP ni `localhost`.
3. **Monogramme** (toujours présent, remplacé dès qu'un logo se charge) : initiales sur la couleur de la marque, texte blanc ou foncé selon le meilleur contraste (≥ 4,5:1 pour les 34). **Ces couleurs sont des teintes d'interface choisies de mémoire, pas les couleurs officielles** : à ajuster dans `logoBrand` / `ctBrand` si vous avez la charte.

Fonctionnement et limites :

- Les réponses sont gardées 30 jours (`localStorage`, clé `jg.logos.v2` ; l'ancienne `jg.logos.v1` est supprimée). Une icône qui a fonctionné est réessayée en premier. **Un échec n'est jamais mémorisé.**
- Seules les enseignes réellement affichées sont résolues, jamais plus.
- Le niveau 2 contacte **directement les sites des enseignes** : elles voient l'adresse IP et le navigateur du visiteur (et leurs cookies si le navigateur autorise les cookies tiers), pas la page d'origine (`no-referrer`). Pour s'en passer : `window.JG_SITE_ICONS = false` avant le script (reste Wikidata + monogrammes). Les requêtes sont toutes ignorées si `navigator.connection.saveData` est actif.
- Sans réseau, ou si rien n'est trouvé : monogramme, sans erreur.
- **Imposer un logo** (enseigne introuvable, logo officiel de meilleure qualité) : `window.JG_LOGOS = { norauto: "https://…/logo.png" }` avant le script (URL ou `data:`). Les identifiants sont ceux du tableau `l` du JS (`norauto`, `feuvert`, `speedy`, `midas`, `roady`, `euromaster`, `points`, …). Profil Plus, Siligom, Carter-Cash et Eurorepar n'ont ni identifiant Wikidata ni site dans les données de la page : sans surcharge, ils restent en monogramme.
- Diagnostic : `jgLogos()` dans la console liste, pour chaque enseigne, le logo Wikidata trouvé, le site utilisé et l'image affichée.
- Les logos sont des marques de leurs propriétaires ; les fichiers de Commons ont leurs propres licences.

## Maintenance

Le JS est celui de l'original (noms de variables minifiés), reformaté, avec des patchs ciblés :

| Fonction | Rôle |
| --- | --- |
| `bt()`, `av()`, `kd()` | gabarit de fiche, avatar (logo, monogramme ou initiale), libellé du type de garage |
| `logoLoad()`, `logoTry()`, `logoApply()`, `logoShow()`, `logoHostOk()` | résolution Wikidata → Commons puis icône du site, cache 30 jours, remplacement du monogramme par le logo ; `logoBrand` / `ctBrand` : monogrammes |
| `wt()`, `rb()` | détails de fiche, frise du trajet |
| `kt()`, `kc()` | accordéon ; compense le défilement quand une fiche au-dessus se referme (utile sur Safari) |
| `sl()`, `slMap()`, `mi()`, `sx()`, `bindTip()` | sélection liste ↔ carte, barre récapitulative, bulles |
| `St()` | bascule Liste / Carte sur mobile (classe `is-map` sur `<body>`) |
| `Et()` | carte : cadrage qui tient compte du panneau (`fo()`), marqueurs |
| `Zt()` | expose l'écran courant dans `body[data-screen]` |

- Le point de bascule **1024 px** doit rester identique dans le CSS (`@media (min-width: 1024px)`) et dans le JS (`ge()`).
- Couleurs des marqueurs lues par le JS : `--mk-priced`, `--mk-none`, `--mk-sel`, `--mk-user`, `--mk-ring`.
- Le fond de carte reste le Plan IGN, adouci par `--map-filter` (inversé en sombre).
- Le jaune vif de la marque ne subsiste que dans le logo et les étoiles (l'ambre pastel est réservé aux avertissements et à « Avis Google »).

## Vérifications effectuées

Tests automatisés (Chromium) contre des services simulés, sur l'original puis sur la nouvelle version : 26 contrôles communs et des données identiques (résumés, ordre, prix et liens des fiches, tri, filtres, rayon, contrôle technique, réparations, navigation), 36 contrôles propres à la nouvelle interface, 0 violation axe-core sur 14 états (clair/sombre, ordinateur/mobile), débordement et redimensionnement à chaud.

Avatars : 54 contrôles, dont les trois niveaux ensemble (logo Wikidata, icône du site après un 404 sur `apple-touch-icon.png`, `.ico` à plusieurs images, icône de 16 px refusée, fichier illisible, monogramme), les garde-fous (IP, `localhost`, sous-domaine trompeur, schéma, identifiants et port retirés), le cache v2 (rechargement sans nouvelle requête, expiration à 30 jours), Wikidata en panne, `JG_LOGOS`, `JG_SITE_ICONS = false`, économiseur de données, contrôle technique, contraste de chacun des 34 monogrammes et alignement des avatars (fiches, vue Prix, ordinateur et mobile). Le niveau 2 est testé à travers un vrai serveur HTTPS local (les chaînes réelles ne sont pas joignables depuis le bac à sable). Les contrôles principaux ont été éprouvés par mutation (neuf variantes de la page volontairement cassées, chacune détectée) et ceux d'alignement en échec sur la version qui portait le défaut.

**À vérifier en conditions réelles** : le rendu du Plan IGN réel avec le filtre adoucissant, Safari / iOS, les API publiques en production, et **les logos eux-mêmes** : le bac à sable n'atteint ni Wikidata, ni Commons, ni les sites des enseignes. Quelles enseignes obtiennent un vrai logo (et lequel : un `favicon.ico` de 32 px peut être flou), et si Safari ou Firefox mesurent un `.ico` multi-images comme Chromium, ne se sait que sur le réseau réel. Dans le doute, l'avatar reste un monogramme lisible.
