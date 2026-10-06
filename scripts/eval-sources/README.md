# Évaluation des sources de garages (branche `evaluation-sources`, hors production)

Mesure, sur un département, ce que donnent trois sources ouvertes en **téléphone, site, horaires et couverture**, avec le critère de
rapprochement de la page (`src/js/modules/mapbox-fiches.js` : même nom ET à 150 m ; garage sans nom : seul lieu à 40 m) :

| Source | Accès | Licence |
|---|---|---|
| Registre SIRENE | API `recherche-entreprises.api.gouv.fr` (NAF 45.20A/B, 45.32Z de réseau), comme la page | Licence Ouverte |
| OpenStreetMap | Overpass (sinon extrait Geofabrik), mêmes balises que la page | ODbL |
| Overture Maps, thème `places` | S3 public, lecture par plages d'octets des groupes de lignes qui touchent le département | CDLA Permissive 2.0 |

Le contour du département vient des divisions d'Overture (sous-type `county`) : le même pour les trois sources.

```
python scripts/eval-sources/test_eval.py                       # tests sans réseau (scénario synthétique)
python scripts/eval-sources/run.py --dept 31 --name Haute-Garonne
```

Dépendances : `pyarrow fsspec aiohttp shapely numpy osmium`. Le workflow `.github/workflows/eval-sources.yml` l'exécute à chaque
poussée de cette branche.

**Aucune donnée conservée.** Le rapport (sortie standard et résumé de l'étape) ne contient que des agrégats. Seules sortent, pour la jointure
avec le banc d'essai de Cazères, les lignes `CZ_OSM` : nom, position et présence de téléphone, site, horaires des garages OpenStreetMap du
disque de 10 km autour de Cazères (jamais un numéro, jamais une adresse web). Rien n'est écrit dans la base ni dans le dépôt.

Les réponses de Mapbox ne servent pas ici : leurs conditions interdisent de les conserver et d'interroger en masse.
