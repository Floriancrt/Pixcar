-- Accord de sous-traitance des données (article 28 du RGPD) accepté par un garage pour la gestion d'atelier (docs/sous-traitance.md,
-- src/js/shared/agreement.js). Une nouvelle table seulement ; mêmes règles de portabilité que 001_init.sql (PostgreSQL, PGlite,
-- Aurora DSQL) : pas de clé étrangère.
--
-- Une ligne par acceptation : la preuve (garage, version du texte, compte, nom déclaré au rattachement, date). ended_at : fin du
-- rattachement (pro-revoke) ; la ligne est effacée 5 ans plus tard (preuve en cas de litige). Un nouveau titulaire du même garage
-- accepte à son tour : la ligne de l'ancien reste, close.
CREATE TABLE pro_agreements (
  id          uuid PRIMARY KEY,
  garage_id   text NOT NULL CHECK (char_length(garage_id) BETWEEN 8 AND 40),
  version     text NOT NULL CHECK (char_length(version) BETWEEN 1 AND 20),
  account_id  text NOT NULL CHECK (char_length(account_id) BETWEEN 1 AND 128),
  signer      text NOT NULL CHECK (char_length(signer) BETWEEN 1 AND 120),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz
);
CREATE INDEX pro_agreements_garage_idx ON pro_agreements (garage_id, version);
