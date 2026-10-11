-- Espace Pro : un compte (Amazon Cognito, sans mot de passe) prouve qu'il gère un garage avant de pouvoir y annoncer des prix.
-- Preuve : un SIRET actif de réparation automobile situé au garage, PUIS un code reçu à une adresse ou un numéro du garage connu par
-- ailleurs (jamais saisi par le demandeur, sauf la partie locale d'une adresse sur le domaine du site propre au garage).
-- Mêmes règles de portabilité que 001_init.sql (PostgreSQL, PGlite, Aurora DSQL) : pas de clé étrangère, empreintes en hexadécimal.

-- Contacts PRIVÉS des garages (Overture Maps : e-mails, téléphones, site). Jamais renvoyés en clair par l'API, jamais publiés dans les
-- tuiles du site : ils ne servent qu'à envoyer un code de vérification. Chargés par la fonction d'opérations (op « import-contacts »).
CREATE TABLE garage_contacts (
  garage_id  text PRIMARY KEY CHECK (char_length(garage_id) BETWEEN 8 AND 40),   -- identifiant Overture du lieu (celui des tuiles)
  name       text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  addr       text NOT NULL DEFAULT '' CHECK (char_length(addr) <= 240),
  pc         text NOT NULL DEFAULT '' CHECK (char_length(pc) IN (0, 5)),
  lat        double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon        double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  area_y     integer NOT NULL,                                                    -- case de 0,05° : recherche autour d'un établissement
  area_x     integer NOT NULL,
  brand      boolean NOT NULL DEFAULT false,                                      -- lieu d'une enseigne : pas de vérification par domaine
  emails     jsonb NOT NULL DEFAULT '[]',                                         -- adresses propres à ce garage (une adresse partagée est écartée à la construction)
  phones     jsonb NOT NULL DEFAULT '[]',                                         -- numéros au format international, propres à ce garage
  web_domain text NOT NULL DEFAULT '' CHECK (char_length(web_domain) <= 100),     -- domaine du site, s'il est à la racine (vide sinon)
  import_id  text NOT NULL CHECK (char_length(import_id) BETWEEN 1 AND 40),       -- chargement qui a écrit la ligne (op « prune-contacts »)
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX garage_contacts_area_idx ON garage_contacts (area_y, area_x);
CREATE INDEX garage_contacts_domain_idx ON garage_contacts (web_domain);          -- un domaine porté par deux garages ne prouve rien
CREATE INDEX garage_contacts_import_idx ON garage_contacts (import_id);

-- Demandes de rattachement d'un compte à un garage, et leur code (empreinte seulement).
CREATE TABLE pro_claims (
  id              uuid PRIMARY KEY,
  account_id      text NOT NULL CHECK (char_length(account_id) BETWEEN 1 AND 128),  -- « sub » du compte Amazon Cognito
  garage_id       text NOT NULL CHECK (char_length(garage_id) BETWEEN 8 AND 40),
  siret           text NOT NULL CHECK (char_length(siret) = 14),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed', 'revoked')),
  channel         text NOT NULL CHECK (channel IN ('email', 'email_domain', 'sms')),
  target          text CHECK (char_length(target) <= 254),                         -- adresse ou numéro du code ; effacé à la vérification
  target_hash     text NOT NULL CHECK (char_length(target_hash) = 64),             -- HMAC (hexadécimal) de la cible : trace sans la cible
  target_hint     text NOT NULL CHECK (char_length(target_hint) <= 260),           -- cible masquée, telle que montrée au demandeur
  code_hash       text CHECK (char_length(code_hash) = 64),                         -- HMAC (hexadécimal) du code en cours ; jamais le code
  code_expires_at timestamptz,
  attempts        smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 50),   -- codes faux saisis pour le code en cours
  sends           smallint NOT NULL DEFAULT 0 CHECK (sends BETWEEN 0 AND 50),
  last_sent_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  verified_at     timestamptz
);
CREATE INDEX pro_claims_account_idx ON pro_claims (account_id, created_at);
CREATE INDEX pro_claims_garage_idx ON pro_claims (garage_id, status);
-- un garage n'a qu'un compte vérifié : un second demandeur passe par une vérification manuelle
CREATE UNIQUE INDEX pro_claims_one_owner_idx ON pro_claims (garage_id) WHERE status = 'verified';

-- Journal des envois et des essais (limites par garage, par compte et globale ; trace des vérifications). Purgé après 90 jours.
CREATE TABLE pro_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN ('send', 'bad_code', 'locked', 'verified', 'revoked')),
  account_id text NOT NULL CHECK (char_length(account_id) BETWEEN 1 AND 128),
  garage_id  text NOT NULL CHECK (char_length(garage_id) BETWEEN 8 AND 40),
  channel    text NOT NULL DEFAULT '' CHECK (char_length(channel) <= 20),
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pro_events_garage_idx ON pro_events (garage_id, at);
CREATE INDEX pro_events_account_idx ON pro_events (account_id, at);
CREATE INDEX pro_events_at_idx ON pro_events (at);
