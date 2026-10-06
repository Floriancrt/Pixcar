# Évaluation des sources de garages — Haute-Garonne, 6 octobre 2026

Branche d'essai `evaluation-sources`, hors production. Les journaux des exécutions GitHub Actions expirent ; ce fichier garde les chiffres.
Méthode et code : `scripts/eval-sources/` (tests sans réseau : 88 contrôles). Exécutions : [1](https://github.com/Floriancrt/Pixcar/actions/runs/37429792197),
[2](https://github.com/Floriancrt/Pixcar/actions/runs/37430690400), [3](https://github.com/Floriancrt/Pixcar/actions/runs/37431298891) (la dernière contient tout).

Question : que donnent le registre SIRENE, OpenStreetMap et Overture en téléphone, site, horaires et couverture, comparés aux 97 % de Mapbox, pour décider
entre une table de garages à nous et la seule complétion des fiches par Mapbox ?

## Sources et règles

- **Overture Maps**, thème `places`, version `2026-09-23.1`, lu sur S3 par plages d'octets : lieux de la hiérarchie « automotive_service / vehicle_service » dans le
  contour du département (contour d'Overture, sous-type `county`). « Cœur » = `automotive_repair`, `tire_dealer_and_repair`, `auto_body_shop`, `auto_glass_service`.
- **OpenStreetMap** : Overpass (miroir `overpass.openstreetmap.fr` ; `overpass-api.de` a répondu 504 deux fois), mêmes balises que la page (`shop=car_repair|tyres`,
  `craft=car_repair`, extensions par nom, prestations ou réseau).
- **SIRENE** : API `recherche-entreprises` (`/search?departement=31`, NAF 45.20A, 45.20B, 45.32Z de réseau), établissements actifs avec position, comme la page.
- **Rapprochement** : celui de la page (`mapbox-fiches.js`) : même nom ET 150 m ; garage sans nom : seul lieu à 40 m. Port Python vérifié identique au JavaScript
  sur 722 500 paires de noms. Variantes mesurées : 300 m ; nom OU adresse (même numéro dans la même voie) ; proximité sans condition de nom.

## Ce que contient chaque source (Haute-Garonne)

| Source | Garages | Téléphone | Site | Horaires |
|---|---:|---:|---:|---:|
| OpenStreetMap (liste de la page) | 370 | 188 (51 %) | 130 (35 %) | 158 (43 %) |
| Overture (cœur) | 1 079 | 936 (87 %) | 880 (82 %) | aucun |
| Registre SIRENE | 1 941 | 0 | 0 | aucun |
| Mapbox, Cazères 10 km, banc du 5 octobre (une zone, n = 34) | 34 | 33 (97 %) | 22 (65 %) | 31 (91 %) |

Overture : 695 lieux d'origine `meta`, 236 `Foursquare`, 132 `AllThePlaces` (réseaux : aucun téléphone, 66 % de sites), 16 `DAC`. Sites : 98 % sur un domaine propre.
Téléphones : 18 % de mobiles seulement (4 % pour OpenStreetMap). Confiance < 0,5 : 141 lieux (13 %). Contrôle technique (66 lieux, à part) : téléphone 2 %, site 100 %.
SIRENE : 14 % des établissements ont une enseigne ; 782 (40 %) sont des entrepreneurs individuels.

## Recouvrement

| Garages de ↓ trouvés dans → (nom + 150 m) | OpenStreetMap | Overture | SIRENE |
|---|---:|---:|---:|
| OpenStreetMap (370) | — | 180 (49 %) | 154 (42 %) |
| Overture (1 079) | 170 (16 %) | — | 319 (30 %) |
| SIRENE (1 941) | 144 (7 %) | 315 (16 %) | — |

Ce que l'exigence d'un nom commun cache (SIRENE → Overture) : 20 % trouvent un équivalent dans OpenStreetMap ou Overture avec le nom, 26 % avec nom ou adresse ;
sans aucune condition de nom, 15 % ont un garage d'Overture à moins de 25 m, 23 % à moins de 50 m, 33 % à moins de 100 m (OpenStreetMap : 9, 13, 16 %).
Entrepreneurs individuels : 5 % trouvent un équivalent (7 % avec l'adresse) ; sociétés : 30 % (38 %) ; avec enseigne : 38 % (47 %).
**Entre 74 % (nom ou adresse) et 80 % (nom) des établissements du registre n'ont aucun équivalent dans OpenStreetMap ni Overture : aucune source ouverte ne leur donne de téléphone.**

## Garages réunis (nom + 150 m)

| Présent dans | Garages | Téléphone | Site | Horaires |
|---|---:|---:|---:|---:|
| OSM + Overture + SIRENE | 86 | 81 | 76 | 43 |
| OSM + Overture | 90 | 89 | 89 | 57 |
| OSM + SIRENE | 70 | 36 | 12 | 23 |
| Overture + SIRENE | 227 | 197 | 173 | 0 |
| OSM seul | 117 | 46 | 30 | 31 |
| Overture seul | 657 | 573 | 530 | 0 |
| SIRENE seul | 1 551 | 0 | 0 | 0 |
| **Total** | **2 798** | 1 022 | 910 | 154 |

OpenStreetMap ∪ Overture : **1 247 garages, 1 022 avec téléphone (82 %), 910 avec site (73 %), 154 avec horaires (12 %)**, contre 370 garages, 188 avec téléphone
aujourd'hui (la liste par défaut de la page est celle d'OpenStreetMap : le registre est une option décochée). Avec nom ou adresse : 1 168 garages, 969 avec téléphone.
Overture seul = 657 garages (547 avec l'adresse) dont 573 avec téléphone ; 69 % ont une confiance ≥ 0,7.
Apport aux fiches OpenStreetMap sans téléphone (182) : 67 (37 %) en trouvent un dans Overture ; sans site (240) : 81 (34 %) ; horaires : 0.
Zones : Toulouse ≤ 12 km, 214 garages OpenStreetMap contre 541 Overture ; couronne 12–30 km, 88 contre 356 ; au-delà, 68 contre 182.

## Qualité

- Téléphones identiques entre OpenStreetMap et Overture : 80 sur 89 paires comparables (90 %) ; confiance ≥ 0,7 : 76 sur 84 ; `meta` : 49 sur 56 ; `Foursquare` : 16 sur 18.
  Sites sur le même domaine : 67 sur 87 (77 %).
- Doublons internes : Overture 72 (7 %), OpenStreetMap 12, SIRENE 65. Numéros partagés par au moins trois lieux (standard de réseau) : Overture 39.
- Lieux disparus (borne basse : même nom à 150 m qu'un établissement fermé du registre, et aucun actif) : OpenStreetMap 27 sur 370 (7 %) ; Overture 98 sur 1 079 (9 %) ;
  `meta` 58 sur 695 (8 %) ; `Foursquare` 35 sur 236 (15 %). Le registre sert donc aussi de filtre à la construction d'une table.

## Cazères, disque de 10 km (comparaison à quatre sources, jointure locale avec le banc ; non versionnée)

| | Garages | Téléphone | Site | Horaires |
|---|---:|---:|---:|---:|
| OpenStreetMap (liste par défaut) | 9 | 5 | 4 | 2 |
| + complétion par Overture | 9 | 7 | 6 | 2 |
| + complétion par Mapbox | 9 | 7 | 6 | 4 |
| Table OpenStreetMap ∪ Overture | 24 | 19 (79 %) | 18 (75 %) | 2 |
| Mapbox seul, pour mémoire (liste impossible : conditions et coût) | 34 | 33 | 22 | 31 |

Mapbox connaît 8 des 24 garages de la table : il y ajouterait des horaires pour 7 d'entre eux et aucun téléphone.
Liste OpenStreetMap ∪ registre (46) : téléphone 5 (11 %) ; avec Overture 10 (22 %) ; avec Mapbox 19 (41 %) ; avec les deux 20 (43 %) ; 26 garages (57 %) restent sans téléphone ni site.
Mapbox ∩ OpenStreetMap : 3 des 9 garages d'OpenStreetMap sont dans Mapbox (33 %), 3 des 34 de Mapbox sont dans OpenStreetMap (9 %).

## Limites

- Un seul département (Toulouse pèse beaucoup) ; Mapbox n'est mesuré que sur une zone et 34 garages (interdit d'interroger en masse et de conserver ses résultats).
- Le rapprochement par le nom sous-estime le recouvrement pour le registre (raison sociale ≠ enseigne) ; l'adresse et la proximité en donnent une fourchette.
- Aucune vérification par appel téléphonique : la concordance avec OpenStreetMap et la comparaison au registre fermé sont des indices, pas une preuve.
- Les 3 exécutions donnent les mêmes chiffres de base (OpenStreetMap 370, Overture 1 079, SIRENE 1 941) : lecture reproductible à la date du 6 octobre 2026.
- À vérifier avant toute construction : licence et attribution d'Overture (CDLA Permissive 2.0 annoncée), part de redistribution de la licence ODbL si OpenStreetMap
  est copié dans une table publiée, données personnelles (téléphones d'entrepreneurs, établissements du registre en entreprise individuelle).
