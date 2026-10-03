-- Pixcar : réparations déclarées par les visiteurs (aucun compte, aucune session).
-- Valide sur PostgreSQL 14 ou plus ET sur Amazon Aurora DSQL (server/migrate.mjs adapte la syntaxe à DSQL : « CREATE INDEX ASYNC »,
-- « IF NOT EXISTS », pas de DESC dans les index, une instruction de structure par transaction). Les contraintes CHECK sont la
-- dernière ligne de défense : l'API valide déjà tout.
-- Les empreintes (plaque, adresse IP, jeton) sont stockées en TEXTE hexadécimal de 64 caractères et non en bytea : DSQL ne sait pas
-- indexer bytea, et l'empreinte de la plaque porte l'index qui interdit les doublons.

CREATE TABLE garages (
  id         text PRIMARY KEY CHECK (char_length(id) BETWEEN 3 AND 120),   -- osm:node/123 · siret:12345678901234 · custom:slug
  name       text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  addr       text NOT NULL DEFAULT '' CHECK (char_length(addr) <= 200),
  lat        double precision CHECK (lat BETWEEN -90 AND 90),              -- position du garage, inconnue pour un nom saisi à la main
  lon        double precision CHECK (lon BETWEEN -180 AND 180),
  chain_id   text NOT NULL DEFAULT '' CHECK (char_length(chain_id) <= 40),
  area_y     integer NOT NULL,                                             -- case de 0,05° (≈ 5 km) du garage, ou du point de
  area_x     integer NOT NULL,                                             -- recherche quand sa position est inconnue
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX garages_area_idx ON garages (area_y, area_x);

CREATE TABLE repairs (
  id                uuid PRIMARY KEY,                                      -- choisi par le navigateur : renvoyer la même déclaration est sans effet
  garage_id         text NOT NULL REFERENCES garages (id) ON DELETE CASCADE,
  service_id        text NOT NULL CHECK (char_length(service_id) BETWEEN 2 AND 40),
  price_cents       integer NOT NULL CHECK (price_cents BETWEEN 100 AND 2000000),
  repaired_on       date NOT NULL CHECK (repaired_on >= DATE '1990-01-01'),
  rating            smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment           text NOT NULL DEFAULT '' CHECK (char_length(comment) <= 500),   -- jamais renvoyé par l'API publique
  vehicle_model     text NOT NULL CHECK (char_length(vehicle_model) BETWEEN 2 AND 40),
  vehicle_year      smallint NOT NULL CHECK (vehicle_year BETWEEN 1950 AND 2100),
  plate_hmac        text CHECK (char_length(plate_hmac) = 64),             -- HMAC-SHA256 de la plaque (hexadécimal) : la plaque elle-même n'est jamais stockée
  status            text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'pending', 'rejected')),
  delete_token_hash text NOT NULL CHECK (char_length(delete_token_hash) = 64), -- SHA-256 (hexadécimal) du jeton qui permet à son auteur de retirer la déclaration
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- lecture d'un garage / d'une prestation (échelle de prix, historique)
CREATE INDEX repairs_garage_service_idx ON repairs (garage_id, service_id, repaired_on DESC, created_at DESC) WHERE status = 'approved';
-- une même plaque ne déclare qu'une fois la même prestation, chez le même garage, le même jour
CREATE UNIQUE INDEX repairs_no_duplicate_idx ON repairs (plate_hmac, garage_id, service_id, repaired_on)
  WHERE plate_hmac IS NOT NULL AND status <> 'rejected';
-- file de modération
CREATE INDEX repairs_pending_idx ON repairs (created_at) WHERE status = 'pending';

-- Limitation du nombre de déclarations par adresse IP (empreinte seulement), purgée après 30 jours
CREATE TABLE write_log (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),                      -- sert à purger par lots (DSQL : 3 000 lignes au plus par transaction)
  ip_hash text NOT NULL CHECK (char_length(ip_hash) = 64),
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX write_log_ip_idx ON write_log (ip_hash, at DESC);
CREATE INDEX write_log_at_idx ON write_log (at);   -- plafond global par minute, purge

-- Réponses des serveurs OpenStreetMap (Overpass), servies même périmées si tous les serveurs sont en panne
CREATE TABLE upstream_cache (
  key        text PRIMARY KEY,
  body       jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
