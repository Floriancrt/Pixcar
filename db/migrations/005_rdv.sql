-- Rendez-vous en ligne (docs/rendez-vous.md, lot 2) : disponibilités d'un garage vérifié (réglages, semaine type, fermetures), demandes
-- des automobilistes, file des e-mails. Mêmes règles de portabilité que 001_init.sql (PostgreSQL, PGlite, Aurora DSQL) : pas de clé
-- étrangère, une contrainte CHECK ne regarde qu'une colonne.

-- Réglages d'un garage : une ligne, créée au premier enregistrement. version : incrémentée à chaque prise d'horaire, pour que deux demandes
-- simultanées sur un même garage ne passent pas toutes deux le contrôle de capacité (PostgreSQL : verrou de ligne ; DSQL : conflit rejoué).
CREATE TABLE rdv_settings (
  garage_id              text PRIMARY KEY CHECK (char_length(garage_id) BETWEEN 8 AND 40),
  enabled                boolean NOT NULL DEFAULT false,
  paused                 boolean NOT NULL DEFAULT false,                        -- mise en pause automatique (3 demandes sans réponse de suite)
  missed                 smallint NOT NULL DEFAULT 0 CHECK (missed BETWEEN 0 AND 1000),
  min_delay_h            smallint NOT NULL DEFAULT 24 CHECK (min_delay_h IN (0, 2, 4, 24, 48)),
  horizon_days           smallint NOT NULL DEFAULT 28 CHECK (horizon_days IN (7, 14, 21, 28)),
  step_min               smallint NOT NULL DEFAULT 30 CHECK (step_min IN (15, 30, 60)),
  holidays               boolean NOT NULL DEFAULT true,                         -- fermé les jours fériés
  notify_email           text NOT NULL DEFAULT '' CHECK (char_length(notify_email) <= 254),   -- adresse privée vérifiée qui reçoit les demandes
  notify_pending         text NOT NULL DEFAULT '' CHECK (char_length(notify_pending) <= 254), -- adresse en cours de vérification
  notify_code_hash       text CHECK (char_length(notify_code_hash) = 64),
  notify_code_expires_at timestamptz,
  notify_attempts        smallint NOT NULL DEFAULT 0 CHECK (notify_attempts BETWEEN 0 AND 100),
  notify_sends           smallint NOT NULL DEFAULT 0 CHECK (notify_sends BETWEEN 0 AND 100),   -- envois de codes depuis notify_window_at
  notify_window_at       timestamptz,
  notify_last_sent_at    timestamptz,
  version                integer NOT NULL DEFAULT 0,
  account_id             text NOT NULL CHECK (char_length(account_id) BETWEEN 1 AND 128),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Semaine type : créneaux (ils peuvent se chevaucher : deux ponts, deux équipes). 20 au plus par garage (contrôlé par l'API).
CREATE TABLE rdv_slots (
  id         uuid PRIMARY KEY,
  garage_id  text NOT NULL CHECK (char_length(garage_id) BETWEEN 8 AND 40),
  name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),          -- pour le garage seulement
  days       text NOT NULL CHECK (char_length(days) BETWEEN 2 AND 20),          -- « mo,tu,we »
  start_min  smallint NOT NULL CHECK (start_min BETWEEN 0 AND 1440 AND start_min % 15 = 0),
  end_min    smallint NOT NULL CHECK (end_min BETWEEN 0 AND 1440 AND end_min % 15 = 0),
  mode       text NOT NULL CHECK (mode IN ('hour', 'drop')),
  capacity   smallint NOT NULL CHECK (capacity BETWEEN 1 AND 9),
  services   jsonb NOT NULL,                                                     -- [ "vidange", "plaq_av" ]
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rdv_slots_garage_idx ON rdv_slots (garage_id);

-- Fermetures en dates (congés) ; les jours fériés, eux, sont calculés (src/js/shared/rdv.js).
CREATE TABLE rdv_closures (
  id         uuid PRIMARY KEY,
  garage_id  text NOT NULL CHECK (char_length(garage_id) BETWEEN 8 AND 40),
  first_day  date NOT NULL,
  last_day   date NOT NULL,
  label      text NOT NULL DEFAULT '' CHECK (char_length(label) <= 60),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rdv_closures_garage_idx ON rdv_closures (garage_id, last_day);

-- Demandes de rendez-vous. Les coordonnées de l'automobiliste sont effacées (anonymized_at) 30 jours après le rendez-vous, 7 jours après
-- un refus, une annulation ou une expiration ; la ligne anonyme reste 24 mois pour les totaux. Le nom, l'adresse et le téléphone du garage
-- sont copiés au moment de la demande : le suivi et les e-mails disent ce qui était vrai quand le client a demandé.
CREATE TABLE rdv_requests (
  id                uuid PRIMARY KEY,
  garage_id         text NOT NULL CHECK (char_length(garage_id) BETWEEN 8 AND 40),
  slot_id           uuid NOT NULL,
  status            text NOT NULL CHECK (status IN ('code', 'pending', 'confirmed', 'declined', 'expired', 'cancelled')),
  day               date NOT NULL,                                                -- jour du rendez-vous (heure de Paris)
  start_min         smallint NOT NULL CHECK (start_min BETWEEN 0 AND 1440),
  end_min           smallint NOT NULL CHECK (end_min BETWEEN 0 AND 1440),
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,
  mode              text NOT NULL CHECK (mode IN ('hour', 'drop')),
  services          jsonb NOT NULL,                                               -- [ { "id": "vidange", "qty": 1 } ]
  minutes           smallint NOT NULL CHECK (minutes BETWEEN 15 AND 2400),        -- temps nécessaire
  name              text NOT NULL DEFAULT '' CHECK (char_length(name) <= 80),
  email             text NOT NULL DEFAULT '' CHECK (char_length(email) <= 254),
  phone             text NOT NULL DEFAULT '' CHECK (char_length(phone) <= 16),    -- format international (+33…)
  car               text NOT NULL DEFAULT '' CHECK (char_length(car) <= 40),
  car_year          smallint CHECK (car_year BETWEEN 1950 AND 2100),
  plate             text NOT NULL DEFAULT '' CHECK (char_length(plate) <= 9),
  message           text NOT NULL DEFAULT '' CHECK (char_length(message) <= 500),
  remind_price      boolean NOT NULL DEFAULT false,
  code_hash         text CHECK (char_length(code_hash) = 64),
  code_expires_at   timestamptz,
  attempts          smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  sends             smallint NOT NULL DEFAULT 0 CHECK (sends BETWEEN 0 AND 100),
  last_sent_at      timestamptz,
  ip_hash           text NOT NULL DEFAULT '' CHECK (char_length(ip_hash) <= 64),
  client_token_hash text CHECK (char_length(client_token_hash) = 64),
  garage_token_hash text CHECK (char_length(garage_token_hash) = 64),
  deadline          timestamptz,                                                  -- heure limite de réponse du garage
  reason            text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 20),  -- motif (code) d'un refus ou d'une annulation
  note              text NOT NULL DEFAULT '' CHECK (char_length(note) <= 300),   -- mot facultatif qui l'accompagne
  cancelled_by      text NOT NULL DEFAULT '' CHECK (cancelled_by IN ('', 'client', 'garage', 'closure')),
  garage_name       text NOT NULL DEFAULT '' CHECK (char_length(garage_name) <= 120),
  garage_addr       text NOT NULL DEFAULT '' CHECK (char_length(garage_addr) <= 300),
  garage_phone      text NOT NULL DEFAULT '' CHECK (char_length(garage_phone) <= 16),
  created_at        timestamptz NOT NULL DEFAULT now(),
  sent_at           timestamptz,                                                  -- bon code : la demande part au garage
  decided_at        timestamptz,
  reminded_at       timestamptz,
  followed_up_at    timestamptz,
  anonymized_at     timestamptz
);
CREATE INDEX rdv_requests_garage_day_idx ON rdv_requests (garage_id, day);
CREATE INDEX rdv_requests_status_deadline_idx ON rdv_requests (status, deadline);
CREATE INDEX rdv_requests_status_day_idx ON rdv_requests (status, day);
CREATE INDEX rdv_requests_email_idx ON rdv_requests (email, status);
CREATE UNIQUE INDEX rdv_requests_client_token_idx ON rdv_requests (client_token_hash);
CREATE UNIQUE INDEX rdv_requests_garage_token_idx ON rdv_requests (garage_token_hash);

-- Envois de codes (limites par adresse IP et par adresse e-mail, en empreintes) ; effacés après 2 jours.
CREATE TABLE rdv_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN ('code', 'notify_code')),
  ip_hash    text NOT NULL DEFAULT '' CHECK (char_length(ip_hash) <= 64),
  email_hash text NOT NULL DEFAULT '' CHECK (char_length(email_hash) <= 64),
  garage_id  text NOT NULL DEFAULT '' CHECK (char_length(garage_id) <= 40),
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rdv_events_ip_idx ON rdv_events (ip_hash, at);
CREATE INDEX rdv_events_email_idx ON rdv_events (email_hash, at);
CREATE INDEX rdv_events_at_idx ON rdv_events (at);

-- File des e-mails : écrite dans la transaction qui change l'état d'une demande, vidée juste après et par la tâche horaire (5 essais).
-- Le texte n'y est pas : il est écrit au moment de l'envoi, à partir de la demande.
CREATE TABLE rdv_mails (
  id         uuid PRIMARY KEY,
  request_id uuid,
  garage_id  text NOT NULL CHECK (char_length(garage_id) BETWEEN 8 AND 40),
  kind       text NOT NULL CHECK (char_length(kind) BETWEEN 2 AND 30),
  attempts   smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  last_error text NOT NULL DEFAULT '' CHECK (char_length(last_error) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz
);
CREATE INDEX rdv_mails_due_idx ON rdv_mails (sent_at, created_at);
CREATE INDEX rdv_mails_request_idx ON rdv_mails (request_id);
