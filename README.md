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
- **Fiches** : une seule fiche ouverte à la fois (accordéon), avatars pastel, distance en pastille, statuts en pastilles à point, actions teintées, bouton noir « Déclarer une réparation ».
- **Style** : noir + pastels (indigo, rose, menthe), grands rayons, police *Plus Jakarta Sans* (remplace Barlow), thème sombre complet (préférence système, ou `data-theme="light|dark"` sur `<html>`).
- **Accessibilité** : lien d'évitement, titres ordonnés, cibles tactiles de 42 à 44 px (`pointer: coarse`), contrastes calculés y compris au pic des lueurs du fond (texte ≥ 4,5:1, bordures de champs ≥ 3:1), `prefers-reduced-motion`, `prefers-contrast`, `forced-colors`.

## Ce qui ne change pas

Recherche (IGN, OpenStreetMap, SIRENE, DGCCRF), prix et promotions des enseignes, calculs, textes, liens d'action, clés `localStorage` (`jg.*`) : les données affichées sont identiques à l'original.

## Maintenance

Le JS est celui de l'original (noms de variables minifiés), reformaté, avec des patchs ciblés :

| Fonction | Rôle |
| --- | --- |
| `bt()`, `av()`, `kd()` | gabarit de fiche, avatar pastel, libellé du type de garage |
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

**À vérifier en conditions réelles** : le rendu du Plan IGN réel avec le filtre adoucissant, Safari / iOS, les API publiques en production.
