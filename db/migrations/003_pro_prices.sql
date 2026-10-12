-- Espace Pro : les prix qu'un garage vérifié annonce, et les visites de sa fiche qu'il voit dans son tableau de bord.
-- Les prix annoncés restent à part des prix payés (table repairs) : ils ne se mélangent jamais aux échelles ni aux médianes.
-- Mêmes règles de portabilité que 001_init.sql (PostgreSQL, PGlite, Aurora DSQL) : pas de clé étrangère, empreintes en hexadécimal.

-- Un prix par garage et par prestation (identifiants de src/js/shared/services.js, contrôle technique exclu : ses prix sont officiels).
CREATE TABLE pro_prices (
  garage_id    text NOT NULL CHECK (char_length(garage_id) BETWEEN 8 AND 40),     -- identifiant Overture du garage (celui de garage_contacts)
  service_id   text NOT NULL CHECK (char_length(service_id) BETWEEN 2 AND 40),
  kind         text NOT NULL CHECK (kind IN ('fixed', 'from', 'quote')),            -- forfait, « à partir de », sur devis
  price_cents  integer CHECK (price_cents BETWEEN 100 AND 2000000),                 -- TTC ; vide pour « sur devis », et seulement pour lui
  vehicles     jsonb NOT NULL DEFAULT '[]',                                         -- catégories de véhicules concernées ([] : toutes)
  includes     jsonb NOT NULL DEFAULT '[]',                                         -- ce que le prix comprend (pièces, main-d'œuvre, produits annexes)
  status       text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'review', 'rejected')), -- review : très éloigné des prix payés du secteur
  account_id   text NOT NULL CHECK (char_length(account_id) BETWEEN 1 AND 128),     -- compte qui l'a saisi en dernier
  confirmed_at timestamptz NOT NULL DEFAULT now(),                                  -- dernière confirmation : marqué « ancien » 6 mois plus tard
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (garage_id, service_id),
  CHECK ((kind = 'quote') = (price_cents IS NULL))
);
CREATE INDEX pro_prices_status_idx ON pro_prices (status, updated_at);

-- Visites d'une fiche de garage vérifié (« view ») et touches « Appeler » (« call ») : un visiteur compte une fois par jour, par garage et par
-- type. visitor = HMAC de l'adresse IP, du garage et du jour : deux jours ou deux garages ne se relient pas. Purgé après 60 jours (le tableau de
-- bord montre 30 jours et leur évolution sur les 30 précédents) ; le garagiste ne voit que des totaux.
CREATE TABLE pro_visits (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),                             -- purge par lots (DSQL : 3 000 lignes par transaction)
  garage_id text NOT NULL CHECK (char_length(garage_id) BETWEEN 8 AND 40),
  day       date NOT NULL,
  kind      text NOT NULL CHECK (kind IN ('view', 'call')),
  visitor   text NOT NULL CHECK (char_length(visitor) = 64)
);
CREATE UNIQUE INDEX pro_visits_once_idx ON pro_visits (garage_id, day, kind, visitor);
CREATE INDEX pro_visits_day_idx ON pro_visits (day);
